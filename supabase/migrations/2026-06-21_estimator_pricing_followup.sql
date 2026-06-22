-- ============================================================================
-- 2026-06-21 (follow-up): estimator pricing corrections.
-- Author: Claude Code. RUN BY COWORK on PROD, AFTER 2026-06-21_estimator_core.sql.
-- Idempotent. NOT applied from the Claude Code session.
--
-- Why: two corrections after Dylan confirmed the real pricing rules.
--   1. Commission is PER SALESPERSON, not per system. It already lives on
--      public.pec_sales_team_members.commission_pct (Aron 6%, Dylan 0%). The
--      core migration speculatively added pec_prod_system_types.commission_pct;
--      that was a modeling error. Drop it (it was never populated). Target GP
--      stays per-system overridable (target_gp_pct is kept).
--   2. Price rounding is "nearest $5, with a charm-down near big round numbers"
--      (e.g. 5150 -> 4995), not the $25 placeholder. Set the increment to 5 and
--      add the two charm-pricing knobs, all editable from Settings.
-- ============================================================================

begin;

-- 1. Commission is not a system attribute. Remove the speculative column.
alter table public.pec_prod_system_types
  drop constraint if exists pec_prod_system_types_commission_range;
alter table public.pec_prod_system_types
  drop column if exists commission_pct;

-- 2a. Rounding increment: $25 placeholder -> $5. Only touch the seeded
--     placeholder; never clobber a value Dylan has since changed by hand.
update public.settings
   set value = '5'
 where key = 'estimator_price_increment'
   and value = '25';

-- 2b. Charm-pricing knobs (round down to threshold-minus-increment when the
--     price lands within `charm_band` above a multiple of `charm_threshold`).
insert into public.settings (key, value) values
  ('estimator_charm_threshold', '1000'),   -- big round number to charm against
  ('estimator_charm_band',      '250')     -- how far above it still charms down
on conflict (key) do nothing;

commit;

-- ============================================================================
-- Verify after running:
--   select column_name from information_schema.columns
--     where table_name='pec_prod_system_types' and column_name='commission_pct';  -- 0 rows
--   select key, value from public.settings
--     where key in ('estimator_price_increment','estimator_charm_threshold','estimator_charm_band');
--     -- estimator_price_increment = 5, charm_threshold = 1000, charm_band = 250
--   select name, commission_pct from public.pec_sales_team_members order by name;
--     -- commission rates live here (Aron 6, Dylan 0) -- this is the source of truth
-- ============================================================================
