// ═══════════════════════════════════════════════════════════════════════════
// Persistent state store
// ═══════════════════════════════════════════════════════════════════════════
// The API keeps its working set in memory, but durable storage is normalised so
// the shop can hold tens of thousands of orders without rewriting the world on
// every sale:
//
//   • <table>          one small JSONB row: menu, settings, accounts, sessions
//   • <table>_orders   one row per order (id, data, status, created_at)
//   • <table>_events   one row per notification / audit entry
//
// Before this change every order mutation rewrote one JSONB document holding
// the entire business (53 MB at 10k orders, ~1 write/second). Now a new order
// writes ~1 KB: the order row, the notification row and the audit row.
//
// Backends:
//   • Supabase Postgres - when DATABASE_POOL_URL / DATABASE_URL is set (primary)
//   • Supabase REST     - when only SUPABASE_URL + a service key are set, or as
//                         a failover. REST mode keeps the legacy single-row
//                         document so nothing is lost when Postgres is down.
//   • Local file        - when neither is configured (npm start on your machine)
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
const sanitizeName = value => String(value || '').replace(/[^a-zA-Z0-9_]/g, '') || 'yebs_state';
const TABLE = sanitizeName(process.env.SUPABASE_STATE_TABLE || 'yebs_state');
const ORDERS_TABLE = sanitizeName(process.env.SUPABASE_ORDERS_TABLE || `${TABLE}_orders`);
const ORDER_ITEMS_TABLE = sanitizeName(process.env.SUPABASE_ORDER_ITEMS_TABLE || `${TABLE}_order_items`);
const EVENTS_TABLE = sanitizeName(process.env.SUPABASE_EVENTS_TABLE || `${TABLE}_events`);
const ROW_ID = 'main';
// Only the most recent events are needed in memory (the ledger screens show a
// recent page); older rows stay in the table for auditing.
const EVENT_MEMORY_LIMIT = Math.max(100, Number(process.env.YEBS_EVENT_MEMORY_LIMIT || 500));

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

// Diff state: what the database already holds, so a write only touches rows
// that actually changed.
let lastOrderJson = new Map();
let lastEventJson = new Map();
let lastConfigJson = null;
let ordersWatermark = null;
let eventsWatermark = null;
let orderCount = 0;

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
  // The legacy REST document can be large; keep a generous ceiling.
  const res = await fetch(url, {
    method: isNewRow ? 'POST' : 'PATCH',
    headers: headers({
      Prefer: isNewRow ? 'resolution=ignore-duplicates,return=representation' : 'return=representation'
    }),
    body: JSON.stringify(isNewRow
      ? { id: ROW_ID, data, updated_at: updatedAt }
      : { data, updated_at: updatedAt }),
    signal: AbortSignal.timeout(30000)
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
    // The mutation middleware holds one connection for its advisory lock while
    // the write itself needs a second one, so the pool must be > 1.
    max: Math.max(2, Number(process.env.PG_POOL_MAX || 5)),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000),
    query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 20000),
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 20000),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
  });
  pool.on('error', err => console.error('[store] Postgres pool error:', err.message));
  return pool;
}

/** Create the three tables (and their indexes) if they are missing. */
async function ensureSchema(pool) {
  await pool.query(
    `create table if not exists public.${TABLE} (
       id text primary key,
       data jsonb not null,
       updated_at timestamptz not null default now()
     )`
  );
  await pool.query(
    `create table if not exists public.${ORDERS_TABLE} (
       id text primary key,
       data jsonb not null,
       status text,
       created_at timestamptz,
       updated_at timestamptz not null default now()
     )`
  );
  await pool.query(`create index if not exists ${ORDERS_TABLE}_created_idx on public.${ORDERS_TABLE} (created_at desc)`);
  await pool.query(`create index if not exists ${ORDERS_TABLE}_status_idx on public.${ORDERS_TABLE} (status)`);
  await pool.query(`create index if not exists ${ORDERS_TABLE}_updated_idx on public.${ORDERS_TABLE} (updated_at)`);
  await pool.query(
    `create table if not exists public.${ORDER_ITEMS_TABLE} (
       order_id text not null references public.${ORDERS_TABLE}(id) on delete cascade,
       position integer not null,
       menu_id text,
       name text not null,
       noodle text,
       quantity integer not null check (quantity > 0),
       unit_price numeric(12,2) not null,
       data jsonb not null,
       primary key (order_id, position)
     )`
  );
  await pool.query(`create index if not exists ${ORDER_ITEMS_TABLE}_menu_idx on public.${ORDER_ITEMS_TABLE} (menu_id)`);
  await pool.query(
    `create table if not exists public.${EVENTS_TABLE} (
       id text primary key,
       kind text not null,
       data jsonb not null,
       created_at timestamptz,
       updated_at timestamptz not null default now()
     )`
  );
  await pool.query(`create index if not exists ${EVENTS_TABLE}_created_idx on public.${EVENTS_TABLE} (created_at desc)`);
  await pool.query(`create index if not exists ${EVENTS_TABLE}_updated_idx on public.${EVENTS_TABLE} (updated_at)`);
  for (const table of [TABLE, ORDERS_TABLE, ORDER_ITEMS_TABLE, EVENTS_TABLE]) {
    await pool.query(`alter table public.${table} enable row level security`).catch(() => {});
  }
}

