import { supabase } from './supabase';
import type { Product, RecipeSlot, SystemType } from './calculator';
import { idbGet, idbPut } from '../offline/idb';

const CATALOG_CACHE_KEY = 'catalog';

// auth_user_id (prompt 47): the member's auth login, mapped by an admin in
// Settings > Sales Team. Drives the current-user salesperson default; null =
// unmapped (and a catalog cached before the migration has no key at all).
export type SalesPerson = { id: string; name: string; commission_pct: number; active: boolean; auth_user_id?: string | null };

// One add-on catalog row (pec_prod_addons). Dylan manages the catalog; the
// estimator only picks from it. system_type_id null = applies to any system.
export type Addon = {
  id: string;
  name: string;
  description: string | null;
  unit: 'each' | 'sqft' | 'lf' | 'hour';
  default_price: number;
  default_cost: number;
  is_optional_default: boolean;
  system_type_id: string | null;
  sort_order: number;
  // The scope paragraph appended to the customer scope; scanned for BLANK
  // placeholders the rep must answer (15c).
  scope_snippet: string | null;
};

export type PricingConfig = {
  laborRate: number;
  standardCommissionPct: number; // estimator_default_commission_pct: the house rate baked into every quote
  targetGpPct: number;
  priceIncrement: number;
  charmThreshold: number;
  charmBand: number;
  sundriesPct: number; // estimator_sundries_pct: sundries + disposables as % of total cost (build 17)
  floorGpPct: number;  // estimator_floor_gp_pct: GP% floor below which an override warns (build 17)
  // Line pricing (prompt 69). Defaults here MUST match the migration seeds and
  // any server-side reader: floor falls back to the estimator floor so day one
  // behaves identically; thresholds gate when a written reason is demanded
  // (final total under calculated total by more than the GREATER of the two).
  linePricingGpFloorPct: number;            // line_pricing_gp_floor_pct: per-line GP floor that turns a line red
  linePricingBlockBelowFloor: boolean;      // line_pricing_block_below_floor: a below-floor LINE forces the confirm (vs warn only)
  linePricingCustomLabelDefault: string;    // line_pricing_custom_label_default: prefilled label on a new custom line
  linePricingReasonThresholdPct: number;    // line_pricing_reason_threshold_pct (default 2)
  linePricingReasonThresholdDollars: number; // line_pricing_reason_threshold_dollars (default 100)
  // Pricing intelligence (prompt 70). Defaults MUST match the migration seeds
  // and pec-estimate-ai.cjs: true / 3. compsMinSample is the ONE knob shared
  // by the comps ladder and the AI confidence flag.
  estimateAiEnabled: boolean;  // estimate_ai_enabled: master switch for the AI price read
  compsMinSample: number;      // comps_min_sample: below it the ladder widens and a line reads thin_sample
  // Optional lines (prompt 72). Defaults MUST match the migration seeds:
  // true / true / the line-pricing floor (40).
  optionalLinesEnabled: boolean;         // optional_lines_enabled: CREATE gate for new optional lines
  optionalLinesPreselectDefault: boolean; // optional_lines_preselect_default: a newly optional line starts ticked
  optionalLinesGpWarnPct: number;        // optional_lines_gp_warn_pct: required-only GP% amber threshold
  hideMaterialQty: boolean;
  commissionConfigured: boolean; // false until Dylan sets a default commission rate
  customerSearchEnabled: boolean; // estimator_customer_search_enabled: the dedup search on the customer card (prompt 44)
  syncStuckThreshold: number; // sync_stuck_threshold_attempts: failed attempts before a queued save shows the red not-syncing state (prompt 48)
  syncStuckEscalationEnabled: boolean; // sync_stuck_escalation_enabled: report stuck saves to the office (bell notification) (prompt 48)
};

export type Catalog = {
  systemTypes: SystemType[];
  productsById: Record<string, Product>;
  recipeSlotsBySystemType: Record<string, RecipeSlot[]>;
  salespeople: SalesPerson[];
  addons: Addon[];
  config: PricingConfig;
};

