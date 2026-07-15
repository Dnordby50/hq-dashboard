import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Addon, Catalog, SalesPerson } from '../../lib/catalog';
import {
  allocateProportionally,
  applySellPrice,
  computeEstimatePricing,
  lineItemsGp,
  lineItemsTotal,
  roundEstimatePrice,
  type Area,
  type PricingResult,
  type Product,
  type RecipeSlot,
} from '../../lib/calculator';
import { useOnline } from '../../lib/useOnline';
import {
  saveEstimateOffline,
  type AreaInput,
  type AreaMaterialInput,
  type EstimateTotals,
  type LineItemInput,
} from '../../offline/estimates';
import type { LeadLink } from '../../lib/lead';
import { emptyCustomer, splitLegacyName, type CustomerForm } from '../../lib/customer';
import AddressAutocomplete from './AddressAutocomplete';
import type { LoadedEstimate } from '../../lib/estimateLoad';
import { deleteEstimateChildren } from '../../lib/estimateLoad';
import { listOps } from '../../offline/outbox';
import { drainOutbox } from '../../offline/sync';
import { buildComps, compsGpCaveat, compsRuleLabel, loadCompCandidates, type CompCandidate, type CompsResult } from '../../lib/comps';
import { compsForAi, fetchAiRecommendation, type AiRecommendation } from '../../lib/ai';
import { supabase } from '../../lib/supabase';
import { uuid } from '../../offline/uuid';
import { openQuestions as scopeOpenQuestions, type ScopeQuestion } from '../../../../../production/scope.cjs';

type AreaForm = { name: string; sqft: string; systemTypeId: string; mvb: boolean; slotValues: Record<string, string> };
// MVB Only is a system type (build 17): an area on it is an MVB-only job, so
// the per-area MVB checkbox is redundant there and is hidden.
const MVB_ONLY_SYSTEM_NAME = 'MVB Only';
type Intake = {
  gate_code: string;
  coat_past_garage: boolean;
  stem_walls: boolean;
  moisture: string;
  mohs_hardness: string;
  additional_non_slip: string;
  grinder_tooling_grit: string;
  special_notes: string;
};

// One add-on / one-off line in form state. Catalog picks carry addonId (label
// locked to the catalog name); a one-off has addonId null and everything
// editable. Prices and costs prefill from the catalog and STAY editable.
type AddonForm = {
  key: string;
  addonId: string | null;
  label: string;
  description: string;
  qty: string;
  unitPrice: string;
  unitCost: string;
  optional: boolean;
};

const SWATCH_TYPES = new Set(['Flake', 'Quartz', 'Metallic Pigment']);
// Same catalog row the dashboard's New Job flow resolves: the one MVB product
// priced for standalone application (100 sqft/gal across all areas).
const MVB_PRODUCT_NAME = 'Simiron MVB - Standalone';

const money = (n: number | null | undefined) =>
  n == null ? '--' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money2 = (n: number | null | undefined) =>
  n == null ? '--' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const pct = (frac: number | null | undefined) => (frac == null ? '--' : `${(frac * 100).toFixed(1)}%`);
const r2 = (n: number) => Math.round(n * 100) / 100;

const ERROR_COPY: Record<string, string> = {
  TARGET_UNREACHABLE:
    'Target margin is impossible for these inputs: labor + commission + target GP add up to 100% or more of revenue. Lower the target GP or commission.',
  NO_LABOR_PCT: 'A selected system has no labor budget percent set. Set it in the Catalog before pricing.',
};

type SlotKind = 'choice' | 'text' | 'product';
const kindOf = (s: RecipeSlot): SlotKind =>
  s.slot_kind === 'choice' ? 'choice' : s.slot_kind === 'text' ? 'text' : 'product';

function normalizeOptions(options: unknown): { value: string; label: string }[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => {
      if (typeof o === 'string') return { value: o, label: o };
      if (o && typeof o === 'object') {
        const obj = o as Record<string, unknown>;
        const value = String(obj.value ?? obj.label ?? obj.name ?? '');
        const label = String(obj.label ?? obj.name ?? obj.value ?? '');
        return { value, label };
      }
      return { value: String(o), label: String(o) };
    })
    .filter((x) => x.value !== '');
}

const emptyIntake: Intake = {
  gate_code: '',
  coat_past_garage: false,
  stem_walls: false,
  moisture: '',
  mohs_hardness: '',
  additional_non_slip: '',
  grinder_tooling_grit: '',
  special_notes: '',
};

function intakeFromLoaded(raw: Record<string, unknown>): Intake {
  return {
    gate_code: raw.gate_code != null ? String(raw.gate_code) : '',
    coat_past_garage: raw.coat_past_garage === true,
    stem_walls: raw.stem_walls === true,
    moisture: raw.moisture != null ? String(raw.moisture) : '',
    mohs_hardness: raw.mohs_hardness != null ? String(raw.mohs_hardness) : '',
    additional_non_slip: raw.additional_non_slip != null ? String(raw.additional_non_slip) : '',
    grinder_tooling_grit: raw.grinder_tooling_grit != null ? String(raw.grinder_tooling_grit) : '',
    special_notes: raw.special_notes != null ? String(raw.special_notes) : '',
  };
}