/**
 * Connect once, create the tables if they are missing, then reuse the pool.
 * Every configured connection string is tried in turn — a stale password on
 * one of them (Render's own database, an old pooler URL) must not stop the
 * store from reaching the Supabase database.
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
      await ensureSchema(pool);
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

/** Connect once, create the tables if they are missing, then reuse the pool. */
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

async function retryPostgres(operation, attempts = 2) {
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

// ---------------------------------------------------------------------------
// Normalised tables
// ---------------------------------------------------------------------------

function eventId(entry, kind) {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.id) return String(entry.id);
  // Legacy audit entries have no id; derive a stable one so a re-read does not
  // duplicate them.
  const stamp = entry.timestamp || entry.createdAt || '';
  const seed = `${kind}|${stamp}|${entry.action || ''}|${entry.entity || ''}|${entry.actor || ''}`;
  return 'legacy_' + require('node:crypto').createHash('sha1').update(seed).digest('hex').slice(0, 20);
}

async function syncOrderItems(client, order) {
  const orderId = String(order.id);
  await client.query(`delete from public.${ORDER_ITEMS_TABLE} where order_id = $1`, [orderId]);
  const items = Array.isArray(order.items) ? order.items : [];
  for (let start = 0; start < items.length; start += 100) {
    const chunk = items.slice(start, start + 100);
    const values = [];
    const params = [];
    chunk.forEach((item, offset) => {
      const index = start + offset;
      const base = offset * 8;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::numeric, $${base + 8}::jsonb)`);
      params.push(
        orderId,
        index,
        item.menuId || null,
        String(item.name || 'Item'),
        item.noodle || null,
        Math.max(1, Math.floor(Number(item.quantity) || 1)),
        Number(item.price) || 0,
        JSON.stringify(item)
      );
    });
    await client.query(
      `insert into public.${ORDER_ITEMS_TABLE} (order_id, position, menu_id, name, noodle, quantity, unit_price, data)
       values ${values.join(', ')} on conflict (order_id, position) do update set
         menu_id = excluded.menu_id, name = excluded.name, noodle = excluded.noodle,
         quantity = excluded.quantity, unit_price = excluded.unit_price, data = excluded.data`,
      params
    );
  }
}

async function insertOrders(client, orders, { ignoreExisting = false } = {}) {
  const rows = (orders || []).filter(o => o && o.id);
  for (let start = 0; start < rows.length; start += 100) {
    const chunk = rows.slice(start, start + 100);
    const values = [];
    const params = [];
    chunk.forEach((order, index) => {
      const base = index * 4;
      values.push(`($${base + 1}, $${base + 2}::jsonb, $${base + 3}, $${base + 4}::timestamptz)`);
      params.push(
        String(order.id),
        JSON.stringify(order),
        order.status || null,
        order.createdAt || new Date().toISOString()
      );
    });
    const conflict = ignoreExisting
      ? 'on conflict (id) do nothing'
      : `on conflict (id) do update set
           data = excluded.data,
           status = excluded.status,
           created_at = excluded.created_at,
           updated_at = now()`;
    await client.query(
      `insert into public.${ORDERS_TABLE} (id, data, status, created_at)
       values ${values.join(', ')}
       ${conflict}`,
      params
    );
    for (const order of chunk) await syncOrderItems(client, order);
  }
}

async function insertEvents(client, entries, kind, { ignoreExisting = false } = {}) {
  const rows = (entries || [])
    .map(entry => ({ entry, id: eventId(entry, kind) }))
    .filter(row => row.id);
  for (let start = 0; start < rows.length; start += 100) {
    const chunk = rows.slice(start, start + 100);
    const values = [];
    const params = [];
    chunk.forEach((row, index) => {
      const base = index * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}::jsonb, $${base + 4}::timestamptz)`);
      params.push(
        row.id,
        kind,
        JSON.stringify(row.entry),
        row.entry.createdAt || row.entry.timestamp || new Date().toISOString()
      );
    });
    const conflict = ignoreExisting
      ? 'on conflict (id) do nothing'
      : `on conflict (id) do update set
           data = excluded.data,
           created_at = excluded.created_at,
           updated_at = now()`;
    await client.query(
      `insert into public.${EVENTS_TABLE} (id, kind, data, created_at)
       values ${values.join(', ')}
       ${conflict}`,
      params
    );
  }
}

