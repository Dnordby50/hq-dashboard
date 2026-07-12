import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Catalog, SalesPerson } from '../../lib/catalog';
import {
  applySellPrice,
  computeEstimatePricing,
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
  type LineItem,
  type SellOverride,
} from '../../offline/estimates';
import type { LeadLink } from '../../lib/lead';
import type { LoadedEstimate } from '../../lib/estimateLoad';
import { deleteEstimateAreas } from '../../lib/estimateLoad';
import { listOps } from '../../offline/outbox';
import { drainOutbox } from '../../offline/sync';
import { buildComps, compsRuleLabel, loadCompCandidates, type CompCandidate, type CompsResult } from '../../lib/comps';
import { compsForAi, fetchAiRecommendation, type AiRecommendation } from '../../lib/ai';
import { supabase } from '../../lib/supabase';
import { uuid } from '../../offline/uuid';

type AreaForm = { name: string; sqft: string; slotValues: Record<string, string> };
type Mvb = 'none' | 'addon' | 'standalone';
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

const SWATCH_TYPES = new Set(['Flake', 'Quartz', 'Metallic Pigment']);
// Same catalog row the dashboard's New Job flow resolves: the one MVB product
// priced for standalone application (100 sqft/gal across all areas).
const MVB_PRODUCT_NAME = 'Simiron MVB - Standalone';

const money = (n: number | null | undefined) =>
  n == null ? '--' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money2 = (n: number | null | undefined) =>
  n == null ? '--' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const pct = (frac: number | null | undefined) => (frac == null ? '--' : `${(frac * 100).toFixed(1)}%`);

