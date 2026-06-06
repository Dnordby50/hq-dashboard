-- ============================================================================
-- 2026-06-06: admin_users supports field roles + SOP company scoping
-- ============================================================================
-- The whole app now sits behind per-user Supabase login (the old shared
-- password + employee codes were removed). Owner-vs-employee role and the
-- per-employee SOP visibility (getAccessibleSOPs) are now read from
-- admin_users instead of CONFIG.EMPLOYEE_CODES.
--
-- Two changes are needed for that:
--   1. role must allow the field roles 'crew' and 'sales' (owner shell =
--      admin/office/pm; employee shell = crew/sales). NOTE: 'crew' was already
--      added in 2026-05-27_invoicing_ar.sql; this re-asserts the full set so
--      the migration is self-contained and idempotent.
--   2. a `company` column so the SOP filter can scope by brand. Values match
--      the SOP frontmatter / old EMPLOYEE_CODES namespace ('PEC','FTP'), plus
--      'both' for owners / cross-brand staff (sees every SOP). This is a
--      DIFFERENT namespace from customers.company ('prescott-epoxy' /
--      'finishing-touch') on purpose -- it feeds getAccessibleSOPs, not the CRM.
--
-- *** COWORK HANDOFF: run this in the PROD Supabase project, then create the 4
-- employee accounts (see the 2026-06-06 PROJECT-LOG entry for the mapping). ***
--
-- Idempotent / safe to re-run.
-- ============================================================================

alter table public.admin_users drop constraint if exists admin_users_role_check;
alter table public.admin_users
  add constraint admin_users_role_check
  check (role in ('admin','office','pm','crew','sales'));

alter table public.admin_users
  add column if not exists company text not null default 'both'
  check (company in ('PEC','FTP','both'));

-- Verify after running:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid = 'public.admin_users'::regclass and conname like '%role%';
--   select column_name from information_schema.columns
--     where table_name = 'admin_users' and column_name = 'company';  -- 1 row
