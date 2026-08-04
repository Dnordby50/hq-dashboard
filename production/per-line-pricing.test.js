// Prompt 69: per-line pricing tests. Self-asserting Node script, same harness
// style as calculator.test.js. Run with `npm test` or
// `node production/per-line-pricing.test.js`.
//
// The two load-bearing invariants:
//   1. SINGLE-AREA IDENTITY: computePerLinePricing on one area returns the
//      exact price computeEstimatePricing returns for the same inputs, to the
//      cent, across sqft / target / sundries / charm / increment variations.
//      If this breaks, the material attribution or the divisor is wrong.
//   2. THE MERGE TRAP: materials kit-round ACROSS areas, so the per-line total
//      must come from ONE estimate-wide plan attributed back to areas, never
//      from solving each area alone (which double-buys shared kits).

import {
  computeEstimatePricing,
  computePerLinePricing,
  customLinePricing,
  applyLineSellPrice,
  allocateProportionally,
  roundEstimatePrice,
} from './calculator.js';

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

const near = (a, b, eps = 0.011) => Math.abs(Number(a) - Number(b)) <= eps;

// ----------------------------------------------------------------------------
// Fixtures: same catalog shape as calculator.test.js, two systems with
// DIFFERENT labor budgets and target GPs so a mixed estimate exercises the
// per-system solve.
// ----------------------------------------------------------------------------
const productsById = {
  basecoat: { id: 'basecoat', name: 'Simiron 1100 SL - Tinted Gray', material_type: 'Basecoat', supplier: 'Simiron', color: 'Tinted Gray', spread_rate: 150, kit_size: 3, unit_cost: 240 },
  flake:    { id: 'flake',    name: 'Decorative Simiron Flake - Domino', material_type: 'Flake', supplier: 'Simiron', color: 'Domino', spread_rate: 350, kit_size: 1, unit_cost: 95 },
  topcoat:  { id: 'topcoat',  name: 'Polyaspartic Clear Gloss', material_type: 'Topcoat', supplier: 'Simiron', color: 'Clear Gloss', spread_rate: 120, kit_size: 2, unit_cost: 320 },
  quartz:   { id: 'quartz',   name: 'Quartz Blend - Storm', material_type: 'Quartz', supplier: 'Torginol', color: 'Storm', spread_rate: 40, kit_size: 1, unit_cost: 60 },
  nocost:   { id: 'nocost',   name: 'Unpriced Sealer', material_type: 'Topcoat', supplier: 'X', color: null, spread_rate: 200, kit_size: 1, unit_cost: null },
};

const recipeSlotsBySystemType = {
  std: [
    { id: 's1', order_index: 1, material_type: 'Basecoat', default_product_id: 'basecoat', required: true },
    { id: 's2', order_index: 2, material_type: 'Flake',    default_product_id: 'flake',    required: true },
    { id: 's3', order_index: 3, material_type: 'Topcoat',  default_product_id: 'topcoat',  required: true },
  ],
  qz: [
    { id: 'q1', order_index: 1, material_type: 'Basecoat', default_product_id: 'basecoat', required: true },
    { id: 'q2', order_index: 2, material_type: 'Quartz',   default_product_id: 'quartz',   required: true },
    { id: 'q3', order_index: 3, material_type: 'Topcoat',  default_product_id: 'topcoat',  required: true },
  ],
  nolabor: [
    { id: 'n1', order_index: 1, material_type: 'Topcoat', default_product_id: 'topcoat', required: true },
  ],
  uncostable: [
    { id: 'u1', order_index: 1, material_type: 'Topcoat', default_product_id: 'nocost', required: true },
  ],
};

const systemTypes = [
  { id: 'std',        name: 'Standard Flake', labor_budget_pct: 30, target_gp_pct: null },
  { id: 'qz',         name: 'Quartz',         labor_budget_pct: 24, target_gp_pct: 55 },
  { id: 'nolabor',    name: 'No Labor Pct',   labor_budget_pct: null, target_gp_pct: null },
  { id: 'uncostable', name: 'Unpriced',       labor_budget_pct: 30, target_gp_pct: null },
  { id: 'greedy',     name: 'Greedy',         labor_budget_pct: 45, target_gp_pct: 60 },
];
recipeSlotsBySystemType.greedy = recipeSlotsBySystemType.std;

