// YEBS Noodles - Unified Express API Backend & Database Server
// Secure auth (bcrypt + HMAC signed sessions), provider-confirmed payments,
// unified order IDs and shared pickup-point state.

// Load .env for local development and self-hosted deployments. On Render,
// Netlify and other hosts the values come from the platform, so a missing .env
// is not an error. This must run before ./src/data/store reads process.env.
try {
  require('dotenv').config();
} catch (error) {
  // dotenv is optional at runtime.
}

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./src/data/store');
const { resolveAdminCredentialResetVersion } = require('./scripts/render-deploy-version');

const resolvedAdminCredentialResetVersion = resolveAdminCredentialResetVersion(process.env);
if (resolvedAdminCredentialResetVersion) {
  process.env.ADMIN_CREDENTIAL_RESET_VERSION = resolvedAdminCredentialResetVersion;
}

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'database.json');
const SECRET_FILE = path.join(__dirname, '.auth-secret');

app.use(cors());
// Photos (driver live face photo + MoMo receipts) are sent as base64 data URLs,
// so the default 100kb JSON limit is far too small.
app.use(express.json({ limit: '12mb' }));

// serverless-http (Netlify Functions) hands the body over as a Buffer/string.
// Normalise it so every JSON handler behaves the same in both modes.
app.use((req, res, next) => {
  if (Buffer.isBuffer(req.body)) {
    const text = req.body.toString('utf8');
    try { req.body = text ? JSON.parse(text) : {}; } catch (e) { req.body = {}; }
  } else if (typeof req.body === 'string' && req.body.length) {
    try { req.body = JSON.parse(req.body); } catch (e) { /* leave original value */ }
  }
  next();
});
app.use('/database.json', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendStatus(404);
});
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
    name: 'Circle Odo Rice Junction / VIP Station',
    lat: 5.5612,
    lng: -0.2155
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
    token: process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_CLOUD_TOKEN || '',
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID || '',
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

  if (!cfg.token || !cfg.phoneId) {
    entry.status = 'not-configured';
    entry.reason = 'Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID to send kitchen alerts automatically.';
  } else {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch('https://graph.facebook.com/' + cfg.version + '/' + cfg.phoneId + '/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cfg.to,
          type: 'text',
          text: { preview_url: false, body: entry.message }
        }),
        signal: controller.signal
      }).finally(() => clearTimeout(timer));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((payload.error && payload.error.message) || ('WhatsApp API ' + response.status));
      entry.status = 'sent';
      entry.providerId = payload.messages && payload.messages[0] ? payload.messages[0].id : null;
      entry.sentAt = new Date().toISOString();
    } catch (err) {
      entry.status = 'failed';
      entry.reason = err.message;
      console.warn('[whatsapp] order notification failed:', err.message);
    }
  }

  order.notificationStatus = entry.status;
  db.notifications.unshift(entry);
  if (db.notifications.length > 500) db.notifications.length = 500;
  saveDatabase(db);
  return entry;
}

app.get('/api/admin/notifications', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  res.json({ success: true, notifications: (db.notifications || []).slice(0, 100) });
});

// Send one plain WhatsApp Cloud API text message. Used by the kitchen alert
// above and by the password-recovery flow. Returns { ok, reason } and never
// throws, so callers can fall back to another channel.
async function sendWhatsAppText(to, text) {
  const cfg = whatsappConfig();
  const target = String(to || cfg.to || '').replace(/[^\d]/g, '');
  if (!cfg.token || !cfg.phoneId) return { ok: false, reason: 'not-configured' };
  if (!target) return { ok: false, reason: 'no-phone' };
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
    console.warn('[whatsapp] message failed:', err.message);
    return { ok: false, reason: err.message };
  }
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
const ADMIN_PASSWORD_CONFIGURED = Boolean(
  DEFAULT_ADMIN_PASSWORD && DEFAULT_ADMIN_PASSWORD !== PUBLISHED_DEFAULT_ADMIN_PASSWORD
);
const ADMIN_CREDENTIAL_RESET_VERSION = resolvedAdminCredentialResetVersion;
const DEFAULT_ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'yebsnoodles@gmail.com').trim();
const DEFAULT_ADMIN_PHONE = String(process.env.ADMIN_RECOVERY_PHONE || '0559103452').trim();

// A stable signing secret is generated once and never leaves this machine.
let AUTH_SECRET = process.env.YEBS_AUTH_SECRET || '';
if (!AUTH_SECRET && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)) {
  // Netlify function instances cannot share a generated secret file. Derive a
  // stable one from the service key already present in the environment so an
  // admin signed in on one instance stays signed in on the next.
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
  name: 'Circle Odo Rice Junction / VIP Station',
  address: 'Kwame Nkrumah Circle, Accra',
  lat: 5.5612,
  lng: -0.2155
};

