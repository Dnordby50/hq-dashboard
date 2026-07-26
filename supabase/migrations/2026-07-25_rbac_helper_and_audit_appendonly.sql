-- @artifacts
--   none: function + grant/revoke only; no table/column/index/setting to probe
-- @end
-- ============================================================================
-- 2026-07-25: RBAC foundation (has_permission) + audit_log append-only hardening
-- ============================================================================
-- Part of Phase 3 of the security remediation plan (wild-meandering-dijkstra).
-- These two changes are SAFE to ship as-is: has_permission() is additive (nothing
-- references it yet), and audit_log is already effectively append-only (its only
-- RLS policies are SELECT + INSERT, so UPDATE/DELETE are already denied to client
-- roles); the revokes below just make that explicit at the privilege layer too.
--
-- The BROAD RBAC policy rewrite (swapping is_admin_staff() for permission-specific
-- checks on payments/commissions/settings/catalog) is intentionally NOT in this
-- migration: it touches many live policies and needs per-table verification that no
-- staff write path breaks. This file lays the safe groundwork for it.
-- ============================================================================

-- has_permission(perm): does the CURRENT user hold the named user_permissions flag?
-- Admins (role='admin') implicitly hold every permission, matching the client's
-- PERMS_ALL_TRUE behavior, so an admin can never be accidentally locked out by a
-- future permission-gated policy. Returns false for anon / unknown perm names.
-- SECURITY DEFINER + pinned search_path so it can be used inside RLS policies.
create or replace function public.has_permission(p_perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin_role() or coalesce((
    select case p_perm
      when 'can_move_pipeline'    then up.can_move_pipeline
      when 'can_view_job_costing' then up.can_view_job_costing
      when 'can_override_status'  then up.can_override_status
      when 'can_view_commission'  then up.can_view_commission
      when 'can_edit_catalog'     then up.can_edit_catalog
      when 'can_manage_team'      then up.can_manage_team
      when 'can_manage_settings'  then up.can_manage_settings
      when 'can_finalize_costing' then up.can_finalize_costing
      else false
    end
    from public.user_permissions up
    join public.admin_users au on au.id = up.admin_user_id
    where au.auth_user_id = auth.uid()
    limit 1
  ), false);
$$;

-- Executable by both signed-in and anon roles because a policy that calls it is
-- evaluated under the querying role (mirrors is_admin_staff). It only ever reveals
-- a boolean about the CURRENT user, and returns false for anon.
grant execute on function public.has_permission(text) to authenticated, anon;

-- audit_log: make append-only explicit. RLS already blocks UPDATE/DELETE for
-- client roles (no such policy exists), so this privilege revoke is defense in
-- depth and documents intent: sign-in / action history must not be editable or
-- erasable through the API. service_role (the server) is unaffected and can still
-- run retention jobs if ever needed.
revoke update, delete on public.audit_log from anon, authenticated;
