// PEC PM Module 1: Material calculator.
// Pure function. No I/O, no DB calls, no globals. Safe to import in browser
// and Node. Walks each Area's System Recipe and merges by product across
// areas so the same product (e.g., Tinted Gray basecoat used in two areas)
// shows up as one summed row.
//
// IMPORTANT: this file is the canonical source for `npm test`, but the
// browser dashboard inlines the same logic into index.html so it works under
// file:// (browsers block ESM imports for file:// origins). If you change
// anything here, mirror the change in the inline copy near the top of the
// production module's <script type="module"> block in index.html, then run
// `npm test`.
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

// Bumped whenever the estimate/pricing math changes. The inline mirror in
// index.html must carry the SAME value; a test asserts it so a drifted mirror
// is visible. Date-stamped so a mismatch points at which copy is stale.
export const CALC_VERSION = '2026-08-04.1';

/**
 * Round a raw cost-plus price to a clean, sell-able number.
 *
 * Two rules, both configurable from Settings:
 *   1. Round to the nearest `increment` (default $5).
 *   2. Charm-down near a big round number: if the price lands at or just above
 *      a multiple of `charmThreshold` (within `charmBand` above it), drop to
 *      that multiple minus one increment. So with threshold 1000 / band 250,
 *      a $5,150 price becomes $4,995 (Dylan's rule). This intentionally gives
 *      up a little margin for a more competitive, attractive price near a
 *      psychological threshold, so the realized GP can dip slightly below
 *      target when it fires (the displayed GP reflects the actual price).
 *
 * @param {number} priceRaw
 * @param {Object} [opts]
 * @param {number} [opts.increment=5]
 * @param {number} [opts.charmThreshold=0]  0 disables charm-pricing
 * @param {number} [opts.charmBand=0]       0 disables charm-pricing
 * @returns {number}
 */
export function roundEstimatePrice(priceRaw, { increment = 5, charmThreshold = 0, charmBand = 0 } = {}) {
  const inc = Number(increment) > 0 ? Number(increment) : 1;
  let price = Math.round(Number(priceRaw) / inc) * inc;  // nearest increment, round half up
  const T = Number(charmThreshold) || 0;
  const band = Number(charmBand) || 0;
  if (T > 0 && band > 0) {
    const lower = Math.floor(price / T) * T;  // nearest multiple of T at or below the price
    if (lower > 0 && price - lower <= band) {
      price = lower - inc;                    // charm price just under the threshold (e.g. 4995)
    }
  }
  return price;
}

// Cure speed lives on the area, not the line, but the per-line cure_speed
// snapshot has to know *which* area column to read. Two product families need
// it today: Simiron 1100 SL (Fast/Standard/Slow, written to basecoat_cure_speed
// because in every shipped recipe 1100 SL fills the basecoat slot) and the
// Polyaspartic family (Fast/Medium/Slow/XTRA Slow, written to topcoat_cure_speed).
// A line for a non-cure-speed product gets cure_speed=null.
export function cureSpeedSpec(product) {
  if (!product) return null;
  const name = String(product.name || '').toLowerCase();
  if (/^simiron\s*1100\s*sl\b/.test(name)) {
    return { areaField: 'basecoat_cure_speed', options: ['Fast', 'Standard', 'Slow'] };
  }
  if (/polyaspartic/.test(name)) {
    return { areaField: 'topcoat_cure_speed', options: ['Fast', 'Medium', 'Slow', 'XTRA Slow'] };
  }
  return null;
}

// Prompt 75 C2: blank cure speeds inherit the job's dominant cure speed at
// PLAN-INPUT time, so same-product lines merge on the pull's
// `${product_id}|${cure_speed}` SKU key instead of splitting into a phantom
// no-cure line (the Bryan Smith duplicate-topcoat bug). Per cure field
// (basecoat_cure_speed / topcoat_cure_speed): dominant = the most common
// non-null value across the job's areas, ties broken by the value carried on
// the lowest-order_index area (array position when order_index is absent).
// An area with an EXPLICIT cure keeps it, so two genuinely different cure
// speeds still make two lines; a job with no cure anywhere stays all-null.
// Deliberately NOT a SKU-key change: that key is load-bearing in
// aggregateMaterialPull, mergeRecalcLines, and the pull, and changing it
// would silently re-pair saved lines on the next Recalculate. Pure: returns
// new area objects, never mutates input.
export function inheritCureSpeeds(areas) {
  const FIELDS = ['basecoat_cure_speed', 'topcoat_cure_speed'];
  const list = Array.isArray(areas) ? areas : [];
  const dominant = {};
  for (const f of FIELDS) {
    const counts = new Map(); // value -> { n, firstOrder }
    list.forEach((a, i) => {
      const v = a && a[f];
      if (!v) return;
      const ordNum = Number(a.order_index);
      const ord = Number.isFinite(ordNum) ? ordNum : i;
      const c = counts.get(v) || { n: 0, firstOrder: Infinity };
      c.n += 1;
      if (ord < c.firstOrder) c.firstOrder = ord;
      counts.set(v, c);
    });
    let best = null;
    for (const [v, c] of counts) {
      if (!best || c.n > best.c.n || (c.n === best.c.n && c.firstOrder < best.c.firstOrder)) best = { v, c };
    }
    dominant[f] = best ? best.v : null;
  }
  if (!dominant.basecoat_cure_speed && !dominant.topcoat_cure_speed) return list.slice();
  return list.map(a => {
    const out = { ...a };
    for (const f of FIELDS) if (!out[f] && dominant[f]) out[f] = dominant[f];
    return out;
  });
}

