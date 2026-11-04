// YEBS Noodles - Unified Express API Backend & Database Server
// Secure auth (bcrypt + HMAC signed sessions), provider-confirmed payments,
// unified order IDs and shared pickup-point state.

// Load .env for local development and self-hosted deployments. On Render and
// other hosts the values come from the platform, so a missing .env is not an
// error. This must run before ./src/data/store reads process.env.
try {
  require('dotenv').config();
} catch (error) {
  // dotenv is optional at runtime.
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const store = require('./src/data/store');
const media = require('./src/data/media');
const { resolveAdminCredentialResetVersion } = require('./scripts/render-deploy-version');

const resolvedAdminCredentialResetVersion = resolveAdminCredentialResetVersion(process.env);
if (resolvedAdminCredentialResetVersion) {
  process.env.ADMIN_CREDENTIAL_RESET_VERSION = resolvedAdminCredentialResetVersion;
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const operationalMetrics = { requests: 0, ordersCreated: 0, paymentAttempts: 0, errors: 0, startedAt: Date.now() };
app.use((req, res, next) => {
  operationalMetrics.requests += 1;
  res.on('finish', () => {
    if (res.statusCode >= 500) operationalMetrics.errors += 1;
  });
  const unsafeMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const origin = String(req.get('origin') || '').trim();
  if (unsafeMethod && origin) {
    const allowedHost = String(req.get('host') || '').toLowerCase();
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch (_) {}
    if (originHost && originHost !== allowedHost) {
      return res.status(403).json({ success: false, message: 'Cross-site request blocked.' });
    }
  }
  next();
});
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try again later.' }
}));
app.use('/api/ai/chat', rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, reply: 'Please wait a moment before sending another message.' }
}));
app.use((req, res, next) => {
  const host = String(req.get('host') || '').split(':')[0].toLowerCase();
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const productionHost = host === 'yebsnoodles.onrender.com' || process.env.RENDER === 'true';
  const canonicalHost = 'yebsnoodles.onrender.com';
  if (productionHost && req.method === 'GET' && host && host !== canonicalHost) {
    return res.redirect(308, `https://yebsnoodles.onrender.com${req.originalUrl}`);
  }
  if (productionHost && forwardedProto === 'http' && req.method === 'GET' && host === 'yebsnoodles.onrender.com') {
    return res.redirect(308, `https://yebsnoodles.onrender.com${req.originalUrl}`);
  }
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'database.json');
const SECRET_FILE = path.join(__dirname, '.auth-secret');

const googleOAuthClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || '');

async function verifyGoogleCredential(idToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  if (!clientId) throw new Error('Google sign-in is not configured.');
  const ticket = await googleOAuthClient.verifyIdToken({ idToken, audience: clientId });
  const payload = ticket.getPayload();
  if (!payload || payload.email_verified !== true) throw new Error('Google email verification is required.');
  return payload;
}

app.use(cors());
// Photos (driver live face photo + MoMo receipts) are sent as base64 data URLs,
// so the default 100kb JSON limit is far too small.
app.use(express.json({ limit: '12mb' }));

app.post('/api/ai/chat', async (req, res) => {
  const message = String(req.body && req.body.message || '').trim().slice(0, 1200);
  if (!message) return res.status(400).json({ success: false, reply: 'Please ask a question.' });
  const suppliedHistory = Array.isArray(req.body.history) ? req.body.history : [];
  let role = ['customer', 'driver', 'admin'].includes(String(req.body.role || '').toLowerCase())
    ? String(req.body.role).toLowerCase()
    : 'customer';
  const authenticated = authenticate(req);
  if (authenticated) role = authenticated.payload.role;

  const db = loadDatabase();
  const momo = getMomoSettings(db);
  const menuItems = (db.menuItems || []).filter(item => item && item.available !== false).slice(0, 80);
  const menuKnowledge = menuItems.map(item => {
    const price = Number(item.price);
    return `${item.name}${Number.isFinite(price) ? ` - GH₵${price.toFixed(2)}` : ''}${item.category ? ` (${item.category})` : ''}`;
  }).join('; ');
  const asArray = value => Array.isArray(value) ? value : [];
  const buildAiBusinessSnapshot = () => {
    const live = loadDatabase();
    const orders = asArray(live.orders);
    const drivers = asArray(live.drivers);
    const payouts = asArray(live.payouts);
    const delivered = orders.filter(order => String(order.status || '').toLowerCase() === 'delivered');
    const active = orders.filter(order => !['delivered', 'cancelled'].includes(String(order.status || '').toLowerCase()));
    const cancelled = orders.filter(order => String(order.status || '').toLowerCase() === 'cancelled');
    const paid = orders.filter(order => String(order.status || '').toLowerCase() !== 'cancelled' &&
      (order.paymentVerified === true ||
        String(order.paymentStatus || '').toLowerCase() === 'paid' ||
        String(order.verificationMethod || '').toLowerCase() === 'cash-driver'));
    const pendingPayments = orders.filter(order =>
      ['pending', 'review'].includes(String(order.paymentStatus || '').toLowerCase()) ||
      String(order.momoRequestStatus || '').toLowerCase() === 'pending'
    );
    const itemTotals = new Map();
    orders.filter(order => String(order.status || '').toLowerCase() !== 'cancelled').forEach(order => {
      for (const item of asArray(order.items)) {
        const key = String(item.name || 'Menu item');
        const quantity = Math.max(0, Number(item.quantity) || 0);
        const current = itemTotals.get(key) || { name: key, quantity: 0, revenue: 0 };
        current.quantity += quantity;
        current.revenue += quantity * (Number(item.price) || 0);
        itemTotals.set(key, current);
      }
    });
    const totalRevenue = orders.filter(order => String(order.status || '').toLowerCase() !== 'cancelled')
      .reduce((sum, order) => sum + (Number(order.total) || 0), 0);
    return {
      generatedAt: new Date().toISOString(),
      orders: { total: orders.length, active: active.length, delivered: delivered.length, cancelled: cancelled.length,       revenue: Math.round(totalRevenue * 100) / 100 },
      payments: { paid: paid.length, pendingReview: pendingPayments.length, paidRevenue: Math.round(paid.reduce((sum, order) => sum + (Number(order.total) || 0), 0) * 100) / 100 },
      drivers: {
        total: drivers.length,
        approved: drivers.filter(driver => driver.approvalStatus === 'approved' || driver.approved === true).length,
        online: drivers.filter(driver => driver.isOnline === true || driver.isActive === true).length
      },
      payouts: { requested: payouts.filter(payout => String(payout.status || '').toLowerCase() === 'requested').length },
      topItems: Array.from(itemTotals.values()).sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue).slice(0, 8),
      statuses: orders.reduce((result, order) => {
        const status = String(order.status || 'pending').toLowerCase();
        result[status] = (result[status] || 0) + 1;
        return result;
      }, {})
    };
  };
  const roleKnowledge = role === 'admin'
    ? 'Admin guidance: explain how to manage orders, approve drivers, update menu and inventory, review payments/refunds, use analytics, broadcast notifications, and configure business settings. Do not invent account balances or pending records; direct the admin to the relevant dashboard data when live values are needed.'
    : role === 'driver'
      ? 'Driver guidance: explain claiming and unclaiming orders, pickup, navigation, delivery status updates, PIN confirmation, cash/receipt verification, earnings, payouts, availability, and the driver map. Never claim a delivery, payment, or payout is complete unless the live status confirms it.'
      : 'Customer guidance: explain the menu, cart, checkout, delivery/pickup, address pin, payment prompts, tracking, receipts, order history, saved addresses, reviews, loyalty, referrals, wallet, cancellation, refunds, and customer support.';
  const knowledge = `You are YEBS's conversational website assistant. Be concise, natural, and useful.

Business facts:
- YEBS Noodles serves fresh, cooked-to-order noodles and pasta in Ghana.
- Customers choose meals, add quantities, enter details, place orders, track live delivery, and view receipts.
- Payment choices are Mobile Money and Cash only when those choices are shown in checkout.
- Mobile Money payments start from checkout with a request sent to the customer's phone. The customer approves it using their MoMo PIN and should wait for confirmation in the app.
- YEBS Mobile Money destination: ${momo.payToLabel || momo.payTo || '0559103452'} (${momo.accountName || 'MATHEW TIA'}).
- Customers can select a delivery address or pickup pin. Delivery fees depend on the route and address. Exact preparation and delivery times depend on kitchen workload, traffic, distance, weather, and driver availability.
- Customer support is on WhatsApp at 0559103452. Ask customers to include their order number for faster help.
- The website also has order history, receipts, saved addresses, live tracking, loyalty rewards, referrals, reviews, notifications, and a wallet where implemented.
- If a customer asks about a current balance, order status, menu availability, exact price, promotion, opening hours, payment confirmation, or other live account data that is not in the supplied conversation, ask them to check the relevant app page and say which page to use. Do not guess.
- You may answer general questions normally, but connect answers back to YEBS when relevant.
- Never claim a payment succeeded unless confirmation is returned by the payment system.
- Ask one focused follow-up question when details are missing.

${roleKnowledge}
Current public menu items from the app database: ${menuKnowledge || 'The menu will be available when menu items are loaded.'}

General capability:
- Answer ordinary questions clearly and independently of a prepared FAQ.
- When asked about software, explain practical steps with the app's relevant screen.
- Do not present unavailable live records as facts.`;

  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
  let geminiFailureReason = '';
  if (geminiKey) {
    try {
      const configuredGeminiModel = String(process.env.GEMINI_MODEL || process.env.AI_MODEL || '').trim();
      const preferredGeminiModels = [...new Set([
        configuredGeminiModel,
        'gemini-flash-lite-latest',
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-flash-latest'
      ].filter(Boolean))];
      try {
        const modelListResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
          headers: { 'x-goog-api-key': geminiKey },
          signal: AbortSignal.timeout(8000)
        });
        if (modelListResponse.ok) {
          const modelList = await modelListResponse.json();
          const availableFlashModels = (modelList.models || [])
            .filter(model => Array.isArray(model.supportedGenerationMethods) &&
              model.supportedGenerationMethods.includes('generateContent'))
            .map(model => String(model.name || '').replace(/^models\//, ''))
            .filter(model => /flash/i.test(model));
          preferredGeminiModels.push(...availableFlashModels);
        }
      } catch (_) {}
      const geminiModels = [...new Set(preferredGeminiModels)];
      const contents = suppliedHistory.slice(-10).filter(entry =>
        entry && typeof entry.content === 'string' && ['user', 'assistant', 'model'].includes(entry.role)
      ).map(entry => ({
        role: entry.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: entry.content.slice(0, 1200) }]
      }));
      contents.push({ role: 'user', parts: [{ text: message }] });
      const tools = [{
        functionDeclarations: [
          { name: 'inspect_dashboard', description: 'Inspect live YEBS operations counts and risks. Use for summaries, validation, maintenance checks, and staff requests.', parameters: { type: 'object', properties: {} } },
          { name: 'analyze_business', description: 'Analyze live orders, revenue, payment risk, menu demand, cancellations, and staff performance, then provide prioritized recommendations.', parameters: { type: 'object', properties: {} } },
          { name: 'list_orders', description: 'List and inspect live orders, optionally filtered by status.', parameters: { type: 'object', properties: { status: { type: 'string', description: 'Exact order status such as preparing, ready, delivered, or cancelled' }, limit: { type: 'number' } } } },
          { name: 'inspect_payments', description: 'Inspect payment review queue, pending Mobile Money payments, and payment mismatches.', parameters: { type: 'object', properties: {} } },
          { name: 'notify_team', description: 'Create an in-app notification for admin or driver staff.', parameters: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' }, audience: { type: 'string', enum: ['admin', 'driver', 'all'] }, confirmed: { type: 'boolean' } }, required: ['title', 'message', 'audience', 'confirmed'] } },
          { name: 'driver_update_availability', description: 'Update the authenticated driver availability when the driver explicitly confirms it.', parameters: { type: 'object', properties: { available: { type: 'boolean' }, confirmed: { type: 'boolean' } }, required: ['available', 'confirmed'] } },
          { name: 'driver_mark_arrived', description: 'Mark the authenticated driver arrival for one assigned active order.', parameters: { type: 'object', properties: { orderId: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['orderId', 'confirmed'] } },
          { name: 'optimize_driver_route', description: 'Calculate an efficient road stop order for the authenticated driver assigned orders that have delivery coordinates.', parameters: { type: 'object', properties: {} } },
          { name: 'verify_delivery_pin', description: 'Verify the customer delivery PIN for one assigned order and log its successful delivery.', parameters: { type: 'object', properties: { orderId: { type: 'string' }, pin: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['orderId', 'pin', 'confirmed'] } }
        ]
      }];
      let lastReply = '';
      let geminiError = 'Gemini returned no usable response.';
      for (const geminiModel of geminiModels) {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`;
        let modelCompleted = false;
        for (let turn = 0; turn < 4 && !modelCompleted; turn++) {
        let response;
        try {
          response = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: knowledge + '\nYou can inspect live data and perform authorized staff operations with tools. For destructive or externally visible actions, require explicit confirmation and explain what you are about to do. Never expose secrets, tokens, passwords, API keys, private customer addresses, phone numbers, or internal database fields. Base conclusions on tool output, not guesses. Keep answers practical and natural; do not repeat the user.' }] },
            contents,
            tools,
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
            generationConfig: { temperature: 0.25, maxOutputTokens: 700 }
          }),
          signal: AbortSignal.timeout(12000)
          });
        } catch (error) {
          geminiFailureReason = error.name === 'TimeoutError' ? 'Gemini model request timed out.' : error.message;
          continue;
        }
        const rawData = await response.text();
        let data;
        try {
          data = JSON.parse(rawData);
        } catch {
          if (!response.ok) {
            geminiError = `Gemini returned HTTP ${response.status}`;
            geminiFailureReason = geminiError;
            if ([404, 429, 502, 503].includes(response.status)) continue;
            break;
          }
          throw new Error(`Gemini ${geminiModel} returned invalid JSON.`);
        }
        const candidate = data.candidates && data.candidates[0];
        const parts = candidate && candidate.content && candidate.content.parts || [];
        if (!response.ok) {
          geminiError = data.error && data.error.message || `Gemini returned HTTP ${response.status}`;
          geminiFailureReason = geminiError;
          if ([404, 429, 502, 503].includes(response.status) ||
              /not found|is not supported|high demand|unavailable|overloaded/i.test(geminiError)) continue;
          break;
        }
        const calls = parts.filter(part => part.functionCall);
        const textPart = parts.map(part => part.text || '').join('').trim();
        if (textPart) lastReply = textPart;
        if (!calls.length) {
          if (lastReply) return res.json({ success: true, reply: lastReply, provider: 'gemini', model: geminiModel });
          break;
        }
        const functionResponses = [];
        for (const call of calls) {
          const args = call.functionCall.args || {};
          let output;
          const live = loadDatabase();
          if (call.functionCall.name === 'inspect_dashboard') {
            output = buildAiBusinessSnapshot();
          } else if (call.functionCall.name === 'analyze_business') {
            const snapshot = buildAiBusinessSnapshot();
            const deliveryRate = snapshot.orders.total ? Math.round((snapshot.orders.delivered / snapshot.orders.total) * 100) : 0;
            const cancellationRate = snapshot.orders.total ? Math.round((snapshot.orders.cancelled / snapshot.orders.total) * 100) : 0;
            output = {
              ...snapshot,
              analysis: {
                deliveryRatePercent: deliveryRate,
                cancellationRatePercent: cancellationRate,
                priorities: [
                  snapshot.payments.pendingReview ? `${snapshot.payments.pendingReview} payment(s) need review before fulfilment or revenue confirmation.` : 'No payment-review backlog.',
                  snapshot.orders.active ? `${snapshot.orders.active} active order(s) require status and bottleneck monitoring.` : 'No active order backlog.',
                  snapshot.drivers.approved === 0 ? 'No approved driver is currently available for assignment.' : `${snapshot.drivers.approved} approved driver(s) exist and ${snapshot.drivers.online} are online.`,
                  snapshot.orders.cancelled ? 'Investigate cancellation patterns and customer complaints.' : 'Cancellation rate is currently controlled.'
                ]
              }
            };
          } else if (call.functionCall.name === 'list_orders') {
            output = asArray(live.orders).filter(o => !args.status || String(o.status).toLowerCase() === String(args.status).toLowerCase()).slice(0, Math.min(Number(args.limit) || 12, 25)).map(o => ({ id: o.id, status: o.status, paymentStatus: o.paymentStatus, fulfilment: o.fulfilment, total: o.total, createdAt: o.createdAt }));
          } else if (call.functionCall.name === 'inspect_payments') {
            output = live.orders.filter(o => o.paymentStatus === 'review' || o.paymentStatus === 'pending' || o.momoRequestStatus === 'pending').slice(0, 25).map(o => ({ id: o.id, total: o.total, paymentStatus: o.paymentStatus, momoRequestStatus: o.momoRequestStatus, paymentMode: o.paymentMode }));
          } else if (call.functionCall.name === 'notify_team' && role !== 'customer' && args.confirmed === true) {
            live.notifications = Array.isArray(live.notifications) ? live.notifications : [];
            live.notifications.unshift({ id: 'ai-' + Date.now(), title: String(args.title).slice(0, 120), message: String(args.message).slice(0, 500), audience: args.audience, createdAt: new Date().toISOString(), source: 'ai-assistant' });
            saveDatabase(live);
            output = { ok: true, audience: args.audience, message: 'In-app notification created.' };
          } else if (call.functionCall.name === 'driver_update_availability' && role === 'driver' && authenticated && args.confirmed === true) {
            const driver = live.drivers.find(d => String(d.id) === String(authenticated.driver.id));
            if (!driver) output = { ok: false, reason: 'Authenticated driver not found.' };
            else {
              driver.isActive = Boolean(args.available);
              driver.availability = args.available ? 'available' : 'offline';
              saveDatabase(live);
              output = { ok: true, available: driver.isActive };
            }
          } else if (call.functionCall.name === 'driver_mark_arrived' && role === 'driver' && authenticated && args.confirmed === true) {
            const order = live.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(args.orderId));
            const ownsOrder = order && (String(order.driverId) === String(authenticated.driver.id) ||
              String(order.driver && order.driver.id) === String(authenticated.driver.id));
            if (!order || !ownsOrder) output = { ok: false, reason: 'Order is not assigned to this driver.' };
            else if (order.status !== 'enroute') output = { ok: false, reason: 'Live tracking must be started before arrival can be recorded.', currentStatus: order.status };
            else {
              order.status = 'arrived';
              order.arrivedAt = new Date().toISOString();
              saveDatabase(live);
              if (typeof pushOrderUpdate === 'function') pushOrderUpdate(order.id, { type: 'status', order: projectOrder(order, 'customer') });
              output = { ok: true, orderId: order.id, status: order.status, arrivedAt: order.arrivedAt };
            }
          } else if (call.functionCall.name === 'optimize_driver_route' && role === 'driver' && authenticated) {
            const driverId = String(authenticated.driver.id);
            const current = authenticated.driver;
            const assigned = live.orders.filter(o => !['delivered', 'cancelled'].includes(String(o.status).toLowerCase()) &&
              (String(o.driverId) === driverId || String(o.driver && o.driver.id) === driverId));
            const stops = assigned.map(order => {
              const pin = order.mapPin || order.deliveryPin || {};
              return { orderId: order.id, lat: Number(pin.lat), lng: Number(pin.lng || pin.lon), address: order.address || pin.address || 'Destination pin' };
            }).filter(stop => Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
            const distanceKm = (a, b) => {
              const rad = Math.PI / 180;
              const dLat = (b.lat - a.lat) * rad;
              const dLng = (b.lng - a.lng) * rad;
              const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
              return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
            };
            const origin = { lat: Number(current.lat), lng: Number(current.lng) };
            const remaining = [...stops];
            const route = [];
            let cursor = Number.isFinite(origin.lat) && Number.isFinite(origin.lng) ? origin : (remaining[0] || null);
            let routeMethod = 'coordinate-distance-fallback';
            if (stops.length > 1 && cursor) {
              try {
                const points = [cursor, ...stops];
                const uniquePoints = points.filter((point, index) =>
                  points.findIndex(candidate => Math.abs(candidate.lat - point.lat) < 0.00001 && Math.abs(candidate.lng - point.lng) < 0.00001) === index);
                const matrixResponse = await fetch(`https://router.project-osrm.org/table/v1/driving/${uniquePoints.map(point => `${point.lng},${point.lat}`).join(';')}?annotations=duration`, {
                  signal: AbortSignal.timeout(8000)
                });
                if (matrixResponse.ok) {
                  const matrix = await matrixResponse.json();
                  if (Array.isArray(matrix.durations)) {
                    routeMethod = 'live-road-duration-matrix';
                    while (remaining.length) {
                      const pointIndex = uniquePoints.findIndex(point =>
                        Math.abs(point.lat - cursor.lat) < 0.00001 && Math.abs(point.lng - cursor.lng) < 0.00001);
                      let bestIndex = 0;
                      let bestDuration = Infinity;
                      for (let i = 0; i < remaining.length; i++) {
                        const stopPointIndex = uniquePoints.findIndex(point =>
                          Math.abs(point.lat - remaining[i].lat) < 0.00001 && Math.abs(point.lng - remaining[i].lng) < 0.00001);
                        const duration = matrix.durations[pointIndex] && matrix.durations[pointIndex][stopPointIndex];
                        if (Number.isFinite(duration) && duration < bestDuration) {
                          bestDuration = duration;
                          bestIndex = i;
                        }
                      }
                      const next = remaining.splice(bestIndex, 1)[0];
                      route.push(next);
                      cursor = next;
                    }
                  }
                }
              } catch (_) {}
            }
            while (routeMethod !== 'live-road-duration-matrix' && cursor && remaining.length) {
              let bestIndex = 0;
              for (let i = 1; i < remaining.length; i++) {
                if (distanceKm(cursor, remaining[i]) < distanceKm(cursor, remaining[bestIndex])) bestIndex = i;
              }
              const next = remaining.splice(bestIndex, 1)[0];
              route.push(next);
              cursor = next;
            }
            output = {
              ok: true,
              method: routeMethod,
              stops: route.map((stop, index) => ({ stop: index + 1, ...stop })),
              unlocatedOrderIds: assigned.filter(order => !route.some(stop => stop.orderId === order.id)).map(order => order.id)
            };
          } else if (call.functionCall.name === 'verify_delivery_pin' && role === 'driver' && authenticated && args.confirmed === true) {
            const order = live.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(args.orderId));
            const ownsOrder = order && (String(order.driverId) === String(authenticated.driver.id) ||
              String(order.driver && order.driver.id) === String(authenticated.driver.id));
            if (!order || !ownsOrder) output = { ok: false, reason: 'Order is not assigned to this driver.' };
            else if (String(order.deliveryPin || '') !== String(args.pin).replace(/\D/g, '').slice(-4)) output = { ok: false, reason: 'PIN does not match this order.' };
            else if (order.status === 'delivered') output = { ok: true, idempotent: true, orderId: order.id, status: 'delivered', deliveredAt: order.deliveredAt };
            else if (order.status !== 'arrived') output = { ok: false, reason: 'Driver must mark arrival before delivery can be verified.', currentStatus: order.status };
            else if (order.paymentStatus !== 'paid' && order.paymentVerified !== true) output = { ok: false, reason: 'Payment must be confirmed before delivery completion.' };
            else {
              const timestamp = new Date().toISOString();
              order.status = 'delivered';
              order.deliveredAt = timestamp;
              order.verifiedAt = timestamp;
              order.verifiedByDriver = true;
              order.deliveryProof = { method: 'ai-pin-verification', verifiedAt: timestamp, driverId: authenticated.driver.id };
              live.deliveryReports = Array.isArray(live.deliveryReports) ? live.deliveryReports : [];
              live.deliveryReports.push({ id: 'delivery-ai-' + timestamp, orderId: order.id, driverId: authenticated.driver.id, deliveredAt: timestamp, source: 'ai-assistant' });
              saveDatabase(live);
              if (typeof pushOrderUpdate === 'function') pushOrderUpdate(order.id, { type: 'status', order: projectOrder(order, 'customer') });
              output = { ok: true, orderId: order.id, status: 'delivered', deliveredAt: timestamp };
            }
          } else if (args.confirmed !== true) output = { ok: false, requiresConfirmation: true };
          else output = { ok: false, reason: 'Unauthorized for this role.' };
          functionResponses.push({ functionResponse: { name: call.functionCall.name, response: output } });
        }
        contents.push({ role: 'model', parts }, { role: 'user', parts: functionResponses });
        }
        if (!lastReply) {
          geminiError = 'Gemini returned no text response.';
        } else {
          modelCompleted = true;
        }
      }
      if (lastReply) return res.json({ success: true, reply: lastReply, provider: 'gemini' });
      console.error('[ai] Gemini returned no text response');
    } catch (err) {
      console.error('[ai] Gemini request failed:', err.message);
      geminiFailureReason = err.message;
    }
  }

  const providerUrl = process.env.AI_API_URL || process.env.OPENAI_BASE_URL || 'https://api.groq.com/openai/v1';
  const apiKey = process.env.AI_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.AI_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  if (apiKey) {
    try {
      const response = await fetch(providerUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          max_tokens: 350,
          messages: [
            { role: 'system', content: knowledge },
            ...suppliedHistory.slice(-10).filter(entry =>
              entry && typeof entry.content === 'string' &&
              ['user', 'assistant'].includes(entry.role)
            ).map(entry => ({
              role: entry.role === 'assistant' ? 'assistant' : 'user',
              content: entry.content.slice(0, 1200)
            })),
            { role: 'user', content: message }
          ]
        }),
        signal: AbortSignal.timeout(15000)
      });
      const data = await response.json();
      const reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (response.ok && reply) return res.json({ success: true, reply: reply.trim(), provider: 'configured' });
      console.error('[ai] provider rejected request:', response.status, data.error || data);
    } catch (err) {
      console.error('[ai] provider request failed:', err.message);
    }
  }

  console.error('[ai] No configured model was able to answer the request.');
  if (geminiKey) {
    return res.status(502).json({
      success: false,
      provider: 'gemini',
      message: 'Gemini could not complete the request.',
      reason: geminiFailureReason || 'The configured API key was rejected or the provider is unavailable.'
    });
  }
  return res.status(503).json({
    success: false,
    provider: 'not-configured',
    reply: 'The AI model is not connected yet. Set GEMINI_API_KEY on Render and redeploy. YEBS support: 0559103452.'
  });
});

// Week 1/2 feature API modules.
app.use('/api/customers', require('./src/routes/customers'));
app.use('/api/drivers', require('./src/routes/drivers'));
app.use('/api/reviews', require('./src/routes/reviews'));
app.use('/api/chat', require('./src/routes/chat'));
app.use('/api/inventory', require('./src/routes/inventory'));
app.use('/api/loyalty', require('./src/routes/loyalty'));
app.use('/api/referrals', require('./src/routes/referrals'));
app.use('/api/receipts', require('./src/routes/receipts'));
app.use('/api/notifications', require('./src/routes/notifications'));
app.use('/api/pricing', require('./src/routes/dynamicPricing'));

app.use('/database.json', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ success: true, storage: 'managed-by-api' });
});
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(__dirname, { extensions: ['html', 'htm'] }));

// Never let browsers cache live operational data; auto-refresh state from Supabase when remote.
app.use('/api', async (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  // Refresh even after an error so a transient outage can recover instead of
  // pinning the server to the seed document until the next restart.
  if (store.remoteEnabled) {
    try { await store.refresh(); } catch (e) { /* non-fatal, fallback to memory */ }
  }
  next();
});

app.use('/api', async (req, res, next) => {
  const changesState = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
    || (req.method === 'GET' && /\/pay\/status$/.test(req.path));
  if (!changesState) return next();
  if (req.method === 'POST' && [
    '/auth/admin/login',
    '/auth/admin/unlock',
    '/auth/driver/login'
  ].includes(req.path.replace(/^\/api/, ''))) return next();
  let release;
  try {
    release = await store.acquireMutationLock();
  } catch (err) {
    console.error('[store] refusing mutation without a fresh durable state:', err.message);
    return res.status(503).json({ success: false, persisted: false, message: 'Persistent storage is unavailable. No changes were accepted.' });
  }

  let released = false;
  const releaseOnce = async () => {
    if (released) return;
    released = true;
    await release();
  };
  res.on('close', releaseOnce);

  const sendJson = res.json.bind(res);
  res.json = (body) => {
    store.flush().then(async () => {
      if (store.remoteEnabled && !store.canPersist() && res.statusCode < 400) {
        await releaseOnce();
        return sendJson({ success: false, persisted: false, message: 'Storage could not confirm the change. Reload before retrying.' });
      }
      await releaseOnce();
      return sendJson(body);
    }).catch(async err => {
      console.error('[store] mutation response persistence check failed:', err.message);
      await releaseOnce();
      if (!res.headersSent) sendJson({ success: false, persisted: false, message: 'Storage could not confirm the change.' });
    });
    return res;
  };
  next();
});

