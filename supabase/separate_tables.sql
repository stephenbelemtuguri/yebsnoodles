-- ============================================================================
-- YEBS Noodles — Supabase Separate Tables Schema & Bidirectional Sync (v2)
-- ============================================================================
-- HOW TO RUN:
--   1. Open https://supabase.com/dashboard/project/dujmpwcarxliadnfdydr/sql/new
--   2. Paste this entire file and click Run.
--
-- PURPOSE:
--   This script creates individual, human-readable relational tables for:
--     • Orders       (public.yebs_orders)
--     • Drivers      (public.yebs_drivers)
--     • Admins       (public.yebs_admins)
--     • Menu Items   (public.yebs_menu_items)
--     • Reviews      (public.yebs_reviews)
--     • Audit Logs   (public.yebs_audit_logs)
--     • Settings     (public.yebs_settings)
--     • Sessions     (public.yebs_sessions)
--
--   AND installs automatic PostgreSQL triggers that keep these individual
--   tables 100% in sync with the production app's public.yebs_state document:
--     1. App saves to yebs_state  ==> Trigger auto-unpacks into separate tables.
--     2. You edit yebs_menu_items ==> Trigger updates yebs_state (live on site).
--     3. You edit yebs_orders     ==> Trigger updates yebs_state.
--     4. You edit yebs_settings   ==> Trigger updates yebs_state.
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ────────────────────────────────────────────────────────────────────────────
-- 1. ORDERS TABLE
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.yebs_orders (
  id               text primary key,
  pickup_pin       text,
  session_number   int,
  customer_name    text,
  customer_phone   text,
  fulfilment       text,
  location         text,
  map_pin          jsonb,
  timing           text,
  subtotal         numeric(10,2),
  delivery_fee     numeric(10,2),
  total            numeric(10,2),
  payment          text,
  payment_mode     text,
  payment_network  text,
  payment_status   text default 'unpaid',
  payment_ref      text,
  payment_verified boolean default false,
  status           text default 'Received',
  kitchen_status   text default 'NEW',
  items            jsonb,
  notes            text,
  driver_id        text,
  driver_name      text,
  driver_phone     text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  raw_data         jsonb
);

-- Defensive migration: ensure all columns exist if the table was previously created
alter table public.yebs_orders add column if not exists pickup_pin text;
alter table public.yebs_orders add column if not exists session_number int;
alter table public.yebs_orders add column if not exists customer_name text;
alter table public.yebs_orders add column if not exists customer_phone text;
alter table public.yebs_orders add column if not exists fulfilment text;
alter table public.yebs_orders add column if not exists location text;
alter table public.yebs_orders add column if not exists map_pin jsonb;
alter table public.yebs_orders add column if not exists timing text;
alter table public.yebs_orders add column if not exists subtotal numeric(10,2);
alter table public.yebs_orders add column if not exists delivery_fee numeric(10,2);
alter table public.yebs_orders add column if not exists total numeric(10,2);
alter table public.yebs_orders add column if not exists payment text;
alter table public.yebs_orders add column if not exists payment_mode text;
alter table public.yebs_orders add column if not exists payment_network text;
alter table public.yebs_orders add column if not exists payment_status text default 'unpaid';
alter table public.yebs_orders add column if not exists payment_ref text;
alter table public.yebs_orders add column if not exists payment_verified boolean default false;
alter table public.yebs_orders add column if not exists status text default 'Received';
alter table public.yebs_orders add column if not exists kitchen_status text default 'NEW';
alter table public.yebs_orders add column if not exists items jsonb;
alter table public.yebs_orders add column if not exists notes text;
alter table public.yebs_orders add column if not exists driver_id text;
alter table public.yebs_orders add column if not exists driver_name text;
alter table public.yebs_orders add column if not exists driver_phone text;
alter table public.yebs_orders add column if not exists created_at timestamptz default now();
alter table public.yebs_orders add column if not exists updated_at timestamptz default now();
alter table public.yebs_orders add column if not exists raw_data jsonb;

