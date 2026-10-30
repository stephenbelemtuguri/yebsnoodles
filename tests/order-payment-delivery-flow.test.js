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
  MOMO_SUBSCRIPTION_KEY: '',
  MOMO_API_USER: '',
  MOMO_API_KEY: '',
  MOMO_CALLBACK_HOST: ''
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

    const excessivePayout = await request(app)
      .post(`/api/drivers/${driverId}/payouts`)
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ amount: Number(order.deliveryFee) + 1 });
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
