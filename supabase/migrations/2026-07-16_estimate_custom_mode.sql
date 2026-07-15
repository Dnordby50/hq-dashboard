-- ============================================================================
-- 2026-07-16 (build 24, estimator phase 2): custom estimate mode.
-- Author: Claude Code. Idempotent, additive only. NOT applied from the build
-- session (do-not-touch-prod rule); Cowork applies it.
--
-- Why: one-off jobs (work the shop does not do often) do not fit the
-- material/sqft engine. A custom estimate is toggled at the top of the
-- estimator: Dylan types the scope and the price himself, no areas, no
-- recipe math. Three columns carry the custom truth:
--   is_custom     the mode flag; false/absent = the standard engine path
--   custom_scope  Dylan's typed scope/proposal text
--   custom_price  the manually typed sell price (the system portion; add-on
--                 lines still price on top of it)
--
-- The standard downstream columns are COMPOSED from these on every save
-- (same safety-net pattern as build 23's customer_name/customer_address):
-- custom_price flows into estimates.price (plus add-ons) so the list, the
-- proposal page, the PDF, and accept-to-job read the right number, and
-- custom_scope flows into scope_of_work (which accept already copies to
-- jobs.scope). So no downstream reader needs to know is_custom exists.
--
-- Deploy order: apply this BEFORE deploying the estimator build, or new
-- saves will queue in the outbox with unknown-column errors until it lands
-- (the save writes all three columns on every estimate, custom or not, so
-- toggling custom OFF clears them).
-- ============================================================================

begin;

alter table public.estimates add column if not exists is_custom    boolean default false;
alter table public.estimates add column if not exists custom_scope text;
alter table public.estimates add column if not exists custom_price numeric;

commit;

-- Verify:
-- select column_name from information_schema.columns
--   where table_name = 'estimates'
--   and column_name in ('is_custom', 'custom_scope', 'custom_price');
-- (expect 3 rows)
