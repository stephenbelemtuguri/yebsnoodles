-- YEBS Noodles - Supabase setup
-- Run this once in Supabase Dashboard -> SQL Editor -> New query -> Run.
-- The app can also create this table itself when DATABASE_URL is configured
-- (see scripts/setup-supabase.js and the Postgres mode in src/data/store.js).

-- The Express API keeps its data in one JSON document (same shape as
-- database.json). This table stores that document so orders, drivers and the
-- menu survive cold starts on Netlify and restarts on Render.

create table if not exists public.yebs_state (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Row Level Security on, with no policies:
-- anon/publishable clients get nothing; service_role and the Postgres
-- connection (table owner) bypass RLS.
alter table public.yebs_state enable row level security;

-- Keep updated_at fresh on every write.
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

-- Optional first row. The API writes this automatically when the table is
-- empty, so this is only useful if you want to inspect it immediately.
-- insert into public.yebs_state (id, data)
-- values ('main', '{}'::jsonb)
-- on conflict (id) do nothing;
