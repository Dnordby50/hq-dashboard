-- ============================================================================
-- 2026-06-06: CRM notification bell store + portal-view notifications
-- ============================================================================
-- Backs the notification bell in the CRM header. Notifications are written by
-- the token-scoped portal RPCs (SECURITY DEFINER, so they bypass RLS to insert):
--   - portal_log_view        -> "customer viewed their portal"  (extended here)
--   - portal_set_area_colors -> "customer confirmed colors" / high-priority
--                                "color collision" (added in the 3A migration)
-- Staff read the table and mark rows read; only the definer functions insert.
--
-- DEPENDENCY: run this BEFORE the 3A portal-colors migration and before (or with)
-- the portal_log_view extension below, because both insert into pec_notifications.

begin;

create table if not exists public.pec_notifications (
  id         uuid primary key default gen_random_uuid(),
  type       text not null,
  job_id     uuid references public.jobs(id) on delete set null,
  body       text,
  priority   text not null default 'normal',  -- 'normal' | 'high'
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists idx_pec_notifications_created_at on public.pec_notifications (created_at desc);
create index if not exists idx_pec_notifications_unread on public.pec_notifications (created_at desc) where read_at is null;

alter table public.pec_notifications enable row level security;
-- Staff may read + mark read; inserts only via SECURITY DEFINER RPCs.
drop policy if exists pec_notifications_staff on public.pec_notifications;
create policy pec_notifications_staff on public.pec_notifications for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());
grant select, update on public.pec_notifications to authenticated;

-- Extend portal_log_view: still records the view, and now also writes a
-- "viewed portal" notification, de-duplicated to at most one per customer per
-- 6h window so a customer refreshing the page does not spam the bell.
create or replace function public.portal_log_view(p_token text, p_user_agent text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer public.customers%rowtype;
  v_job_id uuid;
  v_recent boolean;
begin
  select * into v_customer from public.customers where token = p_token and archived_at is null;
  if v_customer.id is null then
    return; -- unknown/invalid token: silently ignore
  end if;

  -- Was there already a view in the last 6 hours? (check BEFORE inserting this one)
  select exists (
    select 1 from public.pec_portal_views v
    where v.customer_id = v_customer.id and v.viewed_at > now() - interval '6 hours'
  ) into v_recent;

  insert into public.pec_portal_views (customer_id, customer_token, user_agent)
    values (v_customer.id, p_token, p_user_agent);

  if not v_recent then
    select id into v_job_id from public.jobs
      where customer_id = v_customer.id and archived_at is null
      order by created_at desc limit 1;
    insert into public.pec_notifications (type, job_id, body)
      values ('portal_view', v_job_id, coalesce(v_customer.name, 'A customer') || ' viewed their customer portal');
  end if;
end
$$;

grant execute on function public.portal_log_view(text, text) to anon, authenticated;

commit;

-- Verify after running:
--   select count(*) from public.pec_notifications;  -- 0
--   open a portal token (not staff) and confirm one 'portal_view' row appears.
