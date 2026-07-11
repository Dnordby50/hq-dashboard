-- ============================================================================
-- 2026-07-10: archived jobs drop out of pec_job_ar (and therefore out of
-- every Invoicing bucket, Metrics, Commission's job map, and the public
-- invoice/checkout token lookups).
-- Author: Claude Code. RUN BY COWORK on the PROD Supabase project. Idempotent.
-- NOT applied to prod from the Claude Code session.
--
-- WHY: the view's only filter was voided_at, so archiving a job (the CRM's
-- "delete") left it sitting in AR. The concrete bug: Timothy Gallagher's
-- cancelled $4,850 job (archived 2026-07-09, zero payments) inflated
-- "Signed proposal, no deposit collected" by about $2,425. Dylan's decision
-- (2026-07-10, via Cowork): void Gallagher AND make ALL archived jobs drop
-- out of AR going forward.
--
-- KNOWN SIDE EFFECTS, accepted deliberately (details in PROJECT-LOG):
--   - renderJobInvoice reads this view by id, so an archived job's invoice
--     detail shows "Invoice not found. It may have been voided or archived."
--     Acceptable: archived jobs no longer appear anywhere that links there.
--   - The public /pay/<token> page and Stripe checkout resolve tokens through
--     this view, so an archived job's pay link goes dead. Correct: never
--     collect money on a cancelled job.
--   - Metrics reads this view, so payments on already-archived jobs leave the
--     collected-revenue history (3 jobs, $8,602.50 as of 2026-07-10; flagged
--     to Dylan in case any were archived as cleanup rather than cancelled).
--
-- Definition copied from 2026-06-15_invoice_first_sent.sql with ONLY the
-- where clause extended (CREATE OR REPLACE VIEW cannot reorder columns).
-- ============================================================================

begin;

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
  j.line_items_manual_override,
  j.invoice_first_sent_at
from public.jobs j
left join public.customers c on c.id = j.customer_id
left join (
  select job_id,
         sum(amount)        as paid_to_date,
         max(received_date) as last_payment_date
    from public.pec_payments
   group by job_id
) p on p.job_id = j.id
where j.voided_at is null
  and j.archived_at is null;

grant select on public.pec_job_ar to authenticated;

commit;

-- Verify after running:
--   select count(*) from public.pec_job_ar a join public.jobs j on j.id = a.id
--     where j.archived_at is not null;                                  -- 0
--   select count(*) from public.pec_job_ar
--     where id = '2419dc1c-4bb4-4b01-a313-f384b86b2caa';                -- 0 (Gallagher)
