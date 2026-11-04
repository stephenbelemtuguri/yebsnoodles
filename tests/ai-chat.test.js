const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
      admins: [],
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
    const store = require('../src/data/store');
    jest.spyOn(store, 'init').mockResolvedValue(data);
    jest.spyOn(store, 'get').mockReturnValue(data);
    jest.spyOn(store, 'refresh').mockResolvedValue(data);
    jest.spyOn(store, 'canPersist').mockReturnValue(true);
    jest.spyOn(store, 'flush').mockResolvedValue();
    app = require('../server').app;
    await require('../server').start();
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
});
