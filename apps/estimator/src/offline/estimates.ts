import { idbPut } from './idb';
import { enqueue } from './outbox';
import { uuid } from './uuid';
import type { PricingResult } from '../lib/calculator';
import { composeCustomerAddress, composeCustomerName, type CustomerForm } from '../lib/customer';

// One per-area material/answer row (mirrors public.estimate_area_materials).
export type AreaMaterialInput = {
  recipe_slot_id: string | null;
  slot_label: string | null;
  slot_kind: string | null;
  material_type: string | null;
  product_id: string | null;
  choice_value: string | null;
  text_value: string | null;
  pick_index: number;
  order_index: number;
};

export type AreaInput = {
  name: string;
  sqft: number;
  systemTypeId: string;
  flakeProductId: string | null;
  basecoatProductId: string | null;
  topcoatProductId: string | null;
  mvb: boolean; // per-area moisture vapor barrier (build 17)
  answers: Record<string, string>; // raw slotId -> value (audit / re-open)
  materials: AreaMaterialInput[];
};

// The one line item a CUSTOM estimate always carries (build 24): it holds the
// typed price + scope so the public proposal page and the PDF render a row
// with zero special-casing. The label doubles as the discriminator the edit
// loader uses to keep this line OUT of the add-on forms (it is regenerated
// from custom_scope/custom_price on every save, like system lines are from
// areas), so it must stay in sync with estimateLoad.ts.
export const CUSTOM_LINE_LABEL = 'Custom scope of work';

// One estimate line item, written as a ROW to public.estimate_line_items
// (2026-07-13; the jsonb estimates.line_items is legacy-frozen). is_optional
// lines are EXCLUDED from the total until selected_by_customer. areaIndex
// binds a system line to its area: the estimate_areas ids are minted inside
// saveEstimateOffline, so the caller points at the area by position and the
// save resolves it to the real FK.
export type LineItemInput = {
  addonId: string | null; // pec_prod_addons id; null = system/area line or one-off
  areaIndex: number | null; // index into args.areas; null = add-on / one-off / MVB
  label: string;
  description: string | null;
  qty: number;
  unitPrice: number;
  unitCost: number;
  total: number;
  isOptional: boolean;
  selectedByCustomer: boolean;
  sortOrder: number;
};

// The money written onto the estimate row, computed by the screen so what is
// stored is exactly what was displayed: system sell price (engine price or the
// rep's override) PLUS non-optional add-on lines, with GP net of add-on costs
// and commission. Optional lines stay out until the customer ticks them.
export type EstimateTotals = {
  // Null on the EARLY draft save (prompt 47): the card exists before a price
  // does. The full Save always writes a real number.
  price: number | null;
  gpDollars: number | null;
  gpPct: number | null;
  gpPerHour: number | null;
  laborBudget: number | null;
  commissionDollars: number | null;
  budgetedHours: number | null;
};

export type SaveEstimateArgs = {
  // Set when EDITING an existing estimate: the same id makes the outbox upsert
  // an in-place update (decision: reopening edits in place, no version rows).
  estimateId?: string | null;
  // Preserved on edit so reopening a sent estimate cannot silently reset it to
  // draft. New estimates pass 'draft'.
  status: string;
  // The DOMINANT area's system (most sqft) for reporting; every area prices
  // with its own system via estimate_areas.system_type_id. Null on a custom
  // estimate (build 24): there is no system, and writing one would be a lie
  // the metrics attribute revenue to.
  systemTypeId: string | null;
  salesperson: { id: string; name: string; commission_pct: number };
  intake: Record<string, unknown>; // work-order fields
  // Split shape (build 23). The combined customer_name / customer_address
  // columns are composed HERE on every save (including offline ones), so the
  // safety-net values always ride the outbox with the split fields.
  customer: CustomerForm;
  flakeColor: string | null;
  // Rep's answers to the templates' BLANK placeholders, keyed by context hash
  // (15c). The scope writer substitutes these before the model call.
  scopeAnswers: Record<string, string>;
  lineItems: LineItemInput[];
  pricingSnapshot: Record<string, unknown> | null; // comps + AI read that priced it
  areas: AreaInput[];
  // Null on a custom estimate (build 24): no engine ran, so there is no
  // engine snapshot to write. The engine columns land null on the row.
  pricing: PricingResult | null;
  totals: EstimateTotals;
  // Custom estimate mode (build 24). When isCustom, customScope/customPrice
  // are the typed truth AND compose the standard downstream columns:
  // custom_price is already inside totals.price (the caller adds the add-on
  // lines) and custom_scope is written to scope_of_work directly, with
  // scope_edited_at stamped so the AI scope writer's never-overwrite rule
  // protects the typed text from a regenerate.
  isCustom?: boolean;
  customScope?: string | null;
  customPrice?: number | null;
  // Typed square footage for a custom estimate (prompt 32): display-only $/sqft
  // in the estimator, carried to jobs.sqft on accept. Optional; null when not
  // typed. Standard estimates keep sqft on their area rows and pass null.
  customSqft?: number | null;
  // Internal crew brief (prompt 32, Part B), BOTH modes: typed or AI-drafted
  // on the estimator, copied to jobs.crew_notes on accept, printed on the crew
  // work order only. Never customer-facing.
  crewNotes?: string | null;
  // The engine's computed price (calc_price) and the manual-override provenance
  // (build 17). calcPrice keeps the math; totals.price is what actually sells.
  calcPrice: number | null;
  priceOverride: { reason: string; by: string | null } | null;
  createdBy: string | null;
  // Set when the estimator was opened from a lead (/estimator/?lead_id=<uuid>).
  // Null for a walk-up estimate with no lead behind it.
  leadId: string | null;
  // True when editing an estimate whose scope a HUMAN edited (scope_edited_at
  // set): the save marks the scope stale instead of regenerating, so the UI can
  // offer the explicit Regenerate click. Never set on new estimates.
  markScopeStale?: boolean;
  // Live proposal panel, STANDARD mode (build 25): the rep edited the
  // assembled proposal text right in the estimator, so the edited document
  // rides this save. Written with the hand-edited stamp (scope_edited_at) so
  // the server's never-overwrite rule protects it, the same lock custom mode
  // uses. Null (the usual case) leaves every scope column alone.
  editedScope?: string | null;
};