// One round of reads to build everything the estimator's first screen needs.
// Each query is RLS-gated to admin staff (same as the dashboard), so this only
// returns data for a signed-in admin.
export async function loadCatalog(): Promise<Catalog> {
  const [systemsRes, productsRes, slotsRes, salesRes, addonsRes, settingsRes] = await Promise.all([
    supabase
      .from('pec_prod_system_types')
      .select('id,name,labor_budget_pct,target_gp_pct,active,sort_order,scope_template,scope_template_mvb')
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }),
    supabase
      .from('pec_prod_products')
      .select('id,name,material_type,supplier,color,spread_rate,kit_size,unit_cost,active')
      .eq('active', true),
    supabase
      .from('pec_prod_recipe_slots')
      .select('id,system_type_id,order_index,material_type,slot_kind,label,default_product_id,required,editor_hidden,options')
      .order('order_index', { ascending: true }),
    supabase
      .from('pec_sales_team_members')
      // select('*') (not an explicit list) so this keeps working before the
      // auth_user_id migration lands; the column reads undefined until then
      // and the current-user default simply finds no match. Same forward-
      // compat pattern estimateLoad.ts uses for the split customer columns.
      .select('*')
      .eq('active', true)
      .order('name', { ascending: true }),
    supabase
      .from('pec_prod_addons')
      .select('id,name,description,unit,default_price,default_cost,is_optional_default,system_type_id,sort_order,scope_snippet')
      .eq('active', true)
      .order('sort_order', { ascending: true })
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
        'estimator_sundries_pct',
        'estimator_floor_gp_pct',
        'line_pricing_gp_floor_pct',
        'line_pricing_block_below_floor',
        'line_pricing_custom_label_default',
        'line_pricing_reason_threshold_pct',
        'line_pricing_reason_threshold_dollars',
        'estimate_ai_enabled',
        'comps_min_sample',
        'optional_lines_enabled',
        'optional_lines_preselect_default',
        'optional_lines_gp_warn_pct',
        'estimator_customer_search_enabled',
        'sync_stuck_threshold_attempts',
        'sync_stuck_escalation_enabled',
      ]),
  ]);

  const firstError =
    systemsRes.error || productsRes.error || slotsRes.error || salesRes.error ||
    addonsRes.error || settingsRes.error;
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
    standardCommissionPct: num('estimator_default_commission_pct', 0),
    targetGpPct: num('estimator_target_gp_pct', 50),
    priceIncrement: num('estimator_price_increment', 5),
    charmThreshold: num('estimator_charm_threshold', 1000),
    charmBand: num('estimator_charm_band', 250),
    sundriesPct: num('estimator_sundries_pct', 2),
    floorGpPct: num('estimator_floor_gp_pct', 40),
    linePricingGpFloorPct: num('line_pricing_gp_floor_pct', num('estimator_floor_gp_pct', 40)),
    linePricingBlockBelowFloor: String(settings['line_pricing_block_below_floor'] ?? 'false').toLowerCase() === 'true',
    linePricingCustomLabelDefault: String(settings['line_pricing_custom_label_default'] ?? '').trim() || 'Custom work',
    linePricingReasonThresholdPct: num('line_pricing_reason_threshold_pct', 2),
    linePricingReasonThresholdDollars: num('line_pricing_reason_threshold_dollars', 100),
    estimateAiEnabled: String(settings['estimate_ai_enabled'] ?? 'true').toLowerCase() !== 'false',
    compsMinSample: Math.max(1, num('comps_min_sample', 3)) || 3,
    optionalLinesEnabled: String(settings['optional_lines_enabled'] ?? 'true').toLowerCase() !== 'false',
    optionalLinesPreselectDefault: String(settings['optional_lines_preselect_default'] ?? 'true').toLowerCase() !== 'false',
    optionalLinesGpWarnPct: num('optional_lines_gp_warn_pct', num('line_pricing_gp_floor_pct', 40)),
    hideMaterialQty: String(settings['estimator_hide_material_qty'] ?? 'true').toLowerCase() === 'true',
    commissionConfigured:
      settings['estimator_default_commission_pct'] != null &&
      settings['estimator_default_commission_pct'] !== '',
    customerSearchEnabled: String(settings['estimator_customer_search_enabled'] ?? 'true').toLowerCase() !== 'false',
    // Guard against a zero/negative row making every queued op instantly
    // "broken": anything unparseable or < 1 falls back to 2.
    syncStuckThreshold: Math.max(1, num('sync_stuck_threshold_attempts', 2)) || 2,
    syncStuckEscalationEnabled: String(settings['sync_stuck_escalation_enabled'] ?? 'true').toLowerCase() !== 'false',
  };

  const catalog: Catalog = {
    systemTypes: (systemsRes.data ?? []) as SystemType[],
    productsById,
    recipeSlotsBySystemType,
    salespeople: (salesRes.data ?? []) as SalesPerson[],
    addons: (addonsRes.data ?? []) as Addon[],
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
