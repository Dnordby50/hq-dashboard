-- @artifacts
--   none: Advertiser role, session boundaries and a limited read-only reporting RPC.
-- @end
-- Advertisers remain in the login directory but are never operational staff.
alter table public.admin_users drop constraint admin_users_role_check;
alter table public.admin_users add constraint admin_users_role_check
  check (role in ('admin','office','pm','crew','sales','advertiser'));

create or replace function topcoat_security_private.staff_session_valid()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.admin_users a
    join auth.users u on u.id = a.auth_user_id
    join auth.sessions s on s.user_id = u.id
    where a.auth_user_id = (select auth.uid())
      and a.role <> 'advertiser'
      and a.login_revoked_at is null
      and u.email_confirmed_at is not null
      and (u.banned_until is null or u.banned_until <= now())
      and s.id::text = (select auth.jwt()->>'session_id')
      and (s.not_after is null or s.not_after > now())
  );
$$;
revoke all on function topcoat_security_private.staff_session_valid() from public, anon, authenticated, service_role;
grant execute on function topcoat_security_private.staff_session_valid() to authenticated, service_role;

create or replace function topcoat_security_private.advertiser_session_valid()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.admin_users a
    join auth.users u on u.id = a.auth_user_id
    join auth.sessions s on s.user_id = u.id
    where a.auth_user_id = (select auth.uid())
      and a.role = 'advertiser'
      and a.login_revoked_at is null
      and u.email_confirmed_at is not null
      and (u.banned_until is null or u.banned_until <= now())
      and s.id::text = (select auth.jwt()->>'session_id')
      and (s.not_after is null or s.not_after > now())
  );
$$;
revoke all on function topcoat_security_private.advertiser_session_valid() from public, anon, authenticated, service_role;
grant execute on function topcoat_security_private.advertiser_session_valid() to authenticated, service_role;


-- Only the current advertiser's own identity is visible. No permission row is
-- needed: all staff helpers and pec_staff_session now fail closed for this role.
create policy advertiser_own_login on public.admin_users for select to authenticated
  using (auth_user_id = (select auth.uid()) and topcoat_security_private.advertiser_session_valid());

-- Older own-account policies must not retain access after a role downgrade.
create policy advertiser_todos_boundary on public.pec_user_todos as restrictive for all to authenticated
  using (public.is_admin_staff()) with check (public.is_admin_staff());
create policy advertiser_acks_boundary on public.pec_whats_new_acks as restrictive for all to authenticated
  using (public.is_admin_staff()) with check (public.is_admin_staff());
create policy advertiser_permissions_boundary on public.user_permissions as restrictive for all to authenticated
  using (public.is_admin_staff()) with check (public.is_admin_staff());

create or replace function topcoat_owner_private.allowed()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.pec_owner_access o
    join public.admin_users a on a.auth_user_id = o.auth_user_id
    join auth.users u on u.id = o.auth_user_id
    join auth.sessions s on s.user_id = o.auth_user_id
    where o.auth_user_id = (select auth.uid()) and o.enabled
      and a.role <> 'advertiser'
      and a.login_revoked_at is null
      and u.email_confirmed_at is not null
      and (u.banned_until is null or u.banned_until < now())
      and s.id::text = (select auth.jwt()->>'session_id')
      and (s.not_after is null or s.not_after > now())
  );
$$;

create or replace function public.pec_advertiser_report(
  p_from date, p_to date, p_brand text default 'PEC', p_page integer default 0
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_company text; v_result jsonb;
begin
  if not topcoat_security_private.advertiser_session_valid() then
    raise exception 'Advertiser session required' using errcode='42501';
  end if;
  select company into v_company from public.admin_users where auth_user_id=(select auth.uid());
  if p_brand is null or p_brand not in ('PEC','FTP') or v_company is null
    or (v_company <> 'both' and v_company <> p_brand) then
    raise exception 'Company access denied' using errcode='42501';
  end if;
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_to < p_from or p_to-p_from > 366 or p_page is null or p_page < 0 or p_page > 10000 then
    raise exception 'Choose a date range of up to one year and a valid page';
  end if;
  with inquiry_base as (
    select l.id, coalesce(nullif(l.full_name,''),nullif(concat_ws(' ',l.first_name,l.last_name),''),'Unnamed lead') as name,
      coalesce(nullif(l.source,''),'Unspecified') as source, coalesce(l.campaign,'') as campaign, l.stage,
      coalesce(l.inquiry_date, case when l.inquiry_origin is null and l.intake_request_key is null
        then (l.created_at at time zone 'America/Phoenix')::date end) as date
    from public.leads l
    where l.brand=p_brand and l.deleted_at is null and l.duplicate_of is null and l.reporting_excluded_at is null
  ), inquiries as (
    select * from inquiry_base where date between p_from and p_to
  ), sale_base as (
    select j.id,c.name,j.signed_date as date,j.price as amount,
      coalesce(nullif(attribution.source,''),nullif(c.lead_source,''),'Unspecified') as source,
      coalesce(attribution.campaign,'') as campaign
    from public.jobs j join public.customers c on c.id=j.customer_id
    left join lateral (
      select coalesce(nullif(l.source,''),e.lead_source) as source,l.campaign
      from public.estimates e left join public.leads l on l.id=e.lead_id and l.brand=p_brand and l.customer_id=c.id
      where e.job_id=j.id and e.brand=p_brand and e.customer_id=c.id and e.deleted_at is null and e.status='accepted'
      order by e.accepted_at desc nulls last,e.id limit 1
    ) attribution on true
    where c.company=case p_brand when 'PEC' then 'prescott-epoxy' else 'finishing-touch' end
      and j.voided_at is null and j.archived_at is null and c.reporting_excluded_at is null
  ), sales as (
    select * from sale_base where date between p_from and p_to
  ), sources as (
    select source,campaign,count(*) as leads,0::bigint as sales,0::numeric as value from inquiries group by source,campaign
    union all
    select source,campaign,0::bigint,count(*),coalesce(sum(amount),0) from sales group by source,campaign
  )
  select jsonb_build_object(
    'lead_count',(select count(*) from inquiries),
    'sale_count',(select count(*) from sales),
    'sales_value',(select case when count(*) filter(where amount is null)>0 then null else coalesce(sum(amount),0) end from sales),
    'undated_leads',(select count(*) from inquiry_base where date is null),
    'undated_sales',(select count(*) from sale_base where date is null),
    'leads',coalesce((select jsonb_agg(to_jsonb(x) order by x.date desc,x.id) from
      (select * from inquiries order by date desc,id limit 100 offset p_page*100) x),'[]'::jsonb),
    'sales',coalesce((select jsonb_agg(to_jsonb(x) order by x.date desc,x.id) from
      (select * from sales order by date desc,id limit 100 offset p_page*100) x),'[]'::jsonb),
    'sources',coalesce((select jsonb_agg(to_jsonb(x) order by x.leads desc,x.source,x.campaign) from
      (select source,campaign,sum(leads) as leads,sum(sales) as sales from sources group by source,campaign) x),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.pec_advertiser_report(date,date,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.pec_advertiser_report(date,date,text,integer) to authenticated;
