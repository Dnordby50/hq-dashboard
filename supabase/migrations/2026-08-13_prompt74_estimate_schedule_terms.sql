-- @artifacts
--   table: public.estimate_installments
--   index: idx_estimate_installments_estimate
--   index: uq_estimate_installments_deposit
--   column: public.pec_brand_identity.estimate_terms_text
--   setting: estimate_schedule_enabled
-- @end
-- ============================================================================
-- 2026-08-13: estimate-side payment schedule + estimate terms (prompt 74:
-- per-line scope on the customer estimate, payment schedule, terms and
-- conditions, deposit at signing).
-- Author: Claude Code. Applied to PROD (zdfpzmmrgotynrwkeakd) via MCP from the
-- prompt 74 session. Idempotent.
--
-- WHY: the payment schedule is created and approved ON THE ESTIMATE before the
-- customer signs (Dylan, locked decision 5/6: "Payment schedule needs to be
-- created and approved before the estimate is signed"). This table deliberately
-- MIRRORS pec_invoice_installments field-for-field so the accept-time copy is
-- a straight map: on signature the resolved schedule is frozen into
-- estimates.signature and written to pec_invoice_installments as the job's
-- real installments, REPLACING the old auto-prepared 50% deposit.
--
-- NO computed_amount column ON PURPOSE (unlike the job-side table): dollars
-- are computed at render time from the live selection (percent rows recompute
-- as the customer ticks optional lines) and frozen at signature. Storing a
-- computed amount here is how the estimate and the invoice end up disagreeing.
--
-- Trust model: staff read/write (same policy shape as pec_invoice_installments);
-- the service-role Netlify function (pec-public-estimate render + accept copy)
-- bypasses RLS.
-- ============================================================================

begin;

create table if not exists public.estimate_installments (
  id           uuid primary key default gen_random_uuid(),
  estimate_id  uuid not null references public.estimates(id) on delete cascade,
  seq          integer not null default 0,      -- schedule order; deposit convention is 0
  label        text not null default '',
  amount_kind  text not null default 'percent' check (amount_kind in ('fixed','percent')),
  amount_value numeric not null check (amount_value >= 0),
  trigger_kind text not null default 'manual'
                 check (trigger_kind in ('on_acceptance','on_start','on_completion','manual','date')),
  due_date     date,
  is_deposit   boolean not null default false,
  note         text,
  created_at   timestamptz not null default now(),
  created_by   uuid
);

create index if not exists idx_estimate_installments_estimate
  on public.estimate_installments (estimate_id, seq);
-- At most ONE deposit row per estimate, mirroring the job-side constraint
-- (uq_pec_invoice_installments_deposit) so the copy can never violate it.
create unique index if not exists uq_estimate_installments_deposit
  on public.estimate_installments (estimate_id)
  where is_deposit;

alter table public.estimate_installments enable row level security;

drop policy if exists estimate_installments_staff on public.estimate_installments;
create policy estimate_installments_staff on public.estimate_installments for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- Estimate terms and conditions, per brand (locked decision 9), edited in
-- Settings > Brand next to the invoice terms. Empty/null = the terms card
-- simply does not render on the customer estimate (FTP stays empty until
-- Dylan writes it). Customer-facing text: no em dashes (standing rule 6).
alter table public.pec_brand_identity
  add column if not exists estimate_terms_text text;

-- Settings seed (insert-only: never clobber a value Dylan saved). Rule 12:
--   estimate_schedule_enabled  company-wide on/off for the estimate-side
--                              payment schedule card. Off = the estimator
--                              never seeds or shows the schedule card and new
--                              estimates carry no schedule; existing rows and
--                              signed schedules are untouched.
insert into public.settings (key, value) values
  ('estimate_schedule_enabled', 'true')
on conflict (key) do nothing;

commit;

-- Verify after running:
--   select count(*) from information_schema.tables
--     where table_schema='public' and table_name='estimate_installments';       -- 1
--   select policyname, cmd from pg_policies
--     where tablename='estimate_installments';                                  -- 1 row, ALL
--   select indexname from pg_indexes
--     where tablename='estimate_installments' order by indexname;
--   select column_name from information_schema.columns
--     where table_name='pec_brand_identity' and column_name='estimate_terms_text'; -- 1
--   select value from settings where key='estimate_schedule_enabled';           -- 'true'
