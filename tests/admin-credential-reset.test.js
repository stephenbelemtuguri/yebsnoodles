const bcrypt = require('bcryptjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yebs-admin-credential-reset-'));
const databasePath = path.join(tempDir, 'database.json');
const resetUsername = 'recovered-admin';
const resetPassword = 'recovered-admin-strong-password';
const resetVersion = 'recovery-2026-10';

fs.writeFileSync(databasePath, JSON.stringify({
  admins: [{
    id: 'adm-existing',
    username: 'old-admin',
    password: bcrypt.hashSync('old-admin-password', 10),
    name: 'Existing administrator',
    role: 'SUPERADMIN',
    sessionEpoch: 2
  }],
  drivers: [],
  orders: [],
  sessions: [],
  settings: {}
}));

process.env.DB_PATH = databasePath;
process.env.DATABASE_URL = '';
process.env.DATABASE_POOL_URL = '';
process.env.SUPABASE_DB_URL = '';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.ADMIN_USERNAME = resetUsername;
process.env.ADMIN_PASSWORD = resetPassword;
process.env.ADMIN_CREDENTIAL_RESET_VERSION = resetVersion;

const { app, start } = require('../server');

describe('one-time administrator credential reset', () => {
  beforeAll(async () => {
    await start();
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('applies configured credentials to a persisted administrator and permits later GUI changes', async () => {
    const resetLogin = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: resetUsername, password: resetPassword });
    expect(resetLogin.status).toBe(200);

    const oldLogin = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: 'old-admin', password: 'old-admin-password' });
    expect(oldLogin.status).toBe(401);

    const state = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
    expect(state.admins[0]).toMatchObject({ username: resetUsername, sessionEpoch: 3 });
    expect(state.settings.adminCredentialResetVersion).toBe(resetVersion);

    const update = await request(app)
      .post('/api/admin/settings/credentials')
      .set('Authorization', `Bearer ${resetLogin.body.token}`)
      .send({
        currentPassword: resetPassword,
        newPassword: 'new-gui-admin-strong-password'
      });
    expect(update.status).toBe(200);

    const guiLogin = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: resetUsername, password: 'new-gui-admin-strong-password' });
    expect(guiLogin.status).toBe(200);
  });
});
