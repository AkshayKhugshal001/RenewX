-- RenewX · Step 2: data pipeline tables
-- Run once in Supabase → SQL Editor (after schema.sql).
-- Reads:  the logged-in user can READ only their own plants' data (RLS).
-- Writes: done only by the FastAPI backend through its own database connection (bypasses RLS).
--         The browser can never insert or change readings or results.

begin;

-- ─────────────────────────────────────────────────────────────
-- 1. plants: extra settings needed for analysis
-- ─────────────────────────────────────────────────────────────
alter table public.plants
  add column if not exists latitude           double precision check (latitude  between -90  and 90),
  add column if not exists longitude          double precision check (longitude between -180 and 180),
  add column if not exists timezone           text    not null default 'Asia/Kolkata',
  add column if not exists tariff_inr_per_kwh numeric not null default 0 check (tariff_inr_per_kwh >= 0);

-- capacity_mw already exists; it must not be negative
alter table public.plants drop constraint if exists plants_capacity_check;
alter table public.plants add  constraint plants_capacity_check check (capacity_mw >= 0);

alter table public.plants drop constraint if exists plants_status_check;
alter table public.plants add  constraint plants_status_check check (status in ('online', 'offline'));

-- one plant name per user (the frontend already shows a friendly message for this)
alter table public.plants drop constraint if exists plants_owner_name_key;
alter table public.plants add  constraint plants_owner_name_key unique (owner_id, name);

