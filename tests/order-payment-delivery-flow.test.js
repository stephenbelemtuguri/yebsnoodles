const bcrypt = require('bcryptjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yebs-order-flow-'));
const databasePath = path.join(tempDir, 'database.json');
const adminPassword = 'test-admin-password-2026';
const driverPassword = 'test-driver-password-2026';
const driverId = 'drv-order-flow-test';
const initialLocation = { lat: 5.5612, lng: -0.2155 };

function receiptImageFor(orderId) {
  return `data:image/jpeg;base64,${Buffer.from(`receipt-${orderId}`).toString('base64')}`;
}

fs.writeFileSync(databasePath, JSON.stringify({
  admins: [{
    id: 'adm-order-flow-test',
    username: 'test-admin',
    password: bcrypt.hashSync(adminPassword, 10),
    name: 'Test Admin',
    role: 'SUPERADMIN',
    sessionEpoch: 0
  }],
  drivers: [{
    id: driverId,
    username: 'test-driver',
    password: bcrypt.hashSync(driverPassword, 10),
    fname: 'Test',
    lname: 'Driver',
    name: 'Test Driver',
    phone: '0241111111',
    email: 'driver@example.test',
    vehicle: 'Motorcycle',
    isActive: true,
    approvalStatus: 'approved',
    approvedAt: new Date().toISOString(),
    approvalNotified: true,
    lat: initialLocation.lat,
    lng: initialLocation.lng,
    speedKmh: 0,
    lastLocationUpdate: new Date().toISOString()
  }],
  orders: [],
  sessions: [{
    id: 1,
    sessionNumber: 1,
    status: 'ACTIVE',
    startedAt: new Date().toISOString(),
    pickupPoint: { name: 'Test Kitchen', ...initialLocation }
  }],
  settings: {
    adminCredentialResetVersion: '',
    momo: { payTo: '0241111111', accountName: 'Test Kitchen' },
    pickup: { name: 'Test Kitchen', ...initialLocation },
    deliveryFee: 15
  },
  menuItems: [{
    id: 'test-meal',
    name: 'Test meal',
    price: 25,
    image: 'test-meal.jpg',
    available: true,
    status: 'available'
  }],
  auditLogs: [],
  payouts: [],
  reviews: [],
  notifications: []
}));

Object.assign(process.env, {
  DB_PATH: databasePath,
  DATABASE_URL: '',
  DATABASE_POOL_URL: '',
  SUPABASE_DB_URL: '',
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  SUPABASE_SERVICE_KEY: '',
  SUPABASE_SECRET_KEY: '',
  ADMIN_USERNAME: '',
  ADMIN_PASSWORD: '',
  ADMIN_CREDENTIAL_RESET_VERSION: '',
  WHATSAPP_TOKEN: '',
  WHATSAPP_PHONE_NUMBER_ID: '',
  WHATSAPP_ACCESS_TOKEN: '',
  WHATSAPP_CLOUD_TOKEN: '',
  WHATSAPP_PHONE_ID: '',
  META_WHATSAPP_TOKEN: '',
  GEMINI_API_KEY: '',
  GOOGLE_GEMINI_API_KEY: '',
  MOMO_SUBSCRIPTION_KEY: '',
  MOMO_API_USER: '',
  MOMO_API_KEY: '',
  MOMO_CALLBACK_HOST: '',
  YEBS_VAPID_PUBLIC_KEY: '',
  YEBS_VAPID_PRIVATE_KEY: '',
  YEBS_VAPID_SUBJECT: ''
});

const { app, start } = require('../server');

