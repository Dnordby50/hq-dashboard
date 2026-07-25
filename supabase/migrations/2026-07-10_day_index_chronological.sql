-- @artifacts
--   none: data-only renumber of pec_prod_job_schedule_days.day_index
-- @end
-- One-time backfill: renumber day_index chronologically for ALL existing
-- schedule rows.
--
-- openScheduleModal used to write day_index in CLICK order, so a day added
-- before an already scheduled date could carry a later index than dates
-- after it (the job detail's "Day N" column then read out of order).
-- openAddJobModal always sorted. As of this migration's companion commit the
-- schedule modal sorts too (earliest selected date is Day 1 / day_index 0),
-- so this backfill brings historical rows in line with what every writer
-- produces from now on.

with ranked as (
  select id,
         row_number() over (partition by job_id order by scheduled_date) - 1 as new_idx
  from public.pec_prod_job_schedule_days
)
update public.pec_prod_job_schedule_days d
set day_index = r.new_idx
from ranked r
where r.id = d.id
  and d.day_index <> r.new_idx;
