-- ============================================================================
-- 2026-07-14: Crew-bonus approval audit trail. Author: Claude Code.
-- RUN BY COWORK on the PEC Supabase project ("HQ Dashboard",
-- zdfpzmmrgotynrwkeakd). Idempotent, additive only, no RLS change. NOT applied to
-- prod from the Claude Code session, per the standing do-not-touch-prod rule.
--
-- Feature: on Finalize, the reviewer now approves each crew member's bonus in a
-- dialog and may EDIT the amount before it is recorded. To keep a full audit
-- trail, each recorded 'Labor-savings bonus' row now stores the originally
-- suggested amount, the approved amount (the existing `amount` column), who
-- approved it, and when. These three new columns hold the first, third, and
-- fourth of those; `amount` continues to hold what is actually paid.
-- ============================================================================

begin;

alter table public.pec_prod_job_bonuses
  add column if not exists suggested_amount numeric,
  add column if not exists approved_by      text,
  add column if not exists approved_at      timestamptz;

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_name = 'pec_prod_job_bonuses'
--       and column_name in ('suggested_amount','approved_by','approved_at');   -- 3 rows
