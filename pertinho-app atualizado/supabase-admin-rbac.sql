-- Administrative RBAC for the standalone Supabase app.
-- Run in Supabase SQL Editor. The UI expects these exact table and column names.

create or replace function public.is_superadmin()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('SuperAdmin', 'superadmin', 'admin');
$$;

create or replace function public.is_moderator()
returns boolean
language sql
stable
as $$
  select public.is_superadmin()
    or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('Moderador', 'moderador');
$$;

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reported_user_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (length(trim(reason)) between 1 and 120),
  details text not null default '' check (length(details) <= 2000),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now()
);

create table if not exists public.selfie_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  selfie_path text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create table if not exists public.plan_prices (
  id smallint primary key default 1 check (id = 1),
  plus_cents integer not null default 1990 check (plus_cents between 1 and 1000000),
  premium_cents integer not null default 3490 check (premium_cents between 1 and 1000000),
  updated_at timestamptz not null default now()
);

insert into public.plan_prices (id, plus_cents, premium_cents)
values (1, 1990, 3490)
on conflict (id) do nothing;

alter table public.reports enable row level security;
alter table public.selfie_verifications enable row level security;
alter table public.plan_prices enable row level security;

grant select, insert, update, delete on public.reports to authenticated;
grant select, insert, update, delete on public.selfie_verifications to authenticated;
grant select on public.plan_prices to anon, authenticated;
grant update on public.plan_prices to authenticated;

drop policy if exists reports_admin_read on public.reports;
create policy reports_admin_read on public.reports
  for select to authenticated
  using (public.is_moderator());

drop policy if exists reports_user_create on public.reports;
create policy reports_user_create on public.reports
  for insert to authenticated
  with check (reporter_id = (select auth.uid()) and status = 'open');

drop policy if exists reports_superadmin_update on public.reports;
create policy reports_superadmin_update on public.reports
  for update to authenticated
  using (public.is_superadmin())
  with check (public.is_superadmin());

drop policy if exists reports_superadmin_delete on public.reports;
create policy reports_superadmin_delete on public.reports
  for delete to authenticated
  using (public.is_superadmin());

drop policy if exists selfie_verifications_admin_read on public.selfie_verifications;
create policy selfie_verifications_admin_read on public.selfie_verifications
  for select to authenticated
  using (public.is_moderator() or user_id = (select auth.uid()));

drop policy if exists selfie_verifications_user_create on public.selfie_verifications;
create policy selfie_verifications_user_create on public.selfie_verifications
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'pending'
    and split_part(selfie_path, '/', 1) = (select auth.uid())::text
  );

drop policy if exists selfie_verifications_superadmin_update on public.selfie_verifications;
create policy selfie_verifications_superadmin_update on public.selfie_verifications
  for update to authenticated
  using (public.is_superadmin())
  with check (public.is_superadmin());

drop policy if exists selfie_verifications_superadmin_delete on public.selfie_verifications;
create policy selfie_verifications_superadmin_delete on public.selfie_verifications
  for delete to authenticated
  using (public.is_superadmin());

drop policy if exists plan_prices_public_read on public.plan_prices;
create policy plan_prices_public_read on public.plan_prices
  for select to anon, authenticated
  using (true);

drop policy if exists plan_prices_superadmin_update on public.plan_prices;
create policy plan_prices_superadmin_update on public.plan_prices
  for update to authenticated
  using (public.is_superadmin())
  with check (public.is_superadmin());

alter table public.profiles enable row level security;

drop policy if exists profiles_superadmin_delete on public.profiles;
create policy profiles_superadmin_delete on public.profiles
  for delete to authenticated
  using (public.is_superadmin());

insert into storage.buckets (id, name, public)
values ('moderation-selfies', 'moderation-selfies', false)
on conflict (id) do update set public = false;

drop policy if exists moderation_selfies_admin_read on storage.objects;
create policy moderation_selfies_admin_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'moderation-selfies'
    and (
      public.is_moderator()
      or (storage.foldername(name))[1] = (select auth.uid())::text
    )
  );

drop policy if exists moderation_selfies_user_upload on storage.objects;
create policy moderation_selfies_user_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'moderation-selfies'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Assign roles through app_metadata (never user_metadata), then sign out/in to refresh the JWT:
-- update auth.users
-- set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"SuperAdmin"}'::jsonb
-- where email = 'admin@example.com';
--
-- update auth.users
-- set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"Moderador"}'::jsonb
-- where email = 'moderator@example.com';
--
-- Selfies must be uploaded to the private "moderation-selfies" bucket under a path whose
-- first folder is the uploader's Auth user UUID; store that path in selfie_verifications.selfie_path.
-- Inspect existing policies on profiles before deployment: existing permissive policies remain
-- additive, so remove any old broad admin-write policy that grants more than SuperAdmin.