// Friendly clean URL routes
app.get(['/admin', '/dashboard', '/admin-panel'], (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get(['/driver', '/driver-panel', '/rider', '/dispatch'], (req, res) => {
  res.sendFile(path.join(__dirname, 'driver.html'));
});

app.get(['/store', '/menu', '/order', '/track', '/customer'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================================
// GEOCODING — online landmark search (OpenStreetMap/Nominatim)
// ==========================================================
// The checkout and the admin pickup picker both query this proxy so a typed
// area like "ATU" resolves to real popular landmarks and coordinates instead
// of a hard-coded shortlist. Results are cached for a day to respect the
// public Nominatim usage policy, and a small offline list keeps the UI usable
// when the network is down.

const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;
const GEOCODE_MIN_INTERVAL_MS = 1100;
const geoCache = new Map();
let lastGeoRequestAt = 0;

const LOCAL_LANDMARKS = [
  { name: 'Accra Technical University (ATU)', area: 'Barnes Road, Accra Central', lat: 5.5560, lng: -0.2075, aliases: ['atu', 'accra technical', 'polytechnic'] },
  { name: 'Kwame Nkrumah Circle (Odo Rice Junction)', area: 'Circle, Accra', lat: 5.5612, lng: -0.2155, aliases: ['circle', 'odo rice', 'nkrumah circle', 'vip'] },
  { name: 'VIP Station / Circle VIP', area: 'Kwame Nkrumah Circle', lat: 5.5605, lng: -0.2160, aliases: ['vip', 'vip station'] },
  { name: 'Adabraka Market', area: 'Adabraka, Accra', lat: 5.5580, lng: -0.2105, aliases: ['adabraka'] },
  { name: 'Ridge Hospital', area: 'Castle Road, Ridge', lat: 5.5628, lng: -0.2035, aliases: ['ridge', 'ridge hospital'] },
  { name: 'Osu Oxford Street', area: 'Osu, Accra', lat: 5.5560, lng: -0.1830, aliases: ['osu', 'oxford street'] },
  { name: 'Danquah Circle', area: 'Osu / Labone', lat: 5.5600, lng: -0.1820, aliases: ['danquah', 'danquah circle'] },
  { name: 'Cantonments City Mall', area: 'Cantonments, Accra', lat: 5.5780, lng: -0.1790, aliases: ['cantonments', 'city mall'] },
  { name: 'Kaneshie Market', area: 'Kaneshie, Accra', lat: 5.5690, lng: -0.2450, aliases: ['kaneshie'] },
  { name: 'Achimota Mall', area: 'Achimota, Accra', lat: 5.6160, lng: -0.2250, aliases: ['achimota', 'achimota mall'] },
  { name: 'Madina Market', area: 'Madina, Accra', lat: 5.6830, lng: -0.1660, aliases: ['madina'] },
  { name: 'East Legon (American House)', area: 'East Legon, Accra', lat: 5.6350, lng: -0.1570, aliases: ['east legon', 'american house'] },
  { name: '37 Military Hospital', area: 'Liberation Road, Accra', lat: 5.5860, lng: -0.1900, aliases: ['37', '37 hospital', 'military hospital'] },
  { name: 'Lapaz Market', area: 'Lapaz, Accra', lat: 5.6060, lng: -0.2440, aliases: ['lapaz'] },
  { name: 'Tesano Police Station', area: 'Tesano, Accra', lat: 5.6030, lng: -0.2330, aliases: ['tesano'] },
  { name: 'Dzorwulu Total Station', area: 'Dzorwulu, Accra', lat: 5.6020, lng: -0.1960, aliases: ['dzorwulu'] },
  { name: 'Kotoka International Airport', area: 'Airport, Accra', lat: 5.6052, lng: -0.1668, aliases: ['airport', 'kotoka'] },
  { name: 'Accra Mall', area: 'Spintex Road, Accra', lat: 5.6230, lng: -0.1730, aliases: ['accra mall'] },
  { name: 'Makola Market', area: 'Accra Central', lat: 5.5460, lng: -0.2060, aliases: ['makola'] },
  { name: 'Tema Station', area: 'Accra Central', lat: 5.5500, lng: -0.2080, aliases: ['tema station'] },
  { name: 'Arts Centre', area: 'High Street, Accra', lat: 5.5410, lng: -0.2090, aliases: ['arts centre', 'art centre'] },
  { name: 'Korle Bu Teaching Hospital', area: 'Korle Bu, Accra', lat: 5.5360, lng: -0.2260, aliases: ['korle bu', 'korle-bu'] },
  { name: 'Dansoman Last Stop', area: 'Dansoman, Accra', lat: 5.5450, lng: -0.2620, aliases: ['dansoman'] },
  { name: 'Kasoa Toll Booth', area: 'Kasoa, Central Region', lat: 5.5330, lng: -0.4160, aliases: ['kasoa'] },
  { name: 'Spintex Road (Papaye)', area: 'Spintex, Accra', lat: 5.6260, lng: -0.1150, aliases: ['spintex'] },
  { name: 'Teshie Nungua Estate', area: 'Teshie, Accra', lat: 5.5830, lng: -0.0850, aliases: ['teshie', 'nungua'] },
  { name: 'Tema Community 1 Market', area: 'Tema, Greater Accra', lat: 5.6690, lng: -0.0170, aliases: ['tema'] },
  { name: 'Ashaiman Roundabout', area: 'Ashaiman, Greater Accra', lat: 5.6930, lng: -0.0410, aliases: ['ashaiman'] },
  { name: 'GIMPA Main Gate', area: 'Greenhill, Accra', lat: 5.6180, lng: -0.2040, aliases: ['gimpa'] },
  { name: 'University of Ghana (Legon)', area: 'Legon, Accra', lat: 5.6510, lng: -0.1870, aliases: ['legon', 'university of ghana', 'ug'] },
  { name: 'UPSA Main Entrance', area: 'Madina, Accra', lat: 5.6470, lng: -0.1740, aliases: ['upsa'] },
  { name: 'Accra Institute of Technology (AIT)', area: 'Tesano, Accra', lat: 5.6040, lng: -0.2290, aliases: ['ait'] },
  { name: 'Takoradi Market Circle', area: 'Takoradi, Western Region', lat: 4.8990, lng: -1.7590, aliases: ['takoradi', 'market circle'] },
  { name: 'Cape Coast Castle', area: 'Cape Coast, Central Region', lat: 5.1040, lng: -1.2420, aliases: ['cape coast'] },
  { name: 'KNUST Main Gate', area: 'Kumasi, Ashanti Region', lat: 6.6740, lng: -1.5710, aliases: ['knust'] },
  { name: 'Tamale Central Market', area: 'Tamale, Northern Region', lat: 9.4040, lng: -0.8390, aliases: ['tamale'] }
];

function geoCacheGet(key) {
  const hit = geoCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > GEOCODE_TTL_MS) { geoCache.delete(key); return null; }
  return hit.value;
}

function geoCacheSet(key, value) {
  geoCache.set(key, { at: Date.now(), value });
  if (geoCache.size > 300) {
    const oldest = geoCache.keys().next().value;
    geoCache.delete(oldest);
  }
}

function localLandmarkSearch(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  return LOCAL_LANDMARKS.filter(l =>
    l.name.toLowerCase().includes(q) ||
    l.area.toLowerCase().includes(q) ||
    (l.aliases || []).some(a => a.includes(q) || q.includes(a))
  ).slice(0, 6).map(l => ({
    label: l.name,
    area: l.area,
    lat: l.lat,
    lng: l.lng,
    source: 'local'
  }));
}

async function nominatimFetch(pathname, params) {
  const wait = Math.max(0, GEOCODE_MIN_INTERVAL_MS - (Date.now() - lastGeoRequestAt));
  if (wait) await new Promise(r => { setTimeout(r, wait); });
  lastGeoRequestAt = Date.now();

  const url = new URL('https://nominatim.openstreetmap.org/' + pathname);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'YEBS-Noodles/1.0 (contact: stephenbelemtuguri@gmail.com)',
        'Accept': 'application/json',
        'Accept-Language': 'en'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error('Geocoder responded ' + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/geo/search', async (req, res) => {
  const query = cleanString(req.query.q || req.query.query, 120);
  if (query.length < 2) return res.json({ success: true, source: 'local', results: [] });

  const key = 'search:' + query.toLowerCase();
  const cached = geoCacheGet(key);
  if (cached) return res.json({ success: true, ...cached });

  let results = [];
  let source = 'osm';
  try {
    const rows = await nominatimFetch('search', {
      q: query,
      format: 'jsonv2',
      addressdetails: 1,
      limit: 7,
      countrycodes: 'gh',
      'accept-language': 'en'
    });
    results = (Array.isArray(rows) ? rows : []).map(row => ({
      label: row.name || row.display_name.split(',')[0],
      area: String(row.display_name || '').split(',').slice(1, 3).join(',').trim(),
      lat: Number(row.lat),
      lng: Number(row.lon),
      type: row.type || row.class || 'place',
      source: 'osm'
    })).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  } catch (err) {
    console.warn('[geo] online search failed, using local landmarks:', err.message);
    source = 'local';
    results = localLandmarkSearch(query);
  }

  if (!results.length) {
    source = source === 'osm' ? 'local' : source;
    results = localLandmarkSearch(query);
  }

  const payload = { results: results.slice(0, 7) };
  geoCacheSet(key, payload);
  res.json({ success: true, source, ...payload });
});

app.get('/api/geo/reverse', async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ success: false, message: 'Valid lat and lng are required.' });
  }
  const key = 'reverse:' + lat.toFixed(4) + ':' + lng.toFixed(4);
  const cached = geoCacheGet(key);
  if (cached) return res.json({ success: true, ...cached });

  try {
    const row = await nominatimFetch('reverse', { lat, lon: lng, format: 'jsonv2', zoom: 18, addressdetails: 1 });
    const address = row && row.address ? row.address : {};
    const parts = [
      address.road || address.pedestrian || address.neighbourhood || address.suburb,
      address.suburb && address.suburb !== address.road ? address.suburb : null,
      address.city || address.town || address.village || 'Accra'
    ].filter(Boolean);
    const label = row && row.display_name ? String(row.display_name).split(',').slice(0, 3).join(', ') : parts.join(', ');
    const payload = { label: label || 'Your current location', area: parts.join(', ') };
    geoCacheSet(key, payload);
    res.json({ success: true, ...payload });
  } catch (err) {
    console.warn('[geo] reverse failed:', err.message);
    res.json({ success: true, label: 'Your current location', area: 'GPS pin captured', degraded: true });
  }
});

// Public delivery settings: the shared pickup point and the delivery fee.
app.get('/api/settings/public', (req, res) => {
  const db = loadDatabase();
  const session = (db.sessions && db.sessions[0]) || {};
  const pickup = session.pickupPoint || (db.settings && db.settings.pickup) || {
    name: 'YEBS Noodles Kitchen',
    lat: 5.558026,
    lng: -0.213706
  };
  res.json({
    success: true,
    pickupPoint: pickup,
    deliveryFee: Number(db.settings && db.settings.deliveryFee) || 15,
    momo: {
      payTo: (db.settings && db.settings.momo && db.settings.momo.payTo) || DEFAULT_MOMO_SETTINGS.payTo,
      accountName: (db.settings && db.settings.momo && db.settings.momo.accountName) || DEFAULT_MOMO_SETTINGS.accountName
    }
  });
});

app.put('/api/admin/settings/pickup', requireRole('admin'), async (req, res) => {
  const body = req.body || {};
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const name = cleanString(body.name || body.pickupPointName, 160);
  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ success: false, message: 'Set the pickup point on the map or pick a landmark first.' });
  }
  if (!name) {
    return res.status(400).json({ success: false, message: 'Give the shared pickup point a name customers will recognise.' });
  }
  const db = loadDatabase();
  db.settings = db.settings || {};
  const pickup = {
    name,
    address: cleanString(body.address, 220) || name,
    lat,
    lng,
    updatedAt: new Date().toISOString(),
    setBy: (req.auth.admin && (req.auth.admin.name || req.auth.admin.username)) || 'Admin',
    setByRole: 'admin'
  };
  db.settings.pickup = pickup;
  if (body.deliveryFee !== undefined) {
    const fee = toAmount(body.deliveryFee);
    if (fee !== null && fee >= 0 && fee <= 200) db.settings.deliveryFee = fee;
  }
  db.sessions = db.sessions && db.sessions.length ? db.sessions : [{ sessionNumber: 1, status: 'ACTIVE' }];
  db.sessions[0].pickupPoint = pickup;
  db.orders.forEach(o => {
    if (o.status !== 'delivered' && o.status !== 'cancelled') {
      o.pickupPoint = pickup;
      o.pickupPointName = pickup.name;
    }
  });
  const failure = await requireDurableSave(db);
  if (failure) return res.status(503).json({ success: false, persisted: false, message: failure });
  logAction('PICKUP_POINT_UPDATED', pickup.setBy, pickup.name, { lat, lng, deliveryFee: db.settings.deliveryFee }, req);
  res.json({ success: true, persisted: true, pickupPoint: pickup, deliveryFee: db.settings.deliveryFee });
});

// ==========================================================
// WHATSAPP ORDER NOTIFICATIONS (server-side, no redirect)
// ==========================================================
// WhatsApp Cloud API credentials are optional. When they are present the
// kitchen gets the order automatically in the background; when they are not,
// the attempt is stored in the database so the admin can see exactly what is
// missing instead of the customer being bounced to wa.me.
function whatsappConfig() {
  return {
    token: process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN ||
      process.env.WHATSAPP_CLOUD_TOKEN || process.env.META_WHATSAPP_TOKEN || '',
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID ||
      process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || '',
    to: String(process.env.WHATSAPP_TO || process.env.YEBS_WHATSAPP_TO || '233559103452').replace(/[^\d]/g, ''),
    version: process.env.WHATSAPP_API_VERSION || 'v20.0'
  };
}

function orderWhatsAppText(order) {
  const lines = [
    'NEW YEBS NOODLES ORDER #' + order.id,
    'Customer: ' + order.customer,
    'Phone: ' + (order.phone || '-'),
    'Fulfilment: ' + order.fulfilment,
    'Location: ' + (order.location || '-'),
    'Items: ' + (order.items || []).map(i => (i.quantity || 1) + ' x ' + i.name).join(', '),
    'Total: GH' + Number(order.total || 0).toFixed(2),
    'Payment: ' + order.payment + ' (' + order.paymentStatus + ')',
    'Order ID / PIN: ' + order.id + ' / ' + order.pickupPin
  ];
  if (order.notes) lines.push('Notes: ' + order.notes);
  return lines.join('\n');
}

// A free WhatsApp relay the owner can activate without a Meta developer
// account: send "I allow callmebot to send me messages" to +34 644 51 95 23
// once from the shop phone, then set WHATSAPP_CALLMEBOT_APIKEY=<key you receive>.
function callmebotConfig() {
  return {
    apiKey: String(process.env.WHATSAPP_CALLMEBOT_APIKEY || process.env.CALLMEBOT_APIKEY || '').replace(/[^A-Za-z0-9]/g, ''),
    phone: String(process.env.WHATSAPP_CALLMEBOT_PHONE || process.env.CALLMEBOT_PHONE || '').replace(/[^\d]/g, '')
      || whatsappConfig().to
  };
}

async function sendOwnerWhatsApp(text) {
  const cfg = whatsappConfig();
  const results = [];

  // 1. Official WhatsApp Cloud API (Meta business number) when configured.
  if (cfg.token && cfg.phoneId) {
    try {
      let providerError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10000);
          const response = await fetch('https://graph.facebook.com/' + cfg.version + '/' + cfg.phoneId + '/messages', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: cfg.to,
              type: 'text',
              text: { preview_url: false, body: String(text).slice(0, 3800) }
            }),
            signal: controller.signal
          }).finally(() => clearTimeout(timer));
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error((payload.error && payload.error.message) || ('WhatsApp API ' + response.status));
          return {
            ok: true,
            provider: 'whatsapp-cloud',
            providerId: payload.messages && payload.messages[0] ? payload.messages[0].id : null
          };
        } catch (err) {
          providerError = err;
          if (attempt < 3) await new Promise(resolve => {
            setTimeout(resolve, attempt * 750);
          });
        }
      }
      throw providerError || new Error('WhatsApp delivery failed.');
    } catch (err) {
      results.push('cloud: ' + err.message);
    }
  } else {
    results.push('cloud: not-configured (set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID on Render)');
  }

  // 2. CallMeBot fallback so the kitchen still gets the alert in background.
  const bot = callmebotConfig();
  if (bot.apiKey && bot.phone) {
    try {
      const message = String(text || '').trim();
      const chunks = [];
      for (let start = 0; start < message.length; start += 900) {
        chunks.push(message.slice(start, start + 900));
      }
      for (const chunk of (chunks.length ? chunks : ['YEBS Noodles notification'])) {
        let lastError = null;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          try {
            const url = 'https://api.callmebot.com/whatsapp.php?phone=%2B' + encodeURIComponent(bot.phone)
              + '&text=' + encodeURIComponent(chunk)
              + '&apikey=' + encodeURIComponent(bot.apiKey);
            const response = await fetch(url, {
              headers: { 'User-Agent': 'YEBS-Noodles-Server/1.0', Accept: 'text/plain' },
              signal: AbortSignal.timeout(15000)
            });
            const body = await response.text().catch(() => '');
            if (!response.ok || /error|invalid|not activated/i.test(body.slice(0, 200))) {
              throw new Error(body.slice(0, 160) || ('CallMeBot ' + response.status));
            }
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
            if (attempt < 4) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
          }
        }
        if (lastError) throw lastError;
      }
      return { ok: true, provider: 'callmebot', providerId: null };
    } catch (err) {
      results.push('callmebot: ' + err.message);
    }
  } else {
    results.push('callmebot: not-configured (set WHATSAPP_CALLMEBOT_APIKEY)');
  }

  return { ok: false, reason: results.filter(Boolean).join('; ') };
}

async function notifyOrderCreated(db, order) {
  db.notifications = db.notifications || [];
  const cfg = whatsappConfig();
  const entry = {
    id: 'ntf-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    orderId: order.id,
    channel: 'whatsapp',
    to: cfg.to,
    createdAt: new Date().toISOString(),
    status: 'queued',
    message: orderWhatsAppText(order)
  };

  order.notificationStatus = entry.status;
  db.notifications.unshift(entry);
  if (db.notifications.length > 500) db.notifications.length = 500;
  const persistenceError = await requireDurableSave(db);
  if (persistenceError) throw new Error(persistenceError);

  let delivered;
  try {
    delivered = await sendOwnerWhatsApp(entry.message);
  } catch (err) {
    delivered = { ok: false, reason: err.message };
  }
  entry.status = delivered.ok ? 'sent' : 'failed';
  entry.provider = delivered.provider || null;
  entry.providerId = delivered.providerId || null;
  entry.reason = delivered.reason || null;
  entry.sentAt = delivered.ok ? new Date().toISOString() : null;
  if (!delivered.ok) console.warn('[whatsapp] order notification not delivered:', delivered.reason);
  await requireDurableSave(db).catch(err => console.warn('[whatsapp] notification status persistence failed:', err.message));
  order.notificationStatus = entry.status;
  return entry;
}

// A WhatsApp hand-off that always works: even when no API credential is
// configured yet, the customer/rider can open this link with the full message
// already typed in, so nothing is ever lost.
function whatsappFallbackUrl(text, to) {
  const target = String(to || whatsappConfig().to || '').replace(/[^\d]/g, '');
  return 'https://wa.me/' + target + '?text=' + encodeURIComponent(String(text || '').slice(0, 3000));
}

// Which provider (if any) can deliver automatically right now.
function whatsappReadiness() {
  const cfg = whatsappConfig();
  const bot = callmebotConfig();
  const provider = (cfg.token && cfg.phoneId)
    ? 'whatsapp-cloud'
    : ((bot.apiKey && bot.phone) ? 'callmebot' : null);
  return { configured: Boolean(provider), provider, to: cfg.to };
}

function notificationView(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    kind: entry.kind || 'order',
    status: entry.status,
    provider: entry.provider || null,
    reason: entry.reason || null,
    createdAt: entry.createdAt || null,
    sentAt: entry.sentAt || null,
    autoSent: entry.status === 'sent',
    fallbackUrl: entry.fallbackUrl || whatsappFallbackUrl(entry.message || '')
  };
}

// Register the message before the response is sent so the client can poll it
// while the bot works in the background.
function queueNotification(db, order, kind, message) {
  db.notifications = db.notifications || [];
  const entry = {
    id: 'ntf-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    orderId: order.id,
    kind,
    channel: 'whatsapp',
    to: whatsappConfig().to,
    createdAt: new Date().toISOString(),
    status: 'sending',
    message,
    fallbackUrl: whatsappFallbackUrl(message)
  };
  db.notifications.unshift(entry);
  if (db.notifications.length > 500) db.notifications.length = 500;
  return entry;
}

// Runs after the HTTP response: tries Cloud API then CallMeBot, updates the
// ledger, persists it, and pushes the result over SSE so open screens update.
async function deliverNotification(entryId) {
  const db = loadDatabase();
  const entry = (db.notifications || []).find(n => n.id === entryId);
  if (!entry) return null;
  const readiness = whatsappReadiness();
  let delivered;
  try {
    delivered = await sendOwnerWhatsApp(entry.message);
  } catch (err) {
    delivered = { ok: false, reason: err.message };
  }
  if (delivered.ok) {
    entry.status = 'sent';
    entry.provider = delivered.provider;
    entry.providerId = delivered.providerId || null;
    entry.sentAt = new Date().toISOString();
  } else {
    entry.status = readiness.configured ? 'failed' : 'not-configured';
    entry.reason = delivered.reason;
    console.warn('[whatsapp] ' + entry.kind + ' notification not delivered:', delivered.reason);
  }
  const order = (db.orders || []).find(o => String(o.id).toUpperCase() === String(entry.orderId).toUpperCase());
  if (order && entry.kind === 'order') order.notificationStatus = entry.status;
  try {
    const persistenceError = await requireDurableSave(db);
    if (persistenceError) console.warn('[whatsapp] notification ledger not persisted:', persistenceError);
  } catch (err) {
    console.warn('[whatsapp] notification ledger save failed:', err.message);
  }
  pushOrderUpdate(entry.orderId, { type: 'notification', notification: notificationView(entry) });
  return entry;
}

// The delivery report the rider's hand-over triggers, built from the database
// copy of the order (never from stale browser storage).
function deliveryReportText(order, actor) {
  const items = (order.items || [])
    .map(i => (i.quantity || 1) + ' x ' + i.name)
    .join(', ');
  const deliveredAt = order.deliveredAt ? new Date(order.deliveredAt) : new Date();
  return [
    '*YEBS NOODLES - DELIVERY COMPLETED*',
    'Order: ' + order.id + ' (PIN ' + (order.pickupPin || '-') + ' verified)',
    'Customer: ' + order.customer + ' - ' + (order.phone || '-'),
    'Items: ' + (items || '-'),
    'Total: GH' + Number(order.total || 0).toFixed(2) + ' - ' + (order.payment || '-') + ' (' + (order.paymentStatus || 'unpaid') + ')',
    'Fulfilment: ' + (order.fulfilment || '-') + ' - ' + (order.location || '-'),
    'Rider: ' + (actor || order.driverName || 'RIDER'),
    'Delivered: ' + deliveredAt.toLocaleString('en-GB', { timeZone: 'Africa/Accra' })
  ].join('\n');
}

app.get('/api/admin/notifications', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  res.json({ success: true, notifications: (db.notifications || []).slice(0, 100) });
});

// Customer/rider polling endpoint: "is the bot done sending this message?"
app.get('/api/orders/:id/notification', (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (!hasOrderAccess(order, req)) return res.status(403).json({ success: false, message: 'Order access token required.' });
  const kind = cleanString(req.query.kind || '', 20).toLowerCase();
  const entries = (db.notifications || [])
    .filter(n => String(n.orderId).toUpperCase() === order.id.toUpperCase() && (!kind || (n.kind || 'order') === kind))
    .slice(0, 5)
    .map(notificationView);
  res.json({
    success: true,
    notification: entries[0] || null,
    notifications: entries,
    whatsapp: whatsappReadiness()
  });
});

// Send one plain text message to an individual WhatsApp phone. Used by the
// password-recovery flow and rider handover notices. Tries the owner's
// CallMeBot relay as a fallback when the Cloud API is unavailable.
async function sendWhatsAppText(to, text) {
  const cfg = whatsappConfig();
  const target = String(to || cfg.to || '').replace(/[^\d]/g, '');
  if (!target) return { ok: false, reason: 'no-phone' };
  if (cfg.token && cfg.phoneId) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch('https://graph.facebook.com/' + cfg.version + '/' + cfg.phoneId + '/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: target,
          type: 'text',
          text: { preview_url: false, body: String(text).slice(0, 3800) }
        }),
        signal: controller.signal
      }).finally(() => clearTimeout(timer));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((payload.error && payload.error.message) || ('WhatsApp API ' + response.status));
      return { ok: true, providerId: payload.messages && payload.messages[0] ? payload.messages[0].id : null };
    } catch (err) {
      console.warn('[whatsapp] cloud message failed:', err.message);
    }
  }
  // Fallback: the owner's own relay number can still deliver notices.
  const bot = callmebotConfig();
  if (bot.apiKey && bot.phone) {
    try {
      const url = 'https://api.callmebot.com/whatsapp.php?phone=%2B' + encodeURIComponent(bot.phone)
        + '&text=' + encodeURIComponent(String(text).slice(0, 1000))
        + '&apikey=' + encodeURIComponent(bot.apiKey);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
      const body = await response.text().catch(() => '');
      if (!response.ok || /error|invalid/i.test(body.slice(0, 200))) {
        throw new Error(body.slice(0, 160) || ('CallMeBot ' + response.status));
      }
      return { ok: true, provider: 'callmebot' };
    } catch (err) {
      console.warn('[whatsapp] callmebot failed:', err.message);
      return { ok: false, reason: err.message };
    }
  }
  return { ok: false, reason: 'whatsapp-not-configured' };
}

// ==========================================================
// SECURITY PRIMITIVES — bcrypt passwords + HMAC session tokens
// ==========================================================

const BCRYPT_ROUNDS = 10;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// The published legacy password is only retained to identify and invalidate
// old seeded accounts. New administrator credentials must come from env.
const PUBLISHED_DEFAULT_ADMIN_PASSWORD = 'goodfood@123';
const PUBLISHED_DEFAULT_ADMIN_USERNAME = 'goodfood';
const ADMIN_USERNAME_CONFIGURED = Boolean(String(process.env.ADMIN_USERNAME || '').trim());
const DEFAULT_ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || PUBLISHED_DEFAULT_ADMIN_USERNAME).trim();
const DEFAULT_ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
// An explicitly configured ADMIN_PASSWORD is trusted even when it matches the
// historical default ("goodfood@123"): the owner chooses to run the shop with
// these credentials and must be able to sign in with them. Deployments that do
// not set ADMIN_PASSWORD keep the published-password protection below.
const ADMIN_PASSWORD_CONFIGURED = Boolean(DEFAULT_ADMIN_PASSWORD);
const ADMIN_CREDENTIAL_RESET_VERSION = resolvedAdminCredentialResetVersion;
const DEFAULT_ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'yebsnoodles@gmail.com').trim();
const DEFAULT_ADMIN_PHONE = String(process.env.ADMIN_RECOVERY_PHONE || '0559103452').trim();

// A stable signing secret is generated once and never leaves this machine.
let AUTH_SECRET = process.env.YEBS_AUTH_SECRET || '';
if (!AUTH_SECRET && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)) {
  // Derive a stable secret from the service key so sessions remain valid across
  // server instances when an explicit signing secret has not been configured.
  AUTH_SECRET = crypto
    .createHmac('sha256', String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY))
    .update('yebs-auth-v1')
    .digest('hex');
  console.warn('[security] YEBS_AUTH_SECRET not set; deriving a stable secret from the Supabase service key. Set YEBS_AUTH_SECRET explicitly to rotate sessions.');
}
if (!AUTH_SECRET) {
  try {
    if (fs.existsSync(SECRET_FILE)) {
      AUTH_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    }
    if (!AUTH_SECRET) {
      AUTH_SECRET = crypto.randomBytes(48).toString('hex');
      fs.writeFileSync(SECRET_FILE, AUTH_SECRET, { mode: 0o600 });
    }
  } catch (e) {
    AUTH_SECRET = crypto.randomBytes(48).toString('hex');
    // Serverless filesystems are read-only and every instance would get a
    // different secret, silently invalidating every token it issued. Shout
    // about it so the deployment is fixed instead of "random logouts".
    console.error('[security] YEBS_AUTH_SECRET is not set. Sessions will not survive between instances - set it in the hosting environment variables.');
  }
}

function hashPassword(plain) {
  // bcrypt generates a unique random salt for every password automatically.
  return bcrypt.hashSync(String(plain), BCRYPT_ROUNDS);
}

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

function verifyPassword(plain, stored) {
  if (!stored) return false;
  if (isBcryptHash(stored)) {
    try { return bcrypt.compareSync(String(plain), stored); } catch (e) { return false; }
  }
  // Legacy plaintext record: compare, then the caller upgrades it to bcrypt.
  return String(plain) === String(stored);
}

function createToken(subject, role, extra = {}) {
  const payload = {
    sub: String(subject),
    role,
    ...extra,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    jti: crypto.randomBytes(12).toString('hex')
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function bearerFrom(req) {
  const raw = req.headers.authorization || '';
  const match = String(raw).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function authenticate(req) {
  const payload = verifyToken(bearerFrom(req));
  if (!payload) return null;
  const db = loadDatabase();
  // Bumping sessionEpoch (password reset) invalidates every token issued
  // before the change, even though the HMAC itself is still valid.
  const epochMatches = (account) => Number(payload.sessionEpoch || 0) === Number(account.sessionEpoch || 0);
  if (payload.role === 'admin') {
    const admin = db.admins.find(a => a.id === payload.sub);
    return admin && epochMatches(admin) ? { payload, admin } : null;
  }
  if (payload.role === 'driver') {
    const driver = db.drivers.find(d => d.id === payload.sub);
    return driver && epochMatches(driver) ? { payload, driver } : null;
  }
  return null;
}

function requireRole(...roles) {
  return (req, res, next) => {
    const auth = authenticate(req);
    if (!auth || !roles.includes(auth.payload.role)) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please sign in again.' });
    }
    req.auth = auth;
    next();
  };
}

// Brute-force protection: 5 failed attempts per identity per 15 minutes.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10; // hard lockout after this many attempts
const LOGIN_SOFT_FAILURES = 5; // 30-second cooldown starts here
const loginAttempts = new Map();

function loginKey(req, role, identity) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local').toString().split(',')[0].trim();
  return `${role}|${ip}|${String(identity || '').toLowerCase()}`;
}

function rateCheck(req, role, identity) {
  const key = loginKey(req, role, identity);
  const record = loginAttempts.get(key);
  if (!record) return { blocked: false };
  // Hard block (full window lockout after 10 fails)
  if (record.blockedUntil && record.blockedUntil > Date.now()) {
    return {
      blocked: true,
      retryAfter: Math.ceil((record.blockedUntil - Date.now()) / 1000),
      retryAfterMs: record.blockedUntil - Date.now(),
      hardBlocked: true
    };
  }
  // Soft 30-second cooldown between attempts (after 5 fails)
  if (record.cooldownUntil && record.cooldownUntil > Date.now()) {
    return {
      blocked: true,
      retryAfter: Math.ceil((record.cooldownUntil - Date.now()) / 1000),
      retryAfterMs: record.cooldownUntil - Date.now(),
      softBlock: true
    };
  }
  if (record.firstAt && (Date.now() - record.firstAt) > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
  }
  return { blocked: false, count: record ? record.count : 0 };
}

async function sendLockoutEmail(role, identity) {
  try {
    const smtpUser = process.env.SMTP_USER || '';
    const to = process.env.ADMIN_EMAIL || 'yebsnoodles@gmail.com';
    if (!smtpUser || !to) return;
    let nodemailer;
    try { nodemailer = require('nodemailer'); } catch (e) { return; }
    const transporter = nodemailer.createTransporter({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: smtpUser, pass: process.env.SMTP_PASSWORD || '' }
    });
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || `YEBS Noodles <${smtpUser}>`,
      to,
      subject: `🔒 YEBS Security Alert: ${role} account "${identity}" locked after 10 failed logins`,
      html: `<div style="font-family:sans-serif;max-width:520px;margin:auto"><h2 style="color:#b91c1c">Security Alert</h2><p>The <strong>${role}</strong> account <strong>${identity}</strong> has been locked out after <strong>10 consecutive failed login attempts</strong> at ${new Date().toUTCString()}.</p><p>If this was not you, please reset your password immediately.</p><hr><p style="font-size:0.85rem;color:#555">YEBS Noodles Automated Security &bull; Do not reply to this email.</p></div>`
    });
  } catch (e) {
    console.warn('[LOCKOUT_EMAIL]', e.message);
  }
}

function rateFail(req, role, identity) {
  const key = loginKey(req, role, identity);
  const record = loginAttempts.get(key) || { count: 0, firstAt: Date.now(), blockedUntil: 0, cooldownUntil: 0 };
  if ((Date.now() - record.firstAt) > LOGIN_WINDOW_MS) {
    record.count = 0; record.firstAt = Date.now();
    record.blockedUntil = 0; record.cooldownUntil = 0;
  }
  record.count += 1;
  // Soft cooldown: 30s between each attempt after 5 failures
  if (record.count >= LOGIN_SOFT_FAILURES && record.count < LOGIN_MAX_FAILURES) {
    record.cooldownUntil = Date.now() + 30000;
    record.blockedUntil = 0;
  }
  // Hard lockout: full window after 10 failures + email alert
  if (record.count >= LOGIN_MAX_FAILURES) {
    record.blockedUntil = Date.now() + LOGIN_WINDOW_MS;
    record.cooldownUntil = 0;
    sendLockoutEmail(role, identity).catch(() => { });
  }
  loginAttempts.set(key, record);
  return record;
}

function rateSuccess(req, role, identity) {
  loginAttempts.delete(loginKey(req, role, identity));
}

// ==========================================================
// DATABASE
// ==========================================================

// Ensure all collections exist and create an administrator only when a
// non-default deployment password is explicitly configured.
const DEFAULT_MOMO_SETTINGS = { payTo: '0559103452', accountName: 'MATHEW TIA' };
const DEFAULT_PICKUP_POINT = {
  name: 'YEBS Noodles Kitchen',
  address: 'In front of Efex Hotel, Adabraka, Accra',
  lat: 5.558026,
  lng: -0.213706
};

function ensureSystemAccounts(db) {
  const collections = ['admins', 'drivers', 'orders', 'sessions', 'auditLogs', 'menuItems', 'payouts', 'reviews', 'notifications', 'recoveryCodes'];
  let changed = false;

  const isOldPickup = point => point && (
    (Math.abs(Number(point.lat) - 5.5612) < 0.000001 && Math.abs(Number(point.lng) + 0.2155) < 0.000001)
    || (Math.abs(Number(point.lat) - 5.557914) < 0.000001 && Math.abs(Number(point.lng) + 0.213738) < 0.000001)
    || (String(point.name || '').includes('Circle Odo Rice Junction'))
  );
  if (db.settings && isOldPickup(db.settings.pickup)) {
    db.settings.pickup = { ...DEFAULT_PICKUP_POINT, updatedAt: new Date().toISOString() };
    changed = true;
  }
  if (Array.isArray(db.sessions)) {
    db.sessions.forEach(session => {
      if (!session.pickupPoint || isOldPickup(session.pickupPoint)) {
        session.pickupPoint = { ...DEFAULT_PICKUP_POINT, updatedAt: new Date().toISOString() };
        changed = true;
      }
    });
  }

  collections.forEach(key => {
    if (!Array.isArray(db[key])) { db[key] = []; changed = true; }
  });

  if (!db.settings || typeof db.settings !== 'object' || Array.isArray(db.settings)) {
    db.settings = {};
    changed = true;
  }
  if (!db.settings.momo || typeof db.settings.momo !== 'object') {
    db.settings.momo = { ...DEFAULT_MOMO_SETTINGS };
    changed = true;
  }
  if (!db.settings.pickup || typeof db.settings.pickup !== 'object') {
    db.settings.pickup = { ...DEFAULT_PICKUP_POINT };
    changed = true;
  }
  if (!Number.isFinite(Number(db.settings.deliveryFee))) {
    db.settings.deliveryFee = 15;
    changed = true;
  } else {
    if (!db.settings.momo.payTo) { db.settings.momo.payTo = DEFAULT_MOMO_SETTINGS.payTo; changed = true; }
    if (!db.settings.momo.accountName) { db.settings.momo.accountName = DEFAULT_MOMO_SETTINGS.accountName; changed = true; }
  }

  if (db.admins.length === 0 && ADMIN_PASSWORD_CONFIGURED) {
    db.admins.push({
      id: 'adm-1',
      username: DEFAULT_ADMIN_USERNAME,
      password: hashPassword(DEFAULT_ADMIN_PASSWORD),
      email: DEFAULT_ADMIN_EMAIL,
      recoveryPhone: DEFAULT_ADMIN_PHONE,
      name: 'YEBS Administrator',
      role: 'SUPERADMIN',
      createdAt: new Date().toISOString()
    });
    changed = true;
    console.log(`[security] Seeded built-in administrator "${DEFAULT_ADMIN_USERNAME}" (${DEFAULT_ADMIN_EMAIL}).`);
  } else if (db.admins.length === 0) {
    console.error('[security] No administrator was created. Set a non-default ADMIN_PASSWORD before first sign-in.');
  } else {
    const legacyAdmins = db.admins.filter(admin =>
      admin.requiresPasswordSetup || verifyPassword(PUBLISHED_DEFAULT_ADMIN_PASSWORD, admin.password)
    );
    legacyAdmins.forEach(admin => {
      if (ADMIN_PASSWORD_CONFIGURED) {
        admin.password = hashPassword(DEFAULT_ADMIN_PASSWORD);
        admin.passwordUpdatedAt = new Date().toISOString();
        admin.sessionEpoch = (Number(admin.sessionEpoch) || 0) + 1;
        delete admin.requiresPasswordSetup;
        if (ADMIN_USERNAME_CONFIGURED && String(admin.username || '').toLowerCase() === PUBLISHED_DEFAULT_ADMIN_USERNAME) {
          admin.username = DEFAULT_ADMIN_USERNAME;
        }
        changed = true;
      } else if (!admin.requiresPasswordSetup) {
        admin.password = hashPassword(crypto.randomBytes(48).toString('hex'));
        admin.requiresPasswordSetup = true;
        admin.sessionEpoch = (Number(admin.sessionEpoch) || 0) + 1;
        changed = true;
        console.error('[security] Disabled a legacy default administrator password. Set ADMIN_USERNAME and a non-default ADMIN_PASSWORD to restore access.');
      }
    });

    if (ADMIN_CREDENTIAL_RESET_VERSION && ADMIN_USERNAME_CONFIGURED && ADMIN_PASSWORD_CONFIGURED &&
        String(db.settings.adminCredentialResetVersion || '') !== ADMIN_CREDENTIAL_RESET_VERSION) {
      const previousResetVersion = String(db.settings.adminCredentialResetVersion || '');
      if (/^render-deploy-build-/.test(previousResetVersion)) {
        db.settings.adminCredentialResetVersion = ADMIN_CREDENTIAL_RESET_VERSION;
        changed = true;
        console.log('[security] Migrated the legacy per-deploy reset marker without changing administrator credentials.');
      } else {
        const desiredUsername = DEFAULT_ADMIN_USERNAME.toLowerCase();
        const matchingAdmin = db.admins.find(admin =>
          String(admin.username || '').toLowerCase() === desiredUsername
        );
        const resetAdmin = matchingAdmin || (db.admins.length === 1 ? db.admins[0] : null);
        if (resetAdmin) {
          resetAdmin.username = DEFAULT_ADMIN_USERNAME;
          resetAdmin.password = hashPassword(DEFAULT_ADMIN_PASSWORD);
          resetAdmin.passwordUpdatedAt = new Date().toISOString();
          resetAdmin.sessionEpoch = (Number(resetAdmin.sessionEpoch) || 0) + 1;
          delete resetAdmin.requiresPasswordSetup;
          db.settings.adminCredentialResetVersion = ADMIN_CREDENTIAL_RESET_VERSION;
          changed = true;
          console.log(`[security] Applied one-time administrator credential reset version "${ADMIN_CREDENTIAL_RESET_VERSION}" to "${DEFAULT_ADMIN_USERNAME}".`);
        } else {
          console.error('[security] Administrator credential reset was not applied: set ADMIN_USERNAME to an existing account, or ensure exactly one administrator exists.');
        }
      }
    }

    // Ensure the default admin has email and recoveryPhone configured
    const defaultAdm = db.admins.find(a => String(a.username || '').toLowerCase() === DEFAULT_ADMIN_USERNAME.toLowerCase());
    if (defaultAdm) {
      if (!defaultAdm.email) { defaultAdm.email = DEFAULT_ADMIN_EMAIL; changed = true; }
      if (!defaultAdm.recoveryPhone) { defaultAdm.recoveryPhone = DEFAULT_ADMIN_PHONE; changed = true; }
    }
  }

  return changed;
}