const ERROR_COPY: Record<string, string> = {
  TARGET_UNREACHABLE:
    'Target margin is impossible for these inputs: labor + commission + target GP add up to 100% or more of revenue. Lower the target GP or commission.',
  NO_LABOR_PCT: 'This system has no labor budget percent set. Set it in the Catalog before pricing.',
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

  const initialSystemId = editing?.systemTypeId ?? systemTypes[0]?.id ?? '';
  const [salespersonId, setSalespersonId] = useState<string>(() => {
    const fromEdit = editing ? String(editing.intake.salesperson_id ?? '') : '';
    if (fromEdit && salespeople.some((s) => s.id === fromEdit)) return fromEdit;
    return salespeople[0]?.id ?? '';
  });
  const [systemTypeId, setSystemTypeId] = useState<string>(initialSystemId);
  const [mvb, setMvb] = useState<Mvb>(editing?.mvb ?? 'none');
  const [customer, setCustomer] = useState(() => ({
    name: editing?.customer.name ?? leadLink?.name ?? '',
    phone: editing?.customer.phone ?? leadLink?.phone ?? '',
    email: editing?.customer.email ?? leadLink?.email ?? '',
    address: editing?.customer.address ?? leadLink?.address ?? '',
  }));
  const [intake, setIntake] = useState<Intake>(() =>
    editing ? intakeFromLoaded(editing.intake) : emptyIntake,
  );
  const [areas, setAreas] = useState<AreaForm[]>(() =>
    editing
      ? editing.areas.map((a) => ({ name: a.name, sqft: a.sqft, slotValues: a.slotValues }))
      : [{ name: 'Main', sqft: '', slotValues: initialSystemId ? defaultSlotValues(initialSystemId) : {} }],
  );
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [savedOffline, setSavedOffline] = useState(false);
  const [pending, setPending] = useState(0);

  const salesperson: SalesPerson | undefined = salespeople.find((s) => s.id === salespersonId);
  const systemType = systemTypes.find((s) => s.id === systemTypeId);

  const mvbProduct = useMemo(
    () => Object.values(productsById).find((p) => p.name === MVB_PRODUCT_NAME) ?? null,
    [productsById],
  );

  // System's slots, ordered, with internal (editor_hidden) body coats removed.
  // A standalone-MVB estimate has no system recipe, so no slots to pick.
  const visibleSlots: RecipeSlot[] = useMemo(
    () =>
      mvb === 'standalone'
        ? []
        : (recipeSlotsBySystemType[systemTypeId] ?? []).filter((s) => !s.editor_hidden),
    [recipeSlotsBySystemType, systemTypeId, mvb],
  );

  const productsByType = useMemo(() => {
    const m: Record<string, Product[]> = {};
    for (const p of Object.values(productsById)) (m[p.material_type] ??= []).push(p);
    for (const list of Object.values(m)) list.sort((a, b) => (a.color ?? a.name).localeCompare(b.color ?? b.name));
    return m;
  }, [productsById]);

  // Map an area's raw slot answers to the flake/basecoat/topcoat the calculator
  // resolves against (first product slot of each kind wins).
  const deriveProducts = useCallback(
    (slotValues: Record<string, string>) => {
      let flake: string | null = null;
      let basecoat: string | null = null;
      let topcoat: string | null = null;
      for (const s of visibleSlots) {
        const v = slotValues[s.id];
        if (!v || kindOf(s) !== 'product') continue;
        if (SWATCH_TYPES.has(s.material_type) && !flake) flake = v;
        else if (s.material_type === 'Basecoat' && !basecoat) basecoat = v;
        else if (s.material_type === 'Topcoat' && !topcoat) topcoat = v;
      }
      return { flake, basecoat, topcoat };
    },
    [visibleSlots],
  );

  const engineAreas: Area[] = useMemo(
    () =>
      areas
        .map((a, i) => {
          const d = deriveProducts(a.slotValues);
          return {
            id: `a${i}`,
            name: a.name || `Area ${i + 1}`,
            sqft: Number(a.sqft) || 0,
            system_type_id: systemTypeId,
            flake_product_id: d.flake,
            basecoat_product_id: d.basecoat,
            topcoat_product_id: d.topcoat,
          };
        })
        .filter((a) => a.sqft > 0),
    [areas, systemTypeId, deriveProducts],
  );
  const totalSqft = useMemo(() => engineAreas.reduce((s, a) => s + a.sqft, 0), [engineAreas]);

  const pricing: PricingResult | null = useMemo(() => {
    if (!systemTypeId || !salesperson || !engineAreas.length) return null;
    if (mvb !== 'none' && !mvbProduct) return null; // surfaced as mvbMissing below
    return computeEstimatePricing({
      areas: engineAreas,
      productsById,
      // Standalone MVB: no system recipe prices (empty slot map), but the
      // areas keep their system_type_id so labor % and target GP still come
      // from the selected system. The MVB line is added by the engine.
      recipeSlotsBySystemType: mvb === 'standalone' ? {} : recipeSlotsBySystemType,
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
      standaloneMvb: mvb !== 'none',
      standaloneMvbProductId: mvb !== 'none' ? mvbProduct?.id ?? null : null,
    } as Parameters<typeof computeEstimatePricing>[0]);
  }, [engineAreas, systemTypeId, salesperson, productsById, recipeSlotsBySystemType, systemTypes, config, mvb, mvbProduct]);

  const err = pricing?.error ?? null;
  const hasPrice = !!pricing && !err && pricing.price != null;
  const basePrice = hasPrice && pricing ? pricing.price! : null;

  // ---- Sell price / discount (decision 9: nothing is blocked, GP goes red) --
  const [sellInput, setSellInput] = useState('');
  const [discInput, setDiscInput] = useState('');
  const [priceOverride, setPriceOverride] = useState<null | 'sell' | 'disc'>(null);

  // A structural change to the price (system, sqft, MVB, products) resets any
  // manual override: the old discount was negotiated against the old number.
  useEffect(() => {
    setPriceOverride(null);
    setSellInput('');
    setDiscInput('');
  }, [basePrice]);

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

  // GP threshold: the system's target_gp_pct when set, else the estimator
  // config default. (Every prod system currently has NULL target_gp_pct, so
  // the config default is the live threshold until Dylan sets per-system ones.)
  const targetGpPctResolved =
    systemType?.target_gp_pct != null ? Number(systemType.target_gp_pct) : config.targetGpPct;
  const gpBelowTarget =
    adjusted?.gpPct != null && adjusted.gpPct * 100 < targetGpPctResolved - 0.05;

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

  const comps: CompsResult | null = useMemo(() => {
    if (!compCandidates || !systemTypeId || !(totalSqft > 0)) return null;
    return buildComps({ candidates: compCandidates, systemTypeId, sqft: totalSqft, now: new Date() });
  }, [compCandidates, systemTypeId, totalSqft]);
  const compsLabel = comps ? compsRuleLabel(comps, systemType?.name ?? null) : '';

  // ---- AI recommendation: automatic once system + sqft are present ---------
  // Debounced (900ms) so sqft keystrokes do not each fire a model call. Keyed
  // on (system, sqft, MVB), the regeneration rule; the cached read on a
  // reopened estimate's row short-circuits the call entirely.
  const inputsKey = `${systemTypeId}|${Math.round(totalSqft)}|${mvb}`;
  const [ai, setAi] = useState<{ key: string; status: 'loading' | 'ready' | 'error'; rec?: AiRecommendation; err?: string } | null>(null);
  const editingSnapshot = editing?.pricingSnapshot ?? null;

  useEffect(() => {
    if (!hasPrice || !(totalSqft > 0) || !systemTypeId || basePrice == null) return;
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
          inputs_key: inputsKey,
          system_type_name: systemType?.name ?? 'Unknown system',
          sqft: totalSqft,
          mvb,
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
  }, [areas, systemTypeId, salespersonId, intake, mvb, customer, finalSell]);

  const setArea = (i: number, patch: Partial<AreaForm>) =>
    setAreas((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  const setSlot = (i: number, slotId: string, value: string) =>
    setAreas((prev) =>
      prev.map((a, idx) => (idx === i ? { ...a, slotValues: { ...a.slotValues, [slotId]: value } } : a)),
    );
  const addArea = () =>
    setAreas((prev) => [...prev, { name: `Area ${prev.length + 1}`, sqft: '', slotValues: defaultSlotValues(systemTypeId) }]);
  const removeArea = (i: number) => setAreas((prev) => prev.filter((_, idx) => idx !== i));

  const onSystemChange = (sysId: string) => {
    setSystemTypeId(sysId);
    // New system, new slot set: re-seed every area with the new defaults.
    setAreas((prev) => prev.map((a) => ({ ...a, slotValues: defaultSlotValues(sysId) })));
  };

  const mvbMissing = mvb !== 'none' && !mvbProduct;
  const canSave = !!salesperson && hasPrice && !mvbMissing && saveState !== 'saving';

  // Flake color at estimate level: the first area's swatch pick names it; the
  // customer often picks AFTER the presentation, so null is normal here and
  // the estimate page can fill it in later.
  const flakeColorFromPicks = useMemo(() => {
    if (mvb === 'standalone') return null;
    for (const a of areas) {
      for (const s of visibleSlots) {
        if (!SWATCH_TYPES.has(s.material_type) || kindOf(s) !== 'product') continue;
        const v = a.slotValues[s.id];
        if (v && productsById[v]) return productsById[v].color || productsById[v].name;
      }
    }
    return null;
  }, [areas, visibleSlots, productsById, mvb]);

  const postToParent = useCallback((msg: Record<string, unknown>) => {
    // Same-origin by construction (the dashboard and /estimator/ share a host);
    // targeting the explicit origin means the message can never leak elsewhere.
    try { window.parent?.postMessage(msg, window.location.origin); } catch { /* not framed */ }
  }, []);

  const onSave = useCallback(async () => {
    if (!salesperson || !pricing || !hasPrice || finalSell == null) return;
    if (editing && !online) {
      setSaveState('error');
      setSaveError('Editing an existing estimate needs a connection (it rewrites saved areas). Reconnect and save again.');
      return;
    }
    setSaveState('saving');
    setSaveError('');
    try {
      const areaInputs: AreaInput[] = areas
        .filter((a) => Number(a.sqft) > 0)
        .map((a) => {
          const d = deriveProducts(a.slotValues);
          const materials: AreaMaterialInput[] = visibleSlots
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
            systemTypeId,
            flakeProductId: d.flake,
            basecoatProductId: d.basecoat,
            topcoatProductId: d.topcoat,
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

      const sell: SellOverride | null =
        discounted && adjusted && adjusted.sellPrice != null ? (adjusted as SellOverride) : null;

      // One line item for the whole quoted job; optional upsell lines are
      // added on the estimate page after the fact (decision 14).
      const nowIso = new Date().toISOString();
      const sysName = systemType?.name ?? 'Floor coating';
      const lineItems: LineItem[] = [
        {
          id: uuid(),
          label:
            mvb === 'standalone'
              ? 'Moisture vapor barrier (MVB)'
              : `${sysName} floor coating system`,
          description:
            `${Math.round(totalSqft)} sqft` +
            (mvb === 'addon' ? ', includes moisture vapor barrier (MVB)' : ''),
          qty: 1,
          unit_price: finalSell,
          total: finalSell,
          optional: false,
          selected_by_customer: true,
          created_at: nowIso,
        },
      ];

      const pricingSnapshot: Record<string, unknown> = {
        inputs_key: inputsKey,
        comps: comps
          ? {
              rule: comps.rule,
              rule_label: compsLabel,
              sample_size: comps.sample_size,
              median_ppsf: comps.median_ppsf,
              rows: comps.rows.map((r) => ({
                customer_name: r.customer_name,
                completed_date: r.completed_date,
                sqft: r.sqft,
                price: r.price,
                ppsf: r.ppsf,
                gp_pct: r.gp_pct,
              })),
            }
          : null,
        ai: ai?.status === 'ready' && ai.key === inputsKey && ai.rec ? { ...ai.rec, inputs_key: inputsKey } : null,
      };

      // Edit-in-place: rewrite the child areas (delete then re-enqueue; the
      // materials rows cascade). Online-only, checked above.
      if (editing) await deleteEstimateAreas(editing.id);

      const { id } = await saveEstimateOffline({
        estimateId: editing?.id ?? null,
        status: editing?.status ?? 'draft',
        systemTypeId,
        salesperson: { id: salesperson.id, name: salesperson.name, commission_pct: salesperson.commission_pct ?? 0 },
        intake: intakePayload,
        customer: {
          name: customer.name.trim() || null,
          phone: customer.phone.trim() || null,
          email: customer.email.trim() || null,
          address: customer.address.trim() || null,
        },
        mvb,
        flakeColor: editing?.flakeColor ?? flakeColorFromPicks,
        lineItems,
        pricingSnapshot,
        areas: areaInputs,
        pricing,
        sell,
        createdBy: editing?.createdBy ?? createdBy,
        leadId: editing?.leadId ?? leadLink?.id ?? null,
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
  }, [salesperson, pricing, hasPrice, finalSell, editing, online, areas, visibleSlots, deriveProducts, systemTypeId, intake, basePrice, discounted, adjusted, systemType, mvb, totalSqft, inputsKey, comps, compsLabel, ai, customer, flakeColorFromPicks, createdBy, leadLink, refreshPending, embed, postToParent]);

  const setIntakeField = <K extends keyof Intake>(k: K, v: Intake[K]) => setIntake((p) => ({ ...p, [k]: v }));
  const setCustomerField = (k: keyof typeof customer, v: string) => setCustomer((p) => ({ ...p, [k]: v }));

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
          {/* Inside the dashboard's iframe modal the Dashboard link is redundant
              (and navigating INSIDE the iframe would strand the user); a Close
              button that messages the parent replaces it. */}
          {embed ? (
            <button type="button" className="back as-btn" onClick={() => postToParent({ type: 'pec-estimator-close' })}>
              Close
            </button>
          ) : (
            <a className="back" href="/">Dashboard</a>
          )}
        </div>
      </header>

      <main className="cols">
        <div className="left">
          <section className="card inputs">
            <div className="areas-head"><span>Customer</span></div>
            <div className="cust-grid">
              <label className="field"><span>Name</span><input value={customer.name} onChange={(e) => setCustomerField('name', e.target.value)} placeholder="Customer name" /></label>
              <label className="field"><span>Phone</span><input value={customer.phone} onChange={(e) => setCustomerField('phone', e.target.value)} inputMode="tel" /></label>
              <label className="field"><span>Email</span><input value={customer.email} onChange={(e) => setCustomerField('email', e.target.value)} inputMode="email" /></label>
              <label className="field"><span>Address</span><input value={customer.address} onChange={(e) => setCustomerField('address', e.target.value)} /></label>
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

            <label className="field">
              <span>System</span>
              <select value={systemTypeId} onChange={(e) => onSystemChange(e.target.value)}>
                {systemTypes.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>

            <div className="field">
              <span>Moisture vapor barrier (MVB)</span>
              <div className="mvb-seg" role="group" aria-label="MVB">
                {([
                  ['none', 'None'],
                  ['addon', 'Add-on'],
                  ['standalone', 'MVB only'],
                ] as [Mvb, string][]).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    className={mvb === val ? 'seg active' : 'seg'}
                    onClick={() => setMvb(val)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {mvbMissing && (
              <p className="error">The product "{MVB_PRODUCT_NAME}" is missing or inactive in the Catalog, so MVB cannot be priced. Restore it (Price &amp; Material Catalog) or set MVB back to None.</p>
            )}
          </section>

          <section className="card">
            <div className="areas-head"><span>Areas</span><button type="button" className="link" onClick={addArea}>+ Add area</button></div>
            {areas.map((a, i) => (
              <div className="area" key={i}>
                <div className="area-top">
                  <input className="area-name" value={a.name} onChange={(e) => setArea(i, { name: e.target.value })} placeholder="Area name" />
                  <input
                    className="area-sqft"
                    inputMode="decimal"
                    value={a.sqft}
                    onChange={(e) => setArea(i, { sqft: e.target.value.replace(/[^0-9.]/g, '') })}
                    placeholder="sq ft"
                  />
                  {areas.length > 1 && <button type="button" className="x" aria-label="Remove area" onClick={() => removeArea(i)}>×</button>}
                </div>
              </div>
            ))}
          </section>

          {/* Everything below is OPTIONAL and collapsed: a rep who never opens
              it still gets a correct price off the recipe defaults. */}
          <details className="card more-detail">
            <summary>More detail <span className="muted">(products, colors, work order)</span></summary>
            {visibleSlots.length > 0 && areas.map((a, i) => (
              <div className="area" key={i}>
                {areas.length > 1 && <div className="area-label">{a.name || `Area ${i + 1}`}</div>}
                <div className="slots">
                  {visibleSlots.map((s) => (
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
            ))}
            {mvb !== 'standalone' && (
              <p className="hint">Flake color can stay unpicked; the price already includes standard flake, the customer usually chooses after the presentation, and it stays editable on the estimate page.</p>
            )}
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
                <div className="price">{money(finalSell)}</div>
                {discounted && (
                  <p className="hint">calculated {money(basePrice)}{adjusted.discountPct != null ? ` · ${adjusted.discountPct.toFixed(1)}% discount` : ''}</p>
                )}
                <div className="sell-row">
                  <label className="field"><span>Sell price $</span>
                    <input inputMode="decimal" value={sellInput} placeholder={basePrice != null ? String(basePrice) : ''} onChange={(e) => onSellInput(e.target.value)} />
                  </label>
                  <label className="field"><span>Discount %</span>
                    <input inputMode="decimal" value={discInput} placeholder="0" onChange={(e) => onDiscInput(e.target.value)} />
                  </label>
                </div>
                <dl className="metrics">
                  <div><dt>Gross profit</dt><dd className={gpBelowTarget ? 'gp-red' : ''}>{money(adjusted.gpDollars)} ({pct(adjusted.gpPct)})</dd></div>
                  <div><dt>GP / hour</dt><dd>{money2(adjusted.gpPerHour)}</dd></div>
                  <div><dt>Commission (standard {pricing.standardCommissionPct}%)</dt><dd>{money2(adjusted.commissionDollars)}</dd></div>
                  <div><dt>Budgeted hours</dt><dd>{adjusted.budgetedHours?.toFixed(1) ?? '--'}</dd></div>
                  {!config.hideMaterialQty && <div><dt>Materials</dt><dd>{money2(pricing.materialsCost)}</dd></div>}
                </dl>
                {gpBelowTarget && (
                  <p className="warn gp-warn">GP is below the {targetGpPctResolved}% target for this system. Saving still works; the number is just red on purpose.</p>
                )}
                {pricing.materialsMissingCost && pricing.materialsMissingCost.length > 0 && (
                  <p className="warn">No cost set for: {pricing.materialsMissingCost.join(', ')}. Price may be understated until these are priced in the Catalog.</p>
                )}
                <p className="calcver">engine {pricing.calcVersion}</p>
                <div className="save-row">
                  <button type="button" className="save" disabled={!canSave} onClick={onSave}>
                    {saveState === 'saving' ? 'Saving…' : editing ? 'Save changes' : 'Save estimate'}
                  </button>
                  {saveState === 'saved' && (
                    <span className="save-note ok">{savedOffline ? 'Saved offline · will sync when online' : 'Saved & synced'}</span>
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
