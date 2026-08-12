-- @artifacts
--   none: privilege revokes + search_path pins (no table/column/index/setting)
-- @end
-- ============================================================================
-- 2026-08-28: security hardening from the advisor scan (prompt 90 Task B).
-- Author: Claude Code. APPLIED to prod via MCP 2026-08-12. Idempotent
-- (revoke/grant/alter are all repeat-safe).
--
-- WHY: every SECURITY DEFINER function carried Postgres's default PUBLIC
-- EXECUTE grant, so `anon` could invoke 21 of them. Eleven have no
-- anon-reachable caller anywhere (grepped index.html, netlify/functions,
-- apps/estimator): the pec_people_* family (staff People-screen RPCs plus
-- trigger functions, and triggers never check the invoker's EXECUTE) and
-- pec_ops_item_notify (staff bell RPC). Revoking PUBLIC is the load-bearing
-- half (anon inherits PUBLIC, so revoking anon alone does nothing); the
-- explicit grants keep the staff paths working.
--
-- KEPT for anon, deliberately (full keep/revoke table in the 2026-08-12
-- PROJECT-LOG entry): the seven portal_* / get_portal_* token flows (the
-- customer portal runs unauthenticated in index.html on the anon key) and
-- the three RLS helper predicates has_permission / is_admin_role /
-- is_admin_staff (referenced by table policies; an anon request evaluating
-- such a policy without EXECUTE would turn "empty result" into a hard
-- permission error, and the portal makes real anon queries).
--
-- Plus: search_path pinned on the 4 mutable-search_path trigger functions
-- (the revoke-login migration's pattern), closing the schema-shadowing hole
-- the advisor flags on SECURITY DEFINER trigger bodies.
-- ============================================================================

-- ---- Revoke the eleven staff-only definers from PUBLIC/anon ---------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'pec_people_adopt_admin_user()',
    'pec_people_adopt_crew_member()',
    'pec_people_adopt_sales_member()',
    'pec_people_follow_admin_rename()',
    'pec_people_follow_crew_rename()',
    'pec_people_follow_sales_rename()',
    'pec_people_mirror_forward()',
    'pec_people_sync_enabled()',
    'pec_people_grant_role(uuid, text)',
    'pec_people_merge(uuid, uuid)',
    'pec_ops_item_notify(uuid, text, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated, service_role', fn);
  end loop;
end $$;

-- ---- Pin search_path on the four mutable trigger functions ----------------
alter function public.pec_people_touch_updated_at()  set search_path = public;
alter function public.pec_sales_capture_name_alias() set search_path = public;
alter function public.settings_touch_updated_at()    set search_path = public;
alter function public.estimate_status_guard()        set search_path = public;

-- NOT changed, with reasons (Task B item 3):
--   pec_sales_member_google_tokens (RLS on, zero policies) is the
--   INTENTIONAL default-deny token vault (SCHEMA.md: "do not add a policy").
--   pg_trgm in public: relocating an extension its indexes/operators already
--   reference is not the "trivial and safe" bar; logged as a recommendation.