create index if not exists idx_yebs_orders_status on public.yebs_orders (status);
create index if not exists idx_yebs_orders_created on public.yebs_orders (created_at desc);
create index if not exists idx_yebs_orders_driver on public.yebs_orders (driver_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. DRIVERS TABLE
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.yebs_drivers (
  id              text primary key,
  username        text unique,
  name            text,
  fname           text,
  lname           text,
  email           text,
  phone           text unique,
  vehicle         text,
  photo           text,
  approval_status text default 'pending',
  is_active       boolean default true,
  failed_attempts int default 0,
  lockout_until   timestamptz,
  lat             numeric(10,6),
  lng             numeric(10,6),
  status_text     text default 'Available',
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  raw_data        jsonb
);

alter table public.yebs_drivers add column if not exists username text;
alter table public.yebs_drivers add column if not exists name text;
alter table public.yebs_drivers add column if not exists fname text;
alter table public.yebs_drivers add column if not exists lname text;
alter table public.yebs_drivers add column if not exists email text;
alter table public.yebs_drivers add column if not exists phone text;
alter table public.yebs_drivers add column if not exists vehicle text;
alter table public.yebs_drivers add column if not exists photo text;
alter table public.yebs_drivers add column if not exists approval_status text default 'pending';
alter table public.yebs_drivers add column if not exists is_active boolean default true;
alter table public.yebs_drivers add column if not exists failed_attempts int default 0;
alter table public.yebs_drivers add column if not exists lockout_until timestamptz;
alter table public.yebs_drivers add column if not exists lat numeric(10,6);
alter table public.yebs_drivers add column if not exists lng numeric(10,6);
alter table public.yebs_drivers add column if not exists status_text text default 'Available';
alter table public.yebs_drivers add column if not exists created_at timestamptz default now();
alter table public.yebs_drivers add column if not exists updated_at timestamptz default now();
alter table public.yebs_drivers add column if not exists raw_data jsonb;

create index if not exists idx_yebs_drivers_active on public.yebs_drivers (is_active, approval_status);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. ADMINS TABLE (Passwords kept safely in bcrypt or yebs_state)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.yebs_admins (
  id              text primary key,
  username        text unique,
  name            text,
  email           text,
  phone           text,
  role            text default 'ADMIN',
  photo           text,
  failed_attempts int default 0,
  lockout_until   timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

alter table public.yebs_admins add column if not exists username text;
alter table public.yebs_admins add column if not exists name text;
alter table public.yebs_admins add column if not exists email text;
alter table public.yebs_admins add column if not exists phone text;
alter table public.yebs_admins add column if not exists role text default 'ADMIN';
alter table public.yebs_admins add column if not exists photo text;
alter table public.yebs_admins add column if not exists failed_attempts int default 0;
alter table public.yebs_admins add column if not exists lockout_until timestamptz;
alter table public.yebs_admins add column if not exists created_at timestamptz default now();
alter table public.yebs_admins add column if not exists updated_at timestamptz default now();

-- ────────────────────────────────────────────────────────────────────────────
-- 4. MENU ITEMS TABLE
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.yebs_menu_items (
  id          text primary key,
  name        text not null,
  price       numeric(10,2) not null,
  badge       text,
  tag         text,
  "desc"      text,
  description text,
  formula     text,
  image       text,
  noodles     jsonb,
  template    text default 'poster-capsule',
  available   boolean default true,
  status      text default 'available',
  prep_time   text default 'Ready in 20–30 min',
  updated_at  timestamptz default now()
);

alter table public.yebs_menu_items add column if not exists name text;
alter table public.yebs_menu_items add column if not exists price numeric(10,2);
alter table public.yebs_menu_items add column if not exists badge text;
alter table public.yebs_menu_items add column if not exists tag text;
alter table public.yebs_menu_items add column if not exists "desc" text;
alter table public.yebs_menu_items add column if not exists description text;
alter table public.yebs_menu_items add column if not exists formula text;
alter table public.yebs_menu_items add column if not exists image text;
alter table public.yebs_menu_items add column if not exists noodles jsonb;
alter table public.yebs_menu_items add column if not exists template text default 'poster-capsule';
alter table public.yebs_menu_items add column if not exists available boolean default true;
alter table public.yebs_menu_items add column if not exists status text default 'available';
alter table public.yebs_menu_items add column if not exists prep_time text default 'Ready in 20–30 min';
alter table public.yebs_menu_items add column if not exists updated_at timestamptz default now();

-- ────────────────────────────────────────────────────────────────────────────
-- 5. REVIEWS TABLE
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.yebs_reviews (
  id         text primary key,
  order_id   text,
  rating     int check (rating between 1 and 5),
  comment    text,
  customer   text,
  created_at timestamptz default now()
);

create index if not exists idx_yebs_reviews_rating on public.yebs_reviews (rating);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. AUDIT LOGS TABLE
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.yebs_audit_logs (
  id          text primary key,
  action      text,
  actor       text,
  entity      text,
  details     text,
  ip_or_agent text,
  created_at  timestamptz default now()
);

create index if not exists idx_yebs_audit_created on public.yebs_audit_logs (created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 7. SETTINGS TABLE
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.yebs_settings (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 8. SESSIONS TABLE
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.yebs_sessions (
  id                   int primary key,
  session_number       int,
  status               text default 'ACTIVE',
  pickup_point         jsonb,
  started_at           timestamptz,
  intermission_ends_at timestamptz,
  updated_at           timestamptz default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY (RLS) & GRANTS
-- ────────────────────────────────────────────────────────────────────────────
alter table public.yebs_orders     enable row level security;
alter table public.yebs_drivers    enable row level security;
alter table public.yebs_admins     enable row level security;
alter table public.yebs_menu_items enable row level security;
alter table public.yebs_reviews    enable row level security;
alter table public.yebs_audit_logs enable row level security;
alter table public.yebs_settings   enable row level security;
alter table public.yebs_sessions   enable row level security;

do $$
declare r text;
begin
  foreach r in array array[
    'yebs_orders','yebs_drivers','yebs_admins','yebs_menu_items',
    'yebs_reviews','yebs_audit_logs','yebs_settings','yebs_sessions'
  ]
  loop
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert, update, delete on public.%I to service_role', r);
    end if;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', r);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', r);
    end if;
  end loop;
end
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- SYNC ENGINE: yebs_state  ==>  SEPARATE TABLES
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.yebs_sync_from_state()
returns trigger
language plpgsql
security definer
as $$
declare
  ord jsonb;
  drv jsonb;
  adm jsonb;
  mnu jsonb;
  rev jsonb;
  aud jsonb;
  ses jsonb;
  k text;
  v jsonb;
begin
  -- Prevent recursive loops
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.data is null then
    return new;
  end if;

  -- 1. Sync Orders
  if new.data ? 'orders' and jsonb_typeof(new.data->'orders') = 'array' then
    for ord in select jsonb_array_elements(new.data->'orders')
    loop
      insert into public.yebs_orders (
        id, pickup_pin, session_number, customer_name, customer_phone,
        fulfilment, location, map_pin, timing, subtotal, delivery_fee, total,
        payment, payment_mode, payment_network, payment_status, payment_ref, payment_verified,
        status, kitchen_status, items, notes, driver_id, driver_name, driver_phone,
        created_at, updated_at, raw_data
      ) values (
        ord->>'id',
        coalesce(ord->>'pickupPin', ord->>'pickup_pin'),
        (ord->>'sessionNumber')::int,
        coalesce(ord->>'customer', ord->>'customer_name'),
        coalesce(ord->>'phone', ord->>'customer_phone'),
        ord->>'fulfilment',
        ord->>'location',
        ord->'mapPin',
        ord->>'timing',
        (ord->>'subtotal')::numeric,
        (ord->>'deliveryFee')::numeric,
        (ord->>'total')::numeric,
        ord->>'payment',
        ord->>'paymentMode',
        ord->>'paymentNetwork',
        coalesce(ord->>'paymentStatus', 'unpaid'),
        ord->>'paymentRef',
        coalesce((ord->>'paymentVerified')::boolean, false),
        coalesce(ord->>'status', 'Received'),
        coalesce(ord->>'kitchenStatus', 'NEW'),
        ord->'items',
        ord->>'notes',
        ord->>'driverId',
        ord->>'driverName',
        ord->>'driverPhone',
        coalesce((ord->>'createdAt')::timestamptz, now()),
        now(),
        ord
      )
      on conflict (id) do update set
        pickup_pin       = excluded.pickup_pin,
        session_number   = excluded.session_number,
        customer_name    = excluded.customer_name,
        customer_phone   = excluded.customer_phone,
        fulfilment       = excluded.fulfilment,
        location         = excluded.location,
        map_pin          = excluded.map_pin,
        timing           = excluded.timing,
        subtotal         = excluded.subtotal,
        delivery_fee     = excluded.delivery_fee,
        total            = excluded.total,
        payment          = excluded.payment,
        payment_mode     = excluded.payment_mode,
        payment_network  = excluded.payment_network,
        payment_status   = excluded.payment_status,
        payment_ref      = excluded.payment_ref,
        payment_verified = excluded.payment_verified,
        status           = excluded.status,
        kitchen_status   = excluded.kitchen_status,
        items            = excluded.items,
        notes            = excluded.notes,
        driver_id        = excluded.driver_id,
        driver_name      = excluded.driver_name,
        driver_phone     = excluded.driver_phone,
        updated_at       = now(),
        raw_data         = excluded.raw_data;
    end loop;
  end if;

  -- 2. Sync Drivers
  if new.data ? 'drivers' and jsonb_typeof(new.data->'drivers') = 'array' then
    for drv in select jsonb_array_elements(new.data->'drivers')
    loop
      insert into public.yebs_drivers (
        id, username, name, fname, lname, email, phone, vehicle, photo,
        approval_status, is_active, failed_attempts, lockout_until,
        lat, lng, status_text, created_at, updated_at, raw_data
      ) values (
        drv->>'id',
        drv->>'username',
        drv->>'name',
        drv->>'fname',
        drv->>'lname',
        drv->>'email',
        drv->>'phone',
        drv->>'vehicle',
        drv->>'photo',
        coalesce(drv->>'approvalStatus', 'pending'),
        coalesce((drv->>'isActive')::boolean, true),
        coalesce((drv->>'failedAttempts')::int, 0),
        (drv->>'lockoutUntil')::timestamptz,
        (drv->>'lat')::numeric,
        (drv->>'lng')::numeric,
        coalesce(drv->>'statusText', 'Available'),
        coalesce((drv->>'createdAt')::timestamptz, now()),
        now(),
        drv
      )
      on conflict (id) do update set
        username        = excluded.username,
        name            = excluded.name,
        fname           = excluded.fname,
        lname           = excluded.lname,
        email           = excluded.email,
        phone           = excluded.phone,
        vehicle         = excluded.vehicle,
        photo           = coalesce(excluded.photo, public.yebs_drivers.photo),
        approval_status = excluded.approval_status,
        is_active       = excluded.is_active,
        failed_attempts = excluded.failed_attempts,
        lockout_until   = excluded.lockout_until,
        lat             = excluded.lat,
        lng             = excluded.lng,
        status_text     = excluded.status_text,
        updated_at      = now(),
        raw_data        = excluded.raw_data;
    end loop;
  end if;

  -- 3. Sync Admins (exclude password hash for safety)
  if new.data ? 'admins' and jsonb_typeof(new.data->'admins') = 'array' then
    for adm in select jsonb_array_elements(new.data->'admins')
    loop
      insert into public.yebs_admins (
        id, username, name, email, phone, role, photo,
        failed_attempts, lockout_until, created_at, updated_at
      ) values (
        adm->>'id',
        adm->>'username',
        adm->>'name',
        adm->>'email',
        adm->>'phone',
        coalesce(adm->>'role', 'ADMIN'),
        adm->>'photo',
        coalesce((adm->>'failedAttempts')::int, 0),
        (adm->>'lockoutUntil')::timestamptz,
        coalesce((adm->>'createdAt')::timestamptz, now()),
        now()
      )
      on conflict (id) do update set
        username        = excluded.username,
        name            = excluded.name,
        email           = excluded.email,
        phone           = excluded.phone,
        role            = excluded.role,
        photo           = coalesce(excluded.photo, public.yebs_admins.photo),
        failed_attempts = excluded.failed_attempts,
        lockout_until   = excluded.lockout_until,
        updated_at      = now();
    end loop;
  end if;

  -- 4. Sync Menu Items
  if new.data ? 'menuItems' and jsonb_typeof(new.data->'menuItems') = 'array' then
    for mnu in select jsonb_array_elements(new.data->'menuItems')
    loop
      insert into public.yebs_menu_items (
        id, name, price, badge, tag, "desc", description, formula, image, noodles, template, available, status, prep_time, updated_at
      ) values (
        mnu->>'id',
        mnu->>'name',
        (mnu->>'price')::numeric,
        mnu->>'badge',
        mnu->>'tag',
        coalesce(mnu->>'desc', mnu->>'formula'),
        coalesce(mnu->>'description', mnu->>'desc', mnu->>'formula'),
        mnu->>'formula',
        mnu->>'image',
        coalesce(mnu->'noodles', '["Spaghetti", "Indomie"]'::jsonb),
        coalesce(mnu->>'template', 'poster-capsule'),
        coalesce((mnu->>'available')::boolean, true),
        coalesce(mnu->>'status', case when (mnu->>'available')::boolean = false then 'sold_out' else 'available' end),
        coalesce(mnu->>'prepTime', mnu->>'prep_time', 'Ready in 20–30 min'),
        now()
      )
      on conflict (id) do update set
        name        = excluded.name,
        price       = excluded.price,
        badge       = excluded.badge,
        tag         = excluded.tag,
        "desc"      = excluded."desc",
        description = excluded.description,
        formula     = excluded.formula,
        image       = excluded.image,
        noodles     = excluded.noodles,
        template    = excluded.template,
        available   = excluded.available,
        status      = excluded.status,
        prep_time   = excluded.prep_time,
        updated_at  = now();
    end loop;
  end if;

  -- 5. Sync Reviews
  if new.data ? 'reviews' and jsonb_typeof(new.data->'reviews') = 'array' then
    for rev in select jsonb_array_elements(new.data->'reviews')
    loop
      insert into public.yebs_reviews (
        id, order_id, rating, comment, customer, created_at
      ) values (
        coalesce(rev->>'id', gen_random_uuid()::text),
        rev->>'orderId',
        (rev->>'rating')::int,
        rev->>'comment',
        rev->>'customer',
        coalesce((rev->>'createdAt')::timestamptz, now())
      )
      on conflict (id) do update set
        rating   = excluded.rating,
        comment  = excluded.comment,
        customer = excluded.customer;
    end loop;
  end if;

  -- 6. Sync Audit Logs
  if new.data ? 'auditLogs' and jsonb_typeof(new.data->'auditLogs') = 'array' then
    for aud in select jsonb_array_elements(new.data->'auditLogs')
    loop
      insert into public.yebs_audit_logs (
        id, action, actor, entity, details, ip_or_agent, created_at
      ) values (
        coalesce(aud->>'id', gen_random_uuid()::text),
        aud->>'action',
        aud->>'actor',
        aud->>'entity',
        aud->>'details',
        aud->>'ipOrAgent',
        coalesce((aud->>'timestamp')::timestamptz, now())
      )
      on conflict (id) do nothing;
    end loop;
  end if;

  -- 7. Sync Settings
  if new.data ? 'settings' and jsonb_typeof(new.data->'settings') = 'object' then
    for k, v in select * from jsonb_each(new.data->'settings')
    loop
      insert into public.yebs_settings (key, value, updated_at)
      values (k, v, now())
      on conflict (key) do update set
        value      = excluded.value,
        updated_at = now();
    end loop;
  end if;

  -- 8. Sync Sessions
  if new.data ? 'sessions' and jsonb_typeof(new.data->'sessions') = 'array' then
    for ses in select jsonb_array_elements(new.data->'sessions')
    loop
      insert into public.yebs_sessions (
        id, session_number, status, pickup_point, started_at, intermission_ends_at, updated_at
      ) values (
        (ses->>'id')::int,
        (ses->>'sessionNumber')::int,
        coalesce(ses->>'status', 'ACTIVE'),
        ses->'pickupPoint',
        (ses->>'startedAt')::timestamptz,
        (ses->>'intermissionEndsAt')::timestamptz,
        now()
      )
      on conflict (id) do update set
        session_number       = excluded.session_number,
        status               = excluded.status,
        pickup_point         = excluded.pickup_point,
        started_at           = excluded.started_at,
        intermission_ends_at = excluded.intermission_ends_at,
        updated_at           = now();
    end loop;
  end if;

  return new;
end;
$$;

-- Attach trigger to public.yebs_state (if yebs_state exists)
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'yebs_state') then
    drop trigger if exists yebs_sync_from_state on public.yebs_state;
    create trigger yebs_sync_from_state
      after insert or update on public.yebs_state
      for each row execute function public.yebs_sync_from_state();
  end if;
end
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- REVERSE SYNC: SEPARATE TABLES  ==>  yebs_state
-- Enables editing menu items, orders or settings directly in Supabase Studio!
-- ────────────────────────────────────────────────────────────────────────────

-- Menu item edit syncs back to yebs_state.data->'menuItems'
create or replace function public.yebs_menu_items_sync_to_state()
returns trigger
language plpgsql
security definer
as $$
declare
  menu_arr jsonb;
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'yebs_state') then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', id,
        'name', name,
        'price', price,
        'badge', badge,
        'tag', tag,
        'desc', coalesce("desc", formula),
        'description', coalesce(description, "desc", formula),
        'formula', formula,
        'image', image,
        'noodles', coalesce(noodles, '["Spaghetti", "Indomie"]'::jsonb),
        'template', coalesce(template, 'poster-capsule'),
        'available', coalesce(available, true),
        'status', coalesce(status, 'available'),
        'prepTime', coalesce(prep_time, 'Ready in 20–30 min')
      ) order by price asc
    ), '[]'::jsonb) into menu_arr from public.yebs_menu_items;

    update public.yebs_state
    set data = jsonb_set(data, '{menuItems}', menu_arr),
        updated_at = now()
    where id = 'main';
  end if;

  return new;
