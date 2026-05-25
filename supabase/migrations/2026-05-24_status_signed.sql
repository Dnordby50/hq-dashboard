-- ============================================================================
-- 2026-05-24: rename jobs.status value 'confirmed' to 'signed'
-- ============================================================================
-- Dylan: "change one of the statuses from confirmed to signed". The status
-- enum in supabase/schema.sql:57 currently allows ('confirmed', 'scheduled',
-- 'in_progress', 'completed'); the DEFAULT is 'confirmed'. The dashboard's
-- status badge + filter dropdown + STATUSES array all match. We rename the
-- VALUE itself so the badge label, the dropdown option, and the DB row all
-- read 'signed' going forward.
--
-- The separate `jobs.confirmed` BOOLEAN column (set by portal_confirm_job in
-- supabase/policies.sql:174-176 when a customer signs from the portal) is
-- left alone. Renaming it would cascade through the RPC and the portal HTML
-- with no operational benefit. Only the status enum changes here.
--
-- Order matters: existing rows are updated first so the new CHECK constraint
-- has no orphaned 'confirmed' values to reject.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

-- 1) Migrate existing data
update public.jobs set status = 'signed' where status = 'confirmed';

-- 2) Swap the CHECK constraint
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs
  add constraint jobs_status_check
  check (status in ('signed','scheduled','in_progress','completed'));

-- 3) New default
alter table public.jobs alter column status set default 'signed';

commit;

-- Verify after running:
--   select status, count(*) from public.jobs group by status order by status;
--   -- expect: no rows with status='confirmed', some/all with status='signed'.
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conname='jobs_status_check';
--   -- expect: contains 'signed' in the IN (...) list.
--   select column_default from information_schema.columns
--     where table_schema='public' and table_name='jobs' and column_name='status';
--   -- expect: 'signed'::text.