// Canonical picks-to-plan mapping for CRM job card areas (job_areas rows,
// each with an embedded `materials` array of job_area_materials rows). The
// job card is the SOURCE OF TRUTH for what a bridged job needs, so Ordering
// and the Job Costing derived fallback both build calculator input through
// this one function (index.html carries a byte-identical mirror). It
// replicates the Work Order / Budget mapping (firstSlotPick over the
// system's slots, first non-null pick wins) PLUS a Topcoat pick. Customs
// (is_custom rows) and second-and-later picks of a multi-product slot are
// intentionally ignored, exactly like the Work Order.
// Prompt 75 C1: change-order areas (is_change_order) NEVER auto-generate
// material lines. A striping change order carrying the flake system id used
// to emit a full slot-default material set (phantom no-cure topcoat +
// per-job-pick flake); if a change order truly needs material, someone adds
// the line by hand on the order sheet.
export function crmPlanAreas(crmAreas, recipeSlotsBySystemType) {
  const SWATCH = new Set(['Flake', 'Quartz', 'Metallic Pigment']);
  return (crmAreas || []).slice()
    .filter(a => a.is_change_order !== true)
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
    .map(a => {
      const mine = a.materials || [];
      // picks: recipe_slot_id -> productIds[] ordered by pick_index (compacted)
      const picks = {};
      for (const m of mine) {
        if (m.is_custom || !m.recipe_slot_id || !m.product_id) continue;
        (picks[m.recipe_slot_id] ||= [])[m.pick_index || 0] = m.product_id;
      }
      for (const k in picks) picks[k] = picks[k].filter(Boolean);
      let firstSlotPick = (pred) => {
        for (const slot of (recipeSlotsBySystemType[a.system_type_id] || [])) {
          if (!pred(slot.material_type)) continue;
          const pid = (picks[slot.id] || [])[0];
          if (pid) return pid;
        }
        return null;
      };
      // Legacy mirror fallback (mirrors buildArea in the CRM module): a job
      // with areas but ZERO materials rows predates the picks backfill; its
      // selections live on the job_areas flake/basecoat columns directly.
      if (!mine.length && (a.flake_product_id || a.basecoat_product_id)) {
        firstSlotPick = (pred) => {
          if (pred('Flake')) return a.flake_product_id || null;       // swatch predicate
          if (pred('Basecoat')) return a.basecoat_product_id || null;
          return null;
        };
      }
      const sqftNum = Number(a.sqft);
      return {
        id: a.id, name: a.name,
        sqft: Number.isFinite(sqftNum) && sqftNum >= 0 ? sqftNum : 0,
        system_type_id: a.system_type_id,
        flake_product_id: firstSlotPick(t => SWATCH.has(t)),
        basecoat_product_id: firstSlotPick(t => t === 'Basecoat'),
        topcoat_product_id: firstSlotPick(t => t === 'Topcoat'),
        topcoat_cure_speed: a.topcoat_cure_speed || null,
        // Prompt 75: flake_color_id rides along for the ordering-side
        // "flake color not chosen" rule; order_index for cure-inheritance
        // tie-breaking. Both are ignored by computeMaterialPlan.
        flake_color_id: a.flake_color_id || null,
        order_index: a.order_index ?? 0,
      };
    });
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
  mvbProductId = null,
}) {
  if (!Array.isArray(areas)) {
    throw new CalculatorError('areas must be an array', 'INVALID_INPUT');
  }

  const areaPlans = [];

  for (const area of areas) {
    // Per-area MVB (2026-07-15): a moisture vapor barrier is now a COST ADDER
    // on the area that has it, not a job-level mode. Each mvb=true area adds the
    // MVB product at ITS OWN sqft; mergeAcrossAreas then sums two MVB areas into
    // ONE material line (by product_id), which is the point of the merge. An
    // MVB-only job needs no special path: its area's system is "MVB Only" whose
    // recipe already IS the MVB product, so the guard below avoids doubling it.
    areaPlans.push(planForArea(area, {
      productsById,
      recipeSlotsBySystemType,
      defaultBasecoatByFlake,
      mvbProductId,
    }));
  }

  const lines = mergeAcrossAreas(areaPlans, productsById);
  appendPlaceholderLines(lines, areaPlans);

  return { lines, areaPlans };
}

/**
 * The ONE job estimate. Both the front-end job-detail Budget card and the
 * Job Costing tab call this so the estimated materials and estimated hours are
 * identical (Dylan's rule: "exactly what is on the front-end job estimation is
 * what populates into Job Costing. Nothing different at all.").
 *
 * Materials reproduce the Budget card exactly: each area is normalized to flake
 * + basecoat picks ONLY (any topcoat_product_id is dropped, so a topcoat pick
 * is never honored and the slot default fills it, matching renderBudget), and
 * the FULL slot set (including editor_hidden body coats) is used. Labor mirrors
 * renderBudget: revenue x system.labor_budget_pct, divided by the hourly rate
 * for budgeted hours.
 *
 * @param {Object} input
 * @param {Array} input.areas  Normalized areas: { id, name, sqft, system_type_id, flake_product_id, basecoat_product_id } (topcoat ignored)
 * @param {Object} input.productsById
 * @param {Object} input.recipeSlotsBySystemType  FULL slots (incl. editor_hidden), keyed by system_type_id
 * @param {Object} input.defaultBasecoatByFlake
 * @param {Array}  input.systemTypes  rows with { id, labor_budget_pct }
 * @param {number} input.revenue   the FRONT-END job price (public.jobs.price)
 * @param {number} input.laborRate default_labor_hourly_rate
 * @param {string|null} input.mvbProductId  the catalog MVB product; each area
 *   with mvb=true adds it at that area's sqft (passthrough to computeMaterialPlan).
 * @returns {{ materialLines, materialsBudget, laborPct, laborBudget, budgetedHours }}
 */
export function computeJobEstimate({
  areas,
  productsById,
  recipeSlotsBySystemType,
  defaultBasecoatByFlake = {},
  systemTypes = [],
  revenue = 0,
  laborRate = 0,
  mvbProductId = null,
}) {
  // Strip everything but the estimate-relevant fields. Dropping topcoat_product_id
  // is deliberate: the front-end Budget card never passes it, so the topcoat
  // slot default is used in both places. `mvb` rides along so the per-area MVB
  // adder (computeMaterialPlan) fires for the areas that have it.
  const planAreas = (areas || []).map((a) => {
    const sqftNum = Number(a.sqft);
    return {
      id: a.id,
      name: a.name,
      sqft: Number.isFinite(sqftNum) && sqftNum >= 0 ? sqftNum : 0,
      system_type_id: a.system_type_id,
      flake_product_id: a.flake_product_id || null,
      basecoat_product_id: a.basecoat_product_id || null,
      mvb: a.mvb === true,
    };
  });

  let materialLines = [];
  let planError = null;
  try {
    materialLines = computeMaterialPlan({
      areas: planAreas,
      productsById,
      recipeSlotsBySystemType,
      defaultBasecoatByFlake,
      mvbProductId,
    }).lines;
  } catch (err) {
    planError = err && err.message ? err.message : String(err);
  }
  const materialsBudget = materialLines.reduce(
    (s, l) => s + (Number(l.line_cost) > 0 ? Number(l.line_cost) : 0),
    0
  );

  const primarySystem = planAreas[0]
    ? (systemTypes || []).find((s) => s.id === planAreas[0].system_type_id)
    : null;
  const laborPct =
    primarySystem && primarySystem.labor_budget_pct != null
      ? Number(primarySystem.labor_budget_pct)
      : null;
  const rev = Number(revenue) || 0;
  const rate = Number(laborRate) || 0;
  const laborBudget = laborPct != null && rev > 0 ? (rev * laborPct) / 100 : null;
  const budgetedHours = laborBudget != null && rate > 0 ? laborBudget / rate : null;

  return { materialLines, materialsBudget, laborPct, laborBudget, budgetedHours, planError };
}

