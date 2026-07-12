// Self-asserting Node script. No framework. Run with `npm test` or
// `node production/calculator.test.js`. Exits non-zero on the first failure.
//
// Covers every edge case called out in the spec plus a multi-area sanity check.

import { computeMaterialPlan, computeJobEstimate, computeEstimatePricing, roundEstimatePrice, CALC_VERSION, jobNameAddrKey, resolveCrmForProdJob, CalculatorError, lineItemsTotal, lineItemsGp, allocateProportionally } from './calculator.js';
import { actualGpPct, costingMaterials, costingComplete, joinCompsSources, buildComps, compsGpCaveat } from './comps.js';

let passed = 0;
let failed = 0;

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
    console.error(`       expected: ${e}`);
    console.error(`       actual:   ${a}`);
  }
}

function assertThrows(fn, code, label) {
  try {
    fn();
    failed++;
    console.error(`  FAIL ${label} (expected throw with code ${code})`);
  } catch (err) {
    if (err instanceof CalculatorError && err.code === code) {
      passed++;
      console.log(`  ok   ${label}`);
    } else {
      failed++;
      console.error(`  FAIL ${label} (got ${err.name}: ${err.message})`);
    }
  }
}

// ----------------------------------------------------------------------------
// Fixture: Standard Flake System with the 3 seeded products.
// ----------------------------------------------------------------------------
const productsById = {
  basecoat: { id: 'basecoat', name: 'Simiron 1100 SL - Tinted Gray', material_type: 'Basecoat', supplier: 'Simiron', color: 'Tinted Gray', spread_rate: 150, kit_size: 3, unit_cost: 240 },
  flake:    { id: 'flake',    name: 'Decorative Simiron Flake - Domino', material_type: 'Flake', supplier: 'Simiron', color: 'Domino',     spread_rate: 350, kit_size: 1, unit_cost: 95 },
  topcoat:  { id: 'topcoat',  name: 'Polyaspartic Clear Gloss', material_type: 'Topcoat', supplier: 'Simiron', color: 'Clear Gloss', spread_rate: 120, kit_size: 2, unit_cost: 320 },
  blackBase:{ id: 'blackBase',name: 'Simiron 1100 SL - Black',   material_type: 'Basecoat', supplier: 'Simiron', color: 'Black',       spread_rate: 150, kit_size: 3, unit_cost: 240 },
  badSpread:{ id: 'badSpread',name: 'Bad Product',               material_type: 'Topcoat', supplier: 'X', color: null, spread_rate: 0,   kit_size: 1, unit_cost: null },
};

const recipeSlotsBySystemType = {
  std: [
    { id: 's1', order_index: 1, material_type: 'Basecoat', default_product_id: 'basecoat', required: true },
    { id: 's2', order_index: 2, material_type: 'Flake',    default_product_id: null,        required: true },
    { id: 's3', order_index: 3, material_type: 'Topcoat',  default_product_id: 'topcoat',   required: true },
  ],
  badSystem: [
    { id: 'b1', order_index: 1, material_type: 'Topcoat', default_product_id: 'badSpread', required: true },
  ],
};

