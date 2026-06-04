-- ============================================================================
-- 2026-06-03: one-shot backfill of public.jobs.status from current data
-- ============================================================================
-- Brings every existing job's status in line with the state machine:
--   completed   if completed_date is set
--   in_progress if the bridged install_date is today or earlier (Phoenix)
--   scheduled   if there is a bridged install_date in the future
--   signed      otherwise
--
-- WHY the bridge: install_date does NOT live on public.jobs. It lives on the
-- sibling table public.pec_prod_jobs, matched to a job by dripjobs_deal_id
-- (see CLAUDE.md "Two parallel job tables"). So "this job's install date" is
-- max(install_date) over the non-archived pec_prod_jobs rows sharing the deal
-- id. Manual jobs (dripjobs_deal_id NULL) have no bridge, so they resolve to
-- signed unless they were completed.
--
-- Today is Phoenix-local ((now() at time zone 'America/Phoenix')::date), the
-- same basis pec-auto-progress.cjs uses, so the boundary day agrees.
--
-- SAFETY:
--   - Skips rows with status_manual_at set (an admin pinned those by hand).
--   - Skips archived (archived_at) and voided (voided_at) rows.
--   - completed_date is the only thing that produces 'completed', so a job is
--     never auto-marked complete here.
--   - Idempotent: re-running after it converges updates 0 rows.
--
-- NOTE on a known edge case: a job that someone hand-set to 'in_progress' in
-- the past (before status_manual_at existed) but that has NO bridged install
-- date and no completed_date will be moved to 'signed' by the rule above. Run
-- the PREVIEW first and eyeball those rows before running the UPDATE; if any
-- are legitimately in progress, set them manually (the dropdown now persists)
-- AFTER the backfill so status_manual_at protects them.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STEP 1 (PREVIEW, read-only): what WOULD change, and the resulting spread.
-- Run this alone first. Capture the row list and the summary counts.
-- ----------------------------------------------------------------------------
with bridged as (
  select j.id as job_id,
         max(pj.install_date) as install_date
    from public.jobs j
    left join public.pec_prod_jobs pj
      on pj.dripjobs_deal_id = j.dripjobs_deal_id
     and j.dripjobs_deal_id is not null
     and pj.archived_at is null
   group by j.id
),
calc as (
  select j.id,
         j.status as old_status,
         case
           when j.completed_date is not null then 'completed'
           when b.install_date is not null
             and b.install_date <= (now() at time zone 'America/Phoenix')::date then 'in_progress'
           when b.install_date is not null then 'scheduled'
           else 'signed'
         end as new_status
    from public.jobs j
    join bridged b on b.job_id = j.id
   where j.archived_at is null
     and j.voided_at is null
     and j.status_manual_at is null
)
select old_status, new_status, count(*) as n
  from calc
 where old_status is distinct from new_status
 group by old_status, new_status
 order by old_status, new_status;

-- ----------------------------------------------------------------------------
-- STEP 2 (WRITE): apply the backfill. Same CTE; updates only rows that differ.
-- Wrapped in a transaction so it is all-or-nothing.
-- ----------------------------------------------------------------------------
begin;

with bridged as (
  select j.id as job_id,
         max(pj.install_date) as install_date
    from public.jobs j
    left join public.pec_prod_jobs pj
      on pj.dripjobs_deal_id = j.dripjobs_deal_id
     and j.dripjobs_deal_id is not null
     and pj.archived_at is null
   group by j.id
),
calc as (
  select j.id,
         case
           when j.completed_date is not null then 'completed'
           when b.install_date is not null
             and b.install_date <= (now() at time zone 'America/Phoenix')::date then 'in_progress'
           when b.install_date is not null then 'scheduled'
           else 'signed'
         end as new_status
    from public.jobs j
    join bridged b on b.job_id = j.id
   where j.archived_at is null
     and j.voided_at is null
     and j.status_manual_at is null
)
update public.jobs j
   set status = c.new_status
  from calc c
 where j.id = c.id
   and j.status is distinct from c.new_status;

commit;

-- ----------------------------------------------------------------------------
-- STEP 3 (VERIFY, read-only): final spread + a re-run of the preview, which
-- should now return 0 rows (converged).
-- ----------------------------------------------------------------------------
select status, count(*) from public.jobs
 where archived_at is null and voided_at is null
 group by status order by status;
