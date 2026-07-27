-- @artifacts
--   column: public.pec_prod_jobs.touchup_state
--   column: public.pec_prod_jobs.touchup_opened_at
--   column: public.pec_prod_jobs.touchup_closed_at
--   column: public.pec_prod_jobs.touchup_cause
--   column: public.pec_prod_jobs.touchup_cause_note
--   column: public.pec_prod_jobs.touchup_closed_by
--   column: public.pec_prod_jobs.touchup_order
--   column: public.pec_prod_jobs.touchup_order_prev
--   column: public.pec_prod_jobs.touchup_billable
--   column: public.pec_prod_jobs.touchup_requested_by
--   index: idx_pec_prod_jobs_touchup_queue
--   setting: touchup_aging_days
--   setting: touchup_default_duration_hours
--   setting: touchup_panel_show_done_days
-- @end
-- ============================================================================
-- 2026-07-27 (prompt 51): touch-up queue tracking state on callback jobs.
-- Author: Claude Code. Idempotent, additive only. Written for Cowork to apply
-- (standing rule 8).
--
-- A touch-up is ALREADY a pec_prod_jobs row (is_callback = true,
-- original_job_id set, from 2026-06-08_touchup_callback.sql). This migration
-- adds the tracking layer the Touch-ups panel on the Job Schedule reads:
-- lifecycle state, age clock, close cause, manual queue order, and the
-- billable override. Columns live ON the row (not a sidecar table) because
-- the state is strictly 1:1 with the callback row and the panel renders from
-- the same loadProdCore select('*') read the schedule already does; a sidecar
-- would add a join and a row-sync hazard for zero benefit.
--
-- touchup_state is a PARALLEL axis to pec_prod_jobs.status, which is NOT
-- touched: callbacks stay status 'unscheduled' by design (runScheduleStatusSync
-- skips them; the calendar reads day rows). The scheduled_needs_revenue CHECK
-- is also untouched (it already exempts callbacks, so a billable callback with
-- revenue passes trivially).
--
-- Every column is nullable or defaulted, so the ~78 non-callback rows and all
-- existing rows are untouched by the ADD COLUMNs themselves.
-- ============================================================================

BEGIN;

ALTER TABLE public.pec_prod_jobs
  -- Lifecycle: NULL on non-callback rows. 'waiting_customer' coexists with
  -- status 'unscheduled' (parallel axes).
  ADD COLUMN IF NOT EXISTS touchup_state text
    CHECK (touchup_state IN ('open', 'scheduled', 'waiting_customer', 'done')),
  -- When the touch-up was requested; the age clock's anchor.
  ADD COLUMN IF NOT EXISTS touchup_opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS touchup_closed_at timestamptz,
  -- Cause is REQUIRED at close (enforced in the close modal, not here: a row
  -- must be able to exist open with no cause yet).
  ADD COLUMN IF NOT EXISTS touchup_cause text
    CHECK (touchup_cause IN ('crew_workmanship', 'material_failure',
      'customer_expectation', 'damage_after_install', 'sales_spec_error', 'other')),
  ADD COLUMN IF NOT EXISTS touchup_cause_note text,
  -- Auth uid of whoever closed it (no FK, same posture as
  -- pec_prod_job_bonuses.reviewed_by).
  ADD COLUMN IF NOT EXISTS touchup_closed_by uuid,
  -- Manual drag rank, lower first. Shared storage with "Sort by suggested";
  -- touchup_order_prev snapshots the pre-sort order per row so Undo sort can
  -- restore it (a column, not a settings row, because settings writes are
  -- admin-only and any staff can sort).
  ADD COLUMN IF NOT EXISTS touchup_order integer,
  ADD COLUMN IF NOT EXISTS touchup_order_prev integer,
  -- $0 warranty is the default; billable is an explicit override set together
  -- with a revenue value (never one without the other, enforced in the UI).
  ADD COLUMN IF NOT EXISTS touchup_billable boolean NOT NULL DEFAULT false,
  -- Free text: who reported it (customer, crew lead, inspection).
  ADD COLUMN IF NOT EXISTS touchup_requested_by text;

-- The panel loads on every schedule render; keep its filter cheap.
CREATE INDEX IF NOT EXISTS idx_pec_prod_jobs_touchup_queue
  ON public.pec_prod_jobs (is_callback, touchup_state, touchup_order);

-- Backfill existing callback rows (guarded on touchup_state IS NULL so a
-- re-run never overwrites live lifecycle data):
--   'done'      if the row has schedule days and they are ALL in the past
--   'scheduled' if it has any schedule day rows (some today/future)
--   'open'      if it has none
-- Age clock anchors to the row's created_at.
UPDATE public.pec_prod_jobs j
SET touchup_state = CASE
      WHEN EXISTS (SELECT 1 FROM public.pec_prod_job_schedule_days d
                   WHERE d.job_id = j.id)
       AND NOT EXISTS (SELECT 1 FROM public.pec_prod_job_schedule_days d
                       WHERE d.job_id = j.id AND d.scheduled_date >= current_date)
        THEN 'done'
      WHEN EXISTS (SELECT 1 FROM public.pec_prod_job_schedule_days d
                   WHERE d.job_id = j.id)
        THEN 'scheduled'
      ELSE 'open'
    END,
    touchup_opened_at = COALESCE(j.touchup_opened_at, j.created_at),
    -- Backfilled 'done' rows carry no cause (they predate cause capture);
    -- stamp the close clock so the Done section can age them out.
    touchup_closed_at = CASE
      WHEN j.touchup_closed_at IS NOT NULL THEN j.touchup_closed_at
      WHEN EXISTS (SELECT 1 FROM public.pec_prod_job_schedule_days d
                   WHERE d.job_id = j.id)
       AND NOT EXISTS (SELECT 1 FROM public.pec_prod_job_schedule_days d
                       WHERE d.job_id = j.id AND d.scheduled_date >= current_date)
        THEN (SELECT max(d.scheduled_date)::timestamptz
              FROM public.pec_prod_job_schedule_days d WHERE d.job_id = j.id)
      ELSE NULL
    END
WHERE j.is_callback = true
  AND j.touchup_state IS NULL;

-- Settings knobs (standing rule 12). Idempotent: existing values untouched.
--   touchup_aging_days             : days open before a panel row renders red.
--   touchup_default_duration_hours : prefills Estimated hours in the schedule
--                                    modal for a touch-up with none set.
--   touchup_panel_show_done_days   : how far back the panel's Done section reaches.
INSERT INTO public.settings (key, value) VALUES
  ('touchup_aging_days', '14'),
  ('touchup_default_duration_hours', '2'),
  ('touchup_panel_show_done_days', '30')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- RLS: nothing. The existing pec_prod_jobs staff policies cover new columns
-- (same posture as the 2026-07-26 bonus migrations).
