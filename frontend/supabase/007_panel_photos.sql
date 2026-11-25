-- RenewX 007: panel photos (prototype of a fixed plant camera)
-- Run once in Supabase → SQL Editor (after 006). Safe to run again.
-- Photos are files in Supabase Storage (private bucket "panel-images", path "<plant_id>/<file>");
-- one row per photo in panel_inspections holds the date, type and the OpenCV result.

-- ── Storage bucket (private, images only, ≤ 6 MB each) ─────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('panel-images', 'panel-images', false, 6291456, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- users may only touch files in folders named after their own plants
drop policy if exists "panel images: read own"   on storage.objects;
drop policy if exists "panel images: upload own" on storage.objects;
drop policy if exists "panel images: delete own" on storage.objects;
create policy "panel images: read own" on storage.objects for select to authenticated
  using (bucket_id = 'panel-images'
         and (storage.foldername(name))[1] in (select id::text from public.plants where owner_id = (select auth.uid())));
create policy "panel images: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'panel-images'
              and (storage.foldername(name))[1] in (select id::text from public.plants where owner_id = (select auth.uid())));
create policy "panel images: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'panel-images'
         and (storage.foldername(name))[1] in (select id::text from public.plants where owner_id = (select auth.uid())));

-- ── Photo records ──────────────────────────────────────────────────────
create table if not exists public.panel_inspections (
  id            uuid primary key default gen_random_uuid(),
  plant_id      uuid not null references public.plants (id) on delete cascade,
  kind          text not null check (kind in ('reference', 'inspection')),  -- clean reference | camera capture
  taken_on      date not null,
  image_path    text not null,                 -- storage path of the photo
  overlay_path  text,                          -- storage path of the analysed image (dirt in red)
  reference_id  uuid references public.panel_inspections (id) on delete set null,
  label         text check (length(label) <= 120),
  result        jsonb not null default '{}'::jsonb,   -- soiled_pct, severity, est_loss_pct, method, …
  created_at    timestamptz not null default now()
);
create index if not exists panel_inspections_plant_idx on public.panel_inspections (plant_id, taken_on desc);

alter table public.panel_inspections enable row level security;
revoke all on public.panel_inspections from anon;
grant select, insert, update, delete on public.panel_inspections to authenticated;
drop policy if exists "photos: manage own plants" on public.panel_inspections;
create policy "photos: manage own plants" on public.panel_inspections for all to authenticated
  using      (plant_id in (select id from public.plants where owner_id = (select auth.uid())))
  with check (plant_id in (select id from public.plants where owner_id = (select auth.uid())));
