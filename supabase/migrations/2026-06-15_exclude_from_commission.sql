-- ============================================================================
-- 2026-06-15: exclude a seller from the Commission report (e.g. the owner).
-- Author: Claude Code. RUN BY COWORK on the PROD Supabase project. Idempotent.
-- NOT applied to prod from the Claude Code session.
--
-- When the owner sells a job it should not appear in Commission at all (no payout
-- line, no sold-jobs row). This is a per-seller flag (not a hardcoded name), set
-- in Settings > Sales Team, so it generalizes to any non-commission seller. The
-- client builds an excluded-name set from this column and filters those sellers
-- out of the Commission report. Reuses the existing RLS on pec_sales_team_members.
-- ============================================================================

alter table public.pec_sales_team_members
  add column if not exists exclude_from_commission boolean not null default false;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_name='pec_sales_team_members' and column_name='exclude_from_commission';  -- 1 row
