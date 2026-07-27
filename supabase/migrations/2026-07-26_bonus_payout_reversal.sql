-- @artifacts
--   column: public.pec_bonus_payouts.reversed_at
--   column: public.pec_bonus_payouts.reversed_by
--   column: public.pec_bonus_payouts.reversal_reason
-- @end
-- ============================================================================
-- 2026-07-26 (prompt 50, Part E3): payout reversal with an audit trail.
-- Author: Claude Code. Idempotent. Written for Cowork to apply (standing rule).
--
-- Reversing an already-paid payout is a MARKING operation, never a delete:
-- the row keeps its amount / paid_on / payroll_date history and gains
-- reversed_at + reversed_by (auth uuid) + reversal_reason. A reversed payout
-- stops counting as paid everywhere it is summed (Bonus Report, payroll
-- report, handouts) and cannot be re-marked paid (its bonus stays out of
-- Pending). No RLS change: pec_bonus_payouts bp_write is is_admin_role()
-- with no permission-flag escape hatch, which is exactly the posture a
-- clawback tool should have; the UI hides the control from non-admins.
-- ============================================================================

BEGIN;

ALTER TABLE public.pec_bonus_payouts
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason text;

COMMIT;
