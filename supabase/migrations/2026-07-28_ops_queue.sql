-- @artifacts
--   table: public.pec_ops_items
--   index: idx_pec_ops_items_auto_check_key
--   index: idx_pec_ops_items_badge
--   setting: ops_check_busybusy_unmapped
--   setting: ops_check_costing_unfinalized
--   setting: ops_check_missing_revenue
--   setting: ops_check_never_invoiced
--   setting: ops_check_missing_salesperson
--   setting: ops_check_missing_system
--   setting: ops_check_drip_approvals
--   setting: ops_check_touchup_age
--   setting: ops_touchup_age_days
--   setting: ops_check_deposit_uncollected
--   setting: ops_deposit_age_days
--   setting: ops_check_system_health
-- @end
-- ============================================================================
-- 2026-07-28 (prompt 55, Part C): the Admin Ops Queue's ONE small table.
-- Author: Claude Code. Idempotent. Written for Cowork to apply (standing rule).
--
-- The Ops Queue itself is DERIVED: ten data checks computed at render time
-- from tables that already exist, so nothing goes stale. This table stores
-- only what cannot be derived:
--   source='manual'  a human-added item (title required), assignable to an
--                    admin, with an optional due date and a done state.
--   source='auto'    a DISMISSAL of one derived item. check_key is a stable
--                    per-record identifier (e.g. 'job_missing_revenue:<uuid>'),
--                    so dismissing one job's missing revenue never hides
--                    another's. Derived items have no Done, only Dismiss: they
--                    disappear when the underlying data is actually fixed.
--
-- assigned_to / created_by / done_by reference admin_users, NOT people:
-- prompt 54's people migration was unapplied when this was written (the
-- deploy-order warning in the prompt), and admin logins are the assignees
-- anyway. NO permission changes anywhere: RLS reuses the existing
-- is_admin_staff() / is_admin_role() helpers; user_permissions, DELEGABLE
-- perms, and every existing policy are untouched.
-- ============================================================================

begin;

create table if not exists public.pec_ops_items (
  id          uuid primary key default gen_random_uuid(),
  source      text not null check (source in ('manual', 'auto')),
  -- Title is required for manual items; auto rows are dismissals and carry a
  -- check_key instead. Enforced by the CHECK below, not the app alone.
  title       text,
  body        text,
  assigned_to uuid references public.admin_users(id) on delete set null,
  created_by  uuid references public.admin_users(id) on delete set null,
  due_date    date,
  status      text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  -- Deep link, same shape the notifications use (target_view / target_id):
  -- a manual item can point at the exact screen + record that fixes it.
  link_view   text,
  link_id     uuid,
  -- Auto rows only: which derived item this dismissal hides, forever.
  check_key   text,
  created_at  timestamptz not null default now(),
  done_at     timestamptz,
  done_by     uuid references public.admin_users(id) on delete set null,
  constraint pec_ops_items_shape check (
    (source = 'manual' and title is not null and check_key is null)
    or
    (source = 'auto' and check_key is not null)
  )
);

-- One dismissal per derived item, ever. Partial unique: manual rows have no
-- check_key and are unaffected.
create unique index if not exists idx_pec_ops_items_auto_check_key
  on public.pec_ops_items (check_key) where source = 'auto';

-- The nav badge count (open manual items) and per-assignee filters.
create index if not exists idx_pec_ops_items_badge
  on public.pec_ops_items (status, assigned_to);

alter table public.pec_ops_items enable row level security;

-- Staff read, admin write. EXISTING helpers only (no new permission concept):
-- is_admin_staff() = any signed-in staff login; is_admin_role() = role 'admin',
-- the same gate Settings and Job Costing use.
drop policy if exists pec_ops_items_staff_read on public.pec_ops_items;
create policy pec_ops_items_staff_read on public.pec_ops_items
  for select using (public.is_admin_staff());

drop policy if exists pec_ops_items_admin_insert on public.pec_ops_items;
create policy pec_ops_items_admin_insert on public.pec_ops_items
  for insert with check (public.is_admin_role());

drop policy if exists pec_ops_items_admin_update on public.pec_ops_items;
create policy pec_ops_items_admin_update on public.pec_ops_items
  for update using (public.is_admin_role()) with check (public.is_admin_role());

