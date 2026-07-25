-- @artifacts
--   none: function and trigger only
-- @end
-- ============================================================================
-- 2026-07-21: manual completion is the source of truth (no schedule
-- auto-complete)
-- ============================================================================
-- Supersedes the FINAL branch of 2026-06-09_unified_status_trigger.sql. That
-- version auto-completed a job the day after its LAST scheduled day
-- (today > end -> 'completed', stamping completed_date = end). Because
-- 'completed' never re-evaluates (the status <> 'completed' guard below, by
-- design), adding a day back to an auto-completed job (reschedule, a later
-- phase, a warranty/callback day) left it 'completed' while carrying a future
-- scheduled day, cluttering the Invoicing tab's AR bucket with jobs that are
-- not actually receivable.
--
-- Dylan's decision (2026-07-21): a job only becomes 'completed' when a HUMAN
-- marks it complete (Mark Complete on the job detail / Invoicing tab, the
-- pipeline drag, or a prod-side complete). The schedule running out now leaves
-- the job 'in_progress'; the Invoicing tab's "Ready to invoice" section
-- surfaces finished-but-unmarked work so nothing goes uninvoiced.
--
-- The rule (client copy: deriveJobStatus() in index.html -- BOTH must produce
-- the SAME status for the same span; do not change one without the other):
--   start = least(install_date, earliest schedule day)
--   end   = greatest(install_date, latest schedule day)
--   today = now() at America/Phoenix (single timezone, no DST per project)
--     prod row 'completed'      -> completed   (a genuine manual completion
--                                  mirrored from the calendar side)
--     no schedule (no start)    -> signed
--     start > today             -> scheduled
--     start <= today            -> in_progress (INCLUDING past the last day)
--
-- Also removed: the completed_date auto-stamp. The trigger NEVER stamps a
-- completion date now; the human Mark Complete paths stamp it, so the recorded
-- date is the real human completion, not a schedule artifact.
--
-- Unchanged on purpose: the NEW.status = 'completed' branch (a prod row a
-- human marked complete still mirrors to the CRM job), the status <>
-- 'completed' never-downgrade guard, the status_manual_at clear (a genuine
-- calendar change still overrides a stale manual pin), and the deal-id bridge.
--
-- GOING FORWARD ONLY: no data backfill; existing rows' stored status is not
-- touched. The Invoicing tab handles the pre-existing backlog by display
-- (the "Completed, but still on the schedule" section).
--
-- security definer. Idempotent; safe to re-run.
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
  else
    target := 'in_progress';           -- started, INCLUDING past the last day:
                                       -- only a human completes a job
  end if;

  update public.jobs
     set status = target,
         status_manual_at = null       -- a genuine calendar change clears the pin
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
--   select prosrc like '%only a human completes a job%' as new_rule_live
--     from pg_proc where proname = 'pec_prod_jobs_sync_public_status';
--   -- expect: true (the replaced function body is the one deployed).
-- Do NOT run any backfill: this change is going-forward only, existing rows'
-- stored status stays as-is (the pre-2026-06-09 "no-op UPDATE fires the
-- trigger for every bridged row" trick would rewrite history here; skip it).
