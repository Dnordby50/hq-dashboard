import { supabase } from './supabase';
import type { Product, RecipeSlot, SystemType } from './calculator';
import { idbGet, idbPut } from '../offline/idb';

const CATALOG_CACHE_KEY = 'catalog';

export type SalesPerson = { id: string; name: string; commission_pct: number; active: boolean };

export type PricingConfig = {
  laborRate: number;
  targetGpPct: number;
  priceIncrement: number;
  charmThreshold: number;
  charmBand: number;
  hideMaterialQty: boolean;
  commissionConfigured: boolean; // false until Dylan sets a default commission rate
};

export type Catalog = {
  systemTypes: SystemType[];
  productsById: Record<string, Product>;
  recipeSlotsBySystemType: Record<string, RecipeSlot[]>;
  salespeople: SalesPerson[];
  config: PricingConfig;
};

// One round of reads to build everything the estimator's first screen needs.
// Each query is RLS-gated to admin staff (same as the dashboard), so this only
// returns data for a signed-in admin.
export async function loadCatalog(): Promise<Catalog> {
  const [systemsRes, productsRes, slotsRes, salesRes, settingsRes] = await Promise.all([
    supabase
      .from('pec_prod_system_types')
      .select('id,name,labor_budget_pct,target_gp_pct,active,sort_order')
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }),
    supabase
      .from('pec_prod_products')
      .select('id,name,material_type,supplier,color,spread_rate,kit_size,unit_cost,active')
      .eq('active', true),
    supabase
      .from('pec_prod_recipe_slots')
      .select('id,system_type_id,order_index,material_type,slot_kind,label,default_product_id,required,options')
      .order('order_index', { ascending: true }),
    supabase
      .from('pec_sales_team_members')
      .select('id,name,commission_pct,active')
      .eq('active', true)
      .order('name', { ascending: true }),
    supabase
      .from('settings')
      .select('key,value')
      .in('key', [
        'default_labor_hourly_rate',
        'estimator_target_gp_pct',
        'estimator_price_increment',
        'estimator_charm_threshold',
        'estimator_charm_band',
        'estimator_hide_material_qty',
        'estimator_default_commission_pct',
      ]),
  ]);

  const firstError =
    systemsRes.error || productsRes.error || slotsRes.error || salesRes.error || settingsRes.error;
  if (firstError) throw firstError;

  const productsById: Record<string, Product> = {};
  for (const p of productsRes.data ?? []) productsById[p.id] = p as Product;

  const recipeSlotsBySystemType: Record<string, RecipeSlot[]> = {};
  for (const s of (slotsRes.data ?? []) as RecipeSlot[]) {
    (recipeSlotsBySystemType[s.system_type_id] ??= []).push(s);
  }

  const settings: Record<string, string> = {};
  for (const row of settingsRes.data ?? []) settings[row.key] = row.value;

  const num = (key: string, fallback: number) => {
    const v = Number(settings[key]);
    return Number.isFinite(v) && settings[key] !== '' && settings[key] != null ? v : fallback;
  };

  const config: PricingConfig = {
    laborRate: num('default_labor_hourly_rate', 0),
    targetGpPct: num('estimator_target_gp_pct', 50),
    priceIncrement: num('estimator_price_increment', 5),
    charmThreshold: num('estimator_charm_threshold', 1000),
    charmBand: num('estimator_charm_band', 250),
    hideMaterialQty: String(settings['estimator_hide_material_qty'] ?? 'true').toLowerCase() === 'true',
    commissionConfigured:
      settings['estimator_default_commission_pct'] != null &&
      settings['estimator_default_commission_pct'] !== '',
  };

  const catalog: Catalog = {
    systemTypes: (systemsRes.data ?? []) as SystemType[],
    productsById,
    recipeSlotsBySystemType,
    salespeople: (salesRes.data ?? []) as SalesPerson[],
    config,
  };

  // Cache for offline use (best-effort; never fail the online load on a cache
  // write error, e.g. IndexedDB unavailable in private mode).
  try {
    await idbPut('catalog', { ...catalog, cachedAt: new Date().toISOString() }, CATALOG_CACHE_KEY);
  } catch {
    /* ignore */
  }

  return catalog;
}

// The last catalog cached by a successful online load. Used when the device is
// offline so the estimator's question flow + pricing still work at a job site.
export async function getCachedCatalog(): Promise<(Catalog & { cachedAt?: string }) | undefined> {
  try {
    return await idbGet<Catalog & { cachedAt?: string }>('catalog', CATALOG_CACHE_KEY);
  } catch {
    return undefined;
  }
}
