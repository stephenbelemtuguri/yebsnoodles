const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yebs-momo-bridge-'));
const databasePath = path.join(tempDir, 'database.json');
process.env.DB_PATH = databasePath;
process.env.DATABASE_URL = '';
process.env.DATABASE_POOL_URL = '';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.ADMIN_USERNAME = '';
process.env.ADMIN_PASSWORD = '';
process.env.MOMO_SMS_INGEST_TOKEN = 'a'.repeat(64);
process.env.MOMO_SMS_ALLOWED_SENDERS = 'MTN, 12345';

fs.writeFileSync(databasePath, JSON.stringify({
  admins: [],
  drivers: [],
  orders: [],
  sessions: [],
  settings: { momo: {}, pickup: {}, deliveryFee: 15 },
  menuItems: [{
    id: 'test-meal',
    name: 'Test meal',
    price: 10,
    available: true,
    status: 'available'
  }],
  auditLogs: [],
  payouts: [],
  reviews: [],
  notifications: []
}));

const { app, start } = require('../server');

describe('MoMo SMS ingestion bridge', () => {
  let order;
  let trackingToken;
  const deviceId = 'test-device';
  const sender = 'MTN';
  const sms = 'You have received GHS 10.00. Transaction ID: MTN-1234567';

  beforeAll(async () => {
    await start();
    const response = await request(app).post('/api/orders').send({
      customer: 'Bridge Test',
      phone: '0240000000',
      fulfilment: 'Collection',
      payment: 'MTN Mobile Money',
      items: [{ menuId: 'test-meal', name: 'Test meal', price: 10, quantity: 1 }]
    });
    expect(response.status).toBe(201);
    order = response.body;
    trackingToken = order.trackingToken;
    expect(trackingToken).toBeTruthy();
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function ingest(overrides = {}) {
    return request(app)
      .post('/api/payments/momo/sms/ingest')
      .set('Authorization', `Bearer ${process.env.MOMO_SMS_INGEST_TOKEN}`)
      .send({
        deviceId,
        messageId: 'message-001',
        sender,
        sms,
        ...overrides
      });
  }

  test('rejects invalid bridge credentials and sender IDs', async () => {
    const unauthorized = await request(app)
      .post('/api/payments/momo/sms/ingest')
      .set('Authorization', 'Bearer wrong-token')
      .send({ deviceId, messageId: 'unauthorized', sender, sms });
    expect(unauthorized.status).toBe(401);

    const forbidden = await ingest({ messageId: 'forbidden', sender: 'customer-phone' });
    expect(forbidden.status).toBe(403);
  });

  test('restricts order lookup and updates to authorized roles or the customer token', async () => {
    const publicList = await request(app).get('/api/orders');
    expect(publicList.status).toBe(401);

    const privateOrder = await request(app).get(`/api/orders/${order.id}`);
    expect(privateOrder.status).toBe(403);

    const unauthorizedEdit = await request(app)
      .patch(`/api/orders/${order.id}/edit`)
      .send({ notes: 'unauthorized' });
    expect(unauthorizedEdit.status).toBe(403);

    const customerOrder = await request(app)
      .get(`/api/orders/${order.id}/track`)
      .set('X-Order-Access-Token', trackingToken);
    expect(customerOrder.status).toBe(200);
    expect(customerOrder.body.order.phone).toBeUndefined();

    const unauthenticatedPayment = await request(app)
      .post(`/api/orders/${order.id}/pay/momo`)
      .send({ transactionRef: 'MTN-TEST-1', amount: 10 });
    expect(unauthenticatedPayment.status).toBe(403);
  });

  test('customer-supplied payment proof is not treated as provider confirmation', async () => {
    const proof = await request(app)
      .post(`/api/orders/${order.id}/pay/momo`)
      .set('X-Order-Access-Token', trackingToken)
      .send({
        transactionRef: 'MTN-TEST-1',
        amount: 10,
        receiptImage: 'data:image/jpeg;base64,/9j/2Q=='
      });
    expect(proof.status).toBe(202);
    expect(proof.body.needsReview).toBe(true);
    expect(proof.body.order.paymentVerified).toBe(false);
  });

  test('requires stable IDs and an SMS transaction reference', async () => {
    const missingIds = await ingest({ messageId: '' });
    expect(missingIds.status).toBe(400);

    const missingReference = await ingest({
      messageId: 'missing-reference',
      sms: 'You have received GHS 10.00.'
    });
    expect(missingReference.status).toBe(400);
  });

  test('flags SMS matches for verification and deduplicates retry deliveries', async () => {
    const accepted = await ingest();
    expect(accepted.status).toBe(202);
    expect(accepted.body.success).toBe(false);
    expect(accepted.body.needsReview).toBe(true);
    expect(accepted.body.terminal).toBe(true);
    expect(accepted.body.order.id).toBe(order.id);
    expect(accepted.body.order.paymentStatus).toBe('review');
    expect(accepted.body.order.paymentVerified).toBe(false);

    const duplicate = await ingest();
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);
    expect(duplicate.body.order.paymentStatus).toBe('review');
  });

  test('keeps unmatched messages retryable without confirming payment', async () => {
    const unmatched = await ingest({
      deviceId: 'other-device',
      messageId: 'unmatched',
      sms: 'You have received GHS 999.00. Transaction ID: MTN-7654321'
    });
    expect(unmatched.status).toBe(404);
    expect(unmatched.body.retryable).toBe(true);
  });
});
