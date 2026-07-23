-- ============================================================================
-- 2026-07-23 (prompt 44): estimate view logging.
-- Author: Claude Code. Idempotent. Written for Cowork to apply (standing rule).
--
-- Mirrors the pec_portal_views pattern for the PUBLIC ESTIMATE page
-- (/e/<token>, pec-public-estimate.cjs). Estimates may have no job yet, so
-- pec_portal_views (job/customer-keyed) cannot carry these; this table keys on
-- estimates.id directly.
--
-- WHY no insert RPC (unlike portal_log_view): the estimate page is rendered
-- SERVER-SIDE by a Netlify function holding the service-role key, which
-- bypasses RLS. There is no anonymous browser write to authorize, so the
-- table needs only the staff READ policy for the dashboard's "Viewed N times"
-- line and stays otherwise locked.
-- ============================================================================

begin;

create table if not exists public.pec_estimate_views (
  id          uuid primary key default gen_random_uuid(),
  estimate_id uuid not null references public.estimates(id) on delete cascade,
  viewed_at   timestamptz not null default now(),
  user_agent  text,
  ip          text
);

-- The card reads count + max(viewed_at) per estimate; one composite index
-- serves both.
create index if not exists idx_pec_estimate_views_estimate
  on public.pec_estimate_views (estimate_id, viewed_at desc);

alter table public.pec_estimate_views enable row level security;

-- Staff read-only (the pec_webhook_ingest_log shape: service role writes,
-- staff read). No insert/update/delete policy: all writes come from the
-- service-role Netlify function.
drop policy if exists pec_estimate_views_staff_read on public.pec_estimate_views;
create policy pec_estimate_views_staff_read on public.pec_estimate_views
  for select using (public.is_admin_staff());

-- Settings (rule 12), insert-only so live values are never clobbered:
--   estimate_view_notifications_enabled: bell notification on customer views
--     (default on; the VIEW ROW is always logged regardless, this only gates
--     the notification).
--   estimate_view_notify_first_per_day: throttle to one notification per
--     estimate per day (default off; Dylan chose every-open).
insert into public.settings (key, value)
select 'estimate_view_notifications_enabled', 'true'
where not exists (select 1 from public.settings where key = 'estimate_view_notifications_enabled');
insert into public.settings (key, value)
select 'estimate_view_notify_first_per_day', 'false'
where not exists (select 1 from public.settings where key = 'estimate_view_notify_first_per_day');

commit;

-- ============================================================================
-- Verify after running:
--   select relrowsecurity from pg_class where relname='pec_estimate_views';  -- t
--   select count(*) from public.pec_estimate_views;                          -- 0
--   select policyname, cmd from pg_policies
--     where tablename='pec_estimate_views';            -- pec_estimate_views_staff_read / SELECT
--   select indexname from pg_indexes
--     where tablename='pec_estimate_views';            -- pkey + idx_pec_estimate_views_estimate
--   select key, value from settings
--     where key in ('estimate_view_notifications_enabled',
--                   'estimate_view_notify_first_per_day');                   -- true, false
-- ============================================================================
