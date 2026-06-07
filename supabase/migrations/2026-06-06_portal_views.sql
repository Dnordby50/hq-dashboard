-- ============================================================================
-- 2026-06-06: customer portal view logging
-- ============================================================================
-- Records when a CUSTOMER opens their portal (the anonymous /?portal=<token>
-- page) so the CRM notification bell (Phase 3D) can surface "customer viewed
-- their portal". Staff previews are excluded on the CLIENT side: the CRM
-- "View customer portal" button opens the link with &staff=1, and the portal
-- also skips logging when an active CRM login is present, so only a clean
-- customer visit calls portal_log_view.
--
-- WHY an RPC and not a direct insert: the portal is anonymous (bearer token in
-- the URL). anon must never write to a table directly. portal_log_view is a
-- token-scoped SECURITY DEFINER function: it validates the token maps to a
-- live customer, then inserts the view. Same pattern as get_portal_data /
-- portal_confirm_job.
--
-- NOTE: in Phase 3D this function is replaced (CREATE OR REPLACE) to ALSO write
-- a row into pec_notifications. It is intentionally view-only here so this
-- migration has no dependency on the notifications table.

begin;

create table if not exists public.pec_portal_views (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references public.customers(id) on delete set null,
  customer_token text,
  job_id        uuid references public.jobs(id) on delete set null,
  user_agent    text,
  viewed_at     timestamptz not null default now()
);
create index if not exists idx_pec_portal_views_viewed_at
  on public.pec_portal_views (viewed_at desc);

-- Locked down: all access is via SECURITY DEFINER functions (the insert RPC
-- below; the bell reads through pec_notifications in 3D). No anon/authenticated
-- table policies, matching the other portal-scoped tables.
alter table public.pec_portal_views enable row level security;

create or replace function public.portal_log_view(p_token text, p_user_agent text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer public.customers%rowtype;
begin
  select * into v_customer from public.customers where token = p_token and archived_at is null;
  if v_customer.id is null then
    return; -- unknown/invalid token: silently ignore, never leak existence
  end if;
  insert into public.pec_portal_views (customer_id, customer_token, user_agent)
    values (v_customer.id, p_token, p_user_agent);
end
$$;

grant execute on function public.portal_log_view(text, text) to anon, authenticated;

commit;

-- Verify after running:
--   select count(*) from public.pec_portal_views;                       -- 0
--   select proname from pg_proc where proname = 'portal_log_view';      -- 1 row
