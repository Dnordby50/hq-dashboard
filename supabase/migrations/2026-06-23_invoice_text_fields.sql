-- 2026-06-23: Editable customer-facing invoice text fields.
--
-- Adds four nullable plain-text columns to public.pec_brand_identity, edited in
-- Settings > Brand and rendered on the public invoice (pec-public-invoice.cjs):
--   invoice_intro_text            - intro / welcome message at the top
--   offline_payment_details_text  - check / cash / Zelle details (also feeds the
--                                   "Pay by check, cash, or Zelle" invoice option)
--   invoice_footer_text           - thank-you / footer note at the bottom
--   invoice_terms_text            - terms / fine print at the bottom
--
-- Additive and idempotent. Safe to re-run. No RLS change (inherits the existing
-- pec_brand_identity policies).

begin;

alter table public.pec_brand_identity add column if not exists invoice_intro_text text;
alter table public.pec_brand_identity add column if not exists offline_payment_details_text text;
alter table public.pec_brand_identity add column if not exists invoice_footer_text text;
alter table public.pec_brand_identity add column if not exists invoice_terms_text text;

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='pec_brand_identity'
--      and column_name in ('invoice_intro_text','offline_payment_details_text',
--                          'invoice_footer_text','invoice_terms_text');  -- 4 rows