// Persist an estimate offline: write a local copy of the parent first (durable +
// readable offline), then enqueue the parent and its children IN ORDER so the
// FIFO outbox uploads estimates -> estimate_areas (-> estimate_area_materials)
// -> estimate_line_items, satisfying the foreign keys (line items reference
// their area, so they go last). All ids are client-minted, so sync is
// idempotent.
//
// estimate_number is NEVER written from here: the column's Postgres sequence
// default assigns it on insert (concurrency-safe), and the upsert's
// on-conflict update only touches supplied columns, so a replay or an edit can
// never renumber a row.
export async function saveEstimateOffline(args: SaveEstimateArgs): Promise<{ id: string }> {
  const estimateId = args.estimateId || uuid();
  const now = new Date().toISOString();
  const p = args.pricing; // null on a custom estimate: engine columns land null
  const t = args.totals;
  const isCustom = args.isCustom === true;
  const customScope = isCustom ? (args.customScope ?? '').trim() || null : null;
  const customPrice = isCustom ? args.customPrice ?? null : null;

  const estimateRow: Record<string, unknown> = {
    id: estimateId,
    system_type_id: args.systemTypeId,
    // Carries through the outbox unchanged, so an estimate written offline at a
    // job site still lands attached to its lead when the phone gets signal.
    lead_id: args.leadId ?? null,
    status: args.status,
    intake: {
      ...args.intake,
      salesperson_id: args.salesperson.id,
      salesperson_name: args.salesperson.name,
    },
    // Combined columns first (composed safety net), then the split truth.
    // customer_is_commercial is always a real boolean from the toggle; the
    // backfill leaves it null, which is how backfilled rows stay tellable
    // apart from rows a rep actually saved.
    customer_name: composeCustomerName(args.customer),
    customer_phone: args.customer.phone.trim() || null,
    customer_email: args.customer.email.trim() || null,
    customer_address: composeCustomerAddress(args.customer),
    customer_first_name: args.customer.firstName.trim() || null,
    customer_last_name: args.customer.lastName.trim() || null,
    customer_company: args.customer.company.trim() || null,
    customer_is_commercial: args.customer.isCommercial || !!args.customer.company.trim(),
    customer_address1: args.customer.address1.trim() || null,
    customer_address2: args.customer.address2.trim() || null,
    customer_city: args.customer.city.trim() || null,
    customer_state: args.customer.state.trim() || null,
    customer_zip: args.customer.zip.trim() || null,
    // estimates.mvb is FROZEN (build 17): MVB is per-area now. Always 'none'.
    mvb: 'none',
    flake_color: args.flakeColor,
    scope_answers: args.scopeAnswers || {},
    pricing_snapshot: args.pricingSnapshot as unknown,
    // Custom mode (build 24): the flag and the typed truth. Written on EVERY
    // save (null when standard) so toggling custom off clears them.
    is_custom: isCustom,
    custom_scope: customScope,
    custom_price: customPrice,
    custom_sqft: isCustom ? args.customSqft ?? null : null,
    // Written on every save (null when blank) so clearing the field persists.
    crew_notes: (args.crewNotes ?? '').trim() || null,
    materials_cost: p?.materialsCost ?? null,
    fixed_addons: p?.fixedAddons ?? 0,
    labor_pct: p?.laborPct ?? null,
    commission_pct: p?.commissionPct ?? null,
    target_gp_pct: p?.targetGpPct ?? null,
    // calc_price is the engine number; price is what actually sells (override
    // or not). price_override_* is the provenance when a human moved the number.
    calc_price: args.calcPrice,
    price_override_reason: args.priceOverride ? args.priceOverride.reason : null,
    price_overridden_by: args.priceOverride ? args.priceOverride.by : null,
    price_overridden_at: args.priceOverride ? now : null,
    price: t.price,
    gp_dollars: t.gpDollars,
    gp_pct: t.gpPct,
    gp_per_hour: t.gpPerHour,
    labor_budget: t.laborBudget,
    commission_dollars: t.commissionDollars,
    budgeted_hours: t.budgetedHours,
    material_plan: (p?.materialLines ?? null) as unknown,
    calc_version: p?.calcVersion ?? null,
    created_by: args.createdBy,
    client_updated_at: now,
    rev: 0,
  };
  // Human-edited scope + estimate changed: flag it stale so the estimate page
  // shows the Regenerate banner. Deliberately NOT written otherwise, so the
  // upsert leaves the column alone on ordinary saves.
  if (args.markScopeStale) estimateRow.scope_stale = true;
  // Live proposal panel (build 25): a hand-edited proposal from the estimator
  // IS the scope now. Text + scope_edited_at land together and stale clears
  // (the carried text is current by definition), exactly like the estimate
  // page's Save text. Wins over markScopeStale if a caller ever sets both.
  if (!isCustom && typeof args.editedScope === 'string' && args.editedScope.trim()) {
    estimateRow.scope_of_work = args.editedScope;
    estimateRow.scope_edited_at = now;
    estimateRow.scope_stale = false;
  }
  // Custom estimate: the typed scope IS the customer-facing scope of work, so
  // it composes into scope_of_work (the column accept copies to jobs.scope)
  // and scope_edited_at is stamped, which is the existing never-overwrite
  // lock: pec-estimate-scope refuses to regenerate over a human's text
  // without force, so a Generate click cannot clobber what Dylan typed.
  // Standard saves leave all scope columns alone (the server writes them).
  if (isCustom) {
    estimateRow.scope_of_work = customScope;
    estimateRow.scope_edited_at = now;
    estimateRow.scope_stale = false;
  }

  await idbPut('estimates', estimateRow);
  await enqueue({ table: 'estimates', id: estimateId, row: estimateRow, client_updated_at: now });

  // Areas first (line items FK them), collecting the minted ids by position.
  const areaIds: string[] = [];
  for (let i = 0; i < args.areas.length; i++) {
    const a = args.areas[i];
    const areaId = uuid();
    areaIds.push(areaId);
    const areaRow = {
      id: areaId,
      estimate_id: estimateId,
      name: a.name,
      sqft: a.sqft,
      system_type_id: a.systemTypeId,
      flake_product_id: a.flakeProductId,
      basecoat_product_id: a.basecoatProductId,
      topcoat_product_id: a.topcoatProductId,
      mvb: a.mvb === true,
      answers: a.answers,
      sort_order: i,
    };
    await enqueue({ table: 'estimate_areas', id: areaId, row: areaRow, client_updated_at: now });

    for (const m of a.materials) {
      const matId = uuid();
      const matRow = {
        id: matId,
        estimate_area_id: areaId,
        recipe_slot_id: m.recipe_slot_id,
        slot_label: m.slot_label,
        slot_kind: m.slot_kind,
        material_type: m.material_type,
        product_id: m.product_id,
        choice_value: m.choice_value,
        text_value: m.text_value,
        pick_index: m.pick_index,
        order_index: m.order_index,
      };
      await enqueue({ table: 'estimate_area_materials', id: matId, row: matRow, client_updated_at: now });
    }
  }

  // Line items LAST (they FK both the estimate and, for system lines, an area).
  for (const li of args.lineItems) {
    const liId = uuid();
    const liRow = {
      id: liId,
      estimate_id: estimateId,
      addon_id: li.addonId,
      estimate_area_id: li.areaIndex != null ? areaIds[li.areaIndex] ?? null : null,
      label: li.label,
      description: li.description,
      qty: li.qty,
      unit_price: li.unitPrice,
      unit_cost: li.unitCost,
      total: li.total,
      is_optional: li.isOptional,
      selected_by_customer: li.selectedByCustomer,
      sort_order: li.sortOrder,
    };
    await enqueue({ table: 'estimate_line_items', id: liId, row: liRow, client_updated_at: now });
  }

  return { id: estimateId };
}
