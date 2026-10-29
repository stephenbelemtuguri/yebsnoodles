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
// it connects, so hosting on Render or Netlify only needs the database URL.
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

function resolveDatabaseUrl() {
  const renderUrl = String(process.env.DATABASE_URL || '').trim();
  const alternateUrl = String(
    process.env.DATABASE_POOL_URL ||
    process.env.SUPABASE_DB_URL ||
    ''
  ).trim();
  const raw = alternateUrl || renderUrl;
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (
      alternateUrl &&
      url.hostname.endsWith('.pooler.supabase.com') &&
      url.username === 'postgres'
    ) {
      const projectHost = new URL(SUPABASE_URL).hostname;
      const projectRef = projectHost.match(/^([a-z0-9]+)\.supabase\.co$/i)?.[1];
      if (projectRef) url.username = `postgres.${projectRef}`;
    }
    // Accept the raw password separately so characters like @ : # / do not
    // have to be URL-encoded by hand for alternate database URLs.
    if (RAW_DB_PASSWORD) url.password = RAW_DB_PASSWORD;
    return url.toString();
  } catch {
    return raw;
  }
}

const DATABASE_URL = resolveDatabaseUrl();
const TABLE = String(process.env.SUPABASE_STATE_TABLE || 'yebs_state').replace(/[^a-zA-Z0-9_]/g, '') || 'yebs_state';
const ROW_ID = 'main';

const postgresEnabled = Boolean(DATABASE_URL);
const restEnabled = !postgresEnabled && Boolean(SUPABASE_URL && SUPABASE_KEY);
const remoteEnabled = restEnabled || postgresEnabled;
const remoteMode = restEnabled ? 'supabase' : postgresEnabled ? 'postgres' : 'local';

let cache = null;
let initPromise = null;
let pending = Promise.resolve();
let pgPool = null;
let pgReady = null;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function readRest() {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(ROW_ID)}&select=data`;
  // A paused/misconfigured Supabase project must fail fast, not hang until the
  // serverless function times out (which surfaces as a 502 in the browser).
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase read failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0].data : null;
}

async function writeRest(data) {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?on_conflict=id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ id: ROW_ID, data, updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase write failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

function loadPg() {
  try {
    return require('pg');
  } catch (err) {
    throw new Error('Postgres mode needs the "pg" package. Run: npm install pg');
  }
}

/** Connect once, create the state table if it is missing, then reuse the pool. */
function ensurePostgres() {
  if (pgReady) return pgReady;
  pgReady = (async () => {
    const { Pool } = loadPg();
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      // Hosted Postgres (Supabase/Render) requires TLS.
      ssl: /supabase|pooler|render\.com|dpg-/i.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.PG_POOL_MAX || 2),
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 8000
    });
    pgPool.on('error', err => console.error('[store] Postgres pool error:', err.message));
    await pgPool.query(
      `create table if not exists public.${TABLE} (
         id text primary key,
         data jsonb not null,
         updated_at timestamptz not null default now()
       )`
    );
    await pgPool.query(`alter table public.${TABLE} enable row level security`).catch(() => {});
    return pgPool;
  })();
  return pgReady;
}

async function readPostgres() {
  const pool = await ensurePostgres();
  const res = await pool.query(`select data from public.${TABLE} where id = $1 limit 1`, [ROW_ID]);
  return res.rows[0] ? res.rows[0].data : null;
}

async function writePostgres(data) {
  const pool = await ensurePostgres();
  await pool.query(
    `insert into public.${TABLE} (id, data, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (id) do update set data = excluded.data, updated_at = now()`,
    [ROW_ID, JSON.stringify(data)]
  );
}

async function readRemote() {
  return restEnabled ? readRest() : readPostgres();
}

async function writeRemote(data) {
  return restEnabled ? writeRest(data) : writePostgres(data);
}

/**
 * Load the state. `loadLocal` supplies the fallback/seeding document when the
 * remote store is not configured or has no row yet.
 */
let lastError = null;
let lastReadAt = 0;
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
 * Netlify runs several instances of a function, each with its own memory. A
 * driver who signs up in instance A must be visible to an admin handled by
 * instance B, so re-read the shared row when the local copy is older than
 * READ_TTL_MS. Cheap (one row) and skipped entirely for local dev.
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
  if (remoteMode !== 'postgres') {
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
  remoteEnabled,
  remoteMode,
  DATABASE_URL,
  TABLE
};
