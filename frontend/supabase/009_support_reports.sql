-- RenewX 009: issue reports from the "Ask RenewX" chat
-- Run once in Supabase → SQL Editor. Safe to run again.
-- Users create and see their own reports; the team reads all of them in the Supabase Table Editor.
create table if not exists public.support_reports (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  plant_id      uuid references public.plants (id) on delete set null,
  category      text not null default 'other' check (category in ('bug', 'data', 'question', 'feature', 'other')),
  title         text not null check (length(trim(title)) between 1 and 120),
  description   text not null check (length(description) <= 2000),
  page          text check (length(page) <= 200),          -- where the user was in the app
  conversation  jsonb not null default '[]'::jsonb,        -- the chat that led to the report
  status        text not null default 'open' check (status in ('open', 'in_progress', 'closed')),
  created_at    timestamptz not null default now()
);
create index if not exists support_reports_user_idx on public.support_reports (user_id, created_at desc);

alter table public.support_reports enable row level security;
revoke all on public.support_reports from anon;
grant select, insert on public.support_reports to authenticated;
drop policy if exists "reports: insert own" on public.support_reports;
drop policy if exists "reports: read own"   on public.support_reports;
create policy "reports: insert own" on public.support_reports for insert to authenticated
  with check (user_id = (select auth.uid())
              and (plant_id is null or plant_id in (select id from public.plants where owner_id = (select auth.uid()))));
create policy "reports: read own" on public.support_reports for select to authenticated
  using (user_id = (select auth.uid()));
