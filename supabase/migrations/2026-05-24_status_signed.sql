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
-- Order matters: the OLD CHECK constraint must be dropped BEFORE the UPDATE,
-- because the old constraint only allows ('confirmed','scheduled','in_progress',
-- 'completed'). Updating any row to 'signed' while the old constraint is
-- still active raises 23514 and rolls back the transaction (this is exactly
-- how Cowork's 2026-05-24 first attempt failed; see PROJECT-LOG entry titled
-- "supabase: applied grind_and_seal_consolidation, status_signed FAILED").
-- With the old constraint dropped, the column is unconstrained for the
-- UPDATE, then the new constraint goes on and only accepts the new value set.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

-- 1) Drop the old constraint so the UPDATE doesn't violate it
alter table public.jobs drop constraint if exists jobs_status_check;

-- 2) Migrate existing data
update public.jobs set status = 'signed' where status = 'confirmed';

-- 3) Add the new constraint
alter table public.jobs
  add constraint jobs_status_check
  check (status in ('signed','scheduled','in_progress','completed'));

-- 4) New default
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