describe('customer order to verified delivery flow', () => {
  let adminToken;
  let driverToken;

  beforeAll(async () => {
    await start();

    const adminLogin = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: 'test-admin', password: adminPassword });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.token;

    const driverLogin = await request(app)
      .post('/api/auth/driver/login')
      .send({ username: 'test-driver', password: driverPassword });
    expect(driverLogin.status).toBe(200);
    driverToken = driverLogin.body.token;

    const location = await request(app)
      .post(`/api/drivers/${driverId}/location`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send(initialLocation);
    expect(location.status).toBe(200);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function createDelivery() {
    const response = await request(app)
      .post('/api/orders')
      .send({
        customer: 'Test Customer',
        phone: '0240000000',
        fulfilment: 'Delivery',
        payment: 'MTN Mobile Money',
        location: 'Test delivery address',
        mapPin: { lat: 5.6037, lng: -0.187, name: 'Test delivery address' },
        items: [{ menuId: 'test-meal', name: 'Test meal', price: 25, quantity: 1 }]
      });

    expect(response.status).toBe(201);
    expect(response.body.trackingToken).toBeTruthy();
    return response.body;
  }

  async function submitPaymentProof(order) {
    return request(app)
      .post(`/api/orders/${order.id}/pay/momo`)
      .set('X-Order-Access-Token', order.trackingToken)
      .send({
        transactionRef: `MTN-${order.id.slice(-4)}-${Date.now()}`,
        amount: order.total,
        receiptImage: receiptImageFor(order.id)
      });
  }

  async function createCashDelivery() {
    const response = await request(app)
      .post('/api/orders')
      .send({
        customer: 'Cash Customer',
        phone: '0240000001',
        fulfilment: 'Delivery',
        payment: 'Pay on Delivery (Cash)',
        location: 'Cash delivery address',
        mapPin: { lat: 5.6037, lng: -0.187, name: 'Cash delivery address' },
        items: [{ menuId: 'test-meal', name: 'Test meal', price: 25, quantity: 1 }]
      });
    expect(response.status).toBe(201);
    return response.body;
  }

  test('uses the server menu price and rejects fabricated menu items', async () => {
    const fabricated = await request(app)
      .post('/api/orders')
      .send({
        customer: 'Test Customer',
        phone: '0240000000',
        items: [{ menuId: 'not-on-menu', name: 'Free meal', price: 0, quantity: 1 }]
      });
    expect(fabricated.status).toBe(400);

    const order = await request(app)
      .post('/api/orders')
      .send({
        customer: 'Test Customer',
        phone: '0240000000',
        fulfilment: 'Collection',
        items: [{ menuId: 'test-meal', name: 'Spoofed name', price: 0, quantity: 2 }]
      });
    expect(order.status).toBe(201);
    expect(order.body.items).toMatchObject([{ name: 'Test meal', price: 25, quantity: 2 }]);
    expect(order.body.subtotal).toBe(50);
  });

  test('edits the existing unpaid order with authenticated access', async () => {
    const order = await createDelivery();
    const unauthorized = await request(app)
      .patch(`/api/orders/${order.id}/edit`)
      .send({ customer: 'Test Customer', phone: '0240000000', items: [{ menuId: 'test-meal', quantity: 2 }] });
    expect(unauthorized.status).toBe(403);

    const edited = await request(app)
      .patch(`/api/orders/${order.id}/edit`)
      .set('X-Order-Access-Token', order.trackingToken)
      .send({
        customer: 'Updated Customer',
        phone: '0240000000',
        fulfilment: 'Delivery',
        location: 'Updated delivery address',
        mapPin: { lat: 5.61, lng: -0.19, name: 'Updated delivery address' },
        payment: 'MTN Mobile Money',
        paymentNetwork: 'mtn',
        items: [{ menuId: 'test-meal', price: 0, quantity: 2 }]
      });
    expect(edited.status).toBe(200);
    expect(edited.body.order.id).toBe(order.id);
    expect(edited.body.order.customer).toBe('Updated Customer');
    expect(edited.body.order.items).toMatchObject([{ name: 'Test meal', price: 25, quantity: 2 }]);
    expect(edited.body.order.subtotal).toBe(50);

    const tracking = await request(app)
      .get(`/api/orders/${order.id}/track`)
      .set('X-Order-Access-Token', order.trackingToken);
    expect(tracking.status).toBe(200);
    expect(tracking.body.order.location).toBe('Updated delivery address');
  });

  test('requires both a transaction ID and receipt screenshot for customer proof', async () => {
    const order = await createDelivery();
    const receiptImage = receiptImageFor(order.id);
    const missingReceipt = await request(app)
      .post(`/api/orders/${order.id}/pay/momo`)
      .set('X-Order-Access-Token', order.trackingToken)
      .send({ transactionRef: 'MTN-TEST-123', amount: order.total });
    expect(missingReceipt.status).toBe(400);

    const missingReference = await request(app)
      .post(`/api/orders/${order.id}/receipt`)
      .set('X-Order-Access-Token', order.trackingToken)
      .send({ receiptImage, amount: order.total });
    expect(missingReference.status).toBe(400);
  });

  test('returns the payment reference and keeps it distinct from the MoMo transaction ID', async () => {
    const order = await createDelivery();
    const paymentRequest = await request(app)
      .post(`/api/orders/${order.id}/pay/request`)
      .set('X-Order-Access-Token', order.trackingToken)
      .send({ network: 'mtn', phone: '0241234567' });

    expect(paymentRequest.status).toBe(200);
    expect(paymentRequest.body).toMatchObject({
      success: true,
      requested: false,
      mode: 'ussd',
      reference: order.paymentRef,
      amount: order.total
    });
  });

  test('protects staff notification streams and push subscriptions', async () => {
    const stream = await request(app).get('/api/sse/notifications');
    expect(stream.status).toBe(401);

    const publicKey = await request(app).get('/api/push/public-key');
    expect(publicKey.status).toBe(200);
    expect(publicKey.body).toMatchObject({ configured: false, publicKey: null });

    const unauthorizedSubscription = await request(app)
      .post('/api/push/subscriptions')
      .send({ endpoint: 'https://fcm.googleapis.com/test', keys: { p256dh: 'key', auth: 'auth' } });
    expect(unauthorizedSubscription.status).toBe(401);

    const unconfiguredSubscription = await request(app)
      .post('/api/push/subscriptions')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ endpoint: 'https://fcm.googleapis.com/test', keys: { p256dh: 'key', auth: 'auth' } });
    expect(unconfiguredSubscription.status).toBe(503);
  });

  test('persists new-order alerts for administrators', async () => {
    const order = await createDelivery();
    let notification;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const database = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
      notification = (database.notifications || []).find(item =>
        item.kind === 'staff'
        && item.audienceRole === 'admin'
        && item.entityId === order.id
        && item.title === 'New YEBS order');
      if (notification) break;
      await new Promise(resolve => { setTimeout(resolve, 10); });
    }
    expect(notification).toMatchObject({
      audienceRole: 'admin',
      recipientId: 'adm-order-flow-test',
      entityId: order.id,
      title: 'New YEBS order'
    });
  });

  test('confirms an MTN website payment and advances the order after provider settlement', async () => {
    const envNames = [
      'MOMO_SUBSCRIPTION_KEY', 'MOMO_API_USER', 'MOMO_API_KEY', 'MOMO_CALLBACK_HOST',
      'MTN_MOMO_SUBSCRIPTION_KEY', 'MTN_MOMO_API_USER', 'MTN_MOMO_API_KEY', 'MTN_MOMO_CALLBACK_HOST'
    ];
    const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
    const originalFetch = global.fetch;
    process.env.MTN_MOMO_SUBSCRIPTION_KEY = 'test-subscription-key';
    process.env.MTN_MOMO_API_USER = 'test-api-user';
    process.env.MTN_MOMO_API_KEY = 'test-api-key';
    process.env.MTN_MOMO_CALLBACK_HOST = 'https://yebsnoodles.onrender.com';
    for (const name of ['MOMO_SUBSCRIPTION_KEY', 'MOMO_API_USER', 'MOMO_API_KEY', 'MOMO_CALLBACK_HOST']) {
      delete process.env[name];
    }
    let settlementAmount = '';

    global.fetch = jest.fn(async (url, options = {}) => {
      if (url.endsWith('/collection/token/')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'test-access-token' }) };
      }
      if (url.endsWith('/collection/v1_0/requesttopay')) {
        expect(options.headers['X-Callback-Url']).toBe('https://yebsnoodles.onrender.com/api/payments/momo/callback');
        return { ok: true, status: 202, text: async () => '' };
      }
      if (url.includes('/collection/v1_0/requesttopay/') && options.method === 'GET') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'SUCCESSFUL', amount: settlementAmount }) };
      }
      throw new Error('Unexpected MTN request');
    });

    try {
      const order = await createDelivery();
      settlementAmount = Number(order.total).toFixed(2);
      const prompt = await request(app)
        .post(`/api/orders/${order.id}/pay/request`)
        .set('X-Order-Access-Token', order.trackingToken)
        .send({ network: 'mtn', phone: '0241234567' });

      expect(prompt.status).toBe(200);
      expect(prompt.body).toMatchObject({ requested: true, mode: 'api', status: 'pending' });

      const paymentStatus = await request(app)
        .get(`/api/orders/${order.id}/pay/status`)
        .set('X-Order-Access-Token', order.trackingToken);

      expect(paymentStatus.status).toBe(200);
      expect(paymentStatus.body).toMatchObject({
        paid: true,
        paymentStatus: 'paid',
        order: expect.objectContaining({ paymentVerified: true })
      });

      const health = await request(app)
        .get('/api/admin/provider-health')
        .set('Authorization', 'Bearer ' + adminToken);
      expect(health.body.providers.momo.configured).toBe(true);
    } finally {
      global.fetch = originalFetch;
      for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('sends admin customer messages through YEBS Message Hub and retains failed delivery results', async () => {
    const order = await createDelivery();
    const denied = await request(app)
      .post('/api/admin/messages')
      .send({ orderId: order.id, channel: 'whatsapp', message: 'Your order update.' });
    expect(denied.status).toBe(401);

    const result = await request(app)
      .post('/api/admin/messages')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ orderId: order.id, channel: 'whatsapp', message: 'Your order update.' });
    expect(result.status).toBe(502);
    expect(result.body.success).toBe(false);
    expect(result.body.notification).toMatchObject({ status: 'failed', channel: 'whatsapp' });

    const notifications = await request(app)
      .get('/api/admin/notifications')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(notifications.status).toBe(200);
    expect(notifications.body.notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: result.body.notification.id,
        orderId: order.id,
        status: 'failed',
        actor: 'Test Admin'
      })
    ]));
  });

  test('handles inbound WhatsApp messages once, records the assistant response and provider failure', async () => {
    const body = {
      entry: [{
        changes: [{
          value: {
            messages: [{
              id: 'wamid-yebs-test-inbound',
              from: '233240000000',
              type: 'text',
              text: { body: 'Hello, can you help me?' }
            }]
          }
        }]
      }]
    };
    const received = await request(app).post('/api/whatsapp/webhook').send(body);
    expect(received.status).toBe(200);

    let assistantMessage;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const notifications = await request(app)
        .get('/api/admin/notifications')
        .set('Authorization', 'Bearer ' + adminToken);
      assistantMessage = notifications.body.notifications.find(item => item.providerMessageId === 'wamid-yebs-test-inbound');
      if (assistantMessage && assistantMessage.status !== 'processing') break;
      await new Promise(resolve => { setTimeout(resolve, 10); });
    }
    expect(assistantMessage).toMatchObject({
      kind: 'whatsapp-assistant',
      status: 'failed',
      attempts: 1,
      reply: expect.stringContaining('YEBS support'),
      reason: expect.stringContaining('not configured')
    });

    await request(app).post('/api/whatsapp/webhook').send(body);
    await new Promise(resolve => { setTimeout(resolve, 20); });
    const notifications = await request(app)
      .get('/api/admin/notifications')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(notifications.body.notifications.filter(item => item.providerMessageId === 'wamid-yebs-test-inbound')).toHaveLength(1);
  });

  test('retains duplicate screenshot evidence for admin review without marking payment paid', async () => {
    const firstOrder = await createDelivery();
    const secondOrder = await createDelivery();
    const duplicateImage = receiptImageFor(firstOrder.id);
    const firstProof = await request(app)
      .post(`/api/orders/${firstOrder.id}/pay/momo`)
      .set('X-Order-Access-Token', firstOrder.trackingToken)
      .send({ transactionRef: 'MTN-FIRST-123', amount: firstOrder.total, receiptImage: duplicateImage });
    expect(firstProof.status).toBe(202);

    const duplicateProof = await request(app)
      .post(`/api/orders/${secondOrder.id}/pay/momo`)
      .set('X-Order-Access-Token', secondOrder.trackingToken)
      .send({ transactionRef: 'MTN-SECOND-456', amount: secondOrder.total, receiptImage: duplicateImage });
    expect(duplicateProof.status).toBe(409);
    expect(duplicateProof.body.order.paymentStatus).toBe('review');
    expect(duplicateProof.body.order.paymentVerified).toBe(false);
    expect(duplicateProof.body.order.momoReceipt.image).toBe(duplicateImage);

    const adminOrders = await request(app)
      .get('/api/orders')
      .set('Authorization', 'Bearer ' + adminToken);
    const retainedOrder = adminOrders.body.find(item => item.id === secondOrder.id);
    expect(retainedOrder.momoReceipt.image).toBe(duplicateImage);
    expect(retainedOrder.momoTransactionRef).toBe('MTN-SECOND-456');
  });

  test('holds unverified payment for review, then tracks GPS through PIN-confirmed delivery', async () => {
    const order = await createDelivery();
    const receiptImage = receiptImageFor(order.id);

    const proof = await submitPaymentProof(order);
    expect(proof.status).toBe(202);
    expect(proof.body.needsReview).toBe(true);
    expect(proof.body.order.paymentStatus).toBe('review');
    expect(proof.body.order.paymentVerified).toBe(false);
    expect(proof.body.order.momoReceipt).toMatchObject({
      image: receiptImage,
      transactionRef: proof.body.order.momoTransactionRef,
      verified: false
    });

    const adminOrders = await request(app)
      .get('/api/orders')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(adminOrders.status).toBe(200);
    expect(adminOrders.body.find(item => item.id === order.id).momoReceipt).toMatchObject({
      image: receiptImage,
      transactionRef: proof.body.order.momoTransactionRef,
      verified: false
    });
    expect(adminOrders.body.find(item => item.id === order.id).momoAmount).toBe(order.total);

    const cannotEditAfterPayment = await request(app)
      .patch(`/api/orders/${order.id}/edit`)
      .set('X-Order-Access-Token', order.trackingToken)
      .send({
        customer: 'Test Customer',
        phone: '0240000000',
        items: [{ menuId: 'test-meal', quantity: 2 }]
      });
    expect(cannotEditAfterPayment.status).toBe(409);

    const customerCannotApprove = await request(app)
      .post(`/api/orders/${order.id}/pay/review`)
      .set('X-Order-Access-Token', order.trackingToken)
      .send({ paid: true });
    expect(customerCannotApprove.status).toBe(401);

    const approvedPayment = await request(app)
      .post(`/api/orders/${order.id}/pay/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paid: true, reason: 'Verified in integration test' });
    expect(approvedPayment.status).toBe(200);
    expect(approvedPayment.body.persisted).toBe(true);
    expect(approvedPayment.body.order.paymentStatus).toBe('paid');
    expect(approvedPayment.body.order.paymentVerified).toBe(true);

    const claim = await request(app)
      .post(`/api/orders/${order.id}/claim`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({});
    expect(claim.status).toBe(200);
    expect(claim.body.order.driver).toMatchObject({
      id: driverId,
      name: 'Test Driver',
      phone: '0241111111'
    });

    const liveLocation = { lat: 5.565, lng: -0.21, speedKmh: 18 };
    const gpsUpdate = await request(app)
      .post(`/api/drivers/${driverId}/location`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send(liveLocation);
    expect(gpsUpdate.status).toBe(200);

    const tracking = await request(app)
      .get(`/api/orders/${order.id}/track`)
      .set('X-Order-Access-Token', order.trackingToken);
    expect(tracking.status).toBe(200);
    expect(tracking.body.order.status).toBe('enroute');
    expect(tracking.body.order.driver.currentLocation).toMatchObject({
      lat: liveLocation.lat,
      lng: liveLocation.lng
    });
    expect(tracking.body.order.phone).toBeUndefined();

    const arrived = await request(app)
      .patch(`/api/orders/${order.id}/status`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ status: 'arrived' });
    expect(arrived.status).toBe(200);

    const delivered = await request(app)
      .post(`/api/orders/${order.id}/verify-pin`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ pin: order.pickupPin });
    expect(delivered.status).toBe(200);
    expect(delivered.body.order.status).toBe('delivered');
    expect(delivered.body.order.paymentVerified).toBe(true);

    const earnings = await request(app)
      .get(`/api/drivers/${driverId}/earnings`)
      .set('Authorization', 'Bearer ' + driverToken);
    expect(earnings.status).toBe(200);

    const excessivePayout = await request(app)
      .post(`/api/drivers/${driverId}/payouts`)
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ amount: Number(earnings.body.pendingPayout) + 1 });
    expect(excessivePayout.status).toBe(400);

    const payout = await request(app)
      .post(`/api/drivers/${driverId}/payouts`)
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ amount: order.deliveryFee });
    expect(payout.status).toBe(201);
    const duplicateRequest = await request(app)
      .post(`/api/drivers/${driverId}/payouts`)
      .set('Authorization', 'Bearer ' + driverToken)
      .send({});
    expect(duplicateRequest.status).toBe(200);
    expect(duplicateRequest.body.payout.id).toBe(payout.body.payout.id);

    const paidPayout = await request(app)
      .post(`/api/admin/payouts/${payout.body.payout.id}/pay`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({});
    expect(paidPayout.status).toBe(200);
    const duplicatePayment = await request(app)
      .post(`/api/admin/payouts/${payout.body.payout.id}/pay`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({});
    expect(duplicatePayment.status).toBe(409);

    const finalTracking = await request(app)
      .get(`/api/orders/${order.id}/track`)
      .set('X-Order-Access-Token', order.trackingToken);
    expect(finalTracking.body.order.status).toBe('delivered');
  });

  test('records cash received, change, and a synced cashier receipt for overpayment', async () => {
    const order = await createCashDelivery();
    const claim = await request(app)
      .post(`/api/orders/${order.id}/claim`)
      .set('Authorization', 'Bearer ' + driverToken)
      .send({});
    expect(claim.status).toBe(200);
    const assignedLocation = claim.body.order.driver.currentLocation || initialLocation;
    const gps = await request(app)
      .post(`/api/drivers/${driverId}/location`)
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ lat: Number(assignedLocation.lat) + 0.01, lng: Number(assignedLocation.lng), speedKmh: 18 });
    expect(gps.status).toBe(200);
    const arrived = await request(app)
      .patch(`/api/orders/${order.id}/status`)
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ status: 'arrived' });
    expect(arrived.status).toBe(200);

    const received = Number(order.total) + 20;
    const cash = await request(app)
      .post(`/api/orders/${order.id}/pay/cash`)
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ amount: received });
    expect(cash.status).toBe(200);
    expect(cash.body.success).toBe(true);
    expect(cash.body.changeGiven).toBe(20);
    expect(cash.body.receipt).toMatchObject({
      orderId: order.id,
      expectedAmount: order.total,
      receivedAmount: received,
      changeGiven: 20
    });

    const adminOrders = await request(app)
      .get('/api/orders')
      .set('Authorization', 'Bearer ' + adminToken);
    const adminOrder = adminOrders.body.find(item => item.id === order.id);
    expect(adminOrder.paymentStatus).toBe('paid');
    expect(adminOrder.changeGiven).toBe(20);
    expect(adminOrder.cashReceived).toBe(received);
    expect(adminOrder.momoAmount).toBeNull();
    expect(adminOrder.cashReceipt.receiptNumber).toBe(cash.body.receipt.receiptNumber);

    const activeShift = await request(app)
      .get('/api/drivers/me/cashier')
      .set('Authorization', 'Bearer ' + driverToken);
    expect(activeShift.status).toBe(200);
    expect(activeShift.body.active).toMatchObject({
      orderCount: 1,
      totalDue: order.total,
      cashReceived: received,
      changeGiven: 20,
      cashToRemit: order.total,
      variance: null
    });

    const closedShift = await request(app)
      .post('/api/drivers/me/cashier/close')
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ cashHandedOver: Number(order.total) - 1 });
    expect(closedShift.status).toBe(200);
    expect(closedShift.body.reconciliation.variance).toBe(-1);

    const shortClose = await request(app)
      .post('/api/drivers/me/cashier/close')
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ cashHandedOver: order.total });
    expect(shortClose.status).toBe(409);

    const dailyReport = await request(app)
      .get(`/api/reports/daily?date=${new Date().toISOString().slice(0, 10)}`)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(dailyReport.status).toBe(200);
    expect(dailyReport.body.report.cashByDriver).toEqual(expect.arrayContaining([
      expect.objectContaining({
        driverId,
        cashReceived: received,
        changeGiven: 20,
        cashToRemit: order.total,
        cashHandedOver: Number(order.total) - 1,
        variance: -1
      })
    ]));
    expect(dailyReport.body.report.cashReconciliations).toEqual(expect.arrayContaining([
      expect.objectContaining({ driverId, cashToRemit: order.total, cashHandedOver: Number(order.total) - 1, variance: -1 })
    ]));
  });

  test('records an underpayment once for reconciliation and blocks duplicate cash collection', async () => {
    const order = await createCashDelivery();
    const claim = await request(app)
      .post(`/api/orders/${order.id}/claim`)
      .set('Authorization', 'Bearer ' + driverToken)
      .send({});
    expect(claim.status).toBe(200);
    const startingPoint = claim.body.order.driver.currentLocation || initialLocation;
    const gps = await request(app)
      .post(`/api/drivers/${driverId}/location`)
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ lat: Number(startingPoint.lat) + 0.01, lng: Number(startingPoint.lng), speedKmh: 18 });
    expect(gps.status).toBe(200);
    const arrived = await request(app)
      .patch(`/api/orders/${order.id}/status`)
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ status: 'arrived' });
    expect(arrived.status).toBe(200);

    const shortAmount = Number(order.total) - 5;
    const shortPayment = await request(app)
      .post(`/api/orders/${order.id}/pay/cash`)
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ amount: shortAmount });
    expect(shortPayment.status).toBe(202);
    expect(shortPayment.body.needsReview).toBe(true);
    expect(shortPayment.body.receipt).toMatchObject({
      expectedAmount: order.total,
      receivedAmount: shortAmount,
      changeGiven: 0
    });

    const duplicate = await request(app)
      .post(`/api/orders/${order.id}/pay/cash`)
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ amount: order.total });
    expect(duplicate.status).toBe(409);

    const shift = await request(app)
      .get('/api/drivers/me/cashier')
      .set('Authorization', 'Bearer ' + driverToken);
    expect(shift.body.active.cashReceived).toBe(shortAmount);
    const closed = await request(app)
      .post('/api/drivers/me/cashier/close')
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ cashHandedOver: shortAmount });
    expect(closed.status).toBe(200);
    expect(closed.body.reconciliation.variance).toBe(0);
  });

  test('requests cancellation and approves a refund after the fixed fee', async () => {
    const order = await createDelivery();
    const proof = await submitPaymentProof(order);
    expect(proof.status).toBe(202);

    const paid = await request(app)
      .post(`/api/orders/${order.id}/pay/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paid: true, reason: 'Verified in integration test' });
    expect(paid.status).toBe(200);

    const cancellation = await request(app)
      .post(`/api/orders/${order.id}/cancellation`)
      .set('X-Order-Access-Token', order.trackingToken)
      .send({ phone: '0240000000', reason: 'Customer changed their mind' });
    expect(cancellation.status).toBe(202);
    expect(cancellation.body.order.refund).toMatchObject({
      status: 'awaiting_cancellation',
      fee: 5,
      amount: Number((order.total - 5).toFixed(2))
    });

    const cancellationApproval = await request(app)
      .post(`/api/orders/${order.id}/cancellation/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true, reason: 'Approved in integration test' });
    expect(cancellationApproval.status).toBe(200);
    expect(cancellationApproval.body.order.status).toBe('cancelled');
    expect(cancellationApproval.body.order.refund.status).toBe('pending');

    const refundApproval = await request(app)
      .post(`/api/orders/${order.id}/refund/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true, reason: 'Approved in integration test' });
    expect(refundApproval.status).toBe(200);
    expect(refundApproval.body.order.refund).toMatchObject({
      status: 'approved',
      fee: 5,
      amount: Number((order.total - 5).toFixed(2))
    });
  });
});
