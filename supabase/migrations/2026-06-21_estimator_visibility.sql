-- ============================================================================
-- 2026-06-21 (estimator visibility): seed the allowlist setting.
-- Author: Claude Code. RUN BY COWORK on PROD. Idempotent.
--
-- Why: the estimator's "Estimator (Beta)" button in the dashboard is shown only
-- to emails listed in public.settings.estimator_allowed_emails. The dashboard
-- code already DEFAULTS to the owner email when this row is absent, so the
-- button works for Dylan with no DB change; this seed just makes the setting
-- visible + editable in Settings so Dylan can add other staff later (or set it
-- to 'all' to open it to everyone) without touching code.
--
-- The estimator's DATA is admin-only via RLS regardless of this UI gate.
-- ============================================================================

insert into public.settings (key, value) values
  ('estimator_allowed_emails', 'dnordby50@gmail.com')   -- owner only; add emails (comma-separated) or 'all'
on conflict (key) do nothing;

-- Verify:
--   select value from public.settings where key = 'estimator_allowed_emails';
