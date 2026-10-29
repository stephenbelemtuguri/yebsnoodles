const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yebs-admin-seed-security-'));
const databasePath = path.join(tempDir, 'database.json');
process.env.DB_PATH = databasePath;
process.env.DATABASE_URL = '';
process.env.DATABASE_POOL_URL = '';
process.env.SUPABASE_DB_URL = '';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.ADMIN_USERNAME = '';
process.env.ADMIN_PASSWORD = '';

const { app, start, loadDatabase } = require('../server');

describe('administrator seed security', () => {
  beforeAll(async () => {
    await start();
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('does not seed or accept the published default administrator password', async () => {
    expect(loadDatabase().admins).toEqual([]);

    const databaseResponse = await request(app).get('/database.json');
    expect(databaseResponse.status).toBe(404);

    const login = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: 'goodfood', password: 'goodfood@123' });

    expect(login.status).toBe(401);
    expect(JSON.parse(fs.readFileSync(databasePath, 'utf8')).admins).toEqual([]);
  });
});
