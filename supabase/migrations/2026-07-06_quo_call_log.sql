-- ============================================================================
-- 2026-07-06: Quo call log (AI summaries + transcripts on the customer profile)
-- ============================================================================
-- Dylan: "can we add the transcripts to the customer profile, so we can see
-- summaries of calls instead of just duration?" Quo (OpenPhone) generates call
-- summaries and transcripts natively and fires webhook events when each is
-- ready. pec-webhook-quo.cjs (already verified + routed at /api/quo/webhook)
-- now ingests three call events into this table, keyed on the Quo call id so
-- the events can arrive in ANY order and each fills in what it knows:
--   call.completed            -> the base row (direction, numbers, duration,
--                                when, brand, matched customer)
--   call.summary.completed    -> summary + next_steps text
--   call.transcript.completed -> the dialogue turns (jsonb)
-- The customer profile's Calls card reads it by customer_id.
--
-- Same trust model as pec_sms_log (2026-06-28_quo_sms.sql): staff can READ,
-- and there is NO client write policy, so only the service-role webhook
-- writes rows. Customer matching mirrors the SMS path (normalized E.164 with
-- a 10-digit-tail fallback); an unmatched call still logs with customer_id
-- null so nothing is dropped, it just does not show on a profile until the
-- customer's phone is fixed.
--
-- *** COWORK HANDOFF: run this in the PROD Supabase project. ***
-- Idempotent / safe to re-run.
-- ============================================================================

begin;

create table if not exists public.pec_call_log (
  id               uuid primary key default gen_random_uuid(),
  quo_call_id      text not null unique,
  brand            text,
  direction        text,                -- 'in' | 'out'
  from_number      text,
  to_number        text,
  customer_id      uuid references public.customers(id) on delete set null,
  duration_seconds numeric(10,1),
  occurred_at      timestamptz,
  summary          text,
  next_steps       text,
  transcript       jsonb,               -- Quo dialogue turns, verbatim
  status           text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_pec_call_log_customer on public.pec_call_log (customer_id, occurred_at desc);

alter table public.pec_call_log enable row level security;

-- Staff READ only; no client write policy (service-role webhook writes).
drop policy if exists pec_call_log_read on public.pec_call_log;
create policy pec_call_log_read on public.pec_call_log for select
  using (public.is_admin_staff());

-- Shared touch trigger function already exists (2026-04-28_pm_ordering.sql).
drop trigger if exists trg_pec_call_log_touch on public.pec_call_log;
create trigger trg_pec_call_log_touch before update on public.pec_call_log
  for each row execute function public.pec_prod_touch_updated_at();

commit;

-- Verify after running:
--   select count(*) from information_schema.tables
--     where table_schema='public' and table_name='pec_call_log';          -- 1
--   select count(*) from pg_policies where tablename='pec_call_log';     -- 1 (select only)
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conrelid='public.pec_call_log'::regclass and contype='u';    -- unique (quo_call_id)
