-- Per-user permissions, layered ON TOP of admin_users.role.
-- The app treats role='admin' as a super-role that always passes every check;
-- these booleans let an admin selectively grant/revoke individual capabilities
-- for non-admin staff. Every capability defaults TRUE, so a new (or un-edited)
-- account has everything on until an admin unchecks something.
--
-- RLS: admins read/write all rows; a non-admin may read ONLY their own row and
-- may write NONE, so a non-admin can never grant themselves a capability.
-- Reuses public.is_admin_role() and public.pec_prod_touch_updated_at().

create table if not exists public.user_permissions (
  id                   uuid primary key default gen_random_uuid(),
  admin_user_id        uuid not null unique references public.admin_users(id) on delete cascade,
  can_move_pipeline    boolean not null default true,
  can_view_job_costing boolean not null default true,
  can_override_status  boolean not null default true,
  can_view_commission  boolean not null default true,
  can_edit_catalog     boolean not null default true,
  -- Reserved: Team + Settings management stays admin-only in the app regardless
  -- of these, so a non-admin can never be handed staff/permission management.
  can_manage_team      boolean not null default true,
  can_manage_settings  boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.user_permissions enable row level security;

drop policy if exists up_admin_all on public.user_permissions;
create policy up_admin_all on public.user_permissions for all
  using (public.is_admin_role()) with check (public.is_admin_role());

drop policy if exists up_select_own on public.user_permissions;
create policy up_select_own on public.user_permissions for select
  using (admin_user_id in (select id from public.admin_users where auth_user_id = auth.uid()));

drop trigger if exists trg_user_permissions_touch on public.user_permissions;
create trigger trg_user_permissions_touch before update on public.user_permissions
  for each row execute function public.pec_prod_touch_updated_at();

-- Backfill: every existing staff member gets an all-true row immediately, so
-- nobody loses access when the app starts reading permissions (Anne included).
insert into public.user_permissions (admin_user_id)
select a.id from public.admin_users a
where not exists (select 1 from public.user_permissions up where up.admin_user_id = a.id);
