-- ============================================================================
-- 2026-06-06: customer portal color selection wired to the production catalog
-- ============================================================================
-- Lets the customer pick their colors on the portal, persisted to the SAME
-- per-area structure the CRM production side reads (job_area_materials), using
-- ONLY the options valid for each area's system (driven by the catalog, never a
-- hardcoded list). All writes go through a token-scoped SECURITY DEFINER RPC
-- that validates, server-side, that each chosen product's material_type matches
-- what that area's recipe slot requires, so a tampered request cannot set an
-- invalid color.
--
-- DEPENDENCY: run AFTER 2026-06-06_notifications.sql (this RPC inserts into
-- pec_notifications), and the get_portal_data column-allowlist migration can run
-- in any order relative to this one (this file does not touch get_portal_data).

begin;

-- Track a customer-driven confirmation separately so we never silently clobber a
-- staff confirmation (jobs.colors_confirmed / colors_confirmed_at already exist).
alter table public.jobs
  add column if not exists colors_confirmed_by_customer_at timestamptz;

-- READ: per-area systems, the swatch (color) slots they require, the valid
-- products for each slot's material type, and the current pick. Token-scoped.
create or replace function public.get_portal_job_catalog(p_token text, p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_customer_id uuid;
  v_job public.jobs%rowtype;
  v_areas jsonb;
begin
  select id into v_customer_id from public.customers where token = p_token and archived_at is null;
  if v_customer_id is null then return null; end if;
  select * into v_job from public.jobs where id = p_job_id and customer_id = v_customer_id and archived_at is null;
  if v_job.id is null then return null; end if;

  select coalesce(jsonb_agg(a order by (a->>'order_index')::int), '[]'::jsonb) into v_areas
  from (
    select jsonb_build_object(
      'id', ja.id,
      'name', ja.name,
      'order_index', coalesce(ja.order_index, 0),
      'system_type_id', ja.system_type_id,
      'system_name', (select st.name from public.pec_prod_system_types st where st.id = ja.system_type_id),
      'slots', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'recipe_slot_id', rs.id,
          'material_type', rs.material_type,
          'label', coalesce(rs.label, rs.material_type),
          'options', (select coalesce(jsonb_agg(jsonb_build_object(
                        'product_id', p.id, 'name', p.name, 'color', p.color, 'image_url', p.image_url
                      ) order by p.name), '[]'::jsonb)
                      from public.pec_prod_products p
                      where p.material_type = rs.material_type and p.active),
          'selected_product_id', (select jam.product_id from public.job_area_materials jam
                                   where jam.job_area_id = ja.id and jam.recipe_slot_id = rs.id
                                   order by jam.pick_index limit 1)
        ) order by rs.order_index), '[]'::jsonb)
        from public.pec_prod_recipe_slots rs
        where rs.system_type_id = ja.system_type_id
          and rs.material_type in ('Flake', 'Quartz', 'Metallic Pigment')
          and coalesce(rs.slot_kind, 'product') = 'product'
      )
    ) as a
    from public.job_areas ja
    where ja.job_id = p_job_id
  ) areas;

  return jsonb_build_object(
    'job_id', v_job.id,
    'confirmed', v_job.confirmed,
    'colors_confirmed', v_job.colors_confirmed,
    'areas', v_areas
  );
end
$$;
grant execute on function public.get_portal_job_catalog(text, uuid) to anon, authenticated;

