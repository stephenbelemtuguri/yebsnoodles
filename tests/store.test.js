describe('persistent store recovery', () => {
  const originalEnv = {};
  const originalFetch = global.fetch;
  const envKeys = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'DATABASE_URL',
    'DATABASE_POOL_URL',
    'SUPABASE_DB_URL'
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
