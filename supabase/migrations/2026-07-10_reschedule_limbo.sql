-- @artifacts
--   column: public.pec_prod_jobs.reschedule_days_owed
--   column: public.pec_prod_jobs.rescheduled_from
-- @end
-- Reschedule limbo flag on production jobs.
--
-- The Job Schedule modal's "Reschedule" flow pulls some (or all) of a job's
-- scheduled days off the calendar and parks the job in the Pending column,
-- badged "Reschedule · N day(s)", until the days are rebooked.
--
--   reschedule_days_owed: how many pulled days still need to be rescheduled.
--     0 = not in limbo. Accumulates across pulls; saving a new schedule for
--     the job resets it to 0 (a save is a full replace of the day rows).
--   rescheduled_from: the EARLIEST pulled date, shown on the Pending card as
--     "was scheduled for <date>". Cleared alongside the counter.
--
-- The client tolerates these columns not existing yet (best-effort writes,
-- same pattern as pending_hidden_at), so this migration can land before or
-- after the code deploy.

alter table public.pec_prod_jobs
  add column if not exists reschedule_days_owed integer not null default 0,
  add column if not exists rescheduled_from date;

comment on column public.pec_prod_jobs.reschedule_days_owed is
  'Days pulled off the calendar that still need rescheduling. > 0 puts the job in the schedule Pending column with an amber badge; cleared to 0 when a new schedule is saved.';
comment on column public.pec_prod_jobs.rescheduled_from is
  'Earliest pulled date for the reschedule badge ("was scheduled for ..."). Null when not in reschedule limbo.';
