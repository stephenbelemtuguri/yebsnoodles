-- ============================================================================
-- YEBS Noodles - Supabase setup
-- ----------------------------------------------------------------------------
-- HOW TO RUN
--   1. Open https://supabase.com/dashboard/project/dujmpwcarxliadnfdydr/sql/new
--   2. Paste this whole file and press Run.
--   3. You should see: menu_items = 5.
--
-- This file is safe to re-run. It never deletes orders, drivers, reviews or
-- menu edits.
--
-- ADMIN ACCOUNT
--   No password is stored in this file. On first boot the API creates the
--   administrator from ADMIN_USERNAME and ADMIN_PASSWORD in the environment:
--
--     ADMIN_USERNAME=your-admin-name
--     ADMIN_PASSWORD=a-strong-password
--
--   Set the same variables in Render / Netlify, or run the app once with them
--   in .env. Change the password from Admin -> Settings after the first login.
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

-- First row: menu, pickup point, MoMo wallet, settings and admin account.
insert into public.yebs_state (id, data)
values ('main', $yebs${
  "admins": [
    {
      "id": "adm-1",
      "username": "goodfood",
      "password": "$2b$10$Sdgu6IAuF7SS8redQCJ1sO65HB11C/o1sAKaVCZ8FgtmwOOv/ZSBC",
      "name": "YEBS Administrator",
      "role": "SUPERADMIN",
      "createdAt": "2026-10-28T14:51:00.943Z"
    }
  ],
  "orders": [],
  "drivers": [],
  "payouts": [],
  "reviews": [],
  "sessions": [
    {
      "id": 1,
      "status": "ACTIVE",
      "startedAt": "2026-10-28T11:24:04.828Z",
      "pickupPoint": {
        "lat": 5.5612,
        "lng": -0.2155,
        "name": "Circle Odo Rice Junction / VIP Station",
        "address": "Kwame Nkrumah Circle, Accra",
        "updatedAt": "2026-10-28T11:24:04.828Z"
      },
      "sessionNumber": 1,
      "intermissionEndsAt": null
    }
  ],
  "settings": {
    "momo": {
      "payTo": "0559103452",
      "accountName": "MATHEW TIA"
    },
    "pickup": {
      "lat": 5.5612,
      "lng": -0.2155,
      "name": "Circle Odo Rice Junction / VIP Station",
      "address": "Kwame Nkrumah Circle, Accra"
    },
    "deliveryFee": 15
  },
  "auditLogs": [
    {
      "id": "log-init",
      "actor": "SYSTEM",
      "action": "SYSTEM_INITIALIZED",
      "entity": "DATABASE",
      "details": "YEBS Noodles Supabase state initialised.",
      "timestamp": "2026-10-28T11:24:04.828Z"
    }
  ],
  "menuItems": [
    {
      "id": "spag15",
      "tag": "Quick Bite",
      "desc": "= Add scrambled egg + Cut half sausage",
      "name": "SPAGHETTI",
      "badge": "15 CEDIS",
      "image": "img_food_3.jpg",
      "price": 15,
      "formula": "Add scrambled egg + Cut half sausage",
      "noodles": [
        "Spaghetti"
      ],
      "template": "poster-capsule"
    },
    {
      "id": "indomie20",
      "tag": "Bestseller",
      "desc": "= Add scrambled egg + Cut full sausage + Put one egg on top.",
      "name": "SPAGHETTI / INDOMIE",
      "badge": "20 CEDIS",
      "image": "img_food_2.jpg",
      "price": 20,
      "formula": "Add scrambled egg + Cut full sausage + Put one egg on top.",
      "noodles": [
        "Spaghetti",
        "Indomie"
      ],
      "template": "poster-capsule"
    },
    {
      "id": "indomie30",
      "tag": "Free Beta Malt",
      "desc": "= Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + Free Beta malt",
      "name": "SPAGHETTI / INDOMIE",
      "badge": "30 CEDIS",
      "image": "img_food_1.jpg",
      "price": 30,
      "formula": "Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + Free Beta malt",
      "noodles": [
        "Spaghetti",
        "Indomie"
      ],
      "template": "poster-capsule"
    },
    {
      "id": "indomie40",
      "tag": "Chicken + Beta Malt",
      "desc": "= Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + One Chicken + Free Beta Malt",
      "name": "SPAGHETTI / INDOMIE",
      "badge": "40 CEDIS",
      "image": "ghana_spag_chicken.jpg",
      "price": 40,
      "formula": "Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + One Chicken + Free Beta Malt",
      "noodles": [
        "Spaghetti",
        "Indomie"
      ],
      "template": "poster-capsule"
    },
    {
      "id": "indomie60",
      "tag": "Two Chicken + Beta Malt",
      "desc": "= Add scrambled egg + Cut full sausage + Put one egg on top + One sausage + more Gizzard + One Full Chicken (Two pieces) + Free Beta Malt",
      "name": "SPAGHETTI / INDOMIE",
      "badge": "60 CEDIS",
      "image": "img_food_4.jpg",
      "price": 60,
      "formula": "Add scrambled egg + Cut full sausage + Put one egg on top + One sausage + more Gizzard + One Full Chicken (Two pieces) + Free Beta Malt",
      "noodles": [
        "Spaghetti",
        "Indomie"
      ],
      "template": "poster-capsule"
    }
  ],
  "notifications": [
    {
      "id": "ntf-1793190291060-424",
      "orderId": "YB-1460",
      "channel": "whatsapp",
      "to": "233559103452",
      "createdAt": "2026-10-28T12:24:51.060Z",
      "status": "not-configured",
      "message": "NEW YEBS NOODLES ORDER #YB-1460\nCustomer: Supabase Connection Test\nPhone: 0550000001\nFulfilment: Collection\nLocation: Circle Odo Rice Junction / VIP Station\nItems: 1 x SPAGHETTI\nTotal: GH15.00\nPayment: MTN Mobile Money (unpaid)\nOrder ID / PIN: YB-1460 / 1460",
      "reason": "Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID to send kitchen alerts automatically."
    }
  ]
}$yebs$::jsonb)
on conflict (id) do nothing;

-- If the row already exists, make sure the goodfood administrator is present.
update public.yebs_state
set data = jsonb_set(
      data,
      '{admins}',
      coalesce(data->'admins', '[]'::jsonb) || $admin$[{"id":"adm-1","username":"goodfood","password":"$2b$10$Sdgu6IAuF7SS8redQCJ1sO65HB11C/o1sAKaVCZ8FgtmwOOv/ZSBC","name":"YEBS Administrator","role":"SUPERADMIN","createdAt":"2026-10-28T14:51:00.943Z"}]$admin$::jsonb
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
-- Optional: create the admin directly in SQL
--   1. Generate a bcrypt hash locally (never commit the password):
--        node -e "console.log(require('bcryptjs').hashSync('YOUR-PASSWORD',10))"
--   2. Replace HASH and ADMIN_NAME below and run:
--        update public.yebs_state
--        set data = jsonb_set(
--              data,
--              '{admins}',
--              coalesce(data->'admins', '[]'::jsonb) ||
--              '[{"id":"adm-1","username":"ADMIN_NAME","password":"HASH","name":"YEBS Administrator","role":"SUPERADMIN"}]'::jsonb
--            )
--        where id = 'main';
-- ----------------------------------------------------------------------------
