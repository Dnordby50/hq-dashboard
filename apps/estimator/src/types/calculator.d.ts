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
}
