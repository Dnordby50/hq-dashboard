-- @artifacts
--   setting: busybusy_autocreate_enabled
--   setting: busybusy_autocreate_radius_m
--   setting: busybusy_autocreate_reminders
-- @end
--
-- Prompt 68: BusyBusy project auto-creation on estimate acceptance.
-- Data-only: three settings rows (rule 12) for the Settings > BusyBusy
-- "Project auto-create" card. The accept path (_pec-busybusy.cjs) reads the
-- same keys with identical defaults, so the feature behaves the same before
-- and after this seed; the rows exist so the knobs are visible and editable.
-- No table or column changes: the pending-link state on
-- pec_prod_busybusy_projects reuses the existing nullable linked_by/linked_at
-- (null = created by TopCoat at acceptance, not yet touched by a human or an
-- import).

BEGIN;

INSERT INTO public.settings (key, value)
SELECT k, v FROM (VALUES
  ('busybusy_autocreate_enabled',   'true'),
  ('busybusy_autocreate_radius_m',  '150'),
  ('busybusy_autocreate_reminders', 'false')
) AS seed(k, v)
WHERE NOT EXISTS (SELECT 1 FROM public.settings s WHERE s.key = seed.k);

COMMIT;

-- Verify after running:
--   select key, value from public.settings where key like 'busybusy_autocreate%' order by key;
