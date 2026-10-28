#!/usr/bin/env node
// Generate supabase/setup.sql from database.json.
//
// Usage:
//   node scripts/build-supabase-sql.js
//   npm run supabase:sql
//
// The SQL creates public.yebs_state (the single table the API reads and
// writes), enables RLS, seeds the menu/settings and creates the built-in
// administrator. Re-running it never deletes orders, drivers or reviews.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'goodfood').trim() || 'goodfood';
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'goodfood@123');

const root = path.join(__dirname, '..');
const dbPath = path.join(root, 'database.json');
const outPath = path.join(root, 'supabase', 'setup.sql');

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const now = new Date().toISOString();

for (const key of ['admins', 'drivers', 'orders', 'sessions', 'auditLogs', 'menuItems', 'payouts', 'reviews', 'notifications']) {
  if (!Array.isArray(db[key])) db[key] = [];
}

db.settings = db.settings && typeof db.settings === 'object' ? db.settings : {};
db.settings.momo = db.settings.momo || { payTo: '0559103452', accountName: 'MATHEW TIA' };
db.settings.pickup = db.settings.pickup || {
  name: 'Circle Odo Rice Junction / VIP Station',
  address: 'Kwame Nkrumah Circle, Accra',
  lat: 5.5612,
  lng: -0.2155
};
db.settings.deliveryFee = Number.isFinite(Number(db.settings.deliveryFee)) ? Number(db.settings.deliveryFee) : 15;

db.admins = [{
  id: 'adm-1',
  username: ADMIN_USERNAME,
  password: bcrypt.hashSync(ADMIN_PASSWORD, 10),
  name: 'YEBS Administrator',
  role: 'SUPERADMIN',
  createdAt: now
}];

if (!db.sessions.length) {
  db.sessions = [{
    id: 1,
    sessionNumber: 1,
    status: 'ACTIVE',
    startedAt: now,
    intermissionEndsAt: null,
    pickupPoint: { ...db.settings.pickup, updatedAt: now }
  }];
}

if (!db.auditLogs.length) {
  db.auditLogs = [{
    id: 'log-init',
    timestamp: now,
    action: 'SYSTEM_INITIALIZED',
    actor: 'SYSTEM',
    entity: 'DATABASE',
    details: 'YEBS Noodles Supabase state initialised.'
  }];
}

const seedJson = JSON.stringify(db, null, 2);
const adminJson = JSON.stringify(db.admins);
const adminUsernameSql = ADMIN_USERNAME.replace(/'/g, "''");

if (seedJson.includes('$yebs$') || adminJson.includes('$admin$')) {
  throw new Error('JSON contains a dollar-quote tag; change the tag in scripts/build-supabase-sql.js');
}

const sql = `-- ============================================================================
-- YEBS Noodles - Supabase setup
-- ----------------------------------------------------------------------------
-- HOW TO RUN
--   1. Open https://supabase.com/dashboard/project/dujmpwcarxliadnfdydr/sql/new
--   2. Paste this whole file and press Run.
--   3. You should see: menu_items = ${db.menuItems.length}, admins = 1.
--
-- This file is safe to re-run. It never deletes orders, drivers, reviews or
-- menu edits. It only creates the table and makes sure the admin exists.
--
-- Admin login after running:  ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}
-- Change the password from Admin -> Settings after the first login.
-- ============================================================================

create table if not exists public.yebs_state (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

comment on table public.yebs_state is
  'Single-row JSON document for YEBS Noodles: orders, menu, drivers, admins, reviews and settings.';

-- Row Level Security: only the server (service_role key or the table owner)
-- can read or write. Publishable/anon clients get nothing.
alter table public.yebs_state enable row level security;

create or replace function public.yebs_state_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists yebs_state_touch on public.yebs_state;
create trigger yebs_state_touch
  before update on public.yebs_state
  for each row execute function public.yebs_state_touch();

-- Supabase roles exist on Supabase; the DO block keeps the file portable to a
-- plain PostgreSQL instance (e.g. Render's database).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.yebs_state to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.yebs_state from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.yebs_state from authenticated';
  end if;
end
$$;

-- First row: menu, pickup point, MoMo wallet, settings and the admin account.
insert into public.yebs_state (id, data)
values ('main', $yebs$${seedJson}$yebs$::jsonb)
on conflict (id) do nothing;

-- If the app already created the row, add the admin without touching orders.
update public.yebs_state
set data = jsonb_set(
      data,
      '{admins}',
      coalesce(data->'admins', '[]'::jsonb) || $admin$${adminJson}$admin$::jsonb
    ),
    updated_at = now()
where id = 'main'
  and not exists (
    select 1
    from jsonb_array_elements(coalesce(data->'admins', '[]'::jsonb)) as a
    where lower(a->>'username') = lower('${adminUsernameSql}')
  );

-- Verification: expect menu_items = ${db.menuItems.length}, admins >= 1.
select id,
       updated_at,
       jsonb_array_length(coalesce(data->'menuItems', '[]'::jsonb)) as menu_items,
       jsonb_array_length(coalesce(data->'admins', '[]'::jsonb))    as admins,
       data->'settings'->'momo'->>'payTo'                           as momo_wallet
from public.yebs_state
where id = 'main';

-- ----------------------------------------------------------------------------
-- Changing the admin password later
--   1. Generate a bcrypt hash:
--        node -e "console.log(require('bcryptjs').hashSync('NEW-PASSWORD',10))"
--   2. Replace HASH below and run:
--        update public.yebs_state
--        set data = jsonb_set(data, '{admins,0,password}', to_jsonb('HASH'::text))
--        where id = 'main';
-- ----------------------------------------------------------------------------
`;

fs.writeFileSync(outPath, sql, 'utf8');
console.log(`[supabase:sql] wrote ${path.relative(root, outPath)}`);
console.log(`[supabase:sql] admin=${ADMIN_USERNAME} menuItems=${db.menuItems.length} sessions=${db.sessions.length}`);
console.log('[supabase:sql] paste the file into the Supabase SQL Editor and press Run.');
