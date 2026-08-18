-- @artifacts
--   table: public.pec_radar_alerts
--   index: pec_radar_alerts_dedupe_key_idx
--   index: pec_radar_alerts_status_idx
--   setting: radar_enabled
--   setting: radar_missed_call_grace_hours
--   setting: radar_missed_call_rate_threshold_pts
--   setting: radar_ar_balance_floor
--   setting: radar_ar_days_threshold
--   setting: radar_cold_estimate_value_floor
--   setting: radar_cold_estimate_days
--   setting: radar_callback_sla_days
--   setting: radar_escalation_call_count
--   setting: radar_mute_days
--   setting: radar_open_escalate_days
--   setting: radar_feed_stale_hours
-- @end
-- ============================================================================
-- 2026-09-05: Radar alert state table (Business Radar Cowork project).
-- Author: Claude Code. Applied to PROD via MCP. Idempotent.
--
-- WHY: the Business Radar project (a Cowork project that watches the phone,
-- the CRM, and email for operational misses) needs exactly one thing from
-- this database: a place to record findings so it never raises the same
-- finding twice and so an unresolved finding can age visibly. One row = one
-- finding. `dedupe_key` is the identity (unique index enforces never-twice);
-- `status` walks open -> acked/resolved/muted; `last_seen_at`/`seen_count`
-- let a recurring condition bump the existing row instead of minting a new
-- one. Radar writes via the service role (bypasses RLS); staff read and
-- write through the app so Dylan can ack or mute from a future UI.
--
-- Deliberately NOT here: a metrics/snapshot table. The 2026-08-18 audit
-- confirmed every tracked rate is reconstructible from live data
-- (pec_call_log, pec_job_ar, estimates, leads), so a snapshot would store
-- derivable data behind a cron that can silently stop.
--
-- RLS NOTE: the build prompt said "match the RLS pattern used by
-- pec_user_todos", describing it as staff read/write. pec_user_todos is
-- actually OWNER-ONLY (rows key on admin_user_id, deliberately private),
-- which cannot apply to a table with no owner column. The repo's canonical
-- staff-shared shape is is_admin_staff() on all verbs (policies.sql:
-- customers_staff, jobs_staff, etc.), which is what "staff read and write,
-- no anon access" means here, so that is what this table gets.
-- ============================================================================

begin;

create table if not exists public.pec_radar_alerts (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null,
  kind text not null,
  severity text not null default 'tier1',
  brand text,
  subject_type text,
  subject_id text,
  title text not null,
  detail text,
  dollars numeric,
  evidence jsonb,
  status text not null default 'open',
  fired_at timestamptz not null default now(),
  acked_at timestamptz,
  resolved_at timestamptz,
  muted_until timestamptz,
  last_seen_at timestamptz not null default now(),
  seen_count integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pec_radar_alerts_status_check
    check (status in ('open','acked','resolved','muted')),
  constraint pec_radar_alerts_severity_check
    check (severity in ('tier1','tier2','info'))
);

create unique index if not exists pec_radar_alerts_dedupe_key_idx
  on public.pec_radar_alerts (dedupe_key);
create index if not exists pec_radar_alerts_status_idx
  on public.pec_radar_alerts (status, fired_at desc);

alter table public.pec_radar_alerts enable row level security;

-- Staff full access, no anon path. Any signed-in staff member (admin_users
-- row for the auth uid) can read and write; anon sees nothing because no
-- policy grants it anything.
drop policy if exists pec_radar_alerts_staff on public.pec_radar_alerts;
create policy pec_radar_alerts_staff on public.pec_radar_alerts for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- Thresholds (standing rule 12): every knob radar fires on lives here so it
-- can be tuned with no code change. Values are the defaults from the radar
-- project spec. Missing row = the reader's default, same convention as every
-- other settings key.
insert into public.settings (key, value) values
  ('radar_enabled', 'true'),                        -- master switch
  ('radar_missed_call_grace_hours', '2'),           -- business hours before an unreturned call fires
  ('radar_missed_call_rate_threshold_pts', '8'),    -- points over the 8 week baseline before reporting
  ('radar_ar_balance_floor', '500'),                -- minimum balance on a completed job to fire
  ('radar_ar_days_threshold', '7'),                 -- days outstanding before it fires
  ('radar_cold_estimate_value_floor', '5000'),      -- minimum estimate value to track for going cold
  ('radar_cold_estimate_days', '5'),                -- days with no view before it fires
  ('radar_callback_sla_days', '10'),                -- age of an open callback before it fires
  ('radar_escalation_call_count', '3'),             -- calls from one number in 48 hours before it fires
  ('radar_mute_days', '30'),                        -- how long a mute holds
  ('radar_open_escalate_days', '3'),                -- age at which an open finding gets called out in the brief
  ('radar_feed_stale_hours', '12')                  -- age of the newest pec_call_log row before the feed is treated as dead
on conflict (key) do nothing;

commit;

-- ============================================================================
-- Verify after running:
--
-- a) Table exists with RLS on:
--   select relrowsecurity from pg_class where relname = 'pec_radar_alerts';  -- t
--
-- b) One staff policy covering all verbs:
--   select policyname, cmd from pg_policies where tablename = 'pec_radar_alerts';
--                                                            -- pec_radar_alerts_staff, ALL
--
-- c) Duplicate dedupe_key rejected:
--   insert twice with the same dedupe_key; second insert must raise 23505.
--
-- d) All 12 settings rows present:
--   select count(*) from settings where key like 'radar_%';                  -- 12
-- ============================================================================
