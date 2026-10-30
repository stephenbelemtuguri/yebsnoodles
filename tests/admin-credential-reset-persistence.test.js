const bcrypt = require('bcryptjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

describe('administrator credential reset persistence', () => {
  const envKeys = [
    'DB_PATH',
    'ADMIN_USERNAME',
    'ADMIN_PASSWORD',
    'ADMIN_CREDENTIAL_RESET_VERSION',
    'DATABASE_URL',
    'DATABASE_POOL_URL',
    'SUPABASE_DB_URL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_KEY',
    'SUPABASE_SECRET_KEY'
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

  test('does not finish startup when the configured credential reset cannot be saved', async () => {
    process.env.ADMIN_USERNAME = 'recovered-admin';
    process.env.ADMIN_PASSWORD = 'new-private-test-password';
    process.env.ADMIN_CREDENTIAL_RESET_VERSION = 'reset-test-version';
    process.env.DATABASE_URL = '';
    process.env.DATABASE_POOL_URL = '';
    process.env.SUPABASE_DB_URL = '';
    process.env.SUPABASE_URL = 'https://storage.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.SUPABASE_SERVICE_KEY = '';
    process.env.SUPABASE_SECRET_KEY = '';

    jest.resetModules();
    const data = {
      admins: [{
        id: 'adm-existing',
        username: 'recovered-admin',
        password: bcrypt.hashSync('old-admin-password', 10),
        role: 'SUPERADMIN',
        sessionEpoch: 1
      }],
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
    jest.spyOn(store, 'set').mockResolvedValue({
      ok: false,
      mode: 'supabase',
      error: 'write denied'
    });

    const { start } = require('../server');

    await expect(start()).rejects.toThrow('Failed to persist startup account changes: write denied');
    expect(store.set).toHaveBeenCalledWith(data);
  });

  test('verifies the reset hash against the durable state before startup completes', async () => {
    process.env.ADMIN_USERNAME = 'verified-admin';
    process.env.ADMIN_PASSWORD = 'new-private-test-password';
    process.env.ADMIN_CREDENTIAL_RESET_VERSION = 'verified-reset-version';
    process.env.DATABASE_URL = '';
    process.env.DATABASE_POOL_URL = '';
    process.env.SUPABASE_DB_URL = '';
    process.env.SUPABASE_URL = 'https://storage.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.SUPABASE_SERVICE_KEY = '';
    process.env.SUPABASE_SECRET_KEY = '';

    jest.resetModules();
    const data = {
      admins: [{
        id: 'adm-existing',
        username: 'verified-admin',
        password: bcrypt.hashSync('old-admin-password', 10),
        role: 'SUPERADMIN',
        sessionEpoch: 1
      }],
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
    jest.spyOn(store, 'set').mockResolvedValue({ ok: true, mode: 'supabase' });
    const refresh = jest.spyOn(store, 'refresh').mockResolvedValue(data);
    jest.spyOn(store, 'canPersist').mockReturnValue(true);

    const { start } = require('../server');
    await start();

    expect(refresh).toHaveBeenCalledWith(true);
    expect(data.settings.adminCredentialResetVersion).toBe('verified-reset-version');
    expect(bcrypt.compareSync('new-private-test-password', data.admins[0].password)).toBe(true);
  });

  test('migrates a legacy per-deploy marker without changing the existing admin password', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yebs-reset-marker-migration-'));
    const databasePath = path.join(tempDir, 'database.json');
    const currentPassword = 'gui-changed-admin-password';
    const configuredPassword = 'configured-render-password';

    process.env.DB_PATH = databasePath;
    process.env.ADMIN_USERNAME = 'migration-admin';
    process.env.ADMIN_PASSWORD = configuredPassword;
    process.env.ADMIN_CREDENTIAL_RESET_VERSION = 'intentional-reset-marker';
    process.env.DATABASE_URL = '';
    process.env.DATABASE_POOL_URL = '';
    process.env.SUPABASE_DB_URL = '';
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    process.env.SUPABASE_SERVICE_KEY = '';
    process.env.SUPABASE_SECRET_KEY = '';

    fs.writeFileSync(databasePath, JSON.stringify({
      admins: [{
        id: 'adm-migration',
        username: 'migration-admin',
        password: bcrypt.hashSync(currentPassword, 10),
        name: 'Migration administrator',
        role: 'SUPERADMIN',
        sessionEpoch: 5
      }],
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
        adminCredentialResetVersion: 'render-deploy-build-legacy-marker',
        momo: { payTo: '0000000000', accountName: 'Test' },
        pickup: { name: 'Test', address: 'Test', lat: 0, lng: 0 },
        deliveryFee: 15
      }
    }));

    try {
      jest.resetModules();
      const { app, start } = require('../server');
      await start();

      const state = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
      expect(state.settings.adminCredentialResetVersion).toBe('intentional-reset-marker');
      expect(bcrypt.compareSync(currentPassword, state.admins[0].password)).toBe(true);
      expect(bcrypt.compareSync(configuredPassword, state.admins[0].password)).toBe(false);

      const login = await request(app)
        .post('/api/auth/admin/login')
        .send({ username: 'migration-admin', password: currentPassword });
      expect(login.status).toBe(200);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns an error and restores the active credentials when a GUI update is not saved', async () => {
    process.env.ADMIN_USERNAME = 'update-admin';
    process.env.ADMIN_PASSWORD = 'new-private-test-password';
    process.env.ADMIN_CREDENTIAL_RESET_VERSION = 'already-applied-version';
    process.env.DATABASE_URL = '';
    process.env.DATABASE_POOL_URL = '';
    process.env.SUPABASE_DB_URL = '';
    process.env.SUPABASE_URL = 'https://storage.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.SUPABASE_SERVICE_KEY = '';
    process.env.SUPABASE_SECRET_KEY = '';

    jest.resetModules();
    const oldPassword = 'old-admin-password';
    const data = {
      admins: [{
        id: 'adm-existing',
        username: 'update-admin',
        password: bcrypt.hashSync(oldPassword, 10),
        role: 'SUPERADMIN',
        sessionEpoch: 4
      }],
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
        adminCredentialResetVersion: 'already-applied-version',
        momo: { payTo: '0000000000', accountName: 'Test' },
        pickup: { name: 'Test', address: 'Test', lat: 0, lng: 0 },
        deliveryFee: 15
      }
    };
    const store = require('../src/data/store');
    jest.spyOn(store, 'init').mockResolvedValue(data);
    jest.spyOn(store, 'get').mockReturnValue(data);
    const set = jest.spyOn(store, 'set').mockResolvedValue({ ok: true, mode: 'supabase' });
    const { app, start } = require('../server');
    await start();

    const login = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: 'update-admin', password: oldPassword });
    expect(login.status).toBe(200);
    const auditLogCount = data.auditLogs.length;

    set.mockResolvedValue({ ok: false, mode: 'supabase', error: 'write denied' });
    const update = await request(app)
      .post('/api/admin/settings/credentials')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({
        currentPassword: oldPassword,
        newUsername: 'renamed-admin',
        newPassword: 'new-gui-admin-password'
      });

    expect(update.status).toBe(503);
    expect(update.body.success).toBe(false);
    expect(data.admins[0]).toMatchObject({
      username: 'update-admin',
      sessionEpoch: 4
    });
    expect(data.auditLogs).toHaveLength(auditLogCount);
    expect(bcrypt.compareSync(oldPassword, data.admins[0].password)).toBe(true);
    expect(bcrypt.compareSync('new-gui-admin-password', data.admins[0].password)).toBe(false);
  });
});
