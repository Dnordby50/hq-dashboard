-- ============================================================================
-- 2026-06-07: add a third Next-Day slot ('EXTRA')
-- ============================================================================
-- The Next-Day finalization board had two slots per crew (AM = first visit,
-- PM = second visit). Crews sometimes run a third, smaller job, or an overflow
-- job needs a place to land. Widen the time_slot CHECK to allow 'EXTRA' (the
-- board shows it as the "Extra (overflow)" column). Still nullable: null = slot
-- not set yet.
--
-- Additive + idempotent. Deploy-order safe: the client already writes time_slot
-- with a fallback, and only writes 'EXTRA' once this runs.

begin;

alter table public.pec_prod_job_schedule_days
  drop constraint if exists pec_prod_job_schedule_days_time_slot_check;
alter table public.pec_prod_job_schedule_days
  add constraint pec_prod_job_schedule_days_time_slot_check
  check (time_slot is null or time_slot in ('AM','PM','EXTRA'));

commit;

-- Verify after running:
--   insert into public.pec_prod_job_schedule_days (job_id, scheduled_date, time_slot)
--     values (<some job_id>, current_date, 'EXTRA');  -- should succeed, then delete it.
--   -- or inspect the constraint:
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conname = 'pec_prod_job_schedule_days_time_slot_check';
