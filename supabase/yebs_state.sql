-- ═══════════════════════════════════════════════════════════════════════════
-- YEBS Noodles — Supabase setup
-- Run this once in Supabase Dashboard > SQL Editor > New query > Run.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The Express API keeps its data in one JSON document (the same shape as
-- database.json). This table stores that document so orders, drivers and the
-- menu survive cold starts on Netlify.
--
-- Access is limited to the secret / service_role key, which the Netlify
-- Function sends server-side. The publishable key cannot read or write it.

create table if not exists public.yebs_state (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Row Level Security on, with no policies:
-- anon/publishable clients get nothing; service_role bypasses RLS.
alter table public.yebs_state enable row level security;

-- Optional: keep updated_at fresh on every write.
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
