import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Catalog, SalesPerson } from '../../lib/catalog';
import { computeEstimatePricing, type Area, type PricingResult } from '../../lib/calculator';
import { useOnline } from '../../lib/useOnline';
import { saveEstimateOffline } from '../../offline/estimates';
import { listOps } from '../../offline/outbox';
import { drainOutbox } from '../../offline/sync';

type AreaForm = { name: string; sqft: string; flakeProductId: string };

const money = (n: number | null | undefined) =>
  n == null ? '--' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money2 = (n: number | null | undefined) =>
  n == null ? '--' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const pct = (frac: number | null | undefined) => (frac == null ? '--' : `${(frac * 100).toFixed(1)}%`);

const SWATCH_TYPES = new Set(['Flake', 'Quartz', 'Metallic Pigment']);

const ERROR_COPY: Record<string, string> = {
  TARGET_UNREACHABLE:
    'Target margin is impossible for these inputs: labor + commission + target GP add up to 100% or more of revenue. Lower the target GP or commission.',
  NO_LABOR_PCT: 'This system has no labor budget percent set. Set it in the Catalog before pricing.',
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
  const [areas, setAreas] = useState<AreaForm[]>([{ name: 'Main', sqft: '', flakeProductId: '' }]);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [pending, setPending] = useState(0);

  const refreshPending = useCallback(async () => {
    try {
      setPending((await listOps()).length);
    } catch {
      /* IndexedDB unavailable: leave at 0 */
    }
  }, []);

  // Show the queue depth, and whenever we come back online try to flush it.
  useEffect(() => {
    refreshPending();
  }, [refreshPending]);
  useEffect(() => {
    if (online) drainOutbox().then(refreshPending).catch(() => {});
  }, [online, refreshPending]);

  const salesperson: SalesPerson | undefined = salespeople.find((s) => s.id === salespersonId);

  // Products offered for the system's swatch slot (flake/quartz/metallic color).
  const swatchProducts = useMemo(() => {
    const slots = recipeSlotsBySystemType[systemTypeId] ?? [];
    const types = new Set(slots.filter((s) => SWATCH_TYPES.has(s.material_type)).map((s) => s.material_type));
    if (!types.size) return [];
    return Object.values(productsById)
      .filter((p) => types.has(p.material_type))
      .sort((a, b) => (a.color ?? a.name).localeCompare(b.color ?? b.name));
  }, [systemTypeId, recipeSlotsBySystemType, productsById]);

  const engineAreas: Area[] = useMemo(
    () =>
      areas
        .map((a, i) => ({
          id: `a${i}`,
          name: a.name || `Area ${i + 1}`,
          sqft: Number(a.sqft) || 0,
          system_type_id: systemTypeId,
          flake_product_id: a.flakeProductId || null,
        }))
        .filter((a) => a.sqft > 0),
    [areas, systemTypeId],
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

  const setArea = (i: number, patch: Partial<AreaForm>) =>
    setAreas((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  const addArea = () =>
    setAreas((prev) => [...prev, { name: `Area ${prev.length + 1}`, sqft: '', flakeProductId: '' }]);
  const removeArea = (i: number) => setAreas((prev) => prev.filter((_, idx) => idx !== i));

  const err = pricing?.error ?? null;
  const hasPrice = !!pricing && !err && pricing.price != null;
  const canSave = !!salesperson && hasPrice && saveState !== 'saving';

  // Reset the "Saved" confirmation as soon as the estimate changes again.
  useEffect(() => {
    setSaveState('idle');
  }, [engineAreas, systemTypeId, salespersonId]);

  const onSave = useCallback(async () => {
    if (!salesperson || !pricing || !hasPrice) return;
    setSaveState('saving');
    try {
      await saveEstimateOffline({
        systemTypeId,
        salesperson: { id: salesperson.id, name: salesperson.name, commission_pct: salesperson.commission_pct ?? 0 },
        areas: engineAreas.map((a) => ({ name: a.name ?? '', sqft: a.sqft, flake_product_id: a.flake_product_id ?? null })),
        pricing,
        createdBy,
      });
      if (navigator.onLine) await drainOutbox().catch(() => {});
      await refreshPending();
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, [salesperson, pricing, hasPrice, systemTypeId, engineAreas, createdBy, refreshPending]);

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

          <div className="areas">
            <div className="areas-head">
              <span>Areas</span>
              <button type="button" className="link" onClick={addArea}>+ Add area</button>
            </div>
            {areas.map((a, i) => (
              <div className="area-row" key={i}>
                <input
                  className="area-name"
                  value={a.name}
                  onChange={(e) => setArea(i, { name: e.target.value })}
                  placeholder="Area name"
                />
                <input
                  className="area-sqft"
                  inputMode="numeric"
                  value={a.sqft}
                  onChange={(e) => setArea(i, { sqft: e.target.value.replace(/[^0-9.]/g, '') })}
                  placeholder="sq ft"
                />
                {swatchProducts.length > 0 && (
                  <select
                    className="area-color"
                    value={a.flakeProductId}
                    onChange={(e) => setArea(i, { flakeProductId: e.target.value })}
                  >
                    <option value="">Color / custom blend</option>
                    {swatchProducts.map((p) => (
                      <option key={p.id} value={p.id}>{p.color || p.name}</option>
                    ))}
                  </select>
                )}
                {areas.length > 1 && (
                  <button type="button" className="x" aria-label="Remove area" onClick={() => removeArea(i)}>×</button>
                )}
              </div>
            ))}
          </div>
        </section>

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
                {!config.hideMaterialQty && (
                  <div><dt>Materials</dt><dd>{money2(pricing.materialsCost)}</dd></div>
                )}
              </dl>
              <p className="calcver">engine {pricing.calcVersion}</p>
              <div className="save-row">
                <button type="button" className="save" disabled={!canSave} onClick={onSave}>
                  {saveState === 'saving' ? 'Saving…' : 'Save estimate'}
                </button>
                {saveState === 'saved' && (
                  <span className="save-note ok">
                    {online ? 'Saved & synced' : 'Saved offline · will sync when online'}
                  </span>
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