/**
 * The estimate PRICING engine (the only genuinely new math in the estimator).
 * Cost-plus to a target gross margin. It WRAPS computeJobEstimate so there is
 * still one source of truth for materials and labor: it does not re-derive any
 * material or labor number, it only solves for the price R that hits targetGP.
 *
 * Labor and commission are both percents OF revenue, so pricing is mildly
 * circular (labor and commission depend on R; R depends on total cost). The
 * closed form, with cost buckets matching computeCostingRow (materials, labor,
 * commission, plus fixed add-ons F):
 *
 *   GP/R = targetGP
 *   R - (M + laborFrac*R + commFrac*R + F) = targetGP*R
 *   => R = (M + F) / (1 - laborFrac - commFrac - targetGpFrac)
 *
 * Steps:
 *   1. Pass 1 at revenue:0 gets M (materialsBudget is revenue-independent);
 *      materials were always per-area (each area prices with its own system's
 *      recipe via recipeSlotsBySystemType[area.system_type_id]).
 *   2. Resolve laborPct and targetGP% as the SQFT-WEIGHTED averages of the
 *      areas' systems (multi-system estimates, 2026-07-13; each system's own
 *      target_gp_pct override wins over the passed global, per area). All
 *      three rates are PERCENTS. A single-system estimate weights to that
 *      system's own numbers, identical to the old primary-system pick.
 *   3. divisor = 1 - laborFrac - commFrac - targetGpFrac. If divisor <= 0 the
 *      target is mathematically impossible: return an error, never divide.
 *   4. priceRaw = (M + F) / divisor; round UP to priceIncrement so rounding
 *      never drops realized GP below target.
 *   5. Recompute the money buckets at the rounded price so the displayed GP$,
 *      GP%, commission$, labor budget, and budgeted hours all agree with the
 *      shown price (hours = weightedLabor% x price / laborRate).
 *
 * Commission is a STANDARD budgeted house expense baked into the price, so the
 * customer's quote is identical no matter which salesperson is assigned. The
 * assigned rep's ACTUAL rate only changes what the rep is paid and the GP
 * variance vs the budget; it never moves the price. So:
 *   commissionDollars (budgeted) = standardComm% * price   (in the price)
 *   commissionPayout (actual)    = actualComm%   * price   (what the rep gets)
 *   gpVariance                   = (standardComm - actualComm)% * price
 *   realizedGp                   = gpDollars + gpVariance
 * A 0% rep (the owner) yields gpVariance = standardComm% * price of extra GP; a
 * rep at the standard rate yields zero variance.
 *
 * @param {Object} input  Same area-set inputs as computeJobEstimate, plus:
 * @param {number} input.commissionPct        STANDARD house commission PERCENT baked into the price (e.g. 6)
 * @param {number} input.actualCommissionPct  the assigned rep's actual PERCENT (payout + variance only; defaults to the standard)
 * @param {number} input.targetGpPct          target gross-profit PERCENT (e.g. 50)
 * @param {number} input.fixedAddons          F: direct add-ons not proportional to revenue (default 0)
 * @param {number} input.priceIncrement       rounding increment (default 5)
 * @returns {Object} { price, priceRaw, materialsCost, fixedAddons, laborPct,
 *   laborBudget, laborDollars, commissionPct (=standard), standardCommissionPct,
 *   actualCommissionPct, commissionDollars (budgeted), commissionPayout,
 *   gpVariance, targetGpPct, gpDollars, gpPct (budgeted at standard), realizedGp,
 *   realizedGpPct, gpPerHour, budgetedHours, materialLines, materialsMissingCost,
 *   divisor, calcVersion, error } - on failure, { error, ..., calcVersion } with
 *   error one of the planError string, 'NO_LABOR_PCT', or 'TARGET_UNREACHABLE'.
 */
export function computeEstimatePricing({
  areas,
  productsById,
  recipeSlotsBySystemType,
  defaultBasecoatByFlake = {},
  systemTypes = [],
  laborRate = 0,
  commissionPct = 0,
  actualCommissionPct = null,
  targetGpPct = 50,
  fixedAddons = 0,
  priceIncrement = 5,
  charmThreshold = 1000,
  charmBand = 250,
  sundriesPct = 0,
  mvbProductId = null,
}) {
  // Pass 1: materials cost M is independent of revenue, so price at revenue:0.
  const base = computeJobEstimate({
    areas, productsById, recipeSlotsBySystemType, defaultBasecoatByFlake,
    systemTypes, revenue: 0, laborRate, mvbProductId,
  });
  if (base.planError) {
    return { error: base.planError, materialLines: base.materialLines, calcVersion: CALC_VERSION };
  }

  const M = Number(base.materialsBudget) || 0;
  const F = Number(fixedAddons) || 0;

  // Multi-system estimates (2026-07-13): each area carries its OWN system, so
  // labor % and target GP are the SQFT-WEIGHTED averages of the areas' systems
  // (per-system target_gp_pct override wins over the passed global, per area).
  // Sqft-weighted on purpose: a naive mean would let a small high-target area
  // drag the whole estimate's target (and the GP-red warning) around. With one
  // weighted divisor, the realized GP% at the solved price is exactly the
  // weighted target. A single-system estimate weights to that system's own
  // numbers, so prompt-15 estimates price byte-identically.
  const standardComm = Number(commissionPct) || 0;
  const systemById = new Map((systemTypes || []).map((s) => [s.id, s]));
  let weightSum = 0;
  let laborWeighted = 0;
  let gpWeighted = 0;
  let laborMissing = (areas || []).length === 0;
  for (const a of areas || []) {
    const sys = systemById.get(a.system_type_id);
    if (!sys || sys.labor_budget_pct == null) { laborMissing = true; break; }
    // Equal weights when no area has sqft yet (all-zero estimates still error
    // helpfully instead of dividing by zero).
    const w = Number(a.sqft) > 0 ? Number(a.sqft) : 0;
    const sysTarget = sys.target_gp_pct != null ? Number(sys.target_gp_pct) : Number(targetGpPct);
    weightSum += w;
    laborWeighted += w * Number(sys.labor_budget_pct);
    gpWeighted += w * sysTarget;
  }
  if (laborMissing) {
    // An area's system is missing labor_budget_pct: cannot solve cost-plus.
    return { error: 'NO_LABOR_PCT', materialLines: base.materialLines, calcVersion: CALC_VERSION };
  }
  if (!(weightSum > 0)) {
    const n = (areas || []).length;
    for (const a of areas || []) {
      const sys = systemById.get(a.system_type_id);
      laborWeighted += Number(sys.labor_budget_pct) / n;
      gpWeighted += (sys.target_gp_pct != null ? Number(sys.target_gp_pct) : Number(targetGpPct)) / n;
    }
    weightSum = 1;
  }
  const laborPctWeighted = laborWeighted / weightSum;
  const targetGp = gpWeighted / weightSum;

  // Sundries + disposables (2026-07-15): tape, blades, plastic, mixing sticks,
  // grinder consumables. A COST at `s` of TOTAL job cost (materials + fixed
  // add-ons + labor + commission), baked into the price, never a customer line.
  // Labor and commission are fractions of revenue, so sundries is circular; the
  // closed form (no iteration): with L,C,g,s fractions,
  //   P[1 - (L+C)(1+s) - g] = (M+F)(1+s)  =>  P = (M+F)(1+s) / divisor.
  // Setting s=0 collapses to the pre-build-17 divisor and price EXACTLY.
  const s = Number(sundriesPct) / 100 || 0;
  const laborFrac = laborPctWeighted / 100;
  const commFrac = standardComm / 100;
  const gpFrac = targetGp / 100;
  const divisor = 1 - (laborFrac + commFrac) * (1 + s) - gpFrac;
  if (!(divisor > 0)) {
    // labor + commission (grossed up for sundries) + target margin consume
    // >= 100% of revenue: impossible.
    return { error: 'TARGET_UNREACHABLE', divisor, materialLines: base.materialLines, calcVersion: CALC_VERSION };
  }

  const priceRaw = (M + F) * (1 + s) / divisor;
  const price = roundEstimatePrice(priceRaw, { increment: priceIncrement, charmThreshold, charmBand });

  // Recompute money buckets at the ROUNDED price so display is internally
  // consistent (same bucket set as computeCostingRow: materials, labor,
  // commission, sundries, plus fixed add-ons). The commission bucket here is the
  // STANDARD (budgeted) commission, so gpDollars is the BUDGETED gross profit
  // the quote is built to hit.
  const commissionDollars = round2(commFrac * price);
  const laborDollars = round2(laborFrac * price);
  const sundriesDollars = round2(s * (M + F + laborDollars + commissionDollars));
  const gpDollars = round2(price - (M + laborDollars + commissionDollars + F + sundriesDollars));
  const gpPct = price > 0 ? gpDollars / price : null;
  // Labor budget + hours from the WEIGHTED labor fraction (computeJobEstimate's
  // primary-system laborPct would be wrong on a mixed-system estimate).
  const laborBudget = laborFrac * price;
  const rate = Number(laborRate) || 0;
  const budgetedHours = rate > 0 ? laborBudget / rate : null;
  const gpPerHour = budgetedHours != null && budgetedHours > 0 ? round2(gpDollars / budgetedHours) : null;

  // The assigned rep's ACTUAL rate drives payout + GP variance only (never price).
  const actualComm = actualCommissionPct == null ? standardComm : (Number(actualCommissionPct) || 0);
  const commissionPayout = round2((actualComm / 100) * price);
  const gpVariance = round2(((standardComm - actualComm) / 100) * price);
  const realizedGp = round2(gpDollars + gpVariance);
  const realizedGpPct = price > 0 ? realizedGp / price : null;

  // Data-hygiene flag: products with no unit_cost are NOT counted in M, so the
  // price is built on partial material cost. Surface the offending product names
  // so the UI can warn instead of silently underpricing.
  const materialsMissingCost = (base.materialLines || [])
    .filter((l) => l.unit_cost_snapshot == null)
    .map((l) => l.product_name);

  return {
    price,
    priceRaw: round2(priceRaw),
    materialsCost: M,
    fixedAddons: F,
    sundriesPct: Number(sundriesPct) || 0,
    sundriesDollars,
    laborPct: laborPctWeighted,
    laborBudget,
    laborDollars,
    commissionPct: standardComm,
    standardCommissionPct: standardComm,
    actualCommissionPct: actualComm,
    commissionDollars,
    commissionPayout,
    gpVariance,
    targetGpPct: targetGp,
    gpDollars,
    gpPct,
    realizedGp,
    realizedGpPct,
    gpPerHour,
    budgetedHours,
    materialLines: base.materialLines,
    materialsMissingCost,
    divisor,
    calcVersion: CALC_VERSION,
    error: null,
  };
}

