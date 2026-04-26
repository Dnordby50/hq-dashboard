-- Migrate colors table to the current shape (single `sku` column, no CHECK on type)
-- and re-seed the 15 Simiron 1/4″ flakes. Safe to re-run.

begin;

-- 1. Drop the CHECK constraint on type (so future libraries can slot in).
alter table public.colors drop constraint if exists colors_type_check;

-- 2. Add the new `sku` column if it doesn't exist yet.
alter table public.colors add column if not exists sku text;

-- 3. Backfill `sku` from whatever the old column was.
update public.colors set sku = coalesce(sku, sku_1_4) where exists (
  select 1 from information_schema.columns
  where table_schema='public' and table_name='colors' and column_name='sku_1_4'
);
update public.colors set sku = coalesce(sku, sw_code) where exists (
  select 1 from information_schema.columns
  where table_schema='public' and table_name='colors' and column_name='sw_code'
);

-- 4. Drop the old columns (any that exist).
alter table public.colors drop column if exists sku_1_8;
alter table public.colors drop column if exists sku_1_4;
alter table public.colors drop column if exists sw_code;

-- 5. Update the get_portal_data RPC so portal reads use `sku`.
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

-- 6. Wipe any old seed rows (including the Sherwin-Williams set) and any job
-- color picks referencing them. OK to do because we're still pre-launch.
delete from public.job_colors;
delete from public.colors;

-- 7. Re-seed the 15 Simiron 1/4″ flakes.
insert into public.colors (name, type, category, hex, sku) values
  ('Autumn Brown', 'simiron', 'flake-blend', '#8B5A3C', '40001056'),
  ('Cabin Fever',  'simiron', 'flake-blend', '#5E4A3E', '40005924'),
  ('Coyote',       'simiron', 'flake-blend', '#8B7355', '40007041'),
  ('Creekbed',     'simiron', 'flake-blend', '#6B5E4F', '40005955'),
  ('Domino',       'simiron', 'flake-blend', '#3D3D3D', '40007447'),
  ('Feather Gray', 'simiron', 'flake-blend', '#B8B8B8', '40007102'),
  ('Glacier',      'simiron', 'flake-blend', '#8BA7B8', '40000967'),
  ('Gravel',       'simiron', 'flake-blend', '#7A7A72', '40005986'),
  ('Nightfall',    'simiron', 'flake-blend', '#2C3E50', '40006105'),
  ('Orbit',        'simiron', 'flake-blend', '#42454D', '40006679'),
  ('Outback',      'simiron', 'flake-blend', '#A0764A', '40005894'),
  ('Safari',       'simiron', 'flake-blend', '#8F7E5C', '40006136'),
  ('Shoreline',    'simiron', 'flake-blend', '#7FA5BA', '40005863'),
  ('Stargazer',    'simiron', 'flake-blend', '#2F3545', '40007331'),
  ('Tidal Wave',   'simiron', 'flake-blend', '#5A7A93', '40007430');

commit;
