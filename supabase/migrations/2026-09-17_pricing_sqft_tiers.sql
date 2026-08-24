-- @artifacts
--   column: public.pec_pricing_project_types.tiers
-- @end
-- ============================================================================
-- 2026-09-17: Instant Pricing, size-bracket pricing (Dylan, 2026-08-24:
-- "ability to add my own price ranges depending on sq footage entered").
-- Author: Claude Code. Direct to prod per rule 14 (additive column + a
-- constraint swap on a brand-new non-money table).
--
-- tiers: a jsonb array of size brackets, [{"up_to_sqft":600,"low":2500,
-- "high":3500}, ...], sorted by up_to_sqft at read time. When brackets
-- exist they WIN over the per-sqft rate math: the visitor's sqft picks the
-- first bracket it fits and shows that exact typed range (no rounding, no
-- min_price; Dylan typed the number he wants shown). Sizes past the last
-- bracket fall back to rate_low/rate_high, and if no rates are set the
-- quote flips to the call-us flow (a too-big job gets "we price it in
-- person", never a made-up extrapolation).
--
-- The rates check is relaxed so a priceable type can carry brackets ONLY
-- (rates become the optional fallback): priceable now requires rates OR at
-- least one bracket. Bracket-shape validation lives in the Settings editor
-- and the server code, not the constraint (jsonb CHECKs on row shape are
-- write-hostile and this table is staff-edited through one modal).
-- ============================================================================

alter table public.pec_pricing_project_types
  add column if not exists tiers jsonb not null default '[]'::jsonb;

alter table public.pec_pricing_project_types
  drop constraint if exists pec_pricing_types_rates_check;
alter table public.pec_pricing_project_types
  add constraint pec_pricing_types_rates_check
  check (
    priceable = false
    or (rate_low is not null and rate_high is not null and rate_low <= rate_high)
    or jsonb_array_length(tiers) > 0
  );
