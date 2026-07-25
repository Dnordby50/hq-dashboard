-- @artifacts
--   table: public.pec_sync_stuck_reports
--   index: idx_pec_sync_stuck_reports_open
--   setting: sync_stuck_threshold_attempts
--   setting: sync_stuck_escalation_enabled
-- @end
-- ============================================================================
-- 2026-07-25 (prompt 48, Part B): stuck-sync escalation reports.
-- Author: Claude Code. Idempotent. Written for Cowork to apply (standing rule).
--
-- When a queued estimator save fails sync_stuck_threshold_attempts times, the
-- PWA reports its metadata (ids, attempt count, raw error -- never row bodies
-- or customer PII) to pec-sync-stuck.cjs, which upserts here keyed on op_id
-- so repeated reports from new sessions UPDATE one row instead of piling up.
-- resolved_at is for the office: set it when the underlying cause is fixed;
-- a later report on the same op clears it (the op re-broke) and re-bells.
--
-- The pec_estimate_views shape: service-role writes through the endpoint,
-- staff read-only for a future dashboard surface, no client write policy.
-- ============================================================================

begin;

create table if not exists public.pec_sync_stuck_reports (
  id              uuid primary key default gen_random_uuid(),
  op_id           text not null unique,
  table_name      text not null,
  row_id          uuid,
  attempts        int not null default 0,
  first_queued_at timestamptz,
  last_error      text,
  estimate_id     uuid,
  reported_at     timestamptz not null default now(),
  resolved_at     timestamptz
);

-- The open-items read is "unresolved first, newest report first".
create index if not exists idx_pec_sync_stuck_reports_open
  on public.pec_sync_stuck_reports (resolved_at, reported_at desc);

alter table public.pec_sync_stuck_reports enable row level security;

drop policy if exists pec_sync_stuck_reports_staff_read on public.pec_sync_stuck_reports;
create policy pec_sync_stuck_reports_staff_read on public.pec_sync_stuck_reports
  for select using (public.is_admin_staff());

-- Settings (rule 12), insert-only so live values are never clobbered:
--   sync_stuck_threshold_attempts: failed attempts before the estimator
--     shows the red "not syncing" state (1 failure is a blip, 2 is real).
--   sync_stuck_escalation_enabled: whether a stuck save also raises an
--     admin bell via pec-sync-stuck (the red banner shows regardless).
insert into public.settings (key, value)
select 'sync_stuck_threshold_attempts', '2'
where not exists (select 1 from public.settings where key = 'sync_stuck_threshold_attempts');
insert into public.settings (key, value)
select 'sync_stuck_escalation_enabled', 'true'
where not exists (select 1 from public.settings where key = 'sync_stuck_escalation_enabled');

commit;

-- ============================================================================
-- Verify after running:
--   select relrowsecurity from pg_class where relname='pec_sync_stuck_reports'; -- t
--   select policyname, cmd from pg_policies
--     where tablename='pec_sync_stuck_reports';  -- pec_sync_stuck_reports_staff_read / SELECT
--   select indexname from pg_indexes
--     where tablename='pec_sync_stuck_reports';  -- pkey + op_id unique + idx_pec_sync_stuck_reports_open
--   select key, value from settings
--     where key in ('sync_stuck_threshold_attempts','sync_stuck_escalation_enabled'); -- 2, true
-- ============================================================================
