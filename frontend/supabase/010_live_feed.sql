-- 010: Live data feed (simulated device → ingest API). Run once in Supabase → SQL Editor.
--
-- A plant is either fed manually (CSV uploads) or live (a device sends readings to POST /ingest).
-- Devices authenticate with a secret key. Only its SHA-256 hash is stored, so a database leak does not
-- reveal usable keys. Keys are CREATED by the backend (it shows the raw key once); the browser can only
-- list, rename and revoke them.

-- 1. Data input mode per plant
alter table public.plants
  add column if not exists data_mode text not null default 'manual';
alter table public.plants drop constraint if exists plants_data_mode_check;
alter table public.plants add  constraint plants_data_mode_check check (data_mode in ('manual', 'live'));

-- 2. Device keys
create table if not exists public.device_keys (
  id            uuid primary key default gen_random_uuid(),
  plant_id      uuid not null references public.plants (id) on delete cascade,
  name          text not null default 'Phone device' check (char_length(name) between 1 and 60),
  key_hash      text not null unique,          -- sha256(raw key), hex
  key_prefix    text not null,                 -- first characters of the key, shown in the list ("rx_ab12…")
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,                   -- last successful ingest
  readings_sent integer not null default 0,
  revoked_at    timestamptz                    -- set = key no longer accepted
);
create index if not exists device_keys_plant_idx on public.device_keys (plant_id, created_at desc);

-- 3. RLS: owners see and revoke keys of their own plants; no inserts/deletes from the browser
alter table public.device_keys enable row level security;

drop policy if exists "device_keys: read own" on public.device_keys;
create policy "device_keys: read own" on public.device_keys for select
  using (exists (select 1 from public.plants p where p.id = plant_id and p.owner_id = (select auth.uid())));

drop policy if exists "device_keys: update own" on public.device_keys;
create policy "device_keys: update own" on public.device_keys for update
  using (exists (select 1 from public.plants p where p.id = plant_id and p.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.plants p where p.id = plant_id and p.owner_id = (select auth.uid())));

-- Column-level limits: the browser never reads key_hash and may only change the name and revoked_at.
revoke select, insert, update, delete on public.device_keys from anon, authenticated;
grant select (id, plant_id, name, key_prefix, created_at, last_seen_at, readings_sent, revoked_at)
  on public.device_keys to authenticated;
grant update (name, revoked_at) on public.device_keys to authenticated;
