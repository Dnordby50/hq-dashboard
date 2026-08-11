-- @artifacts
--   setting: estimate_schedule_autoseed
-- @end
-- ============================================================================
-- 2026-08-18: auto-seed the payment schedule on every NEW estimate (DripJobs-
-- parity batch, phase 2). Author: Claude Code. Idempotent. Data-only.
--
-- WHY: prompt 74 built the estimate-side payment schedule but a rep had to
-- click "Set up payment schedule" on every estimate, so most proposals went
-- out with no payment plan visible. Dylan's locked decision (2026-08-10):
-- every new estimate starts with the default schedule (deposit percent from
-- the dominant system type, else default_deposit_pct; remaining balance due
-- at completion) so the customer proposal always shows the plan unless the
-- rep edits or removes it. The estimator honors this key (missing = ON);
-- edits of existing estimates NEVER auto-seed (zero rows there means the rep
-- removed the schedule on purpose).
-- ============================================================================

insert into public.settings (key, value) values
  ('estimate_schedule_autoseed', 'true')
on conflict (key) do nothing;
