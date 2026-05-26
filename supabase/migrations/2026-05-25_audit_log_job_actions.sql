-- ============================================================================
-- 2026-05-25: enable staff-side audit_log writes + per-job feed reads
-- ============================================================================
-- Dylan: "create an activity section at the very bottom of each job, logging
-- which user did what with the job." The existing public.audit_log table
-- (schema.sql:160-173) already has the right shape (auth_user_id, action,
-- entity_type, entity_id, before_json, after_json, created_at). It just
-- needs two things to support the new Activity card on the job detail page:
--
-- 1. A partial index keyed on (entity_type, entity_id, created_at desc)
--    filtered to entity_type='jobs', so the activity feed query
--    (select * from audit_log where entity_type='jobs' and entity_id=$1
--     order by created_at desc limit 50) is a single index lookup.
--
-- 2. RLS policies that let ANY admin staff (office, pm, admin -- per
--    admin_users.role) both READ and WRITE rows. Today policies.sql:93-94
--    grants SELECT only to is_admin_role() (admin only) and has NO insert
--    policy, which means the dashboard client cannot write activity rows
--    at all. The activity feed is per-job context that office + PM users
--    need to see, and the writes happen client-side from the dashboard, so
--    is_admin_staff() is the right gate for both. UPDATE/DELETE remain
--    closed (no policy = no access under RLS).
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

-- 1) Partial index for the per-job activity feed lookup
create index if not exists idx_audit_log_job_entity
  on public.audit_log (entity_type, entity_id, created_at desc)
  where entity_type = 'jobs';

-- 2) Replace the old admin-only SELECT with a staff-wide SELECT
drop policy if exists audit_staff on public.audit_log;
create policy audit_staff on public.audit_log for select
  using (public.is_admin_staff());

-- 3) New INSERT policy: any admin staff can write audit rows for their own
--    actions. The auth_user_id column is set by the client to the current
--    session's uid; we enforce that here so a logged-in staffer cannot
--    forge a row attributed to someone else.
drop policy if exists audit_staff_insert on public.audit_log;
create policy audit_staff_insert on public.audit_log for insert
  with check (public.is_admin_staff() and auth_user_id = auth.uid());

commit;

-- Verify after running:
--   select indexname from pg_indexes
--     where schemaname='public' and tablename='audit_log'
--       and indexname='idx_audit_log_job_entity';
--   -- expect 1 row.
--   select polname, polcmd from pg_policy
--     where polrelid='public.audit_log'::regclass order by polname;
--   -- expect: audit_staff (r), audit_staff_insert (a).