/**
 * One-time upgrade from the legacy single-document layout: move orders,
 * notifications and audit entries into their own tables and shrink the config
 * row. Safe to run repeatedly (inserts ignore duplicates).
 */
async function migrateLegacy(client, legacy) {
  const orders = Array.isArray(legacy.orders) ? legacy.orders : [];
  const notifications = Array.isArray(legacy.notifications) ? legacy.notifications : [];
  const auditLogs = Array.isArray(legacy.auditLogs) ? legacy.auditLogs : [];
  if (!orders.length && !notifications.length && !auditLogs.length) return legacy;
  console.log(`[store] migrating legacy state row: ${orders.length} orders, ${notifications.length} notifications, ${auditLogs.length} audit entries.`);
  await insertOrders(client, orders, { ignoreExisting: true });
  await insertEvents(client, notifications, 'notification', { ignoreExisting: true });
  await insertEvents(client, auditLogs, 'audit', { ignoreExisting: true });
  const clean = { ...legacy };
  delete clean.orders;
  delete clean.notifications;
  delete clean.auditLogs;
  await client.query(
    `update public.${TABLE} set data = $1::jsonb, updated_at = now() where id = $2`,
    [JSON.stringify(clean), ROW_ID]
  );
  return clean;
}

// Full snapshot bookkeeping — used once when the state is first loaded.
function rememberState(state, config, orders, notifications, auditLogs) {
  lastOrderJson = new Map();
  for (const order of orders) {
    if (order && order.id) lastOrderJson.set(String(order.id), JSON.stringify(order));
  }
  lastEventJson = new Map();
  for (const entry of notifications) {
    const id = eventId(entry, 'notification');
    if (id) lastEventJson.set(id, JSON.stringify(entry));
  }
  for (const entry of auditLogs) {
    const id = eventId(entry, 'audit');
    if (id) lastEventJson.set(id, JSON.stringify(entry));
  }
  lastConfigJson = JSON.stringify(config);
  orderCount = orders.length;
  return state;
}

// Incremental bookkeeping — used on every refresh. Only the rows that were
// actually re-read are re-serialised, so a poll on a 10,000-order shop does not
// re-encode the entire archive every 1.5 seconds.
function rememberRefreshed(config, changedOrders, changedNotifications, changedAudit, totalOrders) {
  for (const order of changedOrders) {
    if (order && order.id) lastOrderJson.set(String(order.id), JSON.stringify(order));
  }
  for (const entry of changedNotifications) {
    const id = eventId(entry, 'notification');
    if (id) lastEventJson.set(id, JSON.stringify(entry));
  }
  for (const entry of changedAudit) {
    const id = eventId(entry, 'audit');
    if (id) lastEventJson.set(id, JSON.stringify(entry));
  }
  lastConfigJson = JSON.stringify(config);
  orderCount = totalOrders;
}

async function readWatermarks(pool) {
  const res = await pool.query(
    `select
       (select max(updated_at) from public.${ORDERS_TABLE}) as orders_at,
       (select max(updated_at) from public.${EVENTS_TABLE}) as events_at`
  );
  const row = res.rows[0] || {};
  ordersWatermark = row.orders_at ? new Date(row.orders_at).toISOString() : null;
  eventsWatermark = row.events_at ? new Date(row.events_at).toISOString() : null;
}

