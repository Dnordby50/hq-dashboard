// PEC PM Module 1: Material calculator.
// Pure function. No I/O, no DB calls, no globals. Safe to import in browser
// and Node. Walks each Area's System Recipe and merges by product across
// areas so the same product (e.g., Tinted Gray basecoat used in two areas)
// shows up as one summed row.
//
// Rounding rule (carried from spec):
//   qty_needed = ceil(sqft_total / spread_rate / kit_size)
// Sqft is summed per-product BEFORE rounding so we don't over-order when the
// same product spans multiple areas.

export class CalculatorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CalculatorError';
    this.code = code;
  }
}

/**
 * @param {Object} input
 * @param {Array<Area>} input.areas
 *   Each Area: { id, name, sqft, system_type_id, flake_product_id, basecoat_product_id }
 * @param {Object<string, Product>} input.productsById
 *   Each Product: { id, name, material_type, supplier, color, spread_rate, kit_size, unit_cost }
 * @param {Object<string, Array<RecipeSlot>>} input.recipeSlotsBySystemType
 *   Keyed by system_type_id; each value is array of slots ordered by order_index.
 *   Each slot: { id, order_index, material_type, default_product_id, required }
 * @param {Object<string, string>} input.defaultBasecoatByFlake
 *   Keyed by flake_product_id; value is basecoat_product_id (the is_default pairing).
 *   Used only if an Area didn't explicitly set basecoat_product_id.
 * @returns {{ lines: Array<MaterialLine>, areaPlans: Array<AreaPlan> }}
 *   `lines` is the merged-by-product list (what gets written to the Sheet).
 *   `areaPlans` is the per-area breakdown (useful for the New Job preview).
 */
export function computeMaterialPlan({
  areas,
  productsById,
  recipeSlotsBySystemType,
  defaultBasecoatByFlake = {},
}) {
  if (!Array.isArray(areas)) {
    throw new CalculatorError('areas must be an array', 'INVALID_INPUT');
  }

  const areaPlans = [];

  for (const area of areas) {
    areaPlans.push(planForArea(area, {
      productsById,
      recipeSlotsBySystemType,
      defaultBasecoatByFlake,
    }));
  }

  const lines = mergeAcrossAreas(areaPlans, productsById);

  return { lines, areaPlans };
}

function planForArea(area, ctx) {
  const { productsById, recipeSlotsBySystemType, defaultBasecoatByFlake } = ctx;

  const sqft = Number(area.sqft);
  if (!Number.isFinite(sqft) || sqft < 0) {
    throw new CalculatorError(
      `Area "${area.name || area.id}": sqft must be a non-negative number`,
      'INVALID_SQFT'
    );
  }

  const slots = recipeSlotsBySystemType[area.system_type_id] || [];
  const slotLines = [];

  // Resolve the basecoat the area will use:
  // 1) explicit area.basecoat_product_id wins
  // 2) else the default pairing for the area's flake (if set)
  // 3) else fall back to the slot's default_product_id at slot-walk time
  const resolvedBasecoatId =
    area.basecoat_product_id ||
    (area.flake_product_id ? defaultBasecoatByFlake[area.flake_product_id] : null) ||
    null;

  for (const slot of slots) {
    let productId = slot.default_product_id;

    if (slot.material_type === 'Flake') {
      productId = area.flake_product_id || productId;
    } else if (slot.material_type === 'Basecoat') {
      productId = resolvedBasecoatId || productId;
    }

    if (!productId) {
      if (slot.required) {
        throw new CalculatorError(
          `Area "${area.name || area.id}": ${slot.material_type} is required but no product was selected`,
          'MISSING_PRODUCT'
        );
      }
      continue;
    }

    const product = productsById[productId];
    if (!product) {
      throw new CalculatorError(
        `Area "${area.name || area.id}": product ${productId} not found in catalog`,
        'PRODUCT_NOT_FOUND'
      );
    }

    const spread = Number(product.spread_rate);
    const kit = Number(product.kit_size);
    if (!Number.isFinite(spread) || spread <= 0) {
      throw new CalculatorError(
        `Product "${product.name}" has invalid spread_rate (${product.spread_rate}); fix it in the System Catalog before calculating`,
        'INVALID_SPREAD_RATE'
      );
    }
    if (!Number.isFinite(kit) || kit <= 0) {
      throw new CalculatorError(
        `Product "${product.name}" has invalid kit_size (${product.kit_size}); fix it in the System Catalog before calculating`,
        'INVALID_KIT_SIZE'
      );
    }

    slotLines.push({
      area_id: area.id || null,
      area_name: area.name || null,
      order_index: slot.order_index,
      material_type: slot.material_type,
      product_id: product.id,
      product_name: product.name,
      supplier: product.supplier || null,
      color: product.color || null,
      spread_rate: spread,
      kit_size: kit,
      unit_cost: product.unit_cost == null ? null : Number(product.unit_cost),
      sqft, // carry sqft so we can sum across areas before rounding
    });
  }

  return { area, lines: slotLines };
}

function mergeAcrossAreas(areaPlans, productsById) {
  // Group by product_id so the same product across multiple areas becomes one
  // summed row. Lines with sqft=0 across all areas drop out per spec.
  const groups = new Map();

  for (const { lines } of areaPlans) {
    for (const line of lines) {
      const key = line.product_id;
      if (!groups.has(key)) {
        groups.set(key, {
          material_type: line.material_type,
          product_id: line.product_id,
          product_name: line.product_name,
          supplier: line.supplier,
          color: line.color,
          spread_rate: line.spread_rate,
          kit_size: line.kit_size,
          unit_cost_snapshot: line.unit_cost,
          sqft_total: 0,
          area_ids: [],
          first_order_index: line.order_index,
        });
      }
      const g = groups.get(key);
      g.sqft_total += line.sqft;
      if (line.area_id) g.area_ids.push(line.area_id);
      if (line.order_index < g.first_order_index) g.first_order_index = line.order_index;
    }
  }

  const merged = [];
  let i = 0;
  for (const g of groups.values()) {
    if (g.sqft_total <= 0) continue; // sqft=0 across all areas, skip
    const qty = Math.ceil(g.sqft_total / g.spread_rate / g.kit_size);
    const lineCost = g.unit_cost_snapshot == null ? null : round2(qty * g.unit_cost_snapshot);
    merged.push({
      material_type: g.material_type,
      product_id: g.product_id,
      product_name: g.product_name,
      supplier: g.supplier,
      color: g.color,
      spread_rate: g.spread_rate,
      kit_size: g.kit_size,
      qty_needed: qty,
      backstock_qty: 0,
      order_qty: qty,
      use_backstock: false,
      ordered: false,
      delivered: false,
      unit_cost_snapshot: g.unit_cost_snapshot,
      line_cost: lineCost,
      area_ids: g.area_ids,
      sqft_total: g.sqft_total,
      order_index: i++,
      _sort_key: g.first_order_index,
    });
  }

  // Stable sort by recipe order so the Sheet rows come out in the canonical
  // (Basecoat, Flake, Topcoat, ...) order for whichever system was used.
  merged.sort((a, b) => a._sort_key - b._sort_key);
  merged.forEach((line, idx) => {
    line.order_index = idx;
    delete line._sort_key;
  });
  return merged;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
