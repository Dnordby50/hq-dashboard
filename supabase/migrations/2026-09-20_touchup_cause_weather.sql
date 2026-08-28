-- @artifacts
--   none: extends the pec_prod_jobs_touchup_cause_check CHECK constraint with
--     one new allowed value; CHECK constraints are not one of @artifacts' four
--     kinds (table/column/index/setting), same precedent as the material_type
--     CHECK widening and the prompt-93 kind widening.
-- @end
-- ============================================================================
-- 2026-09-20: add 'weather' to the touch-up cause vocabulary.
-- Author: Cowork. Direct to prod per rule 14: one CHECK constraint widened,
-- additive only, no money/auth/estimates.status touched.
--
-- WHY: Dylan classified the Harold Tuttle callback ("Bubbles in quarts",
-- opened 2026-08-25) as weather. The existing vocabulary
-- (crew_workmanship | material_failure | customer_expectation |
-- damage_after_install | sales_spec_error | other) has no home for it, so the
-- answer landed in 'other' with a note. 'other' is where causes go to stop
-- being analyzable: the touch-up cause breakdown (index.html renderTouchup
-- summary) groups by this column, and a cause parked in 'other' can never
-- show a trend. Dylan asked for the real value on 2026-08-27.
--
-- WHY additive and not a re-bucketing: widening a CHECK cannot invalidate an
-- existing row (every current value stays legal), so this is replay-safe and
-- needs no backfill. The one row that motivated it is re-recorded separately,
-- not inside this migration, so re-running the DDL never touches data.
--
-- NOTE for whoever picks up the UI half: index.html TOUCHUP_CAUSES (~line
-- 36222) still needs `weather: 'Weather'` added, or the close-touch-up modal's
-- picker cannot produce this value. The READ paths already degrade safely
-- (`TOUCHUP_CAUSES[v] || v` renders the raw word), but closing the Tuttle
-- touch-up through the modal before that lands would overwrite 'weather' with
-- whatever the picker does offer.
-- ============================================================================

alter table public.pec_prod_jobs
  drop constraint if exists pec_prod_jobs_touchup_cause_check;

alter table public.pec_prod_jobs
  add constraint pec_prod_jobs_touchup_cause_check
  check (touchup_cause = any (array[
    'crew_workmanship'::text,
    'material_failure'::text,
    'customer_expectation'::text,
    'damage_after_install'::text,
    'sales_spec_error'::text,
    'weather'::text,
    'other'::text
  ]));
