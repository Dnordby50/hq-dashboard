-- @artifacts
--   none: RLS policy changes only; no table/column/index/setting to probe
-- @end
-- ============================================================================
-- 2026-07-25: DB-enforced RBAC on sensitive tables (Phase 3, security plan)
-- ============================================================================
-- Until now, role/permission enforcement lived ONLY in client JS (isAdmin /
-- user_permissions / canEdit); at the database every staff member had full access
-- (all sensitive policies were plain is_admin_staff()). So a staff member with a
-- valid JWT but a restricted UI could still read/write restricted data directly
-- via supabase-js. This moves the enforcement into RLS using has_permission()
-- (added in 2026-07-25_rbac_helper_and_audit_appendonly.sql).
--
-- SAFETY: has_permission() returns true for role='admin' (admins always pass) and
-- all six current staff have every user_permissions flag = true, so NO current
-- user loses any access today. The change only makes the DB honor a FUTURE
-- restriction. Principle followed here: TIGHTEN ONLY, never loosen an existing
-- check. Reads that everyone needs (catalog) stay staff-level; only the matching
-- write/view is permission-gated.
--
-- DELIBERATELY NOT CHANGED:
--   * pec_payments -- no finer-grained permission maps to it cleanly, and it is
--     core daily data; stays is_admin_staff().
--   * settings -- writes are already is_admin_role() (stricter than any perm gate);
--     leaving it avoids loosening.
-- ============================================================================

-- ---- Commissions: gate READ on can_view_commission; keep writes admin-only ----
drop policy if exists cp_select on public.pec_commission_payouts;
create policy cp_select on public.pec_commission_payouts
  for select using (public.is_admin_staff() and public.has_permission('can_view_commission'));
-- cp_write (is_admin_role) intentionally left unchanged.

drop policy if exists bp_select on public.pec_bonus_payouts;
create policy bp_select on public.pec_bonus_payouts
  for select using (public.is_admin_staff() and public.has_permission('can_view_commission'));
-- bp_write (is_admin_role) intentionally left unchanged.

-- ---- Job costing: gate read AND write on can_view_job_costing ----
drop policy if exists pec_prod_job_costing_staff on public.pec_prod_job_costing;
create policy pec_prod_job_costing_read on public.pec_prod_job_costing
  for select using (public.is_admin_staff() and public.has_permission('can_view_job_costing'));
create policy pec_prod_job_costing_ins on public.pec_prod_job_costing
  for insert with check (public.is_admin_staff() and public.has_permission('can_view_job_costing'));
create policy pec_prod_job_costing_upd on public.pec_prod_job_costing
  for update using (public.is_admin_staff() and public.has_permission('can_view_job_costing'))
             with check (public.is_admin_staff() and public.has_permission('can_view_job_costing'));
create policy pec_prod_job_costing_del on public.pec_prod_job_costing
  for delete using (public.is_admin_staff() and public.has_permission('can_view_job_costing'));

-- ---- Catalog: reads stay staff-level (everyone builds estimates/jobs from it);
--      writes gated on can_edit_catalog. Applied to each catalog table. ----
do $$
declare t text;
begin
  foreach t in array array[
    'pec_prod_products','pec_prod_system_types','pec_prod_recipe_slots',
    'pec_prod_color_pairings','pec_prod_addons'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_staff', t);
    execute format('create policy %I on public.%I for select using (public.is_admin_staff())', t || '_read', t);
    execute format('create policy %I on public.%I for insert with check (public.is_admin_staff() and public.has_permission(''can_edit_catalog''))', t || '_ins', t);
    execute format('create policy %I on public.%I for update using (public.is_admin_staff() and public.has_permission(''can_edit_catalog'')) with check (public.is_admin_staff() and public.has_permission(''can_edit_catalog''))', t || '_upd', t);
    execute format('create policy %I on public.%I for delete using (public.is_admin_staff() and public.has_permission(''can_edit_catalog''))', t || '_del', t);
  end loop;
end $$;

-- colors: public SELECT stays (colors_select_all, using true). Replace the ALL
-- write policy with write-only, can_edit_catalog-gated policies.
drop policy if exists colors_staff_write on public.colors;
create policy colors_ins on public.colors
  for insert with check (public.is_admin_staff() and public.has_permission('can_edit_catalog'));
create policy colors_upd on public.colors
  for update using (public.is_admin_staff() and public.has_permission('can_edit_catalog'))
             with check (public.is_admin_staff() and public.has_permission('can_edit_catalog'));
create policy colors_del on public.colors
  for delete using (public.is_admin_staff() and public.has_permission('can_edit_catalog'));
