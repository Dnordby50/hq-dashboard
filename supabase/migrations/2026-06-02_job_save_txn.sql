-- ============================================================================
-- 2026-06-02: atomic job-estimate save (areas + materials in one transaction)
-- ============================================================================
-- The CRM job save replaces a job's areas + their material picks by deleting
-- and reinserting both. Done as separate client calls, a failure BETWEEN the
-- delete and the materials insert left a job with areas but no materials -- the
-- "I lost all my color/recipe picks" bug. This function does the delete +
-- reinsert of job_areas AND job_area_materials in ONE transaction (a plpgsql
-- function is atomic: any raise rolls the whole thing back), so it's
-- all-or-nothing.
--
-- Inputs:
--   p_job_id    the public.jobs id whose areas are being replaced
--   p_areas     jsonb array; each element:
--                 { order_index, name, sqft, system_type_id, flake_product_id,
--                   basecoat_product_id, topcoat_cure_speed, price, description }
--   p_materials jsonb array; each element:
--                 { area_index (= the owning area's order_index),
--                   recipe_slot_id, slot_label, slot_kind, material_type,
--                   order_index, pick_index, product_id, choice_value,
--                   text_value, is_custom }
--
-- Staff-only: SECURITY DEFINER (bypasses RLS) but guarded by is_admin_staff()
-- so only admin/PM staff can call it. Empty-string scalars are coerced to NULL
-- before casting. Idempotent to re-run (it's a full replace). Safe to re-run
-- the migration itself (create or replace).
-- ============================================================================

create or replace function public.pec_replace_job_areas(
  p_job_id   uuid,
  p_areas    jsonb,
  p_materials jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_area  jsonb;
  v_mat   jsonb;
  v_new_id uuid;
  v_idmap jsonb := '{}'::jsonb;  -- order_index (text) -> new job_areas.id (text)
begin
  if not public.is_admin_staff() then
    raise exception 'not authorized';
  end if;

  -- Replace: clear existing areas (cascades job_area_materials), then reinsert.
  delete from public.job_areas where job_id = p_job_id;

  for v_area in select * from jsonb_array_elements(coalesce(p_areas, '[]'::jsonb))
  loop
    insert into public.job_areas (
      job_id, name, sqft, system_type_id, flake_product_id, basecoat_product_id,
      topcoat_cure_speed, price, description, order_index
    ) values (
      p_job_id,
      nullif(v_area->>'name', ''),
      nullif(v_area->>'sqft', '')::numeric,
      nullif(v_area->>'system_type_id', '')::uuid,
      nullif(v_area->>'flake_product_id', '')::uuid,
      nullif(v_area->>'basecoat_product_id', '')::uuid,
      nullif(v_area->>'topcoat_cure_speed', ''),
      nullif(v_area->>'price', '')::numeric,
      nullif(v_area->>'description', ''),
      coalesce((v_area->>'order_index')::int, 0)
    )
    returning id into v_new_id;
    v_idmap := v_idmap || jsonb_build_object(coalesce(v_area->>'order_index', '0'), v_new_id::text);
  end loop;

  for v_mat in select * from jsonb_array_elements(coalesce(p_materials, '[]'::jsonb))
  loop
    insert into public.job_area_materials (
      job_area_id, recipe_slot_id, slot_label, slot_kind, material_type,
      order_index, pick_index, product_id, choice_value, text_value, is_custom
    ) values (
      (v_idmap ->> coalesce(v_mat->>'area_index', '0'))::uuid,  -- resolve area_index -> new id
      nullif(v_mat->>'recipe_slot_id', '')::uuid,
      v_mat->>'slot_label',
      v_mat->>'slot_kind',
      v_mat->>'material_type',
      coalesce((v_mat->>'order_index')::int, 0),
      coalesce((v_mat->>'pick_index')::int, 0),
      nullif(v_mat->>'product_id', '')::uuid,
      v_mat->>'choice_value',
      v_mat->>'text_value',
      coalesce((v_mat->>'is_custom')::boolean, false)
    );
  end loop;
end;
$$;

grant execute on function public.pec_replace_job_areas(uuid, jsonb, jsonb) to authenticated;

-- Verify after running:
--   select proname from pg_proc where proname = 'pec_replace_job_areas';  -- 1 row
