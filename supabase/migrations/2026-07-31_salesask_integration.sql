-- @artifacts
--   table: public.pec_salesask_recordings
--   column: public.pec_appointments.salesask_synced_at
--   column: public.pec_appointments.salesask_sync_hash
--   column: public.pec_sales_team_members.salesask_email
--   index: idx_pec_salesask_recordings_customer
--   index: idx_pec_salesask_recordings_appt
--   index: idx_pec_salesask_recordings_lead
--   setting: salesask_sync_enabled
--   setting: salesask_push_window_days
--   setting: salesask_pull_lookback_days
-- @end
-- ============================================================================
-- 2026-07-31: SalesAsk integration (in-home sales call recordings + coaching)
-- ============================================================================
-- Dylan is rolling out SalesAsk (AI recording/coaching for in-person sales
-- appointments, org "Prescott Epoxy Company"). The loop:
--   1. pec-salesask-sync.cjs (cron) pushes upcoming pec_appointments to
--      SalesAsk as "scheduled tasks" with event_id = our appointment id, so
--      the rep's mobile recording auto-attaches to the right appointment.
--      salesask_synced_at / salesask_sync_hash on pec_appointments are the
--      push bookkeeping (hash of the pushed fields; unchanged rows are
--      skipped, canceled rows get a DELETE).
--   2. pec-webhook-salesask.cjs (/api/salesask/webhook) receives
--      recording.processed events and upserts rows here, keyed on the
--      SalesAsk recording id. SalesAsk webhooks have NO retries, so the same
--      cron also reconciles by listing recent recordings from their REST API;
--      the unique key makes both paths idempotent.
--   3. Once processed, the transcript is fetched and a 'salesask_recording'
--      lead_events row is inserted, which puts the recording on the lead
--      timeline AND into pec-lead-ai's context gather for free (it reads
--      lead_events payloads).
--
-- Linkage is relational, no estimate column needed: recording ->
-- appointment_id -> pec_appointments.lead_id -> estimates.lead_id.
--
-- Same trust model as pec_call_log (2026-07-06_quo_call_log.sql): staff can
-- READ, no client write policy, only the service-role functions write.
-- pec_sales_team_members has no plain email column (only google_email), so
-- salesask_email is the explicit "this rep's SalesAsk login" override; the
-- sync resolves salesask_email -> people.email -> google_email.
--
-- *** COWORK HANDOFF: run this in the PROD Supabase project. ***
-- Idempotent / safe to re-run.
-- ============================================================================

begin;

create table if not exists public.pec_salesask_recordings (
  id                     uuid primary key default gen_random_uuid(),
  salesask_recording_id  text not null unique,
  appointment_id         uuid references public.pec_appointments(id) on delete set null,
  lead_id                uuid,          -- no FK, matching pec_appointments.lead_id (survives lead soft-delete)
  customer_id            uuid references public.customers(id) on delete set null,
  sales_member_id        uuid references public.pec_sales_team_members(id) on delete set null,
  rep_email              text,
  occurred_at            timestamptz,
  duration_seconds       numeric(10,1),
  status                 text,          -- 'processing' | 'processed' | 'processing-failed'
  title                  text,
  summary                text,
  notes                  text,
  action_items           jsonb,
  coaching               jsonb,
  tags                   jsonb,
  process_followed       integer,
  process_missed         integer,
  process_total          integer,
  recording_url          text,
  transcript             jsonb,         -- SalesAsk utterances {speaker,text,start,end}, verbatim
  raw                    jsonb,         -- last full API/webhook document, for fields we don't model yet
  match_method           text,          -- 'event_id' | 'rep_time_window' | 'name_fuzzy' | 'unmatched'
  transcript_pending     boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists idx_pec_salesask_recordings_customer on public.pec_salesask_recordings (customer_id, occurred_at desc);
create index if not exists idx_pec_salesask_recordings_appt     on public.pec_salesask_recordings (appointment_id);
create index if not exists idx_pec_salesask_recordings_lead     on public.pec_salesask_recordings (lead_id, occurred_at desc);

alter table public.pec_salesask_recordings enable row level security;

-- Staff READ only; no client write policy (service-role webhook/cron writes).
drop policy if exists pec_salesask_recordings_read on public.pec_salesask_recordings;
create policy pec_salesask_recordings_read on public.pec_salesask_recordings for select
  using (public.is_admin_staff());

-- Shared touch trigger function already exists (2026-04-28_pm_ordering.sql).
drop trigger if exists trg_pec_salesask_recordings_touch on public.pec_salesask_recordings;
create trigger trg_pec_salesask_recordings_touch before update on public.pec_salesask_recordings
  for each row execute function public.pec_prod_touch_updated_at();

-- Push bookkeeping on appointments + the rep's SalesAsk login email.
alter table public.pec_appointments add column if not exists salesask_synced_at timestamptz;
alter table public.pec_appointments add column if not exists salesask_sync_hash text;
alter table public.pec_sales_team_members add column if not exists salesask_email text;

-- Settings knobs (rule 12), insert-only so live edits are never clobbered.
-- salesask_sync_enabled ships 'false': nothing pushes or pulls until Dylan
-- flips it on from Settings after the API key + webhook are configured.
insert into public.settings (key, value)
select 'salesask_sync_enabled', 'false'
where not exists (select 1 from public.settings where key = 'salesask_sync_enabled');

insert into public.settings (key, value)
select 'salesask_push_window_days', '14'
where not exists (select 1 from public.settings where key = 'salesask_push_window_days');

insert into public.settings (key, value)
select 'salesask_pull_lookback_days', '3'
where not exists (select 1 from public.settings where key = 'salesask_pull_lookback_days');

commit;

-- Verify after running:
--   select count(*) from information_schema.tables
--     where table_schema='public' and table_name='pec_salesask_recordings';   -- 1
--   select count(*) from pg_policies where tablename='pec_salesask_recordings'; -- 1 (select only)
--   select column_name from information_schema.columns
--     where table_name='pec_appointments' and column_name like 'salesask%';   -- 2 rows
--   select column_name from information_schema.columns
--     where table_name='pec_sales_team_members' and column_name='salesask_email'; -- 1 row
--   select key, value from settings where key like 'salesask%';               -- 3 rows