/**
 * Re-derive the money buckets at a rep-chosen SELL price (free-typed price or
 * discount percent). The engine's computeEstimatePricing solves for the price
 * that HITS the target GP; this answers the follow-up "and what happens to GP
 * if I sell it for X instead". Same bucket math as computeEstimatePricing's
 * pass 2 (labor and commission are fractions OF revenue, materials and fixed
 * add-ons are not), so the two can never disagree at sellPrice === price.
 *
 * Estimator-only export: index.html never calls this, so it has NO inline
 * mirror (the mirror rule covers functions the dashboard inlines).
 *
 * @param {Object} pricing  a successful computeEstimatePricing result
 * @param {number} sellPrice  the rep's chosen price
 * @returns {{ sellPrice, discountPct, laborDollars, commissionDollars,
 *   gpDollars, gpPct, budgetedHours, gpPerHour }}
 */
export function applySellPrice(pricing, sellPrice) {
  const sell = Number(sellPrice);
  const base = Number(pricing && pricing.price);
  const laborFrac = (Number(pricing && pricing.laborPct) || 0) / 100;
  const commFrac = (Number(pricing && pricing.standardCommissionPct) || 0) / 100;
  const s = (Number(pricing && pricing.sundriesPct) || 0) / 100;
  const M = Number(pricing && pricing.materialsCost) || 0;
  const F = Number(pricing && pricing.fixedAddons) || 0;
  if (!(sell > 0)) {
    return { sellPrice: null, discountPct: null, laborDollars: null, commissionDollars: null, sundriesDollars: null, gpDollars: null, gpPct: null, budgetedHours: null, gpPerHour: null };
  }
  const laborDollars = round2(laborFrac * sell);
  const commissionDollars = round2(commFrac * sell);
  // Sundries counts at the SELL price too, or an override reports a GP that is
  // s of cost too high (exactly the 15c comps class of bug).
  const sundriesDollars = round2(s * (M + F + laborDollars + commissionDollars));
  const gpDollars = round2(sell - (M + laborDollars + commissionDollars + F + sundriesDollars));
  const gpPct = gpDollars / sell;
  // Budgeted hours scale linearly with the labor budget (labor% x price / rate),
  // so hours at the sell price are base hours x (sell / base price).
  const baseHours = pricing && pricing.budgetedHours != null ? Number(pricing.budgetedHours) : null;
  const budgetedHours = baseHours != null && base > 0 ? round2(baseHours * (sell / base)) : null;
  const gpPerHour = budgetedHours != null && budgetedHours > 0 ? round2(gpDollars / budgetedHours) : null;
  const discountPct = base > 0 ? round2((1 - sell / base) * 100) : null;
  return { sellPrice: sell, discountPct, laborDollars, commissionDollars, sundriesDollars, gpDollars, gpPct, budgetedHours, gpPerHour };
}

/**
 * PER-LINE pricing (prompt 69): each area solves its OWN price at its OWN
 * system's labor% and target GP%; the job total is the sum of the lines.
 * Replaces (for the estimator) computeEstimatePricing's single sqft-weighted
 * divisor, under which no individual system hit its own target GP on a mixed
 * estimate: only the blended average did, so a high-margin system silently
 * subsidized a low-margin one.
 *
 * THE TRAP THIS IS BUILT AROUND: materials kit-round ACROSS the whole estimate
 * (mergeAcrossAreas): two areas each needing 0.6 of a kit of the same basecoat
 * consume ONE kit, not two. So this does NOT solve each area alone (that buys
 * two kits and inflates the total). Instead:
 *   1. ONE estimate-wide material plan (identical to computeEstimatePricing's
 *      pass 1); its merged, kit-rounded total is M, still the ordering truth.
 *   2. M is attributed to areas by each area's PRE-merge raw material cost
 *      (its own recipe at its own sqft, fractional kits, unrounded) via
 *      allocateProportionally, so the parts sum to M exactly and kit-rounding
 *      overhead lands in proportion to what each area actually consumes.
 *   3. Each area solves with the SAME closed form as computeEstimatePricing
 *      but at its own rates: divisor_a = 1 - (laborFrac_a + commFrac)(1+s)
 *      - gpFrac_a; priceRaw_a = (M_a + F_a)(1+s) / divisor_a; rounded per line
 *      with the existing roundEstimatePrice rule.
 * Fixed add-ons (F) are allocated across areas by the same raw-cost weights
 * (in practice F is 0 here: the estimator's add-ons are their own line items).
 *
 * INVARIANT (tested): a SINGLE-area estimate prices identically, to the cent,
 * to computeEstimatePricing with the same inputs; M_1 = M and the divisor is
 * the same number, so the two solves are algebraically the same expression.
 *
 * Estimator-only export like applySellPrice: index.html never calls this, so
 * it has NO inline mirror. Same input shape as computeEstimatePricing.
 *
 * @returns {Object} on success, the computeEstimatePricing result shape
 *   (price, priceRaw, materialsCost, laborPct [effective], gpDollars, gpPct,
 *   budgetedHours, materialLines, ...) PLUS `lines`: one entry per area, in
 *   area order: { areaId, index, name, systemTypeId, sqft, materialsCost,
 *   fixedAddons, laborPct, targetGpPct, divisor, priceRaw, price,
 *   laborDollars, commissionDollars, sundriesDollars, gpDollars, gpPct,
 *   budgetedHours, gpPerHour }. On failure { error, errorArea?, ... } with the
 *   same error codes as computeEstimatePricing; TARGET_UNREACHABLE and
 *   NO_LABOR_PCT name the offending area in errorArea.
 */
