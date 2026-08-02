-- @artifacts
--   setting: lost_reason_ai_backfill_enabled
-- @end

-- Prompt 62 Part G: master switch for the nightly lost-reason AI backfill
-- (pec-lost-reason-backfill). Seeded 'true': the function also treats a
-- missing row as on, so this seed is for visibility in Settings, not a gate.
INSERT INTO settings (key, value)
VALUES ('lost_reason_ai_backfill_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
