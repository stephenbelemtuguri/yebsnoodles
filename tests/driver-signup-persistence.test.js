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
      admins: [],
      drivers: [],
      orders: [],
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
    jest.spyOn(store, 'acquireMutationLock').mockResolvedValue(async () => {});
    jest.spyOn(store, 'canPersist').mockReturnValue(true);
    jest.spyOn(store, 'flush').mockResolvedValue();
    const set = jest.spyOn(store, 'set').mockResolvedValue({ ok: true, mode: 'supabase' });
    const { app, start } = require('../server');
    await start();
    return { app, data, set };
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
    const { app, data, set } = await createApp();
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
    const { app, data, set } = await createApp();

    const response = await request(app)
      .post('/api/auth/driver/signup')
      .send(signupPayload());

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      success: true,
      pending: true,
      driverId: expect.any(String),
      username: expect.any(String)
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(data.drivers).toHaveLength(1);
    expect(data.drivers[0].approvalStatus).toBe('pending');
  });
});