const baseInput = {
  productsById,
  recipeSlotsBySystemType,
  defaultBasecoatByFlake: { flake: 'basecoat' },
  systemTypes,
  laborRate: 50,
  commissionPct: 6,
  targetGpPct: 50,
  sundriesPct: 2,
  priceIncrement: 5,
  charmThreshold: 1000,
  charmBand: 250,
};

console.log('per-line-pricing.test.js');

// --- 1. SINGLE-AREA IDENTITY over varied fixtures ---------------------------
{
  const fixtures = [
    { label: '600 sqft std, defaults', area: { id: 'a', name: 'Garage', sqft: 600, system_type_id: 'std', flake_product_id: 'flake' }, over: {} },
    { label: '287 sqft std, odd sqft', area: { id: 'a', name: 'Patio', sqft: 287, system_type_id: 'std', flake_product_id: 'flake' }, over: {} },
    { label: '1450 sqft qz, per-system target 55', area: { id: 'a', name: 'Shop', sqft: 1450, system_type_id: 'qz', flake_product_id: 'quartz' }, over: {} },
    { label: '900 sqft std, no sundries, $1 increment, no charm', area: { id: 'a', name: 'Garage', sqft: 900, system_type_id: 'std', flake_product_id: 'flake' }, over: { sundriesPct: 0, priceIncrement: 1, charmThreshold: 0, charmBand: 0 } },
    { label: '2200 sqft std, charm band wide', area: { id: 'a', name: 'Warehouse', sqft: 2200, system_type_id: 'std', flake_product_id: 'flake' }, over: { charmBand: 400 } },
    { label: '75 sqft qz, tiny job', area: { id: 'a', name: 'Bath', sqft: 75, system_type_id: 'qz', flake_product_id: 'quartz' }, over: {} },
  ];
  for (const f of fixtures) {
    const input = { ...baseInput, ...f.over, areas: [f.area] };
    const old = computeEstimatePricing(input);
    const per = computePerLinePricing(input);
    assertEq(per.error, null, `identity: ${f.label} - no error`);
    assertEq(per.price, old.price, `identity: ${f.label} - price identical to the cent`);
    assertEq(per.priceRaw, old.priceRaw, `identity: ${f.label} - priceRaw identical`);
    assertEq(per.gpDollars, old.gpDollars, `identity: ${f.label} - gpDollars identical`);
    assertEq(per.materialsCost, old.materialsCost, `identity: ${f.label} - M identical`);
    assertEq(per.lines.length, 1, `identity: ${f.label} - one line`);
    assertEq(per.lines[0].price, old.price, `identity: ${f.label} - the line IS the price`);
  }
}

// --- 2. The merge trap: shared kits are bought once, attribution sums to M --
{
  // Two areas on the SAME system: each needs 200/150/3 = 0.44 kits of
  // basecoat; merged they need ceil(400/450) = 1 kit, not 2. A naive
  // solve-each-area-alone would price ceil(0.44)=1 kit into EACH area
  // (2 kits of basecoat, 2 boxes of flake, 2x2 topcoat kits).
  const areas = [
    { id: 'a1', name: 'Bay 1', sqft: 200, system_type_id: 'std', flake_product_id: 'flake' },
    { id: 'a2', name: 'Bay 2', sqft: 200, system_type_id: 'std', flake_product_id: 'flake' },
  ];
  const input = { ...baseInput, areas, charmThreshold: 0, charmBand: 0, priceIncrement: 1 };
  const per = computePerLinePricing(input);
  const old = computeEstimatePricing(input);
  assertEq(per.error, null, 'merge trap: prices without error');
  // Identical systems -> the weighted divisor equals the per-line divisor, so
  // the per-line total must equal the old estimate-wide solve (same M, same
  // divisor; only increment rounding differs, neutralized at $1/no-charm).
  assertEq(near(per.price, old.price, 2), true, `merge trap: same-system 2-area total tracks the single solve (${per.price} vs ${old.price})`);
  assertEq(per.materialsCost, old.materialsCost, 'merge trap: ONE estimate-wide M (shared kit bought once)');
  const naiveSolo = ['a1', 'a2'].map((_, i) =>
    computeEstimatePricing({ ...input, areas: [areas[i]] }).price
  ).reduce((s, p) => s + p, 0);
  assertEq(per.price < naiveSolo, true, `merge trap: per-line total ${per.price} < naive per-area sum ${naiveSolo} (no double-bought kits)`);
  const attributed = per.lines.reduce((s, l) => s + l.materialsCost, 0);
  assertEq(near(attributed, per.materialsCost, 0.011), true, 'merge trap: per-line material attribution sums to M exactly');
  // Equal areas, equal recipes -> equal halves.
  assertEq(per.lines[0].materialsCost, per.lines[1].materialsCost, 'merge trap: equal areas split M equally');
}

