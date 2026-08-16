-- @artifacts
--   column: public.estimates.warranty_snapshot
--   setting: estimate_warranty_enabled
--   setting: estimate_color_chart_enabled
--   setting: estimate_color_chart_min_products
--   setting: estimate_color_chart_max_swatches
--   setting: estimate_color_chart_print_mode
--   none: also widens the pec_presentation_sections.kind CHECK to include 'warranty' (constraint change, not expressible as table/column/index/setting)
-- @end
-- ============================================================================
-- 2026-09-03: warranty document + color charts on customer estimates
-- (prompt 93 Tasks B + C). Author: Claude Code. Idempotent. Direct to prod
-- per standing rule 14: additive jsonb column on estimates (non-money, does
-- not touch estimates.status), a CHECK widening on a content table, and
-- settings seeds. No branch rehearsal required.
--
-- WHY: (1) kind='warranty' joins the presentation-section kinds so the
-- warranty is authored in the existing Settings > Presentation editor; the
-- customer page pins it after the terms card instead of floating it among the
-- literature. (2) estimates.warranty_snapshot freezes the rendered warranty
-- sections at SEND (markEstimateSent), the prompt 83 photos contract: a
-- customer who signed today keeps seeing the wording they signed under,
-- whatever is edited later. (3) The chart settings gate the catalog-generated
-- color charts server-side in pec-public-estimate.cjs.
-- ============================================================================

begin;

-- Widen the kind CHECK (drop + re-add; CREATE OR REPLACE does not exist for
-- constraints). Existing rows all pass the wider check by construction.
alter table public.pec_presentation_sections
  drop constraint if exists pec_presentation_sections_kind_check;
alter table public.pec_presentation_sections
  add constraint pec_presentation_sections_kind_check
  check (kind = any (array['why_us'::text, 'process'::text, 'gallery'::text, 'financing'::text, 'warranty'::text]));

-- The frozen warranty: { sections: [{id,title,body,images}], frozen_at }.
-- NULL = never sent since the feature shipped (page falls back to the live
-- sections while the estimate is still open; accepted-with-no-snapshot shows
-- nothing rather than wording the customer never signed under).
alter table public.estimates add column if not exists warranty_snapshot jsonb;

insert into public.settings (key, value) values
  ('estimate_warranty_enabled', 'true'),
  ('estimate_color_chart_enabled', 'true'),
  ('estimate_color_chart_min_products', '6'),
  ('estimate_color_chart_max_swatches', '60'),
  ('estimate_color_chart_print_mode', 'omit')
on conflict (key) do nothing;

commit;

-- Verify:
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'pec_presentation_sections_kind_check';  -- includes 'warranty'
--   select column_name, data_type from information_schema.columns where table_name = 'estimates' and column_name = 'warranty_snapshot';  -- jsonb
--   select key, value from settings where key like 'estimate_color_chart%' or key = 'estimate_warranty_enabled' order by key;  -- 5 rows
