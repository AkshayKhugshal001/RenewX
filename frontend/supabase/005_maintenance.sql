-- RenewX 005: maintenance tasks
-- Run once in Supabase → SQL Editor (after 004). Safe to run again.
-- Unlike the data tables, users create/edit tasks directly from the browser (RLS: own plants only).

create table if not exists public.maintenance_tasks (
  id                 uuid primary key default gen_random_uuid(),
  plant_id           uuid not null references public.plants (id) on delete cascade,
  title              text not null check (length(trim(title)) between 1 and 200),
  category           text not null default 'inspection'
                     check (category in ('inspection', 'cleaning', 'repair', 'calibration', 'preventive', 'other')),
  priority           text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  status             text not null default 'planned' check (status in ('planned', 'in_progress', 'done', 'cancelled')),
  source             text not null default 'manual'
                     check (source in ('manual', 'anomaly', 'schedule', 'recommendation')),
  anomaly_id         uuid references public.anomalies (id) on delete set null,
  recommendation_id  uuid,                        -- linked in the AI Recommendations step
  due_date           date,
  assigned_to        text check (length(assigned_to) <= 100),
  est_cost_inr       numeric(12, 2) check (est_cost_inr >= 0),
  actual_cost_inr    numeric(12, 2) check (actual_cost_inr >= 0),
  water_litres       numeric(12, 1) check (water_litres >= 0),
  recurrence_days    integer check (recurrence_days between 1 and 3650),
  notes              text check (length(notes) <= 2000),
  completed_at       timestamptz,
  created_by         uuid default auth.uid() references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists maintenance_tasks_plant_idx on public.maintenance_tasks (plant_id, status, due_date);
create index if not exists maintenance_tasks_anomaly_idx on public.maintenance_tasks (anomaly_id);

-- ── Security: users manage tasks of their own plants only ──────────────
alter table public.maintenance_tasks enable row level security;
revoke all on public.maintenance_tasks from anon;
grant select, insert, update, delete on public.maintenance_tasks to authenticated;

drop policy if exists "tasks: manage own plants" on public.maintenance_tasks;
create policy "tasks: manage own plants" on public.maintenance_tasks for all to authenticated
  using      (plant_id in (select id from public.plants where owner_id = (select auth.uid())))
  with check (plant_id in (select id from public.plants where owner_id = (select auth.uid())));

-- ── Before insert/update: timestamps ───────────────────────────────────
create or replace function public.maintenance_tasks_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.status = 'done' and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    new.completed_at := coalesce(new.completed_at, now());
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists maintenance_tasks_before on public.maintenance_tasks;
create trigger maintenance_tasks_before
  before insert or update on public.maintenance_tasks
  for each row execute function public.maintenance_tasks_before();

-- ── After insert/update: keep the linked anomaly in step, repeat preventive tasks ──
-- Runs with the user's own rights (RLS still applies).
create or replace function public.maintenance_tasks_after()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A task for an open anomaly acknowledges it (acknowledged anomalies survive re-detection, so the link stays)
  if new.anomaly_id is not null and new.status <> 'done' then
    update public.anomalies set status = 'acknowledged' where id = new.anomaly_id and status = 'open';
  end if;

  if new.status = 'done' and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    -- finishing the task resolves its anomaly
    if new.anomaly_id is not null then
      update public.anomalies set status = 'resolved' where id = new.anomaly_id and status <> 'resolved';
    end if;
    -- repeating task: plan the next one
    if new.recurrence_days is not null then
      insert into public.maintenance_tasks
        (plant_id, title, category, priority, source, due_date, assigned_to, est_cost_inr, recurrence_days, notes)
      values
        (new.plant_id, new.title, new.category, new.priority, 'schedule',
         (new.completed_at at time zone 'Asia/Kolkata')::date + new.recurrence_days,
         new.assigned_to, new.est_cost_inr, new.recurrence_days, null);
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists maintenance_tasks_after on public.maintenance_tasks;
create trigger maintenance_tasks_after
  after insert or update on public.maintenance_tasks
  for each row execute function public.maintenance_tasks_after();

-- Check:  select count(*) from public.maintenance_tasks;
