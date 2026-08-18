-- @artifacts
--   setting: quo_number_brand_map
-- @end
-- ============================================================================
-- 2026-09-06: number-to-brand fallback map for the Quo webhook. Author:
-- Claude Code. Applied to PROD via MCP. Idempotent. Data-only.
--
-- WHY: pec_call_log.brand was null on 33 rows in 30 days, every one of them
-- a call on the Aron personal inbox (+19284931922). brandForOurNumber in
-- pec-webhook-quo.cjs resolves brand from pec_sms_senders, which is keyed
-- PRIMARY KEY (brand), one row per brand, so a personal inbox that is not a
-- brand's send-from number can NEVER get a senders row. This key is the
-- fallback: a JSON object mapping our extra workspace numbers to a brand,
-- e.g. {"+19284931922": "prescott-epoxy"}.
--
-- Seeded EMPTY on purpose (the routemize_booking_url precedent): which brand
-- the Aron inbox belongs to, or whether it should be retired instead, is
-- Dylan's call. An unmapped number keeps resolving brand null; a wrong brand
-- is worse than a missing one. No Settings UI control (it is a webhook
-- config map, edited rarely); recorded in the orphan inventory's terms as a
-- deliberate no-surface key.
-- ============================================================================

insert into public.settings (key, value) values
  ('quo_number_brand_map', '{}')
on conflict (key) do nothing;
