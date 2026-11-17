-- 分店共享確認換機名單與派工資料
-- 先在 Supabase SQL Editor 執行；每位使用者需由管理員建立分店成員資料。

create table if not exists public.branch_memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  branch_id text not null,
  role text not null default 'staff' check (role in ('staff','manager')),
  created_at timestamptz not null default now(),
  primary key (user_id, branch_id)
);

create table if not exists public.confirmed_cases (
  branch_id text not null,
  customer_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid() references auth.users(id),
  primary key (branch_id, customer_id)
);

create table if not exists public.dispatch_jobs (
  branch_id text not null,
  customer_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid() references auth.users(id),
  primary key (branch_id, customer_id)
);

-- LINE identities are linked to a verified household by the website's member-binding flow.
-- Only the line-booking Edge Function uses the service role to read this mapping.
create table if not exists public.household_line_links (
  branch_id text not null,
  household_id text not null,
  line_user_id text not null unique,
  line_display_name text,
  customer_payload jsonb not null default '{}'::jsonb,
  linked_at timestamptz not null default now(),
  primary key (branch_id, household_id)
);

alter table public.confirmed_cases alter column updated_by drop not null;
alter table public.household_line_links enable row level security;
revoke all on public.household_line_links from anon, authenticated;
grant select (branch_id, household_id, line_user_id, line_display_name, linked_at)
  on public.household_line_links to authenticated;
grant select on public.household_line_links to service_role;
grant select, insert, update on public.confirmed_cases to service_role;

comment on table public.household_line_links is
  'Verified LINE-to-household mapping. Branch members can read the binding; the Edge Function uses the service role for booking.';

create or replace function public.is_branch_member(requested_branch text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.branch_memberships m
    where m.user_id = auth.uid() and m.branch_id = requested_branch
  );
$$;

alter table public.branch_memberships enable row level security;
alter table public.confirmed_cases enable row level security;
alter table public.dispatch_jobs enable row level security;
drop policy if exists "branch members read household LINE links" on public.household_line_links;
create policy "branch members read household LINE links" on public.household_line_links
  for select to authenticated using (public.is_branch_member(branch_id));

grant select on public.branch_memberships to authenticated;
grant select, insert, update, delete on public.confirmed_cases to authenticated;
grant select, insert, update, delete on public.dispatch_jobs to authenticated;

drop policy if exists "members read own memberships" on public.branch_memberships;
create policy "members read own memberships" on public.branch_memberships
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "branch members read confirmed cases" on public.confirmed_cases;
create policy "branch members read confirmed cases" on public.confirmed_cases
  for select to authenticated using (public.is_branch_member(branch_id));
drop policy if exists "branch members insert confirmed cases" on public.confirmed_cases;
create policy "branch members insert confirmed cases" on public.confirmed_cases
  for insert to authenticated with check (public.is_branch_member(branch_id) and updated_by = auth.uid());
drop policy if exists "branch members update confirmed cases" on public.confirmed_cases;
create policy "branch members update confirmed cases" on public.confirmed_cases
  for update to authenticated using (public.is_branch_member(branch_id)) with check (public.is_branch_member(branch_id) and updated_by = auth.uid());
drop policy if exists "branch members delete confirmed cases" on public.confirmed_cases;
create policy "branch members delete confirmed cases" on public.confirmed_cases
  for delete to authenticated using (public.is_branch_member(branch_id));

drop policy if exists "branch members read dispatch jobs" on public.dispatch_jobs;
create policy "branch members read dispatch jobs" on public.dispatch_jobs
  for select to authenticated using (public.is_branch_member(branch_id));
drop policy if exists "branch members insert dispatch jobs" on public.dispatch_jobs;
create policy "branch members insert dispatch jobs" on public.dispatch_jobs
  for insert to authenticated with check (public.is_branch_member(branch_id) and updated_by = auth.uid());
drop policy if exists "branch members update dispatch jobs" on public.dispatch_jobs;
create policy "branch members update dispatch jobs" on public.dispatch_jobs
  for update to authenticated using (public.is_branch_member(branch_id)) with check (public.is_branch_member(branch_id) and updated_by = auth.uid());
drop policy if exists "branch members delete dispatch jobs" on public.dispatch_jobs;
create policy "branch members delete dispatch jobs" on public.dispatch_jobs
  for delete to authenticated using (public.is_branch_member(branch_id));

-- Realtime 讓同分店其他已登入視窗接收名單與派工更新。
do $$ begin
  alter publication supabase_realtime add table public.confirmed_cases;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.dispatch_jobs;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.household_line_links;
exception when duplicate_object then null;
end $$;
