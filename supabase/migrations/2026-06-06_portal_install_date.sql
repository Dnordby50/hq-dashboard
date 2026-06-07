-- ============================================================================
-- 2026-06-06: expose install_date to the customer portal (status descriptions)
-- ============================================================================
-- The portal's per-status description (pec_status_descriptions) supports a
-- {scheduled_date} token, but the install date lives on public.pec_prod_jobs
-- (matched to a job by dripjobs_deal_id) which anon cannot read directly. Add
-- install_date to each job returned by get_portal_data so the portal can fill
-- the token. Purely additive CREATE OR REPLACE: the job rows still carry j.*
-- here; a later migration (portal data column allowlist) tightens the exposed
-- columns and must KEEP install_date.

begin;

create or replace function public.get_portal_data(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_customer public.customers%rowtype;
  v_jobs jsonb;
  v_referral_reward text;
begin
  select * into v_customer from public.customers where token = p_token and archived_at is null;
  if v_customer.id is null then
    return null;
  end if;

  select value into v_referral_reward from public.settings where key = 'referral_reward_amount';

  select coalesce(jsonb_agg(row_to_json(j)::jsonb order by j.created_at desc), '[]'::jsonb) into v_jobs
  from (
    select
      j.*,
      -- Scheduled install date from the bridged production job (earliest dated
      -- row for this deal); null for manual/unbridged jobs.
      (select pj.install_date from public.pec_prod_jobs pj
         where pj.dripjobs_deal_id = j.dripjobs_deal_id
           and pj.install_date is not null
         order by pj.install_date limit 1) as install_date,
      (select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.sort_order), '[]'::jsonb)
         from public.timeline_stages t where t.job_id = j.id) as timeline,
      (select coalesce(jsonb_agg(jsonb_build_object(
                'id', jc.id, 'label', jc.label, 'name', c.name, 'type', c.type,
                'hex', c.hex, 'sku', c.sku, 'swatch_image', c.swatch_image)), '[]'::jsonb)
         from public.job_colors jc join public.colors c on jc.color_id = c.id
         where jc.job_id = j.id) as colors,
      (select coalesce(jsonb_agg(row_to_json(p)::jsonb order by p.created_at desc), '[]'::jsonb)
         from public.photos p where p.job_id = j.id) as photos,
      (select row_to_json(r)::jsonb from public.reviews r where r.job_id = j.id limit 1) as review
    from public.jobs j
    where j.customer_id = v_customer.id and j.archived_at is null
  ) j;

  return jsonb_build_object(
    'customer', row_to_json(v_customer)::jsonb,
    'jobs', v_jobs,
    'referral_reward_amount', coalesce(v_referral_reward, '50')
  );
end
$$;

grant execute on function public.get_portal_data(text) to anon, authenticated;

commit;

-- Verify after running: open a portal token for a scheduled job and confirm the
-- returned job JSON now includes an install_date.