function loadDatabase() {
  const cached = store.get();
  if (cached) {
    for (const key of ['orders', 'notifications', 'auditLogs', 'menuItems', 'payouts', 'reviews', 'drivers', 'admins', 'payments', 'driverReports']) {
      if (!Array.isArray(cached[key])) cached[key] = [];
    }
    return cached;
  }

  if (!fs.existsSync(DB_FILE)) {
    const initialData = {
      admins: [],
      drivers: [],
      orders: [],
      sessions: [
        {
          id: 1,
          sessionNumber: 1,
          status: "ACTIVE",
          startedAt: new Date().toISOString(),
          intermissionEndsAt: null,
          pickupPoint: {
            name: "YEBS Noodles Kitchen",
            lat: 5.558026,
            lng: -0.213706,
            updatedAt: new Date().toISOString()
          }
        }
      ],
      settings: {
        momo: { ...DEFAULT_MOMO_SETTINGS },
        pickup: { ...DEFAULT_PICKUP_POINT },
        deliveryFee: 15
      },
      auditLogs: [
        {
          id: "log-init",
          timestamp: new Date().toISOString(),
          action: "SYSTEM_INITIALIZED",
          actor: "SYSTEM",
          entity: "DATABASE",
          details: "YEBS Noodles API initialised with bcrypt-secured accounts."
        }
      ]
    };
    // Only touch the local mirror in local-file mode. In Supabase/Postgres mode
    // this document is just a seed: writing it would copy the live admin hash
    // (and customer data) onto the server's disk.
    if (store.remoteMode === 'local') {
      try { fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2)); } catch (e) { /* read-only fs */ }
    }
    ensureSystemAccounts(initialData);
    for (const key of ['orders', 'notifications', 'auditLogs', 'menuItems', 'payouts', 'reviews', 'drivers', 'admins', 'payments', 'driverReports']) {
      if (!Array.isArray(initialData[key])) initialData[key] = [];
    }
    return initialData;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (ensureSystemAccounts(parsed) && store.remoteMode === 'local') {
      try { fs.writeFileSync(DB_FILE, JSON.stringify(parsed, null, 2)); } catch (e) { /* read-only fs */ }
    }
    for (const key of ['orders', 'notifications', 'auditLogs', 'menuItems', 'payouts', 'reviews', 'drivers', 'admins', 'payments', 'driverReports']) {
      if (!Array.isArray(parsed[key])) parsed[key] = [];
    }
    return parsed;
  } catch (e) {
    console.error("Database read error, restoring default", e);
    const fallback = {
      admins: [], drivers: [], orders: [], sessions: [], auditLogs: [], menuItems: [], payouts: [], reviews: [], notifications: [],
      settings: { momo: { ...DEFAULT_MOMO_SETTINGS }, pickup: { ...DEFAULT_PICKUP_POINT }, deliveryFee: 15 }
    };
    ensureSystemAccounts(fallback);
    return fallback;
  }
}

// Hosts whose filesystem is wiped on every restart/redeploy. Writing the state
// file there looks successful but the data is gone minutes later.
function isEphemeralHost() {
  return Boolean(
    process.env.RENDER ||
    process.env.RENDER_SERVICE_ID ||
    process.env.AWS_LAMBDA_FUNCTION_NAME
  );
}

function saveDatabase(data) {
  // Memory + Supabase (when configured). The local file is only used when the
  // app is running in local-file mode: in production the remote row is the
  // source of truth, and mirroring it to disk would copy live customer data
  // (and bcrypt hashes) onto the server's filesystem for no benefit.
  const result = store.set(data);
  if (store.remoteMode === 'local') {
    try {
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      // Read-only filesystem — nothing else to persist.
    }
  }
  return result;
}

// Wrap a save for admin write routes: returns null when the change is durable,
// or a message explaining why it was not, so the dashboard never says "saved"
// for data that will disappear on the next restart.
async function requireDurableSave(db) {
  const result = await saveDatabase(db);
  if (result && result.ok) return null;
  const reason = (result && result.error) || 'the storage backend is unavailable';
  return `This change was NOT saved permanently: ${reason}`;
}

// One-time upgrade of any legacy plaintext passwords to bcrypt.
async function migratePasswords() {
  const db = loadDatabase();
  let changed = 0;
  const upgrade = (account, label) => {
    if (account.password && !isBcryptHash(account.password)) {
      account.password = hashPassword(account.password);
      account.passwordUpdatedAt = new Date().toISOString();
      changed += 1;
      console.log(`[security] Upgraded ${label} password to bcrypt.`);
    }
  };
  (db.admins || []).forEach(a => upgrade(a, `admin "${a.username}"`));
  (db.drivers || []).forEach(d => upgrade(d, `driver "${d.username}"`));
  if (changed) {
    db.auditLogs = db.auditLogs || [];
    db.auditLogs.unshift({
      id: "log-migrate-" + Date.now(),
      timestamp: new Date().toISOString(),
      action: "PASSWORDS_REHASHED",
      actor: "SYSTEM",
      entity: "SECURITY",
      details: `${changed} legacy password(s) upgraded to bcrypt with unique salts.`,
      ipOrAgent: "LOCAL"
    });
    const result = await saveDatabase(db);
    if (!result || !result.ok) {
      throw new Error(`Failed to persist password migration: ${(result && result.error) || 'storage backend unavailable'}`);
    }
    console.log(`[security] ${changed} password(s) upgraded to bcrypt.`);
  }
  return changed;
}

// Add an Audit Log entry for traceability
function logAction(action, actor, entity, details = null, req = null) {
  const db = loadDatabase();
  db.auditLogs = db.auditLogs || [];
  const logEntry = {
    id: "log-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    timestamp: new Date().toISOString(),
    action,
    actor: actor || "ANONYMOUS",
    entity: entity || "GENERAL",
    details: typeof details === 'object' ? JSON.stringify(details) : details,
    ipOrAgent: req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) : "LOCAL"
  };
  db.auditLogs.unshift(logEntry);
  if (db.auditLogs.length > 500) db.auditLogs.pop();
  saveDatabase(db);
  return logEntry;
}

// Public driver shape (never exposes passwords)
function publicDriver(d) {
  return {
    id: d.id,
    username: d.username,
    name: d.name || `${d.fname || ''} ${d.lname || ''}`.trim(),
    fname: d.fname,
    lname: d.lname,
    phone: d.phone,
    vehicle: d.vehicle,
    // Never ship a base64 image in a list payload: point at the cached photo
    // endpoint instead. Works for legacy inline photos and Storage URLs alike.
    photo: d.photoUrl || (d.photo ? `/api/drivers/${encodeURIComponent(d.id)}/photo` : null),
    photoUrl: d.photoUrl || (d.photo ? `/api/drivers/${encodeURIComponent(d.id)}/photo` : null),
    isActive: d.isActive !== false,
    isOnline: d.isActive !== false,
    approvalStatus: d.approvalStatus || (d.approvedAt ? 'approved' : 'pending'),
    lat: d.lat,
    lng: d.lng,
    speedKmh: d.speedKmh || 0,
    statusText: d.statusText || 'Available',
    lastLocationUpdate: d.lastLocationUpdate || d.createdAt,
    createdAt: d.createdAt
  };
}

