-- ============================================================================
-- 2026-07-15 (build 23, estimator phase 1): split customer identity + address
-- on estimates. Author: Claude Code. Idempotent, additive only. NOT applied
-- from the build session (do-not-touch-prod rule); Cowork applies it.
--
-- Why: the estimator captured the customer as ONE combined name and ONE
-- combined address string. Dylan's model is a Residential/Commercial toggle
-- (residential = first + last name; commercial = company required + optional
-- contact person) and a real address split (autocomplete fills it). The
-- existing customer_name / customer_address columns are KEPT and become
-- auto-composed safety nets, written on every save:
--   customer_name    = company (commercial, optionally "Company (First Last)")
--                      else "First Last"
--   customer_address = address1, address2, city, state, zip joined
-- so every downstream reader keeps working even if one was missed in the
-- rework. Deploy order: apply this BEFORE deploying the estimator build, or
-- new saves will queue in the outbox with unknown-column errors until it lands.
--
-- customer_is_commercial is STORED (not derived from company alone) so an
-- intentional commercial job under a person's name stays possible later
-- without another migration. Naming note: this is the customer's BUSINESS,
-- the same concept as customers.company_name (2026-05-04), NOT the brand
-- (customers.company / pec_job_ar.customer_company = prescott-epoxy | ftp).
-- ============================================================================

begin;

alter table public.estimates add column if not exists customer_first_name    text;
alter table public.estimates add column if not exists customer_last_name     text;
alter table public.estimates add column if not exists customer_company       text;
alter table public.estimates add column if not exists customer_is_commercial boolean;
alter table public.estimates add column if not exists customer_address1      text;
alter table public.estimates add column if not exists customer_address2      text;
alter table public.estimates add column if not exists customer_city          text;
alter table public.estimates add column if not exists customer_state         text;
alter table public.estimates add column if not exists customer_zip           text;

commit;

-- Verify:
--   select column_name from information_schema.columns
--     where table_name='estimates' and column_name like 'customer_%';
--   -- expect 13 rows: the 4 originals (name/phone/email/address) + these 9
