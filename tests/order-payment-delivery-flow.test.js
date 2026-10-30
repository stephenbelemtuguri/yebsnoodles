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
  menuItems: [],
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
  WHATSAPP_PHONE_NUMBER_ID: ''
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
        items: [{ name: 'Test meal', price: 25, quantity: 1 }]
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
        amount: order.total
      });
  }

  test('holds unverified payment for review, then tracks GPS through PIN-confirmed delivery', async () => {
    const order = await createDelivery();

    const proof = await submitPaymentProof(order);
    expect(proof.status).toBe(202);
    expect(proof.body.needsReview).toBe(true);
    expect(proof.body.order.paymentStatus).toBe('review');
    expect(proof.body.order.paymentVerified).toBe(false);

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

    const finalTracking = await request(app)
      .get(`/api/orders/${order.id}/track`)
      .set('X-Order-Access-Token', order.trackingToken);
    expect(finalTracking.body.order.status).toBe('delivered');
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
