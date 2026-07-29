-- @artifacts
--   column: public.leads.routemize_contact_id
--   column: public.customers.routemize_contact_id
--   setting: routemize_service_type_map
-- @end
-- ============================================================================
-- 2026-08-01 (prompt 56): Routemize native-webhook adapter support.
-- Author: Claude Code. Idempotent. Written for Cowork to apply (standing rule).
--
-- 1. routemize_contact_id on leads AND customers (decision 12): Routemize's
--    contact.contactId lands on whichever entity the appointment intake
--    matched or created (lead preferred, customer as fallback), so a person
--    who books again is recognizable by Routemize's own id even if their
--    phone/email changes on our side. Nullable text, no index: nothing
--    queries by it yet, and the intake writes it fill-if-blank.
--    pec-appt-intake.cjs tolerates this column being ABSENT (landmine 8),
--    so deploy order does not matter; applying this simply makes the store
--    start sticking.
--
-- 2. routemize_service_type_map setting (decision 5 / standing rule 12): JSON
--    text mapping a Routemize serviceName (or eventTypeId) to one of the four
--    TopCoat appt types (on_site_estimate / project_walkthrough / site_visit /
--    other), matched lowercased, serviceName first. Anything unmapped defaults
--    to on_site_estimate, so adding a Routemize service needs a Settings edit
--    (Settings > Appointments > Routemize booking intake), never a deploy.
--    Insert-only: a re-run never clobbers live edits.
-- ============================================================================

BEGIN;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS routemize_contact_id text;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS routemize_contact_id text;

INSERT INTO public.settings (key, value)
VALUES ('routemize_service_type_map', '{"estimate":"on_site_estimate"}')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND column_name='routemize_contact_id';
--   -- expect two rows: leads, customers
--   SELECT value FROM public.settings WHERE key='routemize_service_type_map';
--   -- expect: {"estimate":"on_site_estimate"} (or a later Settings edit)