-- WRITE: persist the customer's per-area color picks into job_area_materials,
-- auto-apply the default basecoat pairing, mark colors confirmed (customer
-- timestamp), and notify staff (high priority if it collides with a prior
-- staff confirmation). p_picks = [{job_area_id, recipe_slot_id, product_id}, ...]
create or replace function public.portal_set_area_colors(p_token text, p_job_id uuid, p_picks jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_cust_name text;
  v_job public.jobs%rowtype;
  v_pick jsonb;
  v_area public.job_areas%rowtype;
  v_slot public.pec_prod_recipe_slots%rowtype;
  v_prod public.pec_prod_products%rowtype;
  v_bc_product_id uuid;
  v_bc_slot public.pec_prod_recipe_slots%rowtype;
  v_old_sig text;
  v_new_sig text;
  v_was_staff_confirmed boolean;
  v_collision boolean;
  v_swatch text[] := array['Flake', 'Quartz', 'Metallic Pigment'];
begin
  select id, name into v_customer_id, v_cust_name from public.customers where token = p_token and archived_at is null;
  if v_customer_id is null then raise exception 'Invalid token'; end if;
  select * into v_job from public.jobs where id = p_job_id and customer_id = v_customer_id and archived_at is null;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0 then
    raise exception 'No color selections provided';
  end if;

  v_was_staff_confirmed := (v_job.colors_confirmed is true) and (v_job.colors_confirmed_by_customer_at is null);

  -- signature of existing swatch picks (before changes) for collision compare
  select string_agg(jam.job_area_id::text || ':' || jam.recipe_slot_id::text || ':' || coalesce(jam.product_id::text, ''), ',' order by jam.job_area_id::text, jam.recipe_slot_id::text)
    into v_old_sig
    from public.job_area_materials jam
    join public.job_areas ja on ja.id = jam.job_area_id
   where ja.job_id = p_job_id and jam.material_type = any(v_swatch);

  -- PASS 1: validate every pick (area in job, slot in area's system + a color
  -- slot, product active + material_type matches the slot). Reject tampering.
  for v_pick in select * from jsonb_array_elements(p_picks) loop
    select * into v_area from public.job_areas where id = (v_pick->>'job_area_id')::uuid and job_id = p_job_id;
    if v_area.id is null then raise exception 'Area not part of this job'; end if;
    select * into v_slot from public.pec_prod_recipe_slots where id = (v_pick->>'recipe_slot_id')::uuid and system_type_id = v_area.system_type_id;
    if v_slot.id is null then raise exception 'Color slot not valid for this area'; end if;
    if not (v_slot.material_type = any(v_swatch)) then raise exception 'Slot is not a color slot'; end if;
    select * into v_prod from public.pec_prod_products where id = (v_pick->>'product_id')::uuid and active;
    if v_prod.id is null then raise exception 'Selected color not found'; end if;
    if v_prod.material_type <> v_slot.material_type then
      raise exception 'Color does not match the % requirement for this area', v_slot.material_type;
    end if;
  end loop;

  -- PASS 2: apply. Replace each picked slot, then auto-pair the basecoat.
  for v_pick in select * from jsonb_array_elements(p_picks) loop
    select * into v_slot from public.pec_prod_recipe_slots where id = (v_pick->>'recipe_slot_id')::uuid;
    select * into v_area from public.job_areas where id = (v_pick->>'job_area_id')::uuid;

    delete from public.job_area_materials where job_area_id = v_area.id and recipe_slot_id = v_slot.id;
    insert into public.job_area_materials
      (job_area_id, recipe_slot_id, slot_label, slot_kind, material_type, order_index, pick_index, product_id, is_custom)
      values (v_area.id, v_slot.id, coalesce(v_slot.label, v_slot.material_type), coalesce(v_slot.slot_kind, 'product'),
              v_slot.material_type, coalesce(v_slot.order_index, 0), 0, (v_pick->>'product_id')::uuid, false);

    -- Default basecoat pairing for a chosen flake (same rule as the CRM).
    select basecoat_product_id into v_bc_product_id
      from public.pec_prod_color_pairings
      where flake_product_id = (v_pick->>'product_id')::uuid and is_default limit 1;
    if v_bc_product_id is not null then
      select * into v_bc_slot from public.pec_prod_recipe_slots
        where system_type_id = v_area.system_type_id and material_type = 'Basecoat'
          and coalesce(slot_kind, 'product') = 'product'
        order by order_index limit 1;
      if v_bc_slot.id is not null then
        delete from public.job_area_materials where job_area_id = v_area.id and recipe_slot_id = v_bc_slot.id;
        insert into public.job_area_materials
          (job_area_id, recipe_slot_id, slot_label, slot_kind, material_type, order_index, pick_index, product_id, is_custom)
          values (v_area.id, v_bc_slot.id, coalesce(v_bc_slot.label, 'Basecoat'), 'product', 'Basecoat',
                  coalesce(v_bc_slot.order_index, 0), 0, v_bc_product_id, false);
      end if;
    end if;
  end loop;

  -- new signature (after changes)
  select string_agg(jam.job_area_id::text || ':' || jam.recipe_slot_id::text || ':' || coalesce(jam.product_id::text, ''), ',' order by jam.job_area_id::text, jam.recipe_slot_id::text)
    into v_new_sig
    from public.job_area_materials jam
    join public.job_areas ja on ja.id = jam.job_area_id
   where ja.job_id = p_job_id and jam.material_type = any(v_swatch);

  v_collision := v_was_staff_confirmed and (coalesce(v_old_sig, '') <> coalesce(v_new_sig, ''));

  -- Mark confirmed + stamp the customer timestamp. Do not clear an existing
  -- colors_confirmed_at (preserves the staff-confirmation time if any).
  update public.jobs
     set colors_confirmed = true,
         colors_confirmed_at = coalesce(colors_confirmed_at, now()),
         colors_confirmed_by_customer_at = now()
   where id = p_job_id;

  if v_collision then
    insert into public.pec_notifications (type, job_id, body, priority)
      values ('colors_collision', p_job_id,
              coalesce(v_cust_name, 'A customer') || ' picked colors that differ from the staff-confirmed selection. Review before ordering.',
              'high');
  else
    insert into public.pec_notifications (type, job_id, body)
      values ('colors_confirmed', p_job_id,
              coalesce(v_cust_name, 'A customer') || ' confirmed their colors on the portal.');
  end if;

  return jsonb_build_object('ok', true, 'collision', v_collision);
end
$$;
grant execute on function public.portal_set_area_colors(text, uuid, jsonb) to anon, authenticated;

commit;

-- Verify after running:
--   select get_portal_job_catalog('<token>', '<job_id>');  -- areas + valid options
--   column jobs.colors_confirmed_by_customer_at exists.