// --- 3. Mixed systems: each line hits ITS OWN target GP ---------------------
{
  const areas = [
    { id: 'a1', name: 'Garage', sqft: 1000, system_type_id: 'std', flake_product_id: 'flake' },
    { id: 'a2', name: 'Shop',   sqft: 400,  system_type_id: 'qz',  flake_product_id: 'quartz' },
  ];
  const per = computePerLinePricing({ ...baseInput, areas, charmThreshold: 0, charmBand: 0, priceIncrement: 1 });
  assertEq(per.error, null, 'mixed: prices without error');
  assertEq(per.lines.length, 2, 'mixed: two lines');
  assertEq(per.lines[0].targetGpPct, 50, 'mixed: std line targets the global 50');
  assertEq(per.lines[1].targetGpPct, 55, 'mixed: quartz line targets its own 55');
  // At the RAW price each line's GP fraction equals its own target (the
  // closed form's defining property); rounding to $1 moves it by pennies.
  for (const l of per.lines) {
    const gpAtRaw = l.priceRaw - (l.materialsCost + (l.laborPct / 100) * l.priceRaw + 0.06 * l.priceRaw
      + 0.02 * (l.materialsCost + (l.laborPct / 100) * l.priceRaw + 0.06 * l.priceRaw));
    assertEq(near(gpAtRaw / l.priceRaw, l.targetGpPct / 100, 0.0005), true,
      `mixed: line "${l.name}" hits its own ${l.targetGpPct}% target at the raw price`);
  }
  assertEq(per.price, per.lines[0].price + per.lines[1].price, 'mixed: job total = sum of the lines');
  assertEq(per.gpDollars, Math.round((per.lines[0].gpDollars + per.lines[1].gpDollars) * 100) / 100, 'mixed: job GP$ = sum of line GP$');
}

// --- 4. Errors name the offending area --------------------------------------
{
  const bad = computePerLinePricing({
    ...baseInput,
    areas: [
      { id: 'a1', name: 'Garage', sqft: 500, system_type_id: 'std', flake_product_id: 'flake' },
      { id: 'a2', name: 'Mystery', sqft: 100, system_type_id: 'nolabor' },
    ],
  });
  assertEq(bad.error, 'NO_LABOR_PCT', 'missing labor pct errors');
  assertEq(bad.errorArea, 'Mystery', 'NO_LABOR_PCT names the area');

  const greedy = computePerLinePricing({
    ...baseInput,
    areas: [
      { id: 'a1', name: 'Garage', sqft: 500, system_type_id: 'std', flake_product_id: 'flake' },
      { id: 'a2', name: 'Impossible', sqft: 100, system_type_id: 'greedy', flake_product_id: 'flake' },
    ],
  });
  assertEq(greedy.error, 'TARGET_UNREACHABLE', 'divisor <= 0 errors instead of dividing');
  assertEq(greedy.errorArea, 'Impossible', 'TARGET_UNREACHABLE names the area');
}

// --- 5. Missing-cost materials flagged, not silently zero-priced -------------
{
  const r = computePerLinePricing({
    ...baseInput,
    areas: [{ id: 'a1', name: 'Sealcoat', sqft: 400, system_type_id: 'uncostable' }],
  });
  assertEq(r.error, null, 'missing-cost still prices');
  assertEq(r.materialsMissingCost, ['Unpriced Sealer'], 'missing-cost product is flagged');
}

// --- 6. Fixed add-ons allocate without loss ----------------------------------
{
  const areas = [
    { id: 'a1', name: 'Garage', sqft: 1000, system_type_id: 'std', flake_product_id: 'flake' },
    { id: 'a2', name: 'Shop',   sqft: 400,  system_type_id: 'qz',  flake_product_id: 'quartz' },
  ];
  const r = computePerLinePricing({ ...baseInput, areas, fixedAddons: 250 });
  assertEq(r.error, null, 'fixed add-ons price without error');
  const fSum = r.lines.reduce((s, l) => s + l.fixedAddons, 0);
  assertEq(near(fSum, 250, 0.011), true, `fixed add-ons attributed without loss (${fSum})`);
}

