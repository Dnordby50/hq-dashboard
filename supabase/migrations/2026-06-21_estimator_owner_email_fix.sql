-- ============================================================================
-- 2026-06-21 (estimator owner email fix): correct the allowlist value.
-- Author: Claude Code. RUN BY COWORK on PROD. Idempotent.
--
-- Why: the estimator visibility allowlist (public.settings.estimator_allowed_emails)
-- was seeded with dnordby50@gmail.com, but Dylan's CRM LOGIN email is
-- dylan@prescottepoxy.com, so the "Estimator (Beta)" button never matched and
-- stayed hidden. Overwrite the wrong auto-seeded value with the correct login
-- email. Guarded to only replace the known-wrong seed, so it never clobbers a
-- list Dylan has since edited by hand.
-- ============================================================================

update public.settings
   set value = 'dylan@prescottepoxy.com'
 where key = 'estimator_allowed_emails'
   and value = 'dnordby50@gmail.com';

-- If the row is somehow missing, create it with the correct value.
insert into public.settings (key, value) values
  ('estimator_allowed_emails', 'dylan@prescottepoxy.com')
on conflict (key) do nothing;

-- Verify:
--   select value from public.settings where key = 'estimator_allowed_emails';
--   -- expect dylan@prescottepoxy.com
