-- ============================================================================
-- 2026-07-14: commission is now a rate-derived cost on job costing.
-- Author: Claude Code. Idempotent. Applied to prod from the build session.
--
-- Why: pec_prod_job_costing.commission_cost was a manual field nobody ever
-- filled, so all 34 rows read $0. That is why the comps GP% (production/comps.js
-- reads this column) ran ~30 points high. Dylan's decision: commission on a job
-- is ALWAYS the seller's rate times the full contract revenue, kept correct
-- automatically. Aron Bronson is 6%; Dylan (owner) is 0%.
--
-- This is the COST side (GP), separate from the Commission REPORT, which pays
-- reps on money actually collected (pec_payments) and freezes payouts into
-- pec_commission_payouts. Nothing here touches that ledger; no double-pay.
--
-- Model: commission_cost = round(revenue * seller_rate / 100, 2), where the
-- rate is pec_sales_team_members.commission_pct matched to pec_prod_jobs.
-- sales_team by name (case/space-insensitive, same match the report uses); 0
-- when the seller is unknown, inactive, or flagged exclude_from_commission.
-- A trigger keeps it live; the field is read-only in the costing UI.
-- ============================================================================

begin;

-- The one rule, as a function so the triggers and the backfill share it.
create or replace function public.pec_costing_commission_for(p_job_id uuid)
returns numeric
language sql
stable
as $$
  select coalesce(round(pj.revenue * coalesce(m.commission_pct, 0) / 100.0, 2), 0)
  from public.pec_prod_jobs pj
  left join public.pec_sales_team_members m
    on lower(trim(m.name)) = lower(trim(pj.sales_team))
   and coalesce(m.active, true)
   and coalesce(m.exclude_from_commission, false) = false
  where pj.id = p_job_id;
$$;

-- Trigger A: any write to a costing row sets commission_cost from the rule, so
-- the column is authoritative no matter which path wrote it (manual edit,
-- future automation). The incoming commission_cost value is ignored on purpose
-- (the UI renders it read-only for the same reason).
create or replace function public.pec_costing_set_commission()
returns trigger
language plpgsql
as $$
begin
  new.commission_cost := coalesce(public.pec_costing_commission_for(new.job_id), 0);
  return new;
end;
$$;

drop trigger if exists trg_costing_set_commission on public.pec_prod_job_costing;
create trigger trg_costing_set_commission
  before insert or update on public.pec_prod_job_costing
  for each row execute function public.pec_costing_set_commission();

-- Trigger B: when a job's price or seller changes, recompute its costing row's
-- commission (only if a costing row exists; this never creates one). The UPDATE
-- re-fires Trigger A, which recomputes the same value from the now-current job.
create or replace function public.pec_job_recompute_costing_commission()
returns trigger
language plpgsql
as $$
begin
  update public.pec_prod_job_costing
     set commission_cost = coalesce(public.pec_costing_commission_for(new.id), 0)
   where job_id = new.id;
  return new;
end;
$$;

drop trigger if exists trg_job_recompute_commission on public.pec_prod_jobs;
create trigger trg_job_recompute_commission
  after update of revenue, sales_team on public.pec_prod_jobs
  for each row execute function public.pec_job_recompute_costing_commission();

-- Backfill every existing costing row. Nets Aron's 3 completed jobs to 6% of
-- revenue (234.00 + 209.40 + 158.40 = 601.80); Dylan's 0% rows stay 0.
update public.pec_prod_job_costing
   set commission_cost = coalesce(public.pec_costing_commission_for(job_id), 0);

commit;

-- ============================================================================
-- Verify after running:
--   -- Aron's three completed jobs now carry 6% commission:
--   select pj.customer_name, pj.revenue, c.commission_cost
--     from pec_prod_job_costing c join pec_prod_jobs pj on pj.id = c.job_id
--    where lower(pj.sales_team) like '%aron%' and pj.status='completed'
--    order by pj.customer_name;
--   -- Brian Wirick 3900/234.00, DJ Johnston 3490/209.40, Larry George 2640/158.40
--
--   select sum(commission_cost) from pec_prod_job_costing;          -- 601.80 (only Aron's today)
--   select count(*) from pec_prod_job_costing c join pec_prod_jobs pj on pj.id=c.job_id
--     where lower(pj.sales_team) like '%dylan%' and c.commission_cost <> 0;  -- 0 (owner, 0%)
--
--   -- Trigger B: changing revenue recomputes commission.
--   -- Trigger A: inserting/updating a costing field recomputes commission.
-- ============================================================================
