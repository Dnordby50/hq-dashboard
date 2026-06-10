-- ============================================================================
-- 2026-06-09: unified job-status state machine (ONE rule, client + DB)
-- ============================================================================
-- Supersedes 2026-06-04_prod_status_sync_trigger.sql. That version completed a
-- job off its install_date alone (so a multi-day job read "complete" on day 1)
-- and never produced 'in_progress'. This trigger is the SERVER copy of the one
-- canonical rule now also implemented client-side as deriveJobStatus() in
-- index.html. Both must produce the SAME status so a job reads identically in
-- the Pipeline, the Jobs list, the job detail, and the schedule calendar.
--
-- The rule:
--   start = least(install_date, earliest schedule day)
--   end   = greatest(install_date, latest schedule day)
--   today = now() at America/Phoenix (single timezone, no DST per project)
--     prod row 'completed'      -> completed
--     no schedule (no start)    -> signed
--     start > today             -> scheduled
--     start <= today <= end     -> in_progress
--     today > end               -> completed  (auto-complete the day AFTER the
--                                  LAST scheduled day; stamp completed_date = end)
--
-- "Calendar wins": this fires only on a GENUINE prod-row change (status or
-- install_date), so it clears status_manual_at -- a real calendar action should
-- override a stale manual pin. It NEVER downgrades a job already 'completed'.
--
-- Bridge: dripjobs_deal_id (manual prod-only rows have none, so they are a
-- no-op here, matching the fact that they have no public.jobs row).
--
-- KNOWN LIMITATION -- the client runScheduleStatusSync is the comprehensive
-- path; this trigger is the path-independent backstop. Firing on a single prod
-- row, it sees only THAT row's schedule days (pec_prod_job_schedule_days.job_id
-- = NEW.id), not every row sharing the deal id, and it does not fire on bare
-- schedule-day edits. So for a job split across a webhook row + a manual row, or
-- one rescheduled by editing only the day rows, the client sweep reconciles the
-- aggregated span; this trigger keeps the common case correct on its own.
--
-- DEPENDENCY: run 2026-06-03_jobs_status_manual_override.sql FIRST (it adds
-- status_manual_at). security definer. Idempotent; safe to re-run.
-- ============================================================================

begin;

create or replace function public.pec_prod_jobs_sync_public_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'America/Phoenix')::date;
  v_start date;
  v_end   date;
  target  text;
begin
  if NEW.dripjobs_deal_id is null then
    return NEW;
  end if;

  -- Span of THIS prod row: install_date plus its own schedule days. Postgres
  -- least()/greatest() ignore NULLs, so with no schedule days both fall back to
  -- NEW.install_date (and stay NULL together if install_date is also NULL).
  select least(NEW.install_date, min(sd.scheduled_date)),
         greatest(NEW.install_date, max(sd.scheduled_date))
    into v_start, v_end
    from public.pec_prod_job_schedule_days sd
   where sd.job_id = NEW.id;

  if NEW.status = 'completed' then
    target := 'completed';
  elsif v_start is null then
    target := 'signed';
  elsif v_start > v_today then
    target := 'scheduled';
  elsif v_today <= v_end then          -- v_end is non-null whenever v_start is
    target := 'in_progress';
  else
    target := 'completed';             -- today is past the LAST scheduled day
  end if;

  update public.jobs
     set status = target,
         status_manual_at = null,      -- a genuine calendar change clears the pin
         completed_date = case
           when target = 'completed' and completed_date is null then v_end
           else completed_date
         end
   where dripjobs_deal_id = NEW.dripjobs_deal_id
     and status is distinct from target
     and status <> 'completed';        -- never downgrade an already-completed CRM job

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