-- ─────────────────────────────────────────────────────────────
-- 2. data_uploads: one row per CSV upload (history + progress + report)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.data_uploads (
  id             uuid primary key default gen_random_uuid(),
  plant_id       uuid not null references public.plants (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  file_name      text not null,
  kind           text not null check (kind in ('historical', 'daily')),
  mode           text not null default 'skip' check (mode in ('skip', 'replace')),  -- what to do with rows that already exist
  status         text not null default 'processing' check (status in ('processing', 'done', 'failed')),
  rows_total     integer not null default 0,
  rows_inserted  integer not null default 0,
  rows_updated   integer not null default 0,
  rows_skipped   integer not null default 0,   -- already existed (mode = skip)
  rows_rejected  integer not null default 0,   -- invalid timestamp / values
  ts_from        timestamptz,
  ts_to          timestamptz,
  report         jsonb not null default '{}'::jsonb,  -- warnings, column mapping, fixes applied
  error          text,
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index if not exists data_uploads_plant_idx on public.data_uploads (plant_id, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- 3. plant_readings: cleaned 15-minute plant-level data
--    Primary key (plant_id, ts) = no duplicates; daily uploads simply append.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.plant_readings (
  plant_id          uuid not null references public.plants (id) on delete cascade,
  ts                timestamptz not null,           -- stored in UTC
  dc_power_kw       double precision,
  ac_power_kw       double precision,
  daily_yield_kwh   double precision,
  total_yield_kwh   double precision,
  active_inverters  smallint,
  ambient_temp_c    double precision,
  module_temp_c     double precision,
  irradiation_kw_m2 double precision,
  quality_flags     text[] not null default '{}',    -- e.g. {missing_weather, dc_unit_fixed, low_inverters}
  upload_id         uuid references public.data_uploads (id) on delete set null,
  primary key (plant_id, ts)
);

-- ─────────────────────────────────────────────────────────────
-- 4. daily_summaries: pre-computed per-day statistics (dashboard reads these)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.daily_summaries (
  plant_id               uuid not null references public.plants (id) on delete cascade,
  day                    date not null,             -- local date in the plant's timezone
  energy_kwh             double precision,          -- ∫ AC power
  dc_energy_kwh          double precision,
  peak_ac_kw             double precision,
  insolation_kwh_m2      double precision,          -- ∫ irradiation
  specific_yield_kwh_kwp double precision,          -- energy / capacity
  performance_ratio      double precision,          -- 0–1
  availability_pct       double precision,
  inverter_eff_pct       double precision,
  avg_ambient_temp_c     double precision,
  avg_module_temp_c      double precision,
  max_module_temp_c      double precision,
  thermal_loss_kwh       double precision,
  inverter_loss_kwh      double precision,
  revenue_inr            double precision,
  co2_avoided_kg         double precision,
  readings_count         integer not null default 0,
  data_completeness_pct  double precision,
  alarm_count            integer not null default 0,
  computed_at            timestamptz not null default now(),
  primary key (plant_id, day)
);

-- ─────────────────────────────────────────────────────────────
-- 5. anomalies: rule-based alarms now, ML anomalies later (same table)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.anomalies (
  id               uuid primary key default gen_random_uuid(),
  plant_id         uuid not null references public.plants (id) on delete cascade,
  source           text not null default 'rule' check (source in ('rule', 'ml')),
  type             text not null,     -- underperformance | data_gap | sensor_fault | inverter_dropout ...
  severity         text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  ts_start         timestamptz not null,
  ts_end           timestamptz not null,
  score            double precision,
  expected_kw      double precision,
  actual_kw        double precision,
  energy_lost_kwh  double precision,
  explanation      text,
  status           text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  upload_id        uuid references public.data_uploads (id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (plant_id, type, ts_start)   -- re-running analysis won't duplicate alarms
);
create index if not exists anomalies_plant_idx on public.anomalies (plant_id, ts_start desc);

-- ─────────────────────────────────────────────────────────────
-- 6. weather_data: from a weather API (Open-Meteo), hourly
-- ─────────────────────────────────────────────────────────────
create table if not exists public.weather_data (
  plant_id          uuid not null references public.plants (id) on delete cascade,
  source            text not null default 'open-meteo',
  ts                timestamptz not null,
  ghi_w_m2          double precision,   -- shortwave radiation
  temp_c            double precision,
  cloud_cover_pct   double precision,
  precipitation_mm  double precision,
  humidity_pct      double precision,
  wind_speed_ms     double precision,
  fetched_at        timestamptz not null default now(),
  primary key (plant_id, source, ts)
);

-- ─────────────────────────────────────────────────────────────
-- 7. Security: read-only for users, scoped to their own plants
-- ─────────────────────────────────────────────────────────────
alter table public.data_uploads    enable row level security;
alter table public.plant_readings  enable row level security;
alter table public.daily_summaries enable row level security;
alter table public.anomalies       enable row level security;
alter table public.weather_data    enable row level security;

-- browser roles get SELECT only (writes come from the backend)
revoke all on public.data_uploads, public.plant_readings, public.daily_summaries,
              public.anomalies, public.weather_data from anon, authenticated;
grant select on public.data_uploads, public.plant_readings, public.daily_summaries,
                public.anomalies, public.weather_data to authenticated;
grant update (status) on public.anomalies to authenticated;   -- user may acknowledge / resolve an alarm

drop policy if exists "uploads: read own plants"   on public.data_uploads;
drop policy if exists "readings: read own plants"  on public.plant_readings;
drop policy if exists "summaries: read own plants" on public.daily_summaries;
drop policy if exists "anomalies: read own plants" on public.anomalies;
drop policy if exists "anomalies: update own plants" on public.anomalies;
drop policy if exists "weather: read own plants"   on public.weather_data;

create policy "uploads: read own plants" on public.data_uploads for select to authenticated
  using (plant_id in (select id from public.plants where owner_id = (select auth.uid())));
create policy "readings: read own plants" on public.plant_readings for select to authenticated
  using (plant_id in (select id from public.plants where owner_id = (select auth.uid())));
create policy "summaries: read own plants" on public.daily_summaries for select to authenticated
  using (plant_id in (select id from public.plants where owner_id = (select auth.uid())));
create policy "anomalies: read own plants" on public.anomalies for select to authenticated
  using (plant_id in (select id from public.plants where owner_id = (select auth.uid())));
create policy "anomalies: update own plants" on public.anomalies for update to authenticated
  using      (plant_id in (select id from public.plants where owner_id = (select auth.uid())))
  with check (plant_id in (select id from public.plants where owner_id = (select auth.uid())));
create policy "weather: read own plants" on public.weather_data for select to authenticated
  using (plant_id in (select id from public.plants where owner_id = (select auth.uid())));

commit;

-- Check: should list the 5 new tables with RLS = true
-- select tablename, rowsecurity from pg_tables
-- where schemaname = 'public'
--   and tablename in ('data_uploads','plant_readings','daily_summaries','anomalies','weather_data');
