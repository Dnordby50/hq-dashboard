-- @artifacts
--   table: public.pec_change_order_signatures
--   column: public.job_areas.is_change_order
--   index: idx_job_areas_change_order
--   index: idx_pec_co_sig_job
-- @end
-- ============================================================================
-- 2026-07-09: change orders carry SCOPE (prompt 12)
-- ============================================================================
-- Three pieces, all additive:
--
-- 1. job_areas.is_change_order. An area-mode change order IS a job_areas row
--    (system + sqft + price), so materials derivation, labor budgets, and
--    price summing inherit for free on the costing side. CO areas are NOT
--    part of the estimate editor: the editor filters them out on load, their
--    invoice representation stays the preserved is_change_order LINE in
--    jobs.line_items (exactly like today's simple change orders), and
--    saveJob's area regeneration never touches them. That split is what
--    prevents double-counting: the CO's price lives on the line item; the CO
--    area row is production scope only.
--
-- 2. pec_replace_job_areas RPC: the estimate save is a full delete+reinsert
--    of a job's areas. Replaced (byte-identical except the DELETE) so the
--    delete SPARES change-order rows: `is_change_order is not true` keeps
--    legacy NULL rows deletable while CO rows survive every estimate re-save.
--    Editor-inserted areas keep order_index 0..n; CO areas are created at
--    order_index 500+ so the two ranges can never collide.
--
-- 3. pec_change_order_signatures: one row per change order (both modes),
--    minted WITH its token at CO save. Carries a display snapshot (title,
--    description, system name, sqft, amount) so the public approval page
--    renders without joining half the schema, plus the signature record
--    (typed name, drawn signature data URL, signed_at, IP, user agent).
--    Status pending -> signed drives the badges. If certified audit trails
--    ever matter, swap the native page for an e-sign API; this table's shape
--    (snapshot + signature + audit fields) would feed that migration.
--
-- Trust model: staff read/write the signature rows from the app (create at
-- CO save, read for badges). The SIGNING itself is written by the public
-- Netlify function via the service role after verifying the token, so there
-- is NO anon policy; an unauthenticated browser can never touch the table
-- directly.
--
-- *** COWORK HANDOFF: run this in the PROD Supabase project. ***
-- Idempotent / safe to re-run.
-- ============================================================================

begin;

-- 1. CO flag on job_areas ----------------------------------------------------
alter table public.job_areas
  add column if not exists is_change_order boolean not null default false;

create index if not exists idx_job_areas_change_order
  on public.job_areas (job_id) where is_change_order;

-- 2. Estimate-save RPC spares CO areas ---------------------------------------
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

  -- Replace: clear existing EDITOR areas (cascades job_area_materials), then
  -- reinsert. Change-order areas are not the editor's to manage, so they
  -- survive (is not true keeps legacy NULL rows deletable).
  delete from public.job_areas
   where job_id = p_job_id
     and is_change_order is not true;

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
      (v_idmap ->> coalesce(v_mat->>'area_index', '0'))::uuid,
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

-- 3. Change-order signature records ------------------------------------------
create table if not exists public.pec_change_order_signatures (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs(id) on delete cascade,
  area_id      uuid references public.job_areas(id) on delete set null,  -- null = simple-mode CO
  token        uuid not null unique default gen_random_uuid(),
  title        text not null,
  description  text,
  system_name  text,             -- display snapshot; survives system renames
  sqft         numeric(12,2),
  amount       numeric(12,2) not null,
  status       text not null default 'pending' check (status in ('pending','signed')),
  signed_name  text,
  signature_data text,           -- drawn signature as a data URL
  signed_at    timestamptz,
  signer_ip    text,
  signer_user_agent text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_pec_co_sig_job on public.pec_change_order_signatures (job_id, created_at desc);

alter table public.pec_change_order_signatures enable row level security;

-- Staff full access from the app (create at CO save, read for badges). The
-- public signing write comes through the service-role function only.
drop policy if exists pec_co_sig_staff on public.pec_change_order_signatures;
create policy pec_co_sig_staff on public.pec_change_order_signatures for all
  using (public.is_admin_staff()) with check (public.is_admin_staff());

drop trigger if exists trg_pec_co_sig_touch on public.pec_change_order_signatures;
create trigger trg_pec_co_sig_touch before update on public.pec_change_order_signatures
  for each row execute function public.pec_prod_touch_updated_at();

commit;

-- Verify after running:
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='job_areas'
--      and column_name='is_change_order';                                 -- 1 row
--   select prosrc like '%is_change_order is not true%' as rpc_spares_co
--     from pg_proc where proname='pec_replace_job_areas';                 -- true
--   select count(*) from information_schema.tables
--    where table_schema='public' and table_name='pec_change_order_signatures'; -- 1
--   select count(*) from pg_policies
--    where tablename='pec_change_order_signatures';                       -- 1 (staff FOR ALL)
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid='public.pec_change_order_signatures'::regclass and contype='u'; -- unique (token)
