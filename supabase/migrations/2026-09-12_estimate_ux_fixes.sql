-- @artifacts
--   column: public.estimate_line_items.est_hours
--   column: public.estimate_line_items.sqft
--   setting: estimate_line_polish_enabled
-- @end
-- ============================================================================
-- 2026-09-12: Dylan's estimate UX fixes (2026-08-20 batch). Author: Claude
-- Code. Applied to PROD via MCP. Idempotent. Plain additive columns + one
-- settings seed: no money, no auth, no SECURITY DEFINER, so direct-to-prod
-- under rule 14's carve-out.
--
-- estimate_line_items.est_hours / .sqft: a one-off ("custom") line in the
-- estimator can now carry its expected crew hours and square footage, the
-- same facts a per-area custom line already stores on estimate_areas
-- (custom_labor_hours / sqft). unit_cost remains the material budget.
-- Recorded for costing honesty; never customer-facing, never priced from.
-- MUST be applied BEFORE the estimator bundle that selects these columns
-- deploys, or loadEstimateForEdit 400s on the unknown column.
--
-- estimate_line_polish_enabled: "Polish with AI" got its own flag
-- (2026-08-20). Prompt 94 turned estimate_line_generate_enabled off because
-- templates fill line scopes at pick time; that flip also hid POLISH, which
-- only cleans text the rep typed into a description and authors nothing.
-- Dylan wants polish back, so it now answers to this key (default on) while
-- generate stays off. pec-estimate-custom-polish.cjs gates on it server-side.
-- ============================================================================

begin;

alter table public.estimate_line_items add column if not exists est_hours numeric;
alter table public.estimate_line_items add column if not exists sqft numeric;

insert into public.settings (key, value) values
  ('estimate_line_polish_enabled', 'true')
on conflict (key) do nothing;

commit;
