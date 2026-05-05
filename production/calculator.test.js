// Self-asserting Node script. No framework. Run with `npm test` or
// `node production/calculator.test.js`. Exits non-zero on the first failure.
//
// Covers every edge case called out in the spec plus a multi-area sanity check.

import { computeMaterialPlan, CalculatorError } from './calculator.js';

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

// --- Missing required product (flake not picked) ---------------------------
assertThrows(() => {
  computeMaterialPlan({
    areas: [{ id: 'a1', name: 'NoFlake', sqft: 600, system_type_id: 'std' }],
    productsById,
    recipeSlotsBySystemType,
    defaultBasecoatByFlake,
  });
}, 'MISSING_PRODUCT', 'missing required Flake selection rejected');

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

// ----------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
