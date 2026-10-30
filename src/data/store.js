// ═══════════════════════════════════════════════════════════════════════════
// Persistent JSON state store
// ═══════════════════════════════════════════════════════════════════════════
// The API keeps its working set in memory (exactly like it used to keep it in
// database.json) but every save is mirrored to one of three durable backends:
//
//   • Supabase REST - when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set
//   • Supabase Postgres - when DATABASE_POOL_URL / DATABASE_URL is set
//   • Local file - when neither is configured (npm start on your machine)
//
// The Postgres mode creates the yebs_state table automatically the first time
// it connects, so hosting on Render only needs the database URL.
//
// Reads happen once at boot (`init`); writes are queued in order and flushed
// with `flush()` before a serverless invocation returns.
// ═══════════════════════════════════════════════════════════════════════════
const dns = require('node:dns');

if (process.env.RENDER || process.env.RENDER_SERVICE_ID) {
  dns.setDefaultResultOrder('ipv4first');
}

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  ''
);
const RAW_DB_PASSWORD = String(
  process.env.DATABASE_PASSWORD ||
  process.env.SUPABASE_DB_PASSWORD ||
  ''
).trim();

/**
 * Every Postgres connection string the host may have configured, in the order
 * they should be tried. A deployment used to pick exactly one and fail hard
 * with "password authentication failed" when the stale one won; now every
 * candidate is attempted in turn so one bad credential never takes the store
 * down and a backup backend can take over.
 */
function normalizeDatabaseUrl(raw) {
  if (!raw || !String(raw).trim()) return '';
  try {
    const url = new URL(String(raw).trim());
    if (url.hostname.endsWith('.pooler.supabase.com') && url.username === 'postgres') {
      // Supabase poolers want the project ref after the role:
      // postgres.<project-ref>@...
      const projectRef = String(SUPABASE_URL || '')
        .match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1];
      if (projectRef) url.username = `postgres.${projectRef}`;
    }
    if (url.hostname.endsWith('.pooler.supabase.com')) {
      // Port 6543 is Supabase transaction pooling. This application holds
      // session-scoped advisory locks, so use the session pooler on 5432.
      if (url.port === '6543') url.port = '5432';
      url.searchParams.delete('pgbouncer');
    }
    // Accept the raw password separately so characters like @ : # / do not
    // have to be URL-encoded by hand for alternate database URLs.
    if (RAW_DB_PASSWORD) url.password = RAW_DB_PASSWORD;
    return url.toString();
  } catch {
    return String(raw).trim();
  }
}

// Pooler first (IPv4-friendly and works on hosts without direct connections),
// then the direct database URL, then Render's own injected database.
const DATABASE_URL_CANDIDATES = [
  normalizeDatabaseUrl(process.env.DATABASE_POOL_URL),
  normalizeDatabaseUrl(process.env.SUPABASE_DB_URL),
  normalizeDatabaseUrl(process.env.DATABASE_URL)
].filter((value, index, all) => value && all.indexOf(value) === index);

const DATABASE_URL = DATABASE_URL_CANDIDATES[0] || '';
const TABLE = String(process.env.SUPABASE_STATE_TABLE || 'yebs_state').replace(/[^a-zA-Z0-9_]/g, '') || 'yebs_state';
const ROW_ID = 'main';

const restConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);
const postgresEnabled = DATABASE_URL_CANDIDATES.length > 0;
const remoteEnabled = restConfigured || postgresEnabled;
let remoteMode = postgresEnabled ? 'postgres' : restConfigured ? 'supabase' : 'local';
let databaseProvider = remoteMode;
try {
  if (postgresEnabled) {
    databaseProvider = /supabase\.co$/i.test(new URL(DATABASE_URL).hostname) ||
      /supabase\.com$/i.test(new URL(DATABASE_URL).hostname)
      ? 'supabase-postgres'
      : 'postgres';
  }
} catch {
  databaseProvider = postgresEnabled ? 'postgres' : databaseProvider;
}