function generateDriverUsername(fname, lname, existingDrivers) {
  const cleanF = (fname || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanL = (lname || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = (cleanF + cleanL) || "driver";
  let username = base;
  let counter = 1;
  while (existingDrivers.some(d => d.username === username)) {
    username = `${base}${counter}`;
    counter++;
  }
  return username;
}

function cleanString(value, max = 400) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function toAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

// ==========================================================
// ORDER IDS — YB-XXXXXX (6-character base-32 suffix)
// ==========================================================
// The old format was YB-0000…YB-9999: a lifetime ceiling of 10,000 orders.
// The suffix is now 6 characters from an unambiguous alphabet (~1.07 billion
// combinations), while legacy four-digit IDs keep working forever.

const ORDER_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomOrderSuffix(length = 6) {
  let suffix = '';
  for (let i = 0; i < length; i += 1) {
    suffix += ORDER_ID_ALPHABET[crypto.randomInt(0, ORDER_ID_ALPHABET.length)];
  }
  return suffix;
}

// A PIN only needs to be unique among orders that can still be handed over.
// Delivered/cancelled orders keep their historical PIN for the record.
function isActiveOrder(order) {
  const status = String(order && order.status || '').toLowerCase();
  return status !== 'delivered' && status !== 'cancelled';
}

function newPickupPin(db, orderId = '') {
  const usedPins = new Set(
    (db.orders || []).filter(isActiveOrder).map(o => String(o.pickupPin || ''))
  );
  const publicIdSuffix = String(orderId).slice(-4);
  for (let i = 0; i < 20000; i++) {
    const pin = String(crypto.randomInt(1000, 10000));
    if (!usedPins.has(pin) && pin !== publicIdSuffix) return pin;
  }
  for (let n = 1000; n <= 9999; n++) {
    const pin = String(n);
    if (!usedPins.has(pin) && pin !== publicIdSuffix) return pin;
  }
  return null;
}

function newOrderId(db) {
  const used = new Set((db.orders || []).map(o => String(o.id || '').toUpperCase()));
  for (let i = 0; i < 100; i++) {
    const id = `YB-${randomOrderSuffix(6)}`;
    if (!used.has(id)) {
      const pin = newPickupPin(db, id);
      if (pin) return { id, pin };
    }
  }
  throw new Error('Could not allocate a unique order reference. Please try again.');
}

function normalizeOrderId(raw) {
  const value = cleanString(raw, 24).toUpperCase().replace(/\s+/g, '');
  if (!value) return '';
  // Legacy four-digit reference (YB-1234 / 1234).
  if (/^\d{4}$/.test(value)) return `YB-${value}`;
  const prefixed = value.match(/^YB-?([A-Z0-9]{4,12})$/);
  if (prefixed) return `YB-${prefixed[1]}`;
  // A bare modern suffix, e.g. "A7K2M9".
  if (/^[A-Z0-9]{5,12}$/.test(value) && /[A-Z]/.test(value)) return `YB-${value}`;
  return value;
}

function paymentModeFor(paymentLabel) {
  const label = String(paymentLabel || '');
  if (/cash|pay on delivery|on arrival|upon delivery/i.test(label)) return 'cash';
  return 'momo';
}

function paymentFieldsFor(order) {
  return {
    paymentMode: order.paymentMode || paymentModeFor(order.payment),
    paymentNetwork: order.paymentNetwork || normalizeNetwork(order.payment) || null,
    paymentNetworkLabel: (MOMO_NETWORKS[order.paymentNetwork] || {}).label || null,
    paymentStatus: order.paymentStatus || (order.paymentVerified ? 'paid' : 'unpaid'),
    paymentRef: order.paymentRef || order.id,
    paymentVerified: order.paymentVerified === true,
    paidAt: order.paidAt || null,
    verificationMethod: order.verificationMethod || null,
    momoAmount: order.momoAmount || null,
    momoTransactionRef: order.momoTransactionRef || null,
    momoRequestId: order.momoRequestId || null,
    momoRequestStatus: order.momoRequestStatus || null,
    momoRequestAt: order.momoRequestAt || null,
    momoReceipt: order.momoReceipt ? {
      // `image` stays for older clients; `imageUrl` points at object storage.
      image: order.momoReceipt.imageUrl || order.momoReceipt.image || null,
      imageUrl: order.momoReceipt.imageUrl || null,
      transactionRef: order.momoReceipt.transactionRef || '',
      uploadedAt: order.momoReceipt.uploadedAt || null,
      verified: order.momoReceipt.verified === true
    } : null
  };
}

// Orders reference the rider instead of embedding their photo. The URL points
// at a cacheable endpoint so a 13 KB base64 avatar is never duplicated into
// every order (which is what made the old state row 53 MB at 10k orders).
function driverPhotoUrl(driverRef) {
  if (!driverRef) return null;
  if (driverRef.photoUrl) return driverRef.photoUrl;
  if (driverRef.photo) return /^data:/i.test(driverRef.photo) ? null : driverRef.photo;
  const id = driverRef.id;
  if (!id) return null;
  try {
    const db = loadDatabase();
    const driver = (db.drivers || []).find(d => String(d.id) === String(id));
    if (driver && (driver.photoUrl || driver.photo)) {
      return driver.photoUrl || `/api/drivers/${encodeURIComponent(id)}/photo`;
    }
  } catch (e) { /* projection must never throw */ }
  return null;
}

// One-time cleanup for orders created before images moved out of the row:
// the rider's face photo belongs to the driver record, not to every order.
function stripOrderMedia(db) {
  let changed = false;
  for (const order of (db.orders || [])) {
    if (order && order.driver && order.driver.photo) {
      const driver = (db.drivers || []).find(d => d && String(d.id) === String(order.driver.id));
      if (driver && !driver.photo) driver.photo = order.driver.photo;
      if (driver && !driver.photoUrl && typeof driver.photo === 'string' && !/^data:/i.test(driver.photo)) {
        driver.photoUrl = driver.photo;
      }
      delete order.driver.photo;
      changed = true;
    }
  }
  return changed;
}

// Best-effort background migration of legacy inline images (rider photos and
// large receipt screenshots) into Supabase Storage. New uploads already go
// straight to Storage; this only shrinks data written by older builds.
async function migrateMediaToStorage(db) {
  if (!media.isConfigured()) return false;
  let changed = false;
  for (const driver of (db.drivers || [])) {
    if (typeof driver.photo === 'string' && /^data:/i.test(driver.photo)) {
      const url = await media.uploadDataUrl(driver.photo, { kind: 'drivers', id: driver.id });
      if (url) {
        driver.photo = url;
        driver.photoUrl = url;
        changed = true;
      }
    }
  }
  for (const order of (db.orders || [])) {
    const receipt = order && order.momoReceipt;
    if (receipt && typeof receipt.image === 'string' && /^data:/i.test(receipt.image) && receipt.image.length > 200_000) {
      const url = await media.uploadDataUrl(receipt.image, { kind: 'receipts', id: order.id });
      if (url) {
        receipt.image = url;
        receipt.imageUrl = url;
        changed = true;
      }
    }
  }
  if (changed) {
    const result = await store.set(db);
    if (!result || !result.ok) {
      console.warn('[media] legacy image migration could not be saved:', (result && result.error) || 'storage unavailable');
      return false;
    }
  }
  return changed;
}

// Public order projection: never leaks other customers' phone numbers,
// private notes, receipt images or payment audit trails.
function projectOrder(order, viewer = 'public') {
  const base = {
    id: order.id,
    sessionNumber: order.sessionNumber,
    createdAt: order.createdAt,
    customer: order.customer,
    fulfilment: order.fulfilment,
    location: order.location,
    mapPin: order.mapPin,
    customerCurrentLocation: order.customerCurrentLocation || null,
    timing: order.timing,
    items: order.items || [],
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    total: order.total,
    payment: order.payment,
    status: order.status,
    arrivedAt: order.arrivedAt || null,
    deliveredAt: order.deliveredAt || null,
    verifiedByDriver: order.verifiedByDriver === true,
    meetingPoint: order.meetingPoint || null,
    pickupPointName: order.pickupPointName || null,
    pickupPoint: order.pickupPoint || null,
    notificationStatus: order.notificationStatus || null,
    customerOrderNumber: Number(order.customerOrderNumber) || 1,
    congratulationsMessage: order.congratulationsMessage || null,
    cancellation: order.cancellation ? {
      status: order.cancellation.status || null,
      reason: order.cancellation.reason || null,
      requestedAt: order.cancellation.requestedAt || null,
      reviewedAt: order.cancellation.reviewedAt || null,
      reviewReason: order.cancellation.reviewReason || null
    } : null,
    refund: order.refund ? {
      status: order.refund.status || null,
      amount: Number(order.refund.amount) || 0,
      fee: Number(order.refund.fee) || 0,
      requestedAt: order.refund.requestedAt || null,
      reviewedAt: order.refund.reviewedAt || null,
      reviewReason: order.refund.reviewReason || null
    } : null,
    driver: order.driver ? {
      id: order.driver.id || null,
      name: order.driver.name || null,
      phone: order.driver.phone || null,
      vehicle: order.driver.vehicle || null,
      photo: driverPhotoUrl(order.driver),
      currentLocation: order.driver.currentLocation || null,
      lastUpdated: order.driver.lastUpdated || null,
      speedKmh: order.driver.speedKmh || 0,
      statusText: order.driver.statusText || null
    } : null,
    ...paymentFieldsFor(order)
  };

  if (viewer === 'admin' || viewer === 'checkout') base.pickupPin = order.pickupPin || null;

  if (viewer === 'admin' || viewer === 'driver') {
    base.phone = order.phone;
    base.notes = order.notes;
    base.paymentAudit = order.paymentAudit || [];
    base.momoSender = order.momoSender || null;
    base.kitchenAt = order.kitchenAt || null;
    base.enrouteAt = order.enrouteAt || null;
  } else {
    // The customer's own order keeps its receipt so the tracking screen can
    // show what was submitted, but the image is never exposed in list views.
    const receiptSource = order.momoReceipt && (order.momoReceipt.imageUrl || order.momoReceipt.image);
    if (receiptSource) {
      base.momoReceipt = {
        image: receiptSource,
        imageUrl: order.momoReceipt.imageUrl || null,
        transactionRef: order.momoReceipt.transactionRef || '',
        uploadedAt: order.momoReceipt.uploadedAt || null,
        verified: order.momoReceipt.verified === true
      };
    }
  }
  return base;
}

function viewerFromReq(req) {
  const auth = authenticate(req);
  if (!auth) return 'public';
  return auth.payload.role;
}

function customerOrderTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function hasOrderAccess(order, req) {
  const auth = req.auth || authenticate(req);
  if (auth && ['admin', 'driver'].includes(auth.payload.role)) return true;
  const supplied = String(req.headers['x-order-access-token'] || req.query.access_token || '');
  const stored = String(order.customerAccessTokenHash || '');
  if (!supplied || !stored) return false;
  const suppliedHash = Buffer.from(customerOrderTokenHash(supplied), 'hex');
  const storedHash = Buffer.from(stored, 'hex');
  return suppliedHash.length === storedHash.length && crypto.timingSafeEqual(suppliedHash, storedHash);
}

// ==========================================================
// 1. AUTHENTICATION ENDPOINTS
// ==========================================================

// ADMIN LOGIN — generic errors, rate limited, bcrypt verified.
app.post('/api/auth/admin/login', (req, res) => {
  const username = cleanString(req.body && req.body.username, 80);
  const password = String((req.body && req.body.password) || '');

  if (!username || !password) {
    return res.status(400).json({ success: false, message: "Username and password are required." });
  }

  const limit = rateCheck(req, 'admin', username);
  if (limit.blocked) {
    res.set('Retry-After', String(limit.retryAfter || 900));
    return res.status(429).json({ success: false, message: `Too many attempts. Try again in ${Math.ceil((limit.retryAfter || 900) / 60)} minute(s).` });
  }

  const db = loadDatabase();
  const lowerUser = username.toLowerCase();
  const digitsUser = username.replace(/\D/g, '');
  let admin = (db.admins || []).find(a =>
    String(a.username || '').toLowerCase() === lowerUser ||
    String(a.email || '').toLowerCase() === lowerUser ||
    (digitsUser.length >= 7 && String(a.recoveryPhone || a.phone || '').replace(/\D/g, '').endsWith(digitsUser.slice(-7)))
  );

  const credentialsMatch = Boolean(admin && !admin.requiresPasswordSetup && verifyPassword(password, admin.password));
  // The published default is only accepted when the operator explicitly chose
  // it via ADMIN_PASSWORD (see ADMIN_PASSWORD_CONFIGURED); otherwise it stays
  // locked out exactly as before.
  const isValid = credentialsMatch && (ADMIN_PASSWORD_CONFIGURED || password !== PUBLISHED_DEFAULT_ADMIN_PASSWORD);

  if (!admin || !isValid) {
    const record = rateFail(req, 'admin', username);
    logAction("ADMIN_LOGIN_FAILED", username, "ADMIN_PORTAL", { reason: "Invalid credentials", attempts: record.count }, req);
    return res.status(401).json({ success: false, message: "Invalid administrator credentials." });
  }

  // Upgrade legacy hashes / plaintext on successful login.
  if (!isBcryptHash(admin.password) || bcrypt.getRounds(admin.password) < BCRYPT_ROUNDS) {
    admin.password = hashPassword(password);
    admin.passwordUpdatedAt = new Date().toISOString();
    saveDatabase(db);
  }

  rateSuccess(req, 'admin', username);
  logAction("ADMIN_LOGIN_SUCCESS", admin.username, "ADMIN_PORTAL", { role: admin.role }, req);

  const token = createToken(admin.id, 'admin', { username: admin.username, name: admin.name, sessionEpoch: admin.sessionEpoch || 0 });
  res.json({
    success: true,
    message: "Admin authenticated successfully.",
    token,
    expiresInMs: SESSION_TTL_MS,
    admin: {
      id: admin.id,
      username: admin.username,
      name: admin.name,
      role: admin.role,
      token
    }
  });
});

// ADMIN LOCKOUT RESET — only works with the master password from .env
// This allows recovering from rate-limit lockout without restarting the server.
app.post('/api/auth/admin/unlock', (req, res) => {
  const { username, masterKey } = req.body || {};
  // Allow unlock if masterKey matches the original ADMIN_PASSWORD from env
  if (!ADMIN_PASSWORD_CONFIGURED || !masterKey || masterKey !== DEFAULT_ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid master key.' });
  }
  // Clear all rate limit records
  loginAttempts.clear();
  logAction('ADMIN_LOCKOUT_CLEARED', username || 'SYSTEM', 'ADMIN_PORTAL', { reason: 'Manual unlock via master key' });
  return res.json({ success: true, message: 'All login lockouts have been cleared. You may try logging in again.' });
});

// DRIVER SIGN UP
app.get('/api/auth/google/client-id', (req, res) => {
  res.json({ success: true, configured: Boolean(process.env.GOOGLE_CLIENT_ID), clientId: process.env.GOOGLE_CLIENT_ID || '' });
});

app.post('/api/auth/driver/google', async (req, res) => {
  try {
    const credential = cleanString(req.body && req.body.credential, 12000);
    const profile = await verifyGoogleCredential(credential);
    const db = loadDatabase();
    const driver = db.drivers.find(d => String(d.email || '').toLower().trim() === String(profile.email || '').toLower().trim());
    if (!driver) {
      return res.json({
        success: true,
        verified: true,
        signup: true,
        profile: { email: profile.email, givenName: profile.given_name || '', familyName: profile.family_name || '', name: profile.name || '', picture: profile.picture || '' }
      });
    }
    if (driver.approvalStatus === 'pending' || (!driver.approvalStatus && !driver.approvedAt && !driver.isActive)) {
      return res.status(403).json({ success: false, pending: true, driverId: driver.id, message: 'Your account is pending admin approval.' });
    }
    if (driver.approvalStatus === 'rejected') {
      return res.status(403).json({ success: false, rejected: true, message: driver.rejectionReason || 'Your registration was not approved.' });
    }
    const token = createToken(driver.id, 'driver', { username: driver.username, name: driver.name || `${driver.fname} ${driver.lname}`, sessionEpoch: driver.sessionEpoch || 0 });
    logAction('DRIVER_GOOGLE_LOGIN_SUCCESS', driver.username, 'DRIVER_PORTAL', { name: driver.name });
    return res.json({ success: true, token, driver: { id: driver.id, username: driver.username, name: driver.name, token }, expiresInMs: SESSION_TTL_MS });
  } catch (err) {
    console.error('[auth] Google verification failed:', err.message);
    return res.status(401).json({ success: false, message: err.message || 'Google verification failed.' });
  }
});

app.post('/api/auth/driver/signup', async (req, res) => {
  const fname = cleanString(req.body && req.body.fname, 60);
  const lname = cleanString(req.body && req.body.lname, 60);
  const phone = cleanString(req.body && req.body.phone, 30);
  const email = cleanString(req.body && req.body.email, 120);
  const password = String((req.body && req.body.password) || '');
  const vehicle = cleanString(req.body && req.body.vehicle, 120);
  const photo = req.body && req.body.photo ? String(req.body.photo).slice(0, 9 * 1024 * 1024) : null;
  const googleCredential = cleanString(req.body && req.body.googleCredential, 12000);
  let googleProfile = null;
  if (googleCredential) {
    try {
      googleProfile = await verifyGoogleCredential(googleCredential);
      if (String(googleProfile.email || '').toLowerCase() !== email.toLowerCase()) {
        return res.status(403).json({ success: false, message: 'The verified Google email does not match the signup email.' });
      }
    } catch (err) {
      return res.status(401).json({ success: false, message: err.message || 'Google verification failed.' });
    }
  }

  if (!fname || !lname || !phone || !email || (!googleProfile && !password)) {
    return res.status(400).json({ success: false, message: "First name, last name, phone, email, and password are required." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: "Enter a valid email address for account recovery." });
  }
  if (!googleProfile && password.length < 6) {
    return res.status(400).json({ success: false, message: "Choose a password with at least 6 characters." });
  }
  if (!vehicle) {
    return res.status(400).json({ success: false, message: "Vehicle type is required." });
  }
  if (!photo) {
    return res.status(400).json({ success: false, message: "A live face photo is required so customers can identify their driver." });
  }

  const db = loadDatabase();
  if (db.drivers.some(d => String(d.phone || '').replace(/\s+/g, '') === phone.replace(/\s+/g, ''))) {
    return res.status(400).json({ success: false, message: "A driver with this phone number is already registered." });
  }

  const username = generateDriverUsername(fname, lname, db.drivers);
  const driverId = "drv-" + Date.now();
  // Keep the image out of the database when object storage is available; only
  // the URL is stored and served to customers.
  const photoUrl = await media.uploadDataUrl(photo, { kind: 'drivers', id: driverId });
  const newDriver = {
    id: driverId,
    username,
    password: googleProfile ? null : hashPassword(password),
    googleSub: googleProfile ? googleProfile.sub : null,
    fname,
    lname,
    name: `${fname} ${lname}`.trim(),
    phone,
    email: email || '',
    vehicle,
    photo: photoUrl || photo,
    photoUrl: photoUrl || null,
    isActive: false,
    approvalStatus: 'pending',
    approvedAt: null,
    approvedBy: null,
    approvalNotified: false,
    lat: 5.56246,
    lng: -0.21289,
    speedKmh: 0,
    createdAt: new Date().toISOString()
  };

  const previousAuditLogs = Array.isArray(db.auditLogs) ? db.auditLogs.slice() : db.auditLogs;
  db.drivers.push(newDriver);
  db.auditLogs = db.auditLogs || [];
  db.auditLogs.unshift({
    id: "log-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    timestamp: new Date().toISOString(),
    action: "DRIVER_SIGNUP",
    actor: username,
    entity: "DRIVER_PORTAL",
    details: JSON.stringify({ name: newDriver.name, phone, vehicle }),
    ipOrAgent: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || "LOCAL").toString()
  });
  if (db.auditLogs.length > 500) db.auditLogs.pop();

  const persistenceError = await requireDurableSave(db);
  if (persistenceError) {
    db.drivers = db.drivers.filter(driver => driver.id !== newDriver.id);
    if (previousAuditLogs === undefined) delete db.auditLogs;
    else db.auditLogs = previousAuditLogs;
    return res.status(503).json({ success: false, message: persistenceError });
  }

  res.status(201).json({
    success: true,
    pending: true,
    message: `Registration successful! Your application is under review. You will be notified once the admin approves your account.`,
    driverId: newDriver.id,
    driverName: newDriver.name,
    username: newDriver.username
  });
});

// DRIVER LOGIN — username or phone, bcrypt verified.
app.post('/api/auth/driver/login', (req, res) => {
  const username = cleanString(req.body && req.body.username, 80);
  const password = String((req.body && req.body.password) || '');
  if (!username || !password) {
    return res.status(400).json({ success: false, message: "Username and password are required." });
  }

  const limit = rateCheck(req, 'driver', username);
  if (limit.blocked) {
    res.set('Retry-After', String(limit.retryAfter || 900));
    return res.status(429).json({ success: false, message: `Too many attempts. Try again in ${Math.ceil((limit.retryAfter || 900) / 60)} minute(s).` });
  }

  const db = loadDatabase();
  const cleanUser = username.toLowerCase();
  const compact = username.replace(/\s+/g, '');
  const digitsOnly = username.replace(/\D/g, '');
  const driver = db.drivers.find(d =>
    String(d.username || '').toLowerCase() === cleanUser ||
    String(d.email || '').toLowerCase() === cleanUser ||
    String(d.phone || '').replace(/\s+/g, '') === compact ||
    (digitsOnly.length >= 7 && String(d.phone || '').replace(/\D/g, '').endsWith(digitsOnly.slice(-7)))
  );

  if (!driver || !verifyPassword(password, driver.password)) {
    const record = rateFail(req, 'driver', username);
    logAction("DRIVER_LOGIN_FAILED", username, "DRIVER_PORTAL", { reason: "Incorrect credentials", attempts: record.count }, req);
    return res.status(401).json({ success: false, message: "Invalid driver username or password." });
  }

  // Block pending and rejected drivers
  if (driver.approvalStatus === 'pending' || (!driver.approvalStatus && !driver.approvedAt && !driver.isActive)) {
    return res.status(403).json({
      success: false,
      pending: true,
      driverId: driver.id,
      driverName: driver.name,
      message: "Your account is pending admin approval. You will be notified once approved."
    });
  }
  if (driver.approvalStatus === 'rejected') {
    return res.status(403).json({
      success: false,
      rejected: true,
      reason: driver.rejectionReason || 'Your registration was not approved.',
      message: driver.rejectionReason || "Your registration was not approved. Please contact YEBS Noodles for assistance."
    });
  }

  if (!isBcryptHash(driver.password) || bcrypt.getRounds(driver.password) < BCRYPT_ROUNDS) {
    driver.password = hashPassword(password);
    driver.passwordUpdatedAt = new Date().toISOString();
    saveDatabase(db);
  }

  rateSuccess(req, 'driver', username);
  logAction("DRIVER_LOGIN_SUCCESS", driver.username, "DRIVER_PORTAL", { name: driver.name }, req);

  const token = createToken(driver.id, 'driver', { username: driver.username, name: driver.name || `${driver.fname} ${driver.lname}`, sessionEpoch: driver.sessionEpoch || 0 });
  res.json({
    success: true,
    message: `Welcome back, ${driver.fname}!`,
    token,
    expiresInMs: SESSION_TTL_MS,
    driver: { ...publicDriver(driver), token }
  });
});

// ==========================================================
// PASSWORD RECOVERY (admin + driver)
// ==========================================================
// A 6-digit code is valid for 10 minutes, is stored only as a bcrypt hash, and
// is delivered over WhatsApp when the Cloud API is configured. The response
// never reveals whether an account exists.

const RECOVERY_TTL_MS = 10 * 60 * 1000;
const RECOVERY_MAX_ATTEMPTS = 5;

function recoveryRole(raw) {
  const role = String(raw || '').toLowerCase();
  return role === 'admin' || role === 'driver' ? role : null;
}

function isLocalRequest(req) {
  const clean = (value) => String(value || '').split(',')[0].trim().replace(/^::ffff:/, '');
  const socketIp = clean(req.socket && req.socket.remoteAddress);
  const forwarded = clean(req.headers['x-forwarded-for']);
  const local = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '';
  return local(socketIp) && local(forwarded);
}

function maskEmail(email) {
  const str = String(email || '').trim();
  if (!str.includes('@')) return '';
  const [local, domain] = str.split('@');
  if (local.length <= 3) return local[0] + '•••@' + domain;
  return local.slice(0, 3) + '•••@' + domain;
}

function recoveryEmailFor(db, role, account) {
  if (role === 'admin') {
    return String(account.email || (db.settings && db.settings.adminEmail) || process.env.ADMIN_EMAIL || 'yebsnoodles@gmail.com');
  }
  return String(account.email || '');
}

async function sendRecoveryEmail(toEmail, code, role, name) {
  const targetEmail = String(toEmail || '').trim();
  if (!targetEmail || !targetEmail.includes('@')) {
    return { ok: false, reason: 'no-email-on-file' };
  }
  const subject = `Your YEBS Noodles Password Recovery Code: ${code}`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;">
      <div style="text-align:center;margin-bottom:20px;">
        <h2 style="color:#173d30;margin:0 0 6px;">YEBS Noodles</h2>
        <div style="font-size:0.85rem;color:#718096;text-transform:uppercase;letter-spacing:1px;font-weight:700;">Password Recovery</div>
      </div>
      <p style="color:#2d3748;font-size:1rem;line-height:1.5;">Hello <strong>${name || role}</strong>,</p>
      <p style="color:#4a5568;font-size:0.95rem;line-height:1.5;">You requested a password reset for your ${role} account. Here is your 6-digit recovery code:</p>
      <div style="background:#f7fafc;border:2px dashed #cbd5e0;border-radius:10px;padding:16px;text-align:center;margin:24px 0;">
        <span style="font-size:2.2rem;letter-spacing:6px;font-weight:800;color:#e57a45;font-family:monospace;">${code}</span>
      </div>
      <p style="color:#718096;font-size:0.85rem;line-height:1.4;">This code is valid for <strong>10 minutes</strong>. If you did not request this, you can safely ignore this message.</p>
      <hr style="border:none;border-top:1px solid #edf2f7;margin:20px 0;">
      <p style="color:#a0aec0;font-size:0.75rem;text-align:center;margin:0;">YEBS Noodles &bull; Adabraka, Accra &bull; Automatic Security</p>
    </div>`;
  const sendGridKey = process.env.SENDGRID_API_KEY || '';
  const fromValue = process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_FROM || process.env.SMTP_USER || '';
  const fromMatch = fromValue.match(/<([^<>]+)>/);
  const fromEmail = (fromMatch ? fromMatch[1] : fromValue).trim();
  const fromName = process.env.SENDGRID_FROM_NAME || (fromMatch ? fromValue.slice(0, fromMatch.index).replace(/["']/g, '').trim() : 'YEBS Noodles');
  let sendGridError = '';

  if (sendGridKey && fromEmail.includes('@')) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + sendGridKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: targetEmail }] }],
          from: { email: fromEmail, name: fromName || 'YEBS Noodles' },
          subject,
          content: [{ type: 'text/html', value: html }]
        }),
        signal: controller.signal
      }).finally(() => clearTimeout(timer));
      if (response.status !== 202) {
        const detail = await response.text().catch(() => '');
        throw new Error(detail.slice(0, 250) || `SendGrid API ${response.status}`);
      }
      return { ok: true, provider: 'sendgrid' };
    } catch (err) {
      sendGridError = `sendgrid: ${err.message}`;
      console.warn('[recovery-email-error] SendGrid delivery failed:', err.message);
    }
  }

  const smtpUser = process.env.SMTP_USER || '';
  const smtpPass = process.env.SMTP_PASSWORD || '';
  if (smtpUser && smtpPass) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: smtpUser, pass: smtpPass }
      });
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || `YEBS Noodles <${smtpUser}>`,
        to: targetEmail,
        subject,
        html
      });
      return { ok: true, provider: 'smtp' };
    } catch (err) {
      console.error(`[recovery-email-error] Failed to send email to ${targetEmail}:`, err.message);
      return { ok: false, reason: [sendGridError, `smtp: ${err.message}`].filter(Boolean).join('; ') };
    }
  }

  const reason = sendGridError || (sendGridKey ? 'sendgrid-from-email-not-configured' : 'email-provider-not-configured');
  console.warn(`[recovery] No email provider accepted delivery for ${role} (${targetEmail}): ${reason}.`);
  return { ok: false, reason };
}

async function sendRecoverySms(toPhone, text) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  const authToken = process.env.TWILIO_AUTH_TOKEN || '';
  const from = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER || '';
  if (!accountSid || !authToken || !from) return { ok: false, reason: 'sms-not-configured' };

  const digits = String(toPhone || '').replace(/\D/g, '');
  const to = digits.startsWith('233') ? `+${digits}` : (digits.startsWith('0') ? `+233${digits.slice(1)}` : `+${digits}`);
  try {
    const body = new URLSearchParams({ To: to, From: from, Body: String(text).slice(0, 1500) });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      signal: controller.signal
    }).finally(() => clearTimeout(timer));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `Twilio API ${response.status}`);
    return { ok: true, providerId: payload.sid || null };
  } catch (err) {
    console.warn('[recovery-sms-error] Failed to send recovery SMS:', err.message);
    return { ok: false, reason: err.message };
  }
}

async function sendRecoveryPhone(phone, text) {
  const sms = await sendRecoverySms(phone, text);
  if (sms.ok) return sms;
  const whatsapp = await sendWhatsAppText(phone, text);
  return whatsapp.ok ? whatsapp : { ok: false, reason: [sms.reason, whatsapp.reason].filter(Boolean).join('; ') };
}

function findRecoveryAccount(db, role, identifier) {
  const needle = String(identifier || '').trim();
  if (!needle) return null;
  const lower = needle.toLowerCase();
  const compact = needle.replace(/\s+/g, '');
  const digitsOnly = needle.replace(/\D/g, '');

  if (role === 'admin') {
    let found = (db.admins || []).find(a =>
      String(a.username || '').toLowerCase() === lower ||
      String(a.email || '').toLowerCase() === lower ||
      (digitsOnly.length >= 7 && String(a.phone || a.recoveryPhone || '').replace(/\D/g, '').endsWith(digitsOnly.slice(-7)))
    );
    if (!found && (lower === 'goodfood' || lower === 'yebsnoodles@gmail.com' || digitsOnly.endsWith('559103452'))) {
      found = (db.admins && db.admins[0]) || null;
    }
    return found;
  }

  return (db.drivers || []).find(d =>
    String(d.username || '').toLowerCase() === lower ||
    String(d.email || '').toLowerCase() === lower ||
    String(d.phone || '').replace(/\s+/g, '') === compact ||
    (digitsOnly.length >= 7 && String(d.phone || '').replace(/\D/g, '').endsWith(digitsOnly.slice(-7)))
  ) || null;
}

function recoveryPhoneFor(db, role, account) {
  if (role === 'driver') return String(account.phone || '');
  return String(
    account.phone ||
    account.recoveryPhone ||
    (db.settings && db.settings.recoveryPhone) ||
    process.env.ADMIN_RECOVERY_PHONE ||
    (db.settings && db.settings.momo && db.settings.momo.payTo) ||
    '0559103452'
  );
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 5) return '';
  return digits.slice(0, 3) + '•••' + digits.slice(-2);
}

app.post('/api/auth/recovery/start', async (req, res) => {
  const role = recoveryRole(req.body && req.body.role);
  const identifier = cleanString(req.body && req.body.identifier, 120);
  if (!role) {
    return res.status(400).json({ success: false, message: "Choose whether you are recovering an admin or a rider account." });
  }
  if (!identifier) {
    return res.status(400).json({ success: false, message: "Enter your username, email, or phone number." });
  }

  const limit = rateCheck(req, 'recovery', identifier);
  if (limit.blocked) {
    res.set('Retry-After', String(limit.retryAfter || 900));
    return res.status(429).json({ success: false, message: `Too many recovery attempts. Try again in ${Math.ceil((limit.retryAfter || 900) / 60)} minute(s).` });
  }

  const db = loadDatabase();
  db.recoveryCodes = Array.isArray(db.recoveryCodes) ? db.recoveryCodes : [];
  const account = findRecoveryAccount(db, role, identifier);

  const generic = {
    success: true,
    message: "If that account exists, a recovery code will be sent to its email or phone on file.",
    expiresInMinutes: Math.round(RECOVERY_TTL_MS / 60000)
  };

  if (!account) {
    rateFail(req, 'recovery', identifier);
    return res.json({ ...generic, delivered: false, canSelfRecover: false });
  }

  // Retire any code that is still unused for this account.
  db.recoveryCodes.forEach(entry => {
    if (entry.accountId === account.id && !entry.usedAt) entry.usedAt = new Date().toISOString();
  });

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + RECOVERY_TTL_MS);
  db.recoveryCodes.push({
    id: 'rcv-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    role,
    accountId: account.id,
    codeHash: hashPassword(code),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    attempts: 0,
    usedAt: null
  });
  if (db.recoveryCodes.length > 100) db.recoveryCodes = db.recoveryCodes.slice(-100);

  const email = recoveryEmailFor(db, role, account);
  const phone = recoveryPhoneFor(db, role, account);

  const [emailResult, smsResult] = await Promise.all([
    email ? sendRecoveryEmail(email, code, role, account.name || account.username) : Promise.resolve({ ok: false, reason: 'no-email-on-file' }),
    phone ? sendRecoveryPhone(phone,
      `YEBS recovery code: ${code}\n\nUse it within 10 minutes to set a new password for "${account.username || account.name || identifier}".\nIf you did not ask for this, ignore this message.`) : Promise.resolve({ ok: false, reason: 'no-phone-on-file' })
  ]);

  const delivered = emailResult.ok === true || smsResult.ok === true;

  const echoSetting = String(process.env.RECOVERY_SHOW_CODE || '').toLowerCase();
  const showCode = echoSetting !== '0' && isLocalRequest(req);
  const ownerLogFallback = role === 'admin' && !delivered;
  if (ownerLogFallback) {
    console.warn('[recovery] Admin password recovery code (restricted service logs only):', JSON.stringify({
      username: account.username || account.name,
      code,
      expiresAt: expiresAt.toISOString()
    }));
  }

  console.log(`[recovery] Request for ${role} "${account.username || account.name}". Email: ${emailResult.ok ? 'Delivered' : emailResult.reason}, Phone: ${smsResult.ok ? 'Delivered' : smsResult.reason}.`);

  saveDatabase(db);
  logAction('PASSWORD_RECOVERY_REQUESTED', account.username || account.name || identifier,
    role === 'admin' ? 'ADMIN_PORTAL' : 'DRIVER_PORTAL',
    { delivered, emailDelivered: emailResult.ok, smsDelivered: smsResult.ok, email: maskEmail(email), phone: maskPhone(phone) }, req);

  res.json({
    ...generic,
    delivered,
    canSelfRecover: Boolean(email || phone),
    emailDelivered: emailResult.ok,
    emailReason: emailResult.reason || null,
    emailHint: maskEmail(email),
    smsDelivered: smsResult.ok,
    smsReason: smsResult.reason || null,
    phoneHint: maskPhone(phone),
    ownerLogFallback,
    ...(showCode ? { code } : {})
  });
});

app.post('/api/auth/recovery/verify', (req, res) => {
  const body = req.body || {};
  const role = recoveryRole(body.role);
  const identifier = cleanString(body.identifier, 120);
  const code = String(body.code || '').replace(/\D/g, '');
  const password = String(body.password || '');

  if (!role || !identifier) {
    return res.status(400).json({ success: false, message: "Enter your username and the code you received." });
  }
  if (code.length !== 6) {
    return res.status(400).json({ success: false, message: "Enter the 6-digit recovery code." });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, message: "Choose a new password with at least 8 characters." });
  }

  const db = loadDatabase();
  const account = findRecoveryAccount(db, role, identifier);
  const invalid = { success: false, message: "That code is invalid or has expired. Request a new one." };
  if (!account) return res.status(400).json(invalid);

  db.recoveryCodes = Array.isArray(db.recoveryCodes) ? db.recoveryCodes : [];
  const record = db.recoveryCodes
    .filter(entry => entry.accountId === account.id && !entry.usedAt)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  if (!record) return res.status(400).json(invalid);

  if (new Date(record.expiresAt).getTime() < Date.now()) {
    record.usedAt = new Date().toISOString();
    saveDatabase(db);
    return res.status(400).json({ success: false, message: "That code has expired. Request a new one." });
  }

  record.attempts = Number(record.attempts || 0) + 1;
  if (record.attempts > RECOVERY_MAX_ATTEMPTS) {
    record.usedAt = new Date().toISOString();
    saveDatabase(db);
    return res.status(429).json({ success: false, message: "Too many wrong codes. Request a fresh code and try again." });
  }

  if (!verifyPassword(code, record.codeHash)) {
    saveDatabase(db);
    return res.status(400).json(invalid);
  }

  record.usedAt = new Date().toISOString();
  account.password = hashPassword(password);
  account.passwordUpdatedAt = new Date().toISOString();
  account.sessionEpoch = (account.sessionEpoch || 0) + 1;
  saveDatabase(db);

  rateSuccess(req, 'recovery', identifier);
  logAction('PASSWORD_RECOVERED', account.username || account.name || identifier,
    role === 'admin' ? 'ADMIN_PORTAL' : 'DRIVER_PORTAL', { via: 'recovery-code' }, req);

  res.json({
    success: true,
    message: "Password updated. Sign in with your new password.",
    username: account.username || account.phone || identifier
  });
});

// Who am I? Lets a portal validate a remembered token after a restart.
app.get('/api/auth/session', (req, res) => {
  const auth = authenticate(req);
  if (!auth) return res.status(401).json({ success: false, message: "Session expired." });
  res.json({
    success: true,
    role: auth.payload.role,
    expiresAt: auth.payload.exp,
    admin: auth.admin ? { id: auth.admin.id, username: auth.admin.username, name: auth.admin.name, role: auth.admin.role } : undefined,
    driver: auth.driver ? publicDriver(auth.driver) : undefined
  });
});

// ==========================================================
// 2. DRIVER LOCATION & PUBLIC PROFILE API
// ==========================================================

app.post('/api/drivers/:id/location', async (req, res) => {
  const { id } = req.params;
  const auth = authenticate(req);
  if (!auth) return res.status(401).json({ success: false, message: "Driver sign-in required." });

  const db = loadDatabase();
  const driver = db.drivers.find(d => d.id === id || d.username === id || (d.phone || '').replace(/\s+/g, '') === String(id).replace(/\s+/g, ''));
  if (!driver) return res.status(404).json({ success: false, message: "Driver not found" });

  if (auth.payload.role === 'driver' && auth.payload.sub !== driver.id) {
    return res.status(403).json({ success: false, message: "You can only update your own live location." });
  }

  const { lat, lng, speedKmh, statusText, name, phone, vehicle, photo, isActive } = req.body || {};
  if (lat !== undefined && lat !== null) driver.lat = Number(lat);
  if (lng !== undefined && lng !== null) driver.lng = Number(lng);
  if (speedKmh !== undefined) driver.speedKmh = Number(speedKmh) || 0;
  if (statusText) driver.statusText = cleanString(statusText, 120);
  if (name) driver.name = cleanString(name, 80);
  if (phone) driver.phone = cleanString(phone, 30);
  if (vehicle) driver.vehicle = cleanString(vehicle, 120);
  if (photo) {
    const inline = String(photo).slice(0, 9 * 1024 * 1024);
    const uploaded = await media.uploadDataUrl(inline, { kind: 'drivers', id: driver.id });
    driver.photo = uploaded || inline;
    driver.photoUrl = uploaded || null;
  }
  if (isActive !== undefined) driver.isActive = !!isActive;
  driver.lastLocationUpdate = new Date().toISOString();

  // Mirror the live GPS position onto every active order handled by this
  // driver so customers on other devices receive it with the order sync.
  db.orders.forEach(o => {
    const sameDriver = (o.driverId && o.driverId === driver.id)
      || (o.driver && o.driver.id && o.driver.id === driver.id)
      || (o.driver && (o.driver.name || '').toLowerCase() === (driver.name || `${driver.fname || ''} ${driver.lname || ''}`).trim().toLowerCase())
      || (o.driver && (o.driver.phone || '').replace(/\s+/g, '') === (driver.phone || '').replace(/\s+/g, ''));
    if (sameDriver && o.status !== 'delivered' && o.status !== 'cancelled') {
      if (!o.driver) o.driver = {};
      const previousLocation = o.driver.currentLocation;
      o.driver.id = driver.id;
      o.driver.name = driver.name || `${driver.fname || ''} ${driver.lname || ''}`.trim() || driver.username;
      o.driver.currentLocation = { lat: driver.lat, lng: driver.lng };
      o.driver.speedKmh = driver.speedKmh;
      o.driver.lastUpdated = driver.lastLocationUpdate;
      if (o.status === 'driver_assigned' && previousLocation
        && Number.isFinite(Number(previousLocation.lat)) && Number.isFinite(Number(previousLocation.lng))
        && calculateDistanceKm(Number(previousLocation.lat), Number(previousLocation.lng), driver.lat, driver.lng) >= 0.02) {
        o.status = 'enroute';
        o.enrouteAt = new Date().toISOString();
      }
      // The face photo is deliberately NOT copied onto the order: a 13 KB
      // base64 image per order was the single biggest driver of the old
      // 53 MB state row. The order references the rider and the UI loads the
      // photo from /api/drivers/:id/photo (cached by the browser).
      if (o.driver.photo) delete o.driver.photo;
      if (driver.phone) o.driver.phone = driver.phone;
      if (driver.vehicle) o.driver.vehicle = driver.vehicle;
      if (typeof pushOrderUpdate === 'function') {
        pushOrderUpdate(o.id, {
          type: 'location',
          driver: {
            lat: driver.lat,
            lng: driver.lng,
            speedKmh: driver.speedKmh,
            statusText: driver.statusText,
            photo: driver.photoUrl || (driver.id ? `/api/drivers/${encodeURIComponent(driver.id)}/photo` : null),
            name: driver.name,
            phone: driver.phone,
            vehicle: driver.vehicle
          },
          order: projectOrder(o, 'customer')
        });
      }
    }
  });

  saveDatabase(db);
  res.json({ success: true, driver: publicDriver(driver) });
});

// Admin roster includes pending applicants; public clients only see approved drivers.
app.get('/api/admin/drivers', requireRole('admin'), async (req, res) => {
  await store.refresh(true);
  if (store.remoteMode !== 'local' && !store.canPersist()) {
    return res.status(503).json({ success: false, message: `Could not sync the driver roster: ${store.status()}` });
  }
  const db = loadDatabase();
  res.set('Cache-Control', 'no-store');
  const drivers = db.drivers.map(driver => ({
    ...publicDriver(driver),
    email: driver.email || ''
  }));
  if (String(req.query.format || '').toLowerCase() === 'envelope') {
    return res.json({ success: true, drivers });
  }
  res.json(drivers);
});

// Public: Approved active drivers only (safe public fields only).
app.get('/api/drivers', (req, res) => {
  const db = loadDatabase();
  const approvedActiveDrivers = db.drivers.filter(driver =>
    driver.isActive !== false &&
    (driver.approvalStatus === 'approved' || Boolean(driver.approvedAt) ||
      (!driver.approvalStatus && driver.isActive === true))
  );
  res.json(approvedActiveDrivers.map(publicDriver));
});

// Public: Get active driver details for customers
app.get('/api/drivers/active', (req, res) => {
  const db = loadDatabase();
  res.json(db.drivers.filter(d => d.isActive).map(publicDriver));
});

// Public: a rider's face photo, served separately so it is never duplicated
// into every order. Cached by the browser for a day.
app.get('/api/drivers/:id/photo', (req, res) => {
  const db = loadDatabase();
  const driver = (db.drivers || []).find(d => String(d.id) === String(req.params.id));
  const photo = driver && (driver.photoUrl || driver.photo);
  if (!photo) return res.status(404).end();
  if (!/^data:/i.test(photo)) {
    // Already in object storage.
    return res.redirect(302, photo);
  }
  const match = String(photo).match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return res.status(404).end();
  const buffer = Buffer.from(match[2], 'base64');
  res.set('Content-Type', match[1]);
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  res.send(buffer);
});

// ==========================================================
// 3. PAYMENTS — instant, transparent, conflict-free
// ==========================================================

function addPaymentAudit(order, action, actor, details) {
  order.paymentAudit = order.paymentAudit || [];
  order.paymentAudit.unshift({
    at: new Date().toISOString(),
    action,
    actor: actor || 'SYSTEM',
    details: details || null
  });
  if (order.paymentAudit.length > 40) order.paymentAudit.pop();
}

function validTxnRef(value) {
  const ref = cleanString(value, 60).replace(/\s+/g, '');
  return /^[A-Za-z0-9._-]{5,50}$/.test(ref) ? ref : '';
}

function validReceiptImage(value) {
  if (typeof value !== 'string' || value.length > 11_200_000) return '';
  const match = value.match(/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return '';
  const image = Buffer.from(match[1], 'base64');
  if (image.length === 0 || image.length > 8 * 1024 * 1024 || image.toString('base64') !== match[1]) return '';
  return value;
}

function findDuplicateTxn(db, txn, orderId) {
  const needle = txn.toLowerCase();
  return db.orders.find(o =>
    String(o.id) !== String(orderId) &&
    String(o.momoTransactionRef || '').toLowerCase() === needle
  );
}

function hashReceipt(image) {
  if (!image || typeof image !== 'string') return '';
  return crypto.createHash('sha256').update(image).digest('hex').slice(0, 24);
}

function findDuplicateReceipt(db, hash, orderId) {
  if (!hash) return null;
  return db.orders.find(o => String(o.id) !== String(orderId) && o.momoReceipt && o.momoReceipt.hash === hash);
}

// ==========================================================
// MOBILE MONEY NETWORKS + COLLECTIONS API
// ----------------------------------------------------------
// Every Ghanaian wallet settles into the same YEBS merchant number.
// MTN additionally publishes a Collections API; when the owner adds the
// real credentials the server pushes a payment
// prompt straight to the customer's phone. Without credentials we fall
// back to the USSD flow on the exact same wallet rail, then the customer
// confirms with the transaction ID / receipt.
// ==========================================================

function getMomoSettings(db) {
  const stored = (db && db.settings && db.settings.momo) || {};
  const payTo = walletPhone(stored.payTo) || walletPhone(process.env.MOMO_PAY_TO) || DEFAULT_MOMO_SETTINGS.payTo;
  const accountName = String(stored.accountName || process.env.MOMO_MERCHANT_NAME || DEFAULT_MOMO_SETTINGS.accountName).trim();
  return {
    payTo,
    payToLabel: payTo.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3'),
    accountName
  };
}

const MOMO_NETWORKS = {
  mtn: {
    id: 'mtn',
    label: 'MTN Mobile Money',
    shortLabel: 'MTN MoMo',
    ussd: '*170#',
    dial: '*170',
    prefixes: ['024', '054', '055', '059', '025'],
    supportsApi: true,
    color: '#facc15',
    textColor: '#713f12'
  },
  telecel: {
    id: 'telecel',
    label: 'Telecel Cash (formerly Vodafone Cash)',
    shortLabel: 'Telecel Cash',
    ussd: '*110#',
    dial: '*110',
    prefixes: ['020', '050'],
    supportsApi: false,
    color: '#ef4444',
    textColor: '#ffffff'
  },
  at: {
    id: 'at',
    label: 'AT Money (AirtelTigo)',
    shortLabel: 'AT Money',
    ussd: '*110#',
    dial: '*110',
    prefixes: ['026', '027', '056', '057'],
    supportsApi: false,
    color: '#0ea5e9',
    textColor: '#ffffff'
  }
};

function listMomoNetworks() {
  const api = momoApiConfig();
  return Object.values(MOMO_NETWORKS).map(n => ({
    id: n.id,
    label: n.label,
    shortLabel: n.shortLabel,
    ussd: n.ussd,
    dial: n.dial,
    color: n.color,
    textColor: n.textColor,
    apiReady: !!(n.supportsApi && api.configured)
  }));
}

function normalizeNetwork(value) {
  const v = String(value || '').toLowerCase().trim();
  if (!v) return '';
  if (/mtn|^0?55|momo/.test(v) && !/telecel|vodafone|airtel|tigo/.test(v)) return 'mtn';
  if (/telecel|vodafone|voda/.test(v)) return 'telecel';
  if (/airtel|tigo|\bat\b|atmoney|at-money/.test(v)) return 'at';
  if (/cash|delivery|on arrival/.test(v)) return 'cash';
  return '';
}

// Best-effort network guess from a Ghanaian wallet number.
function networkFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '').replace(/^233/, '0');
  const prefix = digits.slice(0, 3);
  for (const net of Object.values(MOMO_NETWORKS)) {
    if (net.prefixes.includes(prefix)) return net.id;
  }
  return '';
}

function walletPhone(value) {
  const digits = String(value || '').replace(/\D/g, '').replace(/^233/, '0');
  return /^0\d{9}$/.test(digits) ? digits : '';
}

function momoApiConfig() {
  const cfg = {
    subscriptionKey: process.env.MTN_MOMO_SUBSCRIPTION_KEY || process.env.MOMO_SUBSCRIPTION_KEY || '',
    apiUser: process.env.MTN_MOMO_API_USER || process.env.MOMO_API_USER || '',
    apiKey: process.env.MTN_MOMO_API_KEY || process.env.MOMO_API_KEY || '',
    targetEnvironment: process.env.MTN_MOMO_TARGET_ENV || process.env.MOMO_TARGET_ENV || 'mtnghana',
    callbackHost: process.env.MTN_MOMO_CALLBACK_HOST || process.env.MOMO_CALLBACK_HOST || ''
  };
  cfg.configured = !!(cfg.subscriptionKey && cfg.apiUser && cfg.apiKey);
  return cfg;
}

async function momoFetch(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    let body = null;
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch (e) { body = text.slice(0, 400); }
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// Exchange API user/key for an OAuth token (MTN Collections v1_0).
async function momoAccessToken(cfg) {
  const basic = Buffer.from(`${cfg.apiUser}:${cfg.apiKey}`).toString('base64');
  const res = await momoFetch(`${cfg.baseUrl || 'https://proxy.momoapi.mtn.com'}/collection/token/`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Ocp-Apim-Subscription-Key': cfg.subscriptionKey
    }
  });
  if (!res.ok || !res.body || !res.body.access_token) {
    throw new Error(`MTN token request failed (${res.status})`);
  }
  return res.body.access_token;
}

// Push a real MoMo payment prompt to the customer's phone.
// Returns { ok, configured, status, referenceId, message }.
async function requestMomoCollection({ amount, phone, referenceId, payerMessage, payeeNote }) {
  const cfg = momoApiConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      configured: false,
      status: 'ussd',
      message: 'Card-free MoMo request is not enabled on this deployment. Use the USSD code below and confirm with your transaction ID.'
    };
  }

  try {
    const token = await momoAccessToken(cfg);
    const base = cfg.baseUrl || 'https://proxy.momoapi.mtn.com';
    const res = await momoFetch(`${base}/collection/v1_0/requesttopay`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Reference-Id': referenceId,
        'X-Target-Environment': cfg.targetEnvironment,
        'Ocp-Apim-Subscription-Key': cfg.subscriptionKey,
        'Content-Type': 'application/json',
        ...(cfg.callbackHost ? { 'X-Callback-Url': `https://${cfg.callbackHost}/api/payments/momo/callback` } : {})
      },
      body: JSON.stringify({
        amount: String(Number(amount).toFixed(2)),
        currency: 'GHS',
        externalId: String(referenceId),
        payer: { partyIdType: 'MSISDN', partyId: String(phone).replace(/^0/, '233') },
        payerMessage: String(payerMessage || 'YEBS Noodles order').slice(0, 60),
        payeeNote: String(payeeNote || 'YEBS Noodles').slice(0, 60)
      })
    }, 20000);

    if (res.status === 202) {
      return {
        ok: true,
        configured: true,
        status: 'pending',
        referenceId,
        message: 'Payment request sent. Approve the prompt on your phone by entering your MoMo PIN.'
      };
    }
    return {
      ok: false,
      configured: true,
      status: 'failed',
      referenceId,
      message: (res.body && (res.body.message || res.body.error)) || `MTN rejected the request (${res.status}). Use the USSD code instead.`
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      status: 'error',
      referenceId,
      message: `Could not reach MTN MoMo (${err.message}). Use the USSD code instead.`
    };
  }
}