async function loadSplitState(pool) {
  const configRes = await pool.query(
    `select data from public.${TABLE} where id = $1 limit 1`,
    [ROW_ID]
  );
  const rawConfig = configRes.rows[0] ? configRes.rows[0].data : null;
  if (!rawConfig || typeof rawConfig !== 'object') return null;

  let config = rawConfig;
  const legacy = Array.isArray(config.orders) || Array.isArray(config.notifications) || Array.isArray(config.auditLogs);
  if (legacy) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      config = await migrateLegacy(client, config);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const ordersRes = await pool.query(
    `select data from public.${ORDERS_TABLE} order by created_at desc nulls last`
  );
  const eventsRes = await pool.query(
    `select data, kind from public.${EVENTS_TABLE} order by created_at desc nulls last limit $1`,
    [EVENT_MEMORY_LIMIT * 2]
  );
  const orders = ordersRes.rows.map(row => row.data).filter(Boolean);
  const notifications = eventsRes.rows.filter(r => r.kind === 'notification').map(r => r.data).slice(0, EVENT_MEMORY_LIMIT);
  const auditLogs = eventsRes.rows.filter(r => r.kind === 'audit').map(r => r.data).slice(0, EVENT_MEMORY_LIMIT);

  const state = { ...config, orders, notifications, auditLogs };
  rememberState(state, config, orders, notifications, auditLogs);
  await readWatermarks(pool);
  return state;
}

async function readPostgres() {
  return retryPostgres(async () => {
    const pool = await ensurePostgres();
    return loadSplitState(pool);
  });
}

/**
 * Write only what changed. Orders, notifications and audit entries are
 * diffed by id against the last known database contents, so a status change
 * costs one small row update instead of rewriting the whole business.
 */
async function writePostgres(data) {
  const pool = await ensurePostgres();
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const notifications = Array.isArray(data.notifications) ? data.notifications : [];
  const auditLogs = Array.isArray(data.auditLogs) ? data.auditLogs : [];
  const config = { ...data };
  delete config.orders;
  delete config.notifications;
  delete config.auditLogs;
  const configJson = JSON.stringify(config);

  const nextOrderJson = new Map();
  const changedOrders = [];
  for (const order of orders) {
    if (!order || !order.id) continue;
    const id = String(order.id);
    const json = JSON.stringify(order);
    nextOrderJson.set(id, json);
    if (lastOrderJson.get(id) !== json) changedOrders.push(order);
  }
  const removedOrders = [];
  for (const id of lastOrderJson.keys()) {
    if (!nextOrderJson.has(id)) removedOrders.push(id);
  }

  const nextEventJson = new Map();
  const changedNotifications = [];
  const changedAudit = [];
  for (const entry of notifications) {
    const id = eventId(entry, 'notification');
    if (!id) continue;
    const json = JSON.stringify(entry);
    nextEventJson.set(id, json);
    if (lastEventJson.get(id) !== json) changedNotifications.push(entry);
  }
  for (const entry of auditLogs) {
    const id = eventId(entry, 'audit');
    if (!id) continue;
    const json = JSON.stringify(entry);
    nextEventJson.set(id, json);
    if (lastEventJson.get(id) !== json) changedAudit.push(entry);
  }
  const removedEvents = [];
  for (const id of lastEventJson.keys()) {
    if (!nextEventJson.has(id)) removedEvents.push(id);
  }

  const configChanged = configJson !== lastConfigJson;
  const nothingChanged = !changedOrders.length && !removedOrders.length &&
    !changedNotifications.length && !changedAudit.length && !removedEvents.length && !configChanged;

  if (!nothingChanged) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      if (changedOrders.length) await insertOrders(client, changedOrders);
      if (removedOrders.length) {
        await client.query(`delete from public.${ORDERS_TABLE} where id = any($1::text[])`, [removedOrders]);
      }
      if (changedNotifications.length) await insertEvents(client, changedNotifications, 'notification');
      if (changedAudit.length) await insertEvents(client, changedAudit, 'audit');
      if (removedEvents.length) {
        await client.query(`delete from public.${EVENTS_TABLE} where id = any($1::text[])`, [removedEvents]);
      }
      if (configChanged) {
        await client.query(
          `insert into public.${TABLE} (id, data, updated_at)
           values ($1, $2::jsonb, now())
           on conflict (id) do update set data = excluded.data, updated_at = now()`,
          [ROW_ID, configJson]
        );
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    lastOrderJson = nextOrderJson;
    lastEventJson = nextEventJson;
    lastConfigJson = configJson;
    orderCount = orders.length;
    await readWatermarks(pool);
  }
}