export default function EstimatorScreen({
  catalog,
  createdBy,
  catalogFromCache,
  leadLink,
  embed,
  editing,
}: {
  catalog: Catalog;
  createdBy: string | null;
  catalogFromCache: boolean;
  leadLink: LeadLink | null;
  embed: boolean;
  editing: LoadedEstimate | null;
}) {
  const { systemTypes, productsById, recipeSlotsBySystemType, salespeople, config } = catalog;
  // A catalog cached before 2026-07-13 has no addons key; tolerate it so an
  // offline rep still prices (the add-on picker is just empty until a refresh).
  const addonCatalog: Addon[] = catalog.addons ?? [];
  const online = useOnline();

  // Product slots start PREFILLED with the system's default_product_id, so the
  // collapsed "More detail" section shows real picks instead of empty selects.
  // The engine already falls back to the same defaults, so this changes what
  // the rep SEES (and what persists to estimate_area_materials), not the price.
  //
  // EXCEPT swatch slots (flake / quartz / metallic pigment): a swatch pick IS
  // the customer's color choice, which usually happens after the presentation,
  // so prefilling one would silently write a color nobody chose (it flows into
  // estimates.flake_color via flakeColorFromPicks). Left unpicked, the slot
  // shows "Color / custom blend" and the engine STILL prices it from the
  // slot's default product (pick || default_product_id in planForArea), which
  // as of 2026-07-12 is the "Standard Flake (color TBD)" cost placeholder. So
  // the price is right and the color stays honestly TBD.
  const defaultSlotValues = useCallback(
    (sysId: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const s of recipeSlotsBySystemType[sysId] ?? []) {
        if (s.editor_hidden) continue;
        if (SWATCH_TYPES.has(s.material_type)) continue;
        if (kindOf(s) === 'product' && s.default_product_id) out[s.id] = s.default_product_id;
      }
      return out;
    },
    [recipeSlotsBySystemType],
  );

  const fallbackSystemId = editing?.systemTypeId ?? systemTypes[0]?.id ?? '';
  const [salespersonId, setSalespersonId] = useState<string>(() => {
    const fromEdit = editing ? String(editing.intake.salesperson_id ?? '') : '';
    if (fromEdit && salespeople.some((s) => s.id === fromEdit)) return fromEdit;
    return salespeople[0]?.id ?? '';
  });
  // Split customer shape (build 23): Residential/Commercial toggle, split
  // name / company, split address. Prefill priority: the estimate being
  // edited (estimateLoad already mapped split columns, with legacy fallback),
  // then the lead link (leads store the address split already; full_name gets
  // the same naive first/rest split the backfill uses).
  const [customer, setCustomer] = useState<CustomerForm>(() => {
    if (editing) return editing.customer;
    if (!leadLink) return emptyCustomer;
    return {
      ...emptyCustomer,
      ...splitLegacyName(leadLink.name),
      phone: leadLink.phone ?? '',
      email: leadLink.email ?? '',
      address1: leadLink.address1 ?? '',
      city: leadLink.city ?? '',
      state: leadLink.state ?? '',
      zip: leadLink.zip ?? '',
    };
  });
  const [intake, setIntake] = useState<Intake>(() =>
    editing ? intakeFromLoaded(editing.intake) : emptyIntake,
  );
  // Each area picks its OWN system (multi-system estimates, 2026-07-13): a
  // real job is a garage plus a patio plus stem walls, and they are not the
  // same system. The estimate-level system becomes the DOMINANT area's (most
  // sqft) for reporting; pricing weights every area's own system.
  const [areas, setAreas] = useState<AreaForm[]>(() =>
    editing
      ? editing.areas.map((a) => ({
          name: a.name,
          sqft: a.sqft,
          systemTypeId: a.systemTypeId ?? fallbackSystemId,
          mvb: a.mvb === true,
          slotValues: a.slotValues,
        }))
      : [{ name: 'Main', sqft: '', systemTypeId: fallbackSystemId, mvb: false, slotValues: fallbackSystemId ? defaultSlotValues(fallbackSystemId) : {} }],
  );
  const [addonForms, setAddonForms] = useState<AddonForm[]>(() =>
    (editing?.addonLines ?? []).map((li) => ({
      key: uuid(),
      addonId: li.addonId,
      label: li.label,
      description: li.description ?? '',
      qty: String(li.qty),
      unitPrice: String(li.unitPrice),
      unitCost: String(li.unitCost),
      optional: li.isOptional,
    })),
  );
  // Rep's answers to the templates' BLANK placeholders, keyed by the context
  // hash production/scope.cjs computes (same keys the server uses).
  const [scopeAnswers, setScopeAnswers] = useState<Record<string, string>>(() => editing?.scopeAnswers ?? {});
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [savedOffline, setSavedOffline] = useState(false);
  const [pending, setPending] = useState(0);

  const salesperson: SalesPerson | undefined = salespeople.find((s) => s.id === salespersonId);

  const mvbProduct = useMemo(
    () => Object.values(productsById).find((p) => p.name === MVB_PRODUCT_NAME) ?? null,
    [productsById],
  );

  // A system's slots, ordered, with internal (editor_hidden) body coats removed.
  const slotsFor = useCallback(
    (sysId: string): RecipeSlot[] =>
      (recipeSlotsBySystemType[sysId] ?? []).filter((s) => !s.editor_hidden),
    [recipeSlotsBySystemType],
  );
  const isMvbOnlySystem = useCallback(
    (sysId: string) => systemTypes.find((s) => s.id === sysId)?.name === MVB_ONLY_SYSTEM_NAME,
    [systemTypes],
  );

  const productsByType = useMemo(() => {
    const m: Record<string, Product[]> = {};
    for (const p of Object.values(productsById)) (m[p.material_type] ??= []).push(p);
    for (const list of Object.values(m)) list.sort((a, b) => (a.color ?? a.name).localeCompare(b.color ?? b.name));
    return m;
  }, [productsById]);

  // Map an area's raw slot answers to the flake/basecoat/topcoat the calculator
  // resolves against (first product slot of each kind wins), using THAT AREA'S
  // system's slots.
  const deriveProducts = useCallback(
    (slotValues: Record<string, string>, sysId: string) => {
      let flake: string | null = null;
      let basecoat: string | null = null;
      let topcoat: string | null = null;
      for (const s of slotsFor(sysId)) {
        const v = slotValues[s.id];
        if (!v || kindOf(s) !== 'product') continue;
        if (SWATCH_TYPES.has(s.material_type) && !flake) flake = v;
        else if (s.material_type === 'Basecoat' && !basecoat) basecoat = v;
        else if (s.material_type === 'Topcoat' && !topcoat) topcoat = v;
      }
      return { flake, basecoat, topcoat };
    },
    [slotsFor],
  );

  // The pricable areas, in form order, each with its own system. engineAreas
  // and the save's areaInputs both derive from this ONE filtered list so their
  // indexes stay aligned (line items bind to areas by position).
  const pricedAreas = useMemo(() => areas.filter((a) => Number(a.sqft) > 0 && a.systemTypeId), [areas]);

  const engineAreas: Area[] = useMemo(
    () =>
      pricedAreas.map((a, i) => {
        const d = deriveProducts(a.slotValues, a.systemTypeId);
        return {
          id: `a${i}`,
          name: a.name || `Area ${i + 1}`,
          sqft: Number(a.sqft) || 0,
          system_type_id: a.systemTypeId,
          flake_product_id: d.flake,
          basecoat_product_id: d.basecoat,
          topcoat_product_id: d.topcoat,
          mvb: a.mvb === true,
        };
      }),
    [pricedAreas, deriveProducts],
  );
  const totalSqft = useMemo(() => engineAreas.reduce((s, a) => s + a.sqft, 0), [engineAreas]);

  // Sqft per system, biggest first: [0] is the DOMINANT system (what the
  // estimate reports as ITS system, what the comps panel keys off).
  const systemsBySqft = useMemo(() => {
    const bySys = new Map<string, number>();
    for (const a of engineAreas) bySys.set(a.system_type_id, (bySys.get(a.system_type_id) ?? 0) + a.sqft);
    return [...bySys.entries()]
      .map(([systemId, sqft]) => ({ systemId, sqft }))
      .sort((x, y) => y.sqft - x.sqft);
  }, [engineAreas]);
  const dominantSystemId = systemsBySqft[0]?.systemId ?? areas[0]?.systemTypeId ?? fallbackSystemId;
  const dominantSystem = systemTypes.find((s) => s.id === dominantSystemId);
  const mixedSystems = systemsBySqft.length > 1;

  // BLANK placeholder questions (15c): scan each area's chosen template (its
  // system's MVB variant when THAT AREA has a moisture barrier, build 17) plus
  // the selected add-ons' snippets for the literal word BLANK. Only OPEN
  // (unanswered) ones show.
  const scopeQuestions: ScopeQuestion[] = useMemo(() => {
    const sources: Array<{ text: string; contextLabel: string }> = [];
    for (const a of pricedAreas) {
      const sys = systemTypes.find((s) => s.id === a.systemTypeId);
      if (!sys) continue;
      const tpl = (a.mvb && sys.scope_template_mvb) ? sys.scope_template_mvb : sys.scope_template;
      if (tpl) sources.push({ text: tpl, contextLabel: sys.name });
    }
    for (const f of addonForms) {
      if (!f.addonId) continue; // one-offs have no template
      const cat = addonCatalog.find((a) => a.id === f.addonId);
      if (cat && cat.scope_snippet && cat.scope_snippet.trim()) sources.push({ text: cat.scope_snippet, contextLabel: cat.name });
    }
    return scopeOpenQuestions(sources, scopeAnswers);
  }, [pricedAreas, systemTypes, addonForms, addonCatalog, scopeAnswers]);
  const setScopeAnswer = (key: string, value: string) => setScopeAnswers((prev) => ({ ...prev, [key]: value }));

  // Any area wants MVB but the catalog is missing the MVB product.
  const anyAreaMvb = useMemo(() => engineAreas.some((a) => a.mvb === true), [engineAreas]);
  const mvbMissing = anyAreaMvb && !mvbProduct;

  const pricing: PricingResult | null = useMemo(() => {
    if (!salesperson || !engineAreas.length) return null;
    if (mvbMissing) return null; // surfaced below
    return computeEstimatePricing({
      areas: engineAreas,
      productsById,
      recipeSlotsBySystemType,
      systemTypes,
      laborRate: config.laborRate,
      // PRICING uses the standard house rate; the rep's actual rate only affects
      // payout + GP variance, so the quote never changes with the salesperson.
      commissionPct: config.standardCommissionPct,
      actualCommissionPct: salesperson.commission_pct ?? 0,
      targetGpPct: config.targetGpPct,
      priceIncrement: config.priceIncrement,
      charmThreshold: config.charmThreshold,
      charmBand: config.charmBand,
      sundriesPct: config.sundriesPct,
      // Per-area MVB adds this product at each mvb=true area's sqft.
      mvbProductId: mvbProduct?.id ?? null,
    } as Parameters<typeof computeEstimatePricing>[0]);
  }, [engineAreas, salesperson, productsById, recipeSlotsBySystemType, systemTypes, config, mvbProduct, mvbMissing]);

  const err = pricing?.error ?? null;
  const hasPrice = !!pricing && !err && pricing.price != null;
  const basePrice = hasPrice && pricing ? pricing.price! : null;

  // ---- Sell price / discount (decision 9: nothing is blocked, GP goes red) --
  const [sellInput, setSellInput] = useState('');
  const [discInput, setDiscInput] = useState('');
  const [priceOverride, setPriceOverride] = useState<null | 'sell' | 'disc'>(null);
  // Build 17: overriding the total sell price requires a reason (the paper
  // trail for who is discounting and why). Prefilled from a reopened override.
  const [overrideReason, setOverrideReason] = useState<string>(() => editing?.priceOverrideReason ?? '');

  // A structural change to the price (system, sqft, MVB, products) resets any
  // manual override: the old discount was negotiated against the old number.
  useEffect(() => {
    setPriceOverride(null);
    setSellInput('');
    setDiscInput('');
  }, [basePrice]);

  // The system portion's sell price. Add-on lines price separately on top.
  const finalSell: number | null = useMemo(() => {
    if (basePrice == null) return null;
    if (priceOverride === 'sell') {
      const n = Number(sellInput);
      return Number.isFinite(n) && n > 0 ? n : basePrice;
    }
    if (priceOverride === 'disc') {
      const d = Number(discInput);
      if (!Number.isFinite(d)) return basePrice;
      return Math.max(0, Math.round(basePrice * (1 - d / 100)));
    }
    return basePrice;
  }, [basePrice, priceOverride, sellInput, discInput]);

  const adjusted = useMemo(
    () => (pricing && hasPrice && finalSell != null ? applySellPrice(pricing, finalSell) : null),
    [pricing, hasPrice, finalSell],
  );
  const discounted = basePrice != null && finalSell != null && Math.abs(finalSell - basePrice) >= 0.5;

  // ---- Add-on / one-off line money -----------------------------------------
  // Optional lines are EXCLUDED from the total and from GP until the customer
  // selects them (public page, prompt 16); the rep sees both numbers. GP per
  // line = total - qty*cost - commission, so a costed add-on cannot inflate GP.
  const addonMoneyItems = useMemo(
    () =>
      addonForms.map((f) => {
        const qty = Number(f.qty) > 0 ? Number(f.qty) : 1;
        const unitPrice = Number(f.unitPrice) || 0;
        return {
          total: r2(qty * unitPrice),
          qty,
          unit_cost: Number(f.unitCost) || 0,
          is_optional: f.optional,
          selected_by_customer: false,
        };
      }),
    [addonForms],
  );
  const addonsBaseTotal = useMemo(() => lineItemsTotal(addonMoneyItems), [addonMoneyItems]);
  const addonsAllTotal = useMemo(() => lineItemsTotal(addonMoneyItems, { withAllOptions: true }), [addonMoneyItems]);
  const hasOptionalAddons = addonForms.some((f) => f.optional);

  const totalPrice = finalSell != null ? r2(finalSell + addonsBaseTotal) : null;
  const totalAllOptions = finalSell != null ? r2(finalSell + addonsAllTotal) : null;
  const addonGp = useMemo(
    () => lineItemsGp(addonMoneyItems, config.standardCommissionPct),
    [addonMoneyItems, config.standardCommissionPct],
  );
  const combinedGpDollars = adjusted && adjusted.gpDollars != null ? r2(adjusted.gpDollars + addonGp) : null;
  const combinedGpPct = combinedGpDollars != null && totalPrice != null && totalPrice > 0 ? combinedGpDollars / totalPrice : null;
  const combinedCommission = adjusted && adjusted.commissionDollars != null
    ? r2(adjusted.commissionDollars + (config.standardCommissionPct / 100) * addonsBaseTotal)
    : null;
  const combinedGpPerHour = combinedGpDollars != null && adjusted?.budgetedHours != null && adjusted.budgetedHours > 0
    ? r2(combinedGpDollars / adjusted.budgetedHours)
    : null;

  // GP threshold: the sqft-weighted target across the areas' systems (the
  // engine computes it; a naive mean would let a small high-target area drag
  // the warning). Falls back to the config default before pricing exists.
  const targetGpPctResolved = pricing && !err && pricing.targetGpPct != null
    ? Number(pricing.targetGpPct)
    : (dominantSystem?.target_gp_pct != null ? Number(dominantSystem.target_gp_pct) : config.targetGpPct);
  const gpBelowTarget =
    combinedGpPct != null && combinedGpPct * 100 < targetGpPctResolved - 0.05;

  // ---- Pricing-logic panel values (INTERNAL only, never on the public page) --
  const pricePerSqft = totalPrice != null && totalSqft > 0 ? totalPrice / totalSqft : null;
  // Add-on material/labor cost (included lines only), for the cost stack.
  const addonCost = useMemo(
    () => r2(addonMoneyItems.reduce((sum, li) => (li.is_optional ? sum : sum + li.qty * li.unit_cost), 0)),
    [addonMoneyItems],
  );
  // The engine cost stack at the engine price (M + F + labor + commission + sundries).
  const engineCost = pricing && !err
    ? r2((pricing.materialsCost ?? 0) + (pricing.fixedAddons ?? 0) + (pricing.laborDollars ?? 0) + (pricing.commissionDollars ?? 0) + (pricing.sundriesDollars ?? 0))
    : null;
  // Did charm-pricing fire? Compare the shipped price to what plain rounding
  // (no charm) would have produced from the same raw price.
  const charmFired = pricing && !err && pricing.priceRaw != null && basePrice != null &&
    roundEstimatePrice(pricing.priceRaw, { increment: config.priceIncrement, charmThreshold: 0, charmBand: 0 }) !== basePrice;
  // Floor GP: below it a save asks a hard confirm (warns, does not block).
  const belowFloor = combinedGpPct != null && combinedGpPct * 100 < config.floorGpPct - 0.05;

  const onSellInput = (v: string) => {
    const cleaned = v.replace(/[^0-9.]/g, '');
    setSellInput(cleaned);
    setPriceOverride(cleaned === '' ? null : 'sell');
    if (basePrice != null && cleaned !== '') {
      const n = Number(cleaned);
      if (Number.isFinite(n) && n > 0) setDiscInput(((1 - n / basePrice) * 100).toFixed(1));
    }
    if (cleaned === '') setDiscInput('');
  };
  const onDiscInput = (v: string) => {
    const cleaned = v.replace(/[^0-9.\-]/g, '');
    setDiscInput(cleaned);
    setPriceOverride(cleaned === '' ? null : 'disc');
    if (basePrice != null && cleaned !== '') {
      const d = Number(cleaned);
      if (Number.isFinite(d)) setSellInput(String(Math.max(0, Math.round(basePrice * (1 - d / 100)))));
    }
    if (cleaned === '') setSellInput('');
  };

  // ---- Comps: instant, straight from the database, no model call -----------
  const [compCandidates, setCompCandidates] = useState<CompCandidate[] | null>(null);
  const [compsFailed, setCompsFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    loadCompCandidates()
      .then((c) => { if (alive) setCompCandidates(c); })
      .catch(() => { if (alive) setCompsFailed(true); });
    return () => { alive = false; };
  }, []);

  // Comps key off the DOMINANT system. When the estimate spans systems the
  // panel says so instead of pretending the comps cover the whole job.
  const comps: CompsResult | null = useMemo(() => {
    if (!compCandidates || !dominantSystemId || !(totalSqft > 0)) return null;
    return buildComps({ candidates: compCandidates, systemTypeId: dominantSystemId, sqft: totalSqft, now: new Date() });
  }, [compCandidates, dominantSystemId, totalSqft]);
  const compsLabel = comps ? compsRuleLabel(comps, dominantSystem?.name ?? null) : '';
  const compsCaveat = comps ? compsGpCaveat(comps) : null;
  const dominantSqft = systemsBySqft[0]?.sqft ?? 0;
  const mixedCompsNote = mixedSystems
    ? `This estimate spans ${systemsBySqft.length} systems; comps cover the dominant one (${dominantSystem?.name ?? 'unknown'}, ${Math.round(dominantSqft).toLocaleString()} of ${Math.round(totalSqft).toLocaleString()} sqft).`
    : '';

  // ---- AI recommendation: automatic once system + sqft are present ---------
  // Debounced (900ms) so sqft keystrokes do not each fire a model call. Keyed
  // on (mvb + each system's sqft), the regeneration rule; the cached read on a
  // reopened estimate's row short-circuits the call entirely.
  const mvbSqft = useMemo(() => engineAreas.filter((a) => a.mvb).reduce((s, a) => s + a.sqft, 0), [engineAreas]);
  const inputsKey = useMemo(
    () => [`mvb:${Math.round(mvbSqft)}`, ...systemsBySqft.map((g) => `${g.systemId}:${Math.round(g.sqft)}`).sort()].join('|'),
    [mvbSqft, systemsBySqft],
  );
  const [ai, setAi] = useState<{ key: string; status: 'loading' | 'ready' | 'error'; rec?: AiRecommendation; err?: string } | null>(null);
  const editingSnapshot = editing?.pricingSnapshot ?? null;
  const aiLeadId = editing?.leadId ?? leadLink?.id ?? null;

  useEffect(() => {
    if (!hasPrice || !(totalSqft > 0) || !dominantSystemId || basePrice == null) return;
    if (ai && ai.key === inputsKey && ai.status !== 'error') return;
    // Reopened estimate, unchanged inputs: serve the read that priced it.
    if (editingSnapshot && editingSnapshot.inputs_key === inputsKey && editingSnapshot.ai) {
      setAi({ key: inputsKey, status: 'ready', rec: editingSnapshot.ai as AiRecommendation });
      return;
    }
    if (!online) return; // comps still render; the AI half just waits for signal
    if (compCandidates === null && !compsFailed) return; // let comps settle so the AI sees them
    const timer = setTimeout(async () => {
      setAi({ key: inputsKey, status: 'loading' });
      try {
        const compsPayload = comps
          ? compsForAi(comps, compsLabel)
          : { rule: 'none', rule_label: 'comps unavailable', sample_size: 0, median_ppsf: null, rows: [] };
        const rec = await fetchAiRecommendation({
          estimate_id: editing?.id ?? null,
          lead_id: aiLeadId,
          inputs_key: inputsKey,
          system_type_name: mixedSystems
            ? `${dominantSystem?.name ?? 'Unknown system'} (dominant; estimate spans ${systemsBySqft.length} systems)`
            : dominantSystem?.name ?? 'Unknown system',
          sqft: totalSqft,
          mvb: anyAreaMvb ? 'addon' : 'none',
          calc_price: basePrice,
          target_gp_pct: targetGpPctResolved,
          comps: compsPayload,
        });
        setAi((cur) => (cur && cur.key === inputsKey ? { key: inputsKey, status: 'ready', rec } : cur));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setAi((cur) => (cur && cur.key === inputsKey ? { key: inputsKey, status: 'error', err: msg } : cur));
      }
    }, 900);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsKey, hasPrice, online, compCandidates, compsFailed, basePrice]);

  const refreshPending = useCallback(async () => {
    try {
      setPending((await listOps()).length);
    } catch {
      /* IndexedDB unavailable */
    }
  }, []);

  useEffect(() => {
    refreshPending();
  }, [refreshPending]);
  useEffect(() => {
    if (online) drainOutbox().then(refreshPending).catch(() => {});
  }, [online, refreshPending]);
  useEffect(() => {
    setSaveState('idle');
  }, [areas, salespersonId, intake, customer, finalSell, addonForms, scopeAnswers, overrideReason]);

  const setArea = (i: number, patch: Partial<AreaForm>) =>
    setAreas((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  const setSlot = (i: number, slotId: string, value: string) =>
    setAreas((prev) =>
      prev.map((a, idx) => (idx === i ? { ...a, slotValues: { ...a.slotValues, [slotId]: value } } : a)),
    );
  const addArea = () =>
    setAreas((prev) => {
      // New areas inherit the previous area's system (a second garage bay is
      // likelier than a system switch; one tap changes it either way).
      const sysId = prev[prev.length - 1]?.systemTypeId ?? fallbackSystemId;
      return [...prev, { name: `Area ${prev.length + 1}`, sqft: '', systemTypeId: sysId, mvb: false, slotValues: defaultSlotValues(sysId) }];
    });
  const removeArea = (i: number) => setAreas((prev) => prev.filter((_, idx) => idx !== i));

  const onAreaSystemChange = (i: number, sysId: string) => {
    // New system, new slot set: re-seed THIS area with the new defaults.
    setAreas((prev) => prev.map((a, idx) => (idx === i ? { ...a, systemTypeId: sysId, slotValues: defaultSlotValues(sysId) } : a)));
  };

  // ---- Add-on handlers ------------------------------------------------------
  // The picker is filtered to the areas' systems plus the any-system add-ons.
  const areaSystemIds = useMemo(() => new Set(areas.map((a) => a.systemTypeId).filter(Boolean)), [areas]);
  const availableAddons = useMemo(
    () => addonCatalog.filter((a) => a.system_type_id == null || areaSystemIds.has(a.system_type_id)),
    [addonCatalog, areaSystemIds],
  );
  const addAddonFromCatalog = (addonId: string) => {
    const a = availableAddons.find((x) => x.id === addonId);
    if (!a) return;
    setAddonForms((prev) => [
      ...prev,
      {
        key: uuid(),
        addonId: a.id,
        label: a.name,
        description: a.description ?? '',
        qty: '1',
        unitPrice: String(a.default_price ?? 0),
        unitCost: String(a.default_cost ?? 0),
        optional: a.is_optional_default,
      },
    ]);
  };
  const addOneOff = () =>
    setAddonForms((prev) => [
      ...prev,
      { key: uuid(), addonId: null, label: '', description: '', qty: '1', unitPrice: '', unitCost: '', optional: false },
    ]);
  const setAddonForm = (key: string, patch: Partial<AddonForm>) =>
    setAddonForms((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  const removeAddonForm = (key: string) => setAddonForms((prev) => prev.filter((f) => f.key !== key));

  const addonsIncomplete = addonForms.some((f) => !f.label.trim() || !(Number(f.qty) > 0) || !(Number(f.unitPrice) >= 0));
  // An override (system sell price moved off the engine price) needs a reason.
  const overrideNeedsReason = discounted && !overrideReason.trim();
  // Identity gate (build 23): a commercial estimate needs its company, a
  // residential one a last name. Deliberately nothing else; the address is
  // never a gate (a rep standing in the driveway knows where they are).
  const customerIncomplete = customer.isCommercial ? !customer.company.trim() : !customer.lastName.trim();
  const canSave = !!salesperson && hasPrice && !mvbMissing && !addonsIncomplete && !overrideNeedsReason && !customerIncomplete && saveState !== 'saving';

  // Flake color at estimate level: the first area's swatch pick names it; the
  // customer often picks AFTER the presentation, so null is normal here and
  // the estimate page can fill it in later.
  const flakeColorFromPicks = useMemo(() => {
    for (const a of areas) {
      for (const s of slotsFor(a.systemTypeId)) {
        if (!SWATCH_TYPES.has(s.material_type) || kindOf(s) !== 'product') continue;
        const v = a.slotValues[s.id];
        if (v && productsById[v]) return productsById[v].color || productsById[v].name;
      }
    }
    return null;
  }, [areas, slotsFor, productsById]);

  const postToParent = useCallback((msg: Record<string, unknown>) => {
    // Same-origin by construction (the dashboard and /estimator/ share a host);
    // targeting the explicit origin means the message can never leak elsewhere.
    try { window.parent?.postMessage(msg, window.location.origin); } catch { /* not framed */ }
  }, []);

  // The full page's Back button: return to wherever the rep came from when it
  // was a same-origin page (a full-screen estimator that dead-ends was the
  // complaint), else land on the dashboard root.
  const goBack = useCallback(() => {
    try {
      const ref = document.referrer ? new URL(document.referrer) : null;
      if (ref && ref.origin === window.location.origin && window.history.length > 1) {
        window.history.back();
        return;
      }
    } catch { /* malformed referrer */ }
    window.location.href = '/';
  }, []);

  // Fire the AI scope writer after a save. FREE regeneration only while no
  // human has edited the scope; an edited scope is marked stale by the save
  // itself (markScopeStale) and regenerating then requires the explicit click
  // on the estimate page. Best-effort: the estimate page has a Generate button
  // for anything missed here, and offline saves generate later by design.
  const triggerScope = useCallback(async (estimateId: string) => {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      await fetch('/.netlify/functions/pec-estimate-scope', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ estimate_id: estimateId }),
      });
    } catch { /* the estimate page's Generate button covers this */ }
  }, []);

  const onSave = useCallback(async () => {
    if (!salesperson || !pricing || !hasPrice || finalSell == null || totalPrice == null) return;
    if (editing && !online) {
      setSaveState('error');
      setSaveError('Editing an existing estimate needs a connection (it rewrites saved areas). Reconnect and save again.');
      return;
    }
    // Floor-GP guard (build 17): warn, do not block. Same philosophy as the 15c
    // BLANK-scope send gate.
    if (belowFloor && !window.confirm(`Gross profit is ${combinedGpPct != null ? (combinedGpPct * 100).toFixed(1) : '--'}%, below the ${config.floorGpPct}% floor. Save this estimate anyway?`)) {
      return;
    }
    setSaveState('saving');
    setSaveError('');
    try {
      const areaInputs: AreaInput[] = pricedAreas.map((a) => {
        const d = deriveProducts(a.slotValues, a.systemTypeId);
        const areaSlots = slotsFor(a.systemTypeId);
        const materials: AreaMaterialInput[] = areaSlots
          .filter((s) => a.slotValues[s.id])
          .map((s) => {
            const k = kindOf(s);
            const v = a.slotValues[s.id];
            return {
              recipe_slot_id: s.id,
              slot_label: s.label ?? null,
              slot_kind: s.slot_kind ?? 'product',
              material_type: s.material_type,
              product_id: k === 'product' ? v : null,
              choice_value: k === 'choice' ? v : null,
              text_value: k === 'text' ? v : null,
              pick_index: 0,
              order_index: s.order_index,
            };
          });
        return {
          name: a.name || 'Area',
          sqft: Number(a.sqft) || 0,
          systemTypeId: a.systemTypeId,
          flakeProductId: d.flake,
          basecoatProductId: d.basecoat,
          topcoatProductId: d.topcoat,
          mvb: a.mvb === true,
          answers: a.slotValues,
          materials,
        };
      });

      const intakePayload: Record<string, unknown> = {
        gate_code: intake.gate_code || null,
        coat_past_garage: intake.coat_past_garage,
        stem_walls: intake.stem_walls,
        moisture: intake.moisture ? Number(intake.moisture) : null,
        mohs_hardness: intake.mohs_hardness ? Number(intake.mohs_hardness) : null,
        additional_non_slip: intake.additional_non_slip || null,
        grinder_tooling_grit: intake.grinder_tooling_grit || null,
        special_notes: intake.special_notes || null,
        base_price: basePrice,
        discount_pct: discounted && adjusted ? adjusted.discountPct : null,
      };

      // ---- Line items: one per AREA (its share of the system sell price),
      // then the add-ons and one-offs. Areas' amounts are allocated from each
      // area's own solo cost-plus solve, so a big garage carries more of the
      // price than a small patio and the parts sum EXACTLY to the sell price.
      const lineItems: LineItemInput[] = [];
      {
        const soloByArea = engineAreas.map((a) => {
          const solo = computeEstimatePricing({
            areas: [a],
            productsById,
            recipeSlotsBySystemType,
            systemTypes,
            laborRate: config.laborRate,
            commissionPct: config.standardCommissionPct,
            targetGpPct: config.targetGpPct,
            priceIncrement: 1,
            charmThreshold: 0,
            charmBand: 0,
            sundriesPct: config.sundriesPct,
            mvbProductId: mvbProduct?.id ?? null,
          } as Parameters<typeof computeEstimatePricing>[0]);
          return solo && !solo.error ? solo : null;
        });
        const weights = soloByArea.map((s, i) => (s && s.priceRaw ? s.priceRaw : engineAreas[i].sqft));
        const parts = allocateProportionally(finalSell, weights);
        engineAreas.forEach((a, i) => {
          const sys = systemTypes.find((s) => s.id === a.system_type_id);
          const sysName = sys?.name ?? 'Floor coating';
          const isMvbOnly = sys?.name === MVB_ONLY_SYSTEM_NAME;
          lineItems.push({
            addonId: null,
            areaIndex: i,
            label: engineAreas.length > 1 ? `${a.name}: ${sysName}` : (isMvbOnly ? sysName : `${sysName} floor coating system`),
            description:
              `${Math.round(a.sqft)} sqft` +
              (a.mvb && !isMvbOnly ? ', includes moisture vapor barrier (MVB)' : ''),
            qty: 1,
            unitPrice: parts[i],
            unitCost: r2(Number(soloByArea[i]?.materialsCost) || 0),
            total: parts[i],
            isOptional: false,
            selectedByCustomer: true,
            sortOrder: i,
          });
        });
      }
      let sort = lineItems.length;
      for (const f of addonForms) {
        const qty = Number(f.qty) > 0 ? Number(f.qty) : 1;
        const unitPrice = Number(f.unitPrice) || 0;
        lineItems.push({
          addonId: f.addonId,
          areaIndex: null,
          label: f.label.trim(),
          description: f.description.trim() || null,
          qty,
          unitPrice,
          unitCost: Number(f.unitCost) || 0,
          total: r2(qty * unitPrice),
          isOptional: f.optional,
          selectedByCustomer: false,
          sortOrder: sort++,
        });
      }

      const totals: EstimateTotals = {
        price: totalPrice,
        gpDollars: combinedGpDollars,
        gpPct: combinedGpPct,
        gpPerHour: combinedGpPerHour,
        laborBudget: adjusted ? adjusted.laborDollars : null,
        commissionDollars: combinedCommission,
        budgetedHours: adjusted ? adjusted.budgetedHours : null,
      };

      const pricingSnapshot: Record<string, unknown> = {
        inputs_key: inputsKey,
        comps: comps
          ? {
              rule: comps.rule,
              rule_label: compsLabel,
              sample_size: comps.sample_size,
              median_ppsf: comps.median_ppsf,
              // Persisted so the estimate page shows the SAME GP% caveat the
              // rep saw at pricing time without re-fetching the costing rows.
              complete_count: comps.complete_count,
              gp_pct_count: comps.gp_pct_count,
              gp_caveat: compsCaveat,
              rows: comps.rows.map((r) => ({
                customer_name: r.customer_name,
                completed_date: r.completed_date,
                sqft: r.sqft,
                price: r.price,
                ppsf: r.ppsf,
                gp_pct: r.gp_pct,
                gp_complete: r.gp_complete,
              })),
            }
          : null,
        ai: ai?.status === 'ready' && ai.key === inputsKey && ai.rec ? { ...ai.rec, inputs_key: inputsKey } : null,
      };

      // Edit-in-place: rewrite the child rows (line items first, then areas;
      // the materials rows cascade). Online-only, checked above.
      if (editing) await deleteEstimateChildren(editing.id);

      const scopeWasEdited = !!editing?.scopeEditedAt;
      const { id } = await saveEstimateOffline({
        estimateId: editing?.id ?? null,
        status: editing?.status ?? 'draft',
        systemTypeId: dominantSystemId,
        salesperson: { id: salesperson.id, name: salesperson.name, commission_pct: salesperson.commission_pct ?? 0 },
        intake: intakePayload,
        // Split shape straight through; saveEstimateOffline trims, composes
        // the combined customer_name/customer_address safety nets, and writes
        // both alongside the split columns.
        customer,
        flakeColor: editing?.flakeColor ?? flakeColorFromPicks,
        scopeAnswers,
        lineItems,
        pricingSnapshot,
        areas: areaInputs,
        pricing,
        totals,
        // Provenance: the engine price, and the override reason/who when the rep
        // moved the system sell price off it.
        calcPrice: basePrice,
        priceOverride: discounted ? { reason: overrideReason.trim(), by: createdBy } : null,
        createdBy: editing?.createdBy ?? createdBy,
        leadId: editing?.leadId ?? leadLink?.id ?? null,
        markScopeStale: scopeWasEdited,
      });
      let syncedNumber: number | null = editing?.estimateNumber ?? null;
      if (navigator.onLine) {
        await drainOutbox().catch(() => {});
        if (syncedNumber == null) {
          try {
            const { data } = await supabase.from('estimates').select('estimate_number').eq('id', id).maybeSingle();
            syncedNumber = (data as { estimate_number: number | null } | null)?.estimate_number ?? null;
          } catch { /* the number arrives when the outbox drains */ }
        }
        // Auto-write the customer scope: on first save (scope null) and on any
        // re-save while no human has edited it. An edited scope was marked
        // stale above and is NEVER regenerated without the explicit click.
        if (!scopeWasEdited) triggerScope(id);
      }
      await refreshPending();
      setSavedOffline(!navigator.onLine);
      setSaveState('saved');
      if (embed) {
        // The dashboard closes the modal, refreshes the lead, and opens the
        // estimate page off this message (origin-checked on its side).
        postToParent({ type: 'pec-estimate-saved', estimate_id: id, estimate_number: syncedNumber });
      }
    } catch (e) {
      setSaveState('error');
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }, [salesperson, pricing, hasPrice, finalSell, totalPrice, editing, online, pricedAreas, engineAreas, deriveProducts, slotsFor, intake, basePrice, discounted, adjusted, overrideReason, mvbProduct, totalSqft, inputsKey, comps, compsLabel, ai, customer, flakeColorFromPicks, createdBy, leadLink, refreshPending, embed, postToParent, addonForms, scopeAnswers, belowFloor, combinedGpDollars, combinedGpPct, combinedGpPerHour, combinedCommission, dominantSystemId, systemTypes, productsById, recipeSlotsBySystemType, config, triggerScope]);

  const setIntakeField = <K extends keyof Intake>(k: K, v: Intake[K]) => setIntake((p) => ({ ...p, [k]: v }));
  const setCustomerField = (k: Exclude<keyof CustomerForm, 'isCommercial'>, v: string) =>
    setCustomer((p) => ({ ...p, [k]: v }));
  // "Commercial" IS "has a company name" (Dylan's definition), so the toggle
  // and the field must never disagree: switching to Residential clears the
  // company (visible and retypeable), and the company input only exists in
  // the Commercial view, so a non-empty company always means commercial.
  const setCommercial = (isCommercial: boolean) =>
    setCustomer((p) =>
      p.isCommercial === isCommercial ? p : { ...p, isCommercial, company: isCommercial ? p.company : '' },
    );

  return (
    <div className="screen">
      <header className="topbar">
        <div className="brand">
          PEC Estimator <span className="beta">beta</span>
          {editing && (
            <span className="lead-chip" title={`Editing estimate ${editing.id} in place`}>
              Editing {editing.estimateNumber != null ? `EST-${editing.estimateNumber}` : 'estimate'}
            </span>
          )}
          {/* Visible proof the deep link took. Without it, "attached to the lead"
              is invisible state and the rep cannot tell a good link from a bad one. */}
          {!editing && leadLink && (
            <span className="lead-chip" title={`This estimate will attach to lead ${leadLink.id}`}>
              Lead: {leadLink.name || 'linked'}
            </span>
          )}
        </div>
        <div className="status">
          <span className={online ? 'dot online' : 'dot offline'} title={online ? 'Online' : 'Offline'} />
          <span className="status-text">
            {online ? 'Online' : 'Offline'}
            {pending > 0 && ` · ${pending} to sync`}
            {catalogFromCache && ' · cached catalog'}
          </span>
          {/* Inside the dashboard's iframe modal a Back/Dashboard control is
              redundant (and navigating INSIDE the iframe would strand the
              user); a Close button that messages the parent replaces it. The
              full page gets a real Back that returns where the rep came from. */}
          {embed ? (
            <button type="button" className="back as-btn" onClick={() => postToParent({ type: 'pec-estimator-close' })}>
              Close
            </button>
          ) : (
            <button type="button" className="back as-btn" onClick={goBack}>
              ← Back
            </button>
          )}
        </div>
      </header>

      <main className="cols">
        <div className="left">
          <section className="card inputs">
            <div className="areas-head">
              <span>Customer</span>
              {/* Residential = first + last name; Commercial = company
                  (required) + optional contact person. One fact, two views. */}
              <div className="cust-type" role="group" aria-label="Customer type">
                <button type="button" className={customer.isCommercial ? '' : 'on'} onClick={() => setCommercial(false)}>Residential</button>
                <button type="button" className={customer.isCommercial ? 'on' : ''} onClick={() => setCommercial(true)}>Commercial</button>
              </div>
            </div>
            <div className="cust-grid">
              {customer.isCommercial ? (
                <>
                  <label className="field cust-wide"><span>Company name{customer.company.trim() ? '' : ' (required)'}</span><input value={customer.company} onChange={(e) => setCustomerField('company', e.target.value)} placeholder="Business name" /></label>
                  <label className="field"><span>Contact first name</span><input value={customer.firstName} onChange={(e) => setCustomerField('firstName', e.target.value)} placeholder="Optional" /></label>
                  <label className="field"><span>Contact last name</span><input value={customer.lastName} onChange={(e) => setCustomerField('lastName', e.target.value)} placeholder="Optional" /></label>
                </>
              ) : (
                <>
                  <label className="field"><span>First name</span><input value={customer.firstName} onChange={(e) => setCustomerField('firstName', e.target.value)} /></label>
                  <label className="field"><span>Last name{customer.lastName.trim() ? '' : ' (required)'}</span><input value={customer.lastName} onChange={(e) => setCustomerField('lastName', e.target.value)} /></label>
                </>
              )}
              <label className="field"><span>Phone</span><input value={customer.phone} onChange={(e) => setCustomerField('phone', e.target.value)} inputMode="tel" /></label>
              <label className="field"><span>Email</span><input value={customer.email} onChange={(e) => setCustomerField('email', e.target.value)} inputMode="email" /></label>
              <label className="field cust-wide"><span>Address 1</span>
                <AddressAutocomplete
                  value={customer.address1}
                  onChange={(v) => setCustomerField('address1', v)}
                  // A pick replaces the whole location: city/state/zip take the
                  // resolved values outright (stale leftovers from a previous
                  // address would be worse than a blank), while Address 2 only
                  // updates when the pick itself carries a unit, so a typed
                  // suite number survives. Everything stays hand-editable.
                  onResolve={(r) =>
                    setCustomer((p) => ({
                      ...p,
                      address1: r.address1 || p.address1,
                      address2: r.address2 || p.address2,
                      city: r.city,
                      state: r.state,
                      zip: r.zip,
                    }))
                  }
                  placeholder="Street address"
                />
              </label>
              <label className="field cust-wide"><span>Address 2</span><input value={customer.address2} onChange={(e) => setCustomerField('address2', e.target.value)} placeholder="Suite / unit (optional)" /></label>
              <div className="cust-csz">
                <label className="field"><span>City</span><input value={customer.city} onChange={(e) => setCustomerField('city', e.target.value)} /></label>
                <label className="field"><span>State</span><input value={customer.state} onChange={(e) => setCustomerField('state', e.target.value)} placeholder="AZ" /></label>
                <label className="field"><span>Zip</span><input value={customer.zip} onChange={(e) => setCustomerField('zip', e.target.value)} inputMode="numeric" /></label>
              </div>
            </div>
          </section>

          <section className="card inputs">
            <label className="field">
              <span>Salesperson</span>
              <select value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)}>
                <option value="">Select…</option>
                {salespeople.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.commission_pct ?? 0}% commission)
                  </option>
                ))}
              </select>
            </label>

            {mvbMissing && (
              <p className="error">The product "{MVB_PRODUCT_NAME}" is missing or inactive in the Catalog, so the moisture vapor barrier cannot be priced. Restore it (Price &amp; Material Catalog) or uncheck MVB on the areas.</p>
            )}
          </section>

          <section className="card">
            <div className="areas-head"><span>Areas</span><button type="button" className="link" onClick={addArea}>+ Add area</button></div>
            {/* Each area picks its own system: a garage plus a patio plus stem
                walls is ONE estimate now. Pricing weights every area's own
                system; the dominant (most sqft) system is what reports. */}
            {areas.map((a, i) => (
              <div className="area" key={i}>
                <div className="area-top">
                  <input className="area-name" value={a.name} onChange={(e) => setArea(i, { name: e.target.value })} placeholder="Area name" />
                  <select
                    className="area-system"
                    value={a.systemTypeId}
                    onChange={(e) => onAreaSystemChange(i, e.target.value)}
                    aria-label={`System for ${a.name || `Area ${i + 1}`}`}
                  >
                    {systemTypes.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  <input
                    className="area-sqft"
                    inputMode="decimal"
                    value={a.sqft}
                    onChange={(e) => setArea(i, { sqft: e.target.value.replace(/[^0-9.]/g, '') })}
                    placeholder="sq ft"
                  />
                  {areas.length > 1 && <button type="button" className="x" aria-label="Remove area" onClick={() => removeArea(i)}>×</button>}
                </div>
                {/* Per-area MVB (build 17), default OFF. Hidden on an MVB Only
                    area, whose system already IS the barrier. */}
                {!isMvbOnlySystem(a.systemTypeId) && (
                  <label className="check area-mvb">
                    <input type="checkbox" checked={a.mvb} onChange={(e) => setArea(i, { mvb: e.target.checked })} />
                    <span>Add moisture vapor barrier (MVB) to this area</span>
                  </label>
                )}
              </div>
            ))}
          </section>

          <section className="card">
            <div className="areas-head">
              <span>Add-ons</span>
              <button type="button" className="link" onClick={addOneOff}>+ One-off line</button>
            </div>
            <label className="field">
              <span>Add from catalog</span>
              <select
                value=""
                onChange={(e) => { if (e.target.value) addAddonFromCatalog(e.target.value); }}
              >
                <option value="">Pick an add-on…</option>
                {availableAddons.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}{a.default_price > 0 ? ` (${money2(a.default_price)}/${a.unit})` : ''}
                  </option>
                ))}
              </select>
            </label>
            {addonForms.length === 0 && (
              <p className="hint">Stem walls, joint filling, upgrades, drive time. Optional items stay OUT of the total until the customer picks them.</p>
            )}
            {addonForms.map((f) => (
              <div className="addon-row" key={f.key}>
                <div className="addon-main">
                  {f.addonId ? (
                    <span className="addon-label">{f.label}</span>
                  ) : (
                    <input className="addon-label-input" value={f.label} placeholder="One-off item name" onChange={(e) => setAddonForm(f.key, { label: e.target.value })} />
                  )}
                  {!f.addonId && <span className="oneoff-badge" title="Not in the catalog. If this keeps getting typed, promote it to the add-on catalog.">one-off</span>}
                  <button type="button" className="x" aria-label={`Remove ${f.label || 'line'}`} onClick={() => removeAddonForm(f.key)}>×</button>
                </div>
                {!f.addonId && (
                  <input className="addon-desc" value={f.description} placeholder="Description (customer sees this)" onChange={(e) => setAddonForm(f.key, { description: e.target.value })} />
                )}
                <div className="addon-nums">
                  <label className="field"><span>Qty</span><input inputMode="decimal" value={f.qty} onChange={(e) => setAddonForm(f.key, { qty: e.target.value.replace(/[^0-9.]/g, '') })} /></label>
                  <label className="field"><span>Price $</span><input inputMode="decimal" value={f.unitPrice} onChange={(e) => setAddonForm(f.key, { unitPrice: e.target.value.replace(/[^0-9.]/g, '') })} /></label>
                  <label className="field"><span>Cost $</span><input inputMode="decimal" value={f.unitCost} onChange={(e) => setAddonForm(f.key, { unitCost: e.target.value.replace(/[^0-9.]/g, '') })} /></label>
                  <label className="check addon-opt"><input type="checkbox" checked={f.optional} onChange={(e) => setAddonForm(f.key, { optional: e.target.checked })} /><span>Optional (customer picks)</span></label>
                  <span className="addon-total">{money2(r2((Number(f.qty) > 0 ? Number(f.qty) : 1) * (Number(f.unitPrice) || 0)))}</span>
                </div>
                {Number(f.unitPrice) > 0 && !(Number(f.unitCost) > 0) && (
                  <p className="warn addon-warn">No cost on this line: it books as pure margin and inflates GP until a cost is set{f.addonId ? ' (set a default in the Catalog)' : ''}.</p>
                )}
              </div>
            ))}
          </section>

          {scopeQuestions.length > 0 && (
            <section className="card scope-questions">
              <div className="areas-head"><span>Finish the scope</span></div>
              <p className="hint">Your template leaves these blanks for the customer. Fill them in now while you are on site; anything left blank shows up as the word BLANK in the scope they sign.</p>
              {scopeQuestions.map((q) => (
                <label className="field" key={q.key}>
                  <span>{q.label}</span>
                  <input
                    value={scopeAnswers[q.key] ?? ''}
                    onChange={(e) => setScopeAnswer(q.key, e.target.value)}
                    placeholder="Fill in the blank"
                  />
                </label>
              ))}
            </section>
          )}

          {/* Everything below is OPTIONAL and collapsed: a rep who never opens
              it still gets a correct price off the recipe defaults. */}
          <details className="card more-detail">
            <summary>More detail <span className="muted">(products, colors, work order)</span></summary>
            {areas.map((a, i) => {
              const areaSlots = slotsFor(a.systemTypeId);
              if (!areaSlots.length) return null;
              return (
                <div className="area" key={i}>
                  {areas.length > 1 && <div className="area-label">{a.name || `Area ${i + 1}`} <span className="muted">({systemTypes.find((s) => s.id === a.systemTypeId)?.name ?? ''})</span></div>}
                  <div className="slots">
                    {areaSlots.map((s) => (
                      <label className="field" key={s.id}>
                        <span>{s.label || s.material_type}{s.required ? ' *' : ''}</span>
                        <SlotControl
                          slot={s}
                          value={a.slotValues[s.id] ?? ''}
                          products={productsByType[s.material_type] ?? []}
                          onChange={(v) => setSlot(i, s.id, v)}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
            <p className="hint">Flake color can stay unpicked; the price already includes standard flake, the customer usually chooses after the presentation, and it stays editable on the estimate page.</p>
            <div className="areas-head" style={{ marginTop: 10 }}><span>Work order</span></div>
            <div className="wo-grid">
              <label className="field"><span>Gate code</span><input value={intake.gate_code} onChange={(e) => setIntakeField('gate_code', e.target.value)} /></label>
              <label className="field"><span>Moisture (1-5)</span>
                <select value={intake.moisture} onChange={(e) => setIntakeField('moisture', e.target.value)}>
                  <option value="">--</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="field"><span>MOHS hardness (1-10)</span>
                <select value={intake.mohs_hardness} onChange={(e) => setIntakeField('mohs_hardness', e.target.value)}>
                  <option value="">--</option>{[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="field"><span>Grinder tooling / grit</span><input value={intake.grinder_tooling_grit} onChange={(e) => setIntakeField('grinder_tooling_grit', e.target.value)} /></label>
              <label className="field"><span>Additional non-slip</span><input value={intake.additional_non_slip} onChange={(e) => setIntakeField('additional_non_slip', e.target.value)} /></label>
              <label className="check"><input type="checkbox" checked={intake.coat_past_garage} onChange={(e) => setIntakeField('coat_past_garage', e.target.checked)} /><span>Coat past garage door</span></label>
              <label className="check"><input type="checkbox" checked={intake.stem_walls} onChange={(e) => setIntakeField('stem_walls', e.target.checked)} /><span>Stem walls</span></label>
            </div>
            <label className="field"><span>Special notes</span><textarea rows={2} value={intake.special_notes} onChange={(e) => setIntakeField('special_notes', e.target.value)} /></label>
          </details>
        </div>

        <div className="right">
          <section className="card result" aria-live="polite">
            {!salesperson && <p className="hint">Pick a salesperson to price the job.</p>}
            {salesperson && !hasPrice && !err && !mvbMissing && <p className="hint">Enter the square footage to price the job.</p>}
            {err && <p className="error">{ERROR_COPY[err] ?? err}</p>}
            {hasPrice && pricing && adjusted && (
              <>
                <div className="price">{money(totalPrice)}</div>
                {hasOptionalAddons && totalAllOptions != null && totalAllOptions !== totalPrice && (
                  <p className="hint">with every optional item: {money(totalAllOptions)}</p>
                )}
                {(discounted || addonsBaseTotal > 0) && (
                  <p className="hint">
                    system {money(finalSell)}
                    {discounted ? ` (calculated ${money(basePrice)}${adjusted.discountPct != null ? `, ${adjusted.discountPct.toFixed(1)}% discount` : ''})` : ''}
                    {addonsBaseTotal > 0 ? ` + add-ons ${money(addonsBaseTotal)}` : ''}
                  </p>
                )}
                {/* $/sqft: the number Dylan wants at a glance. INTERNAL. */}
                {pricePerSqft != null && (
                  <div className="ppsf-line">{money2(pricePerSqft)}<span className="muted"> / sqft</span></div>
                )}
                <div className="sell-row">
                  <label className="field"><span>Sell price $ (system)</span>
                    <input inputMode="decimal" value={sellInput} placeholder={basePrice != null ? String(basePrice) : ''} onChange={(e) => onSellInput(e.target.value)} />
                  </label>
                  <label className="field"><span>Discount %</span>
                    <input inputMode="decimal" value={discInput} placeholder="0" onChange={(e) => onDiscInput(e.target.value)} />
                  </label>
                </div>
                {/* Override reason: required to save when the price was moved. */}
                {discounted && (
                  <label className="field override-reason">
                    <span>Why the price was changed{overrideNeedsReason ? ' (required)' : ''}</span>
                    <input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="problem customer, large sqft, competitor match…" />
                  </label>
                )}
                {overrideNeedsReason && <p className="warn">A reason is required to save a changed price.</p>}
                <dl className="metrics">
                  <div><dt>Gross profit</dt><dd className={gpBelowTarget ? 'gp-red' : ''}>{money(combinedGpDollars)} ({pct(combinedGpPct)})</dd></div>
                  <div><dt>Target GP</dt><dd>{Number(targetGpPctResolved).toFixed(1).replace(/\.0$/, '')}%</dd></div>
                  <div><dt>GP / hour</dt><dd>{money2(combinedGpPerHour)}</dd></div>
                  <div><dt>Materials</dt><dd>{money2(pricing.materialsCost)}</dd></div>
                  <div><dt>Labor ({pricing.laborPct != null ? Number(pricing.laborPct).toFixed(1).replace(/\.0$/, '') : '--'}%)</dt><dd>{money2(adjusted.laborDollars)}<span className="muted"> · {adjusted.budgetedHours?.toFixed(1) ?? '--'}h</span></dd></div>
                  <div><dt>Sundries ({Number(pricing.sundriesPct).toFixed(1).replace(/\.0$/, '')}%)</dt><dd>{money2(adjusted.sundriesDollars)}</dd></div>
                  <div><dt>Commission (standard {pricing.standardCommissionPct}%)</dt><dd>{money2(combinedCommission)}</dd></div>
                  {addonCost > 0 && <div><dt>Add-on cost</dt><dd>{money2(addonCost)}</dd></div>}
                </dl>
                {/* How the price was reached, in one plain-English line. */}
                <p className="derivation">
                  {engineCost != null && basePrice != null
                    ? `cost of ${money(engineCost)} priced to a ${Number(targetGpPctResolved).toFixed(1).replace(/\.0$/, '')}% target GP = ${money(pricing.priceRaw)}, rounded to ${money(basePrice)}${mixedSystems ? `, weighted across ${systemsBySqft.length} systems` : ''}${charmFired ? ' (charm-priced just under a round number, so GP dips slightly under target on purpose)' : ''}`
                    : ''}
                </p>
                {gpBelowTarget && (
                  <p className="warn gp-warn">GP is below the {Number(targetGpPctResolved).toFixed(1).replace(/\.0$/, '')}% target{mixedSystems ? ' (sqft-weighted across the area systems)' : ' for this system'}. Saving still works; the number is just red on purpose.</p>
                )}
                {belowFloor && (
                  <p className="warn gp-warn">GP is below the {config.floorGpPct}% floor. Saving asks you to confirm.</p>
                )}
                {pricing.materialsMissingCost && pricing.materialsMissingCost.length > 0 && (
                  <p className="warn">No cost set for: {pricing.materialsMissingCost.join(', ')}. Price may be understated until these are priced in the Catalog.</p>
                )}
                <p className="calcver">engine {pricing.calcVersion}</p>
                {customerIncomplete && (
                  <p className="warn">{customer.isCommercial ? 'Enter the company name (Customer card) to save.' : 'Enter the customer’s last name (Customer card) to save.'}</p>
                )}
                <div className="save-row">
                  <button type="button" className="save" disabled={!canSave} onClick={onSave}>
                    {saveState === 'saving' ? 'Saving…' : editing ? 'Save changes' : 'Save estimate'}
                  </button>
                  {saveState === 'saved' && (
                    <span className="save-note ok">{savedOffline ? 'Saved offline · will sync when online · scope writes itself once connected (or from the estimate page)' : 'Saved & synced'}</span>
                  )}
                  {saveState === 'error' && <span className="save-note bad">{saveError || 'Save failed'}</span>}
                </div>
              </>
            )}
          </section>

          <section className="card comps">
            <div className="areas-head"><span>Comparable jobs</span></div>
            {!(totalSqft > 0) && <p className="hint">Comps appear once the square footage is set.</p>}
            {totalSqft > 0 && compsFailed && (
              <p className="hint">{online ? 'Could not load completed jobs to compare against.' : 'Comps need a connection; the price above works offline.'}</p>
            )}
            {totalSqft > 0 && !compsFailed && !comps && <p className="hint">Loading completed jobs…</p>}
            {comps && comps.sample_size === 0 && <p className="hint">{compsLabel}.</p>}
            {comps && comps.sample_size > 0 && (
              <>
                <div className="comps-median">
                  Median {money2(comps.median_ppsf)}/sqft
                  {comps.median_ppsf != null && totalSqft > 0 && (
                    <span className="muted"> · {money(comps.median_ppsf * totalSqft)} at {Math.round(totalSqft)} sqft</span>
                  )}
                </div>
                <p className="comps-rule">{compsLabel}</p>
                {mixedCompsNote && <p className="warn">{mixedCompsNote}</p>}
                <div className="comps-table-wrap">
                  <table className="comps-table">
                    <thead><tr><th>Customer</th><th>Sqft</th><th>Price</th><th>$/sqft</th><th>GP%</th></tr></thead>
                    <tbody>
                      {comps.rows.map((r) => (
                        <tr key={r.id}>
                          <td>{r.customer_name || '--'}</td>
                          <td>{r.sqft != null ? Math.round(r.sqft).toLocaleString() : '--'}</td>
                          <td>{money(r.price)}</td>
                          <td>{r.ppsf != null ? `$${r.ppsf.toFixed(2)}` : '--'}</td>
                          <td>{r.gp_pct != null ? `${(r.gp_pct * 100).toFixed(0)}%` : '--'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {compsCaveat && <p className="hint" style={{ marginTop: 6 }}>{compsCaveat}.</p>}
              </>
            )}
          </section>

          <section className="card ai-panel">
            <div className="areas-head"><span>AI price read</span></div>
            {!(totalSqft > 0 && hasPrice) && <p className="hint">Runs automatically once system and square footage are set.</p>}
            {totalSqft > 0 && hasPrice && !online && ai?.status !== 'ready' && <p className="hint">Needs a connection; the calculated price and comps stand on their own.</p>}
            {ai?.status === 'loading' && <p className="hint">Analyzing against comps…</p>}
            {ai?.status === 'error' && <p className="warn">AI read failed: {ai.err}</p>}
            {ai?.status === 'ready' && ai.rec && (
              <>
                <div className="ai-range">{money(ai.rec.recommended_low)} to {money(ai.rec.recommended_high)}</div>
                <p className="ai-why">{ai.rec.why}</p>
                {ai.rec.history_available && ai.rec.intent_read && (
                  <p className="ai-why"><strong>Customer signal:</strong> {ai.rec.intent_read}</p>
                )}
                {ai.rec.history_available === false && (
                  <p className="hint">No call or text history on file for this customer.</p>
                )}
                <p className="calcver">The AI never sets the price; you do.</p>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function SlotControl({
  slot,
  value,
  products,
  onChange,
}: {
  slot: RecipeSlot;
  value: string;
  products: Product[];
  onChange: (v: string) => void;
}) {
  const kind = kindOf(slot);
  if (kind === 'text') {
    return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={slot.label ?? ''} />;
  }
  if (kind === 'choice') {
    const opts = normalizeOptions(slot.options);
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">--</option>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  const isSwatch = SWATCH_TYPES.has(slot.material_type);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{isSwatch ? 'Color / custom blend' : 'Use default'}</option>
      {products.map((p) => (
        <option key={p.id} value={p.id}>{isSwatch ? p.color || p.name : p.name}</option>
      ))}
    </select>
  );
}
