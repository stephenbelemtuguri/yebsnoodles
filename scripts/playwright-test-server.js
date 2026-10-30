const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.PORT || 3188);
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yebs-playwright-'));
const databasePath = path.join(dataDirectory, 'database.json');

const isolatedEnvironment = {
  DATABASE_URL: '',
  DATABASE_POOL_URL: '',
  SUPABASE_DB_URL: '',
  DATABASE_PASSWORD: '',
  SUPABASE_DB_PASSWORD: '',
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  SUPABASE_SERVICE_KEY: '',
  SUPABASE_SECRET_KEY: '',
  RENDER: '',
  RENDER_SERVICE_ID: '',
  AWS_LAMBDA_FUNCTION_NAME: ''
};

for (const name of Object.keys(isolatedEnvironment)) {
  process.env[name] = '';
}

for (const name of [
  'PORT',
  'DB_PATH',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'ADMIN_CREDENTIAL_RESET_VERSION',
  'JWT_SECRET',
  'YEBS_AUTH_SECRET'
]) {
  delete process.env[name];
}

Object.assign(process.env, isolatedEnvironment, {
  PORT: String(port),
  DB_PATH: databasePath,
  ADMIN_USERNAME: '',
  ADMIN_PASSWORD: '',
  ADMIN_CREDENTIAL_RESET_VERSION: '',
  JWT_SECRET: 'playwright-isolated-test-secret',
  YEBS_AUTH_SECRET: 'playwright-isolated-test-secret'
});

fs.writeFileSync(databasePath, JSON.stringify({
  admins: [],
  drivers: [],
  orders: [],
  sessions: [{
    id: 1,
    sessionNumber: 1,
    status: 'ACTIVE',
    startedAt: new Date().toISOString(),
    pickupPoint: { name: 'Test Kitchen', lat: 5.5612, lng: -0.2155 }
  }],
  settings: {
    adminCredentialResetVersion: '',
    momo: { payTo: '0241111111', accountName: 'Test Kitchen' },
    pickup: { name: 'Test Kitchen', lat: 5.5612, lng: -0.2155 },
    deliveryFee: 15
  },
  menuItems: [{
    id: 'e2e-noodles',
    name: 'E2E Test Noodles',
    price: 25,
    noodles: ['Spaghetti'],
    image: 'img_food_1.jpg',
    available: true,
    status: 'available'
  }],
  auditLogs: [],
  payouts: [],
  reviews: [],
  notifications: []
}));

const { app, start } = require('../server');
let httpServer;
let shuttingDown = false;

function cleanup() {
  try {
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  } catch (error) {
    console.error('[playwright] Could not remove isolated test data:', error.message);
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!httpServer) {
    cleanup();
    process.exit(0);
    return;
  }
  httpServer.close(() => {
    cleanup();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', cleanup);

start()
  .then(() => new Promise((resolve, reject) => {
    httpServer = app.listen(port, '127.0.0.1', resolve);
    httpServer.once('error', reject);
  }))
  .then(() => console.log(`[playwright] Isolated test API ready on 127.0.0.1:${port}`))
  .catch(error => {
    cleanup();
    console.error('[playwright] Test API failed to start:', error.message);
    process.exitCode = 1;
  });