/**
 * Incremental refresh: the config row is tiny, and only rows written since the
 * last watermark are pulled for orders and events. This keeps a 1.5 s poll from
 * downloading the whole order history on every API request.
 */
async function refreshSplit(pool) {
  const configRes = await pool.query(
    `select data from public.${TABLE} where id = $1 limit 1`,
    [ROW_ID]
  );
  const config = configRes.rows[0] ? configRes.rows[0].data : null;
  if (!config || typeof config !== 'object') return cache;
  if (Array.isArray(config.orders) || Array.isArray(config.notifications) || Array.isArray(config.auditLogs)) {
    return loadSplitState(pool);
  }

  const existingOrders = new Map();
  for (const order of (cache && Array.isArray(cache.orders) ? cache.orders : [])) {
    if (order && order.id) existingOrders.set(String(order.id), order);
  }
  const existingNotifications = new Map();
  for (const entry of (cache && Array.isArray(cache.notifications) ? cache.notifications : [])) {
    const id = eventId(entry, 'notification');
    if (id) existingNotifications.set(id, entry);
  }
  const existingAudit = new Map();
  for (const entry of (cache && Array.isArray(cache.auditLogs) ? cache.auditLogs : [])) {
    const id = eventId(entry, 'audit');
    if (id) existingAudit.set(id, entry);
  }

  // Look back a few seconds past the watermark. Two server instances can write
  // at almost the same moment; if our own write lands second it advances the
  // watermark past the other instance's row, which a strict `>=` would then
  // never fetch. Re-reading a handful of recent rows is cheap and guarantees
  // no update is missed.
  const ordersRes = await pool.query(
    `select data from public.${ORDERS_TABLE}
     where $1::timestamptz is null
        or updated_at >= $1::timestamptz - interval '5 seconds'`,
    [ordersWatermark]
  );
  const changedOrders = [];
  for (const row of ordersRes.rows) {
    if (row.data && row.data.id) {
      existingOrders.set(String(row.data.id), row.data);
      changedOrders.push(row.data);
    }
  }
  const eventsRes = await pool.query(
    `select data, kind from public.${EVENTS_TABLE}
     where $1::timestamptz is null
        or updated_at >= $1::timestamptz - interval '5 seconds'
     order by created_at desc nulls last`,
    [eventsWatermark]
  );
  const changedNotifications = [];
  const changedAudit = [];
  for (const row of eventsRes.rows) {
    const target = row.kind === 'audit' ? existingAudit : existingNotifications;
    const id = eventId(row.data, row.kind);
    if (id) {
      target.set(id, row.data);
      if (row.kind === 'audit') changedAudit.push(row.data);
      else changedNotifications.push(row.data);
    }
  }

  const orders = [...existingOrders.values()].sort((a, b) =>
    new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  const notifications = [...existingNotifications.values()].slice(0, EVENT_MEMORY_LIMIT);
  const auditLogs = [...existingAudit.values()].slice(0, EVENT_MEMORY_LIMIT);

  const state = { ...config, orders, notifications, auditLogs };
  rememberRefreshed(config, changedOrders, changedNotifications, changedAudit, orders.length);
  await readWatermarks(pool);
  return state;
}

/**
 * Read from the active backend. When Postgres is unreachable (bad credential,
 * paused project, network) and the Supabase REST key is configured, the REST
 * backend takes over once and stays on it.
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
 * Re-read shared data periodically so changes made by another server instance
 * become visible. Orders and events are pulled incrementally.
 */
async function refresh(force = false) {
  if (!remoteEnabled) return cache;
  if (!force && Date.now() - lastReadAt < READ_TTL_MS) return cache;
  await pending; // never discard a write that is still in flight
  try {
    let remote;
    if (failoverBackend === 'rest' || !DATABASE_URL_CANDIDATES.length) {
      remote = await readRest();
    } else {
      const pool = await ensurePostgres();
      remote = await refreshSplit(pool);
    }
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
    },
    layout: {
      mode: failoverBackend === 'rest' ? 'legacy-single-row' : 'normalized',
      stateTable: TABLE,
      ordersTable: ORDERS_TABLE,
      orderItemsTable: ORDER_ITEMS_TABLE,
      eventsTable: EVENTS_TABLE,
      orderRows: orderCount,
      orderWatermark: ordersWatermark,
      eventWatermark: eventsWatermark
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
  TABLE,
  ORDERS_TABLE,
  ORDER_ITEMS_TABLE,
  EVENTS_TABLE
};
