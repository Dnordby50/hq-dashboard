-- @artifacts
--   column: public.pec_prod_products.default_basecoat_product_id
-- @end
-- Move flake->basecoat pairing onto the flake product itself.
-- Single default basecoat per flake. Additive + idempotent. Backfills from
-- the existing default color pairings. Does NOT drop pec_prod_color_pairings.
alter table public.pec_prod_products
  add column if not exists default_basecoat_product_id uuid
  references public.pec_prod_products(id) on delete set null;

update public.pec_prod_products f
set default_basecoat_product_id = cp.basecoat_product_id
from public.pec_prod_color_pairings cp
where cp.flake_product_id = f.id
  and cp.is_default = true
  and f.default_basecoat_product_id is null;