export function computePerLinePricing({
  areas,
  productsById,
  recipeSlotsBySystemType,
  defaultBasecoatByFlake = {},
  systemTypes = [],
  laborRate = 0,
  commissionPct = 0,
  actualCommissionPct = null,
  targetGpPct = 50,
  fixedAddons = 0,
  priceIncrement = 5,
  charmThreshold = 1000,
  charmBand = 250,
  sundriesPct = 0,
  mvbProductId = null,
}) {
  // Normalize EXACTLY like computeJobEstimate (topcoat dropped, mvb carried),
  // so the merged plan and M are byte-identical to computeEstimatePricing's.
  const planAreas = (areas || []).map((a) => {
    const sqftNum = Number(a.sqft);
    return {
      id: a.id,
      name: a.name,
      sqft: Number.isFinite(sqftNum) && sqftNum >= 0 ? sqftNum : 0,
      system_type_id: a.system_type_id,
      flake_product_id: a.flake_product_id || null,
      basecoat_product_id: a.basecoat_product_id || null,
      mvb: a.mvb === true,
    };
  });

  let plan = null;
  let planError = null;
  try {
    plan = computeMaterialPlan({
      areas: planAreas, productsById, recipeSlotsBySystemType,
      defaultBasecoatByFlake, mvbProductId,
    });
  } catch (err) {
    planError = err && err.message ? err.message : String(err);
  }
  const materialLines = plan ? plan.lines : [];
  if (planError) {
    return { error: planError, materialLines, calcVersion: CALC_VERSION };
  }
  const M = materialLines.reduce(
    (s, l) => s + (Number(l.line_cost) > 0 ? Number(l.line_cost) : 0),
    0
  );

  // PRE-merge raw cost per area: fractional kits at the area's own sqft
  // (tint lines are pack-priced). Products with no unit_cost contribute 0,
  // matching how M excludes them (materialsMissingCost flags them below).
  const rawCostByArea = (plan.areaPlans || []).map(({ lines }) =>
    lines.reduce((s, l) => {
      const cost = l.unit_cost == null ? 0 : Number(l.unit_cost);
      if (l._tint_packs != null) return s + l._tint_packs * cost;
      if (!(l.sqft > 0)) return s;
      return s + (l.sqft / l.spread_rate / l.kit_size) * cost;
    }, 0)
  );

  const standardComm = Number(commissionPct) || 0;
  const systemById = new Map((systemTypes || []).map((sys) => [sys.id, sys]));
  if (!planAreas.length) {
    return { error: 'NO_LABOR_PCT', materialLines, calcVersion: CALC_VERSION };
  }
  for (let i = 0; i < planAreas.length; i++) {
    const sys = systemById.get(planAreas[i].system_type_id);
    if (!sys || sys.labor_budget_pct == null) {
      return {
        error: 'NO_LABOR_PCT',
        errorArea: planAreas[i].name || `Area ${i + 1}`,
        materialLines,
        calcVersion: CALC_VERSION,
      };
    }
  }

  const F = Number(fixedAddons) || 0;
  const mParts = allocateProportionally(M, rawCostByArea);
  const fParts = F ? allocateProportionally(F, rawCostByArea) : planAreas.map(() => 0);

  const s = Number(sundriesPct) / 100 || 0;
  const commFrac = standardComm / 100;
  const rate = Number(laborRate) || 0;

  const lines = [];
  for (let i = 0; i < planAreas.length; i++) {
    const a = planAreas[i];
    const sys = systemById.get(a.system_type_id);
    const laborPctSys = Number(sys.labor_budget_pct);
    const sysTarget = sys.target_gp_pct != null ? Number(sys.target_gp_pct) : Number(targetGpPct);
    const laborFrac = laborPctSys / 100;
    const gpFrac = sysTarget / 100;
    const divisor = 1 - (laborFrac + commFrac) * (1 + s) - gpFrac;
    if (!(divisor > 0)) {
      return {
        error: 'TARGET_UNREACHABLE',
        errorArea: a.name || `Area ${i + 1}`,
        divisor,
        materialLines,
        calcVersion: CALC_VERSION,
      };
    }
    const priceRaw = (mParts[i] + fParts[i]) * (1 + s) / divisor;
    const price = roundEstimatePrice(priceRaw, { increment: priceIncrement, charmThreshold, charmBand });
    const laborDollars = round2(laborFrac * price);
    const commissionDollars = round2(commFrac * price);
    const sundriesDollars = round2(s * (mParts[i] + fParts[i] + laborDollars + commissionDollars));
    const gpDollars = round2(price - (mParts[i] + laborDollars + commissionDollars + fParts[i] + sundriesDollars));
    const budgetedHours = rate > 0 ? round2((laborFrac * price) / rate) : null;
    lines.push({
      areaId: a.id != null ? a.id : null,
      index: i,
      name: a.name || `Area ${i + 1}`,
      systemTypeId: a.system_type_id,
      sqft: a.sqft,
      materialsCost: round2(mParts[i]),
      fixedAddons: round2(fParts[i]),
      laborPct: laborPctSys,
      targetGpPct: sysTarget,
      divisor,
      priceRaw: round2(priceRaw),
      price,
      laborDollars,
      commissionDollars,
      sundriesDollars,
      gpDollars,
      gpPct: price > 0 ? gpDollars / price : null,
      budgetedHours,
      gpPerHour: budgetedHours != null && budgetedHours > 0 ? round2(gpDollars / budgetedHours) : null,
    });
  }

  // Job totals = SUMS of the lines. No second job-level solve, no
  // back-allocation. laborBudget stays unrounded (matching
  // computeEstimatePricing) so budgetedHours agrees on a single area.
  const price = lines.reduce((sum, l) => sum + l.price, 0);
  const priceRawTotal = lines.reduce((sum, l) => sum + l.priceRaw, 0);
  const laborBudget = lines.reduce((sum, l) => sum + (l.laborPct / 100) * l.price, 0);
  const laborDollars = round2(lines.reduce((sum, l) => sum + l.laborDollars, 0));
  const commissionDollars = round2(lines.reduce((sum, l) => sum + l.commissionDollars, 0));
  const sundriesDollars = round2(lines.reduce((sum, l) => sum + l.sundriesDollars, 0));
  const gpDollars = round2(lines.reduce((sum, l) => sum + l.gpDollars, 0));
  const gpPct = price > 0 ? gpDollars / price : null;
  const budgetedHours = rate > 0 ? laborBudget / rate : null;
  const gpPerHour = budgetedHours != null && budgetedHours > 0 ? round2(gpDollars / budgetedHours) : null;
  // Effective (price-weighted) rates, so applySellPrice at a job sell price
  // scales the same cost stack the lines sum to.
  const laborPctEff = price > 0 ? (laborBudget / price) * 100 : lines[0].laborPct;
  const targetGpEff = price > 0
    ? lines.reduce((sum, l) => sum + l.targetGpPct * l.price, 0) / price
    : lines[0].targetGpPct;

  const actualComm = actualCommissionPct == null ? standardComm : (Number(actualCommissionPct) || 0);
  const commissionPayout = round2((actualComm / 100) * price);
  const gpVariance = round2(((standardComm - actualComm) / 100) * price);
  const realizedGp = round2(gpDollars + gpVariance);

  const materialsMissingCost = materialLines
    .filter((l) => l.unit_cost_snapshot == null)
    .map((l) => l.product_name);

  return {
    lines,
    price,
    priceRaw: round2(priceRawTotal),
    materialsCost: M,
    fixedAddons: F,
    sundriesPct: Number(sundriesPct) || 0,
    sundriesDollars,
    laborPct: laborPctEff,
    laborBudget,
    laborDollars,
    commissionPct: standardComm,
    standardCommissionPct: standardComm,
    actualCommissionPct: actualComm,
    commissionDollars,
    commissionPayout,
    gpVariance,
    targetGpPct: targetGpEff,
    gpDollars,
    gpPct,
    realizedGp,
    realizedGpPct: price > 0 ? realizedGp / price : null,
    gpPerHour,
    budgetedHours,
    materialLines,
    materialsMissingCost,
    calcVersion: CALC_VERSION,
    error: null,
  };
}

