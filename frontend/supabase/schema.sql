-- Run this once in Supabase → SQL Editor.

-- 1. Profile per user (filled automatically on sign-up)
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  role text not null default 'Plant Manager',
  created_at timestamptz not null default now()
);

-- 2. Plants owned by a user (a user can have many)
create table public.plants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  location text,
  capacity_mw numeric not null default 0,
  grid_connected boolean not null default true,
  status text not null default 'online',
  created_at timestamptz not null default now()
);
create index plants_owner_idx on public.plants (owner_id);

-- 3. Row Level Security: each user sees ONLY their own rows
alter table public.profiles enable row level security;
alter table public.plants   enable row level security;

create policy "profiles: read own"   on public.profiles for select using ((select auth.uid()) = id);
create policy "profiles: update own" on public.profiles for update using ((select auth.uid()) = id);

create policy "plants: manage own" on public.plants for all
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

-- 4. Auto-create the profile when someone signs up
create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
