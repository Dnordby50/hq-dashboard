-- @artifacts
--   column: public.pec_prod_job_bonuses.review_status
--   column: public.pec_prod_job_bonuses.reviewed_by
--   column: public.pec_prod_job_bonuses.reviewed_at
--   column: public.pec_prod_job_bonuses.review_note
-- @end
-- ============================================================================
-- 2026-07-26 (prompt 50, Part E2): callback review gate on crew bonuses.
-- Author: Claude Code. Idempotent. Written for Cowork to apply (standing rule).
--
-- When a job has a callback visit (another pec_prod_jobs row with
-- is_callback = true and original_job_id pointing at it), the parent job's
-- bonuses get flagged for MANUAL review on the Bonus Report. review_status
-- records the decision: 'pay_full' | 'reduced' | 'voided' (NULL = not yet
-- reviewed; a flagged, unreviewed bonus is not payable). No automatic math:
-- a Reduce is an admin typing the new amount themselves. reviewed_by is the
-- reviewer's auth uuid. No RLS change: the existing staff policy
-- (is_admin_staff()) already covers new columns on this table.
-- ============================================================================

BEGIN;

ALTER TABLE public.pec_prod_job_bonuses
  ADD COLUMN IF NOT EXISTS review_status text,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text;

COMMIT;