/**
 * Re-derive ONE calculator line's money buckets at a rep-chosen sell price
 * (a per-line price edit, or this line's share of a job-level discount).
 * Same bucket math as computePerLinePricing's per-line pass, so the two can
 * never disagree at sellPrice === line.price. Materials and fixed add-ons are
 * this line's attributed (fixed) cost; labor and commission scale with the
 * sell price; sundries counts at the sell price too (the applySellPrice rule).
 * Estimator-only export: no inline mirror.
 *
 * @param {Object} line  one entry of computePerLinePricing().lines
 * @param {number} sellPrice
 * @param {Object} opts  { commissionPct, sundriesPct, laborRate } - the
 *   job-level rates (the line carries its own laborPct; these three are
 *   estimate-wide by design)
 */
export function applyLineSellPrice(line, sellPrice, { commissionPct = 0, sundriesPct = 0, laborRate = 0 } = {}) {
  const sell = Number(sellPrice);
  if (!(sell > 0) || !line) {
    return { sellPrice: null, laborDollars: null, commissionDollars: null, sundriesDollars: null, gpDollars: null, gpPct: null, budgetedHours: null, gpPerHour: null };
  }
  const M = Number(line.materialsCost) || 0;
  const F = Number(line.fixedAddons) || 0;
  const laborFrac = (Number(line.laborPct) || 0) / 100;
  const commFrac = (Number(commissionPct) || 0) / 100;
  const s = (Number(sundriesPct) || 0) / 100;
  const laborDollars = round2(laborFrac * sell);
  const commissionDollars = round2(commFrac * sell);
  const sundriesDollars = round2(s * (M + F + laborDollars + commissionDollars));
  const gpDollars = round2(sell - (M + laborDollars + commissionDollars + F + sundriesDollars));
  const rate = Number(laborRate) || 0;
  const budgetedHours = rate > 0 ? round2((laborFrac * sell) / rate) : null;
  return {
    sellPrice: sell,
    laborDollars,
    commissionDollars,
    sundriesDollars,
    gpDollars,
    gpPct: gpDollars / sell,
    budgetedHours,
    gpPerHour: budgetedHours != null && budgetedHours > 0 ? round2(gpDollars / budgetedHours) : null,
  };
}

/**
 * Money buckets for a CUSTOM line (prompt 69, locked decision 5): the price is
 * typed, the cost is typed material cost + typed labor hours x the hourly
 * rate, plus commission and sundries at the typed price, so its GP has the
 * same shape as every calculator line's and its hours are real for
 * scheduling. No catalog products, nothing into the material plan (decision
 * 6). Estimator-only export: no inline mirror.
 *
 * @returns {{ price, materialsCost, laborDollars, commissionDollars,
 *   sundriesDollars, gpDollars, gpPct, budgetedHours, gpPerHour }} or the
 *   all-null shape when price is not a positive number.
 */
export function customLinePricing({ price, materialCost = 0, laborHours = 0, laborRate = 0, commissionPct = 0, sundriesPct = 0 }) {
  const sell = Number(price);
  if (!(sell > 0)) {
    return { price: null, materialsCost: null, laborDollars: null, commissionDollars: null, sundriesDollars: null, gpDollars: null, gpPct: null, budgetedHours: null, gpPerHour: null };
  }
  const M = Number(materialCost) > 0 ? Number(materialCost) : 0;
  const hours = Number(laborHours) > 0 ? Number(laborHours) : 0;
  const laborDollars = round2(hours * (Number(laborRate) || 0));
  const commissionDollars = round2(((Number(commissionPct) || 0) / 100) * sell);
  const sFrac = (Number(sundriesPct) || 0) / 100;
  const sundriesDollars = round2(sFrac * (M + laborDollars + commissionDollars));
  const gpDollars = round2(sell - (M + laborDollars + commissionDollars + sundriesDollars));
  return {
    price: sell,
    materialsCost: M,
    laborDollars,
    commissionDollars,
    sundriesDollars,
    gpDollars,
    gpPct: gpDollars / sell,
    budgetedHours: hours > 0 ? hours : null,
    gpPerHour: hours > 0 ? round2(gpDollars / hours) : null,
  };
}

/**
 * Prompt 82: is the per-line money chain ready to run? The engine is a pricer
 * for CALCULATOR lines only, so an estimate whose lines are all custom is not
 * broken, it is an estimate the engine legitimately has no work on. The engine
 * price is therefore required only when at least one calculator line exists;
 * every line must carry a current price either way. This rule used to live
 * inline in the estimator as `hasPrice && ...`, which is exactly what made a
 * custom-line-only estimate unsaveable (the Save button never rendered).
 * Estimator-only export: no inline mirror.
 *
 * @param {Array<{kind: 'calc'|'custom', current: number|null}>} rows
 * @param {boolean} hasEnginePrice  the engine solved a price with no error
 * @returns {boolean}
 */
export function lineRowsReady(rows, hasEnginePrice) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const calcCount = rows.filter((r) => r && r.kind === 'calc').length;
  if (calcCount > 0 && !hasEnginePrice) return false;
  return rows.every((r) => r && r.current != null);
}

/**
 * The ONE optional-item money rule, shared by the estimator, the estimate
 * page, and the public customer page: a line with is_optional=true is EXCLUDED
 * from the total until selected_by_customer=true. `withAllOptions` answers the
 * rep's other question ("and if they take everything?"). Tolerates both the
 * row shape (is_optional) and the legacy jsonb shape (optional).
 *
 * @param {Array} items  estimate_line_items rows (or legacy jsonb items)
 * @returns {number} sum of counted items' totals
 */
export function lineItemsTotal(items, { withAllOptions = false } = {}) {
  return (Array.isArray(items) ? items : []).reduce((sum, li) => {
    if (!li) return sum;
    const optional = li.is_optional === true || li.optional === true;
    if (optional && !li.selected_by_customer && !withAllOptions) return sum;
    const t = Number(li.total);
    return sum + (Number.isFinite(t) ? t : 0);
  }, 0);
}

/**
 * Gross-profit contribution of add-on / one-off line items, counted with the
 * same optional rule as lineItemsTotal. Per counted line:
 *   gp = total - qty*unit_cost - standardComm% * total
 * Commission applies because the house commission is a percent of ALL revenue;
 * labor is assumed inside unit_cost (an add-on's cost is its all-in cost).
 * A line with revenue and NO cost contributes its full margin, which is
 * exactly how a costless add-on inflates GP; the catalog's default_cost exists
 * so that stops happening the moment Dylan prices it.
 */