let cache = null;
let initPromise = null;
let pending = Promise.resolve();
let restMutationTail = Promise.resolve();
let pgPool = null;
let pgReady = null;
// Flipped to 'rest' once a Postgres connection attempt fails and the Supabase
// REST key is available, so reads and writes stay on one backend.
let failoverBackend = null;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function readRest() {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(ROW_ID)}&select=data,updated_at`;
  // A paused/misconfigured Supabase project must fail fast, not hang until the
  // serverless function times out (which surfaces as a 502 in the browser).
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(8000) });
    const rows = await res.json();
    if (!res.ok) {
      const body = Array.isArray(rows) ? '' : JSON.stringify(rows).slice(0, 300);
      throw new Error(`Supabase read failed (${res.status}): ${body}`);
    }
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    remoteUpdatedAt = row && row.updated_at ? row.updated_at : null;
    return row ? row.data : null;
  } catch (err) {
    console.warn(`[store] REST read ${failoverBackend === 'rest' ? '(failover)' : ''}${Date.now() - startedAt}ms: ${err.message}`);
    throw err;
  }
}

async function writeRest(data) {
  const previousUpdatedAt = remoteUpdatedAt;
  const updatedAt = new Date(Math.max(Date.now(), (Date.parse(previousUpdatedAt) || 0) + 1)).toISOString();
  const isNewRow = !previousUpdatedAt;
  const query = isNewRow
    ? `on_conflict=id`
    : `id=eq.${encodeURIComponent(ROW_ID)}&updated_at=eq.${encodeURIComponent(previousUpdatedAt)}`;
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?${query}`;
  // The whole state row (menu, orders, accounts) can be hundreds of kilobytes
  // on a slow upload link, so writes get a generous ceiling.
  const res = await fetch(url, {
    method: isNewRow ? 'POST' : 'PATCH',
    headers: headers({
      Prefer: isNewRow ? 'resolution=ignore-duplicates,return=representation' : 'return=representation'
    }),
    body: JSON.stringify(isNewRow
      ? { id: ROW_ID, data, updated_at: updatedAt }
      : { data, updated_at: updatedAt }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase write failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    if (!isNewRow) {
      throw new Error('Concurrent state update detected; reload the latest data and retry.');
    }
    const remote = await readRest();
    if (!remote || typeof remote !== 'object') {
      throw new Error('The shared state row could not be created.');
    }
    cache = remote;
    if (JSON.stringify(remote) !== JSON.stringify(data)) {
      throw new Error('Concurrent state creation detected; reload the latest data and retry.');
    }
    return;
  }
  remoteUpdatedAt = rows[0].updated_at || updatedAt;
  if (isNewRow && rows[0].data && typeof rows[0].data === 'object') {
    cache = rows[0].data;
  }
}

function loadPg() {
  try {
    return require('pg');
  } catch (err) {
    throw new Error('Postgres mode needs the "pg" package. Run: npm install pg');
  }
}

let activeConnectionString = DATABASE_URL || '';

function describeProvider(connectionString) {
  try {
    const host = new URL(connectionString).hostname;
    return /supabase\.co$/i.test(host) || /supabase\.com$/i.test(host)
      ? 'supabase-postgres'
      : 'postgres';
  } catch {
    return 'postgres';
  }
}

function pgPoolFor(connectionString) {
  const { Pool } = loadPg();
  const pool = new Pool({
    connectionString,
    // Hosted Postgres (Supabase/Render) requires TLS.
    ssl: /supabase|pooler|render\.com|dpg-/i.test(connectionString) ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX || 1),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 30000),
    query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 20000),
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 20000),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
  });
  pool.on('error', err => console.error('[store] Postgres pool error:', err.message));
  return pool;
}

/**
 * Connect once, create the state table if it is missing, then reuse the pool.
 * Every configured connection string is tried in turn — a stale password on
 * one of them (Render's own database, an old pooler URL) must not stop the
 * store from reaching the Supabase row.
 */
async function connectPostgres() {
  let lastError = null;
  const candidates = activeConnectionString
    ? [activeConnectionString, ...DATABASE_URL_CANDIDATES.filter(u => u !== activeConnectionString)]
    : DATABASE_URL_CANDIDATES;
  for (const candidate of candidates) {
    let pool = null;
    try {
      pool = pgPoolFor(candidate);
      await pool.query(
        `create table if not exists public.${TABLE} (
           id text primary key,
           data jsonb not null,
           updated_at timestamptz not null default now()
         )`
      );
      await pool.query(`alter table public.${TABLE} enable row level security`).catch(() => {});
      activeConnectionString = candidate;
      remoteMode = 'postgres';
      databaseProvider = describeProvider(candidate);
      console.log(`[store] Postgres connected via ${describeProvider(candidate)} (${new URL(candidate).host}).`);
      return pool;
    } catch (err) {
      lastError = err;
      console.warn(`[store] Postgres candidate failed (${err.code || err.message}): dropping ${new URL(candidate).host}.`);
      if (pool) await pool.end().catch(() => {});
    }
  }
  throw lastError || new Error('No Postgres connection string is configured.');
}

