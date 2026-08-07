// Single source of truth for the estimate math. We import the CANONICAL pure
// functions from repo-root production/calculator.js (the same file the dashboard
// and `npm test` use) rather than reimplementing anything in the PWA.
import {
  computeEstimatePricing as _computeEstimatePricing,
  computePerLinePricing as _computePerLinePricing,
  applyLineSellPrice as _applyLineSellPrice,
  customLinePricing as _customLinePricing,
  computeJobEstimate as _computeJobEstimate,
  computeMaterialPlan as _computeMaterialPlan,
  roundEstimatePrice as _roundEstimatePrice,
  applySellPrice as _applySellPrice,
  lineItemsTotal as _lineItemsTotal,
  lineItemsGp as _lineItemsGp,
  allocateProportionally as _allocateProportionally,
  CALC_VERSION as _CALC_VERSION,
} from '../../../../production/calculator.js';

// An area in the shape computeJobEstimate / computeEstimatePricing expect.
export type Area = {
  id?: string;
  name?: string;
  sqft: number;
  system_type_id: string;
  flake_product_id?: string | null;
  basecoat_product_id?: string | null;
  topcoat_product_id?: string | null;
  basecoat_cure_speed?: string | null;
  topcoat_cure_speed?: string | null;
  mvb?: boolean;
};

export type Product = {
  id: string;
  name: string;
  material_type: string;
  supplier?: string | null;
  color?: string | null;
  spread_rate: number;
  kit_size: number;
  unit_cost: number | null;
};

export type SystemType = {
  id: string;
  name: string;
  labor_budget_pct: number | null;
  target_gp_pct?: number | null;
  active?: boolean;
  scope_template?: string | null;
  scope_template_mvb?: string | null;
  // Per-system deposit percent (prompt 74): seeds the payment-schedule card's
  // default deposit row, same precedence prepareDepositInstallment uses.
  deposit_pct?: number | null;
};

export type RecipeSlot = {
  id: string;
  system_type_id: string;
  order_index: number;
  material_type: string;
  slot_kind?: 'product' | 'multi_product' | 'choice' | 'text';
  label?: string | null;
  default_product_id?: string | null;
  required?: boolean;
  editor_hidden?: boolean | null;
  options?: unknown;
};

export type PricingInput = {
  areas: Area[];
  productsById: Record<string, Product>;
  recipeSlotsBySystemType: Record<string, RecipeSlot[]>;
  defaultBasecoatByFlake?: Record<string, string>;
  systemTypes: SystemType[];
  laborRate: number;
  commissionPct: number; // STANDARD house commission PERCENT, baked into the price
  actualCommissionPct?: number | null; // assigned rep's actual PERCENT (payout + variance only)
  targetGpPct: number; // PERCENT
  fixedAddons?: number;
  priceIncrement?: number;
  charmThreshold?: number;
  charmBand?: number;
  sundriesPct?: number; // sundries + disposables as % of total cost (build 17)
  // MVB is per-area (build 17): each area with mvb=true adds this product at its
  // own sqft. An MVB-only job is a normal area on the "MVB Only" system.
  mvbProductId?: string | null;
};

export type PricingResult = ReturnType<typeof _computeEstimatePricing>;
export type SellPriceResult = ReturnType<typeof _applySellPrice>;

// One solved calculator line from computePerLinePricing (prompt 69): the
// area's own cost-plus price at its own system's labor% and target GP%, with
// its attributed share of the ONE estimate-wide (kit-merged) material cost.
export type PricedLine = {
  areaId: string | null;
  index: number;
  name: string;
  systemTypeId: string;
  sqft: number;
  materialsCost: number;
  fixedAddons: number;
  laborPct: number;
  targetGpPct: number;
  divisor: number;
  priceRaw: number;
  price: number;
  laborDollars: number;
  commissionDollars: number;
  sundriesDollars: number;
  gpDollars: number;
  gpPct: number | null;
  budgetedHours: number | null;
  gpPerHour: number | null;
};

// computePerLinePricing returns the computeEstimatePricing shape (so the
// screen's downstream money code keeps working) PLUS `lines`, and names the
// offending area on TARGET_UNREACHABLE / NO_LABOR_PCT via errorArea.
export type PerLinePricingResult = PricingResult & {
  lines?: PricedLine[];
  errorArea?: string;
};

export type LineSellResult = {
  sellPrice: number | null;
  laborDollars: number | null;
  commissionDollars: number | null;
  sundriesDollars: number | null;
  gpDollars: number | null;
  gpPct: number | null;
  budgetedHours: number | null;
  gpPerHour: number | null;
};

export type CustomLineMoney = {
  price: number | null;
  materialsCost: number | null;
  laborDollars: number | null;
  commissionDollars: number | null;
  sundriesDollars: number | null;
  gpDollars: number | null;
  gpPct: number | null;
  budgetedHours: number | null;
  gpPerHour: number | null;
};

// Money shape lineItemsTotal / lineItemsGp accept (matches estimate_line_items
// rows; the legacy jsonb `optional` key is also tolerated by the canonical fns).
export type MoneyLineItem = {
  total: number;
  qty?: number;
  unit_cost?: number;
  is_optional?: boolean;
  selected_by_customer?: boolean;
};

export const computeEstimatePricing = (input: PricingInput): PricingResult =>
  _computeEstimatePricing(input);
export const computePerLinePricing = (input: PricingInput): PerLinePricingResult =>
  _computePerLinePricing(input) as PerLinePricingResult;
export const applyLineSellPrice = (
  line: PricedLine,
  sellPrice: number,
  opts: { commissionPct?: number; sundriesPct?: number; laborRate?: number },
): LineSellResult => _applyLineSellPrice(line, sellPrice, opts) as LineSellResult;
export const customLinePricing = (input: {
  price: number | null;
  materialCost?: number;
  laborHours?: number;
  laborRate?: number;
  commissionPct?: number;
  sundriesPct?: number;
}): CustomLineMoney => _customLinePricing(input) as CustomLineMoney;
export const computeJobEstimate = _computeJobEstimate;
export const computeMaterialPlan = _computeMaterialPlan;
export const roundEstimatePrice = _roundEstimatePrice;
export const applySellPrice = _applySellPrice;
export const lineItemsTotal = (items: MoneyLineItem[], opts?: { withAllOptions?: boolean }): number =>
  _lineItemsTotal(items, opts);
export const lineItemsGp = (items: MoneyLineItem[], standardCommissionPct?: number, opts?: { withAllOptions?: boolean }): number =>
  _lineItemsGp(items, standardCommissionPct, opts);
export const allocateProportionally = (total: number, weights: number[]): number[] =>
  _allocateProportionally(total, weights);
export const CALC_VERSION: string = _CALC_VERSION;
