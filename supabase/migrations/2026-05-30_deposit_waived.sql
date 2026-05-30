-- ============================================================================
-- 2026-05-30: "no deposit needed" flag for commercial / special-case jobs
-- ============================================================================
-- Some jobs (commercial clients, special arrangements) never require a deposit.
-- Without a way to mark that, they sat forever in the AR "Signed, no deposit
-- collected" bucket and inflated pending-deposits. Add a boolean waiver and
-- expose it through the pec_job_ar view so the Invoicing UI can read it via
-- select('*'). A waived job is treated like its deposit step is satisfied: it
-- drops out of the "no deposit collected" bucket and is no longer owed a deposit.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

begin;

alter table public.jobs
  add column if not exists deposit_waived boolean not null default false;

-- Recreate the AR view to add j.deposit_waived. (Definition copied from
-- 2026-05-27_invoicing_ar.sql with the one new column.)
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
  j.deposit_waived,
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
  (current_date - j.signed_date)                       as days_since_signed
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
--     where table_schema='public' and table_name='jobs' and column_name='deposit_waived';
--   -- expect one row: deposit_waived
--   select deposit_waived from public.pec_job_ar limit 1;  -- should resolve (column exists in view)
