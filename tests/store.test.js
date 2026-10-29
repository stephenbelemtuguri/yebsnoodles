describe('persistent store recovery', () => {
  const originalEnv = {};
  const originalFetch = global.fetch;
  const envKeys = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'DATABASE_URL',
    'DATABASE_POOL_URL',
    'SUPABASE_DB_URL',
    'DATABASE_PASSWORD',
    'RENDER',
    'RENDER_SERVICE_ID'
  ];

  beforeAll(() => {
    envKeys.forEach(key => { originalEnv[key] = process.env[key]; });
  });

  afterEach(() => {
    jest.resetModules();
    global.fetch = originalFetch;
    envKeys.forEach(key => {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    });
  });

  test('prefers the configured database pooler when both database URLs are set', () => {
    const renderUrl = 'postgres://render_user:render-password@render-db.example:5432/yebs';
    process.env.DATABASE_URL = renderUrl;
    process.env.DATABASE_POOL_URL = 'postgres://postgres:stale-password@supabase-db.example:5432/postgres';
    process.env.SUPABASE_URL = 'https://storage.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.DATABASE_PASSWORD = '';

    const store = require('../src/data/store');

    expect(store.remoteMode).toBe('postgres');
    expect(store.DATABASE_URL).toBe(process.env.DATABASE_POOL_URL);
  });

  test('uses DATABASE_URL when no pooler URL is configured', () => {
    process.env.DATABASE_URL = 'primary-database-url';
    process.env.DATABASE_POOL_URL = '';
    process.env.SUPABASE_DB_URL = '';

    const store = require('../src/data/store');

    expect(store.DATABASE_URL).toBe('primary-database-url');
  });

  test('prefers IPv4 addresses for Render database connections', () => {
    const dns = require('node:dns');
    const setDefaultResultOrder = jest.spyOn(dns, 'setDefaultResultOrder');
    process.env.RENDER = 'true';
    process.env.DATABASE_URL = 'postgres://render_user:password@render-db.example:5432/yebs';

    require('../src/data/store');

    expect(setDefaultResultOrder).toHaveBeenCalledWith('ipv4first');
    setDefaultResultOrder.mockRestore();
  });

  test('allows writes after remote storage recovers with an empty state row', async () => {
    process.env.SUPABASE_URL = 'https://storage.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.DATABASE_URL = '';
    process.env.DATABASE_POOL_URL = '';
    process.env.SUPABASE_DB_URL = '';

    const fetchMock = jest.fn()
      .mockRejectedValueOnce(new Error('temporary unavailable'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => []
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => []
      })
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock;
    const store = require('../src/data/store');
    const seed = { orders: [] };

    await store.init(() => seed);
    expect(store.canPersist()).toBe(false);
    expect(store.status()).toContain('error');

    await store.refresh(true);
    expect(store.canPersist()).toBe(true);
    expect(store.status()).toBe('supabase');
    await expect(store.acquireMutationLock()).resolves.toEqual(expect.any(Function));

    const saved = await store.set({ ...seed, drivers: [{ id: 'driver-test' }] });
    expect(saved.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
