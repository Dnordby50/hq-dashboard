-- ============================================================================
-- 2026-06-07: durable manual invoice line items (per-job override flag)
-- ============================================================================
-- jobs.line_items is normally DERIVED from the estimate areas on every job save
-- (only is_change_order lines survive), so a hand-built/corrected invoice would
-- be clobbered by the next estimate save. For the DripJobs switch-over, staff
-- need invoices to be fully editable and durable.
--
-- This adds jobs.line_items_manual_override: when true, the client's saveJob()
-- SKIPS regenerating line_items/price from areas (the invoice line editor is
-- authoritative for that job). The new "Edit line items" modal sets it true.
-- Mirrors the existing jobs.status_manual_override pattern (2026-06-03).
--
-- *** COWORK HANDOFF: run this in the PROD Supabase project. ***
-- Idempotent / safe to re-run.
-- ============================================================================

begin;

alter table public.jobs
  add column if not exists line_items_manual_override boolean not null default false;

-- Recreate pec_job_ar with line_items_manual_override appended LAST (definition
-- copied from 2026-06-01_brand_and_public_invoice.sql plus the one new column;
-- CREATE OR REPLACE VIEW can only append columns, not reorder).
create or replace view public.pec_job_ar with (security_invoker = on) as
select
  j.id,
  j.customer_id,
  j.status,
  j.address,
  j.price,
  j.scope,
  j.dripjobs_deal_id,
  j.hq_invoice_number,
  j.salesperson,
  j.bill_to_address,
  j.deposit_amount,
  j.deposit_collected,
  j.signed_date,
  j.completed_date,
  j.line_items,
  j.created_at,
  c.name  as customer_name,
  c.email as customer_email,
  c.phone as customer_phone,
  c.company as customer_company,
  coalesce(p.paid_to_date, 0)                          as paid_to_date,
  coalesce(j.price, 0) - coalesce(p.paid_to_date, 0)   as balance_remaining,
  p.last_payment_date,
  (current_date - j.completed_date)                    as days_outstanding,
  (current_date - j.signed_date)                       as days_since_signed,
  j.deposit_waived,
  j.public_token,
  j.line_items_manual_override
from public.jobs j
left join public.customers c on c.id = j.customer_id
left join (
  select job_id,
         sum(amount)        as paid_to_date,
         max(received_date) as last_payment_date
    from public.pec_payments
   group by job_id
) p on p.job_id = j.id
where j.voided_at is null;

grant select on public.pec_job_ar to authenticated;

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--     where table_name='jobs' and column_name='line_items_manual_override';   -- 1 row
--   select line_items_manual_override from public.pec_job_ar limit 1;          -- resolves
