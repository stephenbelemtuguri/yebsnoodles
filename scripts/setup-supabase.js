#!/usr/bin/env node
// Create and verify the Supabase state table used by YEBS Noodles.
//
// Usage:
//   1. Put the real database password in .env (DATABASE_POOL_URL + DATABASE_URL).
//   2. npm run supabase:setup
//
// The script creates public.yebs_state, enables RLS, seeds it from database.json
// when empty, then reads the row back so you can see the connection working.
// It never prints the password.

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const TABLE = String(process.env.SUPABASE_STATE_TABLE || 'yebs_state').replace(/[^a-zA-Z0-9_]/g, '') || 'yebs_state';
const RAW_DB_PASSWORD = String(
  process.env.DATABASE_PASSWORD ||
  process.env.SUPABASE_DB_PASSWORD ||
  ''
).trim();

function resolveDbUrl() {
  const raw = String(process.env.DATABASE_POOL_URL || process.env.DATABASE_URL || '').trim();
  if (!raw) return '';
  if (!RAW_DB_PASSWORD) return raw;
  try {
    const url = new URL(raw);
    url.password = RAW_DB_PASSWORD;
    return url.toString();
  } catch {
    return raw;
  }
}

const DB_URL = resolveDbUrl();

function mask(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(invalid URL)';
  }
}

function isPlaceholder(url) {
  const pw = decodeURIComponent(new URL(url).password || '').trim();
  if (!pw) return true;
  return ['your-password', '[your-password]', 'your_password', 'change-me', 'changeme', 'placeholder', 'password', 'example'].includes(pw.toLowerCase());
}

(async () => {
  if (!DB_URL) {
    console.error('\n[setup] DATABASE_POOL_URL / DATABASE_URL is missing in .env.');
    console.error('        Supabase Dashboard -> Project Settings -> Database -> Connection string (URI).');
    console.error('        Use the Session pooler URI (port 6543) and replace [YOUR-PASSWORD].\n');
    process.exit(1);
  }

  let placeholder = false;
  try {
    placeholder = isPlaceholder(DB_URL);
  } catch {
    console.error('\n[setup] DATABASE_POOL_URL is not a valid URL.\n');
    process.exit(1);
  }
  if (placeholder) {
    console.error('\n[setup] The database password is still a placeholder.');
    console.error('        Reset it in Supabase -> Project Settings -> Database -> Reset database password,');
    console.error('        then update DATABASE_POOL_URL and DATABASE_URL in .env.\n');
    process.exit(1);
  }

  const { Client } = require('pg');
  const client = new Client({
    connectionString: DB_URL,
    ssl: /supabase|pooler|render\.com|dpg-/i.test(DB_URL) ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 12000
  });

  console.log(`[setup] connecting to ${mask(DB_URL)} ...`);
  try {
    await client.connect();
    const who = await client.query('select current_database() as db, current_user as usr');
    console.log(`[setup] connected as ${who.rows[0].usr} to ${who.rows[0].db}`);

    await client.query(`
      create table if not exists public.${TABLE} (
        id text primary key,
        data jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
    await client.query(`alter table public.${TABLE} enable row level security`).catch(() => {});
    console.log(`[setup] table public.${TABLE} is ready`);

    const existing = await client.query(`select id, data from public.${TABLE} where id = $1`, ['main']);
    const seedPath = path.join(__dirname, '..', 'database.json');
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const bcrypt = require('bcryptjs');
    const adminUsername = String(process.env.ADMIN_USERNAME || '').trim();
    const adminPassword = String(process.env.ADMIN_PASSWORD || '');
    const admin = adminUsername && adminPassword ? {
      id: 'adm-1',
      username: adminUsername,
      password: bcrypt.hashSync(adminPassword, 10),
      name: 'YEBS Administrator',
      role: 'SUPERADMIN',
      createdAt: new Date().toISOString()
    } : null;

    if (!admin) {
      console.warn('[setup] ADMIN_USERNAME / ADMIN_PASSWORD not set - no administrator will be seeded.');
    }

    if (existing.rowCount === 0) {
      seed.admins = admin ? [admin] : [];
      await client.query(
        `insert into public.${TABLE} (id, data, updated_at) values ($1, $2::jsonb, now())`,
        ['main', JSON.stringify(seed)]
      );
      console.log(`[setup] seeded "main" from database.json (${seed.menuItems ? seed.menuItems.length : 0} menu items${admin ? `, admin "${adminUsername}"` : ', no admin'})`);
    } else {
      const data = existing.rows[0].data || {};
      const admins = Array.isArray(data.admins) ? data.admins : [];
      const hasAdmin = admin && admins.some(a => String(a.username || '').toLowerCase() === adminUsername.toLowerCase());
      if (!admin) {
        console.log('[setup] existing "main" row kept (no admin changes)');
      } else if (hasAdmin) {
        console.log(`[setup] existing "main" row kept (admin "${adminUsername}" already present)`);
      } else {
        data.admins = admins.concat([admin]);
        await client.query(
          `update public.${TABLE} set data = $2::jsonb, updated_at = now() where id = $1`,
          ['main', JSON.stringify(data)]
        );
        console.log(`[setup] existing "main" row kept; added admin "${adminUsername}"`);
      }
    }

    const check = await client.query(
      `select id, updated_at, jsonb_array_length(coalesce(data->'menuItems', '[]'::jsonb)) as menu_items from public.${TABLE} where id = $1`,
      ['main']
    );
    const row = check.rows[0];
    console.log(`[setup] verified: id=${row.id} menuItems=${row.menu_items} updatedAt=${row.updated_at.toISOString()}`);

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    if (serviceKey && baseUrl) {
      const res = await fetch(`${baseUrl}/rest/v1/${TABLE}?id=eq.main&select=id,updated_at`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
      });
      const body = await res.text();
      if (res.ok) {
        console.log(`[setup] REST check passed (${res.status})`);
      } else {
        console.warn(`[setup] REST check failed (${res.status}): ${body.slice(0, 200)}`);
      }
    } else {
      console.log('[setup] SUPABASE_SERVICE_ROLE_KEY not set - the app will use the Postgres connection instead.');
    }

    console.log('\n[setup] done. Start the app and check /api/health -> storage should read "postgres" or "supabase".\n');
  } catch (err) {
    console.error(`\n[setup] failed: ${err.message}`);
    if (err.code === '28P01') {
      console.error('        Wrong database password. Reset it in Supabase -> Project Settings -> Database.');
    }
    if (err.code === 'ENOTFOUND') {
      console.error('        Host not found. Use the Session pooler host from the Supabase dashboard.');
    }
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
