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

  test('qualifies the default Supabase pooler user with the project reference', () => {
    const poolUrl = new URL('postgres://pooler.example');
    poolUrl.username = 'postgres';
    poolUrl.password = 'test-password';
    poolUrl.hostname = 'aws-0-eu-west-1.pooler.supabase.com';
    poolUrl.port = '6543';
    poolUrl.pathname = '/postgres';
    poolUrl.searchParams.set('pgbouncer', 'true');
    process.env.DATABASE_URL = '';
    process.env.DATABASE_POOL_URL = poolUrl.toString();
    process.env.SUPABASE_URL = 'https://projectref123.supabase.co';
    process.env.DATABASE_PASSWORD = '';

    const store = require('../src/data/store');
    poolUrl.username = 'postgres.projectref123';

    expect(store.DATABASE_URL).toBe(poolUrl.toString());
    expect(store.databaseProvider).toBe('supabase-postgres');
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
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          data: { orders: [], drivers: [{ id: 'driver-test' }] },
          updated_at: '2026-10-30T09:00:00.000Z'
        }]
      });
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

  test('refuses a stale Supabase REST write when another instance updated the state row', async () => {
    process.env.SUPABASE_URL = 'https://storage.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.DATABASE_URL = '';
    process.env.DATABASE_POOL_URL = '';
    process.env.SUPABASE_DB_URL = '';

    const updatedAt = '2026-10-30T09:00:00.000Z';
    const state = { orders: [] };
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ data: state, updated_at: updatedAt }]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ data: state, updated_at: updatedAt }]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => []
      });
    global.fetch = fetchMock;
    const store = require('../src/data/store');

    await store.init(() => state);
    const release = await store.acquireMutationLock();
    const saved = await store.set({ orders: [{ id: 'stale-write' }] });
    await release();

    expect(saved.ok).toBe(false);
    expect(saved.error).toMatch(/concurrent state update/i);
    expect(fetchMock.mock.calls[2][0]).toContain('updated_at=eq.');
    expect(fetchMock.mock.calls[2][1].method).toBe('PATCH');
  });

  test('uses the database-issued updated_at value for the next conditional write', async () => {
    process.env.SUPABASE_URL = 'https://storage.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.DATABASE_URL = '';
    process.env.DATABASE_POOL_URL = '';
    process.env.SUPABASE_DB_URL = '';

    const initialUpdatedAt = '2026-10-30T09:00:00.000Z';
    const databaseUpdatedAt = '2026-10-30T09:00:01.123+00:00';
    const nextUpdatedAt = '2026-10-30T09:00:02.456+00:00';
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ data: { orders: [] }, updated_at: initialUpdatedAt }]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ data: { orders: [] }, updated_at: initialUpdatedAt }]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ data: { orders: [{ id: 'one' }] }, updated_at: databaseUpdatedAt }]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ data: { orders: [{ id: 'one' }, { id: 'two' }] }, updated_at: nextUpdatedAt }]
      });
    global.fetch = fetchMock;
    const store = require('../src/data/store');

    await store.init(() => ({ orders: [] }));
    const release = await store.acquireMutationLock();
    expect((await store.set({ orders: [{ id: 'one' }] })).ok).toBe(true);
    expect((await store.set({ orders: [{ id: 'one' }, { id: 'two' }] })).ok).toBe(true);
    await release();

    expect(decodeURIComponent(fetchMock.mock.calls[3][0])).toContain(`updated_at=eq.${databaseUpdatedAt}`);
  });

  test('serializes overlapping mutation requests before refreshing shared REST state', async () => {
    process.env.SUPABASE_URL = 'https://storage.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.DATABASE_URL = '';
    process.env.DATABASE_POOL_URL = '';
    process.env.SUPABASE_DB_URL = '';

    const updatedAt = '2026-10-30T09:00:00.000Z';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ data: { orders: [] }, updated_at: updatedAt }]
    });
    global.fetch = fetchMock;
    const store = require('../src/data/store');

    await store.init(() => ({ orders: [] }));
    const releaseFirst = await store.acquireMutationLock();
    const secondLock = store.acquireMutationLock();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await releaseFirst();
    const releaseSecond = await secondLock;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await releaseSecond();
  });
});
