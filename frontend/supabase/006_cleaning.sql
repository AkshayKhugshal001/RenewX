-- RenewX 006: soiling, cleaning and cooling analysis
-- Run once in Supabase → SQL Editor (after 005). Safe to run again.

-- Cleaning costs per plant (editable in "Edit plant"; defaults are rough assumptions)
alter table public.plants
  add column if not exists cleaning_cost_inr_per_mw numeric(12, 2) not null default 6000 check (cleaning_cost_inr_per_mw >= 0),
  add column if not exists cleaning_water_l_per_mw  numeric(12, 1) not null default 4000 check (cleaning_water_l_per_mw >= 0);

-- Per day: measured cleanliness (actual ÷ expected on clear days) and the modelled soiling loss
alter table public.daily_summaries
  add column if not exists cleanliness_index double precision,
  add column if not exists soiling_loss_pct  double precision;

-- One row per analysis run (written by the backend; the page shows the latest)
create table if not exists public.cleaning_analyses (
  id                     uuid primary key default gen_random_uuid(),
  plant_id               uuid not null references public.plants (id) on delete cascade,
  created_at             timestamptz not null default now(),
  as_of                  date,                 -- latest day with data
  rate_pct_per_day       double precision,
  rate_source            text check (rate_source in ('measured', 'assumed')),
  days_since_reset       integer,
  last_reset             date,
  last_reset_reason      text,                 -- rain | cleaning | gap | start
  action                 text check (action in ('clean_now', 'clean_in', 'wait_rain', 'not_needed')),
  due_date               date,
  loss_pct               double precision,
  daily_loss_inr         double precision,
  cleaning_cost_inr      double precision,
  optimal_interval_days  double precision,
  result                 jsonb not null default '{}'::jsonb   -- full plan, projection, cooling, rate details
);
create index if not exists cleaning_analyses_plant_idx on public.cleaning_analyses (plant_id, created_at desc);

alter table public.cleaning_analyses enable row level security;
revoke all on public.cleaning_analyses from anon, authenticated;
grant select on public.cleaning_analyses to authenticated;
drop policy if exists "cleaning: read own plants" on public.cleaning_analyses;
create policy "cleaning: read own plants" on public.cleaning_analyses for select to authenticated
  using (plant_id in (select id from public.plants where owner_id = (select auth.uid())));
