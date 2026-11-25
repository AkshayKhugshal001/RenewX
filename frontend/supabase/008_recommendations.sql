-- RenewX 008: AI recommendations (+ battery what-if settings)
-- Run once in Supabase → SQL Editor (after 007). Safe to run again.

-- Simulated battery per plant (what-if only; editable in "Edit plant")
alter table public.plants
  add column if not exists battery_capacity_mwh numeric(10, 2) not null default 10 check (battery_capacity_mwh >= 0),
  add column if not exists battery_power_mw     numeric(10, 2) not null default 5  check (battery_power_mw >= 0);

-- One row per recommendation (written by the backend; the user approves or dismisses in the browser)
create table if not exists public.recommendations (
  id              uuid primary key default gen_random_uuid(),
  plant_id        uuid not null references public.plants (id) on delete cascade,
  key             text not null,                 -- stable id, e.g. 'cleaning', 'anomaly:inverter_fault'
  type            text not null,                 -- cleaning | anomaly | sensor | schedule | reminder | cooling | battery
  title           text not null,
  summary         text,                          -- template explanation (numbers from the models)
  ai_summary      text,                          -- optional friendlier wording by the LLM (never new numbers)
  evidence        jsonb not null default '[]'::jsonb,
  details         jsonb not null default '{}'::jsonb,
  action          jsonb not null default '{}'::jsonb,   -- what "Approve" does (create_task | reschedule | open_task | none)
  gain_kwh        double precision,              -- over the next 30 days
  gain_inr        double precision,
  cost_inr        double precision,
  water_l         double precision,
  co2_kg          double precision,
  confidence      integer check (confidence between 0 and 100),
  priority        text check (priority in ('high', 'medium', 'low')),
  value           double precision,              -- ranking value: (gain − cost) × confidence
  rank            integer,
  due_date        date,
  status          text not null default 'open' check (status in ('open', 'approved', 'dismissed', 'done')),
  task_id         uuid references public.maintenance_tasks (id) on delete set null,
  dismiss_reason  text check (length(dismiss_reason) <= 300),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists recommendations_plant_idx on public.recommendations (plant_id, status, rank);

alter table public.recommendations enable row level security;
revoke all on public.recommendations from anon, authenticated;
grant select on public.recommendations to authenticated;
grant update (status, task_id, dismiss_reason) on public.recommendations to authenticated;   -- approve / dismiss
drop policy if exists "recommendations: read own"   on public.recommendations;
drop policy if exists "recommendations: update own" on public.recommendations;
create policy "recommendations: read own" on public.recommendations for select to authenticated
  using (plant_id in (select id from public.plants where owner_id = (select auth.uid())));
create policy "recommendations: update own" on public.recommendations for update to authenticated
  using      (plant_id in (select id from public.plants where owner_id = (select auth.uid())))
  with check (plant_id in (select id from public.plants where owner_id = (select auth.uid())));

create or replace function public.recommendations_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists recommendations_touch on public.recommendations;
create trigger recommendations_touch before update on public.recommendations
  for each row execute function public.recommendations_touch();

-- Tasks created from a recommendation point back to it; finishing the task marks it done
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'maintenance_tasks_recommendation_fk') then
    alter table public.maintenance_tasks
      add constraint maintenance_tasks_recommendation_fk
      foreign key (recommendation_id) references public.recommendations (id) on delete set null;
  end if;
end $$;

create or replace function public.maintenance_tasks_recommendation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.recommendation_id is not null and new.status = 'done' and old.status is distinct from 'done' then
    update public.recommendations set status = 'done' where id = new.recommendation_id and status <> 'done';
  end if;
  return null;
end;
$$;
drop trigger if exists maintenance_tasks_recommendation on public.maintenance_tasks;
create trigger maintenance_tasks_recommendation after update on public.maintenance_tasks
  for each row execute function public.maintenance_tasks_recommendation();