// Ask MTN whether a request-to-pay has settled.
async function fetchMomoRequestStatus(referenceId) {
  const cfg = momoApiConfig();
  if (!cfg.configured) return { configured: false, status: 'unknown' };
  try {
    const token = await momoAccessToken(cfg);
    const base = cfg.baseUrl || 'https://proxy.momoapi.mtn.com';
    const res = await momoFetch(`${base}/collection/v1_0/requesttopay/${encodeURIComponent(referenceId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Target-Environment': cfg.targetEnvironment,
        'Ocp-Apim-Subscription-Key': cfg.subscriptionKey
      }
    });
    if (!res.ok || !res.body) return { configured: true, status: 'unknown' };
    return {
      configured: true,
      status: String(res.body.status || 'unknown').toLowerCase(),
      reason: res.body.reason || null,
      amount: res.body.amount || null
    };
  } catch (err) {
    return { configured: true, status: 'unknown', error: err.message };
  }
}

// Pull a lat/lng out of a Google/Apple Maps link or a raw "5.55, -0.21" string.
function extractCoordinates(text) {
  const value = String(text || '');
  if (!value) return null;
  const patterns = [
    /@(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/,
    /[?&](?:q|query|ll|destination|daddr)=(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/,
    /!3d(-?\d{1,2}\.\d{3,})!4d(-?\d{1,3}\.\d{3,})/,
    /(?:^|\s)(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})(?:$|\s)/
  ];
  for (const re of patterns) {
    const m = value.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { lat, lng };
      }
    }
  }
  return null;
}

// Core MoMo verification used by customer proof, admin SMS matching and receipts.
function applyMomoPayment(db, order, opts) {
  const { transactionRef, amount, sender, receiptImage, method, actor, note, providerVerified } = opts;

  if (order.status === 'cancelled') {
    return { ok: false, status: 409, order, message: "This order is cancelled and cannot accept a payment." };
  }

  if (order.paymentStatus === 'paid') {
    return {
      ok: true,
      alreadyPaid: true,
      order,
      message: `This order is already paid (${order.verificationMethod === 'cash-driver' ? 'cash collected by rider' : 'MoMo verified'}). No further payment is needed.`
    };
  }

  const total = Number(order.total) || 0;
  const paidAmount = amount === null || amount === undefined ? total : Number(amount);
  if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
    return { ok: false, status: 400, order, message: "Enter the amount you paid." };
  }

  const txn = validTxnRef(transactionRef);
  // When the screenshot has already been uploaded to object storage the hash is
  // supplied separately, so duplicate-receipt detection still compares the
  // image bytes rather than two different URLs.
  const receiptHash = opts.receiptHash || hashReceipt(receiptImage);

  // Keep the submitted evidence available to an administrator even when it
  // conflicts with another order and must be rejected for automatic payment.
  order.momoTransactionRef = txn || order.momoTransactionRef || (receiptHash ? `RECEIPT-${receiptHash.slice(0, 8).toUpperCase()}` : null);
  order.momoAmount = paidAmount;
  order.momoSender = sender ? cleanString(sender, 40) : (order.momoSender || null);
  order.momoReceipt = {
    image: receiptImage || (order.momoReceipt && order.momoReceipt.image) || null,
    transactionRef: order.momoTransactionRef,
    uploadedAt: new Date().toISOString(),
    verified: false,
    hash: receiptHash || (order.momoReceipt && order.momoReceipt.hash) || null
  };

  // A screenshot already used on another order is evidence of reuse/fraud.
  const dupReceipt = findDuplicateReceipt(db, receiptHash, order.id);
  if (dupReceipt) {
    order.paymentStatus = 'review';
    addPaymentAudit(order, 'MOMO_RECEIPT_DUPLICATE', actor, { matchedOrder: dupReceipt.id });
    return {
      ok: false,
      status: 409,
      order,
      conflict: true,
      message: `This exact receipt was already used for order ${dupReceipt.id}. Submit your own payment proof or pay cash on delivery.`
    };
  }

  if (txn) {
    const dup = findDuplicateTxn(db, txn, order.id);
    if (dup) {
      order.paymentStatus = 'review';
      addPaymentAudit(order, 'MOMO_TXN_DUPLICATE', actor, { matchedOrder: dup.id, transactionRef: txn });
      return {
        ok: false,
        status: 409,
        order,
        conflict: true,
        message: `Transaction ${txn} was already used for order ${dup.id}. Each payment can only verify one order.`
      };
    }
  }

  if (Math.abs(paidAmount - total) > 0.009) {
    order.paymentStatus = 'review';
    addPaymentAudit(order, 'MOMO_AMOUNT_MISMATCH', actor, { expected: total, received: paidAmount, note: note || null });
    return {
      ok: false,
      status: 202,
      order,
      needsReview: true,
      message: `Proof submitted for GH₵${paidAmount.toFixed(2)}, but this order total is GH₵${total.toFixed(2)}. An administrator must review it before payment is confirmed.`
    };
  }

  if (!txn && !receiptImage) {
    return { ok: false, status: 400, order, message: "Enter the MoMo transaction ID or upload the payment receipt." };
  }

  if (providerVerified !== true) {
    order.paymentStatus = 'review';
    order.paymentVerified = false;
    order.paidAt = null;
    order.momoReceipt.verified = false;
    addPaymentAudit(order, 'MOMO_PROOF_SUBMITTED', actor, {
      transactionRef: order.momoTransactionRef,
      amount: paidAmount,
      note: note || 'Awaiting administrator verification'
    });
    return {
      ok: false,
      status: 202,
      order,
      needsReview: true,
      message: 'Payment proof submitted successfully. An administrator will verify the transaction; your order will be marked paid only after confirmation.'
    };
  }

  order.paymentStatus = 'paid';
  order.paymentVerified = true;
  order.paidAt = new Date().toISOString();
  order.verificationMethod = method || (receiptImage && !txn ? 'auto-receipt' : 'auto-momo');
  order.momoReceipt.verified = true;
  addPaymentAudit(order, 'MOMO_PAYMENT_VERIFIED', actor, {
    transactionRef: order.momoTransactionRef,
    amount: paidAmount,
    method: order.verificationMethod
  });

  return {
    ok: true,
    order,
    message: `Payment confirmed ✅ GH₵${paidAmount.toFixed(2)} received for order ${order.id}. You are all set — no need to wait.`
  };
}

// Customer submits proof for verification; the server never trusts a client-side paid flag.
app.post('/api/orders/:id/pay/momo', (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });
  if (!hasOrderAccess(order, req)) return res.status(403).json({ success: false, message: "Order access token required." });

  const body = req.body || {};
  const transactionRef = validTxnRef(body.transactionRef);
  const receiptImage = validReceiptImage(body.receiptImage);
  if (!transactionRef) {
    return res.status(400).json({ success: false, message: "Enter a valid MoMo transaction ID." });
  }
  if (!receiptImage) {
    return res.status(400).json({ success: false, message: "Upload a valid JPEG, PNG, or WebP payment receipt screenshot." });
  }
  const amount = toAmount(body.amount);
  const result = applyMomoPayment(db, order, {
    transactionRef,
    amount: amount === null ? Number(order.total) : amount,
    sender: body.senderPhone || body.sender,
    receiptImage,
    method: body.method,
    actor: order.customer || 'CUSTOMER',
    note: body.note
  });

  saveDatabase(db);
  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'payment', order: projectOrder(order, 'customer') });
  }
  logAction(result.ok ? (result.alreadyPaid ? 'MOMO_ALREADY_PAID' : 'MOMO_AUTO_VERIFIED') : 'MOMO_PAYMENT_REVIEW',
    order.customer, order.id, {
    amount: order.momoAmount,
    transactionRef: order.momoTransactionRef,
    status: order.paymentStatus,
    conflict: !!result.conflict
  }, req);

  res.status(result.ok ? 200 : (result.status || 400)).json({
    success: result.ok,
    alreadyPaid: !!result.alreadyPaid,
    needsReview: !!result.needsReview,
    conflict: !!result.conflict,
    message: result.message,
    order: projectOrder(order, 'public')
  });
});

// Public: which MoMo networks/USSD codes this deployment supports.
app.get('/api/payments/networks', (req, res) => {
  const wallet = getMomoSettings(loadDatabase());
  res.json({
    success: true,
    payTo: wallet.payTo,
    payToLabel: wallet.payToLabel,
    merchant: wallet.accountName,
    accountName: wallet.accountName,
    apiConfigured: momoApiConfig().configured,
    networks: listMomoNetworks()
  });
});

// Customer chooses "Pay now" + a network: push a real MoMo prompt when the
// Collections API is configured, otherwise return the exact USSD steps.
app.post('/api/orders/:id/pay/request', async (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found." });
  if (!hasOrderAccess(order, req)) return res.status(403).json({ success: false, message: "Order access token required." });
  if (order.status === 'cancelled') return res.status(409).json({ success: false, message: "This order is cancelled and cannot accept a payment request." });

  if (order.paymentStatus === 'paid') {
    return res.status(200).json({
      success: true,
      alreadyPaid: true,
      message: "This order is already paid.",
      order: projectOrder(order, 'public')
    });
  }

  const body = req.body || {};
  const network = normalizeNetwork(body.network || body.paymentNetwork || order.paymentNetwork || order.payment);
  if (!network || network === 'cash') {
    return res.status(400).json({ success: false, message: "Choose MTN MoMo, Telecel Cash or AT Money first." });
  }
  const net = MOMO_NETWORKS[network];
  if (!net) return res.status(400).json({ success: false, message: "Unknown mobile money network." });

  const phone = walletPhone(body.phone || body.senderPhone || order.momoPayerPhone);
  if (!phone) {
    return res.status(400).json({ success: false, message: "Enter the mobile money number that will pay (e.g. 024 123 4567)." });
  }

  const amount = Number(order.total) || 0;
  const referenceId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  order.paymentNetwork = network;
  order.payment = net.label;
  order.paymentMode = 'momo';
  order.momoPayerPhone = phone;

  const result = network === 'mtn'
    ? await requestMomoCollection({
      amount,
      phone,
      referenceId,
      payerMessage: `YEBS order ${order.id}`,
      payeeNote: `YEBS Noodles ${order.id}`
    })
    : {
      ok: false,
      configured: false,
      status: 'ussd',
      message: 'Pay from your wallet with the USSD code below, then confirm with the transaction ID.'
    };

  if (result.configured && result.ok) {
    order.momoRequestId = referenceId;
    order.momoRequestStatus = 'pending';
    order.momoRequestAt = new Date().toISOString();
    // A pushed prompt that is never approved must not block the order forever:
    // the status endpoint marks it expired after 10 minutes and invites a retry.
    order.momoRequestExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  } else {
    order.momoRequestId = null;
    order.momoRequestStatus = result.configured ? (result.status || 'failed') : 'ussd';
    order.momoRequestExpiresAt = null;
  }

  addPaymentAudit(order, result.ok ? 'MOMO_REQUEST_SENT' : 'MOMO_USSD_INSTRUCTIONS', order.customer, {
    network,
    phone,
    amount,
    mode: result.configured ? 'api' : 'ussd',
    status: order.momoRequestStatus
  });
  saveDatabase(db);
  logAction(result.ok ? 'MOMO_REQUEST_SENT' : 'MOMO_USSD_INSTRUCTIONS', order.customer, order.id, {
    network, amount, mode: result.configured ? 'api' : 'ussd'
  }, req);

  res.json({
    success: true,
    requested: result.ok,
    configured: result.configured,
    mode: result.configured ? 'api' : 'ussd',
    status: order.momoRequestStatus,
    reference: result.configured ? referenceId : order.id,
    network,
    networkLabel: net.label,
    ussd: net.ussd,
    dial: net.dial,
    payTo: getMomoSettings(db).payTo,
    payToLabel: getMomoSettings(db).payToLabel,
    merchant: getMomoSettings(db).accountName,
    amount,
    phone,
    message: result.message,
    order: projectOrder(order, 'public')
  });
});

// Poll a pushed MoMo request; auto-marks the order paid when MTN settles it.
app.get('/api/orders/:id/pay/status', async (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found." });
  if (!hasOrderAccess(order, req)) return res.status(403).json({ success: false, message: "Order access token required." });

  let networkStatus = order.momoRequestStatus || null;

  // A prompt left unanswered for 10 minutes expires instead of hanging forever.
  if (order.paymentStatus !== 'paid'
    && networkStatus === 'pending'
    && order.momoRequestExpiresAt
    && Date.now() > Date.parse(order.momoRequestExpiresAt)) {
    order.momoRequestStatus = 'expired';
    networkStatus = 'expired';
    addPaymentAudit(order, 'MOMO_REQUEST_EXPIRED', 'SYSTEM', {
      referenceId: order.momoRequestId,
      requestedAt: order.momoRequestAt,
      expiresAt: order.momoRequestExpiresAt
    });
    saveDatabase(db);
  }

  if (order.paymentStatus !== 'paid' && order.momoRequestId && networkStatus !== 'expired') {
    const state = await fetchMomoRequestStatus(order.momoRequestId);
    if (state.configured && state.status && state.status !== 'unknown') {
      networkStatus = state.status;
      order.momoRequestStatus = state.status;
      if (state.status === 'successful' && Math.abs(Number(state.amount) - Number(order.total)) <= 0.009) {
        applyMomoPayment(db, order, {
          transactionRef: order.momoRequestId,
          amount: Number(order.total),
          sender: order.momoPayerPhone,
          method: 'mtn-api',
          providerVerified: true,
          actor: 'MTN MOMO API',
          note: 'Settled by MTN Collections API'
        });
        logAction('MOMO_API_SETTLED', 'MTN MOMO API', order.id, { amount: order.total }, req);
      } else if (state.status === 'successful') {
        order.paymentStatus = 'review';
        order.paymentVerified = false;
        addPaymentAudit(order, 'MOMO_PROVIDER_AMOUNT_MISMATCH', 'MTN MOMO API', {
          expected: Number(order.total), received: Number(state.amount) || null
        });
      }
      saveDatabase(db);
    }
  }

  res.json({
    success: true,
    paid: order.paymentStatus === 'paid',
    paymentStatus: order.paymentStatus,
    requestStatus: networkStatus,
    message: order.paymentStatus === 'paid'
      ? 'Payment confirmed by the mobile money network.'
      : (networkStatus === 'expired'
        ? 'That payment prompt expired. Request a new prompt or pay with the USSD code below.'
        : (networkStatus === 'failed' ? 'The mobile money network declined this request. Try again or use the USSD code.' : 'Waiting for the customer to approve the payment prompt.')),
    order: projectOrder(order, 'public')
  });
});

// MTN MoMo Collections calls this URL when a request-to-pay settles (the URL is
// already advertised by requestMomoCollection via X-Callback-Url). The body is
// never trusted on its own: the settlement is re-checked against the MTN API.
app.post('/api/payments/momo/callback', async (req, res) => {
  const cfg = momoApiConfig();
  if (!cfg.configured) {
    return res.status(503).json({ success: false, message: 'Mobile money API is not configured.' });
  }
  const body = req.body || {};
  const referenceId = String(
    body.referenceId || body.reference_id || body.externalId || body.external_id ||
    (body.data && (body.data.referenceId || body.data.externalId)) || ''
  ).trim();
  if (!referenceId) return res.status(400).json({ success: false, message: 'referenceId is required.' });

  const db = loadDatabase();
  const order = (db.orders || []).find(o => String(o.momoRequestId || '') === referenceId);
  if (!order) return res.status(404).json({ success: false, message: 'Unknown payment reference.' });
  if (order.paymentStatus === 'paid') return res.json({ success: true, alreadyPaid: true, orderId: order.id });

  const state = await fetchMomoRequestStatus(referenceId);
  if (!state.configured || state.status !== 'successful') {
    return res.json({ success: true, applied: false, status: state.status || 'pending', orderId: order.id });
  }
  const received = Number(state.amount);
  if (!(Math.abs(received - Number(order.total)) <= 0.009)) {
    order.paymentStatus = 'review';
    order.paymentVerified = false;
    addPaymentAudit(order, 'MOMO_PROVIDER_AMOUNT_MISMATCH', 'MTN MOMO CALLBACK', {
      expected: Number(order.total), received: Number.isFinite(received) ? received : null
    });
    await requireDurableSave(db);
    return res.json({ success: true, applied: false, status: 'review', orderId: order.id });
  }

  applyMomoPayment(db, order, {
    transactionRef: referenceId,
    amount: Number(order.total),
    sender: order.momoPayerPhone,
    method: 'mtn-api',
    providerVerified: true,
    actor: 'MTN MOMO CALLBACK',
    note: 'Settled via MTN Collections callback'
  });
  order.momoRequestStatus = 'successful';
  await requireDurableSave(db);
  logAction('MOMO_CALLBACK_SETTLED', 'MTN MOMO CALLBACK', order.id, { amount: order.total, referenceId }, req);
  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'payment', order: projectOrder(order, 'customer') });
  }
  res.json({ success: true, applied: true, paid: true, orderId: order.id });
});

// Rider collects cash on delivery — auto-validated against the order total.
app.post('/api/orders/:id/pay/cash', requireRole('driver', 'admin'), (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });
  if (order.status === 'cancelled') return res.status(409).json({ success: false, message: "This order is cancelled and cannot accept a payment." });
  if (req.auth.payload.role === 'driver' && order.driverId !== req.auth.driver.id && !(order.driver && order.driver.id === req.auth.driver.id)) {
    return res.status(403).json({ success: false, message: "You can only record cash for a delivery assigned to you." });
  }
  if (req.auth.payload.role === 'driver' && order.paymentMode !== 'cash' && !/cash|pay on delivery/i.test(order.payment || '')) {
    return res.status(409).json({ success: false, message: "This order is set for Mobile Money, not cash collection." });
  }

  if (order.paymentStatus === 'paid') {
    return res.status(409).json({
      success: false,
      conflict: true,
      message: `${order.id} is already paid (${order.verificationMethod === 'cash-driver' ? 'cash already collected' : 'MoMo verified'}). Do not collect cash again.`,
      order: projectOrder(order, req.auth.payload.role)
    });
  }

  const total = Number(order.total) || 0;
  const received = toAmount((req.body || {}).amount);
  if (received === null || received <= 0) {
    return res.status(400).json({ success: false, message: "Enter the cash amount received from the customer." });
  }

  const actorName = req.auth.payload.role === 'driver'
    ? (req.auth.driver.name || req.auth.driver.username)
    : (req.auth.admin.name || req.auth.admin.username);

  order.momoAmount = received;
  order.momoTransactionRef = `CASH-${Date.now().toString(36).toUpperCase()}`;
  order.paymentMode = 'cash';
  order.payment = 'Pay on Delivery (Cash)';
  order.verificationMethod = 'cash-driver';
  order.cashCollectedBy = actorName;
  order.cashCollectedAt = new Date().toISOString();

  if (Math.abs(received - total) > 0.009) {
    order.paymentStatus = 'review';
    addPaymentAudit(order, received < total ? 'CASH_SHORT' : 'CASH_OVERPAYMENT', actorName, { expected: total, received });
    saveDatabase(db);
    logAction(received < total ? 'CASH_PAYMENT_SHORT' : 'CASH_PAYMENT_OVERPAYMENT', actorName, order.id, { expected: total, received }, req);
    return res.status(202).json({
      success: false,
      needsReview: true,
      message: `Cash received GH₵${received.toFixed(2)} does not match the GH₵${total.toFixed(2)} total. The payment is flagged for admin review.`,
      order: projectOrder(order, req.auth.payload.role)
    });
  }

  order.paymentStatus = 'paid';
  order.paymentVerified = true;
  order.paidAt = new Date().toISOString();
  addPaymentAudit(order, 'CASH_COLLECTED', actorName, { received, expected: total });

  saveDatabase(db);
  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'payment', order: projectOrder(order, 'customer') });
  }
  logAction('CASH_PAYMENT_COLLECTED', actorName, order.id, { received, expected: total }, req);

  res.json({
    success: true,
    message: `Cash payment of GH₵${received.toFixed(2)} verified and recorded. ${order.id} is fully paid.`,
    order: projectOrder(order, req.auth.payload.role)
  });
});

// Admin override / review outcome.
app.post('/api/orders/:id/pay/review', requireRole('admin'), async (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });
  if (order.status === 'cancelled') return res.status(409).json({ success: false, message: "A cancelled order cannot be marked paid." });

  const previousOrder = JSON.parse(JSON.stringify(order));
  const paid = (req.body || {}).paid !== false;
  const reason = cleanString((req.body || {}).reason, 240);
  const actor = req.auth.admin.name || req.auth.admin.username;

  if (paid) {
    order.paymentStatus = 'paid';
    order.paymentVerified = true;
    order.paidAt = order.paidAt || new Date().toISOString();
    order.verificationMethod = order.verificationMethod || 'admin-manual';
    if (order.momoReceipt) order.momoReceipt.verified = true;
    addPaymentAudit(order, 'PAYMENT_APPROVED_BY_ADMIN', actor, { reason });
  } else {
    order.paymentStatus = 'review';
    order.paymentVerified = false;
    order.paidAt = null;
    if (order.momoReceipt) order.momoReceipt.verified = false;
    addPaymentAudit(order, 'PAYMENT_REJECTED_BY_ADMIN', actor, { reason });
  }

  const persistenceError = await requireDurableSave(db);
  if (persistenceError) {
    Object.keys(order).forEach(key => delete order[key]);
    Object.assign(order, previousOrder);
    return res.status(503).json({ success: false, persisted: false, message: persistenceError });
  }

  logAction(paid ? 'PAYMENT_APPROVED_BY_ADMIN' : 'PAYMENT_REJECTED_BY_ADMIN', actor, order.id, { reason }, req);
  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'payment-review', order: projectOrder(order, 'customer') });
  }
  res.json({ success: true, persisted: true, message: paid ? 'Payment approved.' : 'Payment rejected and flagged for review.', order: projectOrder(order, 'admin') });
});

// Match a forwarded MoMo SMS to an unpaid order; bridged messages remain for admin review.
function parseMomoSms(raw) {
  const text = cleanString(raw, 700);
  const amountMatch = text.match(/(?:GH\s*[₵C]?|GHS|GHC|GH₵)\s*([\d,]+(?:\.\d{1,2})?)/i)
    || text.match(/(?:amount|received|paid)[^\d]{0,24}([\d,]+(?:\.\d{1,2})?)/i);
  const txnMatch = text.match(/(?:transaction\s*(?:id|no|number|ref(?:erence)?)|txn\s*(?:id|no)?|reference|ref)\s*[:\-]?\s*([A-Za-z0-9._-]{5,50})/i);
  const orderMatch = text.match(/\b(YB[\s-]?[A-Z0-9]{4,12})\b/i);
  return {
    amount: amountMatch ? Number(String(amountMatch[1]).replace(/,/g, '')) : null,
    transactionRef: txnMatch ? validTxnRef(txnMatch[1]) : '',
    orderId: orderMatch ? normalizeOrderId(orderMatch[1]) : '',
    raw: text
  };
}

function momoSmsIngestKey(deviceId, messageId) {
  return crypto.createHash('sha256')
    .update(`${deviceId}\0${messageId}`)
    .digest('hex');
}

function isAllowedMomoSmsSender(sender) {
  const allowedSenders = String(process.env.MOMO_SMS_ALLOWED_SENDERS || '')
    .split(',')
    .map(value => cleanString(value, 80).toLowerCase().replace(/[\s-]/g, ''))
    .filter(Boolean);
  const normalizedSender = cleanString(sender, 80).toLowerCase().replace(/[\s-]/g, '');
  return allowedSenders.length > 0 && !!normalizedSender && allowedSenders.includes(normalizedSender);
}

function hasValidMomoSmsIngestToken(req) {
  const expected = String(process.env.MOMO_SMS_INGEST_TOKEN || '');
  const supplied = bearerFrom(req);
  if (expected.length < 32 || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length
    && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

async function processMomoSms(req, res, actor, ingestionKey = null, providerVerified = false) {
  const body = req.body || {};
  const rawSms = typeof body.sms === 'string' ? body.sms : '';
  if (!rawSms || rawSms.length > 1000) {
    return res.status(400).json({ success: false, message: "Provide the full MoMo transaction message (maximum 1000 characters)." });
  }
  const parsed = parseMomoSms(rawSms);
  if (!parsed.amount) {
    return res.status(400).json({ success: false, message: "Could not read an amount from that message. Paste the full MoMo confirmation SMS." });
  }
  if (!parsed.transactionRef) {
    return res.status(400).json({ success: false, message: "The message must contain the MoMo transaction ID before it can verify a payment." });
  }

  const db = loadDatabase();
  if (ingestionKey) {
    db.momoSmsIngestedMessages = Array.isArray(db.momoSmsIngestedMessages) ? db.momoSmsIngestedMessages : [];
    const previous = db.momoSmsIngestedMessages.find(entry => entry.key === ingestionKey);
    if (previous) {
      const previousOrder = db.orders.find(order => order.id === previous.orderId);
      return res.status(200).json({
        success: previous.success,
        duplicate: true,
        terminal: true,
        needsReview: previous.needsReview,
        conflict: previous.conflict,
        message: previous.message,
        order: previousOrder ? projectOrder(previousOrder, 'admin') : null
      });
    }
  }

  let order = parsed.orderId ? db.orders.find(o => String(o.id).toUpperCase() === parsed.orderId) : null;

  if (!order) {
    order = db.orders.find(o => String(o.momoTransactionRef || '').toLowerCase() === parsed.transactionRef.toLowerCase());
  }

  if (!order) {
    // Only auto-match by amount when exactly one unpaid order matches it.
    const candidates = db.orders.filter(o =>
      o.paymentStatus !== 'paid' &&
      Math.abs(Number(o.total) - parsed.amount) < 0.009
    );
    if (candidates.length === 1) order = candidates[0];
    else if (candidates.length > 1) {
      return res.status(409).json({
        success: false,
        ambiguous: true,
        message: `Amount GH₵${parsed.amount.toFixed(2)} matches ${candidates.length} unpaid orders (${candidates.map(o => o.id).join(', ')}). Include the order ID or reference in the SMS.`,
        ...(ingestionKey ? { retryable: true } : { parsed })
      });
    }
  }

  if (!order) {
    return res.status(404).json({
      success: false,
      ...(ingestionKey ? { retryable: true } : {}),
      message: "No unpaid order matches this message. Check the amount, or include the order ID / transaction reference.",
      ...(ingestionKey ? {} : { parsed })
    });
  }

  const result = applyMomoPayment(db, order, {
    transactionRef: parsed.transactionRef,
    amount: parsed.amount,
    sender: body.sender,
    receiptImage: null,
    method: 'auto-sms',
    providerVerified,
    actor,
    note: 'Verified from forwarded MoMo SMS'
  });

  if (ingestionKey && (result.ok || result.needsReview || result.conflict)) {
    db.momoSmsIngestedMessages.push({
      key: ingestionKey,
      orderId: order.id,
      success: result.ok,
      needsReview: !!result.needsReview,
      conflict: !!result.conflict,
      message: result.message,
      receivedAt: new Date().toISOString()
    });
    if (db.momoSmsIngestedMessages.length > 1000) {
      db.momoSmsIngestedMessages.splice(0, db.momoSmsIngestedMessages.length - 1000);
    }
  }

  if (ingestionKey) {
    const persistenceError = await requireDurableSave(db);
    if (persistenceError) {
      return res.status(503).json({ success: false, retryable: true, message: persistenceError });
    }
  } else {
    saveDatabase(db);
  }
  logAction(result.ok ? 'MOMO_SMS_AUTO_VERIFIED' : 'MOMO_SMS_REVIEW', actor, order.id, {
    amount: parsed.amount,
    transactionRef: parsed.transactionRef,
    status: order.paymentStatus
  }, req);
  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'payment', order: projectOrder(order, 'customer') });
  }

  const terminalConflict = !!(ingestionKey && result.conflict);
  res.status(terminalConflict ? 200 : (result.ok ? 200 : (result.status || 400))).json({
    success: result.ok,
    needsReview: !!result.needsReview,
    conflict: !!result.conflict,
    ...(ingestionKey ? { terminal: !!(result.ok || result.needsReview || result.conflict) } : {}),
    message: result.message,
    ...(ingestionKey ? {} : { parsed }),
    order: projectOrder(order, 'admin')
  });
}

app.post('/api/payments/momo/sms', requireRole('admin'), (req, res) => {
  const admin = req.auth.admin;
  return processMomoSms(req, res, admin.name || admin.username, null, true);
});

app.post('/api/payments/momo/sms/ingest', async (req, res) => {
  if (!process.env.MOMO_SMS_INGEST_TOKEN || String(process.env.MOMO_SMS_INGEST_TOKEN).length < 32) {
    return res.status(503).json({ success: false, message: "The MoMo SMS bridge is not configured on this server." });
  }
  if (!hasValidMomoSmsIngestToken(req)) {
    return res.status(401).json({ success: false, message: "Invalid MoMo SMS bridge credentials." });
  }

  const body = req.body || {};
  if (!isAllowedMomoSmsSender(body.sender)) {
    return res.status(403).json({ success: false, message: "This SMS sender is not on the configured MoMo sender allowlist." });
  }
  const deviceId = cleanString(body.deviceId, 100);
  const messageId = cleanString(body.messageId, 200);
  if (!deviceId || !messageId) {
    return res.status(400).json({ success: false, message: "A stable device ID and SMS message ID are required for safe retries." });
  }

  const sender = cleanString(body.sender, 80);
  req.body = { ...body, sender };
  await processMomoSms(req, res, `MOMO_SMS_BRIDGE:${sender}`, momoSmsIngestKey(deviceId, messageId), true);
});

// Legacy receipt upload kept for compatibility; proof remains unverified until reviewed.
app.post('/api/orders/:id/receipt', async (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });
  if (!hasOrderAccess(order, req)) return res.status(403).json({ success: false, message: "Order access token required." });
  if (order.status === 'cancelled') return res.status(409).json({ success: false, message: "This order is cancelled and cannot accept payment proof." });

  const body = req.body || {};
  const transactionRef = validTxnRef(body.transactionRef);
  const receiptImage = validReceiptImage(body.receiptImage);
  if (!transactionRef) {
    return res.status(400).json({ success: false, message: "Enter a valid MoMo transaction ID." });
  }
  if (!receiptImage) {
    return res.status(400).json({ success: false, message: "Upload a valid JPEG, PNG, or WebP payment receipt screenshot." });
  }
  // Hash the original bytes for duplicate detection, then move the screenshot
  // out of the order row and store only its URL when Storage is available.
  const receiptHash = hashReceipt(receiptImage);
  const receiptUrl = await media.uploadDataUrl(receiptImage, { kind: 'receipts', id: order.id });
  const result = applyMomoPayment(db, order, {
    transactionRef,
    amount: toAmount(body.amount) === null ? Number(order.total) : toAmount(body.amount),
    sender: body.senderPhone,
    receiptImage: receiptUrl || receiptImage,
    receiptHash,
    method: 'auto-receipt',
    actor: order.customer || 'CUSTOMER'
  });
  if (order.momoReceipt && receiptUrl) order.momoReceipt.imageUrl = receiptUrl;

  saveDatabase(db);
  res.status(result.ok ? 200 : (result.status || 400)).json({
    success: result.ok,
    needsReview: !!result.needsReview,
    conflict: !!result.conflict,
    message: result.message,
    order: projectOrder(order, 'public')
  });
});

app.post('/api/orders/:id/receipt/verify', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });
  if (order.status === 'cancelled') return res.status(409).json({ success: false, message: "A cancelled order cannot be marked paid." });

  const verified = req.body.verified !== false;
  order.paymentStatus = verified ? 'paid' : 'review';
  order.paymentVerified = verified;
  if (verified) order.paidAt = order.paidAt || new Date().toISOString();
  if (order.momoReceipt) order.momoReceipt.verified = verified;
  addPaymentAudit(order, verified ? 'RECEIPT_APPROVED' : 'RECEIPT_REJECTED', req.auth.admin.username, null);
  saveDatabase(db);
  logAction("MOMO_RECEIPT_VERIFIED", req.auth.admin.username, order.id, { verified }, req);
  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'payment-review', order: projectOrder(order, 'customer') });
  }
  res.json({ success: true, order: projectOrder(order, 'admin') });
});

// ==========================================================
// 4. ORDERS CRUD & DATABASE PERSISTENCE
// ==========================================================

// Lightweight order shape for dashboards/lists. Keeps the heavy per-order
// detail (audit trail, receipt, map pin) out of list polling.
function projectOrderSummary(order, viewer = 'public') {
  const staff = viewer === 'admin' || viewer === 'driver';
  return {
    id: order.id,
    createdAt: order.createdAt,
    customer: order.customer,
    phone: staff ? order.phone : undefined,
    status: order.status,
    total: order.total,
    payment: order.payment,
    paymentMode: order.paymentMode || paymentModeFor(order.payment),
    paymentStatus: order.paymentStatus || (order.paymentVerified ? 'paid' : 'unpaid'),
    fulfilment: order.fulfilment,
    location: order.location,
    mapPin: order.mapPin || null,
    driverId: order.driverId || (order.driver && order.driver.id) || null,
    driverName: order.driverName || (order.driver && order.driver.name) || null,
    pickupPin: staff ? (order.pickupPin || null) : undefined,
    notificationStatus: order.notificationStatus || null,
    items: (order.items || []).map(item => ({
      menuId: item.menuId || null,
      name: item.name,
      quantity: item.quantity,
      price: item.price
    })),
    itemCount: (order.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 1), 0)
  };
}

// Paginated, filtered order list. The default returns everything still in play
// plus the last day of history, so a shop with 10,000 archived orders does not
// download 10,000 rows on every dashboard poll. Pass ?scope=all for history.
app.get('/api/orders', (req, res) => {
  const auth = authenticate(req);
  if (!auth || !['admin', 'driver'].includes(auth.payload.role)) {
    return res.status(401).json({ success: false, message: "Sign in to view the order list." });
  }
  const db = loadDatabase();
  const viewer = auth.payload.role;
  const scope = cleanString(req.query.scope || '', 20).toLowerCase();
  const status = cleanString(req.query.status || '', 30).toLowerCase();
  const search = cleanString(req.query.q || '', 80).toLowerCase();
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(req.query.limit) || 300)));
  const cursor = cleanString(req.query.cursor || '', 40);
  const summary = String(req.query.summary || '') === '1' || String(req.query.summary || '') === 'true';
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

  let rows = db.orders.filter(order => {
    if (scope === 'all') return true;
    if (scope === 'active') return isActiveOrder(order);
    if (scope === 'today') return new Date(order.createdAt || 0).getTime() >= dayAgo;
    return isActiveOrder(order) || new Date(order.createdAt || 0).getTime() >= dayAgo;
  });
  if (status && status !== 'all') {
    rows = rows.filter(order => String(order.status || '').toLowerCase() === status);
  }
  if (search) {
    rows = rows.filter(order => [
      order.id, order.customer, order.phone, order.location,
      order.driverName, order.driver && order.driver.name
    ].filter(Boolean).join(' ').toLowerCase().includes(search));
  }
  if (cursor) {
    const at = Date.parse(cursor);
    if (Number.isFinite(at)) rows = rows.filter(order => new Date(order.createdAt || 0).getTime() < at);
  }
  rows.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  const page = rows.slice(0, limit);
  res.set('X-Total-Count', String(rows.length));
  res.set('X-Page-Limit', String(limit));
  res.set('X-Has-More', rows.length > page.length ? '1' : '0');
  if (rows.length > page.length && page.length) {
    res.set('X-Next-Cursor', new Date(page[page.length - 1].createdAt || Date.now()).toISOString());
  }
  res.json(page.map(order => summary ? projectOrderSummary(order, viewer) : projectOrder(order, viewer)));
});

// Aggregate counters for the dashboard KPIs. These are computed over the whole
// history on the server, so the browser no longer has to download every order
// just to show "total orders" and "revenue".
app.get('/api/orders/stats', (req, res) => {
  const auth = authenticate(req);
  if (!auth || !['admin', 'driver'].includes(auth.payload.role)) {
    return res.status(401).json({ success: false, message: "Sign in to view order statistics." });
  }
  const db = loadDatabase();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  const stats = {
    totalOrders: 0,
    ongoingOrders: 0,
    deliveredOrders: 0,
    cancelledOrders: 0,
    totalRevenue: 0,
    netRevenue: 0,
    paidRevenue: 0,
    todayOrders: 0,
    todayRevenue: 0,
    byStatus: {},
    lastOrderAt: null,
    generatedAt: new Date().toISOString()
  };

  for (const order of (db.orders || [])) {
    const status = String(order.status || 'pending').toLowerCase();
    const total = Number(order.total) || 0;
    stats.totalOrders += 1;
    stats.totalRevenue += total;
    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    if (status === 'delivered') stats.deliveredOrders += 1;
    else if (status === 'cancelled') stats.cancelledOrders += 1;
    else stats.ongoingOrders += 1;
    if (status !== 'cancelled') stats.netRevenue += total;
    if (order.paymentVerified === true || String(order.paymentStatus || '') === 'paid') stats.paidRevenue += total;
    const createdAt = new Date(order.createdAt || 0).getTime();
    if (createdAt >= todayMs) {
      stats.todayOrders += 1;
      if (status !== 'cancelled') stats.todayRevenue += total;
    }
    if (Number.isFinite(createdAt) && (!stats.lastOrderAt || createdAt > Date.parse(stats.lastOrderAt))) {
      stats.lastOrderAt = new Date(createdAt).toISOString();
    }
  }

  stats.totalRevenue = Math.round(stats.totalRevenue * 100) / 100;
  stats.netRevenue = Math.round(stats.netRevenue * 100) / 100;
  stats.paidRevenue = Math.round(stats.paidRevenue * 100) / 100;
  stats.todayRevenue = Math.round(stats.todayRevenue * 100) / 100;

  res.json({ success: true, ...stats });
});

// Driver handover lookup: accepts YB-1234, 1234 or a phone number.
app.get('/api/orders/lookup/:code', requireRole('driver', 'admin'), (req, res) => {
  const db = loadDatabase();
  const raw = cleanString(req.params.code, 30);
  const normalized = normalizeOrderId(raw);
  const compactPhone = raw.replace(/\s+/g, '');

  const matches = db.orders.filter(o =>
    String(o.id).toUpperCase() === normalized ||
    String(o.pickupPin) === raw.replace(/[^0-9]/g, '') ||
    (compactPhone.length >= 9 && String(o.phone || '').replace(/\s+/g, '').endsWith(compactPhone.slice(-9)))
  );

  if (!matches.length) {
    return res.status(404).json({ success: false, message: `No order found for "${raw}". Ask the customer for their Order ID or separate 4-digit pickup PIN.` });
  }
  if (matches.length > 1) {
    return res.status(409).json({
      success: false,
      multiple: true,
      message: `${matches.length} orders match that phone number. Use the exact Order ID instead.`,
      orders: matches.map(o => projectOrder(o, req.auth.payload.role))
    });
  }

  res.json({ success: true, order: projectOrder(matches[0], req.auth.payload.role) });
});

app.get('/api/orders/:id', (req, res) => {
  const db = loadDatabase();
  const id = normalizeOrderId(req.params.id);
  const order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });
  if (!hasOrderAccess(order, req)) return res.status(403).json({ success: false, message: "Order access token required." });
  const viewer = viewerFromReq(req);
  const view = projectOrder(order, viewer);
  // The customer who holds this order's access token is the one person who
  // must be able to read the handover PIN — otherwise they cannot tell the
  // rider the code when the food arrives.
  if (viewer !== 'admin' && view.pickupPin === undefined) view.pickupPin = order.pickupPin || null;
  res.json(view);
});

// ========================================
// FEATURE API ROUTES - Customers, Drivers, Analytics
// ========================================

// Import feature route handlers
// Legacy demo routers (customers, drivers, analytics, reviews, loyalty, receipts,
// chat, inventory, referrals, notifications, pricing) were removed on purpose.
// They returned hard-coded demo numbers that shadowed the real database endpoints
// defined in this file. No page in this build calls those demo routes.

// ========================================
// ORDER SUBMISSION & MANAGEMENT
// ========================================

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateOrderDelivery(isDelivery, items, orderPin, sharedPickup) {
  if (!isDelivery) {
    return { fee: 0, distanceKm: 0, discount: 0, baseFee: 0, mealCount: 0 };
  }
  const mealCount = (items || []).reduce((sum, i) => sum + (Number(i.quantity) || 1), 0);
  const originLat = (sharedPickup && Number(sharedPickup.lat)) || 5.5612;
  const originLng = (sharedPickup && Number(sharedPickup.lng)) || -0.2155;
  const destLat = (orderPin && Number(orderPin.lat)) || originLat;
  const destLng = (orderPin && Number(orderPin.lng)) || originLng;
  const rawDist = calculateDistanceKm(originLat, originLng, destLat, destLng);
  const distanceKm = Math.max(0.5, Math.round(rawDist * 10) / 10);
  const ratePerKm = mealCount >= 4 ? 2 : mealCount === 3 ? 4 : mealCount === 2 ? 6 : 8;
  const baseFee = Math.round(distanceKm * ratePerKm * 100) / 100;
  const discount = 0;
  const fee = baseFee;
  return { fee, distanceKm, discount, baseFee, mealCount };
}

function normalizeOrderItems(db, submittedItems) {
  if (!Array.isArray(submittedItems) || submittedItems.length === 0 || submittedItems.length > 30) {
    return { error: "Add between 1 and 30 meals to the order." };
  }

  const items = [];
  for (const item of submittedItems) {
    if (!item || typeof item !== 'object') {
      return { error: "One or more selected meals are invalid. Refresh the menu and try again." };
    }
    const menuItem = (db.menuItems || []).find(m => String(m.id) === String(item.menuId));
    const status = String(menuItem && menuItem.status || '').toLowerCase();
    const price = menuItem ? toAmount(menuItem.price) : null;
    if (!menuItem || menuItem.available === false || ['sold_out', 'coming_soon'].includes(status) || price === null) {
      return { error: "One or more selected meals are unavailable. Refresh the menu and try again." };
    }
    const quantity = Number(item.quantity);
    const qty = Math.max(1, Math.min(50, Math.floor(Number.isFinite(quantity) && quantity > 0 ? quantity : 1)));
    items.push({
      name: cleanString(menuItem.name, 100),
      noodle: cleanString(item.noodle, 60),
      menuId: menuItem.id,
      price,
      quantity: qty,
      image: cleanString(menuItem.image || item.image, 120)
    });
  }
  return { items };
}

app.post('/api/orders', async (req, res) => {
  const body = req.body || {};
  const db = loadDatabase();

  const customer = cleanString(body.customer, 100);
  const phone = cleanString(body.phone, 30);
  if (!customer || !phone) {
    return res.status(400).json({ success: false, message: "Customer name and phone number are required." });
  }

  // Idempotency: if this exact ID already exists, return it untouched.
  const requested = normalizeOrderId(body.id || '');
  if (requested) {
    const existing = db.orders.find(o => String(o.id).toUpperCase() === requested);
    if (existing) {
      const submittedPhone = String(phone).replace(/\D/g, '').slice(-9);
      const existingPhone = String(existing.phone || '').replace(/\D/g, '').slice(-9);
      const sameCustomerPhone = submittedPhone.length === 9 && submittedPhone === existingPhone;
      return res.status(200).json(projectOrder(existing, sameCustomerPhone ? 'checkout' : 'public'));
    }
  }

  const normalizedItems = normalizeOrderItems(db, body.items);
  if (normalizedItems.error) return res.status(400).json({ success: false, message: normalizedItems.error });
  const { items } = normalizedItems;

  const subtotal = Math.round(items.reduce((sum, i) => sum + (i.price * i.quantity), 0) * 100) / 100;
  const requestedFulfilment = cleanString(body.fulfilment || 'Delivery', 40);
  const isDelivery = /deliver/i.test(requestedFulfilment);

  let id = requested;
  let pin;
  if (id && /^YB-[A-Z0-9]{4,12}$/.test(id)) {
    pin = newPickupPin(db, id);
    if (!pin) return res.status(503).json({ success: false, message: "Could not reserve a unique pickup PIN. Please try again." });
  } else {
    const generated = newOrderId(db);
    id = generated.id;
    pin = generated.pin;
  }

  const currentSession = (db.sessions && db.sessions[0]) || { sessionNumber: 1 };
  const requestedNetwork = normalizeNetwork(body.paymentNetwork);
  const network = requestedNetwork === 'cash' ? '' : (requestedNetwork || normalizeNetwork(body.payment));
  const payment = cleanString(body.payment || (network ? MOMO_NETWORKS[network].label : 'MTN Mobile Money'), 80);
  const paymentMode = paymentModeFor(payment) === 'cash' || requestedNetwork === 'cash' ? 'cash' : 'momo';

  // Prefer an explicit pin, then any coordinates embedded in the address
  // (pasted Google/Apple Maps link), then the Adabraka kitchen default.
  const sharedPickup = currentSession.pickupPoint || (db.settings && db.settings.pickup) || null;
  const pinFromAddress = extractCoordinates(body.location);
  const hasPin = body.mapPin
    && Number.isFinite(Number(body.mapPin.lat))
    && Number.isFinite(Number(body.mapPin.lng))
    && Math.abs(Number(body.mapPin.lat)) <= 90
    && Math.abs(Number(body.mapPin.lng)) <= 180;
  const customerPin = hasPin
    ? {
      lat: Number(body.mapPin.lat),
      lng: Number(body.mapPin.lng),
      name: cleanString(body.mapPin.name || body.location, 200)
    }
    : pinFromAddress;
  const sharedPin = sharedPickup && Number.isFinite(Number(sharedPickup.lat)) && Number.isFinite(Number(sharedPickup.lng))
    ? { lat: Number(sharedPickup.lat), lng: Number(sharedPickup.lng), name: sharedPickup.name }
    : { ...DEFAULT_PICKUP_POINT };
  if (isDelivery && !customerPin) {
    return res.status(400).json({
      success: false,
      message: "Choose a delivery landmark or share your GPS pin so the rider can navigate to the correct address."
    });
  }
  const orderPin = isDelivery ? customerPin : sharedPin;
  const orderLocation = customerPin
    ? cleanString(body.location || customerPin.name || 'Customer selected location', 200)
    : (sharedPin.name || DEFAULT_PICKUP_POINT.name);

  // The server owns delivery pricing so a client cannot submit a lower fee.
  const deliveryCalc = calculateOrderDelivery(isDelivery, items, orderPin, sharedPickup);
  const deliveryFee = deliveryCalc.fee;
  const total = Math.round((subtotal + deliveryFee) * 100) / 100;

  const customerAccessToken = crypto.randomBytes(32).toString('base64url');
  const customerPhoneKey = String(phone || '').replace(/\D/g, '').slice(-9);
  const previousOrders = customerPhoneKey
    ? (db.orders || []).filter(existing => String(existing.phone || '').replace(/\D/g, '').slice(-9) === customerPhoneKey && existing.status !== 'cancelled')
    : [];
  const customerOrderNumber = previousOrders.length + 1;
  const newOrder = {
    id,
    customerAccessTokenHash: customerOrderTokenHash(customerAccessToken),
    pickupPin: pin,
    pickupPinIsOrderId: false,
    sessionNumber: body.sessionNumber || currentSession.sessionNumber,
    createdAt: body.createdAt || new Date().toISOString(),
    customer,
    phone,
    customerOrderNumber,
    congratulationsMessage: customerOrderNumber === 1
      ? 'Congratulations on your first order! Thank you for choosing YEBS Noodles and making us your main piece.'
      : `Congratulations on your ${customerOrderNumber}${customerOrderNumber % 10 === 1 && customerOrderNumber !== 11 ? 'st' : customerOrderNumber % 10 === 2 && customerOrderNumber !== 12 ? 'nd' : customerOrderNumber % 10 === 3 && customerOrderNumber !== 13 ? 'rd' : 'th'} order! Thank you for continuing to choose YEBS Noodles.`,
    fulfilment: isDelivery ? 'Delivery' : 'Collection',
    location: orderLocation,
    mapPin: orderPin,
    pinSource: customerPin ? (hasPin ? 'customer-map' : 'map-link') : 'shared-pickup',
    timing: cleanString(body.timing || "As soon as possible", 60),
    items,
    subtotal,
    deliveryFee,
    deliveryDistanceKm: deliveryCalc.distanceKm,
    deliveryDiscount: deliveryCalc.discount,
    deliveryBaseFee: deliveryCalc.baseFee,
    total,
    payment,
    paymentMode,
    paymentNetwork: network || null,
    paymentStatus: 'unpaid',
    paymentRef: id,
    paymentVerified: false,
    paidAt: null,
    verificationMethod: null,
    momoAmount: null,
    momoTransactionRef: null,
    momoRequestId: null,
    momoRequestStatus: null,
    momoRequestAt: null,
    momoPayerPhone: walletPhone(body.payerPhone) || null,
    momoReceipt: null,
    paymentAudit: [],
    notes: cleanString(body.notes, 500),
    status: "pending",
    verifiedByDriver: false,
    pickupPoint: sharedPickup,
    pickupPointName: sharedPickup ? sharedPickup.name : null,
    orderSession: body.orderSession || {
      isActive: true,
      sessionNumber: body.sessionNumber || currentSession.sessionNumber,
      startedAt: new Date().toISOString(),
      endedAt: null
    },
    driver: null,
    driverId: null,
    driverName: null,
    driverPhone: null
  };

  db.orders.unshift(newOrder);
  // Register the kitchen alert together with the order in the same durable
  // write, then deliver it in the background after the customer already has
  // their confirmation (the "bot working" status is polled by the UI).
  const orderNotification = queueNotification(db, newOrder, 'order', orderWhatsAppText(newOrder));
  newOrder.notificationStatus = 'sending';
  const orderPersistenceError = await requireDurableSave(db);
  if (orderPersistenceError) {
    db.orders.shift();
    db.notifications = (db.notifications || []).filter(n => n.id !== orderNotification.id);
    return res.status(503).json({ success: false, persisted: false, message: orderPersistenceError });
  }

  logAction("ORDER_CREATED", customer, newOrder.id, {
    total: newOrder.total,
    pin: newOrder.pickupPin,
    paymentMode: newOrder.paymentMode
  }, req);

  // Fire-and-forget: Cloud API → CallMeBot retries happen here while the
  // customer sees "Bot working — please wait while the message is sent."
  Promise.resolve().then(() => deliverNotification(orderNotification.id))
    .catch(err => console.warn('[whatsapp] order notification skipped:', err.message));

  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(newOrder.id, { type: 'created', order: projectOrder(newOrder, 'customer') });
  }

  res.status(201).json({
    ...projectOrder(newOrder, 'checkout'),
    trackingToken: customerAccessToken,
    notification: notificationView(orderNotification),
    whatsapp: whatsappReadiness()
  });
});

app.patch('/api/orders/:id/edit', (req, res) => {
  const db = loadDatabase();
  const id = normalizeOrderId(req.params.id);
  const order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order) return res.status(404).json({ success: false, message: "Order not found." });
  if (!hasOrderAccess(order, req)) return res.status(403).json({ success: false, message: "Order access token required." });
  if (!['pending', 'kitchen'].includes(order.status) || order.driverId || order.driver) {
    return res.status(409).json({ success: false, message: "This order can no longer be edited. Contact the kitchen for help." });
  }
  if ((order.paymentStatus && order.paymentStatus !== 'unpaid')
    || order.paymentVerified
    || order.momoReceipt
    || order.momoTransactionRef
    || order.momoRequestId) {
    return res.status(409).json({ success: false, message: "An order with payment activity cannot be edited. Contact the kitchen for help." });
  }
  if (order.cancellation && ['requested', 'pending', 'awaiting_cancellation'].includes(order.cancellation.status)) {
    return res.status(409).json({ success: false, message: "This order has a pending cancellation request and cannot be edited." });
  }

  const body = req.body || {};
  const customer = cleanString(body.customer, 100);
  const phone = cleanString(body.phone, 30);
  if (!customer || !phone) {
    return res.status(400).json({ success: false, message: "Customer name and phone number are required." });
  }
  const normalizedItems = normalizeOrderItems(db, body.items);
  if (normalizedItems.error) return res.status(400).json({ success: false, message: normalizedItems.error });

  const items = normalizedItems.items;
  const subtotal = Math.round(items.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100) / 100;
  const requestedFulfilment = cleanString(body.fulfilment || 'Delivery', 40);
  const isDelivery = /deliver/i.test(requestedFulfilment);
  const currentSession = (db.sessions && db.sessions[0]) || { sessionNumber: order.sessionNumber || 1 };
  const sharedPickup = currentSession.pickupPoint || (db.settings && db.settings.pickup) || null;
  const pinFromAddress = extractCoordinates(body.location);
  const hasPin = body.mapPin
    && Number.isFinite(Number(body.mapPin.lat))
    && Number.isFinite(Number(body.mapPin.lng))
    && Math.abs(Number(body.mapPin.lat)) <= 90
    && Math.abs(Number(body.mapPin.lng)) <= 180;
  const customerPin = hasPin
    ? {
      lat: Number(body.mapPin.lat),
      lng: Number(body.mapPin.lng),
      name: cleanString(body.mapPin.name || body.location, 200)
    }
    : pinFromAddress;
  const sharedPin = sharedPickup && Number.isFinite(Number(sharedPickup.lat)) && Number.isFinite(Number(sharedPickup.lng))
    ? { lat: Number(sharedPickup.lat), lng: Number(sharedPickup.lng), name: sharedPickup.name }
    : { ...DEFAULT_PICKUP_POINT };
  if (isDelivery && !customerPin) {
    return res.status(400).json({
      success: false,
      message: "Choose a delivery landmark or share your GPS pin so the rider can navigate to the correct address."
    });
  }

  const orderPin = isDelivery ? customerPin : sharedPin;
  const orderLocation = isDelivery
    ? cleanString(body.location || customerPin.name || 'Customer selected location', 200)
    : (sharedPin.name || DEFAULT_PICKUP_POINT.name);
  const deliveryCalc = calculateOrderDelivery(isDelivery, items, orderPin, sharedPickup);
  const requestedNetwork = normalizeNetwork(body.paymentNetwork);
  const network = requestedNetwork === 'cash' ? '' : (requestedNetwork || normalizeNetwork(body.payment));
  const payment = cleanString(body.payment || (network ? MOMO_NETWORKS[network].label : 'MTN Mobile Money'), 80);

  order.customer = customer;
  order.phone = phone;
  order.fulfilment = isDelivery ? 'Delivery' : 'Collection';
  order.location = orderLocation;
  order.mapPin = orderPin;
  order.pinSource = customerPin ? (hasPin ? 'customer-map' : 'map-link') : 'shared-pickup';
  order.timing = cleanString(body.timing || "As soon as possible", 60);
  order.items = items;
  order.subtotal = subtotal;
  order.deliveryFee = deliveryCalc.fee;
  order.deliveryDistanceKm = deliveryCalc.distanceKm;
  order.deliveryDiscount = deliveryCalc.discount;
  order.deliveryBaseFee = deliveryCalc.baseFee;
  order.total = Math.round((subtotal + deliveryCalc.fee) * 100) / 100;
  order.payment = payment;
  order.paymentMode = paymentModeFor(payment) === 'cash' || requestedNetwork === 'cash' ? 'cash' : 'momo';
  order.paymentNetwork = network || null;
  order.momoPayerPhone = walletPhone(body.payerPhone) || null;
  order.notes = cleanString(body.notes, 500);
  order.pickupPoint = sharedPickup;
  order.pickupPointName = sharedPickup ? sharedPickup.name : null;
  order.updatedAt = new Date().toISOString();
  saveDatabase(db);
  logAction("ORDER_EDITED", customer, order.id, { total: order.total }, req);

  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'updated', order: projectOrder(order, 'customer') });
  }
  res.json({ success: true, message: "Order updated.", order: projectOrder(order, 'checkout') });
});

app.patch('/api/orders/:id/status', requireRole('driver', 'admin'), (req, res) => {
  const db = loadDatabase();
  const id = normalizeOrderId(req.params.id);
  const order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });

  const { status, driver } = req.body || {};
  const allowed = ['pending', 'kitchen', 'enroute', 'arrived', 'delivered'];
  if (status && !allowed.includes(status)) {
    return res.status(400).json({ success: false, message: "Unknown order status." });
  }
  if (req.auth.payload.role === 'driver') {
    const driverOwnsOrder = order.driverId === req.auth.driver.id
      || (order.driver && order.driver.id === req.auth.driver.id);
    if (!driverOwnsOrder) {
      return res.status(403).json({ success: false, message: "Accept this delivery before updating its status." });
    }
  }
  if (driver) {
    return res.status(409).json({ success: false, message: "Driver assignment is managed by accepting an available delivery." });
  }
  if (status === 'enroute') {
    return res.status(409).json({ success: false, message: "En-route tracking starts automatically after the assigned rider moves with live GPS." });
  }
  if (status === 'arrived' && req.auth.payload.role !== 'driver') {
    return res.status(403).json({ success: false, message: "Only the assigned rider can mark arrival." });
  }
  if (status === 'arrived' && order.status !== 'enroute') {
    return res.status(409).json({ success: false, message: "The rider must start live tracking before marking arrival." });
  }
  const paymentIsPaid = order.paymentStatus === 'paid' || order.paymentVerified === true;
  if (status === 'delivered' && !paymentIsPaid) {
    return res.status(409).json({ success: false, message: "Record and verify the payment before marking this delivery complete." });
  }
  if (status === 'delivered') {
    return res.status(409).json({ success: false, message: "Use the assigned rider's customer PIN verification to complete this delivery." });
  }
  if (status) order.status = status;
  if (driver) order.driver = { ...(order.driver || {}), ...driver };

  if (order.status === 'kitchen') order.kitchenAt = order.kitchenAt || new Date().toISOString();
  if (order.status === 'enroute') order.enrouteAt = new Date().toISOString();
  if (order.status === 'arrived') order.arrivedAt = new Date().toISOString();
  if (order.status === 'delivered') order.deliveredAt = new Date().toISOString();

  saveDatabase(db);
  logAction("ORDER_STATUS_CHANGED", driver ? driver.name : (req.auth.payload.role === 'admin' ? req.auth.admin.username : 'DRIVER'), order.id, { newStatus: order.status }, req);

  // Push real-time update to any customer watching this order via SSE
  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'status', order: projectOrder(order, 'customer') });
  }

  res.json(projectOrder(order, req.auth.payload.role === 'admin' ? 'admin' : 'driver'));
});

app.post('/api/orders/:id/cancellation', (req, res) => {
  const db = loadDatabase();
  const id = normalizeOrderId(req.params.id);
  const order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order) return res.status(404).json({ success: false, message: "Order not found." });
  if (!hasOrderAccess(order, req)) return res.status(403).json({ success: false, message: "Order access token required." });

  const submittedPhone = cleanString((req.body || {}).phone, 30).replace(/\D/g, '').slice(-9);
  const orderPhone = String(order.phone || '').replace(/\D/g, '').slice(-9);
  if (submittedPhone.length !== 9 || orderPhone.length !== 9 || submittedPhone !== orderPhone) {
    return res.status(403).json({ success: false, message: "Enter the phone number used for this order." });
  }
  if (['enroute', 'arrived', 'delivered', 'cancelled'].includes(order.status)) {
    return res.status(409).json({ success: false, message: "This order can no longer be cancelled online. Please contact YEBS support." });
  }
  if (order.cancellation && order.cancellation.status === 'pending') {
    return res.json({ success: true, message: "Your cancellation request is already awaiting admin approval.", order: projectOrder(order, 'customer') });
  }

  const paid = order.paymentStatus === 'paid' && order.paymentVerified === true;
  const refundFee = 5;
  order.cancellation = {
    status: 'pending',
    reason: cleanString((req.body || {}).reason || 'Customer requested cancellation', 240),
    requestedAt: new Date().toISOString()
  };
  order.refund = paid ? {
    status: 'awaiting_cancellation',
    amount: Math.max(0, Math.round((Number(order.total || 0) - refundFee) * 100) / 100),
    fee: refundFee,
    requestedAt: new Date().toISOString()
  } : null;

  saveDatabase(db);
  logAction('ORDER_CANCELLATION_REQUESTED', order.customer, order.id, {
    paid,
    refundAmount: order.refund ? order.refund.amount : 0,
    reason: order.cancellation.reason
  }, req);
  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'cancellation-request', order: projectOrder(order, 'customer') });
  }
  res.status(202).json({
    success: true,
    message: paid
      ? `Cancellation request sent for admin approval. If approved, the refund will be GH₵${order.refund.amount.toFixed(2)} after the GH₵5.00 cancellation fee.`
      : "Cancellation request sent for admin approval.",
    order: projectOrder(order, 'customer')
  });
});

app.post('/api/orders/:id/cancellation/review', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found." });
  if (!order.cancellation || order.cancellation.status !== 'pending') {
    return res.status(409).json({ success: false, message: "There is no pending cancellation request for this order." });
  }

  const approved = (req.body || {}).approved === true;
  const reason = cleanString((req.body || {}).reason, 240);
  const actor = req.auth.admin.name || req.auth.admin.username;
  if (approved && ['enroute', 'arrived', 'delivered', 'cancelled'].includes(order.status)) {
    return res.status(409).json({ success: false, message: "This order has already entered delivery or reached a terminal state; cancellation cannot be approved." });
  }
  order.cancellation.status = approved ? 'approved' : 'rejected';
  order.cancellation.reviewedAt = new Date().toISOString();
  order.cancellation.reviewReason = reason || null;
  if (approved) {
    order.status = 'cancelled';
    order.cancelledAt = order.cancellation.reviewedAt;
    if (order.refund) order.refund.status = 'pending';
  } else if (order.refund) {
    order.refund.status = 'rejected';
    order.refund.reviewedAt = order.cancellation.reviewedAt;
    order.refund.reviewReason = reason || null;
  }

  saveDatabase(db);
  logAction(approved ? 'ORDER_CANCELLATION_APPROVED' : 'ORDER_CANCELLATION_REJECTED', actor, order.id, { reason }, req);
  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'cancellation-review', order: projectOrder(order, 'customer') });
  }
  res.json({ success: true, message: approved ? "Cancellation approved." : "Cancellation request rejected.", order: projectOrder(order, 'admin') });
});

app.post('/api/orders/:id/refund/review', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found." });
  if (order.status !== 'cancelled' || !order.refund || order.refund.status !== 'pending') {
    return res.status(409).json({ success: false, message: "There is no pending refund approval for this cancelled order." });
  }

  const approved = (req.body || {}).approved === true;
  const reason = cleanString((req.body || {}).reason, 240);
  const actor = req.auth.admin.name || req.auth.admin.username;
  order.refund.status = approved ? 'approved' : 'rejected';
  order.refund.reviewedAt = new Date().toISOString();
  order.refund.reviewReason = reason || null;

  saveDatabase(db);
  logAction(approved ? 'ORDER_REFUND_APPROVED' : 'ORDER_REFUND_REJECTED', actor, order.id, {
    amount: order.refund.amount,
    reason
  }, req);
  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'refund-review', order: projectOrder(order, 'customer') });
  }
  res.json({
    success: true,
    message: approved
      ? `Refund of GH₵${Number(order.refund.amount).toFixed(2)} approved. Send it through the MoMo provider and update the customer.`
      : "Refund request rejected.",
    order: projectOrder(order, 'admin')
  });
});

app.post('/api/orders/:id/refund/complete', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order || !order.refund || order.refund.status !== 'approved') {
    return res.status(409).json({ success: false, message: 'Only an approved refund can be marked as sent.' });
  }
  const method = cleanString((req.body || {}).method || 'Mobile Money', 40);
  const reference = cleanString((req.body || {}).reference || '', 80);
  if (!reference) return res.status(400).json({ success: false, message: 'A payment or transfer reference is required.' });
  order.refund.status = 'completed';
  order.refund.completedAt = new Date().toISOString();
  order.refund.method = method;
  order.refund.reference = reference;
  saveDatabase(db);
  logAction('ORDER_REFUND_COMPLETED', req.auth.admin.username, order.id, { method, reference, amount: order.refund.amount }, req);
  res.json({ success: true, message: 'Refund marked as completed.', order: projectOrder(order, 'admin') });
});

// Driver or Admin claims / accepts an order for delivery
app.post('/api/orders/:id/claim', requireRole('driver'), async (req, res) => {
  const db = loadDatabase();
  const id = normalizeOrderId(req.params.id);
  const order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });

  if (order.status === 'delivered' || order.status === 'cancelled') {
    return res.status(409).json({ success: false, message: "This order is no longer available for delivery." });
  }
  if (order.cancellation && order.cancellation.status === 'pending') {
    return res.status(409).json({ success: false, message: "This order has a pending cancellation request and is temporarily unavailable." });
  }

  const driverObj = req.auth.driver;
  if (driverObj.isActive === false || driverObj.approvalStatus === 'pending' || driverObj.approvalStatus === 'rejected') {
    return res.status(403).json({ success: false, message: "Your rider account must be active and approved before accepting deliveries." });
  }
  const currentDriverId = order.driverId || (order.driver && order.driver.id);
  if (currentDriverId && currentDriverId !== driverObj.id) {
    return res.status(409).json({ success: false, message: "Another rider has already accepted this delivery." });
  }
  if (currentDriverId === driverObj.id) {
    return res.json({ success: true, message: "You already accepted this delivery.", order: projectOrder(order, 'driver') });
  }
  const driverName = driverObj.name || `${driverObj.fname || ''} ${driverObj.lname || ''}`.trim() || driverObj.username || 'YEBS Rider';
  const previousOrder = JSON.parse(JSON.stringify(order));

  order.driverId = driverObj.id || null;
  order.driverName = driverName;
  order.driverPhone = driverObj.phone || null;
  if (order.status !== 'driver_assigned') order.statusBeforeAssignment = order.status || 'pending';
  order.driver = {
    id: driverObj.id || null,
    name: driverName,
    phone: driverObj.phone || null,
    vehicle: driverObj.vehicle || null,
    // No inline photo here — customers load it from /api/drivers/:id/photo.
    currentLocation: Number.isFinite(Number(driverObj.lat)) && Number.isFinite(Number(driverObj.lng))
      ? { lat: Number(driverObj.lat), lng: Number(driverObj.lng) }
      : null
  };
  order.assignedAt = order.assignedAt || new Date().toISOString();
  if (['Received', 'pending', 'kitchen', ''].includes(String(order.status || ''))) {
    order.status = 'driver_assigned';
  }

  const persistenceError = await requireDurableSave(db);
  if (persistenceError) {
    Object.keys(order).forEach(key => delete order[key]);
    Object.assign(order, previousOrder);
    return res.status(503).json({ success: false, persisted: false, message: persistenceError });
  }
  logAction("ORDER_CLAIMED", driverName, order.id, { driverId: driverObj.id, status: order.status }, req);

  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'assignment', order: projectOrder(order, 'customer') });
  }

  // External notification providers must not block a durable order acceptance.
  void sendRecoveryPhone(order.phone,
    `YEBS: Rider ${driverName} accepted your order ${order.id}. Live GPS tracking will start when the rider begins moving.`
  ).then(async customerNotice => {
    order.driverNoticeStatus = customerNotice.ok ? 'sent' : 'not-delivered';
    try {
      await requireDurableSave(db);
    } catch (noticeError) {
      console.warn('[order] Acceptance notice persistence failed:', noticeError && noticeError.message);
    }
  });

  res.json({ success: true, message: `Delivery accepted by ${driverName}. Live tracking starts when the rider moves.`, order: projectOrder(order, 'driver') });
});

// Driver or Admin releases / unclaims an order
app.post('/api/orders/:id/unclaim', requireRole('driver', 'admin'), (req, res) => {
  const db = loadDatabase();
  const id = normalizeOrderId(req.params.id);
  const order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });

  if (req.auth.payload.role === 'driver' && order.driverId !== req.auth.driver.id && !(order.driver && order.driver.id === req.auth.driver.id)) {
    return res.status(403).json({ success: false, message: "You can only release a delivery assigned to you." });
  }
  if (['enroute', 'arrived', 'delivered'].includes(order.status)) {
    return res.status(409).json({ success: false, message: "This delivery cannot be released after the rider has started moving." });
  }

  const prevDriver = order.driverName || (order.driver && order.driver.name) || 'Rider';
  const restoredStatus = order.statusBeforeAssignment || 'pending';
  order.driverId = null;
  order.driverName = null;
  order.driverPhone = null;
  order.driver = null;
  order.status = restoredStatus;
  delete order.statusBeforeAssignment;

  saveDatabase(db);
  logAction("ORDER_UNCLAIMED", prevDriver, order.id, {}, req);

  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'status', order: projectOrder(order, 'customer') });
  }

  res.json({ success: true, message: "Order unassigned and available for any rider to claim.", order: projectOrder(order, req.auth.payload.role) });
});

// Handover validation uses the separate pickup PIN stored on the order.
app.post('/api/orders/:id/verify-pin', requireRole('driver', 'admin'), async (req, res) => {
  const db = loadDatabase();
  const id = normalizeOrderId(req.params.id);
  const order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });

  if (req.auth.payload.role === 'driver' && order.driverId !== req.auth.driver.id && !(order.driver && order.driver.id === req.auth.driver.id)) {
    return res.status(403).json({ success: false, message: "You can only verify the PIN for a delivery assigned to you." });
  }
  if (order.paymentStatus !== 'paid' && order.paymentVerified !== true) {
    return res.status(409).json({ success: false, message: "Payment must be verified before the order can be handed over." });
  }
  if (order.status !== 'arrived') {
    return res.status(409).json({ success: false, message: "Mark arrival at the order destination before verifying the handover PIN." });
  }

  const entered = cleanString((req.body || {}).pin, 20).replace(/[^0-9]/g, '');
  const expected = String(order.pickupPin || '');

  if (entered && entered === expected) {
    const actorName = req.auth.payload.role === 'admin'
      ? (req.auth.admin.username || 'ADMIN')
      : (req.auth.driver.name || req.auth.driver.username || 'RIDER');
    order.verifiedByDriver = true;
    order.verifiedAt = new Date().toISOString();
    order.status = 'delivered';
    order.deliveredAt = new Date().toISOString();
    // The rider's hand-over report is built from the database copy of the
    // order and queued in the same write, then delivered in the background.
    const reportEntry = queueNotification(db, order, 'report', deliveryReportText(order, actorName));
    const persistenceError = await requireDurableSave(db);
    if (persistenceError) {
      return res.status(503).json({ success: false, persisted: false, message: persistenceError });
    }
    logAction("PIN_VERIFIED", actorName, order.id, { customer: order.customer }, req);
    if (typeof pushOrderUpdate === 'function') {
      pushOrderUpdate(order.id, { type: 'delivered', order: projectOrder(order, 'customer') });
    }
    Promise.resolve().then(() => deliverNotification(reportEntry.id))
      .catch(err => console.warn('[whatsapp] delivery report skipped:', err.message));
    return res.json({
      success: true,
      message: `Order ID verified ✅ Hand ${order.id} to ${order.customer}.`,
      order: projectOrder(order, req.auth.payload.role === 'admin' ? 'admin' : 'driver'),
      report: notificationView(reportEntry),
      whatsapp: whatsappReadiness()
    });
  }

  return res.status(400).json({
    success: false,
    message: `That code does not match ${order.id}. Ask the customer to show their separate 4-digit pickup PIN.`
  });
});

// ==========================================================
// 5. SESSION & SHARED PICKUP POINT
// ==========================================================

app.get('/api/session', (req, res) => {
  const db = loadDatabase();
  res.json((db.sessions && db.sessions[0]) || {});
});

// Admin or rider sets the pickup point; every portal polls this and updates.
app.post('/api/session/pickup-point', requireRole('admin', 'driver'), (req, res) => {
  const body = req.body || {};
  const name = cleanString(body.pickupPointName || body.name || body.pickupPoint, 140);
  const latRaw = body.coordinates && body.coordinates.lat !== undefined ? body.coordinates.lat : body.lat;
  const lngRaw = body.coordinates && body.coordinates.lng !== undefined ? body.coordinates.lng : body.lng;

  const ACCRA_LANDMARKS = {
    "circle": { lat: 5.5612, lng: -0.2155 },
    "odo rice": { lat: 5.5612, lng: -0.2155 },
    "vip": { lat: 5.5605, lng: -0.2160 },
    "efex": { lat: 5.56246, lng: -0.21289 },
    "adabraka": { lat: 5.5580, lng: -0.2105 },
    "police": { lat: 5.5580, lng: -0.2105 },
    "ridge": { lat: 5.5628, lng: -0.2035 },
    "hospital": { lat: 5.5628, lng: -0.2035 },
    "osu": { lat: 5.5560, lng: -0.1830 },
    "danquah": { lat: 5.5600, lng: -0.1820 },
    "cantonments": { lat: 5.5780, lng: -0.1790 },
    "kaneshie": { lat: 5.5690, lng: -0.2450 }
  };

  let lat = Number(latRaw);
  let lng = Number(lngRaw);
  if (!Number.isFinite(lat)) lat = null;
  if (!Number.isFinite(lng)) lng = null;
  const validLat = lat !== null && lat >= -90 && lat <= 90;
  const validLng = lng !== null && lng >= -180 && lng <= 180;

  if (!validLat || !validLng) {
    const lower = name.toLowerCase();
    for (const [key, coords] of Object.entries(ACCRA_LANDMARKS)) {
      if (lower.includes(key)) {
        lat = coords.lat;
        lng = coords.lng;
        break;
      }
    }
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ success: false, message: "Pick a pickup point on the map or choose a landmark so exact coordinates can be saved." });
  }

  const db = loadDatabase();
  const session = (db.sessions && db.sessions[0]) || { sessionNumber: 1 };
  const actor = req.auth.payload.role === 'admin'
    ? (req.auth.admin.name || req.auth.admin.username)
    : (req.auth.driver.name || req.auth.driver.username);

  const newPickupPoint = {
    name: name || "Custom Pickup Point",
    lat: Number(lat),
    lng: Number(lng),
    updatedAt: new Date().toISOString(),
    setBy: actor,
    setByRole: req.auth.payload.role
  };

  session.pickupPoint = newPickupPoint;
  db.sessions = db.sessions && db.sessions.length ? db.sessions : [session];
  db.sessions[0] = session;

  // Keep active orders pointing at the same live pickup point.
  db.orders.forEach(o => {
    if (o.status !== 'delivered' && o.status !== 'cancelled') {
      o.pickupPoint = newPickupPoint;
      o.pickupPointName = newPickupPoint.name;
    }
  });

  saveDatabase(db);
  logAction("PICKUP_POINT_UPDATED", actor, newPickupPoint.name, { lat, lng }, req);

  res.json({ success: true, pickupPoint: newPickupPoint, session });
});

// ==========================================================
// 6. AUDIT LOGS (admin only)
// ==========================================================

app.get('/api/logs', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  res.json(db.auditLogs || []);
});

// ==========================================================
// 7. MENU MANAGEMENT & POSTER CARD TEMPLATES
// ==========================================================
const DEFAULT_POSTER_MENU = [
  {
    id: "spag15",
    name: "SPAGHETTI",
    price: 15,
    noodles: ["Spaghetti"],
    formula: "Add scrambled egg + Cut half sausage",
    desc: "= Add scrambled egg + Cut half sausage",
    image: "img_food_3.jpg",
    badge: "15 CEDIS",
    tag: "Quick Bite",
    template: "poster-capsule"
  },
  {
    id: "indomie20",
    name: "SPAGHETTI / INDOMIE",
    price: 20,
    noodles: ["Spaghetti", "Indomie"],
    formula: "Add scrambled egg + Cut full sausage + Put one egg on top.",
    desc: "= Add scrambled egg + Cut full sausage + Put one egg on top.",
    image: "img_food_2.jpg",
    badge: "20 CEDIS",
    tag: "Bestseller",
    template: "poster-capsule"
  },
  {
    id: "indomie30",
    name: "SPAGHETTI / INDOMIE",
    price: 30,
    noodles: ["Spaghetti", "Indomie"],
    formula: "Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + Free Beta malt",
    desc: "= Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + Free Beta malt",
    image: "img_food_1.jpg",
    badge: "30 CEDIS",
    tag: "Free Beta Malt",
    template: "poster-capsule"
  },
  {
    id: "indomie40",
    name: "SPAGHETTI / INDOMIE",
    price: 40,
    noodles: ["Spaghetti", "Indomie"],
    formula: "Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + One Chicken + Free Beta Malt",
    desc: "= Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + One Chicken + Free Beta Malt",
    image: "ghana_spag_chicken.jpg",
    badge: "40 CEDIS",
    tag: "Chicken + Beta Malt",
    template: "poster-capsule"
  },
  {
    id: "indomie60",
    name: "SPAGHETTI / INDOMIE",
    price: 60,
    noodles: ["Spaghetti", "Indomie"],
    formula: "Add scrambled egg + Cut full sausage + Put one egg on top + One sausage + more Gizzard + One Full Chicken (Two pieces) + Free Beta Malt",
    desc: "= Add scrambled egg + Cut full sausage + Put one egg on top + One sausage + more Gizzard + One Full Chicken (Two pieces) + Free Beta Malt",
    image: "img_food_3.jpg",
    badge: "60 CEDIS",
    tag: "Two Chicken + Beta Malt",
    template: "poster-capsule"
  }
];

app.get('/api/menu', async (req, res) => {
  const db = loadDatabase();
  if (!db.menuItems || !Array.isArray(db.menuItems) || db.menuItems.length === 0) {
    db.menuItems = JSON.parse(JSON.stringify(DEFAULT_POSTER_MENU));
    await saveDatabase(db);
  }
  res.json(db.menuItems);
});

// Personalised recommendations built from real order history:
//   1. dishes this phone has ordered before (weighted highest)
//   2. dishes that are popular across recent orders
//   3. whatever is available, so the shelf is never empty
app.get('/api/recommendations', (req, res) => {
  const db = loadDatabase();
  const exclude = new Set(String(req.query.exclude || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean));
  const phone = String(req.query.phone || '').replace(/\D/g, '').slice(-9);
  const available = (db.menuItems || []).filter(item => {
    const status = String(item.status || '').toLowerCase();
    return item.available !== false && status !== 'sold_out' && status !== 'coming_soon';
  });

  const scores = new Map();
  const bump = (id, amount) => {
    if (!id) return;
    scores.set(String(id), (scores.get(String(id)) || 0) + amount);
  };

  // Repeat-customer history (last 180 days).
  const historyCutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;
  let historyOrders = 0;
  if (phone) {
    for (const order of db.orders) {
      const orderPhone = String(order.phone || '').replace(/\D/g, '').slice(-9);
      if (orderPhone !== phone) continue;
      if (new Date(order.createdAt || 0).getTime() < historyCutoff) continue;
      historyOrders += 1;
      for (const item of (order.items || [])) {
        const itemId = item.menuId || available.find(menu => menu.name === item.name)?.id;
        bump(itemId, 3 * (Number(item.quantity) || 1));
      }
    }
  }

  // Shop-wide popularity (last 90 days).
  const popularCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  for (const order of db.orders) {
    if (new Date(order.createdAt || 0).getTime() < popularCutoff) continue;
    if (order.status === 'cancelled') continue;
    for (const item of (order.items || [])) {
      const itemId = item.menuId || available.find(menu => menu.name === item.name)?.id;
      bump(itemId, Number(item.quantity) || 1);
    }
  }

  const ranked = available
    .filter(item => !exclude.has(String(item.id)))
    .map(item => ({ item, score: scores.get(String(item.id)) || 0 }))
    .sort((a, b) => b.score - a.score || String(a.item.name).localeCompare(String(b.item.name)));

  const limit = Math.min(6, Math.max(1, Math.floor(Number(req.query.limit) || 3)));
  const recommendations = ranked.slice(0, limit).map(entry => entry.item);
  res.json({
    success: true,
    basis: historyOrders > 0 ? 'history' : 'popularity',
    recommendations,
    reason: historyOrders > 0
      ? `Based on your last ${historyOrders} order${historyOrders === 1 ? '' : 's'}`
      : 'Popular with YEBS customers'
  });
});

app.post('/api/menu', requireRole('admin'), async (req, res) => {
  const { menuItems } = req.body || {};
  if (!Array.isArray(menuItems) || menuItems.length === 0) {
    return res.status(400).json({ success: false, message: "Invalid menuItems array." });
  }
  const db = loadDatabase();
  db.menuItems = menuItems.slice(0, 100);
  const failure = await requireDurableSave(db);
  if (failure) return res.status(503).json({ success: false, persisted: false, message: failure });
  logAction("MENU_UPDATED", req.auth.admin.username, "MENU", { count: db.menuItems.length }, req);
  res.json({ success: true, persisted: true, menuItems: db.menuItems });
});

app.post('/api/menu/item', requireRole('admin'), async (req, res) => {
  const itemData = req.body || {};
  if (!itemData.name || !itemData.name.trim()) {
    return res.status(400).json({ success: false, message: "Dish title / name is required." });
  }
  const price = Number(itemData.price);
  if (!price || price <= 0) {
    return res.status(400).json({ success: false, message: "A valid positive price in Cedis is required." });
  }

  const db = loadDatabase();
  if (!db.menuItems || !Array.isArray(db.menuItems)) {
    db.menuItems = [...DEFAULT_POSTER_MENU];
  }

  const id = itemData.id && String(itemData.id).trim()
    ? String(itemData.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    : 'dish_' + Date.now().toString(36);

  const newItem = {
    id,
    name: itemData.name.trim(),
    price: Math.round(price * 100) / 100,
    badge: itemData.badge || `${price} CEDIS`,
    tag: itemData.tag || (itemData.status === 'coming_soon' ? '🚀 COMING SOON' : 'Freshly Cooked'),
    formula: itemData.formula || itemData.desc || 'Cooked to perfection with freshly boiled noodles',
    desc: itemData.desc || itemData.description || itemData.formula || 'Fresh Ghanaian noodles cooked to order',
    description: itemData.description || itemData.desc || 'Fresh Ghanaian noodles cooked to order',
    image: itemData.image || 'img_food_1.jpg',
    noodles: Array.isArray(itemData.noodles) && itemData.noodles.length > 0 ? itemData.noodles : ['Spaghetti', 'Indomie'],
    template: itemData.template || 'poster-capsule',
    available: itemData.status === 'sold_out' ? false : (itemData.available !== false),
    status: itemData.status || (itemData.available === false ? 'sold_out' : 'available'),
    prepTime: itemData.prepTime || 'Ready in 20–30 min'
  };

  db.menuItems.push(newItem);
  const failure = await requireDurableSave(db);
  if (failure) return res.status(503).json({ success: false, persisted: false, message: failure });
  logAction("MENU_ITEM_CREATED", req.auth.admin.username, newItem.id, { name: newItem.name, price: newItem.price, status: newItem.status }, req);
  res.json({ success: true, persisted: true, item: newItem, menuItems: db.menuItems });
});

app.put('/api/menu/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const updates = req.body || {};
  const db = loadDatabase();
  if (!db.menuItems || !Array.isArray(db.menuItems) || db.menuItems.length === 0) {
    db.menuItems = [...DEFAULT_POSTER_MENU];
  }
  const idx = db.menuItems.findIndex(m => m.id === id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: "Menu item not found." });
  }
  db.menuItems[idx] = { ...db.menuItems[idx], ...updates };
  const failure = await requireDurableSave(db);
  if (failure) return res.status(503).json({ success: false, persisted: false, message: failure });
  logAction("MENU_ITEM_UPDATED", req.auth.admin.username, id, updates, req);
  res.json({ success: true, persisted: true, item: db.menuItems[idx], menuItems: db.menuItems });
});

app.delete('/api/menu/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const db = loadDatabase();
  if (!db.menuItems || !Array.isArray(db.menuItems)) {
    return res.status(404).json({ success: false, message: "Menu is empty." });
  }
  const prevCount = db.menuItems.length;
  db.menuItems = db.menuItems.filter(m => m.id !== id);
  if (db.menuItems.length === prevCount) {
    return res.status(404).json({ success: false, message: "Dish not found." });
  }
  const failure = await requireDurableSave(db);
  if (failure) return res.status(503).json({ success: false, persisted: false, message: failure });
  logAction("MENU_ITEM_DELETED", req.auth.admin.username, id, { deletedId: id }, req);
  res.json({ success: true, persisted: true, message: "Dish deleted successfully.", menuItems: db.menuItems });
});

app.post('/api/menu/reset', requireRole('admin'), async (req, res) => {
  const db = loadDatabase();
  db.menuItems = JSON.parse(JSON.stringify(DEFAULT_POSTER_MENU));
  const failure = await requireDurableSave(db);
  if (failure) return res.status(503).json({ success: false, persisted: false, message: failure });
  logAction("MENU_RESET_TO_POSTER", req.auth.admin.username, "MENU", "Reset to original 15-60 Cedis poster template.", req);
  res.json({ success: true, persisted: true, menuItems: db.menuItems });
});

// ==========================================================
// 8. DRIVER APPROVAL WORKFLOW
// ==========================================================

// Driver signup now creates a pending account awaiting admin approval
// Override the existing signup to mark approvalStatus = 'pending'
// (patch applied at the route level below)

app.post('/api/auth/driver/approve', requireRole('admin'), async (req, res) => {
  const { driverId, approved, reason } = req.body || {};
  if (!driverId) return res.status(400).json({ success: false, message: "driverId required." });
  const db = loadDatabase();
  const driver = db.drivers.find(d => d.id === driverId);
  if (!driver) return res.status(404).json({ success: false, message: "Driver not found." });
  const previousDriver = JSON.parse(JSON.stringify(driver));
  const actor = req.auth.admin.name || req.auth.admin.username;
  if (approved) {
    driver.approvalStatus = 'approved';
    driver.approvedAt = new Date().toISOString();
    driver.approvedBy = actor;
    driver.isActive = true;
    driver.approvalNotified = false;
  } else {
    driver.approvalStatus = 'rejected';
    driver.rejectedAt = new Date().toISOString();
    driver.rejectedBy = actor;
    driver.rejectionReason = cleanString(reason || 'Not approved', 300);
    driver.isActive = false;
  }
  const persistenceError = await requireDurableSave(db);
  if (persistenceError) {
    Object.keys(driver).forEach(key => delete driver[key]);
    Object.assign(driver, previousDriver);
    return res.status(503).json({ success: false, persisted: false, message: persistenceError });
  }
  logAction(approved ? "DRIVER_APPROVED" : "DRIVER_REJECTED", actor, driver.id, {
    name: driver.name,
    reason: approved ? (reason || null) : driver.rejectionReason
  }, req);
  if (approved) {
    pushToDriver(driver.id, { type: 'approved', driver: publicDriver(driver) });
  }
  res.json({
    success: true,
    persisted: true,
    message: approved ? `${driver.name} approved and can now log in.` : `${driver.name} has been rejected.`,
    driver: publicDriver(driver)
  });
});

// Remove / deactivate inactive drivers
app.delete('/api/drivers/:id', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const idx = db.drivers.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: "Driver not found." });
  const driver = db.drivers[idx];
  const actor = req.auth.admin.name || req.auth.admin.username;
  logAction("DRIVER_REMOVED", actor, driver.id, { name: driver.name }, req);
  db.drivers.splice(idx, 1);
  saveDatabase(db);
  res.json({ success: true, message: `${driver.name} has been removed from the system.` });
});

// Toggle driver active/inactive
app.patch('/api/drivers/:id/toggle', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const driver = db.drivers.find(d => d.id === req.params.id);
  if (!driver) return res.status(404).json({ success: false, message: "Driver not found." });
  driver.isActive = !driver.isActive;
  const actor = req.auth.admin.name || req.auth.admin.username;
  logAction(driver.isActive ? "DRIVER_ACTIVATED" : "DRIVER_DEACTIVATED", actor, driver.id, { name: driver.name }, req);
  saveDatabase(db);
  res.json({ success: true, isActive: driver.isActive, driver: publicDriver(driver) });
});

// Driver earnings + payout requests, calculated from real delivered orders.
// A rider earns the delivery fee recorded on each order; nothing is invented.
function driverEarningsSnapshot(driver, period) {
  const db = loadDatabase();
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const label = ['week', 'month', 'year'].includes(period) ? period : 'week';
  const buckets = [];
  if (label === 'week') {
    start.setDate(start.getDate() - 6);
    for (let i = 0; i < 7; i++) {
      const from = new Date(start); from.setDate(start.getDate() + i);
      const to = new Date(from); to.setDate(from.getDate() + 1);
      buckets.push({ label: from.toLocaleDateString('en-GB', { weekday: 'short' }), from, to });
    }
  } else if (label === 'month') {
    start.setDate(1);
    const days = Math.max(1, Math.ceil((now - start) / 86400000) + 1);
    for (let i = 0; i < days; i++) {
      const from = new Date(start); from.setDate(start.getDate() + i);
      const to = new Date(from); to.setDate(from.getDate() + 1);
      buckets.push({ label: String(from.getDate()), from, to });
    }
  } else {
    start.setMonth(0, 1);
    for (let m = 0; m < 12; m++) {
      const from = new Date(start.getFullYear(), m, 1);
      const to = new Date(start.getFullYear(), m + 1, 1);
      buckets.push({ label: from.toLocaleDateString('en-GB', { month: 'short' }), from, to });
    }
  }

  function belongs(o) {
    if (!o.driver) return false;
    if (o.driver.id && driver.id && String(o.driver.id) === String(driver.id)) return true;
    if (o.driver.username && driver.username && String(o.driver.username).toLowerCase() === String(driver.username).toLowerCase()) return true;
    return !!(o.driver.name && driver.name && String(o.driver.name).toLowerCase() === String(driver.name).toLowerCase());
  }
  function fee(o) { return Number(o.deliveryFee) || 0; }

  const mine = db.orders.filter(belongs);
  const delivered = mine.filter(o => o.status === 'delivered');
  const weekStart = new Date(); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - 6);

  const totalEarnings = Math.round(delivered.reduce((sum, o) => sum + fee(o), 0) * 100) / 100;
  const thisWeek = Math.round(delivered.filter(o => new Date(o.deliveredAt || o.createdAt || 0) >= weekStart).reduce((sum, o) => sum + fee(o), 0) * 100) / 100;

  // A rider can only cash out delivery fees from orders that were actually
  // delivered and have not already been requested or paid out.
  const claimed = (db.payouts || [])
    .filter(p => String(p.driverId) === String(driver.id) && ['requested', 'paid'].includes(p.status))
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const pendingPayout = Math.max(0, Math.round((totalEarnings - claimed) * 100) / 100);

  const timed = delivered.filter(o => o.createdAt && o.deliveredAt);
  const avgMinutes = timed.length
    ? Math.round(timed.reduce((sum, o) => sum + Math.max(0, (new Date(o.deliveredAt) - new Date(o.createdAt)) / 60000), 0) / timed.length)
    : null;

  const chart = buckets.map(b => {
    const from = b.from.getTime();
    const to = b.to.getTime();
    const inBucket = delivered.filter(o => {
      const t = new Date(o.deliveredAt || o.createdAt || 0).getTime();
      return t >= from && t < to;
    });
    return {
      label: b.label,
      earnings: Math.round(inBucket.reduce((sum, o) => sum + fee(o), 0) * 100) / 100,
      deliveries: inBucket.length
    };
  });

  const payouts = (db.payouts || [])
    .filter(p => String(p.driverId) === String(driver.id))
    .sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0))
    .slice(0, 20)
    .map(p => ({
      id: p.id,
      amount: Number(p.amount) || 0,
      deliveries: p.deliveries || 0,
      status: p.status || 'requested',
      method: p.method || 'Mobile Money',
      requestedAt: p.requestedAt,
      paidAt: p.paidAt || null
    }));

  const recentDeliveries = delivered
    .slice()
    .sort((a, b) => new Date(b.deliveredAt || b.createdAt || 0) - new Date(a.deliveredAt || a.createdAt || 0))
    .slice(0, 10)
    .map(o => ({
      orderId: o.id,
      customer: o.customer || '',
      createdAt: o.createdAt,
      deliveredAt: o.deliveredAt || null,
      fee: fee(o),
      total: Number(o.total) || 0,
      status: o.status
    }));

  return {
    driver: { id: driver.id, name: driver.name || driver.username, phone: driver.phone || '' },
    period: label,
    totalEarnings,
    thisWeek,
    totalDeliveries: delivered.length,
    avgPerDelivery: delivered.length ? Math.round((totalEarnings / delivered.length) * 100) / 100 : 0,
    pendingPayout,
    chart,
    payouts,
    recentDeliveries,
    metrics: {
      delivered: delivered.length,
      cancelled: mine.filter(o => o.status === 'cancelled').length,
      inProgress: mine.filter(o => !['delivered', 'cancelled'].includes(o.status)).length,
      completionRate: (delivered.length + mine.filter(o => o.status === 'cancelled').length)
        ? Math.round((delivered.length / (delivered.length + mine.filter(o => o.status === 'cancelled').length)) * 1000) / 10
        : 0,
      avgDeliveryTime: avgMinutes
    }
  };
}

app.get('/api/drivers/:id/earnings', requireRole('driver', 'admin'), (req, res) => {
  const db = loadDatabase();
  const driver = db.drivers.find(d => String(d.id) === String(req.params.id))
    || (req.auth.payload.role === 'driver' ? req.auth.driver : null);
  if (!driver) return res.status(404).json({ success: false, message: 'Driver not found.' });
  if (req.auth.payload.role === 'driver' && String(driver.id) !== String(req.auth.driver.id)) {
    return res.status(403).json({ success: false, message: 'You can only view your own earnings.' });
  }
  res.json({ success: true, ...driverEarningsSnapshot(driver, req.query.period) });
});

app.post('/api/drivers/:id/payouts', requireRole('driver', 'admin'), (req, res) => {
  const db = loadDatabase();
  const driver = db.drivers.find(d => String(d.id) === String(req.params.id));
  if (!driver) return res.status(404).json({ success: false, message: 'Driver not found.' });
  if (req.auth.payload.role === 'driver' && String(driver.id) !== String(req.auth.driver.id)) {
    return res.status(403).json({ success: false, message: 'You can only request your own payout.' });
  }
  const snapshot = driverEarningsSnapshot(driver, 'week');
  const existing = (db.payouts || []).find(p => String(p.driverId) === String(driver.id) && p.status === 'requested');
  if (existing) {
    return res.status(200).json({ success: true, pending: true, message: 'Your payout request is already waiting for the admin.', payout: existing });
  }
  const requestedAmount = (req.body || {}).amount;
  const amount = requestedAmount === undefined || requestedAmount === null || requestedAmount === ''
    ? snapshot.pendingPayout
    : toAmount(requestedAmount);
  if (amount === null) {
    return res.status(400).json({ success: false, message: 'Enter a valid payout amount.' });
  }
  if (!amount || amount <= 0) {
    return res.status(400).json({ success: false, message: 'There is no pending delivery fee to request yet.' });
  }
  if (amount > snapshot.pendingPayout) {
    return res.status(400).json({
      success: false,
      message: `The requested payout cannot exceed your pending earnings of GH₵${snapshot.pendingPayout.toFixed(2)}.`
    });
  }
  const payout = {
    id: 'payout-' + Date.now(),
    driverId: driver.id,
    driverName: driver.name || driver.username,
    amount: Math.round(amount * 100) / 100,
    deliveries: snapshot.recentDeliveries.length,
    status: 'requested',
    method: 'Mobile Money',
    requestedAt: new Date().toISOString()
  };
  db.payouts = db.payouts || [];
  db.payouts.unshift(payout);
  saveDatabase(db);
  logAction('DRIVER_PAYOUT_REQUESTED', driver.name || driver.username, driver.id, { amount: payout.amount }, req);
  res.status(201).json({ success: true, message: 'Payout request sent to the admin.', payout });
});

// Check approval status (used by driver portal to show pending screen)
app.get('/api/drivers/:id/approval', (req, res) => {
  const db = loadDatabase();
  const driver = db.drivers.find(d => d.id === req.params.id);
  if (!driver) return res.status(404).json({ success: false, message: "Driver not found." });
  res.json({
    success: true,
    approvalStatus: driver.approvalStatus || 'pending',
    name: driver.name || `${driver.fname} ${driver.lname}`.trim()
  });
});

// ==========================================================
// 9. ADMIN SETTINGS — Change username / password
// ==========================================================

app.post('/api/admin/settings/credentials', requireRole('admin'), async (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body || {};
  const db = loadDatabase();
  const admin = db.admins.find(a => a.id === req.auth.admin.id);
  if (!admin) return res.status(404).json({ success: false, message: "Admin account not found." });

  if (!verifyPassword(String(currentPassword || ''), admin.password)) {
    rateFail(req, 'admin', admin.username);
    logAction("ADMIN_CRED_CHANGE_FAILED", admin.username, "SETTINGS", { reason: "Wrong current password" }, req);
    return res.status(401).json({ success: false, message: "Current password is incorrect." });
  }

  const previousCredentials = {
    username: admin.username,
    password: admin.password,
    passwordUpdatedAt: admin.passwordUpdatedAt,
    sessionEpoch: admin.sessionEpoch
  };
  const previousAuditLogs = Array.isArray(db.auditLogs) ? db.auditLogs.slice() : db.auditLogs;
  let changed = [];
  if (newPassword && String(newPassword).length < 12) {
    return res.status(400).json({ success: false, message: "New password must be at least 12 characters." });
  }
  if (newPassword && String(newPassword) === PUBLISHED_DEFAULT_ADMIN_PASSWORD) {
    return res.status(400).json({ success: false, message: "Choose a unique password. The published default password is not allowed." });
  }

  if (newUsername && cleanString(newUsername, 80).toLowerCase() !== admin.username.toLowerCase()) {
    const nu = cleanString(newUsername, 80);
    if (db.admins.some(a => a.id !== admin.id && String(a.username).toLowerCase() === nu.toLowerCase())) {
      return res.status(409).json({ success: false, message: "That username is already taken." });
    }
    admin.username = nu;
    changed.push('username');
  }
  if (newPassword) {
    admin.password = hashPassword(String(newPassword));
    admin.passwordUpdatedAt = new Date().toISOString();
    admin.sessionEpoch = (admin.sessionEpoch || 0) + 1;
    changed.push('password');
  }

  if (!changed.length) return res.status(400).json({ success: false, message: "No changes provided." });

  db.auditLogs = db.auditLogs || [];
  db.auditLogs.unshift({
    id: "log-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    timestamp: new Date().toISOString(),
    action: "ADMIN_CREDENTIALS_UPDATED",
    actor: admin.username || "ANONYMOUS",
    entity: "SETTINGS",
    details: JSON.stringify({ changed }),
    ipOrAgent: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || "LOCAL").toString()
  });
  if (db.auditLogs.length > 500) db.auditLogs.pop();

  const persistenceError = await requireDurableSave(db);
  if (persistenceError) {
    Object.assign(admin, previousCredentials);
    if (previousAuditLogs === undefined) delete db.auditLogs;
    else db.auditLogs = previousAuditLogs;
    return res.status(503).json({ success: false, message: persistenceError });
  }

  const token = createToken(admin.id, 'admin', { username: admin.username, name: admin.name, sessionEpoch: admin.sessionEpoch || 0 });
  res.json({
    success: true,
    message: `Updated: ${changed.join(' and ')}. Please use your new credentials next time.`,
    token,
    admin: { id: admin.id, username: admin.username, name: admin.name, role: admin.role }
  });
});

// ==========================================================
// 10. CUSTOMER ORDER EDIT
// ==========================================================

app.patch('/api/orders/:id/edit', (req, res) => {
  const db = loadDatabase();
  const id = normalizeOrderId(req.params.id);
  const order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order) return res.status(404).json({ success: false, message: "Order not found." });
  if (!hasOrderAccess(order, req)) return res.status(403).json({ success: false, message: "Order access token required." });

  // Only allow edits on pending or kitchen orders (not enroute/arrived/delivered)
  if (['enroute', 'arrived', 'delivered', 'cancelled'].includes(order.status)) {
    return res.status(409).json({ success: false, message: "This order is already being delivered and cannot be edited. Call the rider directly." });
  }

  // Verify ownership via phone (last 9 digits match)
  const reqPhone = cleanString((req.body || {}).phone || '', 30).replace(/\s+/g, '');
  const orderPhone = String(order.phone || '').replace(/\s+/g, '');
  if (reqPhone && orderPhone && !orderPhone.endsWith(reqPhone.slice(-9))) {
    return res.status(403).json({ success: false, message: "Phone number does not match this order." });
  }

  const body = req.body || {};
  const updates = [];
  if (body.location && cleanString(body.location, 200) !== order.location) {
    order.location = cleanString(body.location, 200);
    updates.push('location');
  }
  if (body.mapPin && Number.isFinite(Number(body.mapPin.lat)) && Number.isFinite(Number(body.mapPin.lng))) {
    order.mapPin = { lat: Number(body.mapPin.lat), lng: Number(body.mapPin.lng) };
    updates.push('mapPin');
  }
  if (body.notes !== undefined) { order.notes = cleanString(body.notes, 500); updates.push('notes'); }
  if (body.timing) { order.timing = cleanString(body.timing, 60); updates.push('timing'); }

  if (body.items && Array.isArray(body.items) && body.items.length > 0) {
    const items = body.items.slice(0, 30).map(item => {
      const menuItem = (db.menuItems || []).find(m => String(m.id) === String(item.menuId));
      const unit = menuItem ? Number(menuItem.price) : toAmount(item.price);
      const qty = Math.max(1, Math.min(50, Math.floor(Number(item.quantity) || 1)));
      return {
        name: cleanString(item.name || (menuItem && menuItem.name), 100),
        noodle: cleanString(item.noodle, 60),
        menuId: menuItem ? menuItem.id : (item.menuId || null),
        price: unit || 0,
        quantity: qty,
        image: cleanString(item.image, 120)
      };
    }).filter(i => i.name && i.price >= 0);
    if (items.length > 0) {
      order.items = items;
      order.subtotal = Math.round(items.reduce((s, i) => s + i.price * i.quantity, 0) * 100) / 100;
      order.total = Math.round((order.subtotal + (order.deliveryFee || 0)) * 100) / 100;
      updates.push('items');
    }
  }

  if (!updates.length) return res.status(400).json({ success: false, message: "No valid changes provided." });

  order.lastEditedAt = new Date().toISOString();
  saveDatabase(db);
  logAction("ORDER_EDITED_BY_CUSTOMER", order.customer, order.id, { updates }, req);

  res.json({
    success: true,
    message: `Order ${order.id} updated (${updates.join(', ')}).`,
    order: projectOrder(order, 'public')
  });
});

// ==========================================================
// 11. DAILY AUDIT / CLOSE-OF-DAY REPORT
// ==========================================================

function buildDailyReport(date) {
  const db = loadDatabase();
  const dayStart = date ? new Date(date + 'T00:00:00.000Z') : (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d;
  })();
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const todayOrders = db.orders.filter(o => {
    const t = new Date(o.createdAt || 0).getTime();
    return t >= dayStart.getTime() && t < dayEnd.getTime();
  });

  const delivered = todayOrders.filter(o => o.status === 'delivered');
  const cancelled = todayOrders.filter(o => o.status === 'cancelled');
  const pending = todayOrders.filter(o => !['delivered', 'cancelled'].includes(o.status));
  const totalIncome = todayOrders.filter(o => o.paymentStatus === 'paid').reduce((s, o) => s + (o.total || 0), 0);
  const momoIncome = todayOrders.filter(o => o.paymentStatus === 'paid' && o.paymentMode === 'momo').reduce((s, o) => s + (o.total || 0), 0);
  const cashIncome = todayOrders.filter(o => o.paymentStatus === 'paid' && o.paymentMode === 'cash').reduce((s, o) => s + (o.total || 0), 0);

  const todayLogs = (db.auditLogs || []).filter(l => {
    const t = new Date(l.timestamp || 0).getTime();
    return t >= dayStart.getTime() && t < dayEnd.getTime();
  });

  return {
    reportDate: dayStart.toISOString().split('T')[0],
    generatedAt: new Date().toISOString(),
    summary: {
      totalOrders: todayOrders.length,
      delivered: delivered.length,
      cancelled: cancelled.length,
      pending: pending.length,
      totalIncome: Math.round(totalIncome * 100) / 100,
      momoIncome: Math.round(momoIncome * 100) / 100,
      cashIncome: Math.round(cashIncome * 100) / 100,
      unpaidOrders: todayOrders.filter(o => o.paymentStatus !== 'paid').length
    },
    orders: todayOrders.map(o => ({
      id: o.id, pin: o.pickupPin, customer: o.customer, phone: o.phone,
      items: (o.items || []).map(i => `${i.quantity}x ${i.name}`).join('; '),
      total: o.total, paymentStatus: o.paymentStatus, paymentMode: o.paymentMode,
      status: o.status, createdAt: o.createdAt, deliveredAt: o.deliveredAt || '',
      driver: o.driver ? o.driver.name : ''
    })),
    activityLog: todayLogs
  };
}

app.get('/api/reports/daily', requireRole('admin'), (req, res) => {
  const report = buildDailyReport(req.query.date);
  res.json({ success: true, report });
});

// ==========================================================
// 10b. CUSTOMER REVIEWS & LOYALTY (real orders only)
// ==========================================================

function phoneKey(value) {
  return String(value || '').replace(/\D/g, '').slice(-9);
}

function ordersForPhone(db, phone) {
  const key = phoneKey(phone);
  if (!key) return [];
  return (db.orders || []).filter(o => phoneKey(o.phone) === key);
}

function publicReview(review) {
  return {
    id: review.id,
    orderId: review.orderId,
    customer: review.customer || 'Customer',
    rating: Number(review.rating) || 0,
    comment: review.comment || '',
    createdAt: review.createdAt,
    reply: review.reply || null,
    repliedAt: review.repliedAt || null
  };
}

app.get('/api/reviews', (req, res) => {
  const db = loadDatabase();
  const orderId = normalizeOrderId(req.query.orderId || '');
  const phone = phoneKey(req.query.phone);
  let reviews = (db.reviews || []).filter(r => r.hidden !== true);
  if (orderId) reviews = reviews.filter(r => String(r.orderId).toUpperCase() === orderId);
  if (phone) reviews = reviews.filter(r => phoneKey(r.phone) === phone);
  reviews = reviews
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 50);
  const average = reviews.length ? Math.round((reviews.reduce((sum, r) => sum + (Number(r.rating) || 0), 0) / reviews.length) * 10) / 10 : 0;
  res.json({ success: true, average, count: reviews.length, reviews: reviews.map(publicReview) });
});

app.post('/api/reviews', (req, res) => {
  const body = req.body || {};
  const db = loadDatabase();
  const orderId = normalizeOrderId(body.orderId || '');
  const rating = Math.max(1, Math.min(5, Math.round(Number(body.rating) || 0)));
  const comment = cleanString(body.comment, 500);
  const phone = phoneKey(body.phone);

  if (!orderId) return res.status(400).json({ success: false, message: 'Choose the order you want to review.' });
  if (!rating) return res.status(400).json({ success: false, message: 'Choose a rating from 1 to 5 stars.' });
  const order = db.orders.find(o => String(o.id).toUpperCase() === orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (phone && phoneKey(order.phone) !== phone) {
    return res.status(403).json({ success: false, message: 'That order belongs to a different phone number.' });
  }
  if (order.status !== 'delivered') {
    return res.status(400).json({ success: false, message: 'You can review an order once it has been delivered.' });
  }

  db.reviews = db.reviews || [];
  let review = db.reviews.find(r => String(r.orderId).toUpperCase() === orderId && (!phone || phoneKey(r.phone) === phone));
  if (review) {
    review.rating = rating;
    review.comment = comment;
    review.createdAt = new Date().toISOString();
  } else {
    review = {
      id: 'rev-' + Date.now(),
      orderId,
      phone: order.phone || '',
      customer: order.customer || 'Customer',
      rating,
      comment,
      createdAt: new Date().toISOString(),
      reply: null,
      repliedAt: null
    };
    db.reviews.unshift(review);
  }
  saveDatabase(db);
  logAction('CUSTOMER_REVIEW_SAVED', order.customer || 'CUSTOMER', orderId, { rating }, req);
  res.status(201).json({ success: true, message: 'Thank you - your review is saved.', review: publicReview(review) });
});

app.post('/api/reviews/:id/reply', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const review = (db.reviews || []).find(r => String(r.id) === String(req.params.id));
  if (!review) return res.status(404).json({ success: false, message: 'Review not found.' });
  const reply = cleanString((req.body || {}).reply, 500);
  if (!reply) return res.status(400).json({ success: false, message: 'Write a reply first.' });
  review.reply = reply;
  review.repliedAt = new Date().toISOString();
  review.repliedBy = req.auth.admin.username;
  saveDatabase(db);
  logAction('REVIEW_REPLIED', req.auth.admin.username, review.orderId, { reviewId: review.id }, req);
  res.json({ success: true, review: publicReview(review) });
});

app.get('/api/loyalty/summary', (req, res) => {
  const db = loadDatabase();
  const phone = phoneKey(req.query.phone);
  if (!phone) return res.status(400).json({ success: false, message: 'Enter the phone number used for your orders.' });
  const orders = ordersForPhone(db, phone);
  const paid = orders.filter(o => o.paymentStatus === 'paid');
  const spent = paid.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
  const points = Math.floor(spent);
  const tiers = [
    { name: 'Bronze', min: 0 },
    { name: 'Silver', min: 100 },
    { name: 'Gold', min: 300 },
    { name: 'Platinum', min: 700 }
  ];
  const tier = tiers.slice().reverse().find(t => points >= t.min) || tiers[0];
  const next = tiers.find(t => t.min > points) || null;
  const myReviews = (db.reviews || []).filter(r => phoneKey(r.phone) === phone);
  res.json({
    success: true,
    phone,
    points,
    tier: tier.name,
    nextTier: next ? next.name : null,
    pointsToNext: next ? Math.max(0, next.min - points) : 0,
    orders: orders.length,
    paidOrders: paid.length,
    spent: Math.round(spent * 100) / 100,
    reviews: myReviews.length,
    tiers
  });
});

app.get('/api/customers/orders', (req, res) => {
  const db = loadDatabase();
  const orders = ordersForPhone(db, req.query.phone)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json({ success: true, orders: orders.map(o => projectOrder(o, 'public')) });
});

// ==========================================================
// 11b. BUSINESS ANALYTICS (computed from the real database)
// ==========================================================

function analyticsRangeBounds(rangeValue) {
  const range = ['today', 'week', 'month', 'year'].includes(rangeValue) ? rangeValue : 'week';
  const end = new Date();
  const start = new Date(end);
  start.setHours(0, 0, 0, 0);
  if (range === 'week') start.setDate(start.getDate() - 6);
  if (range === 'month') start.setDate(1);
  if (range === 'year') start.setMonth(0, 1);
  const span = Math.max(1, end.getTime() - start.getTime());
  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(start.getTime() - span);
  return { range, start, end, prevStart, prevEnd };
}

function analyticsInRange(orders, start, end) {
  const from = start.getTime();
  const to = end.getTime();
  return (orders || []).filter(o => {
    const t = new Date(o.createdAt || 0).getTime();
    return Number.isFinite(t) && t >= from && t <= to;
  });
}

function analyticsSummary(orders) {
  const real = orders.filter(o => o.status !== 'cancelled');
  const paid = real.filter(o =>
    o.paymentStatus === 'paid' ||
    o.paymentVerified === true ||
    o.verificationMethod === 'cash-driver'
  );
  const collected = paid.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
  const orderValue = real.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
  // Total revenue is the value of every non-cancelled order, so it always
  // reconciles with orders x AOV. Money actually received is collected.
  const revenue = orderValue;
  const delivered = orders.filter(o => o.status === 'delivered').length;
  const cancelled = orders.filter(o => o.status === 'cancelled').length;
  const pending = orders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length;
  const customers = new Set(real.map(o => String(o.phone || o.customer || '').replace(/\s+/g, '')).filter(Boolean)).size;
  return {
    revenue: Math.round(revenue * 100) / 100,
    collected: Math.round(collected * 100) / 100,
    orders: orders.length,
    customers,
    aov: real.length ? Math.round((orderValue / real.length) * 100) / 100 : 0,
    delivered,
    cancelled,
    pending,
    paidOrders: paid.length,
    unpaidOrders: real.length - paid.length,
    completionRate: (delivered + cancelled) ? Math.round((delivered / (delivered + cancelled)) * 1000) / 10 : 0
  };
}

function pctChange(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function analyticsBuckets(bounds) {
  const { range, start, end } = bounds;
  const buckets = [];
  if (range === 'today') {
    for (let h = 0; h < 24; h++) {
      const from = new Date(start); from.setHours(h, 0, 0, 0);
      const to = new Date(from); to.setHours(h + 1, 0, 0, 0);
      buckets.push({ label: String(h).padStart(2, '0') + ':00', from, to });
    }
  } else if (range === 'week') {
    for (let i = 0; i < 7; i++) {
      const from = new Date(start); from.setDate(start.getDate() + i);
      const to = new Date(from); to.setDate(from.getDate() + 1);
      buckets.push({ label: from.toLocaleDateString('en-GB', { weekday: 'short' }), from, to });
    }
  } else if (range === 'month') {
    const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
    for (let i = 0; i < days; i++) {
      const from = new Date(start); from.setDate(start.getDate() + i);
      const to = new Date(from); to.setDate(from.getDate() + 1);
      buckets.push({ label: String(from.getDate()), from, to });
    }
  } else {
    for (let m = 0; m < 12; m++) {
      const from = new Date(start.getFullYear(), m, 1);
      const to = new Date(start.getFullYear(), m + 1, 1);
      buckets.push({ label: from.toLocaleDateString('en-GB', { month: 'short' }), from, to });
    }
  }
  return buckets;
}

app.get('/api/analytics/dashboard', requireRole('admin'), (req, res) => {
  try {
    const db = loadDatabase();
    const bounds = analyticsRangeBounds(req.query.range);
    const orders = analyticsInRange(db.orders, bounds.start, bounds.end);
    const prevOrders = analyticsInRange(db.orders, bounds.prevStart, bounds.prevEnd);

    const kpis = analyticsSummary(orders);
    const prev = analyticsSummary(prevOrders);

    // Revenue + order series in the selected range.
    const series = analyticsBuckets(bounds).map(b => {
      const from = b.from.getTime();
      const to = b.to.getTime();
      const inBucket = orders.filter(o => {
        const t = new Date(o.createdAt || 0).getTime();
        return t >= from && t < to;
      });
      return {
        label: b.label,
        revenue: Math.round(inBucket.filter(o => o.status !== 'cancelled').reduce((sum, o) => sum + (Number(o.total) || 0), 0) * 100) / 100,
        orders: inBucket.length
      };
    });

    // Order status breakdown.
    const statusOrder = ['pending', 'kitchen', 'enroute', 'arrived', 'delivered', 'cancelled'];
    const statusBreakdown = statusOrder.map(status => ({
      status,
      label: status === 'enroute' ? 'En route' : status.charAt(0).toUpperCase() + status.slice(1),
      count: orders.filter(o => (o.status || 'pending') === status).length
    }));

    // Best selling menu items by quantity and revenue.
    const itemMap = new Map();
    orders.filter(o => o.status !== 'cancelled').forEach(o => {
      (o.items || []).forEach(item => {
        const name = item.name || 'Menu item';
        const entry = itemMap.get(name) || { name, quantity: 0, revenue: 0 };
        entry.quantity += Number(item.quantity) || 0;
        entry.revenue += (Number(item.price) || 0) * (Number(item.quantity) || 0);
        itemMap.set(name, entry);
      });
    });
    const topItems = Array.from(itemMap.values())
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5)
      .map(i => ({ name: i.name, quantity: i.quantity, revenue: Math.round(i.revenue * 100) / 100 }));

    // Peak ordering hours (Ghana is UTC+0, matching the default server clock).
    const peakBuckets = [
      { label: '6-8 AM', from: 6, to: 9 },
      { label: '9-11 AM', from: 9, to: 12 },
      { label: '12-2 PM', from: 12, to: 15 },
      { label: '3-5 PM', from: 15, to: 18 },
      { label: '6-8 PM', from: 18, to: 21 },
      { label: '9-11 PM', from: 21, to: 24 }
    ];
    const peakHours = peakBuckets.map(b => ({
      label: b.label,
      orders: orders.filter(o => {
        const h = new Date(o.createdAt || 0).getHours();
        return h >= b.from && h < b.to;
      }).length
    }));

    // Driver performance from real delivered orders only.
    const driverMap = new Map();
    orders.forEach(o => {
      if (!o.driver || !o.driver.name) return;
      const name = o.driver.name;
      const entry = driverMap.get(name) || {
        name,
        deliveries: 0,
        active: 0,
        deliveryValue: 0,
        totalMinutes: 0,
        timedDeliveries: 0
      };
      if (o.status === 'delivered') {
        entry.deliveries += 1;
        entry.deliveryValue += Number(o.total) || 0;
        if (o.createdAt && o.deliveredAt) {
          const mins = (new Date(o.deliveredAt).getTime() - new Date(o.createdAt).getTime()) / 60000;
          if (Number.isFinite(mins) && mins >= 0) {
            entry.totalMinutes += mins;
            entry.timedDeliveries += 1;
          }
        }
      } else if (!['cancelled'].includes(o.status)) {
        entry.active += 1;
      }
      driverMap.set(name, entry);
    });
    const driverPerformance = Array.from(driverMap.values())
      .map(d => ({
        name: d.name,
        deliveries: d.deliveries,
        active: d.active,
        deliveryValue: Math.round(d.deliveryValue * 100) / 100,
        avgMinutes: d.timedDeliveries ? Math.round(d.totalMinutes / d.timedDeliveries) : null
      }))
      .sort((a, b) => b.deliveries - a.deliveries);

    // Insights are derived from the same numbers - never invented.
    const insights = [];
    if (topItems.length) {
      const best = topItems[0];
      const totalQty = topItems.reduce((sum, i) => sum + i.quantity, 0);
      insights.push({
        title: 'Best seller',
        text: best.name + ' leads with ' + best.quantity + ' portions' +
          (totalQty ? ' (' + Math.round((best.quantity / totalQty) * 100) + '% of top-item sales)' : '') +
          ' and GH₵' + best.revenue.toFixed(2) + ' in item revenue this period.'
      });
    }
    const peak = peakHours.reduce((best, b) => b.orders > best.orders ? b : best, peakHours[0]);
    if (peak && peak.orders > 0) {
      insights.push({
        title: 'Busiest window',
        text: peak.label + ' is your busiest window with ' + peak.orders + ' order' + (peak.orders === 1 ? '' : 's') + '. Staff and prep for that window first.'
      });
    }
    const repeatRows = new Map();
    orders.filter(o => o.status !== 'cancelled').forEach(o => {
      const key = String(o.phone || o.customer || '').replace(/\s+/g, '');
      if (!key) return;
      repeatRows.set(key, (repeatRows.get(key) || 0) + 1);
    });
    const repeatCustomers = Array.from(repeatRows.values()).filter(n => n > 1).length;
    const uniqueCustomers = repeatRows.size;
    if (uniqueCustomers) {
      insights.push({
        title: 'Customer retention',
        text: repeatCustomers + ' of ' + uniqueCustomers + ' customers ordered more than once this period (' +
          Math.round((repeatCustomers / uniqueCustomers) * 100) + '%). ' +
          (repeatCustomers ? 'Keep the repeat buyers close with a thank-you message.' : 'A small follow-up offer can turn first orders into repeat orders.')
      });
    }
    if (!orders.length) {
      insights.push({
        title: 'No orders yet',
        text: 'There are no orders in this period. Analytics update automatically as soon as customers order.'
      });
    }

    const recentOrders = orders
      .slice()
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 10)
      .map(o => ({
        orderId: o.id,
        customer: o.customer || '',
        items: (o.items || []).reduce((n, i) => n + (Number(i.quantity) || 0), 0),
        itemsLabel: (o.items || []).map(i => i.quantity + 'x ' + i.name).join(', '),
        amount: Number(o.total) || 0,
        status: o.status || 'pending',
        paymentStatus: o.paymentStatus || 'unpaid',
        driver: o.driver && o.driver.name ? o.driver.name : 'Not assigned',
        time: o.createdAt || ''
      }));

    res.json({
      success: true,
      range: bounds.range,
      generatedAt: new Date().toISOString(),
      rangeStart: bounds.start.toISOString(),
      rangeEnd: bounds.end.toISOString(),
      kpis,
      changes: {
        revenue: pctChange(kpis.revenue, prev.revenue),
        orders: pctChange(kpis.orders, prev.orders),
        customers: pctChange(kpis.customers, prev.customers),
        aov: pctChange(kpis.aov, prev.aov)
      },
      previous: prev,
      series,
      statusBreakdown,
      topItems,
      peakHours,
      driverPerformance,
      recentOrders,
      insights
    });
  } catch (err) {
    console.error('[analytics] dashboard failed:', err);
    res.status(200).json({
      success: true,
      degraded: true,
      message: 'Live analytics are temporarily unavailable. The store and orders are unaffected.',
      generatedAt: new Date().toISOString(),
      range: (req.query && req.query.range) || 'week',
      kpis: { revenue: 0, collected: 0, orders: 0, customers: 0, aov: 0, delivered: 0, cancelled: 0, pending: 0, paidOrders: 0, unpaidOrders: 0, completionRate: 0 },
      changes: { revenue: 0, orders: 0, customers: 0, aov: 0 },
      previous: { revenue: 0, orders: 0, customers: 0, aov: 0 },
      series: [],
      statusBreakdown: [],
      topItems: [],
      peakHours: [],
      driverPerformance: [],
      recentOrders: [],
      insights: []
    });
  }
});

// Close-of-day: auto-trigger audit when shop closes (called by admin or cron)
app.post('/api/reports/close-of-day', requireRole('admin'), (req, res) => {
  const report = buildDailyReport(req.body && req.body.date);
  const actor = req.auth.admin.name || req.auth.admin.username;
  logAction("CLOSE_OF_DAY_AUDIT", actor, "DAILY_REPORT", {
    date: report.reportDate,
    totalOrders: report.summary.totalOrders,
    delivered: report.summary.delivered,
    income: report.summary.totalIncome
  }, req);
  res.json({ success: true, report });
});

app.post('/api/driver/report', requireRole('driver'), async (req, res) => {
  const db = loadDatabase();
  const driver = req.auth.driver;
  const driverId = String(driver.id || '');
  const orders = (db.orders || []).filter(order =>
    String(order.driverId || (order.driver && order.driver.id) || '') === driverId
  );
  const activeOrders = orders.filter(order => !['delivered', 'cancelled'].includes(order.status));
  const lines = orders.slice(0, 30).map((order, index) => {
    const items = (order.items || []).map(item => `${item.quantity || 1}x ${item.name}`).join(', ');
    return `${index + 1}. Order #${order.id} - ${order.status || 'pending'}\nCustomer: ${order.customer || '-'} | ${order.phone || '-'}\nItems: ${items || '-'} | Total: GH${Number(order.total || 0).toFixed(2)}\nLocation: ${order.location || order.address || '-'}\nPIN: ${order.pickupPin || '-'}`;
  });
  const message = [
    'YEBS DRIVER REPORT',
    `Driver: ${driver.name || driver.username || 'Rider'}`,
    `Phone: ${driver.phone || '-'}`,
    `Submitted: ${new Date().toLocaleString()}`,
    `Orders assigned: ${orders.length}`,
    `Orders still active: ${activeOrders.length}`,
    '',
    lines.join('\n\n') || 'No assigned orders.'
  ].join('\n');

  const report = {
    id: 'driver-report-' + Date.now(),
    driverId,
    driverName: driver.name || driver.username || 'Rider',
    status: 'queued',
    createdAt: new Date().toISOString(),
    message
  };
  db.driverReports = db.driverReports || [];
  db.driverReports.unshift(report);
  if (db.driverReports.length > 200) db.driverReports.length = 200;
  db.notifications = db.notifications || [];
  db.notifications.unshift({
    id: 'ntf-' + Date.now() + '-driver',
    channel: 'whatsapp',
    to: whatsappConfig().to,
    createdAt: report.createdAt,
    status: 'queued',
    kind: 'driver-report',
    driverReportId: report.id,
    message
  });

  const saveError = await requireDurableSave(db);
  if (saveError) return res.status(503).json({ success: false, persisted: false, message: saveError });
  void sendOwnerWhatsApp(message).then(async delivered => {
    report.status = delivered.ok ? 'sent' : 'failed';
    report.provider = delivered.provider || null;
    report.providerId = delivered.providerId || null;
    report.reason = delivered.reason || null;
    report.sentAt = delivered.ok ? new Date().toISOString() : null;
    const notification = db.notifications.find(item => item.driverReportId === report.id);
    if (notification) Object.assign(notification, report, { status: report.status });
    await requireDurableSave(db).catch(err => console.warn('[whatsapp] driver report status persistence failed:', err.message));
  });
  res.json({ success: true, queued: true, status: 'queued', reportId: report.id, message, deliveryTarget: whatsappConfig().to });
});

