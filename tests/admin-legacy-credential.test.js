const bcrypt = require('bcryptjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yebs-admin-legacy-credential-'));
const databasePath = path.join(tempDir, 'database.json');
const configuredUsername = 'secure-admin-test';
const configuredPassword = 'new-secure-test-password';
fs.writeFileSync(databasePath, JSON.stringify({
  admins: [{
    id: 'adm-legacy',
    username: 'goodfood',
    password: bcrypt.hashSync('goodfood@123', 4),
    name: 'Legacy administrator',
    role: 'SUPERADMIN',
    sessionEpoch: 4
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
process.env.ADMIN_USERNAME = configuredUsername;
process.env.ADMIN_PASSWORD = configuredPassword;

const { app, start, loadDatabase } = require('../server');

describe('legacy administrator credential migration', () => {
  beforeAll(async () => {
    await start();
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('replaces known seeded credentials with configured credentials', async () => {
    const legacyLogin = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: 'goodfood', password: 'goodfood@123' });
    expect(legacyLogin.status).toBe(401);

    const configuredLogin = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: configuredUsername, password: configuredPassword });
    expect(configuredLogin.status).toBe(200);

    const admin = loadDatabase().admins[0];
    expect(admin.username).toBe(configuredUsername);
    expect(admin.sessionEpoch).toBe(5);
    expect(admin.requiresPasswordSetup).toBeUndefined();
    expect(bcrypt.compareSync('goodfood@123', admin.password)).toBe(false);
    expect(bcrypt.compareSync(configuredPassword, admin.password)).toBe(true);
  });
});
