// Ambient declaration for the canonical, plain-JS estimate engine that lives
// outside this app (repo-root production/calculator.js). The PWA imports it
// directly so there is exactly ONE copy of the estimate math. The wildcard
// matches the relative specifier used in src/lib/calculator.ts.
declare module '*/production/calculator.js' {
  export const CALC_VERSION: string;
  export class CalculatorError extends Error {
    code: string;
  }
  export function cureSpeedSpec(product: unknown): { areaField: string; options: string[] } | null;
  export function computeMaterialPlan(input: unknown): { lines: unknown[]; areaPlans: unknown[] };
  export function computeJobEstimate(input: unknown): {
    materialLines: unknown[];
    materialsBudget: number;
    laborPct: number | null;
    laborBudget: number | null;
    budgetedHours: number | null;
    planError: string | null;
  };
  export function computeEstimatePricing(input: unknown): {
    price?: number;
    priceRaw?: number;
    materialsCost?: number;
    fixedAddons?: number;
    laborPct?: number;
    laborBudget?: number | null;
    laborDollars?: number;
    commissionPct?: number; // standard rate, echoed
    standardCommissionPct?: number;
    actualCommissionPct?: number;
    commissionDollars?: number; // budgeted (standard) commission $
    commissionPayout?: number; // actual rep payout $
    gpVariance?: number; // (standard - actual)% * price
    targetGpPct?: number;
    gpDollars?: number; // budgeted GP at standard
    gpPct?: number | null;
    realizedGp?: number; // budgeted GP + variance
    realizedGpPct?: number | null;
    gpPerHour?: number | null;
    budgetedHours?: number | null;
    materialLines?: { unit_cost_snapshot: number | null; product_name: string }[] | unknown[];
    materialsMissingCost?: string[];
    divisor?: number;
    calcVersion: string;
    error: string | null;
  };
  export function roundEstimatePrice(
    priceRaw: number,
    opts?: { increment?: number; charmThreshold?: number; charmBand?: number },
  ): number;
  export function lineItemsTotal(items: unknown[], opts?: { withAllOptions?: boolean }): number;
  export function lineItemsGp(items: unknown[], standardCommissionPct?: number, opts?: { withAllOptions?: boolean }): number;
  export function allocateProportionally(total: number, weights: number[]): number[];
  export function applySellPrice(
    pricing: unknown,
    sellPrice: number,
  ): {
    sellPrice: number | null;
    discountPct: number | null;
    laborDollars: number | null;
    commissionDollars: number | null;
    gpDollars: number | null;
    gpPct: number | null;
    budgetedHours: number | null;
    gpPerHour: number | null;
  };
}

// Ambient declaration for the canonical comps engine (repo-root
// production/comps.js), same one-copy-of-the-math posture as the calculator.
declare module '*/production/comps.js' {
  export function parseSqft(text: unknown): number | null;
  export function median(nums: Array<number | null>): number | null;
  export function actualGpPct(price: unknown, costing: unknown): number | null;
  export function costingMaterials(costing: unknown): number;
  export function costingComplete(costing: unknown): boolean;
  export function joinCompsSources(jobs: unknown[], prodJobs: unknown[], costings: unknown[]): Array<{
    id: string;
    customer_name: string | null;
    system_type_id: string | null;
    completed_date: string | null;
    sqft: number | null;
    price: number | null;
    ppsf: number | null;
    gp_pct: number | null;
    gp_complete: boolean;
  }>;
  export function buildComps(input: {
    candidates: unknown[];
    systemTypeId: string | null;
    sqft: number | null;
    now: Date | number;
  }): {
    rule: string;
    sample_size: number;
    exact_count: number;
    complete_count: number;
    gp_pct_count: number;
    median_ppsf: number | null;
    rows: Array<{
      id: string;
      customer_name: string | null;
      system_type_id: string | null;
      completed_date: string | null;
      sqft: number | null;
      price: number | null;
      ppsf: number | null;
      gp_pct: number | null;
      gp_complete: boolean;
    }>;
    target_sqft: number | null;
  };
  export function compsRuleLabel(comps: unknown, systemName?: string | null): string;
  export function compsGpCaveat(comps: unknown): string | null;
}

// Canonical BLANK-placeholder logic (repo-root production/scope.cjs), shared
// with pec-estimate-scope.cjs so answer keys match across client and server.
declare module '*/production/scope.cjs' {
  export interface ScopeQuestion {
    key: string;
    label: string;
    context: string;
    contextLabel: string | null;
    index?: number;
  }
  export function containsBlank(text: unknown): boolean;
  export function detectBlanks(text: unknown, contextLabel?: string | null): ScopeQuestion[];
  export function applyAnswers(text: unknown, answersByKey: Record<string, string>, contextLabel?: string | null): string;
  export function openQuestions(
    sources: Array<{ text: unknown; contextLabel?: string | null }>,
    answersByKey: Record<string, string>,
  ): ScopeQuestion[];
  export function stableKey(contextLabel: string, context: string, ordinal?: number): string;
}