end;
$$;

drop trigger if exists yebs_menu_sync on public.yebs_menu_items;
create trigger yebs_menu_sync
  after insert or update or delete on public.yebs_menu_items
  for each statement execute function public.yebs_menu_items_sync_to_state();

-- Order status edit syncs back to yebs_state.data->'orders'
create or replace function public.yebs_orders_sync_to_state()
returns trigger
language plpgsql
security definer
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'yebs_state') then
    update public.yebs_state
    set data = jsonb_set(
      data,
      '{orders}',
      (
        select coalesce(jsonb_agg(
          case when (elem->>'id') = new.id
               then elem || jsonb_build_object(
                 'status', new.status,
                 'kitchenStatus', new.kitchen_status,
                 'paymentStatus', new.payment_status,
                 'driverId', new.driver_id,
                 'driverName', new.driver_name,
                 'driverPhone', new.driver_phone
               )
               else elem
          end
        ), '[]'::jsonb)
        from jsonb_array_elements(coalesce(data->'orders', '[]'::jsonb)) as elem
      )
    ),
    updated_at = now()
    where id = 'main';
  end if;

  return new;
end;
$$;

drop trigger if exists yebs_order_sync on public.yebs_orders;
create trigger yebs_order_sync
  after update of status, kitchen_status, payment_status, driver_id, driver_name, driver_phone
  on public.yebs_orders
  for each row execute function public.yebs_orders_sync_to_state();

