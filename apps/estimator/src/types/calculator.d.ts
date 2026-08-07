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
    sundriesPct?: number;
    sundriesDollars?: number;
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
  // Per-line pricing (prompt 69): same input shape as computeEstimatePricing,
  // same result shape PLUS `lines` (one solved entry per area) and errorArea.
  export function computePerLinePricing(input: unknown): ReturnType<typeof computeEstimatePricing> & {
    lines?: Array<{
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
    }>;
    errorArea?: string;
  };
  export function applyLineSellPrice(
    line: unknown,
    sellPrice: number,
    opts?: { commissionPct?: number; sundriesPct?: number; laborRate?: number },
  ): {
    sellPrice: number | null;
    laborDollars: number | null;
    commissionDollars: number | null;
    sundriesDollars: number | null;
    gpDollars: number | null;
    gpPct: number | null;
    budgetedHours: number | null;
    gpPerHour: number | null;
  };
  export function customLinePricing(input: {
    price: number | null;
    materialCost?: number;
    laborHours?: number;
    laborRate?: number;
    commissionPct?: number;
    sundriesPct?: number;
  }): {
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
    sundriesDollars: number | null;
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
  export function compGp(price: unknown, costing: unknown, agg?: unknown): { gpPct: number | null; complete: boolean };
  export function actualGpPct(price: unknown, costing: unknown, agg?: unknown): number | null;
  export function costingComplete(costing: unknown, agg?: unknown): boolean;
  export function joinCompsSources(jobs: unknown[], prodJobs: unknown[], costings: unknown[], aggregates?: unknown): Array<{
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
    // comps_min_sample (prompt 70): below it the exact rule widens to
    // same-system any-size. The system filter itself is HARD: the ladder
    // never crosses systems.
    minSample?: number;
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

// Canonical job-costing GP formula (repo-root production/costing.js), shared
// by the dashboard (byte-identical mirror), Metrics, and the comps engine.
declare module '*/production/costing.js' {
  export function computeCostingRow(
    job: unknown,
    cost: unknown,
    sysName: unknown,
    derivedOrderedCost?: number | null,
    derivedUsedCost?: number | null,
    derivedBonusCost?: number | null,
    derived?: unknown,
  ): {
    revenue: number;
    buckets: Record<string, number>;
    totalVar: number;
    gp: number;
    gpPct: number | null;
    actHrs: number;
  };
  export function buildCostAggregates(
    sources: {
      materialLines: unknown[];
      bonuses: unknown[];
      timeEntries: unknown[];
      crewMembers: unknown[];
      manualLabor: unknown[];
      costings: unknown[];
    },
    opts?: { burden?: number; otMultiplier?: number; defaultRate?: number },
  ): {
    orderedByJob: Record<string, number>;
    usedByJob: Record<string, number>;
    bonusByJob: Record<string, number>;
    laborByJob: Record<string, { laborCost: number; actHrs: number }>;
  };
}

// Per-line AI recommendation logic (repo-root production/ai-lines.cjs,
// prompt 70), shared with pec-estimate-ai.cjs so the inputs key and the
// confidence semantics are one implementation.
declare module '*/production/ai-lines.cjs' {
  export const MIN_COMPS_SAMPLE: number;
  export const CONFIDENCE_LABELS: Record<string, string>;
  export const NO_COMPS_STATEMENT: string;
  export function lineConfidence(comps: { sample_size?: number } | null | undefined, minSample?: number): 'comps_backed' | 'thin_sample' | 'no_comps';
  export function scopeHash(text: unknown): string;
  export function linesInputsKey(lines: Array<{
    kind?: string;
    system_type_id?: string | null;
    sqft?: number | null;
    mvb?: boolean;
    calc_price?: number | null;
    scope_text?: string | null;
  }>): string;
}

// Optional-lines money rules (repo-root production/optional-lines.cjs,
// prompt 72), shared with pec-public-estimate.cjs and the fixture tests.
declare module '*/production/optional-lines.cjs' {
  export const SEND_GATE_MESSAGE: string;
  export function isOptionalLine(li: unknown): boolean;
  export function isDeclinedLine(li: unknown): boolean;
  export function splitLineTotals(items: Array<{ total: number; is_optional?: boolean; selected_by_customer?: boolean }>): {
    requiredOnly: number;
    allIn: number;
    opening: number;
  };
  export function sendGateError(items: unknown[]): string | null;
  export function acceptSelectionInvalid(items: unknown[]): boolean;
  export function declinedAreaIdSet(items: unknown[]): Set<string>;
  export function filterAreasForJob<A>(areas: A[], declinedIds: Set<string> | string[]): A[];
  export function declinedNoteLine(declinedLines: unknown[]): string | null;
  export function selectedScopeDoc(includedLines: unknown[]): string;
  export function optionalControlsVisible(enabled: boolean | undefined, isOptional: boolean | undefined): boolean;
}

// Estimate-side payment schedule math (repo-root
// production/estimate-installments.cjs, prompt 74), shared with
// pec-public-estimate.cjs and the fixture tests. All money in cents.
declare module '*/production/estimate-installments.cjs' {
  export interface ScheduleRowShared {
    seq: number;
    label: string;
    amount_kind: 'fixed' | 'percent';
    amount_value: number;
    trigger_kind: string;
    due_date: string | null;
    is_deposit: boolean;
  }
  export function resolveDepositPct(systemDepositPct: unknown, settingDepositPct: unknown): number;
  export function defaultScheduleRows(depositPct: number): ScheduleRowShared[];
  export function scheduleValidationError(rows: ScheduleRowShared[], totalCents: number): { message: string; diffCents: number } | null;
  export function computeScheduleCents(rows: ScheduleRowShared[], totalCents: number, originalTotalCents?: number): number[];
  export function freezeSchedule(rows: ScheduleRowShared[], totalCents: number): Array<ScheduleRowShared & { computed_amount: number }>;
  export function scheduleSumsToTotal(cents: number[], totalCents: number): boolean;
  export function triggerLabel(triggerKind: string, dueDate?: string | null): string;
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

// Card-first draft + salesperson default rules (repo-root
// production/estimate-draft.cjs, prompt 47), shared with the fixture tests so
// the tested logic is the logic the screen runs.
declare module '*/production/estimate-draft.cjs' {
  export interface DraftFields {
    isCommercial: boolean;
    company: string;
    lastName: string;
    phone: string;
    email: string;
    address1: string;
    salespersonId: string;
  }
  export function missingDraftFields(fields: DraftFields): string[];
  export function draftReady(fields: DraftFields): boolean;
  export function createDraftTrigger(opts?: { alreadyPersisted?: boolean }): {
    signal(fields: DraftFields, opts?: { initial?: boolean }): boolean;
    reset(): void;
  };
  export function defaultSalespersonId(args: {
    editingSalespersonId?: string | null;
    salespeople: Array<{ id: string; auth_user_id?: string | null }>;
    currentUserId?: string | null;
  }): string;
  export function userUnmapped(
    salespeople: Array<{ id: string; auth_user_id?: string | null }>,
    currentUserId?: string | null,
  ): boolean;
  export function estimateIdForSave(editingId: string | null | undefined, draftId: string): string;
  // Prompt 61 Part B: seed the create-path Main area when an edited estimate
  // (a dashboard-created draft) has no areas.
  export function initialAreas<A>(args: { editingAreas: A[] | null; makeDefaultArea: () => A }): A[];
}

// Outbox drain policy (repo-root production/outbox-drain.cjs, prompt 48):
// retry backoff + skip-children-of-a-failed-parent, shared with the fixture
// tests so the tested policy is the policy the sync loop runs.
declare module '*/production/outbox-drain.cjs' {
  export interface DrainOp {
    opId: string;
    id: string;
    row: Record<string, unknown>;
    attempts: number;
    nextAttemptAt?: string;
  }
  export function backoffMs(attempts: number): number;
  export function nextAttemptAfterFailure(attempts: number, nowMs: number): string;
  export function isDue(op: DrainOp, nowMs: number, force?: boolean): boolean;
  export function referencesUnavailable(op: DrainOp, unavailableIds: Set<string>): boolean;
  export function drainPass<T extends DrainOp>(
    ops: T[],
    deps: {
      upsert(op: T): Promise<string | null>;
      markError(op: T, message: string, nextAttemptAt: string): unknown;
      removeOp(opId: string): unknown;
      now(): number;
    },
    opts?: { force?: boolean },
  ): Promise<{ synced: number; failed: number; blocked: number; deferred: number }>;
}
