// Single source of truth for the estimate math. We import the CANONICAL pure
// functions from repo-root production/calculator.js (the same file the dashboard
// and `npm test` use) rather than reimplementing anything in the PWA.
import {
  computeEstimatePricing as _computeEstimatePricing,
  computeJobEstimate as _computeJobEstimate,
  computeMaterialPlan as _computeMaterialPlan,
  roundEstimatePrice as _roundEstimatePrice,
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
};

export type PricingResult = ReturnType<typeof _computeEstimatePricing>;

export const computeEstimatePricing = (input: PricingInput): PricingResult =>
  _computeEstimatePricing(input);
export const computeJobEstimate = _computeJobEstimate;
export const computeMaterialPlan = _computeMaterialPlan;
export const roundEstimatePrice = _roundEstimatePrice;
export const CALC_VERSION: string = _CALC_VERSION;
