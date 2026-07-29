-- @artifacts
--   column: public.pec_prod_material_lines.order_qty_manual
--   column: public.pec_prod_material_lines.manual_added
-- @end
--
-- Material Ordering rework: persistent quantity overrides.
--
-- order_qty_manual: true means a human set order_qty by hand and the recalc
-- merge (mergeRecalcLines in index.html) must preserve it; qty_needed stays
-- the pure calculated number so "reset to calculated" always has a target.
-- We flag rather than add a separate qty_override column because every
-- existing consumer (aggregateMaterialPull, putaway, job-detail editor,
-- costing) already reads order_qty; a flag means zero downstream changes.
--
-- manual_added: true means the whole LINE was hand-added (not produced by the
-- calculator), so recalc must never update or delete it. Legacy hand-added
-- costing lines were only identifiable by the order_index >= 9000 sentinel;
-- the backfill makes that explicit.

alter table public.pec_prod_material_lines
  add column if not exists order_qty_manual boolean not null default false,
  add column if not exists manual_added boolean not null default false;

update public.pec_prod_material_lines set manual_added = true where order_index >= 9000;

-- Verify:
--   select count(*) filter (where manual_added) as manual_lines,
--          count(*) filter (where order_qty_manual) as overridden_lines,
--          count(*) as total
--   from pec_prod_material_lines;
--   -- expect: overridden_lines = 0, manual_lines = count of order_index >= 9000 rows
