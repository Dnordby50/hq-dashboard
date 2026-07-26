-- @artifacts
--   column: public.pec_prod_job_costing.office_notes
--   column: public.pec_prod_job_costing.office_notes_by
--   column: public.pec_prod_job_costing.office_notes_at
-- @end
-- ============================================================================
-- 2026-07-26 (prompt 50, Part C): Office notes on job costing.
-- Author: Claude Code. Idempotent. Written for Cowork to apply (standing rule).
--
-- A distinct office-facing note field on pec_prod_job_costing, separate from
-- the existing `notes` column (untouched). Author uuid + timestamp are
-- stamped by the client on every save so the detail page can show
-- "Anne, Jul 26 2:14 PM". No RLS change: the existing costing policies
-- (is_admin_staff() AND has_permission('can_view_job_costing')) already
-- cover new columns on the same table, and widening them would weaken the
-- 2026-07-25 security posture.
-- ============================================================================

BEGIN;

ALTER TABLE public.pec_prod_job_costing
  ADD COLUMN IF NOT EXISTS office_notes text,
  ADD COLUMN IF NOT EXISTS office_notes_by uuid,
  ADD COLUMN IF NOT EXISTS office_notes_at timestamptz;

COMMIT;
