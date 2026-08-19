-- @artifacts
--   column: public.leads.scored_at
--   setting: lead_score_nightly_enabled
--   setting: lead_score_batch_cap
--   setting: lead_score_stages
--   setting: lead_score_model
-- @end
-- ============================================================================
-- 2026-09-09: prompt 97, lead scoring goes live for every lead. Author:
-- Claude Code. Applied to PROD via MCP. Idempotent. Additive (rule 14: a
-- nullable timestamptz on leads plus settings seeds; no money/auth/
-- estimates.status touched, direct to prod).
--
-- WHY: leads.score was written only by the web-form intake path and the
-- Refresh button, so most leads (which now arrive through Routemize) were
-- never scored, and a scored lead was scored once at intake forever. Prompt
-- 97 kicks the AI from every lead-creation door and adds a nightly re-score
-- runner (pec-lead-score-runner.cjs). scored_at is the staleness column that
-- runner orders by and the badge tooltip reads ("Scored 2 days ago");
-- ai_analyzed_at keeps its existing meaning (last full-analysis write) and
-- the two are stamped together by the shared core.
--
-- Settings (rule 12), surfaced on Settings > Drips > Lead scoring:
--   lead_score_nightly_enabled  front-of-card on/off (missing row = on)
--   lead_score_batch_cap        front-of-card; max model calls per run
--   lead_score_stages           Advanced; comma list of stages the nightly
--                               runner re-scores (lost/accepted are stripped
--                               server-side even if typed here)
--   lead_score_model            Advanced; empty = the code default model
-- ============================================================================

alter table public.leads add column if not exists scored_at timestamptz;

insert into public.settings (key, value) values
  ('lead_score_nightly_enabled', 'true'),
  ('lead_score_batch_cap', '50'),
  ('lead_score_stages', 'new,contacted,estimate_scheduled,presented,estimate_sent'),
  ('lead_score_model', '')
on conflict (key) do nothing;
