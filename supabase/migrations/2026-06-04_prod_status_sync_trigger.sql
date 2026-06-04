-- ============================================================================
-- 2026-06-04: mirror production-calendar state onto public.jobs.status
-- ============================================================================
-- The recurring "scheduled on the calendar but still shows signed/unscheduled
-- everywhere else" bug: scheduling writes pec_prod_jobs (status + install_date)
-- but historically nothing wrote public.jobs.status, which the Pipeline, Jobs
-- list, and job-detail label read. The client now writes it at schedule time
-- (syncPublicJobStatusFromSchedule), and THIS trigger is the path-independent
-- backstop: any change to a pec_prod_jobs row's status/install_date (UI, Cowork
-- SQL, a future webhook) mirrors onto the bridged public.jobs row(s).
--
-- Bridge: dripjobs_deal_id (manual prod-only rows have none, so they are a
-- no-op here, matching the fact that they have no public.jobs row).
--
-- State machine (calendar drives it):
--   completed (prod)                         -> completed
--   scheduled/ordered/delivered OR install_date set:
--        install_date <= today (Phoenix)     -> in_progress
--        else                                -> scheduled
--   otherwise (unscheduled, no install_date) -> signed
-- "Calendar wins": the update clears status_manual_at so the job can still
-- auto-advance. It never downgrades a CRM job that is already 'completed'.
--
-- DEPENDENCY: run 2026-06-03_jobs_status_manual_override.sql FIRST (this
-- function sets status_manual_at). Idempotent; safe to re-run.
-- ============================================================================

begin;

create or replace function public.pec_prod_jobs_sync_public_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target text;
begin
  if NEW.dripjobs_deal_id is null then
    return NEW;
  end if;

  if NEW.status = 'completed' then
    target := 'completed';
  elsif NEW.status in ('scheduled','ordered','delivered') or NEW.install_date is not null then
    if NEW.install_date is not null
       and NEW.install_date <= (now() at time zone 'America/Phoenix')::date then
      target := 'in_progress';
    else
      target := 'scheduled';
    end if;
  else
    target := 'signed';
  end if;

  update public.jobs
     set status = target,
         status_manual_at = null
   where dripjobs_deal_id = NEW.dripjobs_deal_id
     and status is distinct from target
     and status <> 'completed';

  return NEW;
end;
$$;

drop trigger if exists trg_pec_prod_jobs_sync_status on public.pec_prod_jobs;
create trigger trg_pec_prod_jobs_sync_status
  after insert or update of status, install_date on public.pec_prod_jobs
  for each row execute function public.pec_prod_jobs_sync_public_status();

commit;

-- Verify after running:
--   select tgname from pg_trigger where tgrelid = 'public.pec_prod_jobs'::regclass
--     and tgname = 'trg_pec_prod_jobs_sync_status';
--   -- expect: 1 row.
-- Optional backfill (re-mirror every currently-scheduled prod row in one shot):
--   update public.pec_prod_jobs set status = status where dripjobs_deal_id is not null;
--   -- the no-op UPDATE fires the trigger for every bridged row.
