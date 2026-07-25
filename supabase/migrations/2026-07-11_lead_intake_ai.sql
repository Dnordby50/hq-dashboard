-- @artifacts
--   column: public.leads.campaign
--   column: public.leads.ad_meta
--   column: public.leads.ai_analysis
--   column: public.leads.ai_analyzed_at
--   index: idx_leads_phone_live
--   index: idx_leads_email_live
--   index: idx_lead_events_type
-- @end
-- ============================================================================
-- 2026-07-11: Lead intake + AI framework (weekend leads/pipeline build, phase 0).
-- Author: Cowork. Idempotent. NOT yet applied to prod; apply before the Zapier
-- intake endpoint goes live (the endpoint tolerates the missing columns until
-- then by failing loudly, it does not half-insert).
--
-- Why: leads/lead_events exist (2026-06-21_estimator_core.sql) but nothing
-- writes to them. This adds what the Zapier intake webhook and the AI analysis
-- layer need. Decisions from Dylan (Cowork interview, 2026-07-10): Zapier is
-- the intake path for Meta + Google; simplified 6-stage pipeline (the existing
-- stage check is already correct); AI analysis stored per lead, run on arrival
-- and on demand; no access gating.
--
-- No jobs.sqft change is needed for the $/sqft metric: public.jobs already has
-- sqft (populated by pec-webhook-proposal-accepted) and job_areas has per-area
-- sqft. The metric is a UI/read concern.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Intake attribution: which campaign/ad produced the lead. campaign is the
--    human-readable name for filters and the conversion-by-source metric;
--    ad_meta keeps the raw platform fields (form id, adset, ad id, utm params)
--    so nothing Zapier sends is thrown away.
-- ----------------------------------------------------------------------------
alter table public.leads
  add column if not exists campaign text,
  add column if not exists ad_meta  jsonb;

-- ----------------------------------------------------------------------------
-- 2. AI analysis storage. One jsonb blob per lead, replaced on each run:
--    { summary, score, score_reason, next_action, call_script, draft_sms,
--      draft_email, risk_flags[], model, generated_at }. leads.score (int,
--    already exists) is mirrored from ai_analysis.score so the kanban can
--    sort/badge without parsing jsonb.
-- ----------------------------------------------------------------------------
alter table public.leads
  add column if not exists ai_analysis    jsonb,
  add column if not exists ai_analyzed_at timestamptz;

-- ----------------------------------------------------------------------------
-- 3. Dedupe lookups for the intake webhook: match inbound leads by normalized
--    phone (last 10 digits) or lowercased email among live rows.
-- ----------------------------------------------------------------------------
create index if not exists idx_leads_phone_live
  on public.leads (phone) where deleted_at is null;
create index if not exists idx_leads_email_live
  on public.leads (lower(email)) where deleted_at is null;

-- ----------------------------------------------------------------------------
-- 4. OpenPhone call linkage: lead_events rows with event_type 'call' carry the
--    transcript in payload. Index event_type so the AI gather query and the
--    speed-to-lead metric read cheaply.
-- ----------------------------------------------------------------------------
create index if not exists idx_lead_events_type
  on public.lead_events (event_type, created_at desc);

commit;

-- ============================================================================
-- Verify after running:
--   select column_name from information_schema.columns
--     where table_name='leads'
--       and column_name in ('campaign','ad_meta','ai_analysis','ai_analyzed_at');  -- 4 rows
--   select indexname from pg_indexes where tablename='leads'
--     and indexname in ('idx_leads_phone_live','idx_leads_email_live');            -- 2 rows
-- ============================================================================
