-- @artifacts
--   none: CREATE OR REPLACE of function get_portal_data (no table/column/index/setting changes)
-- @end
-- ============================================================================
-- 2026-09-13: the customer portal shows the signed estimate (Dylan's Susan
-- Nasser report, 2026-08-21). Author: Claude Code. SECURITY DEFINER function
-- change, so REHEARSED via rolled-back transaction on prod first (rule 14;
-- branching unavailable on this plan).
--
-- ROOT CAUSE the report uncovered: the portal's signature display reads the
-- LEGACY jobs.signature_data (the old draw-on-canvas confirm flow). The
-- estimate accept path signs on the public /e/ page and stores the record in
-- estimates.signature + signed_name/signed_at, and never writes
-- jobs.signature_data, so an estimate-signed customer's portal showed no
-- signature at all. Recording was never broken; only this surface was blind.
--
-- WHAT THIS ADDS: each portal job object gains 'estimate_signature', the
-- newest accepted+signed estimate linked to that job: estimate_number,
-- signed_name, signed_at, public_token. Exposure review: everything here is
-- the customer's OWN contract, and public_token is the very link the accept
-- flow texted/emailed them; nothing new becomes reachable. Everything else
-- in the function is byte-identical to the live definition (captured from
-- pg_get_functiondef before editing).
-- ============================================================================

begin;

CREATE OR REPLACE FUNCTION public.get_portal_data(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        'review', (select row_to_json(r)::jsonb from public.reviews r where r.job_id = j.id limit 1),
        'estimate_signature', (select jsonb_build_object(
                            'estimate_number', e.estimate_number,
                            'signed_name', e.signed_name,
                            'signed_at', e.signed_at,
                            'public_token', e.public_token)
                     from public.estimates e
                     where e.job_id = j.id and e.status = 'accepted'
                       and e.signed_at is not null and e.deleted_at is null
                     order by e.signed_at desc limit 1)
      ) as job_obj
    from public.jobs j
    where j.customer_id = v_customer.id and j.archived_at is null
  ) sub;

  return jsonb_build_object(
    'customer', row_to_json(v_customer)::jsonb,
    'jobs', v_jobs,
    'referral_reward_amount', coalesce(v_referral_reward, '50')
  );
end
$function$;

commit;
