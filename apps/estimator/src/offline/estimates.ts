import { idbPut } from './idb';
import { enqueue } from './outbox';
import { uuid } from './uuid';
import type { PricingResult } from '../lib/calculator';

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
  answers: Record<string, string>; // raw slotId -> value (audit / re-open)
  materials: AreaMaterialInput[];
};

// One estimate line item (estimates.line_items jsonb, mirrors jobs.line_items).
// optional=true lines are EXCLUDED from the total until selected_by_customer.
export type LineItem = {
  id: string;
  label: string;
  description: string | null;
  qty: number;
  unit_price: number;
  total: number;
  optional: boolean;
  selected_by_customer: boolean;
  created_at: string;
};

// The rep's sell-price override (free-typed price or discount %), already run
// through applySellPrice so the GP fields written to the row agree with what
// the screen showed. Null means the engine price was accepted as-is.
export type SellOverride = {
  sellPrice: number;
  discountPct: number | null;
  laborDollars: number | null;
  commissionDollars: number | null;
  gpDollars: number | null;
  gpPct: number | null;
  budgetedHours: number | null;
  gpPerHour: number | null;
};

export type SaveEstimateArgs = {
  // Set when EDITING an existing estimate: the same id makes the outbox upsert
  // an in-place update (decision: reopening edits in place, no version rows).
  estimateId?: string | null;
  // Preserved on edit so reopening a sent estimate cannot silently reset it to
  // draft. New estimates pass 'draft'.
  status: string;
  systemTypeId: string;
  salesperson: { id: string; name: string; commission_pct: number };
  intake: Record<string, unknown>; // work-order fields
  customer: { name: string | null; phone: string | null; email: string | null; address: string | null };
  mvb: 'none' | 'addon' | 'standalone';
  flakeColor: string | null;
  lineItems: LineItem[];
  pricingSnapshot: Record<string, unknown> | null; // comps + AI read that priced it
  areas: AreaInput[];
  pricing: PricingResult;
  sell: SellOverride | null;
  createdBy: string | null;
  // Set when the estimator was opened from a lead (/estimator/?lead_id=<uuid>).
  // Null for a walk-up estimate with no lead behind it.
  leadId: string | null;
};

// Persist an estimate offline: write a local copy of the parent first (durable +
// readable offline), then enqueue the parent and its children IN ORDER so the
// FIFO outbox uploads estimates -> estimate_areas -> estimate_area_materials,
// satisfying the foreign keys. All ids are client-minted, so sync is idempotent.
//
// estimate_number is NEVER written from here: the column's Postgres sequence
// default assigns it on insert (concurrency-safe), and the upsert's
// on-conflict update only touches supplied columns, so a replay or an edit can
// never renumber a row.
export async function saveEstimateOffline(args: SaveEstimateArgs): Promise<{ id: string }> {
  const estimateId = args.estimateId || uuid();
  const now = new Date().toISOString();
  const p = args.pricing;
  const s = args.sell;

  const estimateRow = {
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
    customer_name: args.customer.name,
    customer_phone: args.customer.phone,
    customer_email: args.customer.email,
    customer_address: args.customer.address,
    mvb: args.mvb,
    flake_color: args.flakeColor,
    line_items: args.lineItems as unknown,
    pricing_snapshot: args.pricingSnapshot as unknown,
    materials_cost: p.materialsCost ?? null,
    fixed_addons: p.fixedAddons ?? 0,
    labor_pct: p.laborPct ?? null,
    commission_pct: p.commissionPct ?? null,
    target_gp_pct: p.targetGpPct ?? null,
    // Money fields honor the sell override so the stored row matches the
    // quoted number, not the engine's pre-discount solve.
    price: s ? s.sellPrice : (p.price ?? null),
    gp_dollars: s ? s.gpDollars : (p.gpDollars ?? null),
    gp_pct: s ? s.gpPct : (p.gpPct ?? null),
    gp_per_hour: s ? s.gpPerHour : (p.gpPerHour ?? null),
    labor_budget: s ? s.laborDollars : (p.laborBudget ?? null),
    commission_dollars: s ? s.commissionDollars : (p.commissionDollars ?? null),
    budgeted_hours: s ? s.budgetedHours : (p.budgetedHours ?? null),
    material_plan: (p.materialLines ?? null) as unknown,
    calc_version: p.calcVersion,
    created_by: args.createdBy,
    client_updated_at: now,
    rev: 0,
  };

  await idbPut('estimates', estimateRow);
  await enqueue({ table: 'estimates', id: estimateId, row: estimateRow, client_updated_at: now });

  for (let i = 0; i < args.areas.length; i++) {
    const a = args.areas[i];
    const areaId = uuid();
    const areaRow = {
      id: areaId,
      estimate_id: estimateId,
      name: a.name,
      sqft: a.sqft,
      system_type_id: a.systemTypeId,
      flake_product_id: a.flakeProductId,
      basecoat_product_id: a.basecoatProductId,
      topcoat_product_id: a.topcoatProductId,
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

  return { id: estimateId };
}
