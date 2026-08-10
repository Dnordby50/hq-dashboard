-- @artifacts
--   none: creates a sequence, a column default, and a data backfill; no new table, column, index, or setting
-- @end

-- Numeric invoice numbers (Dylan, 2026-08-10): invoice records must show
-- numbers only. jobs.hq_invoice_number was never auto-assigned (0 of 97 rows
-- carried one), so the display fell back to dripjobs_deal_id (numeric, fine)
-- or, for native jobs with no deal id, a uuid slice WITH LETTERS. Every new
-- job now takes the next number from this sequence at insert; existing jobs
-- that would have shown the uuid slice are backfilled oldest-first. Jobs
-- already displaying their numeric DripJobs deal id are left alone: that is
-- the number their customer has already seen on paper.
-- Start at 10001: clearly distinct from the 102xxx estimate-number series so
-- an invoice number can never be misread as an estimate number.
create sequence if not exists pec_invoice_number_seq start 10001;

alter table public.jobs
  alter column hq_invoice_number set default nextval('pec_invoice_number_seq')::text;

with ordered as (
  select id from public.jobs
  where hq_invoice_number is null and dripjobs_deal_id is null
  order by created_at
)
update public.jobs j
   set hq_invoice_number = nextval('pec_invoice_number_seq')::text
  from ordered o
 where j.id = o.id;
