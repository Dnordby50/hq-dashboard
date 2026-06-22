import { idbPut } from './idb';
import { enqueue } from './outbox';
import { uuid } from './uuid';
import type { PricingResult } from '../lib/calculator';

export type SaveEstimateArgs = {
  systemTypeId: string;
  salesperson: { id: string; name: string; commission_pct: number };
  areas: { name: string; sqft: number; flake_product_id: string | null }[];
  pricing: PricingResult;
  createdBy: string | null;
};

// Build the public.estimates row (ONLY real columns) and persist it offline:
// write the local copy first (durable + readable offline), then enqueue the
// sync op. Because the local write happens before any network attempt, killing
// the app between save and sync loses nothing; the next launch drains the queue.
export async function saveEstimateOffline(args: SaveEstimateArgs): Promise<{ id: string }> {
  const id = uuid();
  const now = new Date().toISOString();
  const p = args.pricing;
  const row = {
    id,
    system_type_id: args.systemTypeId,
    status: 'draft',
    // Salesperson + area inputs ride in intake (jsonb) until the dedicated
    // estimate_areas child rows + a salesperson column land in a later slice.
    intake: {
      salesperson_id: args.salesperson.id,
      salesperson_name: args.salesperson.name,
      areas: args.areas,
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

  await idbPut('estimates', row);
  await enqueue({ opId: uuid(), table: 'estimates', id, row, client_updated_at: now });
  return { id };
}