/** Connect once, create the state table if it is missing, then reuse the pool. */
function ensurePostgres() {
  if (pgReady) return pgReady;
  pgReady = connectPostgres().catch(async err => {
    pgReady = null;
    if (pgPool) {
      const failedPool = pgPool;
      pgPool = null;
      await failedPool.end().catch(() => {});
    }
    throw err;
  }).then(pool => {
    pgPool = pool;
    return pool;
  });
  return pgReady;
}

async function retryPostgres(operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const transient = /timeout|temporarily unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/i.test(err.message || '');
      if (!transient || attempt === attempts) throw err;
      console.warn(`[store] Postgres retry ${attempt}/${attempts}: ${err.message}`);
      await new Promise(resolve => {
        setTimeout(resolve, attempt * 750);
      });
    }
  }
  throw lastError;
}

async function readPostgres() {
  return retryPostgres(async () => {
    const pool = await ensurePostgres();
    const res = await pool.query(`select data from public.${TABLE} where id = $1 limit 1`, [ROW_ID]);
    return res.rows[0] ? res.rows[0].data : null;
  });
}

async function writePostgres(data) {
  await retryPostgres(async () => {
    const pool = await ensurePostgres();
    await pool.query(
      `insert into public.${TABLE} (id, data, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (id) do update set data = excluded.data, updated_at = now()`,
      [ROW_ID, JSON.stringify(data)]
    );
  });
}

/**
 * Read from the active backend. When Postgres is unreachable (bad credential,
 * paused project, network) and the Supabase REST key is configured, the REST
 * backend takes over once and stays on it — probing the dead connection on
 * every request only added 20 second delays and kept storage marked broken.
 */
async function readRemote() {
  if (failoverBackend === 'rest') return readRest();
  if (!DATABASE_URL_CANDIDATES.length) return readRest();
  try {
    return await readPostgres();
  } catch (pgErr) {
    if (!restConfigured) throw pgErr;
    failoverBackend = 'rest';
    remoteMode = 'supabase';
    databaseProvider = 'supabase-rest';
    console.warn('[store] Postgres unreachable, switching to the Supabase REST backend:', pgErr.message);
    return readRest();
  }
}

/** Write to whichever backend the reads are currently using. */
async function writeRemote(data) {
  if (failoverBackend === 'rest') return writeRest(data);
  if (!DATABASE_URL_CANDIDATES.length) return writeRest(data);
  try {
    return await writePostgres(data);
  } catch (pgErr) {
    if (!restConfigured) throw pgErr;
    failoverBackend = 'rest';
    remoteMode = 'supabase';
    databaseProvider = 'supabase-rest';
    console.warn('[store] Postgres write failed, switching to the Supabase REST backend:', pgErr.message);
    return writeRest(data);
  }
}

/**
 * Load the state. `loadLocal` supplies the fallback/seeding document when the
 * remote store is not configured or has no row yet.
 */
let lastError = null;
let lastReadAt = 0;
let remoteUpdatedAt = null;
// False when the durable row could not be read at startup. While it is false we
// must never write, otherwise a transient outage would replace the real menu,
// orders and accounts with the local seed document.
let remoteReadOk = !remoteEnabled;
const READ_TTL_MS = Number(process.env.SUPABASE_STATE_TTL_MS || 1500);

function init(loadLocal) {
  if (!initPromise) {
    initPromise = (async () => {
      if (!remoteEnabled) {
        cache = loadLocal();
        return cache;
      }
      try {
        const remote = await readRemote();
        lastReadAt = Date.now();
        if (remote && typeof remote === 'object') {
          remoteReadOk = true;
          cache = remote;
          return cache;
        }
        const seed = loadLocal();
        cache = seed;
        remoteReadOk = true;
        await writeRemote(seed);
        return cache;
      } catch (err) {
        // A missing table, a wrong key or a paused project must not take the
        // whole site down: fall back to the seed document so the menu, admin
        // login and sign-ups still work, and surface the reason on /api/health.
        lastError = err.message;
        remoteReadOk = false;
        console.error('[store] remote store unavailable, using in-memory seed:', err.message);
        cache = loadLocal();
        return cache;
      }
    })();
  }
  return initPromise;
}

/**
 * Re-read the shared row periodically so changes made by another server
 * instance become visible. Cheap (one row) and skipped entirely for local dev.
 */
async function refresh(force = false) {
  if (!remoteEnabled) return cache;
  if (!force && Date.now() - lastReadAt < READ_TTL_MS) return cache;
  await pending; // never discard a write that is still in flight
  try {
    const remote = await readRemote();
    lastReadAt = Date.now();
    remoteReadOk = true;
    if (remote && typeof remote === 'object') {
      cache = remote;
    }
    lastError = null;
  } catch (err) {
    lastError = err.message;
    lastReadAt = Date.now(); // don't hammer a broken endpoint on every request
    console.error('[store] refresh failed:', err.message);
  }
  return cache;
}

