-- ============================================================================
-- YEBS Noodles - Supabase setup
-- ----------------------------------------------------------------------------
-- HOW TO RUN
--   1. Open https://supabase.com/dashboard/project/dujmpwcarxliadnfdydr/sql/new
--   2. Paste this whole file and press Run.
--   3. You should see: menu_items = 5, admins = 1.
--
-- This file is safe to re-run. It never deletes orders, drivers, reviews or
-- menu edits. It only creates the table and makes sure the admin exists.
--
-- Admin login after running:  goodfood / goodfood@123
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
values ('main', $yebs${
  "admins": [
    {
      "id": "adm-1",
      "username": "goodfood",
      "password": "$2b$10$LQ5qmL..JgZPXbT6MjMIjeGngwFeSIVZ.QLn9DUHyP67hpdTtaV3S",
      "name": "YEBS Administrator",
      "role": "SUPERADMIN",
      "createdAt": "2026-10-28T11:24:04.828Z"
    }
  ],
  "drivers": [],
  "orders": [],
  "sessions": [
    {
      "id": 1,
      "sessionNumber": 1,
      "status": "ACTIVE",
      "startedAt": "2026-10-28T11:24:04.828Z",
      "intermissionEndsAt": null,
      "pickupPoint": {
        "name": "Circle Odo Rice Junction / VIP Station",
        "address": "Kwame Nkrumah Circle, Accra",
        "lat": 5.5612,
        "lng": -0.2155,
        "updatedAt": "2026-10-28T11:24:04.828Z"
      }
    }
  ],
  "auditLogs": [
    {
      "id": "log-init",
      "timestamp": "2026-10-28T11:24:04.828Z",
      "action": "SYSTEM_INITIALIZED",
      "actor": "SYSTEM",
      "entity": "DATABASE",
      "details": "YEBS Noodles Supabase state initialised."
    }
  ],
  "menuItems": [
    {
      "id": "spag15",
      "name": "SPAGHETTI",
      "price": 15,
      "noodles": [
        "Spaghetti"
      ],
      "formula": "Add scrambled egg + Cut half sausage",
      "desc": "= Add scrambled egg + Cut half sausage",
      "image": "img_food_3.jpg",
      "badge": "15 CEDIS",
      "tag": "Quick Bite",
      "template": "poster-capsule"
    },
    {
      "id": "indomie20",
      "name": "SPAGHETTI / INDOMIE",
      "price": 20,
      "noodles": [
        "Spaghetti",
        "Indomie"
      ],
      "formula": "Add scrambled egg + Cut full sausage + Put one egg on top.",
      "desc": "= Add scrambled egg + Cut full sausage + Put one egg on top.",
      "image": "img_food_2.jpg",
      "badge": "20 CEDIS",
      "tag": "Bestseller",
      "template": "poster-capsule"
    },
    {
      "id": "indomie30",
      "name": "SPAGHETTI / INDOMIE",
      "price": 30,
      "noodles": [
        "Spaghetti",
        "Indomie"
      ],
      "formula": "Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + Free Beta malt",
      "desc": "= Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + Free Beta malt",
      "image": "img_food_1.jpg",
      "badge": "30 CEDIS",
      "tag": "Free Beta Malt",
      "template": "poster-capsule"
    },
    {
      "id": "indomie40",
      "name": "SPAGHETTI / INDOMIE",
      "price": 40,
      "noodles": [
        "Spaghetti",
        "Indomie"
      ],
      "formula": "Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + One Chicken + Free Beta Malt",
      "desc": "= Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + One Chicken + Free Beta Malt",
      "image": "ghana_spag_chicken.jpg",
      "badge": "40 CEDIS",
      "tag": "Chicken + Beta Malt",
      "template": "poster-capsule"
    },
    {
      "id": "indomie60",
      "name": "SPAGHETTI / INDOMIE",
      "price": 60,
      "noodles": [
        "Spaghetti",
        "Indomie"
      ],
      "formula": "Add scrambled egg + Cut full sausage + Put one egg on top + One sausage + more Gizzard + One Full Chicken (Two pieces) + Free Beta Malt",
      "desc": "= Add scrambled egg + Cut full sausage + Put one egg on top + One sausage + more Gizzard + One Full Chicken (Two pieces) + Free Beta Malt",
      "image": "img_food_4.jpg",
      "badge": "60 CEDIS",
      "tag": "Two Chicken + Beta Malt",
      "template": "poster-capsule"
    }
  ],
  "settings": {
    "momo": {
      "payTo": "0559103452",
      "accountName": "MATHEW TIA"
    },
    "pickup": {
      "name": "Circle Odo Rice Junction / VIP Station",
      "address": "Kwame Nkrumah Circle, Accra",
      "lat": 5.5612,
      "lng": -0.2155
    },
    "deliveryFee": 15
  },
  "payouts": [],
  "reviews": [],
  "notifications": []
}$yebs$::jsonb)
on conflict (id) do nothing;

-- If the app already created the row, add the admin without touching orders.
update public.yebs_state
set data = jsonb_set(
      data,
      '{admins}',
      coalesce(data->'admins', '[]'::jsonb) || $admin$[{"id":"adm-1","username":"goodfood","password":"$2b$10$LQ5qmL..JgZPXbT6MjMIjeGngwFeSIVZ.QLn9DUHyP67hpdTtaV3S","name":"YEBS Administrator","role":"SUPERADMIN","createdAt":"2026-10-28T11:24:04.828Z"}]$admin$::jsonb
    ),
    updated_at = now()
where id = 'main'
  and not exists (
    select 1
    from jsonb_array_elements(coalesce(data->'admins', '[]'::jsonb)) as a
    where lower(a->>'username') = lower('goodfood')
  );

-- Verification: expect menu_items = 5, admins >= 1.
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
