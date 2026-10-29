const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yebs-momo-bridge-'));
process.env.DB_PATH = path.join(tempDir, 'database.json');
process.env.DATABASE_URL = '';
process.env.DATABASE_POOL_URL = '';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.MOMO_SMS_INGEST_TOKEN = 'a'.repeat(64);
process.env.MOMO_SMS_ALLOWED_SENDERS = 'MTN, 12345';

const { app, start } = require('../server');

describe('MoMo SMS ingestion bridge', () => {
  let order;
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
      items: [{ name: 'Test meal', price: 10, quantity: 1 }]
    });
    expect(response.status).toBe(201);
    order = response.body;
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

  test('requires stable IDs and an SMS transaction reference', async () => {
    const missingIds = await ingest({ messageId: '' });
    expect(missingIds.status).toBe(400);

    const missingReference = await ingest({
      messageId: 'missing-reference',
      sms: 'You have received GHS 10.00.'
    });
    expect(missingReference.status).toBe(400);
  });

  test('verifies a matching order and deduplicates retry deliveries', async () => {
    const accepted = await ingest();
    expect(accepted.status).toBe(200);
    expect(accepted.body.success).toBe(true);
    expect(accepted.body.terminal).toBe(true);
    expect(accepted.body.order.id).toBe(order.id);

    const duplicate = await ingest();
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);
    expect(duplicate.body.order.paymentStatus).toBe('paid');
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
