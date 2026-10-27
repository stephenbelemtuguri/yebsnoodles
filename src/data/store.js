// ═══════════════════════════════════════════════════════════════════════════
// Persistent JSON state store
// ═══════════════════════════════════════════════════════════════════════════
// The API keeps its working set in memory (exactly like it used to keep it in
// database.json) but every save is mirrored to one of two durable backends:
//
//   • Supabase  — when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set
//                 (used by the Netlify deployment, survives cold starts)
//   • Local file — when they are not (npm start on your own machine)
//
// Reads happen once at boot (`init`); writes are queued in order and flushed
// with `flush()` before a serverless invocation returns.
// ═══════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  ''
);
const TABLE = process.env.SUPABASE_STATE_TABLE || 'yebs_state';
const ROW_ID = 'main';

const remoteEnabled = Boolean(SUPABASE_URL && SUPABASE_KEY);

let cache = null;
let initPromise = null;
let pending = Promise.resolve();

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function readRemote() {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(ROW_ID)}&select=data`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase read failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0].data : null;
}

async function writeRemote(data) {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?on_conflict=id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ id: ROW_ID, data, updated_at: new Date().toISOString() })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase write failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

/**
 * Load the state. `loadLocal` supplies the fallback/seeding document when
 * Supabase is not configured or has no row yet.
 */
let lastError = null;
let lastReadAt = 0;
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
          cache = remote;
          return cache;
        }
        const seed = loadLocal();
        cache = seed;
        await writeRemote(seed);
        return cache;
      } catch (err) {
        // A missing table, a wrong key or a paused project must not take the
        // whole site down: fall back to the seed document so the menu, admin
        // login and sign-ups still work, and surface the reason on /api/health.
        lastError = err.message;
        console.error('[store] Supabase unavailable, using in-memory seed:', err.message);
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
async function refresh() {
  if (!remoteEnabled) return cache;
  if (Date.now() - lastReadAt < READ_TTL_MS) return cache;
  await pending; // never discard a write that is still in flight
  try {
    const remote = await readRemote();
    lastReadAt = Date.now();
    if (remote && typeof remote === 'object') cache = remote;
    lastError = null;
  } catch (err) {
    lastError = err.message;
    lastReadAt = Date.now(); // don't hammer a broken endpoint on every request
    console.error('[store] refresh failed:', err.message);
  }
  return cache;
}

function get() {
  return cache;
}

/** Update the in-memory state and queue a durable write. */
function set(data) {
  cache = data;
  if (remoteEnabled) {
    pending = pending
      .then(() => writeRemote(data))
      .then(() => { lastError = null; })
      .catch(err => {
        lastError = err.message;
        console.error('[store]', err.message);
      });
  }
  return pending;
}

/** Resolve once every queued write has reached its backend. */
function flush() {
  return pending.catch(() => {});
}

function isRemote() {
  return remoteEnabled && !lastError;
}

/** Human-readable storage status for /api/health. */
function status() {
  if (!remoteEnabled) return 'local-file';
  return lastError ? `supabase-error: ${lastError}` : 'supabase';
}

module.exports = { init, refresh, get, set, flush, isRemote, status, remoteEnabled };
