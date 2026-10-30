const bcrypt = require('bcryptjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yebs-admin-recovery-'));
const databasePath = path.join(tempDir, 'database.json');
const envKeys = [
  'DB_PATH',
  'DATABASE_URL',
  'DATABASE_POOL_URL',
  'SUPABASE_DB_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_SECRET_KEY',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'ADMIN_CREDENTIAL_RESET_VERSION',
  'ADMIN_EMAIL',
  'ADMIN_RECOVERY_PHONE',
  'SENDGRID_API_KEY',
  'SENDGRID_FROM_EMAIL',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'RECOVERY_SHOW_CODE'
];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const oldPassword = 'old-private-admin-password';
const newPassword = 'new-private-admin-password';

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
  ADMIN_EMAIL: '',
  ADMIN_RECOVERY_PHONE: '',
  SENDGRID_API_KEY: '',
  SENDGRID_FROM_EMAIL: '',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  TWILIO_FROM_NUMBER: '',
  WHATSAPP_TOKEN: '',
  WHATSAPP_PHONE_NUMBER_ID: '',
  RECOVERY_SHOW_CODE: '0'
});

fs.writeFileSync(databasePath, JSON.stringify({
  admins: [{
    id: 'adm-recovery-test',
    username: 'test-admin',
    password: bcrypt.hashSync(oldPassword, 10),
    email: 'admin@example.test',
    recoveryPhone: '0240000000',
    name: 'Test Admin',
    role: 'SUPERADMIN',
    sessionEpoch: 0
  }],
  drivers: [],
  orders: [],
  sessions: [],
  settings: { momo: {}, pickup: {}, deliveryFee: 15 },
  auditLogs: [],
  menuItems: [],
  payouts: [],
  reviews: [],
  notifications: [],
  recoveryCodes: []
}));

const { app, start } = require('../server');

describe('admin recovery when external delivery is not configured', () => {
  beforeAll(async () => {
    await start();
  });

  afterAll(() => {
    envKeys.forEach(key => {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('provides a restricted-log fallback without returning the recovery code to the requester', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.RECOVERY_SHOW_CODE = '1';
      const recovery = await request(app)
        .post('/api/auth/recovery/start')
        .set('X-Forwarded-For', '203.0.113.42')
        .send({ role: 'admin', identifier: 'test-admin' });

      expect(recovery.status).toBe(200);
      expect(recovery.body).toMatchObject({
        success: true,
        delivered: false,
        ownerLogFallback: true
      });
      expect(recovery.body).not.toHaveProperty('code');

      const logCall = warning.mock.calls.find(([message]) =>
        String(message).includes('Admin password recovery code (restricted service logs only)')
      );
      expect(logCall).toBeTruthy();
      const fallback = JSON.parse(logCall[1]);
      expect(fallback.username).toBe('test-admin');
      expect(fallback.code).toMatch(/^\d{6}$/);
      expect(Date.parse(fallback.expiresAt)).toBeGreaterThan(Date.now());

      const reset = await request(app)
        .post('/api/auth/recovery/verify')
        .set('X-Forwarded-For', '203.0.113.42')
        .send({
          role: 'admin',
          identifier: 'test-admin',
          code: fallback.code,
          password: newPassword
        });
      expect(reset.status).toBe(200);
      expect(reset.body.success).toBe(true);

      const login = await request(app)
        .post('/api/auth/admin/login')
        .send({ username: 'test-admin', password: newPassword });
      expect(login.status).toBe(200);
    } finally {
      warning.mockRestore();
    }
  });
});
