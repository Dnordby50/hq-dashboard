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
export const CALC_VERSION = '2026-06-21.2';

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
  standaloneMvb = false,
  standaloneMvbProductId = null,
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

  // Job-level standalone MVB: one extra synthetic area whose only "slot" is
  // the MVB product, applied to total sqft across all real areas. Folded into
  // mergeAcrossAreas so it shows up as a single line in the order. Does not
  // override the in-Metallic-system MVB; that one comes from the recipe.
  if (standaloneMvb && standaloneMvbProductId) {
    const product = productsById[standaloneMvbProductId];
    if (!product) {
      throw new CalculatorError(
        `Standalone MVB product ${standaloneMvbProductId} not found in catalog`,
        'PRODUCT_NOT_FOUND'
      );
    }
    const totalSqft = areas.reduce((s, a) => s + (Number(a.sqft) > 0 ? Number(a.sqft) : 0), 0);
    if (totalSqft > 0) {
      areaPlans.push({
        area: { id: '_standalone_mvb', name: 'Standalone MVB', sqft: totalSqft },
        lines: [{
          area_id: null,
          area_name: 'Standalone MVB',
          order_index: -1, // sorts to top of the order
          material_type: product.material_type,
          product_id: product.id,
          product_name: product.name,
          supplier: product.supplier || null,
          color: product.color || null,
          spread_rate: Number(product.spread_rate),
          kit_size: Number(product.kit_size),
          unit_cost: product.unit_cost == null ? null : Number(product.unit_cost),
          sqft: totalSqft,
          cure_speed: null,
        }],
      });
    }
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
}) {
  // Strip everything but the estimate-relevant fields. Dropping topcoat_product_id
  // is deliberate: the front-end Budget card never passes it, so the topcoat
  // slot default is used in both places.
  const planAreas = (areas || []).map((a) => {
    const sqftNum = Number(a.sqft);
    return {
      id: a.id,
      name: a.name,
      sqft: Number.isFinite(sqftNum) && sqftNum >= 0 ? sqftNum : 0,
      system_type_id: a.system_type_id,
      flake_product_id: a.flake_product_id || null,
      basecoat_product_id: a.basecoat_product_id || null,
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
 *   1. Pass 1 at revenue:0 gets M (materialsBudget is revenue-independent) and
 *      laborPct from the primary system.
 *   2. Resolve targetGP% and commission% (per-system override on the primary
 *      system wins over the passed global). All three rates are PERCENTS.
 *   3. divisor = 1 - laborFrac - commFrac - targetGpFrac. If divisor <= 0 the
 *      target is mathematically impossible: return an error, never divide.
 *   4. priceRaw = (M + F) / divisor; round UP to priceIncrement so rounding
 *      never drops realized GP below target.
 *   5. Pass 2 at the rounded price gets laborBudget + budgetedHours, then
 *      recompute the money buckets at the rounded price so the displayed GP$,
 *      GP%, commission$ all agree with the shown price.
 *
 * @param {Object} input  Same area-set inputs as computeJobEstimate, plus:
 * @param {number} input.commissionPct  commission as a PERCENT of revenue (e.g. 8)
 * @param {number} input.targetGpPct    target gross-profit PERCENT (e.g. 50)
 * @param {number} input.fixedAddons    F: direct add-ons not proportional to revenue (default 0)
 * @param {number} input.priceIncrement round price up to this increment (default 25)
 * @returns {Object} { price, priceRaw, materialsCost, fixedAddons, laborPct,
 *   laborBudget, laborDollars, commissionPct, commissionDollars, targetGpPct,
 *   gpDollars, gpPct, gpPerHour, budgetedHours, materialLines, divisor,
 *   calcVersion, error } - on failure, { error, ... , calcVersion } with error
 *   one of the planError string, 'NO_LABOR_PCT', or 'TARGET_UNREACHABLE'.
 */
export function computeEstimatePricing({
  areas,
  productsById,
  recipeSlotsBySystemType,
  defaultBasecoatByFlake = {},
  systemTypes = [],
  laborRate = 0,
  commissionPct = 0,
  targetGpPct = 50,
  fixedAddons = 0,
  priceIncrement = 5,
  charmThreshold = 1000,
  charmBand = 250,
}) {
  // Pass 1: materials cost M is independent of revenue, so price at revenue:0.
  const base = computeJobEstimate({
    areas, productsById, recipeSlotsBySystemType, defaultBasecoatByFlake,
    systemTypes, revenue: 0, laborRate,
  });
  if (base.planError) {
    return { error: base.planError, materialLines: base.materialLines, calcVersion: CALC_VERSION };
  }
  if (base.laborPct == null) {
    // No primary system / no labor_budget_pct: cannot solve cost-plus on labor.
    return { error: 'NO_LABOR_PCT', materialLines: base.materialLines, calcVersion: CALC_VERSION };
  }

  const M = Number(base.materialsBudget) || 0;
  const F = Number(fixedAddons) || 0;

  // Target GP can be overridden per system; commission is NOT per system, it is
  // the assigned salesperson's rate (pec_sales_team_members.commission_pct),
  // which the caller resolves and passes in as commissionPct. So commission
  // comes straight from the input, never from the system row.
  const primary = (areas && areas[0])
    ? (systemTypes || []).find((s) => s.id === areas[0].system_type_id)
    : null;
  const targetGp = primary && primary.target_gp_pct != null ? Number(primary.target_gp_pct) : Number(targetGpPct);
  const commPct = Number(commissionPct) || 0;

  const laborFrac = Number(base.laborPct) / 100;
  const commFrac = commPct / 100;
  const gpFrac = targetGp / 100;
  const divisor = 1 - laborFrac - commFrac - gpFrac;
  if (!(divisor > 0)) {
    // labor + commission + target margin consume >= 100% of revenue: impossible.
    return { error: 'TARGET_UNREACHABLE', divisor, materialLines: base.materialLines, calcVersion: CALC_VERSION };
  }

  const priceRaw = (M + F) / divisor;
  const price = roundEstimatePrice(priceRaw, { increment: priceIncrement, charmThreshold, charmBand });

  // Pass 2: feed the rounded price back for labor budget + budgeted hours.
  const atPrice = computeJobEstimate({
    areas, productsById, recipeSlotsBySystemType, defaultBasecoatByFlake,
    systemTypes, revenue: price, laborRate,
  });

  // Recompute money buckets at the ROUNDED price so display is internally
  // consistent (same bucket set as computeCostingRow: materials, labor,
  // commission, plus fixed add-ons; other buckets are 0 at estimate time).
  const commissionDollars = round2(commFrac * price);
  const laborDollars = round2(laborFrac * price);
  const gpDollars = round2(price - (M + laborDollars + commissionDollars + F));
  const gpPct = price > 0 ? gpDollars / price : null;
  const budgetedHours = atPrice.budgetedHours;
  const gpPerHour = budgetedHours != null && budgetedHours > 0 ? round2(gpDollars / budgetedHours) : null;

  return {
    price,
    priceRaw: round2(priceRaw),
    materialsCost: M,
    fixedAddons: F,
    laborPct: Number(base.laborPct),
    laborBudget: atPrice.laborBudget,
    laborDollars,
    commissionPct: commPct,
    commissionDollars,
    targetGpPct: targetGp,
    gpDollars,
    gpPct,
    gpPerHour,
    budgetedHours,
    materialLines: base.materialLines,
    divisor,
    calcVersion: CALC_VERSION,
    error: null,
  };
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