const defaultBasecoatByFlake = {
  flake: 'basecoat',
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function lineByMaterial(plan, materialType) {
  return plan.lines.find((l) => l.material_type === materialType);
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------
console.log('calculator.test.js');

// --- Single area, 600 sqft, Standard Flake + Domino -------------------------
{
  const plan = computeMaterialPlan({
    areas: [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake' }],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  assertEq(plan.lines.length, 3, '600 sqft Standard Flake -> 3 lines');
  assertEq(lineByMaterial(plan, 'Basecoat').qty_needed, Math.ceil(600 / 150 / 3), '600 sqft basecoat = ceil(600/150/3) = 2 kits');
  assertEq(lineByMaterial(plan, 'Flake').qty_needed,    Math.ceil(600 / 350 / 1), '600 sqft flake = 2 boxes');
  assertEq(lineByMaterial(plan, 'Topcoat').qty_needed,  Math.ceil(600 / 120 / 2), '600 sqft topcoat = 3 kits');
  assertEq(lineByMaterial(plan, 'Topcoat').line_cost,   320 * Math.ceil(600 / 120 / 2), 'topcoat line cost snapshotted');
  assertEq(lineByMaterial(plan, 'Basecoat').color,      'Tinted Gray', 'basecoat auto-filled from default pairing');
}

// --- sqft = 0 should produce no lines ---------------------------------------
{
  const plan = computeMaterialPlan({
    areas: [{ id: 'a1', name: 'Empty', sqft: 0, system_type_id: 'std', flake_product_id: 'flake' }],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  assertEq(plan.lines.length, 0, 'sqft=0 -> no material lines');
}

// --- sqft = 1 should round up to 1 of every product ------------------------
{
  const plan = computeMaterialPlan({
    areas: [{ id: 'a1', name: 'Tiny', sqft: 1, system_type_id: 'std', flake_product_id: 'flake' }],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  assertEq(lineByMaterial(plan, 'Basecoat').qty_needed, 1, 'sqft=1 basecoat = 1 kit');
  assertEq(lineByMaterial(plan, 'Flake').qty_needed,    1, 'sqft=1 flake = 1 box');
  assertEq(lineByMaterial(plan, 'Topcoat').qty_needed,  1, 'sqft=1 topcoat = 1 kit');
}

// --- Exact kit boundary: 450 sqft basecoat (150 sqft/gal x 3 gal/kit) = 1 kit
{
  const plan = computeMaterialPlan({
    areas: [{ id: 'a1', name: 'KitBoundary', sqft: 450, system_type_id: 'std', flake_product_id: 'flake' }],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  assertEq(lineByMaterial(plan, 'Basecoat').qty_needed, 1, '450 sqft basecoat = exactly 1 kit (no overshoot)');
}

// --- Exact box boundaries for flake: 350, 700, 1050 -> 1, 2, 3 boxes -------
for (const [sqft, expected] of [[350, 1], [700, 2], [1050, 3]]) {
  const plan = computeMaterialPlan({
    areas: [{ id: 'a1', name: 'BoxBoundary', sqft, system_type_id: 'std', flake_product_id: 'flake' }],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  assertEq(lineByMaterial(plan, 'Flake').qty_needed, expected, `${sqft} sqft flake = ${expected} boxes`);
}

// --- spread_rate = 0 throws -------------------------------------------------
assertThrows(() => {
  computeMaterialPlan({
    areas: [{ id: 'a1', name: 'Bad', sqft: 100, system_type_id: 'badSystem' }],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
}, 'INVALID_SPREAD_RATE', 'spread_rate=0 rejected with explanatory error');

// --- Negative sqft rejected -------------------------------------------------
assertThrows(() => {
  computeMaterialPlan({
    areas: [{ id: 'a1', name: 'Negative', sqft: -100, system_type_id: 'std', flake_product_id: 'flake' }],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
}, 'INVALID_SQFT', 'negative sqft rejected');

// --- Missing required SWATCH product (flake not picked) ---------------------
// Behavior change 2026-06-10 (Dylan): a required swatch slot (Flake / Quartz /
// Metallic Pigment) with no product is a custom in-house blend, not an error.
// It emits a manual placeholder line (product_id null, qty 1, cost 0) priced
// per job in the line editor. Basecoat/Topcoat keep the hard MISSING_PRODUCT
// throw (tested below) since those are always catalog products.
{
  const plan = computeMaterialPlan({
    areas: [{ id: 'a1', name: 'NoFlake', sqft: 600, system_type_id: 'std' }],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  const ph = lineByMaterial(plan, 'Flake');
  assertEq(ph.product_id, null, 'custom blend flake: product_id is null (manual flag)');
  assertEq(ph.product_name, 'Custom blend flake (enter cost)', 'custom blend flake: placeholder name');
  assertEq([ph.qty_needed, ph.order_qty, ph.unit_cost_snapshot, ph.line_cost], [1, 1, 0, 0], 'custom blend flake: qty 1, zero cost until priced');
  assertEq(ph.order_index, plan.lines.length - 1, 'custom blend flake: placeholder sorts last');
  assertEq(plan.lines.length, 3, 'custom blend flake: basecoat + topcoat lines still generated');
}

// --- Two areas both missing flake merge into ONE placeholder ----------------
{
  const plan = computeMaterialPlan({
    areas: [
      { id: 'a1', name: 'Garage', sqft: 400, system_type_id: 'std' },
      { id: 'a2', name: 'Patio',  sqft: 200, system_type_id: 'std' },
    ],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  const phs = plan.lines.filter((l) => l.product_id === null);
  assertEq(phs.length, 1, 'two flakeless areas: one merged placeholder');
  assertEq(phs[0].area_ids, ['a1', 'a2'], 'two flakeless areas: placeholder carries both area ids');
}

// --- Missing Flake AND missing Quartz yield TWO placeholders ----------------
{
  const slotsWithQuartz = {
    ...recipeSlotsBySystemType,
    qtz: [
      { id: 'q1', order_index: 1, material_type: 'Basecoat', default_product_id: 'basecoat', required: true },
      { id: 'q2', order_index: 2, material_type: 'Quartz',   default_product_id: null,        required: true },
      { id: 'q3', order_index: 3, material_type: 'Topcoat',  default_product_id: 'topcoat',   required: true },
    ],
  };
  const plan = computeMaterialPlan({
    areas: [
      { id: 'a1', name: 'Flake area',  sqft: 300, system_type_id: 'std' },
      { id: 'a2', name: 'Quartz area', sqft: 300, system_type_id: 'qtz' },
    ],
    productsById,
    recipeSlotsBySystemType: slotsWithQuartz,
    defaultBasecoatByFlake,
  });
  const phs = plan.lines.filter((l) => l.product_id === null);
  assertEq(phs.map((l) => l.material_type).sort(), ['Flake', 'Quartz'], 'missing flake + quartz: one placeholder per material type');
}

// --- Missing required Basecoat still throws ----------------------------------
assertThrows(() => {
  computeMaterialPlan({
    areas: [{ id: 'a1', name: 'NoBase', sqft: 600, system_type_id: 'noBaseDefault' }],
    productsById,
    recipeSlotsBySystemType: {
      noBaseDefault: [
        { id: 'n1', order_index: 1, material_type: 'Basecoat', default_product_id: null, required: true },
      ],
    },
    defaultBasecoatByFlake,
  });
}, 'MISSING_PRODUCT', 'missing required Basecoat still rejected');

// --- Multi-area: same product across areas merges by sqft (not sum-of-ceils)
{
  // Two garage-flake areas: 200 sqft + 200 sqft. Combined 400 sqft basecoat.
  // ceil(400/150/3) = 1 kit. Sum-of-ceils would (wrongly) give 1+1 = 2.
  const plan = computeMaterialPlan({
    areas: [
      { id: 'a1', name: 'Garage A', sqft: 200, system_type_id: 'std', flake_product_id: 'flake' },
      { id: 'a2', name: 'Garage B', sqft: 200, system_type_id: 'std', flake_product_id: 'flake' },
    ],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  assertEq(plan.lines.length, 3, 'two areas same products -> 3 merged lines');
  assertEq(lineByMaterial(plan, 'Basecoat').qty_needed, Math.ceil(400 / 150 / 3), 'merged basecoat 400 sqft -> 1 kit (not 2)');
  assertEq(lineByMaterial(plan, 'Basecoat').area_ids.length, 2, 'merged line tracks both source areas');
}

// --- Multi-area: different basecoat colors stay as separate lines ----------
{
  const plan = computeMaterialPlan({
    areas: [
      { id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake' /* default basecoat = tinted gray */ },
      { id: 'a2', name: 'Mudroom', sqft: 300, system_type_id: 'std', flake_product_id: 'flake', basecoat_product_id: 'blackBase' },
    ],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  const basecoats = plan.lines.filter((l) => l.material_type === 'Basecoat');
  assertEq(basecoats.length, 2, 'two distinct basecoats -> two separate lines');
  assertEq(basecoats.find((l) => l.color === 'Tinted Gray').qty_needed, Math.ceil(600 / 150 / 3), 'Tinted Gray basecoat 600 sqft = 2 kits');
  assertEq(basecoats.find((l) => l.color === 'Black').qty_needed,       Math.ceil(300 / 150 / 3), 'Black basecoat 300 sqft = 1 kit');
}

// --- Recipe order preserved in the merged output ---------------------------
{
  const plan = computeMaterialPlan({
    areas: [{ id: 'a1', name: 'Order', sqft: 1000, system_type_id: 'std', flake_product_id: 'flake' }],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  assertEq(
    plan.lines.map((l) => l.material_type),
    ['Basecoat', 'Flake', 'Topcoat'],
    'output order matches recipe slot order_index'
  );
}

// --- Metallic Pigment slot resolves via area.flake_product_id --------------
{
  const productsByIdMP = {
    ...productsById,
    mvb:     { id: 'mvb',     name: 'Simiron MVB', material_type: 'Basecoat', supplier: 'Simiron', color: 'Clear', spread_rate: 150, kit_size: 3, unit_cost: null },
    metEpx:  { id: 'metEpx',  name: 'Simiron Metallic Epoxy', material_type: 'Extra', supplier: 'Simiron', color: 'Clear', spread_rate: 100, kit_size: 3, unit_cost: null },
    pigSilv: { id: 'pigSilv', name: 'Simiron Metallic Pigment - Silver', material_type: 'Metallic Pigment', supplier: 'Simiron', color: 'Silver', spread_rate: 240, kit_size: 1, unit_cost: null },
    urethane:{ id: 'urethane',name: 'Simiron High Wear Urethane', material_type: 'Topcoat', supplier: 'Simiron', color: 'Clear', spread_rate: 150, kit_size: 1, unit_cost: null },
  };
  const recipesMP = {
    metallic: [
      { id: 'm1', order_index: 1, material_type: 'Basecoat',         default_product_id: 'mvb',     required: true },
      { id: 'm2', order_index: 2, material_type: 'Extra',            default_product_id: 'metEpx',  required: true },
      { id: 'm3', order_index: 3, material_type: 'Metallic Pigment', default_product_id: null,      required: true },
      { id: 'm4', order_index: 4, material_type: 'Topcoat',          default_product_id: 'urethane',required: true },
    ],
  };
  const plan = computeMaterialPlan({
    areas: [{ id: 'a1', name: 'Studio', sqft: 480, system_type_id: 'metallic', flake_product_id: 'pigSilv' }],
    productsById: productsByIdMP,
    recipeSlotsBySystemType: recipesMP,
  });
  const pig = plan.lines.find(l => l.material_type === 'Metallic Pigment');
  assertEq(!!pig, true, 'Metallic Pigment slot produces a line');
  assertEq(pig.product_id, 'pigSilv', 'Metallic Pigment line uses area.flake_product_id pick');
  assertEq(pig.qty_needed, Math.ceil(480 / 240 / 1), 'Metallic Pigment qty = ceil(480/240/1) = 2');
}

// --- Standalone MVB: one extra line at total sqft / 100 / 3 ----------------
{
  const productsByIdMvb = {
    ...productsById,
    mvbStd: { id: 'mvbStd', name: 'Simiron MVB - Standalone', material_type: 'Basecoat', supplier: 'Simiron', color: 'Clear', spread_rate: 100, kit_size: 3, unit_cost: null },
  };
  const plan = computeMaterialPlan({
    areas: [
      { id: 'a1', name: 'Garage A', sqft: 300, system_type_id: 'std', flake_product_id: 'flake' },
      { id: 'a2', name: 'Garage B', sqft: 300, system_type_id: 'std', flake_product_id: 'flake' },
    ],
    productsById: productsByIdMvb,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
    standaloneMvb: true,
    standaloneMvbProductId: 'mvbStd',
  });
  const mvbLine = plan.lines.find(l => l.product_id === 'mvbStd');
  assertEq(!!mvbLine, true, 'Standalone MVB produces an extra line');
  assertEq(mvbLine.qty_needed, Math.ceil(600 / 100 / 3), 'Standalone MVB qty over 600 sqft = 2 kits');
  assertEq(mvbLine.product_name, 'Simiron MVB - Standalone', 'Standalone MVB line carries the right product name');
}

// --- Standalone MVB off: no extra line --------------------------------------
{
  const plan = computeMaterialPlan({
    areas: [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake' }],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
    standaloneMvb: false,
  });
  const hasMvbLine = plan.lines.some(l => /MVB/.test(l.product_name));
  assertEq(hasMvbLine, false, 'standaloneMvb=false produces no MVB line');
}

// --- Cure speed: 1100 SL basecoat stamps from area.basecoat_cure_speed -----
// Cure speed is authored on the area, not the line, but the planner needs to
// stamp it onto whichever line ends up using a 1100 SL or Polyaspartic
// product. This test pins the basecoat stamping against the Standard Flake
// recipe (basecoat = Simiron 1100 SL - Tinted Gray).
{
  const plan = computeMaterialPlan({
    areas: [{
      id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake',
      basecoat_cure_speed: 'Slow',
      topcoat_cure_speed: 'XTRA Slow',
    }],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  assertEq(lineByMaterial(plan, 'Basecoat').cure_speed, 'Slow',     'basecoat (1100 SL) line gets basecoat_cure_speed');
  assertEq(lineByMaterial(plan, 'Topcoat').cure_speed,  'XTRA Slow', 'topcoat (Polyaspartic) line gets topcoat_cure_speed');
  assertEq(lineByMaterial(plan, 'Flake').cure_speed,    null,        'flake line has no cure speed');
}

// --- Cure speed: same product across areas with different cure speeds stays
// as two lines, not one (otherwise Fast and Slow collapse and the value is
// silently lost). Both areas share the same flake so the basecoat product
// resolves the same way; only the cure_speed differs.
{
  const plan = computeMaterialPlan({
    areas: [
      { id: 'a1', name: 'Garage A', sqft: 300, system_type_id: 'std', flake_product_id: 'flake', basecoat_cure_speed: 'Fast' },
      { id: 'a2', name: 'Garage B', sqft: 300, system_type_id: 'std', flake_product_id: 'flake', basecoat_cure_speed: 'Slow' },
    ],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  const basecoats = plan.lines.filter(l => l.material_type === 'Basecoat');
  assertEq(basecoats.length, 2, 'two cure speeds for same basecoat -> two basecoat lines');
  const speeds = basecoats.map(l => l.cure_speed).sort();
  assertEq(speeds[0], 'Fast', 'one line keeps Fast');
  assertEq(speeds[1], 'Slow', 'other line keeps Slow');
}

// --- Cure speed: same product, same cure speed across two areas merges as
// before (this is the regression test that proves we didn't break sqft merge
// for cure-speed-bearing products).
{
  const plan = computeMaterialPlan({
    areas: [
      { id: 'a1', name: 'Garage A', sqft: 300, system_type_id: 'std', flake_product_id: 'flake', basecoat_cure_speed: 'Standard' },
      { id: 'a2', name: 'Garage B', sqft: 300, system_type_id: 'std', flake_product_id: 'flake', basecoat_cure_speed: 'Standard' },
    ],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  const basecoats = plan.lines.filter(l => l.material_type === 'Basecoat');
  assertEq(basecoats.length, 1, 'same cure speed across two areas -> one merged basecoat line');
  assertEq(basecoats[0].cure_speed, 'Standard', 'merged line keeps the cure speed');
  assertEq(basecoats[0].sqft_total, 600, 'merged line sums sqft across both areas');
}

// --- Topcoat override: area.topcoat_product_id wins over the slot default ---
// New behavior added alongside U-Tint attachments. Without the override, the
// recipe's topcoat slot default would be used and there'd be no way to attach
// a U-Tint to a different topcoat product per area.
{
  const productsWithAlt = {
    ...productsById,
    altTop: { id: 'altTop', name: 'Polyaspartic Matte', material_type: 'Topcoat', supplier: 'Simiron', color: 'Matte', spread_rate: 120, kit_size: 2, unit_cost: 350 },
  };
  const plan = computeMaterialPlan({
    areas: [{
      id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake',
      topcoat_product_id: 'altTop',
    }],
    productsById: productsWithAlt,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  const top = plan.lines.find(l => l.material_type === 'Topcoat');
  assertEq(top.product_id, 'altTop',         'topcoat_product_id override wins over slot default');
  assertEq(top.product_name, 'Polyaspartic Matte', 'override carries the right product name');
}

// --- U-Tint attachment: area.tints emit Tint Pack lines with packs as qty --
// One tint, two packs, expect one Tint Pack line with qty_needed = 2 and
// line_cost = 2 * unit_cost (no sqft math).
{
  const productsWithTint = {
    ...productsById,
    tintHaze: { id: 'tintHaze', name: 'Simiron U-Tint Pack 16oz - Haze Gray', material_type: 'Tint Pack', supplier: 'Simiron', color: 'Haze Gray', spread_rate: 240, kit_size: 1, unit_cost: 22 },
  };
  const plan = computeMaterialPlan({
    areas: [{
      id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake',
      tints: [{ product_id: 'tintHaze', attach_to: 'Basecoat', packs: 2 }],
    }],
    productsById: productsWithTint,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  const tint = plan.lines.find(l => l.material_type === 'Tint Pack');
  assertEq(!!tint, true,            'tint attachment produces a Tint Pack line');
  assertEq(tint.qty_needed, 2,      'qty_needed = packs (no sqft math)');
  assertEq(tint.line_cost,  44,     'line_cost = packs * unit_cost');
  assertEq(tint.product_name, 'Simiron U-Tint Pack 16oz - Haze Gray', 'tint line carries the right product name');
}

// --- U-Tint attachment merges across areas by product_id (sums packs) -------
// Same tint attached to two areas (one Basecoat, one Topcoat) should sum to
// one order line with packs_total. Different attach_to values do not split
// the row; the order list cares about ordering quantity, not per-slot
// allocation.
{
  const productsWithTint = {
    ...productsById,
    tintWhite: { id: 'tintWhite', name: 'Simiron U-Tint Pack 16oz - White', material_type: 'Tint Pack', supplier: 'Simiron', color: 'White', spread_rate: 240, kit_size: 1, unit_cost: 22 },
  };
  const plan = computeMaterialPlan({
    areas: [
      { id: 'a1', name: 'Garage', sqft: 300, system_type_id: 'std', flake_product_id: 'flake',
        tints: [{ product_id: 'tintWhite', attach_to: 'Basecoat', packs: 1 }] },
      { id: 'a2', name: 'Patio',  sqft: 300, system_type_id: 'std', flake_product_id: 'flake',
        tints: [{ product_id: 'tintWhite', attach_to: 'Topcoat',  packs: 3 }] },
    ],
    productsById: productsWithTint,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
  const tints = plan.lines.filter(l => l.material_type === 'Tint Pack');
  assertEq(tints.length, 1,   'same tint across two areas merges into one Tint Pack line');
  assertEq(tints[0].qty_needed, 4, 'merged Tint Pack qty = sum of packs (1+3)');
}

// --- computeJobEstimate: ONE estimate shared by the front-end + Job Costing --
// The front-end Budget card and Job Costing both call computeJobEstimate, so
// there is no second copy of the estimate math. These assert its two outputs.
{
  const systemTypes = [{ id: 'std', labor_budget_pct: 20 }];
  const areas = [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake' }];
  const est = computeJobEstimate({
    areas, productsById, recipeSlotsBySystemType, defaultBasecoatByFlake,
    systemTypes, revenue: 10000, laborRate: 50,
  });
  // Materials are exactly the computeMaterialPlan lines for the same areas.
  const plan = computeMaterialPlan({ areas, productsById, recipeSlotsBySystemType, defaultBasecoatByFlake });
  assertEq(est.materialLines, plan.lines, 'estimate materials == computeMaterialPlan lines (one source)');
  assertEq(est.materialsBudget, plan.lines.reduce((s, l) => s + (Number(l.line_cost) > 0 ? Number(l.line_cost) : 0), 0), 'materialsBudget = sum of positive line costs');
  // Labor: revenue 10000 x 20% = 2000 budget; / $50/hr = 40 budgeted hours.
  assertEq(est.laborBudget, 2000, 'laborBudget = revenue x labor_budget_pct');
  assertEq(est.budgetedHours, 40, 'budgetedHours = laborBudget / laborRate');
}

// --- computeJobEstimate drops a topcoat pick (matches the front-end Budget) ---
// The front-end normalizes flake + basecoat only; a topcoat pick must fall to
// the slot default so Job Costing and the Budget card never diverge on topcoat.
{
  const systemTypes = [{ id: 'std', labor_budget_pct: 20 }];
  const withTopcoatPick = computeJobEstimate({
    areas: [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake', topcoat_product_id: 'blackBase' }],
    productsById, recipeSlotsBySystemType, defaultBasecoatByFlake, systemTypes, revenue: 0, laborRate: 0,
  });
  const topcoat = withTopcoatPick.materialLines.find((l) => l.material_type === 'Topcoat');
  assertEq(topcoat.product_id, 'topcoat', 'topcoat pick ignored; slot default used (matches front-end)');
}

// --- resolveCrmForProdJob: bridge a prod job to its CRM job card -------------
// The deal id is the reliable bridge; manual (deal-null) prod rows fall back to
// normalized name+address. This is what fixed Lisa Santana (manual prod row,
// bridged CRM job): the deal-only lookup missed her, name+address finds her.
{
  const crmBridged = { id: 'crm-1', price: 5000 };
  const crmSantana = { id: 'crm-santana', price: 7400 };
  const indexes = {
    byDeal: { '2776218-other': crmBridged },
    byNameAddr: {
      [jobNameAddrKey('Lisa Santana', '123 Main St')]: crmSantana,
      [jobNameAddrKey('Bridged Bob', '9 Oak Ave')]: crmBridged,
    },
  };
  // Deal match wins.
  assertEq(
    resolveCrmForProdJob({ dripjobs_deal_id: '2776218-other', customer_name: 'X', address: 'Y' }, indexes),
    crmBridged, 'deal id match takes priority');
  // Manual (deal-null) prod row resolves by name+address.
  assertEq(
    resolveCrmForProdJob({ dripjobs_deal_id: null, customer_name: 'Lisa Santana', address: '123 Main St' }, indexes),
    crmSantana, 'deal-null prod row matched by name+address (the Santana fix)');
  // Case / whitespace insensitive.
  assertEq(
    resolveCrmForProdJob({ dripjobs_deal_id: null, customer_name: '  lisa   santana ', address: '123 main st' }, indexes),
    crmSantana, 'name+address match is case/whitespace insensitive');
  // No false match when address is blank (key requires BOTH fields).
  assertEq(
    resolveCrmForProdJob({ dripjobs_deal_id: null, customer_name: 'Lisa Santana', address: '' }, indexes),
    null, 'blank address never matches');
  assertEq(jobNameAddrKey('Name', ''), '', 'jobNameAddrKey requires both fields');
}

// --- slot_kind regression: choice/text slots never affect the material plan --
// The estimator's question flow leans on choice + free-text recipe slots. A
// required choice/text slot carries no product, so it must be skipped: without
// the guard in planForArea it throws MISSING_PRODUCT (or emits a phantom line)
// and corrupts M (and therefore every price). This pins same-plan-as-without.
{
  const recipesWithChoiceText = {
    flakeCT: [
      { id: 'c1', order_index: 1, material_type: 'Basecoat', default_product_id: 'basecoat', required: true },
      { id: 'c2', order_index: 2, slot_kind: 'choice', material_type: 'Broadcast', label: 'Broadcast', required: true, default_product_id: null },
      { id: 'c3', order_index: 3, material_type: 'Flake',    default_product_id: null,        required: true },
      { id: 'c4', order_index: 4, slot_kind: 'text',   material_type: 'Notes', label: 'Notes', required: true, default_product_id: null },
      { id: 'c5', order_index: 5, material_type: 'Topcoat',  default_product_id: 'topcoat',   required: true },
    ],
    flakePlain: [
      { id: 'p1', order_index: 1, material_type: 'Basecoat', default_product_id: 'basecoat', required: true },
      { id: 'p3', order_index: 3, material_type: 'Flake',    default_product_id: null,        required: true },
      { id: 'p5', order_index: 5, material_type: 'Topcoat',  default_product_id: 'topcoat',   required: true },
    ],
  };
  const areaCT = [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'flakeCT', flake_product_id: 'flake' }];
  let planCT;
  try {
    planCT = computeMaterialPlan({ areas: areaCT, productsById, recipeSlotsBySystemType: recipesWithChoiceText, defaultBasecoatByFlake });
    passed++; console.log('  ok   choice/text slots do not throw');
  } catch (err) {
    failed++; console.error(`  FAIL choice/text slots do not throw (got ${err.name}: ${err.message})`);
    planCT = { lines: [] };
  }
  // Same job through the slot set with the choice/text slots removed: the only
  // difference is their presence, so the material lines must come out identical.
  const planPlain = computeMaterialPlan({ areas: [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'flakePlain', flake_product_id: 'flake' }], productsById, recipeSlotsBySystemType: recipesWithChoiceText, defaultBasecoatByFlake });
  assertEq(planCT.lines.map(l => [l.material_type, l.qty_needed, l.line_cost]),
           planPlain.lines.map(l => [l.material_type, l.qty_needed, l.line_cost]),
           'choice/text slots yield the same material lines as without them');
  const mCT = planCT.lines.reduce((s, l) => s + (Number(l.line_cost) > 0 ? Number(l.line_cost) : 0), 0);
  const mPlain = planPlain.lines.reduce((s, l) => s + (Number(l.line_cost) > 0 ? Number(l.line_cost) : 0), 0);
  assertEq(mCT, mPlain, 'choice/text slots do not change materials cost M');
}

// --- roundEstimatePrice: nearest $5, with charm-down near big round numbers --
// Dylan's rule: round to the nearest $5, but if the price lands at or just
// above a major round number (within the band), drop to that number minus $5
// (e.g. 5150 -> 4995). threshold 1000 / band 250 are the defaults.
{
  const o = { increment: 5, charmThreshold: 1000, charmBand: 250 };
  assertEq(roundEstimatePrice(7409.09, o), 7410, 'round: 7409.09 -> nearest $5 = 7410 (no charm, 410 above 7000)');
  assertEq(roundEstimatePrice(5150, o),    4995, 'round: 5150 -> charm-down to 4995 (150 above 5000)');
  assertEq(roundEstimatePrice(4998, o),    4995, 'round: 4998 -> $5 rounds to 5000 then charm-down to 4995');
  assertEq(roundEstimatePrice(5400, o),    5400, 'round: 5400 -> no charm (400 above 5000 > band)');
  assertEq(roundEstimatePrice(5252, o),    4995, 'round: 5252 -> nearest $5 5250 (250 above, edge of band) -> charm 4995');
  assertEq(roundEstimatePrice(5253, o),    5255, 'round: 5253 -> 5255 (255 above 5000 > band) -> no charm');
  assertEq(roundEstimatePrice(980,  o),     980, 'round: 980 -> no charm below the first threshold');
  assertEq(roundEstimatePrice(7412, { increment: 5 }), 7410, 'round: charm disabled -> pure nearest $5 (round down)');
}

// --- computeEstimatePricing: closed-form cost-plus to target margin ----------
// Standard Flake 600 sqft fixture -> M = basecoat 2*240 + flake 2*95 + topcoat
// 3*320 = 480 + 190 + 960 = 1630. With laborPct 20, STANDARD commission 8%,
// targetGP 50: divisor = 1 - .20 - .08 - .50 = .22; priceRaw = 1630/.22 =
// 7409.09 -> nearest $5 = 7410. At 7410: labor 1482, std comm 592.8,
// gp = 7410 - (1630 + 1482 + 592.8) = 3705.2 -> gpPct ~0.5000.
{
  const systemTypes = [{ id: 'std', labor_budget_pct: 20 }];
  const areas = [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake' }];
  const r = computeEstimatePricing({
    areas, productsById, recipeSlotsBySystemType, defaultBasecoatByFlake,
    systemTypes, laborRate: 50, commissionPct: 8, targetGpPct: 50,
  });
  assertEq(r.error, null, 'pricing: no error on a valid plan');
  assertEq(r.materialsCost, 1630, 'pricing: M = sum of material line costs (1630)');
  assertEq(r.price, 7410, 'pricing: price = nearest $5 of the cost-plus number');
  assertEq(r.commissionDollars, 592.8, 'pricing: budgeted commission = standard 8% of the final price');
  assertEq(r.laborDollars, 1482, 'pricing: labor = 20% of the final price');
  assertEq(r.gpDollars, 3705.2, 'pricing: budgeted GP$ = price - (M + labor + std commission)');
  assertEq(Math.abs(r.gpPct - 0.50) < 0.005, true, 'pricing: budgeted GP% within half a point of target');
  // No actualCommissionPct given -> rep is at the standard rate: payout = budgeted, no variance.
  assertEq(r.standardCommissionPct, 8, 'pricing: standardCommissionPct echoes the standard');
  assertEq(r.actualCommissionPct, 8, 'pricing: actual defaults to the standard when not given');
  assertEq(r.commissionPayout, 592.8, 'pricing: payout = actual rate (defaulted to standard) * price');
  assertEq(r.gpVariance, 0, 'pricing: no variance when the rep is at the standard rate');
  assertEq(r.realizedGp, r.gpDollars, 'pricing: realized GP = budgeted GP when variance is 0');
  assertEq(r.budgetedHours, 1482 / 50, 'pricing: budgetedHours from labor budget at the final price');
}

// --- computeEstimatePricing: STANDARD-rate commission, rep-independent price --
// Decision (2026-06-21): commission is a budgeted house expense in the price at
// the STANDARD rate, so the quote is identical no matter which rep is assigned.
// The rep's ACTUAL rate only drives payout + GP variance. Standard 6%, M=1630,
// labor 20, target 50 -> divisor .24 -> 1630/.24 = 6791.67 -> nearest $5 6790.
// budgeted: labor 1358, std comm 407.4, gp = 6790-(1630+1358+407.4) = 3394.6.
{
  const systemTypes = [{ id: 'std', labor_budget_pct: 20 }];
  const areas = [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake' }];
  const base = { areas, productsById, recipeSlotsBySystemType, defaultBasecoatByFlake, systemTypes, laborRate: 50, commissionPct: 6, targetGpPct: 50 };
  const owner = computeEstimatePricing({ ...base, actualCommissionPct: 0 }); // Dylan 0%
  const aron = computeEstimatePricing({ ...base, actualCommissionPct: 6 });  // Aron 6%
  assertEq(owner.price, 6790, 'pricing: standard-rate price (6790)');
  assertEq(owner.price, aron.price, 'pricing: price identical for actual 0% vs 6% (rep-independent quote)');
  assertEq(owner.commissionDollars, 407.4, 'pricing: budgeted commission = standard 6% of price (both reps)');
  assertEq(owner.gpDollars, 3394.6, 'pricing: budgeted GP is the standard-rate GP (both reps)');
  // Owner at 0%: pays no commission, so the budgeted 6% becomes extra realized GP.
  assertEq(owner.commissionPayout, 0, 'pricing: 0% rep payout is 0');
  assertEq(owner.gpVariance, 407.4, 'pricing: gpVariance = (6-0)% * price for the owner');
  assertEq(owner.realizedGp, 3802, 'pricing: realized GP = budgeted + variance (3394.6 + 407.4)');
  // Aron at the standard rate: full payout, no variance.
  assertEq(aron.commissionPayout, 407.4, 'pricing: 6% rep payout = 6% * price');
  assertEq(aron.gpVariance, 0, 'pricing: standard-rate rep has no variance');
  assertEq(aron.realizedGp, aron.gpDollars, 'pricing: realized GP = budgeted for the standard-rate rep');
}

// --- computeEstimatePricing: missing-cost materials are flagged ---------------
// A selected product with no unit_cost is NOT counted in M (understated price),
// so the engine surfaces it for a UI warning instead of silently underpricing.
{
  const productsNullCost = {
    ...productsById,
    flakeNoCost: { id: 'flakeNoCost', name: 'Domino (uncosted)', material_type: 'Flake', supplier: 'Simiron', color: 'Domino', spread_rate: 350, kit_size: 1, unit_cost: null },
  };
  const systemTypes = [{ id: 'std', labor_budget_pct: 20 }];
  const r = computeEstimatePricing({
    areas: [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flakeNoCost' }],
    productsById: productsNullCost, recipeSlotsBySystemType, defaultBasecoatByFlake,
    systemTypes, laborRate: 50, commissionPct: 6, targetGpPct: 50,
  });
  assertEq(r.materialsMissingCost.includes('Domino (uncosted)'), true, 'pricing: flags a selected material that has no unit_cost');
  assertEq(r.error, null, 'pricing: still prices (on partial cost) but flags the gap');
}

// --- computeEstimatePricing: divisor guard (target mathematically impossible)
{
  const systemTypes = [{ id: 'hi', labor_budget_pct: 30 }];
  const recipes = { hi: [
    { id: 'h1', order_index: 1, material_type: 'Basecoat', default_product_id: 'basecoat', required: true },
    { id: 'h2', order_index: 2, material_type: 'Flake',    default_product_id: null,        required: true },
    { id: 'h3', order_index: 3, material_type: 'Topcoat',  default_product_id: 'topcoat',   required: true },
  ] };
  const r = computeEstimatePricing({
    areas: [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'hi', flake_product_id: 'flake' }],
    productsById, recipeSlotsBySystemType: recipes, defaultBasecoatByFlake,
    systemTypes, laborRate: 50, commissionPct: 25, targetGpPct: 50, priceIncrement: 25,
  });
  // 1 - .30 - .25 - .50 = -0.05 -> impossible.
  assertEq(r.error, 'TARGET_UNREACHABLE', 'pricing: divisor <= 0 returns TARGET_UNREACHABLE');
  assertEq(r.price, undefined, 'pricing: no price emitted when target unreachable');
  assertEq(Number.isFinite(r.divisor), true, 'pricing: divisor is a finite number, never NaN/Infinity');
}

// --- computeEstimatePricing: materialLines deep-equal computeJobEstimate -----
// Wrap integrity: pricing must reuse the exact material plan, not a second copy.
{
  const systemTypes = [{ id: 'std', labor_budget_pct: 20 }];
  const areas = [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake' }];
  const r = computeEstimatePricing({ areas, productsById, recipeSlotsBySystemType, defaultBasecoatByFlake, systemTypes, laborRate: 50, commissionPct: 8, targetGpPct: 50 });
  const est = computeJobEstimate({ areas, productsById, recipeSlotsBySystemType, defaultBasecoatByFlake, systemTypes, revenue: 0, laborRate: 50 });
  assertEq(r.materialLines, est.materialLines, 'pricing materialLines == computeJobEstimate lines (one source)');
}

// --- computeEstimatePricing: per-system target_gp override; commission is NOT
// per-system (it is the salesperson's rate passed in). A stray commission_pct
// on the system row must be IGNORED.
{
  const systemTypes = [{ id: 'std', labor_budget_pct: 20, target_gp_pct: 55, commission_pct: 99 }];
  const areas = [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake' }];
  const r = computeEstimatePricing({ areas, productsById, recipeSlotsBySystemType, defaultBasecoatByFlake, systemTypes, laborRate: 50, commissionPct: 6, targetGpPct: 50 });
  assertEq(r.targetGpPct, 55, 'pricing: per-system target_gp_pct overrides global');
  assertEq(r.commissionPct, 6, 'pricing: commission output is the standard rate; system commission_pct ignored');
  // divisor = 1 - .20 - .06 - .55 = .19; priceRaw = 1630/.19 = 8578.95 -> nearest $5 8580
  assertEq(r.price, 8580, 'pricing: price uses overridden target + standard commission');
  assertEq(r.gpPct >= 0.55, true, 'pricing: budgeted GP% >= overridden target');
}

// --- computeEstimatePricing: standard 0% commission (no commission budgeted) --
{
  const systemTypes = [{ id: 'std', labor_budget_pct: 20 }];
  const areas = [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake' }];
  const r = computeEstimatePricing({ areas, productsById, recipeSlotsBySystemType, defaultBasecoatByFlake, systemTypes, laborRate: 50, commissionPct: 0, targetGpPct: 50 });
  assertEq(r.commissionDollars, 0, 'pricing: standard 0% -> no commission budgeted in the price');
  // divisor = 1 - .20 - 0 - .50 = .30; priceRaw = 1630/.30 = 5433.33 -> nearest $5 5435 (435 above 5000 > band)
  assertEq(r.price, 5435, 'pricing: standard-0% price');
}

// --- computeEstimatePricing: planError passes through, no price ---------------
{
  const r = computeEstimatePricing({
    areas: [{ id: 'a1', name: 'Bad', sqft: 100, system_type_id: 'badSystem' }],
    productsById, recipeSlotsBySystemType, defaultBasecoatByFlake,
    systemTypes: [{ id: 'badSystem', labor_budget_pct: 20 }], laborRate: 50, commissionPct: 8, targetGpPct: 50,
  });
  assertEq(typeof r.error === 'string' && /spread_rate/i.test(r.error), true, 'pricing: planError (bad spread_rate) surfaced as error');
  assertEq(r.price, undefined, 'pricing: no price when the material plan is broken');
}

// --- Swatch slot WITH a default prices as a real line, not a $0 placeholder --
// 2026-07-12 fix: an unpicked flake used to price as $0 (placeholder) because
// the prod Flake slot had no default_product_id. With a default set (the
// "Standard Flake (color TBD)" placeholder product), planForArea resolves
// pick || default and the flake COST lands in M while the color stays TBD.
{
  const slotsWithFlakeDefault = {
    std: [
      { id: 's1', order_index: 1, material_type: 'Basecoat', default_product_id: 'basecoat', required: true },
      { id: 's2', order_index: 2, material_type: 'Flake',    default_product_id: 'flake',    required: true },
      { id: 's3', order_index: 3, material_type: 'Topcoat',  default_product_id: 'topcoat',  required: true },
    ],
  };
  // NO picks at all: the area carries only sqft + system.
  const areas = [{ id: 'a1', name: 'Garage', sqft: 600, system_type_id: 'std' }];
  const plan = computeMaterialPlan({ areas, productsById, recipeSlotsBySystemType: slotsWithFlakeDefault, defaultBasecoatByFlake });
  assertEq(plan.lines.filter((l) => l.product_id == null).length, 0, 'flake default: no $0 placeholder line');
  const flakeLine = plan.lines.find((l) => l.material_type === 'Flake');
  assertEq(flakeLine.qty_needed, 2, 'flake default: real qty from the default product');
  assertEq(flakeLine.line_cost, 190, 'flake default: flake cost counted in the plan');
  const r = computeEstimatePricing({
    areas, productsById, recipeSlotsBySystemType: slotsWithFlakeDefault, defaultBasecoatByFlake,
    systemTypes: [{ id: 'std', labor_budget_pct: 20 }], laborRate: 50, commissionPct: 8, targetGpPct: 50,
  });
  assertEq(r.error, null, 'no-picks estimate: prices without any selection (system + sqft alone)');
  assertEq(r.materialsCost, 1630, 'no-picks estimate: M identical to the fully-picked plan');
}

// --- Prod reference job: 1000 sqft Standard Flake at the 52% flake target ----
// Mirrors the LIVE catalog after the 2026-07-12 migration: basecoat 144.27/
// 150/3kit, flake TBD 87.44/325/1, topcoat 132/120/2kit, labor 15, standard
// commission 6, per-system target_gp_pct 52. M = 3*144.27 + 4*87.44 + 5*132
// = 1442.57; divisor = 1 - .15 - .06 - .52 = .27; 1442.57/.27 = 5342.85 ->
// nearest $5 = 5345 (345 above the 5000 charm threshold > 250 band, no charm).
// This is the price-sheet anchor: Aron sells 1000 sqft garages at $5,000-5,500.
{
  const prodProducts = {
    bc:  { id: 'bc',  name: 'Simiron 1100 SL - Light Gray',   material_type: 'Basecoat', spread_rate: 150, kit_size: 3, unit_cost: 144.27 },
    fl:  { id: 'fl',  name: 'Standard Flake (color TBD)',     material_type: 'Flake',    spread_rate: 325, kit_size: 1, unit_cost: 87.44 },
    tc:  { id: 'tc',  name: 'Simiron Polyaspartic 2gal Kit',  material_type: 'Topcoat',  spread_rate: 120, kit_size: 2, unit_cost: 132 },
  };
  const prodSlots = { flake: [
    { id: 'p1', order_index: 1, material_type: 'Basecoat', default_product_id: 'bc', required: true },
    { id: 'p2', order_index: 2, material_type: 'Flake',    default_product_id: 'fl', required: true },
    { id: 'p3', order_index: 3, material_type: 'Topcoat',  default_product_id: 'tc', required: true },
  ] };
  const r = computeEstimatePricing({
    areas: [{ id: 'a1', name: 'Garage', sqft: 1000, system_type_id: 'flake' }],
    productsById: prodProducts, recipeSlotsBySystemType: prodSlots, defaultBasecoatByFlake: {},
    systemTypes: [{ id: 'flake', labor_budget_pct: 15, target_gp_pct: 52 }],
    laborRate: 50, commissionPct: 6, targetGpPct: 50,
  });
  assertEq(r.error, null, 'reference job: prices clean');
  assertEq(r.materialsCost, 1442.57, 'reference job: M = 1442.57 (kits rounded up)');
  assertEq(r.price, 5345, 'reference job: 1000 sqft flake at 52% GP = $5,345 (price-sheet anchor)');
  assertEq(Math.abs(r.gpPct - 0.52) < 0.005, true, 'reference job: budgeted GP within half a point of 52%');
}

// --- Multi-system estimates (2026-07-13): per-area system + weighted rates ---
// Two areas, two systems: the garage prices off the flake recipe, the patio
// off the quartz recipe, and labor % / target GP are the sqft-weighted
// averages of the two systems (NOT areas[0]'s system, NOT a naive mean).
{
  const products = {
    fbc: { id: 'fbc', name: 'Flake Base',   material_type: 'Basecoat', spread_rate: 100, kit_size: 1, unit_cost: 100 },
    qbc: { id: 'qbc', name: 'Quartz Base',  material_type: 'Basecoat', spread_rate: 100, kit_size: 1, unit_cost: 200 },
  };
  const slots = {
    flake:  [{ id: 'f1', order_index: 1, material_type: 'Basecoat', default_product_id: 'fbc', required: true }],
    quartz: [{ id: 'q1', order_index: 1, material_type: 'Basecoat', default_product_id: 'qbc', required: true }],
  };
  const systems = [
    { id: 'flake',  labor_budget_pct: 15, target_gp_pct: 52 },
    { id: 'quartz', labor_budget_pct: 25, target_gp_pct: null }, // null -> global 50
  ];
  const r = computeEstimatePricing({
    areas: [
      { id: 'g', name: 'Garage', sqft: 600, system_type_id: 'flake' },
      { id: 'p', name: 'Patio',  sqft: 200, system_type_id: 'quartz' },
    ],
    productsById: products, recipeSlotsBySystemType: slots, defaultBasecoatByFlake: {},
    systemTypes: systems, laborRate: 50, commissionPct: 6, targetGpPct: 50,
    charmThreshold: 0, charmBand: 0, priceIncrement: 1,
  });
  assertEq(r.error, null, 'mixed systems: prices clean');
  // Each area used its OWN recipe: 6 flake-base kits @100 + 2 quartz-base @200.
  assertEq(r.materialsCost, 600 / 100 * 100 + 200 / 100 * 200, 'mixed systems: each area priced with its own recipe (M = 600 + 400)');
  // Weighted labor = (600*15 + 200*25)/800 = 17.5; weighted GP = (600*52 + 200*50)/800 = 51.5.
  assertEq(r.laborPct, 17.5, 'mixed systems: labor % is the sqft-weighted average');
  assertEq(r.targetGpPct, 51.5, 'mixed systems: target GP is the sqft-weighted average');
  // Solve: 1000 / (1 - .175 - .06 - .515) = 1000 / .25 = 4000.
  assertEq(r.price, 4000, 'mixed systems: closed form solves on the weighted divisor');
  assertEq(Math.abs(r.gpPct - 0.515) < 1e-9, true, 'mixed systems: realized GP equals the weighted target');
  // Hours come from the weighted labor budget: .175 * 4000 / 50 = 14.
  assertEq(r.budgetedHours, 14, 'mixed systems: budgeted hours use the weighted labor fraction');

  // A single-system estimate still prices exactly as before (regression: the
  // 1000 sqft flake anchor above already pins this; here the weighted path
  // degenerates to the one system's own numbers).
  const solo = computeEstimatePricing({
    areas: [{ id: 'g', name: 'Garage', sqft: 600, system_type_id: 'flake' }],
    productsById: products, recipeSlotsBySystemType: slots, defaultBasecoatByFlake: {},
    systemTypes: systems, laborRate: 50, commissionPct: 6, targetGpPct: 50,
    charmThreshold: 0, charmBand: 0, priceIncrement: 1,
  });
  assertEq(solo.laborPct, 15, 'single system: weighted labor degenerates to the system value');
  assertEq(solo.targetGpPct, 52, 'single system: weighted target degenerates to the system value');

  // ANY area whose system is missing labor_budget_pct blocks the solve (the
  // old code only checked areas[0]'s system).
  const noLabor = computeEstimatePricing({
    areas: [
      { id: 'g', name: 'Garage', sqft: 600, system_type_id: 'flake' },
      { id: 'x', name: 'Patio',  sqft: 200, system_type_id: 'nolabor' },
    ],
    productsById: products, recipeSlotsBySystemType: { ...slots, nolabor: slots.quartz },
    defaultBasecoatByFlake: {},
    systemTypes: [...systems, { id: 'nolabor', labor_budget_pct: null }],
    laborRate: 50, commissionPct: 6, targetGpPct: 50,
  });
  assertEq(noLabor.error, 'NO_LABOR_PCT', 'mixed systems: any area missing labor % blocks the solve');
}

// --- Line-item money rules (add-ons / one-offs) -------------------------------
{
  const items = [
    { id: '1', label: 'Stem walls',  qty: 40, unit_price: 10, unit_cost: 4, total: 400, is_optional: true,  selected_by_customer: false },
    { id: '2', label: 'Drive time',  qty: 2,  unit_price: 75, unit_cost: 50, total: 150, is_optional: false, selected_by_customer: false },
    { id: '3', label: 'No-cost upsell', qty: 1, unit_price: 300, unit_cost: 0, total: 300, is_optional: false, selected_by_customer: false },
  ];
  assertEq(lineItemsTotal(items), 450, 'optional add-on EXCLUDED from the total until selected');
  assertEq(lineItemsTotal(items, { withAllOptions: true }), 850, 'all-options total includes the unselected optional');
  const selected = items.map((li) => (li.id === '1' ? { ...li, selected_by_customer: true } : li));
  assertEq(lineItemsTotal(selected), 850, 'selecting the optional moves it into the total');
  // GP at 6% commission: drive time 150 - 100 - 9 = 41; no-cost 300 - 0 - 18 =
  // 282 (a costless add-on inflates GP, which is the catalog-cost argument).
  assertEq(lineItemsGp(items, 6), 323, 'line GP counts only included lines, net of cost and commission');
  const costed = items.map((li) => (li.id === '3' ? { ...li, unit_cost: 120 } : li));
  assertEq(lineItemsGp(costed, 6), 203, 'setting the add-on cost pulls GP down (no more inflation)');
  assertEq(lineItemsGp(selected, 6), 323 + (400 - 160 - 24), 'selected optional contributes its GP too');
  // Legacy jsonb shape (optional key) still honors the exclusion rule.
  assertEq(lineItemsTotal([{ optional: true, selected_by_customer: false, total: 99 }]), 0, 'legacy jsonb optional shape still excluded');
}

// --- allocateProportionally: parts always sum exactly to the total -----------
{
  assertEq(allocateProportionally(100, [1, 1, 1]), [33.33, 33.33, 33.34], 'allocation: last positive weight absorbs the rounding remainder');
  assertEq(allocateProportionally(5345, [600, 200]).reduce((s, p) => s + p, 0), 5345, 'allocation: sums exactly to the total');
  assertEq(allocateProportionally(500, [0, 0]), [500, 0], 'allocation: all-zero weights put everything on the first part');
  assertEq(allocateProportionally(500, [300, 0]), [500, 0], 'allocation: zero-weight parts get nothing');
}

// --- Comps GP% math (15c): materials counted ONCE + completeness note --------
{
  // The regression that would appear the DAY Dylan backfills: with both
  // materials_ordered_cost AND materials_used_cost populated, the old code
  // summed both and understated GP. Now materials count once (used wins).
  const price = 10000;
  const bothMaterials = { materials_ordered_cost: 2000, materials_used_cost: 2500, salary_wages_cost: 1500 };
  // used(2500) + labor(1500) = 4000 -> GP = (10000-4000)/10000 = 0.60.
  assertEq(actualGpPct(price, bothMaterials), 0.6, 'materials counted ONCE (used wins over ordered), not summed');
  assertEq(costingMaterials(bothMaterials), 2500, 'costingMaterials prefers used when > 0');
  assertEq(costingMaterials({ materials_ordered_cost: 2000, materials_used_cost: 0 }), 2000, 'costingMaterials falls back to ordered when used is 0');

  // The prod reality today: wages only, no materials. GP still computes (Dylan
  // chose to keep the number), but it is NOT complete.
  const wagesOnly = { salary_wages_cost: 1000 };
  assertEq(actualGpPct(price, wagesOnly), 0.9, 'wages-only row still yields a (too-high) GP, not null');
  assertEq(costingComplete(wagesOnly), false, 'wages-only row is NOT complete (no materials)');
  assertEq(costingComplete(bothMaterials), true, 'materials + labor row IS complete');
  assertEq(costingComplete({ materials_used_cost: 500 }), false, 'materials-only row is NOT complete (no labor)');
  assertEq(actualGpPct(price, { equipment_rental_cost: 0 }), null, 'an all-zero costing row yields null (no false 100% GP)');
  assertEq(actualGpPct(price, null), null, 'no costing row yields null');
}

// --- Comps completeness note counts materials AND labor ----------------------
{
  const now = Date.parse('2026-07-13');
  const day = (d) => new Date(now - d * 86400000).toISOString();
  const jobs = [
    { id: 'j1', customer_name: 'A', system_type_id: 'flake', sqft: '600', price: 6000, completed_date: day(10), dripjobs_deal_id: 'd1' },
    { id: 'j2', customer_name: 'B', system_type_id: 'flake', sqft: '650', price: 6500, completed_date: day(20), dripjobs_deal_id: 'd2' },
    { id: 'j3', customer_name: 'C', system_type_id: 'flake', sqft: '700', price: 7000, completed_date: day(30), dripjobs_deal_id: 'd3' },
  ];
  const prodJobs = [ { id: 'p1', dripjobs_deal_id: 'd1' }, { id: 'p2', dripjobs_deal_id: 'd2' }, { id: 'p3', dripjobs_deal_id: 'd3' } ];
  const costings = [
    { job_id: 'p1', materials_used_cost: 1000, salary_wages_cost: 900 }, // complete
    { job_id: 'p2', salary_wages_cost: 800 },                            // wages only
    // p3: no costing row at all
  ];
  const candidates = joinCompsSources(jobs, prodJobs, costings);
  assertEq(candidates.find(c => c.id === 'j1').gp_complete, true, 'j1 complete (materials + labor)');
  assertEq(candidates.find(c => c.id === 'j2').gp_complete, false, 'j2 not complete (wages only)');
  assertEq(candidates.find(c => c.id === 'j3').gp_complete, false, 'j3 not complete (no costing)');
  const comps = buildComps({ candidates, systemTypeId: 'flake', sqft: 650, now });
  assertEq(comps.sample_size, 3, 'all three flake jobs are comps');
  assertEq(comps.complete_count, 1, 'exactly one comp has complete costing');
  assertEq(comps.gp_pct_count, 2, 'two comps have any GP% (j3 has no costing)');
  assertEq(compsGpCaveat(comps), 'GP% from job costing; 1 of 3 comps have materials costed', 'caveat names the completeness honestly');
  // No GP% at all -> no caveat (nothing to qualify).
  const noCost = buildComps({ candidates: joinCompsSources(jobs, [], []), systemTypeId: 'flake', sqft: 650, now });
  assertEq(compsGpCaveat(noCost), null, 'no caveat when no comp carries a GP%');
}

// --- Commission flows into comps GP (2026-07-14) -----------------------------
// A completed job sold by a 6% rep, once its costing row carries the derived
// commission (revenue x rate, set by the pec_costing_set_commission trigger),
// shows a GP net of that commission. This is the number that was reading ~30
// points high while commission_cost sat at 0. actualGpPct reads the column, so
// the same math the trigger applies is what the comps panel now reflects.
{
  const price = 3900; // Aron's Brian Wirick job
  const noCommission = { materials_used_cost: 900, salary_wages_cost: 386, commission_cost: 0 };
  const withCommission = { materials_used_cost: 900, salary_wages_cost: 386, commission_cost: 234 }; // 6% of 3900
  const gpBefore = actualGpPct(price, noCommission);
  const gpAfter = actualGpPct(price, withCommission);
  // (3900 - 900 - 386) / 3900 = 0.6702...; with commission (3900 - 900 - 386 - 234) / 3900 = 0.6103...
  assertEq(Math.round(gpBefore * 10000) / 10000, 0.6703, 'GP without commission (the old, too-high number)');
  assertEq(Math.round(gpAfter * 10000) / 10000, 0.6103, 'GP once the 6% commission is counted');
  assertEq(gpAfter < gpBefore, true, 'counting commission lowers the reported GP');
  assertEq(Math.round((gpBefore - gpAfter) * price), 234, 'the GP drop equals the commission dollars (6% of 3900)');
}

// --- CALC_VERSION is exported (mirror-drift guard) ---------------------------
// The inline copy in index.html must carry the SAME CALC_VERSION. This asserts
// the canonical value exists and is a non-empty string so the mirror check has
// something to compare against.
assertEq(typeof CALC_VERSION === 'string' && CALC_VERSION.length > 0, true, 'CALC_VERSION is a non-empty string');

// ----------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
