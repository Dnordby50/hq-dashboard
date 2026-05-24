-- ============================================================================
-- 2026-05-23: RLS policies for job_areas and job_area_materials
-- ============================================================================
-- Context: the original 2026-05-19_job_areas.sql and 2026-05-20_recipe_formula.sql
-- migrations intentionally left these two tables WITHOUT row-level security
-- (the recipe_formula file even has a comment to that effect). At some point
-- after those migrations shipped, RLS was enabled on `public.job_areas` in the
-- live PEC Supabase project (most likely via Supabase Studio's "Enable RLS"
-- warning button) without an accompanying policy. The result: every job-area
-- save from the CRM job detail page fails with
--   new row violates row-level security policy for table "job_areas"
-- because there is no policy granting insert. (Anne hit this on sqft and on
-- flake color; the sqft change appeared to persist because the legacy mirror
-- on `public.jobs.sqft` is written by the same handler one step earlier and
-- the `jobs` table does have a staff policy.)
--
-- This migration:
--   (a) enables RLS on both tables (idempotent) so the security posture
--       matches what is already in production for one of them, and
--   (b) adds the standard `is_admin_staff()` staff-only policy that every
--       other CRM-writable table in this project uses
--       (see supabase/policies.sql: jobs_staff, customers_staff, etc).
--
-- Idempotent and safe to re-run. Uses the existing helper
-- public.is_admin_staff() defined in supabase/policies.sql.
-- ============================================================================

alter table public.job_areas          enable row level security;
alter table public.job_area_materials enable row level security;

drop policy if exists job_areas_staff on public.job_areas;
create policy job_areas_staff on public.job_areas for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop policy if exists job_area_materials_staff on public.job_area_materials;
create policy job_area_materials_staff on public.job_area_materials for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- Verify after running:
--   select tablename, rowsecurity
--     from pg_tables
--    where schemaname='public' and tablename in ('job_areas','job_area_materials');
--   -- expect: 2 rows, rowsecurity = true for both.
--
--   select polname, polrelid::regclass
--     from pg_policy
--    where polname in ('job_areas_staff','job_area_materials_staff');
--   -- expect: 2 rows.
