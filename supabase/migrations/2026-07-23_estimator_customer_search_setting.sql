-- @artifacts
--   setting: estimator_customer_search_enabled
-- @end
-- ============================================================================
-- 2026-07-23 (prompt 44): estimator duplicate-customer search setting.
-- Author: Claude Code. Idempotent. Written for Cowork to apply (standing rule).
--
-- The dedup search itself needs NO schema change: it links estimates through
-- the existing estimates.lead_id spine (a matched customer with no lead gets
-- one found-or-created by the estimator at pick time, using the existing
-- leads.customer_id FK). This migration only seeds the rule-12 settings row;
-- both readers (the estimator's loadCatalog and Settings > Estimates) default
-- to ON when the row is missing, so applying it changes nothing visible.
-- ============================================================================

begin;

insert into public.settings (key, value)
select 'estimator_customer_search_enabled', 'true'
where not exists (select 1 from public.settings where key = 'estimator_customer_search_enabled');

commit;

-- ============================================================================
-- Verify after running:
--   select key, value from settings
--     where key = 'estimator_customer_search_enabled';                 -- true
-- ============================================================================
