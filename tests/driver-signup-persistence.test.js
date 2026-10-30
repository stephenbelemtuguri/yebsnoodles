const bcrypt = require('bcryptjs');
const request = require('supertest');

describe('driver signup persistence', () => {
  const envKeys = [
    'ADMIN_USERNAME',
    'ADMIN_PASSWORD',
    'DATABASE_URL',
    'DATABASE_POOL_URL',
    'SUPABASE_DB_URL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'YEBS_AUTH_SECRET'
  ];
  const originalEnv = {};

  beforeAll(() => {
    envKeys.forEach(key => { originalEnv[key] = process.env[key]; });
  });

  afterEach(() => {
    jest.resetModules();
    envKeys.forEach(key => {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    });
  });

  async function createApp() {
    process.env.ADMIN_USERNAME = '';
    process.env.ADMIN_PASSWORD = '';
    process.env.DATABASE_URL = '';
    process.env.DATABASE_POOL_URL = '';
    process.env.SUPABASE_DB_URL = '';
    process.env.SUPABASE_URL = 'https://storage.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.YEBS_AUTH_SECRET = 'driver-signup-test-secret';

    jest.resetModules();
    const data = {
      admins: [{
        id: 'adm-driver-signup-test',
        username: 'test-admin',
        password: bcrypt.hashSync('test-admin-password', 10),
        name: 'Test Admin',
        role: 'SUPERADMIN',
        sessionEpoch: 0
      }],
      drivers: [],
      orders: [{
        id: 'YB-7319',
        customer: 'Test Customer',
        total: 25,
        status: 'pending',
        paymentStatus: 'review',
        paymentVerified: false
      }],
      sessions: [],
      auditLogs: [],
      menuItems: [],
      payouts: [],
      reviews: [],
      notifications: [],
      recoveryCodes: [],
      settings: {
        momo: { payTo: '0000000000', accountName: 'Test' },
        pickup: { name: 'Test', address: 'Test', lat: 0, lng: 0 },
        deliveryFee: 15
      }
    };
    const store = require('../src/data/store');
    jest.spyOn(store, 'init').mockResolvedValue(data);
    jest.spyOn(store, 'get').mockReturnValue(data);
    jest.spyOn(store, 'refresh').mockResolvedValue(data);
    const acquireMutationLock = jest.spyOn(store, 'acquireMutationLock').mockResolvedValue(async () => {});
    jest.spyOn(store, 'canPersist').mockReturnValue(true);
    jest.spyOn(store, 'flush').mockResolvedValue();
    const set = jest.spyOn(store, 'set').mockResolvedValue({ ok: true, mode: 'supabase' });
    const { app, start } = require('../server');
    await start();
    return { app, data, set, acquireMutationLock };
  }

  function signupPayload() {
    return {
      fname: 'Test',
      lname: 'Rider',
      phone: '0550000001',
      email: 'rider@example.test',
      password: 'valid-test-password',
      vehicle: 'Bicycle',
      photo: 'data:image/jpeg;base64,dGVzdA=='
    };
  }

  test('does not report signup success when the database write fails', async () => {
    const { app, data, set, acquireMutationLock } = await createApp();
    set.mockResolvedValue({ ok: false, mode: 'supabase', error: 'write denied' });

    const response = await request(app)
      .post('/api/auth/driver/signup')
      .send(signupPayload());

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toContain('NOT saved permanently');
    expect(data.drivers).toHaveLength(0);
    expect(data.auditLogs).toHaveLength(0);
  });

  test('returns a pending application only after the database write succeeds', async () => {
    const { app, data, set, acquireMutationLock } = await createApp();

    const response = await request(app)
      .post('/api/auth/driver/signup')
      .send(signupPayload());

    expect(response.status).toBe(201);
    expect(acquireMutationLock).toHaveBeenCalledTimes(1);
    expect(response.body).toMatchObject({
      success: true,
      pending: true,
      driverId: expect.any(String),
      username: expect.any(String)
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(data.drivers).toHaveLength(1);
    expect(data.drivers[0].approvalStatus).toBe('pending');

    const login = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: 'test-admin', password: 'test-admin-password' });
    expect(login.status).toBe(200);
    const token = login.body.token;

    const roster = await request(app)
      .get('/api/admin/drivers')
      .set('Authorization', `Bearer ${token}`);
    expect(roster.status).toBe(200);
    expect(roster.body).toHaveLength(1);
    expect(roster.body[0]).toMatchObject({
      id: response.body.driverId,
      approvalStatus: 'pending',
      email: 'rider@example.test'
    });
    expect(roster.body[0]).not.toHaveProperty('password');

    acquireMutationLock.mockClear();
    const approval = await request(app)
      .post('/api/auth/driver/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({ driverId: response.body.driverId, approved: true });
    expect(approval.status).toBe(200);
    expect(acquireMutationLock).toHaveBeenCalledTimes(1);
    expect(approval.body).toMatchObject({ success: true, persisted: true });
    expect(data.drivers[0]).toMatchObject({ approvalStatus: 'approved', isActive: true });

    const driverLogin = await request(app)
      .post('/api/auth/driver/login')
      .send({ username: response.body.username, password: signupPayload().password });
    expect(driverLogin.status).toBe(200);
    expect(driverLogin.body.success).toBe(true);
  });

  test('does not confirm driver approval when the database write fails', async () => {
    const { app, set, acquireMutationLock } = await createApp();
    const signup = await request(app)
      .post('/api/auth/driver/signup')
      .send(signupPayload());
    const login = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: 'test-admin', password: 'test-admin-password' });
    expect(login.status).toBe(200);

    set.mockResolvedValue({ ok: false, mode: 'supabase', error: 'write denied' });
    acquireMutationLock.mockClear();
    const approval = await request(app)
      .post('/api/auth/driver/approve')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ driverId: signup.body.driverId, approved: true });

    expect(approval.status).toBe(503);
    expect(acquireMutationLock).toHaveBeenCalledTimes(1);
    expect(approval.body).toMatchObject({ success: false, persisted: false });
    expect(approval.body.message).toContain('NOT saved permanently');
  });

  test('does not report payment approval when the database write fails', async () => {
    const { app, data, set, acquireMutationLock } = await createApp();
    const login = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: 'test-admin', password: 'test-admin-password' });
    expect(login.status).toBe(200);

    set.mockResolvedValue({ ok: false, mode: 'supabase', error: 'write denied' });
    acquireMutationLock.mockClear();
    const approval = await request(app)
      .post('/api/orders/YB-7319/pay/review')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ paid: true, reason: 'Verified in test' });

    expect(approval.status).toBe(503);
    expect(acquireMutationLock).toHaveBeenCalledTimes(1);
    expect(approval.body).toMatchObject({ success: false, persisted: false });
    expect(data.orders[0]).toMatchObject({
      paymentStatus: 'review',
      paymentVerified: false
    });
  });
});
