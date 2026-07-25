-- @artifacts
--   table: public.pec_invoice_installments
--   index: idx_pec_invoice_installments_job
--   index: idx_pec_invoice_installments_status
--   index: uq_pec_invoice_installments_deposit
--   setting: default_deposit_pct
--   setting: payment_schedules_enabled
--   setting: installment_approval_required
-- @end
-- ============================================================================
-- 2026-07-22: pec_invoice_installments + deposit/schedule settings (prompt 45:
-- partial invoicing, required deposits, payment schedules).
-- Author: Claude Code. RUN BY COWORK on the PROD Supabase project. Idempotent.
-- NOT applied to prod from the Claude Code session.
--
-- WHY: today the one-invoice-per-job model can only ever ask a customer for
-- the FULL remaining balance (or the clamped deposit). This table gives that
-- single invoice a schedule of installments: each row is one planned ask
-- (deposit, milestone progress payment, or final), entered as a flat dollar
-- amount OR a percent of the job total, due on a job milestone. At any moment
-- exactly ONE installment is the current amount due (the resolver in
-- netlify/functions/_pec-installments.cjs is the single definition of
-- "current"). A job with NO rows here behaves exactly as before -- the table
-- is purely additive.
--
-- Name: pec_invoice_installments (not pec_payment_schedule) because each row
-- belongs to the job's ONE invoice (hq_invoice_number stays per-job, locked
-- decision 1) and is an installment OF that invoice, and pec_payments is the
-- money actually received -- the two names keep plan vs money distinct.
--
-- Trust model: staff read/write (the invoicing module is staff-managed, same
-- policy shape as pec_payments); the service-role Netlify functions (deposit
-- prepare on acceptance, milestone trigger runner, Stripe webhook settle)
-- bypass RLS.
-- ============================================================================

begin;

create table if not exists public.pec_invoice_installments (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs(id) on delete cascade,
  seq             integer not null default 0,   -- schedule order; deposit convention is 0
  label           text not null default '',
  -- Locked decision 2: staff pick dollars or percent PER LINE; both the kind
  -- and the entered value are stored, and computed_amount snapshots the
  -- resolved dollars at save time so a later job-total edit never silently
  -- moves an already-communicated ask.
  amount_kind     text not null default 'fixed' check (amount_kind in ('fixed','percent')),
  amount_value    numeric not null check (amount_value >= 0),
  computed_amount numeric not null default 0 check (computed_amount >= 0),
  -- Locked decision 6: UI ships the three job milestones; 'manual' and 'date'
  -- are schema headroom for a future trigger type (due_date pairs with 'date').
  trigger_kind    text not null default 'manual'
                    check (trigger_kind in ('on_acceptance','on_start','on_completion','manual','date')),
  due_date        date,
  -- planned: drafted, milestone not fired (or deposit awaiting manual send).
  -- queued: reserved (approved-but-deferred, mirroring the drip ledger).
  -- pending_approval: milestone fired; held in the approval gate for staff.
  -- sent / paid: locked rows (sent_at / paid_at + payment_id stamped).
  -- skipped / canceled: removed from the ask chain (note says why).
  status          text not null default 'planned'
                    check (status in ('planned','queued','pending_approval','sent','paid','skipped','canceled')),
  is_deposit      boolean not null default false,
  -- Locked decision 4, per-job choice on the deposit line only:
  -- standalone=true  -> the deposit is its own line handled outside the
  --                     numbered schedule; standalone=false -> installment #1.
  standalone      boolean not null default false,
  note            text,                          -- void/skip reasons, audit context
  queued_at       timestamptz,
  sent_at         timestamptz,
  paid_at         timestamptz,
  payment_id      uuid references public.pec_payments(id) on delete set null,
  created_at      timestamptz not null default now(),
  created_by      uuid
);

create index if not exists idx_pec_invoice_installments_job
  on public.pec_invoice_installments (job_id, seq);
-- The trigger runner's scan: planned rows only.
create index if not exists idx_pec_invoice_installments_status
  on public.pec_invoice_installments (status)
  where status in ('planned','pending_approval');
-- Integrity: at most ONE deposit line per job (the deposit-prepare hook is
-- existence-checked, this makes a concurrent double-accept a clean conflict).
create unique index if not exists uq_pec_invoice_installments_deposit
  on public.pec_invoice_installments (job_id)
  where is_deposit;

alter table public.pec_invoice_installments enable row level security;

drop policy if exists pec_invoice_installments_staff on public.pec_invoice_installments;
create policy pec_invoice_installments_staff on public.pec_invoice_installments for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

-- Settings seeds (insert-only: never clobber a value Dylan saved in company
-- Settings). Per the standing settings rule these are the feature's knobs:
--   default_deposit_pct         company-wide default deposit percent, the LAST
--                               stop in the precedence rule (per-job manual
--                               jobs.deposit_amount, then the job's system
--                               type pec_prod_system_types.deposit_pct, then
--                               this). '50' matches the code's long-standing
--                               50%-of-price fallback so behavior is unchanged
--                               until Dylan tunes it.
--   payment_schedules_enabled   master on/off for milestone auto-queueing; off
--                               = nothing ever queues or auto-sends, staff
--                               send every installment by hand.
--   installment_approval_required  the approval gate. 'true' (default): a
--                               fired installment waits in Approvals for a
--                               human. 'false': the runner auto-sends the
--                               installment notice (SMS + email with the pay
--                               link) at trigger time.
insert into public.settings (key, value) values
  ('default_deposit_pct', '50'),
  ('payment_schedules_enabled', 'true'),
  ('installment_approval_required', 'true')
on conflict (key) do nothing;

commit;

-- ============================================================================
-- Verify after running (Cowork: capture the outputs in your log entry):
--
-- a) Table exists with RLS on and exactly one for-all staff policy:
--   select count(*) from information_schema.tables
--     where table_schema='public' and table_name='pec_invoice_installments';   -- 1
--   select relrowsecurity from pg_class
--     where relname='pec_invoice_installments';                               -- t
--   select policyname, cmd from pg_policies
--     where tablename='pec_invoice_installments';                             -- 1 row, ALL
--
-- b) The three indexes:
--   select indexname from pg_indexes
--     where tablename='pec_invoice_installments' order by indexname;
--   -- idx_pec_invoice_installments_job, idx_pec_invoice_installments_status,
--   -- uq_pec_invoice_installments_deposit (+ the pkey)
--
-- c) CHECK constraints carry the full value lists:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid='public.pec_invoice_installments'::regclass
--       and contype='c' order by conname;
--
-- d) Settings seeds landed (values may differ if Dylan already tuned them):
--   select key, value from public.settings
--     where key in ('default_deposit_pct','payment_schedules_enabled',
--                   'installment_approval_required') order by key;            -- 3 rows
-- ============================================================================