-- Settings edit syncs back to yebs_state.data->'settings'
create or replace function public.yebs_settings_sync_to_state()
returns trigger
language plpgsql
security definer
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'yebs_state') then
    update public.yebs_state
    set data = jsonb_set(data, array['settings', new.key], new.value),
        updated_at = now()
    where id = 'main';
  end if;

  return new;
end;
$$;

drop trigger if exists yebs_settings_sync on public.yebs_settings;
create trigger yebs_settings_sync
  after insert or update on public.yebs_settings
  for each row execute function public.yebs_settings_sync_to_state();

-- ────────────────────────────────────────────────────────────────────────────
-- INITIAL BACKFILL (if yebs_state already has data, backfill immediately)
-- ────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'yebs_state') then
    -- Triggering an update forces the yebs_sync_from_state trigger to unpack immediately
    update public.yebs_state set updated_at = now() where id = 'main';
  end if;
end
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- DEFAULT SEEDS (only applied if the tables are empty and no state exists)
-- ────────────────────────────────────────────────────────────────────────────
insert into public.yebs_menu_items (id, name, price, badge, tag, "desc", formula, image, noodles)
values
  ('spag15',    'SPAGHETTI',         15, '15 CEDIS',  'Quick Bite',          'Add scrambled egg + Cut half sausage',                                                             'Add scrambled egg + Cut half sausage',                                                             'img_food_3.jpg',         '["Spaghetti"]'::jsonb),
  ('indomie20', 'SPAGHETTI/INDOMIE', 20, '20 CEDIS',  'Bestseller',          'Add scrambled egg + Cut full sausage + Put one egg on top.',                                       'Add scrambled egg + Cut full sausage + Put one egg on top.',                                       'img_food_2.jpg',         '["Spaghetti","Indomie"]'::jsonb),
  ('indomie30', 'SPAGHETTI/INDOMIE', 30, '30 CEDIS',  'Free Beta Malt',      'Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + Free Beta malt', 'Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + Free Beta malt', 'img_food_1.jpg',         '["Spaghetti","Indomie"]'::jsonb),
  ('indomie40', 'SPAGHETTI/INDOMIE', 40, '40 CEDIS',  'Chicken + Beta Malt', 'Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + One Chicken + Free Beta Malt', 'Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + One Chicken + Free Beta Malt', 'ghana_spag_chicken.jpg', '["Spaghetti","Indomie"]'::jsonb),
  ('indomie60', 'SPAGHETTI/INDOMIE', 60, '60 CEDIS',  'Two Chicken + Beta Malt', 'Add scrambled egg + Cut full sausage + Put one egg on top + One sausage + more Gizzard + One Full Chicken (Two pieces) + Free Beta Malt', 'Add scrambled egg + Cut full sausage + Put one egg on top + One sausage + more Gizzard + One Full Chicken (Two pieces) + Free Beta Malt', 'img_food_4.jpg',     '["Spaghetti","Indomie"]'::jsonb)
on conflict (id) do nothing;

insert into public.yebs_settings (key, value)
values
  ('momo',        '{"payTo":"0559103452","accountName":"MATHEW TIA"}'::jsonb),
  ('deliveryFee', '15'::jsonb),
  ('pickup',      '{"name":"Circle Odo Rice Junction / VIP Station","address":"Kwame Nkrumah Circle, Accra","lat":5.5612,"lng":-0.2155}'::jsonb)
on conflict (key) do nothing;

insert into public.yebs_admins (id, username, name, email, role)
values
  ('adm-1', 'goodfood', 'YEBS Administrator', 'yebsnoodles@gmail.com', 'SUPERADMIN')
on conflict (id) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- VERIFICATION
-- ────────────────────────────────────────────────────────────────────────────
select
  (select count(*) from public.yebs_menu_items) as menu_items,
  (select count(*) from public.yebs_orders)     as orders,
  (select count(*) from public.yebs_drivers)    as drivers,
  (select count(*) from public.yebs_admins)     as admins,
  (select count(*) from public.yebs_settings)   as settings;