async function acquireMutationLock() {
  const backend = failoverBackend
    || (remoteMode === 'supabase' ? 'supabase' : postgresEnabled ? 'postgres' : 'local');
  if (backend === 'supabase') {
    let releaseGate;
    const previousMutation = restMutationTail;
    restMutationTail = new Promise(resolve => { releaseGate = resolve; });
    await previousMutation;
    try {
      await refresh(true);
      if (!canPersist()) throw new Error('Persistent storage is unavailable.');
    } catch (err) {
      releaseGate();
      throw err;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      releaseGate();
    };
  }
  if (backend === 'local') {
    await refresh(true);
    if (remoteEnabled && !canPersist()) throw new Error('Persistent storage is unavailable.');
    return async () => {};
  }
  const pool = await ensurePostgres();
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [724105221]);
    lastReadAt = 0;
    await refresh(true);
    if (!canPersist()) throw new Error('Persistent storage is unavailable.');
  } catch (err) {
    try { await client.query('select pg_advisory_unlock($1)', [724105221]); } catch (unlockErr) {
      console.error('[store] advisory lock cleanup failed:', unlockErr.message);
    }
    client.release();
    throw err;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query('select pg_advisory_unlock($1)', [724105221]);
    } finally {
      client.release();
    }
  };
}

function get() {
  return cache;
}

/**
 * Update the in-memory state and write it durably.
 * Returns a promise with `{ ok, mode, error }` so callers can tell the admin
 * the truth instead of reporting success for a write that never landed.
 */
function set(data) {
  cache = data;
  if (!remoteEnabled) return Promise.resolve({ ok: true, mode: 'local-file' });

  const write = pending.then(async () => {
    if (!remoteReadOk) {
      // Try once more to read the real row. If it exists we refuse the write:
      // the caller's copy was built from defaults and would erase live data.
      const remote = await readRemote();
      lastReadAt = Date.now();
      if (remote && typeof remote === 'object') {
        remoteReadOk = true;
        cache = remote;
        throw new Error('Live data could not be loaded when the server started, so this change was not saved over it. Reload the dashboard and try again.');
      }
      remoteReadOk = true;
    }
    await writeRemote(data);
  });

  pending = write
    .then(() => { lastError = null; return true; })
    .catch(err => {
      lastError = err.message;
      console.error('[store]', err.message);
      return false;
    });

  return write
    .then(() => ({ ok: true, mode: remoteMode }))
    .catch(err => ({ ok: false, mode: remoteMode, error: err.message }));
}

/** Resolve once every queued write has reached its backend. */
function flush() {
  return pending.catch(() => {});
}

function isRemote() {
  return remoteEnabled && !lastError;
}

/** True when a save would actually reach durable storage. */
function canPersist() {
  if (!remoteEnabled) return false;
  return remoteReadOk && !lastError;
}

/** Human-readable storage status for /api/health. */
function status() {
  if (!remoteEnabled) return 'local-file';
  if (lastError) return `${remoteMode}-error: ${lastError}`;
  return remoteMode;
}

/** Full picture for /api/health so connectivity problems are visible at once. */
function diagnostics() {
  const pgTried = DATABASE_URL_CANDIDATES.map(url => {
    try { return new URL(url).host; } catch { return 'invalid-url'; }
  });
  return {
    injector: DATABASE_URL_CANDIDATES.length ? 'postgres' : (restConfigured ? 'supabase-rest' : 'local-file'),
    postgres: {
      configured: DATABASE_URL_CANDIDATES.length > 0,
      candidates: pgTried,
      using: pgTried[0]
    },
    supabaseRest: {
      configured: restConfigured,
      project: SUPABASE_URL ? (SUPABASE_URL.match(/^https:\/\/([a-z0-9]+)\./i)?.[1] || null) : null,
      failover: failoverBackend === 'rest'
    }
  };
}

module.exports = {
  init,
  refresh,
  get,
  set,
  flush,
  acquireMutationLock,
  isRemote,
  canPersist,
  status,
  diagnostics,
  // These are live getters on purpose: `remoteMode` and `databaseProvider`
  // change when the backend fails over, and a plain "property: variable" export
  // would be frozen at whatever the value was when the module was first
  // required (which is exactly the stale-"postgres"-after-failover bug).
  get remoteEnabled() { return remoteEnabled; },
  get remoteMode() { return remoteMode; },
  get databaseProvider() { return databaseProvider; },
  get DATABASE_URL() { return activeConnectionString; },
  TABLE
};
