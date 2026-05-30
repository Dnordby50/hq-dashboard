-- ============================================================================
-- 2026-05-30: colors_confirmed flag for jobs (color-selection sign-off)
-- ============================================================================
-- Color selection is a manual process and jobs were reaching the crew without
-- the customer's colors confirmed, with no field tracking it. Add a job-level
-- flag the office can set now (Dashboard "Colors NOT confirmed" worklist + a
-- toggle on the job detail page), and a timestamp for when it was confirmed.
-- A future customer-portal confirmation will flip the same flag.
--
-- Read directly from public.jobs by the dashboard (renderDashboard) and the job
-- detail (select('*')), so no view change is needed. The jobs_staff RLS policy
-- already permits staff UPDATE.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

alter table public.jobs
  add column if not exists colors_confirmed    boolean not null default false,
  add column if not exists colors_confirmed_at timestamptz;

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='jobs'
--       and column_name in ('colors_confirmed','colors_confirmed_at');
--   -- expect 2 rows.
