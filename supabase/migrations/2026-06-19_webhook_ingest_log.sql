-- ============================================================================
-- 2026-06-19: DripJobs webhook ingestion log.
-- Author: Claude Code. RUN BY COWORK on the PROD Supabase project. Idempotent.
-- NOT applied to prod from the Claude Code session.
--
-- Why: DripJobs jobs reach the CRM only via a Zapier push to the webhook
-- functions. Three failure classes were previously INVISIBLE (logged to the
-- Netlify console only, never persisted, so un-queryable after the fact):
--   - rejected   : payload missing customer_name -> 400, job dropped
--   - bridge_failed: public.jobs created but the pec_prod_jobs bridge threw
--                    (job shows on Jobs page, never on the Schedule)
--   - error      : outer 500 catch
-- This table persists one row per inbound webhook attempt so the new "DripJobs
-- Sync Health" dashboard view can surface them. Writes come from the webhook
-- (service role, bypasses RLS); reads are admin-only.
--
-- CEILING (documented, not solvable here): this CANNOT detect a deal that never
-- reached the webhook at all (Zap errored/filtered/never-fired in Zapier),
-- because the CRM has no source-of-truth list to reconcile against. That needs a
-- Zapier task-history audit or a future DripJobs API pull.
--
-- Reuses public.is_admin_staff() (the same gate the costing tables use).
-- ============================================================================

create table if not exists public.pec_webhook_ingest_log (
  id            uuid primary key default gen_random_uuid(),
  endpoint      text,                       -- 'proposal-accepted', 'appointment-set'
  deal_id       text,
  customer_name text,
  company       text,
  outcome       text not null,              -- 'ok' | 'rejected' | 'error' | 'bridge_failed'
  status_code   int,
  message       text,                       -- error text or short note
  payload       jsonb,                      -- parsed inbound body (no secrets; for replay/debug)
  public_job_id uuid,                       -- public.jobs row, when known
  prod_job_id   uuid,                       -- pec_prod_jobs row, when known
  created_at    timestamptz not null default now()
);
create index if not exists idx_pec_webhook_ingest_log_created
  on public.pec_webhook_ingest_log (created_at desc);
create index if not exists idx_pec_webhook_ingest_log_deal
  on public.pec_webhook_ingest_log (deal_id);

-- RLS: admin-only read; the webhook writes with the service role, which bypasses
-- RLS, so no INSERT policy is needed (and none is granted to normal clients).
alter table public.pec_webhook_ingest_log enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'pec_webhook_ingest_log'
      and policyname = 'pec_webhook_ingest_log_admin_read'
  ) then
    create policy pec_webhook_ingest_log_admin_read
      on public.pec_webhook_ingest_log
      for select
      using (public.is_admin_staff());
  end if;
end $$;

-- Verify after running:
--   select count(*) from public.pec_webhook_ingest_log;  -- 0
--   select policyname from pg_policies where tablename = 'pec_webhook_ingest_log';  -- 1 row
