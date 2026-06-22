import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Catalog, SalesPerson } from '../../lib/catalog';
import {
  computeEstimatePricing,
  type Area,
  type PricingResult,
  type Product,
  type RecipeSlot,
} from '../../lib/calculator';
import { useOnline } from '../../lib/useOnline';
import { saveEstimateOffline, type AreaInput, type AreaMaterialInput } from '../../offline/estimates';
import { listOps } from '../../offline/outbox';
import { drainOutbox } from '../../offline/sync';

type AreaForm = { name: string; sqft: string; slotValues: Record<string, string> };
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

export default function EstimatorScreen({
  catalog,
  createdBy,
  catalogFromCache,
}: {
  catalog: Catalog;
  createdBy: string | null;
  catalogFromCache: boolean;
}) {
  const { systemTypes, productsById, recipeSlotsBySystemType, salespeople, config } = catalog;
  const online = useOnline();

  const [salespersonId, setSalespersonId] = useState<string>(salespeople[0]?.id ?? '');
  const [systemTypeId, setSystemTypeId] = useState<string>(systemTypes[0]?.id ?? '');
  const [intake, setIntake] = useState<Intake>(emptyIntake);
  const [areas, setAreas] = useState<AreaForm[]>([{ name: 'Main', sqft: '', slotValues: {} }]);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [pending, setPending] = useState(0);

  const salesperson: SalesPerson | undefined = salespeople.find((s) => s.id === salespersonId);

  // System's slots, ordered, with internal (editor_hidden) body coats removed.
  const visibleSlots: RecipeSlot[] = useMemo(
    () => (recipeSlotsBySystemType[systemTypeId] ?? []).filter((s) => !s.editor_hidden),
    [recipeSlotsBySystemType, systemTypeId],
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

  const pricing: PricingResult | null = useMemo(() => {
    if (!systemTypeId || !salesperson || !engineAreas.length) return null;
    return computeEstimatePricing({
      areas: engineAreas,
      productsById,
      recipeSlotsBySystemType,
      systemTypes,
      laborRate: config.laborRate,
      commissionPct: salesperson.commission_pct ?? 0,
      targetGpPct: config.targetGpPct,
      priceIncrement: config.priceIncrement,
      charmThreshold: config.charmThreshold,
      charmBand: config.charmBand,
    });
  }, [engineAreas, systemTypeId, salesperson, productsById, recipeSlotsBySystemType, systemTypes, config]);

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
  }, [areas, systemTypeId, salespersonId, intake]);

  const setArea = (i: number, patch: Partial<AreaForm>) =>
    setAreas((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  const setSlot = (i: number, slotId: string, value: string) =>
    setAreas((prev) =>
      prev.map((a, idx) => (idx === i ? { ...a, slotValues: { ...a.slotValues, [slotId]: value } } : a)),
    );
  const addArea = () => setAreas((prev) => [...prev, { name: `Area ${prev.length + 1}`, sqft: '', slotValues: {} }]);
  const removeArea = (i: number) => setAreas((prev) => prev.filter((_, idx) => idx !== i));

  const err = pricing?.error ?? null;
  const hasPrice = !!pricing && !err && pricing.price != null;
  const canSave = !!salesperson && hasPrice && saveState !== 'saving';

  const onSave = useCallback(async () => {
    if (!salesperson || !pricing || !hasPrice) return;
    setSaveState('saving');
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

      const intakePayload = {
        gate_code: intake.gate_code || null,
        coat_past_garage: intake.coat_past_garage,
        stem_walls: intake.stem_walls,
        moisture: intake.moisture ? Number(intake.moisture) : null,
        mohs_hardness: intake.mohs_hardness ? Number(intake.mohs_hardness) : null,
        additional_non_slip: intake.additional_non_slip || null,
        grinder_tooling_grit: intake.grinder_tooling_grit || null,
        special_notes: intake.special_notes || null,
      };

      await saveEstimateOffline({
        systemTypeId,
        salesperson: { id: salesperson.id, name: salesperson.name, commission_pct: salesperson.commission_pct ?? 0 },
        intake: intakePayload,
        areas: areaInputs,
        pricing,
        createdBy,
      });
      if (navigator.onLine) await drainOutbox().catch(() => {});
      await refreshPending();
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, [salesperson, pricing, hasPrice, areas, visibleSlots, deriveProducts, systemTypeId, intake, createdBy, refreshPending]);

  const setIntakeField = <K extends keyof Intake>(k: K, v: Intake[K]) => setIntake((p) => ({ ...p, [k]: v }));

  return (
    <div className="screen">
      <header className="topbar">
        <div className="brand">PEC Estimator <span className="beta">beta</span></div>
        <div className="status">
          <span className={online ? 'dot online' : 'dot offline'} title={online ? 'Online' : 'Offline'} />
          <span className="status-text">
            {online ? 'Online' : 'Offline'}
            {pending > 0 && ` · ${pending} to sync`}
            {catalogFromCache && ' · cached catalog'}
          </span>
          <a className="back" href="/">Dashboard</a>
        </div>
      </header>

      <main className="cols">
        <div className="left">
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
              <select value={systemTypeId} onChange={(e) => setSystemTypeId(e.target.value)}>
                {systemTypes.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
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
          </section>

          <section className="card">
            <div className="areas-head"><span>Work order</span></div>
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
          </section>
        </div>

        <section className="card result" aria-live="polite">
          {!salesperson && <p className="hint">Pick a salesperson to price the job.</p>}
          {salesperson && !hasPrice && !err && <p className="hint">Enter at least one area with square footage.</p>}
          {err && <p className="error">{ERROR_COPY[err] ?? err}</p>}
          {hasPrice && pricing && (
            <>
              <div className="price">{money(pricing.price)}</div>
              <dl className="metrics">
                <div><dt>Gross profit</dt><dd>{money(pricing.gpDollars)} ({pct(pricing.gpPct)})</dd></div>
                <div><dt>GP / hour</dt><dd>{money2(pricing.gpPerHour)}</dd></div>
                <div><dt>Commission</dt><dd>{money2(pricing.commissionDollars)} ({pricing.commissionPct}%)</dd></div>
                <div><dt>Budgeted hours</dt><dd>{pricing.budgetedHours?.toFixed(1) ?? '--'}</dd></div>
                {!config.hideMaterialQty && <div><dt>Materials</dt><dd>{money2(pricing.materialsCost)}</dd></div>}
              </dl>
              <p className="calcver">engine {pricing.calcVersion}</p>
              <div className="save-row">
                <button type="button" className="save" disabled={!canSave} onClick={onSave}>
                  {saveState === 'saving' ? 'Saving…' : 'Save estimate'}
                </button>
                {saveState === 'saved' && (
                  <span className="save-note ok">{online ? 'Saved & synced' : 'Saved offline · will sync when online'}</span>
                )}
                {saveState === 'error' && <span className="save-note bad">Save failed</span>}
              </div>
            </>
          )}
        </section>
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