// --- 7. customLinePricing: the typed-cost GP shape ---------------------------
{
  const c = customLinePricing({ price: 2000, materialCost: 300, laborHours: 8, laborRate: 50, commissionPct: 6, sundriesPct: 2 });
  // labor = 8*50 = 400; commission = 120; sundries = 2% of (300+400+120) = 16.4
  assertEq(c.laborDollars, 400, 'custom: labor = hours x rate');
  assertEq(c.commissionDollars, 120, 'custom: commission = 6% of typed price');
  assertEq(c.sundriesDollars, 16.4, 'custom: sundries on the cost stack');
  assertEq(c.gpDollars, Math.round((2000 - 300 - 400 - 120 - 16.4) * 100) / 100, 'custom: GP = price - all buckets');
  assertEq(near(c.gpPct, c.gpDollars / 2000), true, 'custom: GP% of typed price');
  assertEq(c.budgetedHours, 8, 'custom: typed hours are the budgeted hours');
  const empty = customLinePricing({ price: 0 });
  assertEq(empty.gpDollars, null, 'custom: no price -> null money, never NaN');
  const priceOnly = customLinePricing({ price: 1000, commissionPct: 6 });
  assertEq(priceOnly.gpDollars, 940, 'custom: costless line = price minus commission (the 100%-GP trap is visible, not hidden)');
}

// --- 8. applyLineSellPrice agrees with the solve at the solved price ---------
{
  const areas = [
    { id: 'a1', name: 'Garage', sqft: 1000, system_type_id: 'std', flake_product_id: 'flake' },
    { id: 'a2', name: 'Shop',   sqft: 400,  system_type_id: 'qz',  flake_product_id: 'quartz' },
  ];
  const per = computePerLinePricing({ ...baseInput, areas });
  const l = per.lines[0];
  const at = applyLineSellPrice(l, l.price, { commissionPct: 6, sundriesPct: 2, laborRate: 50 });
  assertEq(at.gpDollars, l.gpDollars, 'line sell at solved price: identical GP$');
  assertEq(at.laborDollars, l.laborDollars, 'line sell at solved price: identical labor$');
  assertEq(at.sundriesDollars, l.sundriesDollars, 'line sell at solved price: identical sundries');
  const cut = applyLineSellPrice(l, l.price - 500, { commissionPct: 6, sundriesPct: 2, laborRate: 50 });
  assertEq(cut.gpDollars < l.gpDollars, true, 'discounting a line lowers its GP$');
  assertEq(cut.gpPct < l.gpPct, true, 'discounting a line lowers its GP%');
}

// --- 9. Job-level discount allocation exactness (3-line mixed estimate) ------
{
  // The estimator's rule: a typed job sell price allocates across the lines
  // weighted by their current prices, and the parts sum to the typed number
  // to the cent. Proven here with a calculator line pair + one custom line.
  const areas = [
    { id: 'a1', name: 'Garage', sqft: 1000, system_type_id: 'std', flake_product_id: 'flake' },
    { id: 'a2', name: 'Shop',   sqft: 400,  system_type_id: 'qz',  flake_product_id: 'quartz' },
  ];
  const per = computePerLinePricing({ ...baseInput, areas });
  const linePrices = [per.lines[0].price, per.lines[1].price, 1500]; // + custom line
  const typedTotal = Math.round((linePrices[0] + linePrices[1] + 1500) * 0.9) - 0.07; // ugly cents on purpose
  const parts = allocateProportionally(typedTotal, linePrices);
  const sum = Math.round(parts.reduce((s, p) => s + p, 0) * 100) / 100;
  assertEq(sum, Math.round(typedTotal * 100) / 100, `discount allocation: parts (${parts.join(', ')}) sum to the typed total exactly`);
}

// --- 10. roundEstimatePrice is applied per line ------------------------------
{
  const areas = [
    { id: 'a1', name: 'Garage', sqft: 1000, system_type_id: 'std', flake_product_id: 'flake' },
    { id: 'a2', name: 'Shop', sqft: 400, system_type_id: 'qz', flake_product_id: 'quartz' },
  ];
  const per = computePerLinePricing({ ...baseInput, areas });
  for (const l of per.lines) {
    assertEq(l.price, roundEstimatePrice(l.priceRaw, { increment: 5, charmThreshold: 1000, charmBand: 250 }), `line "${l.name}" is increment/charm rounded`);
  }
}

// ----------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
