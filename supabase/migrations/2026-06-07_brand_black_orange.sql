-- ============================================================================
-- 2026-06-07: Prescott Epoxy black/orange rebrand + structured pay fields
-- ============================================================================
-- The customer invoice page and all emails read brand colors from the
-- pec_brand_identity row at render time, so changing code defaults alone does
-- NOT recolor live sends -- the DB row wins. This migration flips the row to the
-- new brand: near-black #14181C (text/primary) and PEC orange #D8531C (accent).
--
-- It also adds two STRUCTURED fields the redesigned invoice pay section needs:
--   zelle_email       -- the Zelle address shown on the "Zelle" pay option
--   card_surcharge_pct-- percent added to a card payment (shown as a live $ amount
--                        computed per-invoice in code; the column just holds the rate)
-- These are separate columns (not crammed into payment_instructions_html) because
-- the surcharge math is dynamic per invoice and staff may tune the rate later.
--
-- *** COWORK HANDOFF: run this in the PROD Supabase project. ***
-- Idempotent / safe to re-run.
-- ============================================================================

begin;

alter table public.pec_brand_identity
  add column if not exists zelle_email text,
  add column if not exists card_surcharge_pct numeric not null default 3;

update public.pec_brand_identity
  set primary_color = '#14181C',
      accent_color  = '#D8531C',
      zelle_email   = coalesce(zelle_email, 'dylan@prescottepoxy.com'),
      updated_at    = now()
  where brand = 'prescott-epoxy';

commit;

-- Verify after running:
--   select brand, primary_color, accent_color, zelle_email, card_surcharge_pct
--     from public.pec_brand_identity where brand='prescott-epoxy';
--     -- expect primary_color #14181C, accent_color #D8531C, zelle set, pct 3