// CSV export of daily report
app.get('/api/reports/daily/csv', requireRole('admin'), (req, res) => {
  const report = buildDailyReport(req.query.date);
  const headers = ['Order ID', 'PIN', 'Customer', 'Phone', 'Items', 'Total (GH₵)', 'Payment', 'Payment Status', 'Order Status', 'Created At', 'Delivered At', 'Driver'];
  const rows = report.orders.map(o => [
    o.id, o.pin, o.customer, o.phone, `"${o.items}"`,
    o.total, o.paymentMode, o.paymentStatus, o.status,
    o.createdAt, o.deliveredAt, o.driver
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="yebs-report-${report.reportDate}.csv"`);
  res.send(csv);
});

// Purge test / inactive drivers (admin utility)
app.post('/api/drivers/purge-inactive', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const { driverIds } = req.body || {};
  const actor = req.auth.admin.name || req.auth.admin.username;
  let removed = 0;
  if (Array.isArray(driverIds) && driverIds.length > 0) {
    const before = db.drivers.length;
    db.drivers = db.drivers.filter(d => !driverIds.includes(d.id));
    removed = before - db.drivers.length;
  }
  saveDatabase(db);
  logAction("DRIVERS_PURGED", actor, "DRIVERS", { removed, ids: driverIds }, req);
  res.json({ success: true, message: `${removed} driver(s) removed.`, remaining: db.drivers.length });
});

// ==========================================================
// 12. PUSH NOTIFICATION ENDPOINT (web-push compatible stub)
// Sends server-side event — clients poll /api/drivers/:id/approval
// ==========================================================

// Server-Sent Events stream for real-time push (no external service needed)
const sseClients = new Map(); // driverId -> res

app.get('/api/sse/driver/:id', (req, res) => {
  const driverId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseClients.set(driverId, res);
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    if (sseClients.get(driverId) === res) sseClients.delete(driverId);
  });
});

function pushToDriver(driverId, payload) {
  const client = sseClients.get(driverId);
  if (client) client.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ──────────────────────────────────────────────────────────────
// Customer-facing SSE: live order status stream (no auth needed)
// The tracking modal subscribes to /api/sse/order/:id and gets a
// push whenever the order status, payment or driver changes.
// ──────────────────────────────────────────────────────────────
const orderSseClients = new Map(); // orderId -> Set<res>

app.get('/api/sse/order/:id', (req, res) => {
  const orderId = normalizeOrderId(req.params.id);
  const initialDb = loadDatabase();
  const initialOrder = initialDb.orders.find(o => String(o.id).toUpperCase() === orderId);
  if (!initialOrder) return res.status(404).end();
  if (!hasOrderAccess(initialOrder, req)) return res.status(403).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering on Render
  res.flushHeaders();

  if (!orderSseClients.has(orderId)) orderSseClients.set(orderId, new Set());
  orderSseClients.get(orderId).add(res);

  // Send current snapshot immediately
  try {
    res.write(`data: ${JSON.stringify({ type: 'snapshot', order: projectOrder(initialOrder, 'customer') })}\n\n`);
  } catch (e) { /* non-fatal */ }

  let lastSnapshot = JSON.stringify(projectOrder(initialOrder, 'customer'));
  const heartbeat = setInterval(async () => {
    try {
      await store.refresh();
      const db = loadDatabase();
      const order = db.orders.find(o => String(o.id).toUpperCase() === orderId);
      if (!order) return;
      const snapshot = JSON.stringify(projectOrder(order, 'customer'));
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        res.write(`data: ${JSON.stringify({ type: 'snapshot', order: JSON.parse(snapshot) })}\n\n`);
      } else {
        res.write(': ping\n\n');
      }
    } catch (err) {
      console.warn('[tracking] shared-state refresh failed:', err.message);
    }
  }, 3000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const set = orderSseClients.get(orderId);
    if (set) { set.delete(res); if (set.size === 0) orderSseClients.delete(orderId); }
  });
});

// Public lightweight order status endpoint (no auth) — used by the tracking page
app.get('/api/orders/:id/track', (req, res) => {
  const db = loadDatabase();
  const id = normalizeOrderId(req.params.id);
  let order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order && /^\d{4}$/.test(id.replace(/^YB-/, ''))) {
    const pin = id.replace(/^YB-/, '');
    order = db.orders.find(o => String(o.pickupPin || '') === pin);
  }
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  res.json({ success: true, order: projectOrder(order, 'customer') });
});

app.post('/api/orders/:id/customer-location', (req, res) => {
  const db = loadDatabase();
  const orderId = normalizeOrderId(req.params.id);
  const order = db.orders.find(o => String(o.id).toUpperCase() === orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (!hasOrderAccess(order, req)) return res.status(403).json({ success: false, message: 'Order access token required.' });

  const lat = Number(req.body && req.body.lat);
  const lng = Number(req.body && req.body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ success: false, message: 'A valid customer GPS position is required.' });
  }
  order.customerCurrentLocation = { lat, lng, updatedAt: new Date().toISOString(), accuracyM: Number(req.body.accuracyM) || null };
  const result = saveDatabase(db);
  if (result === false) return res.status(503).json({ success: false, persisted: false, message: 'Customer location could not be saved.' });
  pushOrderUpdate(order.id, { type: 'customer-location', order: projectOrder(order, 'customer') });
  return res.json({ success: true, persisted: true, customerLocation: order.customerCurrentLocation });
});

function pushOrderUpdate(orderId, payload) {
  const id = normalizeOrderId(orderId);
  const clients = orderSseClients.get(id);
  if (!clients || clients.size === 0) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  clients.forEach(r => { try { r.write(msg); } catch (e) { clients.delete(r); } });
}


app.get('/api/admin/settings/momo', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  res.json({ success: true, momo: getMomoSettings(db) });
});

app.put('/api/admin/settings/momo', requireRole('admin'), async (req, res) => {
  const body = req.body || {};
  const payTo = walletPhone(body.payTo);
  if (!payTo) {
    return res.status(400).json({ success: false, message: "Enter a valid Ghanaian mobile money number (e.g. 0559103452)." });
  }
  const accountName = String(body.accountName || '').trim().slice(0, 80);
  if (!accountName) {
    return res.status(400).json({ success: false, message: "Enter the mobile money account name." });
  }
  const db = loadDatabase();
  db.settings = db.settings || {};
  db.settings.momo = { payTo, accountName };
  const failure = await requireDurableSave(db);
  if (failure) return res.status(503).json({ success: false, persisted: false, message: failure });
  logAction("MOMO_SETTINGS_UPDATED", req.auth.admin.username, "SETTINGS", { payTo, accountName }, req);
  res.json({ success: true, persisted: true, momo: getMomoSettings(db) });
});

// Admin: driver payout requests created from the driver earnings page.
app.get('/api/admin/payouts', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const payouts = (db.payouts || [])
    .slice()
    .sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));
  res.json({ success: true, payouts });
});

app.post('/api/admin/payouts/:id/pay', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const payout = (db.payouts || []).find(p => String(p.id) === String(req.params.id));
  if (!payout) return res.status(404).json({ success: false, message: 'Payout request not found.' });
  if (payout.status !== 'requested') {
    return res.status(409).json({ success: false, message: 'Only a pending payout request can be marked as paid.' });
  }
  const driver = (db.drivers || []).find(d => String(d.id) === String(payout.driverId));
  if (!driver) return res.status(409).json({ success: false, message: 'The payout driver no longer exists.' });
  const earnings = driverEarningsSnapshot(driver);
  const otherClaims = (db.payouts || [])
    .filter(p => String(p.driverId) === String(driver.id) && String(p.id) !== String(payout.id) && ['requested', 'paid'].includes(p.status))
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const available = Math.max(0, Math.round((earnings.totalEarnings - otherClaims) * 100) / 100);
  if (!Number.isFinite(Number(payout.amount)) || Number(payout.amount) <= 0 || Number(payout.amount) > available) {
    return res.status(409).json({
      success: false,
      message: `This payout exceeds the driver's available earnings of GH₵${available.toFixed(2)}.`
    });
  }
  payout.status = 'paid';
  payout.paidAt = new Date().toISOString();
  payout.paidBy = req.auth.admin.username;
  saveDatabase(db);
  logAction('DRIVER_PAYOUT_PAID', req.auth.admin.username, payout.driverId, { amount: payout.amount }, req);
  res.json({ success: true, message: 'Payout marked as paid.', payout });
});

