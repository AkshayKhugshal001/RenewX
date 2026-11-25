-- RenewX 004: ML anomaly detection
-- Run once in Supabase → SQL Editor (after 002 and 003). Safe to run again.

-- Extra information per anomaly (feature values shown in the UI) and when the user acted on it
alter table public.anomalies
  add column if not exists details         jsonb not null default '{}'::jsonb,
  add column if not exists acknowledged_at timestamptz,
  add column if not exists resolved_at     timestamptz;

create index if not exists anomalies_status_idx on public.anomalies (plant_id, status);

-- The browser may only change `status` (grant from 002); the timestamps follow automatically.
create or replace function public.anomalies_status_times()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'open' then
      new.acknowledged_at := null;
      new.resolved_at := null;
    elsif new.status = 'acknowledged' then
      new.acknowledged_at := coalesce(old.acknowledged_at, now());
      new.resolved_at := null;
    elsif new.status = 'resolved' then
      new.acknowledged_at := coalesce(old.acknowledged_at, now());
      new.resolved_at := now();
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists anomalies_status_times on public.anomalies;
create trigger anomalies_status_times
  before update of status on public.anomalies
  for each row execute function public.anomalies_status_times();

-- Check:  select column_name from information_schema.columns
--         where table_name = 'anomalies' and column_name in ('details','acknowledged_at','resolved_at');
