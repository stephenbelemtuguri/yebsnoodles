const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yebs-public-driver-roster-'));
const databasePath = path.join(tempDir, 'database.json');
fs.writeFileSync(databasePath, JSON.stringify({
  admins: [],
  drivers: [
    {
      id: 'drv-pending',
      username: 'pending-driver',
      name: 'Pending Driver',
      phone: '0200000000',
      photo: 'private-pending-photo',
      isActive: false,
      approvalStatus: 'pending'
    },
    {
      id: 'drv-approved',
      username: 'approved-driver',
      name: 'Approved Driver',
      phone: '0200000001',
      photo: 'approved-driver-photo',
      isActive: true,
      approvalStatus: 'approved'
    }
  ],
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
process.env.ADMIN_USERNAME = '';
process.env.ADMIN_PASSWORD = '';

const { app, start } = require('../server');

describe('public driver roster', () => {
  beforeAll(async () => {
    await start();
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('does not expose pending driver applications', async () => {
    const response = await request(app).get('/api/drivers');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      id: 'drv-approved',
      username: 'approved-driver',
      approvalStatus: 'approved'
    });
    expect(response.body.some(driver => driver.id === 'drv-pending')).toBe(false);
  });
});