// Health check used by the portals to detect a live API server
app.get('/api/health', (req, res) => {
  const db = loadDatabase();
  const pickup = (db.sessions && db.sessions[0] && db.sessions[0].pickupPoint) || (db.settings && db.settings.pickup) || null;
  const wa = whatsappConfig();
  const recoverySendGridFrom = process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_FROM || process.env.SMTP_USER || '';
  const recoveryEmailSendGridReady = Boolean(process.env.SENDGRID_API_KEY && recoverySendGridFrom.includes('@'));
  const recoveryEmailSmtpReady = Boolean(process.env.SMTP_USER && process.env.SMTP_PASSWORD);
  const recoveryPhoneTwilioReady = Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    (process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER)
  );
  const databaseWritable = store.canPersist() || (store.remoteMode === 'local' && !isEphemeralHost());
  const databasePersistent = store.isRemote() || (store.remoteMode === 'local' && Boolean(process.env.DB_PATH));
  res.status(databaseWritable ? 200 : 503).json({
    success: databaseWritable,
    service: "YEBS Noodles API",
    time: new Date().toISOString(),
    storage: store.status(),
    database: {
      engine: store.remoteMode === 'local'
        ? 'json-file'
        : store.remoteMode === 'postgres'
          ? 'postgres'
          : 'supabase-rest',
      provider: store.databaseProvider,
      path: store.remoteMode === 'local' ? DB_FILE : null,
      persistent: databasePersistent,
      writable: databaseWritable,
      // So "Supabase and Render are not talking to each other" can be seen at a
      // glance: which connection strings exist and which backend is in use.
      connections: store.diagnostics()
    },
    pickupPoint: pickup,
    deliveryFee: Number(db.settings && db.settings.deliveryFee) || 15,
    whatsapp: {
      configured: whatsappReadiness().configured,
      provider: whatsappReadiness().provider,
      to: wa.to ? wa.to.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1 $2 $3") : null,
      apiVersion: wa.version
    },
    recoveryDelivery: {
      emailConfigured: recoveryEmailSendGridReady || recoveryEmailSmtpReady,
      sendGridConfigured: recoveryEmailSendGridReady,
      smtpConfigured: recoveryEmailSmtpReady,
      twilioConfigured: recoveryPhoneTwilioReady,
      whatsappConfigured: whatsappReadiness().configured,
      adminOwnerLogFallback: true
    },
    momo: {
      payTo: getMomoSettings(db).payTo,
      accountName: getMomoSettings(db).accountName,
      apiConfigured: momoApiConfig().configured,
      networks: listMomoNetworks().map(n => ({ id: n.id, ussd: n.ussd, apiReady: n.apiReady }))
    },
    ai: {
      configured: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || process.env.AI_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY),
      providerFallback: true
    }
  });
});