export function lineItemsGp(items, standardCommissionPct = 0, { withAllOptions = false } = {}) {
  const commFrac = (Number(standardCommissionPct) || 0) / 100;
  return round2((Array.isArray(items) ? items : []).reduce((sum, li) => {
    if (!li) return sum;
    const optional = li.is_optional === true || li.optional === true;
    if (optional && !li.selected_by_customer && !withAllOptions) return sum;
    const t = Number(li.total) || 0;
    const qty = Number.isFinite(Number(li.qty)) && Number(li.qty) > 0 ? Number(li.qty) : 1;
    const cost = Number(li.unit_cost) || 0;
    return sum + (t - qty * cost - commFrac * t);
  }, 0));
}

/**
 * Split one total across weights so the parts sum EXACTLY to the total (the
 * last positive weight absorbs the rounding remainder). Used to allocate the
 * estimate's system sell price across its per-area line items, so the customer
 * page's line amounts always add up to the signed number. Zero/negative
 * weights get 0; an all-zero weight set puts everything on the first part.
 */
export function allocateProportionally(total, weights) {
  const t = Number(total) || 0;
  const ws = (Array.isArray(weights) ? weights : []).map((w) => (Number(w) > 0 ? Number(w) : 0));
  const wSum = ws.reduce((s, w) => s + w, 0);
  if (!ws.length) return [];
  if (!(wSum > 0)) return ws.map((_, i) => (i === 0 ? round2(t) : 0));
  const parts = ws.map((w) => round2((t * w) / wSum));
  const lastIdx = ws.reduce((best, w, i) => (w > 0 ? i : best), 0);
  const drift = round2(t - parts.reduce((s, p) => s + p, 0));
  parts[lastIdx] = round2(parts[lastIdx] + drift);
  return parts;
}

/**
 * Normalized name+address key. Requires BOTH fields so a blank name or address
 * can never produce a false match. Mirrors index.html's _nameAddrKey.
 */
export function jobNameAddrKey(name, addr) {
  const n = String(name == null ? '' : name).toLowerCase().replace(/\s+/g, ' ').trim();
  const a = String(addr == null ? '' : addr).toLowerCase().replace(/\s+/g, ' ').trim();
  return n && a ? n + '|' + a : '';
}

/**
 * defaultBasecoatByFlake map, sourced from the flake PRODUCT rows. The default
 * basecoat per flake lives ON the flake product (default_basecoat_product_id,
 * 2026-07-16 catalog reorg); pec_prod_color_pairings is retired (table kept in
 * the DB, dead, for reversibility). Every consumer of the map builds it here
 * so the source can never drift per call site.
 *
 * @param {Array<Object>} products  pec_prod_products rows
 * @returns {Object<string,string>} flake_product_id -> basecoat_product_id
 */
export function flakeBasecoatDefaults(products) {
  const out = {};
  for (const p of (products || [])) {
    if (p && p.material_type === 'Flake' && p.default_basecoat_product_id) out[p.id] = p.default_basecoat_product_id;
  }
  return out;
}

/**
 * Save-time validation for the product modal: a Flake product MUST carry a
 * default basecoat (so the estimator/job pickers can auto-fill it), except the
 * "Special Order Flake" placeholder, whose whole point is a per-job pick.
 * Returns the user-facing error string, or null when the payload is fine.
 * Existing flakes are grandfathered implicitly: this only runs on save.
 *
 * @param {Object} payload  { name, material_type, default_basecoat_product_id }
 */
export function flakeProductSaveError(payload) {
  if (!payload || payload.material_type !== 'Flake') return null;
  if (payload.name === 'Special Order Flake') return null;
  // Per-job-pick products (Standard Flake, Simiron Special Flake 40lb
  // (Standard)) carry no single blend, so no single pairing: the basecoat
  // comes from the picked COLOR (colors.default_basecoat_product_id,
  // prompt 57 Part G) or an explicit area pick.
  if (payload.color === 'Per-job pick') return null;
  if (payload.default_basecoat_product_id) return null;
  return 'Pick a default basecoat for this flake color.';
}

/**
 * Resolve a production job (pec_prod_jobs) to its CRM job card identity. The
 * reliable bridge is dripjobs_deal_id, but a MANUAL "+ Add Job" prod row has
 * none (deal NULL) even when the same customer exists as a bridged CRM job (the
 * two-parallel-job-tables shape). So we fall back to a normalized name+address
 * match. Deal match takes priority. Returns the CRM identity or null.
 *
 * @param {Object} prodJob  { dripjobs_deal_id, customer_name, address }
 * @param {Object} indexes  { byDeal: {dealId->ident}, byNameAddr: {key->ident} }
 */
export function resolveCrmForProdJob(prodJob, indexes) {
  if (!prodJob) return null;
  const byDeal = (indexes && indexes.byDeal) || {};
  const byNameAddr = (indexes && indexes.byNameAddr) || {};
  const deal = prodJob.dripjobs_deal_id;
  if (deal && byDeal[deal]) return byDeal[deal];
  const key = jobNameAddrKey(prodJob.customer_name, prodJob.address);
  return (key && byNameAddr[key]) || null;
}

// Custom-blend placeholders (a required swatch slot with no catalog product)
// are appended AFTER the merge, never routed through it: the merge keys on
// product_id (all-null placeholders would collapse Flake and Quartz into one
// group), its qty formula divides by spread_rate (zero here), and its
// sqft_total <= 0 guard would drop the line entirely. One line per
// material_type regardless of how many areas miss that swatch (qty 1, cost 0
// until priced in the line editor); area_ids carries the union for
// traceability. product_id stays null on purpose: it is the manual-line flag
// the line editor keys on to make unit cost editable.
function appendPlaceholderLines(lines, areaPlans) {
  const names = {
    'Flake': 'Custom blend flake (enter cost)',
    'Quartz': 'Custom blend quartz (enter cost)',
    'Metallic Pigment': 'Custom metallic pigment (enter cost)',
  };
  const byType = new Map();
  for (const p of areaPlans) {
    for (const m of (p.placeholders || [])) {
      if (!byType.has(m.material_type)) byType.set(m.material_type, { material_type: m.material_type, area_ids: [] });
      if (m.area_id) byType.get(m.material_type).area_ids.push(m.area_id);
    }
  }
  for (const p of byType.values()) {
    lines.push({
      material_type: p.material_type,
      product_id: null,
      product_name: names[p.material_type] || `Custom ${p.material_type} (enter cost)`,
      supplier: null,
      color: null,
      spread_rate: 0,
      kit_size: 1,
      qty_needed: 1,
      backstock_qty: 0,
      order_qty: 1,
      use_backstock: false,
      ordered: false,
      delivered: false,
      unit_cost_snapshot: 0,
      line_cost: 0,
      cure_speed: null,
      area_ids: p.area_ids,
      sqft_total: 0,
      order_index: lines.length,
    });
  }
}

