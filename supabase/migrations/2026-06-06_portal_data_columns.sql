-- ============================================================================
-- 2026-06-06: lock get_portal_data to a customer-facing column allowlist
-- ============================================================================
-- get_portal_data previously returned j.* for each job, i.e. EVERY column of
-- public.jobs to the anonymous portal (token in the URL). That leaks internal
-- fields, including jobs.scope (the staff "Issues / Notes"), which Dylan does
-- not want shown to customers. Replace j.* with an explicit jsonb_build_object
-- allowlist of only customer-facing fields. Keeps install_date (added in
-- 2026-06-06_portal_install_date.sql) and the timeline/colors/photos/review
-- subqueries unchanged.
--
-- RUN ORDER: this must be the LAST get_portal_data definition applied in prod
-- (run after 2026-06-06_portal_install_date.sql), since CREATE OR REPLACE means
-- the last one wins.

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

  select coalesce(jsonb_agg(sub.job_obj order by sub.created_at desc), '[]'::jsonb) into v_jobs
  from (
    select
      j.created_at as created_at,
      jsonb_build_object(
        'id', j.id,
        'type', j.type,
        'status', j.status,
        'address', j.address,
        'package', j.package,
        'price', j.price,
        'warranty', j.warranty,
        'confirmed', j.confirmed,
        'confirmed_at', j.confirmed_at,
        'signature_data', j.signature_data,
        'created_at', j.created_at,
        'colors_confirmed', j.colors_confirmed,
        -- Scheduled install date from the bridged production job (earliest dated
        -- row for this deal); null for manual/unbridged jobs.
        'install_date', (select pj.install_date from public.pec_prod_jobs pj
                           where pj.dripjobs_deal_id = j.dripjobs_deal_id
                             and pj.install_date is not null
                           order by pj.install_date limit 1),
        'timeline', (select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.sort_order), '[]'::jsonb)
                       from public.timeline_stages t where t.job_id = j.id),
        'colors', (select coalesce(jsonb_agg(jsonb_build_object(
                            'id', jc.id, 'label', jc.label, 'name', c.name, 'type', c.type,
                            'hex', c.hex, 'sku', c.sku, 'swatch_image', c.swatch_image)), '[]'::jsonb)
                     from public.job_colors jc join public.colors c on jc.color_id = c.id
                     where jc.job_id = j.id),
        'photos', (select coalesce(jsonb_agg(row_to_json(p)::jsonb order by p.created_at desc), '[]'::jsonb)
                     from public.photos p where p.job_id = j.id),
        'review', (select row_to_json(r)::jsonb from public.reviews r where r.job_id = j.id limit 1)
      ) as job_obj
    from public.jobs j
    where j.customer_id = v_customer.id and j.archived_at is null
  ) sub;

  -- v_customer is row_to_json'd below; customers has no internal-only secrets
  -- on the portal today (name/email/phone/company/token), but if that changes,
  -- switch this to an allowlist too.
  return jsonb_build_object(
    'customer', row_to_json(v_customer)::jsonb,
    'jobs', v_jobs,
    'referral_reward_amount', coalesce(v_referral_reward, '50')
  );
end
$$;

grant execute on function public.get_portal_data(text) to anon, authenticated;

commit;

-- Verify after running: get_portal_data for a token returns jobs WITHOUT a
-- "scope" key, and WITH id/type/status/install_date/colors_confirmed present.