drop policy if exists pec_ops_items_admin_delete on public.pec_ops_items;
create policy pec_ops_items_admin_delete on public.pec_ops_items
  for delete using (public.is_admin_role());

-- Bell notification for NEW MANUAL items only (decision 12). Client JS cannot
-- insert into pec_notifications directly (the table grants staff SELECT/UPDATE
-- only; inserts go through SECURITY DEFINER RPCs, same as
-- log_costing_submitted), so this is the one writer. Derived Ops Queue items
-- NEVER call it: they re-derive every day and would re-fire the bell forever.
create or replace function public.pec_ops_item_notify(p_item_id uuid, p_title text, p_assignee text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text;
begin
  -- Same gate as the table's write policies: only an admin can create a
  -- manual item, so only an admin can bell one.
  if not public.is_admin_role() then
    raise exception 'admin only';
  end if;
  select coalesce(name, email) into v_actor from public.admin_users where auth_user_id = auth.uid();
  insert into public.pec_notifications (type, body, target_view, target_id)
  values ('ops_item',
          coalesce(v_actor, 'Someone') || ' added an Ops Queue item: '
            || coalesce(nullif(p_title, ''), '(untitled)')
            || case when nullif(p_assignee, '') is not null
                 then ' (assigned to ' || p_assignee || ')' else '' end,
          'ops', p_item_id);
end
$$;

grant execute on function public.pec_ops_item_notify(uuid, text, text) to authenticated;

-- Settings (rule 12), insert-only so live values are never clobbered.
-- One on/off per derived check, plus the two day thresholds.
insert into public.settings (key, value)
select k, v from (values
  ('ops_check_busybusy_unmapped',   'true'),
  ('ops_check_costing_unfinalized', 'true'),
  ('ops_check_missing_revenue',     'true'),
  ('ops_check_never_invoiced',      'true'),
  ('ops_check_missing_salesperson', 'true'),
  ('ops_check_missing_system',      'true'),
  ('ops_check_drip_approvals',      'true'),
  ('ops_check_touchup_age',         'true'),
  ('ops_touchup_age_days',          '7'),
  ('ops_check_deposit_uncollected', 'true'),
  ('ops_deposit_age_days',          '7'),
  ('ops_check_system_health',       'true')
) as t(k, v)
where not exists (select 1 from public.settings s where s.key = t.k);

commit;

-- ============================================================================
-- Verify (run after applying; every query should succeed and match the note)
-- ============================================================================
-- 1. Table exists with 0 rows:
--      select count(*) from public.pec_ops_items;                      -- 0
-- 2. Both indexes exist:
--      select indexname from pg_indexes
--      where tablename = 'pec_ops_items' order by indexname;
--      -- idx_pec_ops_items_auto_check_key, idx_pec_ops_items_badge,
--      -- pec_ops_items_pkey
-- 3. Exactly 4 policies, and none on any OTHER table changed:
--      select policyname, cmd from pg_policies
--      where tablename = 'pec_ops_items' order by policyname;
--      -- pec_ops_items_admin_delete (DELETE), pec_ops_items_admin_insert
--      -- (INSERT), pec_ops_items_admin_update (UPDATE),
--      -- pec_ops_items_staff_read (SELECT)
-- 4. The shape CHECK holds: this must FAIL (manual without a title):
--      insert into public.pec_ops_items (source) values ('manual');
-- 5. The dismissal uniqueness holds: run twice, second must FAIL:
--      insert into public.pec_ops_items (source, check_key, status)
--      values ('auto', 'verify:dupe-test', 'dismissed');
--    then clean up:
--      delete from public.pec_ops_items where check_key = 'verify:dupe-test';
-- 6. All 12 settings keys present:
--      select count(*) from public.settings where key like 'ops_%';    -- 12
-- 7. The bell RPC exists and is admin-gated:
--      select proname from pg_proc where proname = 'pec_ops_item_notify';
--      -- pec_ops_item_notify (SECURITY DEFINER; raises 'admin only' for
--      -- non-admin callers, inserts one type='ops_item' notification row)
-- ============================================================================