function planForArea(area, ctx) {
  const { productsById, recipeSlotsBySystemType, defaultBasecoatByFlake, mvbProductId } = ctx;

  const sqft = Number(area.sqft);
  if (!Number.isFinite(sqft) || sqft < 0) {
    throw new CalculatorError(
      `Area "${area.name || area.id}": sqft must be a non-negative number`,
      'INVALID_SQFT'
    );
  }

  const slots = recipeSlotsBySystemType[area.system_type_id] || [];
  const slotLines = [];
  const placeholders = [];

  // Resolve the basecoat the area will use:
  // 1) explicit area.basecoat_product_id wins
  // 2) else the default pairing for the area's flake (if set)
  // 3) else fall back to the slot's default_product_id at slot-walk time
  const resolvedBasecoatId =
    area.basecoat_product_id ||
    (area.flake_product_id ? defaultBasecoatByFlake[area.flake_product_id] : null) ||
    null;

  for (const slot of slots) {
    // Choice / free-text recipe slots (e.g. "Single|Double broadcast", job
    // notes) carry no product, so they never contribute a material line and
    // must not trip the required-product check below. Mirrors index.html's
    // _planForArea; without this guard a required choice/text slot throws
    // MISSING_PRODUCT (or emits a phantom line), corrupting the material plan.
    if (slot.slot_kind === 'choice' || slot.slot_kind === 'text') continue;
    let productId = slot.default_product_id;

    if (slot.material_type === 'Flake' || slot.material_type === 'Quartz' || slot.material_type === 'Metallic Pigment') {
      // Flake / Quartz / Metallic Pigment colors are all picked per-job and
      // stored in the same area column (flake_product_id) as the user's
      // pick. The slot's material_type just gates which catalog products
      // the New Job picker shows for that system.
      productId = area.flake_product_id || productId;
    } else if (slot.material_type === 'Basecoat') {
      productId = resolvedBasecoatId || productId;
    } else if (slot.material_type === 'Topcoat') {
      // Topcoat works the same way basecoat does: explicit area override
      // wins, otherwise the slot's default product fills it.
      productId = area.topcoat_product_id || productId;
    }

    if (!productId) {
      if (slot.required) {
        // Swatch slots (Flake / Quartz / Metallic Pigment) can legitimately
        // have no catalog product: a custom blend mixed in-house. Those emit
        // a manual placeholder line (collected here, appended post-merge in
        // computeMaterialPlan) priced per job in the line editor. Basecoat /
        // Topcoat are always catalog products, so a missing one stays a hard
        // data error.
        const isSwatch = slot.material_type === 'Flake' || slot.material_type === 'Quartz' || slot.material_type === 'Metallic Pigment';
        if (!isSwatch) {
          throw new CalculatorError(
            `Area "${area.name || area.id}": ${slot.material_type} is required but no product was selected`,
            'MISSING_PRODUCT'
          );
        }
        placeholders.push({ material_type: slot.material_type, area_id: area.id || null });
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

    const spec = cureSpeedSpec(product);
    const cure_speed = spec ? (area[spec.areaField] || null) : null;

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
      cure_speed,
    });
  }

  // Per-area U-Tint Pack attachments. Quantity is the user-entered packs
  // count (NOT a sqft-derived number), so these lines carry a _tint_packs
  // marker and bypass the ceil(sqft/spread/kit) formula in mergeAcrossAreas.
  // order_index sorts them after every recipe slot so the work order reads
  // basecoat -> flake -> topcoat -> tints, in that order.
  const tints = Array.isArray(area.tints) ? area.tints : [];
  const lastSlotIndex = slots.length ? slots[slots.length - 1].order_index : 0;
  let tintOrder = lastSlotIndex + 1;
  for (const t of tints) {
    if (!t || !t.product_id) continue;
    const tProduct = productsById[t.product_id];
    if (!tProduct) {
      throw new CalculatorError(
        `Area "${area.name || area.id}": tint product ${t.product_id} not found in catalog`,
        'PRODUCT_NOT_FOUND'
      );
    }
    const packs = Number(t.packs);
    if (!Number.isFinite(packs) || packs <= 0) continue;
    slotLines.push({
      area_id: area.id || null,
      area_name: area.name || null,
      order_index: tintOrder++,
      material_type: 'Tint Pack',
      product_id: tProduct.id,
      product_name: tProduct.name,
      supplier: tProduct.supplier || null,
      color: tProduct.color || null,
      spread_rate: Number(tProduct.spread_rate) || 1,
      kit_size: Number(tProduct.kit_size) || 1,
      unit_cost: tProduct.unit_cost == null ? null : Number(tProduct.unit_cost),
      sqft: 0,
      cure_speed: null,
      _tint_packs: packs,
      _tint_attach_to: t.attach_to || null,
    });
  }

  // Per-area MVB adder: a moisture vapor barrier applied UNDER this area's
  // coating, at this area's sqft. order_index -1 sorts it to the top of the work
  // order (it goes down first). Skipped when the area's recipe already includes
  // the MVB product (the "MVB Only" system), so the two never double up.
  if (area.mvb === true && mvbProductId && sqft > 0) {
    const already = slotLines.some((l) => l.product_id === mvbProductId);
    if (!already) {
      const product = productsById[mvbProductId];
      if (!product) {
        throw new CalculatorError(
          `Area "${area.name || area.id}": MVB product ${mvbProductId} not found in catalog`,
          'PRODUCT_NOT_FOUND'
        );
      }
      const spread = Number(product.spread_rate);
      const kit = Number(product.kit_size);
      if (!Number.isFinite(spread) || spread <= 0) {
        throw new CalculatorError(
          `MVB product "${product.name}" has invalid spread_rate (${product.spread_rate}); fix it in the Catalog before pricing`,
          'INVALID_SPREAD_RATE'
        );
      }
      if (!Number.isFinite(kit) || kit <= 0) {
        throw new CalculatorError(
          `MVB product "${product.name}" has invalid kit_size (${product.kit_size}); fix it in the Catalog before pricing`,
          'INVALID_KIT_SIZE'
        );
      }
      slotLines.push({
        area_id: area.id || null,
        area_name: area.name || null,
        order_index: -1,
        material_type: product.material_type,
        product_id: product.id,
        product_name: product.name,
        supplier: product.supplier || null,
        color: product.color || null,
        spread_rate: spread,
        kit_size: kit,
        unit_cost: product.unit_cost == null ? null : Number(product.unit_cost),
        sqft,
        cure_speed: null,
      });
    }
  }

  return { area, lines: slotLines, placeholders };
}

function mergeAcrossAreas(areaPlans, productsById) {
  // Group by product_id so the same product across multiple areas becomes one
  // summed row. Lines with sqft=0 across all areas drop out per spec.
  const groups = new Map();

  for (const { lines } of areaPlans) {
    for (const line of lines) {
      // Two flavors of grouping share one Map: sqft-driven lines (recipe
      // slots) merge by product_id|cure_speed so two cure speeds for the
      // same product stay separate; pack-driven tint lines merge by
      // product_id alone so the same Tint Pack attached to two basecoats
      // in two areas comes out as one summed order line.
      const isTint = line._tint_packs != null;
      const key = isTint
        ? `tint:${line.product_id}`
        : `${line.product_id}|${line.cure_speed || ''}`;
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
          cure_speed: line.cure_speed || null,
          is_tint: isTint,
          sqft_total: 0,
          packs_total: 0,
          area_ids: [],
          first_order_index: line.order_index,
        });
      }
      const g = groups.get(key);
      if (isTint) g.packs_total += line._tint_packs;
      else g.sqft_total += line.sqft;
      if (line.area_id) g.area_ids.push(line.area_id);
      if (line.order_index < g.first_order_index) g.first_order_index = line.order_index;
    }
  }

  const merged = [];
  let i = 0;
  for (const g of groups.values()) {
    let qty;
    if (g.is_tint) {
      if (g.packs_total <= 0) continue;
      qty = g.packs_total;
    } else {
      if (g.sqft_total <= 0) continue;
      qty = Math.ceil(g.sqft_total / g.spread_rate / g.kit_size);
    }
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
      cure_speed: g.cure_speed,
      area_ids: g.area_ids,
      sqft_total: g.is_tint ? 0 : g.sqft_total,
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
