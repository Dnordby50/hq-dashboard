-- ============================================================================
-- 2026-07-17: batch change-order approval (prompt 31)
-- ============================================================================
-- When a job has 2+ pending change orders they go out as ONE approval request:
-- one stable link per job (/co/batch/<token>), one page stacking every
-- currently-pending CO, one signature that approves them all.
--
-- HOW IT WORKS (two pieces, both additive):
--
-- 1. pec_change_order_batches: ONE row per approval request. The row is
--    get-or-created by the dashboard card the first time a job shows 2+
--    pending COs, and the SAME row (same token) is reused for every send
--    after that (Dylan decision 4: one stable live link, re-sends reuse it).
--    The link is LIVE: the public page renders whatever COs are pending at
--    view time, so the batch row intentionally stores NO snapshot of COs at
--    creation. The snapshot happens at SIGN time: the signing function reads
--    the job's currently-pending COs, records their ids in signed_co_ids,
--    and flips exactly those rows. signed_co_ids is therefore the audit
--    record of what one signature covered.
--    A partial unique index allows only ONE pending batch per job (that is
--    what makes the link stable), while signed batches accumulate as
--    history: after a batch signs, a later pair of new COs mints a fresh
--    pending batch with a fresh token.
--
-- 2. pec_change_order_signatures.batch_id: a CO signed via a batch points at
--    the batch row that holds its signature. The per-CO badge keeps reading
--    the CO's own signed_name / signed_at (the signing function stamps those
--    too), but the drawn signature image lives ONLY on the batch (Dylan
--    decision 9: do not fold the signature onto each CO row). Single-CO
--    signing (exactly one pending) is untouched and keeps writing the per-CO
--    row exactly as today; its batch_id simply stays null.
--
-- Trust model mirrors pec_change_order_signatures: staff read/write from the
-- app (create the batch row, read for the card). The public SIGNING write
-- goes through the service-role Netlify function only, so there is NO anon
-- policy and an unauthenticated browser can never touch either table.
--
-- *** COWORK HANDOFF: run this in the PROD Supabase project. ***
-- Idempotent / safe to re-run.
-- ============================================================================

begin;

-- 1. Batch approval records ---------------------------------------------------
create table if not exists public.pec_change_order_batches (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.jobs(id) on delete cascade,
  token          uuid not null unique default gen_random_uuid(),
  status         text not null default 'pending' check (status in ('pending','signed')),
  signed_co_ids  uuid[],          -- captured AT SIGN TIME: exactly the CO rows this signature covered
  signed_name    text,
  signature_data text,            -- drawn signature as a data URL (lives here only, not on each CO)
  signed_at      timestamptz,
  signer_ip      text,
  signer_user_agent text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One PENDING batch per job = the stable link. Signed batches are history.
create unique index if not exists idx_pec_co_batch_one_pending
  on public.pec_change_order_batches (job_id) where status = 'pending';

create index if not exists idx_pec_co_batch_job
  on public.pec_change_order_batches (job_id, created_at desc);

alter table public.pec_change_order_batches enable row level security;

-- Staff full access from the app (create/read the batch link). The public
-- signing write comes through the service-role function only; no anon policy.
drop policy if exists pec_co_batch_staff on public.pec_change_order_batches;
create policy pec_co_batch_staff on public.pec_change_order_batches for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop trigger if exists trg_pec_co_batch_touch on public.pec_change_order_batches;
create trigger trg_pec_co_batch_touch before update on public.pec_change_order_batches
  for each row execute function public.pec_prod_touch_updated_at();

-- 2. Batch pointer on each CO row --------------------------------------------
alter table public.pec_change_order_signatures
  add column if not exists batch_id uuid references public.pec_change_order_batches(id) on delete set null;

create index if not exists idx_pec_co_sig_batch
  on public.pec_change_order_signatures (batch_id) where batch_id is not null;

commit;

-- Verify after running:
--   select count(*) from information_schema.tables
--    where table_schema='public' and table_name='pec_change_order_batches';       -- 1
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='pec_change_order_batches'
--    order by ordinal_position;   -- id, job_id, token, status, signed_co_ids,
--                                 -- signed_name, signature_data, signed_at,
--                                 -- signer_ip, signer_user_agent, created_at, updated_at
--   select indexdef from pg_indexes
--    where tablename='pec_change_order_batches'
--      and indexname='idx_pec_co_batch_one_pending';  -- UNIQUE ... WHERE (status = 'pending')
--   select count(*) from pg_policies
--    where tablename='pec_change_order_batches';      -- 1 (staff FOR ALL, no anon)
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='pec_change_order_signatures'
--      and column_name='batch_id';                    -- 1 row
