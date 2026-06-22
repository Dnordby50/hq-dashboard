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

export type SaveEstimateArgs = {
  systemTypeId: string;
  salesperson: { id: string; name: string; commission_pct: number };
  intake: Record<string, unknown>; // work-order fields
  areas: AreaInput[];
  pricing: PricingResult;
  createdBy: string | null;
};

// Persist an estimate offline: write a local copy of the parent first (durable +
// readable offline), then enqueue the parent and its children IN ORDER so the
// FIFO outbox uploads estimates -> estimate_areas -> estimate_area_materials,
// satisfying the foreign keys. All ids are client-minted, so sync is idempotent.
export async function saveEstimateOffline(args: SaveEstimateArgs): Promise<{ id: string }> {
  const estimateId = uuid();
  const now = new Date().toISOString();
  const p = args.pricing;

  const estimateRow = {
    id: estimateId,
    system_type_id: args.systemTypeId,
    status: 'draft',
    intake: {
      ...args.intake,
      salesperson_id: args.salesperson.id,
      salesperson_name: args.salesperson.name,
    },
    materials_cost: p.materialsCost ?? null,
    fixed_addons: p.fixedAddons ?? 0,
    labor_pct: p.laborPct ?? null,
    commission_pct: p.commissionPct ?? null,
    target_gp_pct: p.targetGpPct ?? null,
    price: p.price ?? null,
    gp_dollars: p.gpDollars ?? null,
    gp_pct: p.gpPct ?? null,
    gp_per_hour: p.gpPerHour ?? null,
    labor_budget: p.laborBudget ?? null,
    commission_dollars: p.commissionDollars ?? null,
    budgeted_hours: p.budgetedHours ?? null,
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
