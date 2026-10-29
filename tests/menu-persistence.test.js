const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yebs-menu-persistence-'));
const databasePath = path.join(tempDir, 'database.json');
process.env.DB_PATH = databasePath;
process.env.DATABASE_URL = '';
process.env.DATABASE_POOL_URL = '';
process.env.SUPABASE_DB_URL = '';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.ADMIN_USERNAME = 'menu-editor-test';
process.env.ADMIN_PASSWORD = 'menu-editor-test-password';

const { app, start } = require('../server');

describe('admin menu persistence', () => {
  let token;

  beforeAll(async () => {
    await start();
    const login = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    token = login.body.token;
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('keeps edited food-card details after the menu is reloaded', async () => {
    const initial = await request(app).get('/api/menu');
    expect(initial.status).toBe(200);
    const menuItems = initial.body.map(item => item.id === 'indomie60'
      ? { ...item, name: 'Updated Test Dish', price: 67.5, formula: 'Updated test ingredients' }
      : item);

    const save = await request(app)
      .post('/api/menu')
      .set('Authorization', `Bearer ${token}`)
      .send({ menuItems });
    expect(save.status).toBe(200);
    expect(save.body.persisted).toBe(true);

    const reloaded = await request(app).get('/api/menu');
    const updated = reloaded.body.find(item => item.id === 'indomie60');
    expect(updated).toMatchObject({
      name: 'Updated Test Dish',
      price: 67.5,
      formula: 'Updated test ingredients'
    });

    const diskState = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
    expect(diskState.menuItems.find(item => item.id === 'indomie60')).toMatchObject({
      name: 'Updated Test Dish',
      price: 67.5,
      formula: 'Updated test ingredients'
    });
  });
});