app.get('/api/ready', (req, res) => {
  const db = loadDatabase();
  const checks = {
    database: store.canPersist() || store.remoteMode === 'local',
    whatsapp: whatsappReadiness().configured,
    momo: momoApiConfig().configured,
    ai: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || process.env.AI_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY)
  };
  const ready = checks.database;
  res.status(ready ? 200 : 503).json({
    success: ready,
    ready,
    checks,
    optionalServices: {
      whatsapp: checks.whatsapp ? 'ready' : 'configuration-required',
      momo: checks.momo ? 'ready' : 'configuration-required',
      ai: checks.ai ? 'ready' : 'fallback-active'
    },
    time: new Date().toISOString()
  });
});

app.get('/api/admin/operations-metrics', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const orders = Array.isArray(db.orders) ? db.orders : [];
  res.json({
    success: true,
    uptimeSeconds: Math.round((Date.now() - operationalMetrics.startedAt) / 1000),
    requests: operationalMetrics.requests,
    serverErrors: operationalMetrics.errors,
    activeOrders: orders.filter(o => !['delivered', 'cancelled'].includes(String(o.status))).length,
    paidOrders: orders.filter(o => o.paymentStatus === 'paid').length,
    pendingCancellations: orders.filter(o => o.cancellation && o.cancellation.status === 'pending').length,
    pendingRefunds: orders.filter(o => o.refund && o.refund.status === 'pending').length,
    time: new Date().toISOString()
  });
});

app.post('/api/privacy/data-request', (req, res) => {
  const db = loadDatabase();
  const phone = cleanString((req.body || {}).phone || '', 30);
  const email = cleanString((req.body || {}).email || '', 120);
  const requestType = ['access', 'correction', 'export', 'deletion'].includes((req.body || {}).type)
    ? (req.body || {}).type
    : '';
  const details = cleanString((req.body || {}).details || '', 1000);
  if (!phone && !email) return res.status(400).json({ success: false, message: 'A phone number or email is required.' });
  if (!requestType) return res.status(400).json({ success: false, message: 'Choose the type of privacy request.' });
  db.privacyRequests = Array.isArray(db.privacyRequests) ? db.privacyRequests : [];
  db.privacyRequests.unshift({
    id: 'PR-' + Date.now().toString(36).toUpper(),
    type: requestType,
    phone,
    email,
    details,
    status: 'pending',
    requestedAt: new Date().toISOString()
  });
  saveDatabase(db);
  res.status(202).json({ success: true, message: 'Your privacy request has been submitted for review.' });
});

// Friendly JSON error handler (e.g. oversized photo / receipt payload)
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      message: "Uploaded image is too large. Please retake a smaller photo (under 10 MB)."
    });
  }
  console.error("API error:", err);
  res.status(500).json({ success: false, message: err && err.message ? err.message : "Server error" });
});

// Boot: load persisted state (Supabase in production, database.json locally),
// ensure the built-in administrator exists, then upgrade legacy password hashes.
let startPromise = null;
function start() {
  if (!startPromise) {
    startPromise = (async () => {
      const data = await store.init(loadDatabase);
      const previousResetVersion = String(data.settings && data.settings.adminCredentialResetVersion || '');
      const migratingLegacyResetVersion = /^render-deploy-build-/.test(previousResetVersion)
        && ADMIN_USERNAME_CONFIGURED
        && ADMIN_PASSWORD_CONFIGURED;
      // Orders from older builds embed the rider photo; strip it so list and
      // order payloads stay small.
      const mediaStripped = stripOrderMedia(data);
      if (ensureSystemAccounts(data) || mediaStripped) {
        const result = await store.set(data);
        if (!result || !result.ok) {
          throw new Error(`Failed to persist startup account changes: ${(result && result.error) || 'storage backend unavailable'}`);
        }
        if (store.remoteMode === 'local') {
          try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) { /* read-only fs */ }
        }
      }
      const resetApplied = !migratingLegacyResetVersion &&
        ADMIN_CREDENTIAL_RESET_VERSION &&
        previousResetVersion !== ADMIN_CREDENTIAL_RESET_VERSION &&
        String(data.settings && data.settings.adminCredentialResetVersion || '') === ADMIN_CREDENTIAL_RESET_VERSION;
      if (resetApplied) {
        await store.refresh(true);
        if (store.remoteMode !== 'local' && !store.canPersist()) {
          throw new Error('Failed to verify the administrator credential reset against persistent storage.');
        }
        const persisted = store.get();
        const persistedAdmin = (persisted.admins || []).find(admin =>
          String(admin.username || '').toLowerCase() === DEFAULT_ADMIN_USERNAME.toLowerCase()
        );
        if (!persistedAdmin ||
            String(persisted.settings && persisted.settings.adminCredentialResetVersion || '') !== ADMIN_CREDENTIAL_RESET_VERSION ||
            !verifyPassword(DEFAULT_ADMIN_PASSWORD, persistedAdmin.password)) {
          throw new Error('Administrator credential reset did not match the durable database state.');
        }
      }
      await migratePasswords();
      // Move any legacy inline images out of the database after the server is
      // already serving; this never blocks boot.
      if (media.isConfigured()) {
        setTimeout(() => {
          migrateMediaToStorage(data).catch(err => console.warn('[media] background migration failed:', err.message));
        }, 5000).unref?.();
      }
      return data;
    })().catch(err => {
      startPromise = null;
      throw err;
    });
  }
  return startPromise;
}

if (require.main === module) {
  start()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`YEBS Noodles API Server running at http://localhost:${PORT}`);
        console.log(`Storage: ${store.status()}`);
        console.log(`Security: bcrypt passwords - HMAC signed sessions (${SESSION_TTL_MS / 3600000}h) - login rate limiting`);
      });
    })
    .catch(err => {
      console.error('Failed to start YEBS Noodles API:', err.message);
      process.exit(1);
    });
}

module.exports = { app, start, loadDatabase, saveDatabase };
