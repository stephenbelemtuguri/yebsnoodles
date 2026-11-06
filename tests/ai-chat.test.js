const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

describe('AI chat provider handling', () => {
  jest.setTimeout(30000);

  const envKeys = [
    'ADMIN_USERNAME',
    'ADMIN_PASSWORD',
    'DB_PATH',
    'DATABASE_URL',
    'DATABASE_POOL_URL',
    'SUPABASE_DB_URL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'YEBS_AUTH_SECRET',
    'GEMINI_API_KEY',
    'GOOGLE_GEMINI_API_KEY',
    'GEMINI_MODEL',
    'AI_MODEL',
    'AI_API_KEY',
    'GROQ_API_KEY',
    'OPENAI_API_KEY'
  ];
  const originalEnv = {};
  const originalFetch = global.fetch;
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yebs-ai-chat-'));
  const databasePath = path.join(testDir, 'database.json');
  let app;
  let adminToken;
  let databaseState;

  beforeAll(async () => {
    envKeys.forEach(key => { originalEnv[key] = process.env[key]; });
    process.env.ADMIN_USERNAME = '';
    process.env.ADMIN_PASSWORD = '';
    process.env.DB_PATH = databasePath;
    process.env.DATABASE_URL = '';
    process.env.DATABASE_POOL_URL = '';
    process.env.SUPABASE_DB_URL = '';
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    process.env.YEBS_AUTH_SECRET = 'ai-chat-test-secret';
    process.env.GEMINI_API_KEY = '';
    process.env.GOOGLE_GEMINI_API_KEY = '';
    process.env.GEMINI_MODEL = '';
    process.env.AI_MODEL = '';
    process.env.AI_API_KEY = '';
    process.env.GROQ_API_KEY = '';
    process.env.OPENAI_API_KEY = '';

    jest.resetModules();
    const data = {
      admins: [{
        id: 'adm-ai-health-test',
        username: 'ai-test-admin',
        password: bcrypt.hashSync('ai-health-test-password', 10),
        name: 'AI Health Test Admin',
        role: 'SUPERADMIN',
        sessionEpoch: 0
      }],
      drivers: [],
      orders: [],
      sessions: [],
      auditLogs: [],
      menuItems: [],
      payouts: [],
      reviews: [],
      notifications: [],
      settings: {
        momo: { payTo: '0550000000', accountName: 'Test' },
        pickup: { name: 'Test', address: 'Test', lat: 0, lng: 0 },
        deliveryFee: 15
      }
    };
    databaseState = data;
    const store = require('../src/data/store');
    jest.spyOn(store, 'init').mockResolvedValue(data);
    jest.spyOn(store, 'get').mockReturnValue(data);
    jest.spyOn(store, 'set').mockResolvedValue({ ok: true });
    jest.spyOn(store, 'refresh').mockResolvedValue(data);
    jest.spyOn(store, 'canPersist').mockReturnValue(true);
    jest.spyOn(store, 'flush').mockResolvedValue();
    jest.spyOn(store, 'acquireMutationLock').mockResolvedValue(jest.fn());
    app = require('../server').app;
    await require('../server').start();
    const login = await request(app)
      .post('/api/auth/admin/login')
      .send({ username: 'ai-test-admin', password: 'ai-health-test-password' });
    expect(login.status).toBe(200);
    adminToken = login.body.token;
  });

  afterAll(() => {
    global.fetch = originalFetch;
    envKeys.forEach(key => {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    });
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.GEMINI_API_KEY = '';
    process.env.GOOGLE_GEMINI_API_KEY = '';
    process.env.GEMINI_MODEL = '';
  });

  test('explains that an AI provider must be configured', async () => {
    const response = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'Hello' });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      success: false,
      provider: 'not-configured'
    });
    expect(response.body.reply).toContain('Set GEMINI_API_KEY');
  });

  test('falls back from a retired configured model to a current Gemini model', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_MODEL = 'retired-model';
    const requestedModels = [];
    global.fetch = jest.fn(async (url) => {
      if (!String(url).includes(':generateContent')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      requestedModels.push(String(url).match(/models\/([^:]+)/)[1]);
      if (requestedModels.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'Model not found.' } }), { status: 404 });
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Hello from the model.' }] } }]
      }), { status: 200 });
    });

    const response = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'Hello' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      reply: 'Hello from the model.',
      model: 'gemini-3.6-flash'
    });
    expect(requestedModels).toEqual(['retired-model', 'gemini-3.6-flash']);
  });

  test('requires an administrator and reports missing provider configuration', async () => {
    const unauthorized = await request(app).post('/api/admin/ai-health-check');
    expect(unauthorized.status).toBe(401);

    const response = await request(app)
      .post('/api/admin/ai-health-check')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      operational: false,
      status: 'not-configured'
    });
    expect(response.body.message).toContain('GEMINI_API_KEY');
    expect(response.body).not.toHaveProperty('apiKey');
  });

  test('reports a live Gemini response without returning the API key', async () => {
    process.env.GEMINI_API_KEY = 'private-test-key';
    process.env.GEMINI_MODEL = 'gemini-test-model';
    global.fetch = jest.fn(async (url, options) => {
      if (!String(url).includes(':generateContent')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      expect(options.headers['x-goog-api-key']).toBe('private-test-key');
      expect(JSON.parse(options.body).generationConfig.maxOutputTokens).toBe(8);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'OK' }] } }]
      }), { status: 200 });
    });

    const response = await request(app)
      .post('/api/admin/ai-health-check')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      operational: true,
      status: 'operational',
      provider: 'Gemini',
      model: 'gemini-test-model'
    });
    expect(JSON.stringify(response.body)).not.toContain('private-test-key');
  });

  test('does not report a configured Gemini key as operational before probing it', async () => {
    process.env.GEMINI_API_KEY = 'private-test-key';

    const response = await request(app)
      .get('/api/admin/provider-health')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.providers.gemini).toMatchObject({
      configured: true,
      operational: null,
      status: 'not-tested'
    });
  });

  test('reports rejected Gemini keys as a safe actionable status', async () => {
    process.env.GEMINI_API_KEY = 'private-test-key';
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      error: { message: 'API key private-test-key is invalid.' }
    }), { status: 403 }));

    const response = await request(app)
      .post('/api/admin/ai-health-check')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      operational: false,
      status: 'invalid-key'
    });
    expect(response.body.message).toContain('Replace GEMINI_API_KEY');
    expect(JSON.stringify(response.body)).not.toContain('private-test-key');
  });

  test('does not trust an unauthenticated admin role supplied by the browser', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = jest.fn(async (url, options) => {
      if (!String(url).includes(':generateContent')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      const requestBody = JSON.parse(options.body);
      expect(requestBody).not.toHaveProperty('tools');
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'I cannot access admin tools without an admin session.' }] } }]
      }), { status: 200 });
    });

    const response = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'Show admin orders', role: 'admin' });

    expect(response.status).toBe(200);
    expect(global.fetch.mock.calls.filter(([url]) => String(url).includes(':generateContent'))).toHaveLength(1);
    expect(response.body.reply).toContain('without an admin session');
  });

  test('requires a one-time signed-in confirmation before sending an admin notification', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            functionCall: {
              name: 'notify_team',
              args: { title: 'Kitchen update', message: 'Check the lunch queue.', audience: 'admin' }
            }
          }]
        }
      }]
    }), { status: 200 }));

    const initialNotifications = databaseState.notifications.length;
    const proposal = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ message: 'Notify admins to check the lunch queue.' });

    expect(proposal.status).toBe(200);
    expect(proposal.body.pendingAction).toMatchObject({
      title: 'Send a staff notification',
      summary: expect.stringContaining('Kitchen update')
    });
    expect(databaseState.notifications).toHaveLength(initialNotifications);

    const action = proposal.body.pendingAction;
    const confirmed = await request(app)
      .post(`/api/ai/actions/${action.id}/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirmationToken: action.confirmationToken, confirmed: true });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.message).toBe('The staff notification was sent.');
    expect(databaseState.notifications).toHaveLength(initialNotifications + 1);
    expect(databaseState.notifications[0]).toMatchObject({
      title: 'Kitchen update',
      audience: 'admin',
      source: 'ai-assistant'
    });

    const replay = await request(app)
      .post(`/api/ai/actions/${action.id}/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirmationToken: action.confirmationToken, confirmed: true });
    expect(replay.status).toBe(410);
  });
});