function ensureSystemAccounts(db) {
  const collections = ['admins', 'drivers', 'orders', 'sessions', 'auditLogs', 'menuItems', 'payouts', 'reviews', 'notifications', 'recoveryCodes'];
  let changed = false;

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
  if (cached) return cached;

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
            name: "Circle Odo Rice Junction / VIP Station",
            lat: 5.5612,
            lng: -0.2155,
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
    return initialData;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (ensureSystemAccounts(parsed) && store.remoteMode === 'local') {
      try { fs.writeFileSync(DB_FILE, JSON.stringify(parsed, null, 2)); } catch (e) { /* read-only fs */ }
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
    process.env.NETLIFY ||
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
    photo: d.photo || null,
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
// ORDER IDS — YB-XXXX where XXXX is the unique pickup PIN
// ==========================================================

function newPickupPin(db, orderId = '') {
  const usedPins = new Set((db.orders || []).map(o => String(o.pickupPin || '')));
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
  for (let i = 0; i < 20000; i++) {
    const n = crypto.randomInt(1000, 10000);
    const id = `YB-${n}`;
    if (!used.has(id)) {
      const pin = newPickupPin(db, id);
      if (pin) return { id, pin };
    }
  }
  // Extremely unlikely: deterministic scan for a free public order ID.
  for (let n = 1000; n <= 9999; n++) {
    const id = `YB-${n}`;
    if (!used.has(id)) {
      const pin = newPickupPin(db, id);
      if (pin) return { id, pin };
    }
  }
  throw new Error('No unused order ID and pickup PIN are available.');
}

function normalizeOrderId(raw) {
  const value = cleanString(raw, 20).toUpperCase().replace(/\s+/g, '');
  if (/^\d{4}$/.test(value)) return `YB-${value}`;
  if (/^YB-?\d{4}$/.test(value)) return `YB-${value.replace(/[^0-9]/g, '')}`;
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
      image: order.momoReceipt.image || null,
      transactionRef: order.momoReceipt.transactionRef || '',
      uploadedAt: order.momoReceipt.uploadedAt || null,
      verified: order.momoReceipt.verified === true
    } : null
  };
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
      photo: order.driver.photo || null,
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
    if (order.momoReceipt && order.momoReceipt.image) {
      base.momoReceipt = {
        image: order.momoReceipt.image,
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

  const isValid = password !== PUBLISHED_DEFAULT_ADMIN_PASSWORD
    && Boolean(admin && !admin.requiresPasswordSetup && verifyPassword(password, admin.password));

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
app.post('/api/auth/driver/signup', async (req, res) => {
  const fname = cleanString(req.body && req.body.fname, 60);
  const lname = cleanString(req.body && req.body.lname, 60);
  const phone = cleanString(req.body && req.body.phone, 30);
  const email = cleanString(req.body && req.body.email, 120);
  const password = String((req.body && req.body.password) || '');
  const vehicle = cleanString(req.body && req.body.vehicle, 120);
  const photo = req.body && req.body.photo ? String(req.body.photo).slice(0, 9 * 1024 * 1024) : null;

  if (!fname || !lname || !phone || !email || !password) {
    return res.status(400).json({ success: false, message: "First name, last name, phone, email, and password are required." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: "Enter a valid email address for account recovery." });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: "Choose a password with at least 6 characters." });
  }
  if (!vehicle) {
    return res.status(400).json({ success: false, message: "Vehicle type is required." });
  }
  if (!photo) {
    return res.status(400).json({ success: false, message: "A live face photo is required so customers can identify their driver." });
  }

  let releaseMutationLock;
  try {
    releaseMutationLock = await store.acquireMutationLock();
  } catch (error) {
    return res.status(503).json({ success: false, message: `Could not load the latest registration data: ${error.message}` });
  }

  try {
    const db = loadDatabase();
    if (db.drivers.some(d => String(d.phone || '').replace(/\s+/g, '') === phone.replace(/\s+/g, ''))) {
      return res.status(400).json({ success: false, message: "A driver with this phone number is already registered." });
    }

    const username = generateDriverUsername(fname, lname, db.drivers);
    const newDriver = {
      id: "drv-" + Date.now(),
      username,
      password: hashPassword(password),
      fname,
      lname,
      name: `${fname} ${lname}`.trim(),
      phone,
      email: email || '',
      vehicle,
      photo,
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
  } finally {
    await releaseMutationLock();
  }
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
          Authorization: `Bearer ${sendGridKey}`,
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

app.post('/api/drivers/:id/location', (req, res) => {
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
  if (photo) driver.photo = String(photo).slice(0, 9 * 1024 * 1024);
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
      if (driver.photo) o.driver.photo = driver.photo;
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
            photo: driver.photo,
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
  res.json(db.drivers.map(driver => ({
    ...publicDriver(driver),
    email: driver.email || ''
  })));
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
// real credentials (see DEPLOY_NETLIFY.md) the server pushes a payment
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
  const receiptHash = hashReceipt(receiptImage);

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
  } else {
    order.momoRequestId = null;
    order.momoRequestStatus = result.configured ? (result.status || 'failed') : 'ussd';
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

  if (order.paymentStatus !== 'paid' && order.momoRequestId) {
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
      : (networkStatus === 'failed' ? 'The mobile money network declined this request. Try again or use the USSD code.' : 'Waiting for the customer to approve the payment prompt.'),
    order: projectOrder(order, 'public')
  });
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
  let releaseMutationLock;
  try {
    releaseMutationLock = await store.acquireMutationLock();
  } catch (error) {
    return res.status(503).json({ success: false, persisted: false, message: `Could not load the latest order data: ${error.message}` });
  }
  try {
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
  } finally {
    await releaseMutationLock();
  }
});

// Match a forwarded MoMo SMS to an unpaid order; bridged messages remain for admin review.
function parseMomoSms(raw) {
  const text = cleanString(raw, 700);
  const amountMatch = text.match(/(?:GH\s*[₵C]?|GHS|GHC|GH₵)\s*([\d,]+(?:\.\d{1,2})?)/i)
    || text.match(/(?:amount|received|paid)[^\d]{0,24}([\d,]+(?:\.\d{1,2})?)/i);
  const txnMatch = text.match(/(?:transaction\s*(?:id|no|number|ref(?:erence)?)|txn\s*(?:id|no)?|reference|ref)\s*[:\-]?\s*([A-Za-z0-9._-]{5,50})/i);
  const orderMatch = text.match(/(YB[\s-]?\d{4})/i);
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
  await processMomoSms(req, res, `MOMO_SMS_BRIDGE:${sender}`, momoSmsIngestKey(deviceId, messageId), false);
});

// Legacy receipt upload kept for compatibility; proof remains unverified until reviewed.
app.post('/api/orders/:id/receipt', (req, res) => {
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
  const result = applyMomoPayment(db, order, {
    transactionRef,
    amount: toAmount(body.amount) === null ? Number(order.total) : toAmount(body.amount),
    sender: body.senderPhone,
    receiptImage,
    method: 'auto-receipt',
    actor: order.customer || 'CUSTOMER'
  });

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

app.get('/api/orders', (req, res) => {
  const auth = authenticate(req);
  if (!auth || !['admin', 'driver'].includes(auth.payload.role)) {
    return res.status(401).json({ success: false, message: "Sign in to view the order list." });
  }
  const db = loadDatabase();
  res.json(db.orders.map(o => projectOrder(o, auth.payload.role)));
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
  res.json(projectOrder(order, viewerFromReq(req)));
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
  if (id && /^YB-\d{4}$/.test(id)) {
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
  const newOrder = {
    id,
    customerAccessTokenHash: customerOrderTokenHash(customerAccessToken),
    pickupPin: pin,
    pickupPinIsOrderId: false,
    sessionNumber: body.sessionNumber || currentSession.sessionNumber,
    createdAt: body.createdAt || new Date().toISOString(),
    customer,
    phone,
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
  saveDatabase(db);

  logAction("ORDER_CREATED", customer, newOrder.id, {
    total: newOrder.total,
    pin: newOrder.pickupPin,
    paymentMode: newOrder.paymentMode
  }, req);

  // Notify the kitchen automatically. No WhatsApp redirect for the customer.
  try {
    await notifyOrderCreated(db, newOrder);
  } catch (err) {
    console.warn('[whatsapp] notification skipped:', err.message);
  }

  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(newOrder.id, { type: 'created', order: projectOrder(newOrder, 'customer') });
  }

  res.status(201).json({ ...projectOrder(newOrder, 'checkout'), trackingToken: customerAccessToken });
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
  const lastGpsAt = Date.parse(driverObj.lastLocationUpdate || '');
  if (!Number.isFinite(lastGpsAt) || Date.now() - lastGpsAt > 120000) {
    return res.status(409).json({ success: false, message: "Turn on device location and wait for a live GPS fix before accepting a delivery." });
  }
  const currentDriverId = order.driverId || (order.driver && order.driver.id);
  if (currentDriverId && currentDriverId !== driverObj.id) {
    return res.status(409).json({ success: false, message: "Another rider has already accepted this delivery." });
  }
  if (currentDriverId === driverObj.id) {
    return res.json({ success: true, message: "You already accepted this delivery.", order: projectOrder(order, 'driver') });
  }
  const driverName = driverObj.name || `${driverObj.fname || ''} ${driverObj.lname || ''}`.trim() || driverObj.username || 'YEBS Rider';

  order.driverId = driverObj.id || null;
  order.driverName = driverName;
  order.driverPhone = driverObj.phone || null;
  if (order.status !== 'driver_assigned') order.statusBeforeAssignment = order.status || 'pending';
  order.driver = {
    id: driverObj.id || null,
    name: driverName,
    phone: driverObj.phone || null,
    vehicle: driverObj.vehicle || null,
    photo: driverObj.photo || null,
    currentLocation: Number.isFinite(Number(driverObj.lat)) && Number.isFinite(Number(driverObj.lng))
      ? { lat: Number(driverObj.lat), lng: Number(driverObj.lng) }
      : null
  };
  order.assignedAt = order.assignedAt || new Date().toISOString();
  if (['Received', 'pending', 'kitchen', ''].includes(String(order.status || ''))) {
    order.status = 'driver_assigned';
  }

  saveDatabase(db);
  logAction("ORDER_CLAIMED", driverName, order.id, { driverId: driverObj.id, status: order.status }, req);

  if (typeof pushOrderUpdate === 'function') {
    pushOrderUpdate(order.id, { type: 'assignment', order: projectOrder(order, 'customer') });
  }

  const customerNotice = await sendRecoveryPhone(order.phone,
    `YEBS: Rider ${driverName} accepted your order ${order.id}. Live GPS tracking will start when the rider begins moving.`);
  order.driverNoticeStatus = customerNotice.ok ? 'sent' : 'not-delivered';
  saveDatabase(db);

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
app.post('/api/orders/:id/verify-pin', requireRole('driver', 'admin'), (req, res) => {
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
    order.verifiedByDriver = true;
    order.verifiedAt = new Date().toISOString();
    order.status = 'delivered';
    order.deliveredAt = new Date().toISOString();
    saveDatabase(db);
    logAction("PIN_VERIFIED", req.auth.payload.role === 'admin' ? req.auth.admin.username : (req.auth.driver.name || 'DRIVER'), order.id, { customer: order.customer }, req);
    if (typeof pushOrderUpdate === 'function') {
      pushOrderUpdate(order.id, { type: 'delivered', order: projectOrder(order, 'customer') });
    }
    return res.json({
      success: true,
      message: `Order ID verified ✅ Hand ${order.id} to ${order.customer}.`,
      order: projectOrder(order, req.auth.payload.role === 'admin' ? 'admin' : 'driver')
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
  let releaseMutationLock;
  try {
    releaseMutationLock = await store.acquireMutationLock();
  } catch (error) {
    return res.status(503).json({ success: false, persisted: false, message: `Could not load the latest driver data: ${error.message}` });
  }
  try {
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
    res.json({
      success: true,
      persisted: true,
      message: approved ? `${driver.name} approved and can now log in.` : `${driver.name} has been rejected.`,
      driver: publicDriver(driver)
    });
  } finally {
    await releaseMutationLock();
  }
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
  // Mark notified so next poll stops showing the push banner
  let justApproved = false;
  if (driver.approvalStatus === 'approved' && driver.approvalNotified === false) {
    driver.approvalNotified = true;
    justApproved = true;
    saveDatabase(db);
  }
  res.json({
    success: true,
    approvalStatus: driver.approvalStatus || 'pending',
    justApproved,
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
  const paid = real.filter(o => o.paymentStatus === 'paid');
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
  res.flushHeaders();

  sseClients.set(driverId, res);
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  req.on('close', () => { sseClients.delete(driverId); });
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
  const order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (!hasOrderAccess(order, req)) return res.status(403).json({ success: false, message: 'Order access token required.' });
  res.json({ success: true, order: projectOrder(order, 'customer') });
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
      writable: databaseWritable
    },
    pickupPoint: pickup,
    deliveryFee: Number(db.settings && db.settings.deliveryFee) || 15,
    whatsapp: {
      configured: Boolean(wa.token && wa.phoneId),
      to: wa.to ? wa.to.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1 $2 $3") : null,
      apiVersion: wa.version
    },
    recoveryDelivery: {
      emailConfigured: recoveryEmailSendGridReady || recoveryEmailSmtpReady,
      sendGridConfigured: recoveryEmailSendGridReady,
      smtpConfigured: recoveryEmailSmtpReady,
      twilioConfigured: recoveryPhoneTwilioReady,
      whatsappConfigured: Boolean(wa.token && wa.phoneId),
      adminOwnerLogFallback: true
    },
    momo: {
      payTo: getMomoSettings(db).payTo,
      accountName: getMomoSettings(db).accountName,
      apiConfigured: momoApiConfig().configured,
      networks: listMomoNetworks().map(n => ({ id: n.id, ussd: n.ussd, apiReady: n.apiReady }))
    }
  });
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
      if (ensureSystemAccounts(data)) {
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
