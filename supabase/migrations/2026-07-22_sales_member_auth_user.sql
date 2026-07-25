-- ============================================================================
-- 2026-07-22 (prompt 47): link sales team members to their auth logins.
-- Author: Claude Code. Idempotent. Written for Cowork to apply (standing rule).
--
-- WHY: the estimator now defaults the salesperson on a new estimate to the
-- logged-in rep. Name-matching a login to a pec_sales_team_members row is
-- fragile (renames, nicknames), so the mapping is an explicit column: each
-- member optionally points at exactly one auth.users login. Nullable on
-- purpose: existing members stay unmapped until an admin links them in
-- Settings > Sales Team, and an unmapped login simply gets no default (the
-- estimator blocks the save with a prompt instead of guessing).
--
-- The partial unique index enforces "one login maps to at most one member"
-- while still allowing any number of unmapped (NULL) rows.
-- ============================================================================

begin;

alter table public.pec_sales_team_members
  add column if not exists auth_user_id uuid references auth.users(id);

create unique index if not exists uq_pec_sales_team_members_auth_user
  on public.pec_sales_team_members (auth_user_id)
  where auth_user_id is not null;

commit;

-- ============================================================================
-- Verify after running:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--     where table_schema = 'public'
--       and table_name = 'pec_sales_team_members'
--       and column_name = 'auth_user_id';            -- uuid, YES (nullable)
--
--   select indexname, indexdef from pg_indexes
--     where tablename = 'pec_sales_team_members'
--       and indexname = 'uq_pec_sales_team_members_auth_user';
--   -- indexdef must contain: UNIQUE ... (auth_user_id) WHERE (auth_user_id IS NOT NULL)
--
--   select conname from pg_constraint
--     where conrelid = 'public.pec_sales_team_members'::regclass
--       and contype = 'f' and conname like '%auth_user_id%';  -- FK to auth.users
-- ============================================================================
