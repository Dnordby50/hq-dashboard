import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  CUSTOM_LINE_LABEL,
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
import { listOps, type OutboxOp } from '../../offline/outbox';
import { drainOutbox } from '../../offline/sync';
import { buildComps, compsGpCaveat, compsRuleLabel, loadCompCandidates, type CompCandidate, type CompsResult } from '../../lib/comps';
import { compsForAi, fetchAiRecommendation, type AiRecommendation } from '../../lib/ai';
import { supabase } from '../../lib/supabase';
import { ensureLeadForCustomer, searchCustomersAndLeads, type CustomerMatch } from '../../lib/customerSearch';
import { uuid } from '../../offline/uuid';
import { applyAnswers as scopeApplyAnswers, containsBlank as scopeContainsBlank, openQuestions as scopeOpenQuestions, type ScopeQuestion } from '../../../../../production/scope.cjs';
// Card-first draft + salesperson default rules (prompt 47): shared CJS module
// (the scope.cjs pattern) so the fixture tests exercise the exact logic the
// screen runs.
import { createDraftTrigger, defaultSalespersonId, draftReady, estimateIdForSave, userUnmapped } from '../../../../../production/estimate-draft.cjs';

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
  viewerIsAdmin,
  catalogFromCache,
  leadLink,
  embed,
  editing,
}: {
  catalog: Catalog;
  createdBy: string | null;
  viewerIsAdmin: boolean;
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
  // Salesperson default (prompt 47): the edited estimate's pick if still
  // valid, else the member mapped to THIS login (auth_user_id), else blank.
  // Never salespeople[0]: an unmapped login gets a prompt, not a guess. Stays
  // freely editable (creating on another rep's behalf is normal).
  const [salespersonId, setSalespersonId] = useState<string>(() =>
    defaultSalespersonId({
      editingSalespersonId: editing ? String(editing.intake.salesperson_id ?? '') : '',
      salespeople,
      currentUserId: createdBy,
    }),
  );
  // Salesperson lock (prompt 55 Part B, narrowing prompt 47's freely-editable
  // decision): once a salesperson is set, only an admin can change it. The
  // lock is captured at OPEN (useState initializer runs once), with one
  // deliberate exception: a BLANK salespersonId (an unmapped login, prompt
  // 47's fallback) keeps the select enabled for everyone for this session,
  // otherwise an unmapped rep could never save an estimate and the
  // block-with-a-clear-message path would be a dead end.
  const [salespersonSetAtOpen] = useState<boolean>(() => salespersonId !== '');
  const salespersonLocked = salespersonSetAtOpen && !viewerIsAdmin;
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
  // Duplicate-customer search (prompt 44): find an existing customer/lead and
  // link the estimate to it instead of creating a fresh unlinked record.
  // linkedLead overrides the URL leadLink at save time (the rep deliberately
  // picked it). Online-only; offline the search UI is hidden and the normal
  // outbox save path is untouched. Toggleable from Settings > Estimates.
  const custSearchEnabled = !editing && online && config.customerSearchEnabled !== false;
  const [custSearch, setCustSearch] = useState('');
  const [custMatches, setCustMatches] = useState<CustomerMatch[]>([]);
  const [custSearchOpen, setCustSearchOpen] = useState(false);
  const [linkedLead, setLinkedLead] = useState<{ id: string; name: string } | null>(null);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  useEffect(() => {
    if (!custSearchEnabled || custSearch.trim().length < 2) {
      setCustMatches([]);
      setCustSearchOpen(false);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchCustomersAndLeads(custSearch);
        if (!alive) return;
        setCustMatches(found);
        setCustSearchOpen(true);
      } catch {
        // Search is a nicety, never a gate: a failed query just shows nothing.
        if (alive) { setCustMatches([]); setCustSearchOpen(false); }
      }
    }, 300);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [custSearch, custSearchEnabled]);
  const pickCustomerMatch = useCallback(async (m: CustomerMatch) => {
    setCustomer(m.form);
    setCustSearch('');
    setCustMatches([]);
    setCustSearchOpen(false);
    if (m.kind === 'lead') {
      setLinkedLead({ id: m.id, name: m.name });
      setLinkNote(null);
      return;
    }
    // Customer match: the estimate links through a lead (the spine downstream
    // readers key off), found or created now. On failure the fields stay
    // prefilled and the save proceeds unlinked, with a visible note.
    try {
      const leadId = await ensureLeadForCustomer(m.id, m.form);
      setLinkedLead({ id: leadId, name: m.name });
      setLinkNote(null);
    } catch {
      setLinkedLead(null);
      setLinkNote('Fields filled, but linking to the existing customer failed. The estimate will save unlinked.');
    }
  }, []);

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
  // ---- Live proposal panel (build 25, STANDARD mode) -----------------------
  // The assembled scope of work, visible and editable WHILE the estimate is
  // built instead of only after save on the estimate page. The text has three
  // owners, in precedence order:
  //   1. the rep (panelEdited / dbScopeEdited): their words, protected by the
  //      never-overwrite rule the server already enforces (scope_edited_at +
  //      force),
  //   2. the server writer (scopeGenerated): pec-estimate-scope's assembled
  //      document, loaded on the auto-first save or a Regenerate click,
  //   3. the local template preview (nothing generated yet): instant,
  //      offline-safe substitution of the same templates.
  const [scopeText, setScopeText] = useState<string>(() => editing?.scopeOfWork ?? '');
  const [scopeGenerated, setScopeGenerated] = useState<boolean>(() => editing?.hasScope === true);
  // Hand-edit tracking, split in two because they mean different writes: a
  // panel edit this session must RIDE the next save (editedScope); a scope
  // already edited in the database only gates force/stale semantics.
  const [panelEdited, setPanelEdited] = useState(false);
  const [dbScopeEdited, setDbScopeEdited] = useState<boolean>(() => !!editing?.scopeEditedAt);
  const [scopeStale, setScopeStale] = useState<boolean>(() => editing?.scopeStale === true);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeError, setScopeError] = useState('');
  const [savedEstimateId, setSavedEstimateId] = useState<string | null>(() => editing?.id ?? null);
  // Estimate saved OFFLINE with the auto-first generation still owed: the id
  // waits here until the outbox drains, then the generation fires by itself.
  const pendingAutoGenRef = useRef<string | null>(null);
  // ---- Custom estimate mode (build 24): the WHOLE estimate goes custom -----
  // One-off jobs the shop does not do often: Dylan types the scope and the
  // price himself; areas and the material engine are off. The toggle is
  // NON-destructive: area/answer state persists hidden, so flipping back to
  // Standard restores exactly what was there (that is also how the engine
  // stays optionally usable: price in Standard, then switch).
  const [isCustom, setIsCustom] = useState<boolean>(() => editing?.isCustom === true);
  const [customScope, setCustomScope] = useState<string>(() => editing?.customScope ?? '');
  const [customPriceInput, setCustomPriceInput] = useState<string>(() => editing?.customPrice ?? '');
  // Custom sqft (prompt 32): typed alongside the price so the estimator can
  // show $/sqft as a READOUT. Optional, never a save gate, and never a rate
  // that computes the price: price stays the typed number.
  const [customSqftInput, setCustomSqftInput] = useState<string>(() => editing?.customSqft ?? '');
  // "Polish with AI" undo: the pre-polish text, kept until reverted or
  // re-polished, so the button is never a one-way door.
  const [prePolish, setPrePolish] = useState<string | null>(null);
  const [polishBusy, setPolishBusy] = useState(false);
  const [polishError, setPolishError] = useState('');
  // ---- Crew notes (prompt 32, Part B): INTERNAL brief for the install crew,
  // both modes. Typed or AI-drafted (manual button only, never automatic);
  // prints on the crew work order and nowhere customer-facing. The pre-
  // generate text is kept for undo (the polish pattern), and a hand-edit
  // since the last generate makes the next generate ask before overwriting.
  const [crewNotes, setCrewNotes] = useState<string>(() => editing?.crewNotes ?? '');
  const [crewNotesEdited, setCrewNotesEdited] = useState(false);
  const [preGenCrewNotes, setPreGenCrewNotes] = useState<string | null>(null);
  const [crewNotesBusy, setCrewNotesBusy] = useState(false);
  const [crewNotesError, setCrewNotesError] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [savedOffline, setSavedOffline] = useState(false);
  // Full queued ops, not just a count (prompt 48): the header needs attempt
  // counts and errors to tell "syncing" from "stuck". `pending` stays derived
  // so the quiet counter path is unchanged.
  const [pendingOps, setPendingOps] = useState<OutboxOp[]>([]);
  const pending = pendingOps.length;
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [retryState, setRetryState] = useState<'idle' | 'running' | 'done'>('idle');
  const [retryOutcome, setRetryOutcome] = useState('');

  const salesperson: SalesPerson | undefined = salespeople.find((s) => s.id === salespersonId);
  // Card-first draft (prompt 47): the estimate id is minted ONCE per screen so
  // the early draft save and every later Save upsert the SAME row (the outbox
  // upserts by id). draftTrigger owns the fire-once-on-first-real-edit
  // semantics (estimate-draft.cjs); draftWriteRef records that the parent row
  // exists so the draft never writes twice.
  const [draftId] = useState<string>(() => uuid());
  const [draftTrigger] = useState(() => createDraftTrigger({ alreadyPersisted: !!editing }));
  const draftWriteRef = useRef(false);
  // Blank-salesperson copy: an unmapped login gets the get-yourself-mapped
  // prompt (never a silent salespeople[0] fallback); a mapped user who cleared
  // the field gets the plain pick-one hint.
  const salespersonUnmapped = !salesperson && userUnmapped(salespeople, createdBy);
  const salespersonPrompt = !salesperson
    ? (salespersonUnmapped
      ? 'Your login is not linked to a salesperson yet. Ask an admin to map you in Settings > Sales Team, or pick a salesperson to continue.'
      : 'Pick a salesperson to price the job.')
    : null;

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

  // Instant local preview for the proposal panel: the same templates, the
  // same BLANK substitution (shared production/scope.cjs), assembled in the
  // same per-line document shape the server writes (## label + body, ---
  // separators, same line labels the save composes). It is a PREVIEW: the
  // model's fact substitution (sqft slots, stem walls is/is-not, flake color)
  // has not run yet, so those template slots read as written until the
  // server-assembled document replaces this after the first save. An
  // unanswered question stays the literal word BLANK on purpose, exactly
  // what the customer would see.
  const localScopePreview = useMemo(() => {
    if (isCustom) return '';
    const sections: string[] = [];
    pricedAreas.forEach((a, i) => {
      const sys = systemTypes.find((s) => s.id === a.systemTypeId);
      if (!sys) return;
      const isMvbOnly = sys.name === MVB_ONLY_SYSTEM_NAME;
      const name = a.name || `Area ${i + 1}`;
      const label = pricedAreas.length > 1 ? `${name}: ${sys.name}` : isMvbOnly ? sys.name : `${sys.name} floor coating system`;
      const tpl = (a.mvb && sys.scope_template_mvb) ? sys.scope_template_mvb : sys.scope_template;
      const body = tpl ? scopeApplyAnswers(tpl, scopeAnswers, sys.name) : `${Math.round(Number(a.sqft) || 0)} sqft`;
      sections.push(body ? `## ${label}\n\n${body}` : `## ${label}`);
    });
    for (const f of addonForms) {
      const cat = f.addonId ? addonCatalog.find((x) => x.id === f.addonId) ?? null : null;
      const snippet = cat && cat.scope_snippet && cat.scope_snippet.trim() ? cat.scope_snippet : null;
      const head = `## ${f.label.trim() || 'Add-on'}${f.optional ? ' (optional)' : ''}`;
      const body = snippet && cat ? scopeApplyAnswers(snippet, scopeAnswers, cat.name) : f.description.trim();
      sections.push(body ? `${head}\n\n${body}` : head);
    }
    return sections.join('\n\n---\n\n');
  }, [isCustom, pricedAreas, systemTypes, scopeAnswers, addonForms, addonCatalog]);

  const scopeEditedAny = panelEdited || dbScopeEdited;
  // What the panel shows: the rep's or the server's document once one exists,
  // else the live local preview (which keeps updating as inputs change).
  const scopeDisplay = scopeGenerated || scopeEditedAny ? scopeText : localScopePreview;
  const onScopeTextChange = (v: string) => {
    setScopeText(v);
    setPanelEdited(true);
    setScopeError('');
    // An edited proposal is an unsaved change: it rides the next save.
    setSaveState('idle');
  };

  // Call the ONE scope writer (pec-estimate-scope; the estimate page uses the
  // same function with the same semantics) and load the assembled document
  // into the live panel. force=true is only ever sent after the explicit
  // "this replaces your edited text" confirm, mirroring the estimate page's
  // Regenerate; the server refuses an unforced write over a human's words
  // anyway (scope_edited_at, 409), so a bug here still cannot lose them.
  const generateScope = useCallback(async (estimateId: string, force: boolean): Promise<boolean> => {
    setScopeBusy(true);
    setScopeError('');
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Sign in to write the proposal.');
      const res = await fetch('/.netlify/functions/pec-estimate-scope', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(force ? { estimate_id: estimateId, force: true } : { estimate_id: estimateId }),
      });
      const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || out.success !== true) throw new Error(String(out.error || `Proposal generation failed (${res.status})`));
      if (out.generated !== true) {
        setScopeError(String(out.reason || 'Nothing to generate for this estimate yet.'));
        return false;
      }
      setScopeText(String(out.scope_of_work ?? ''));
      setScopeGenerated(true);
      setPanelEdited(false);
      setDbScopeEdited(false); // a successful write clears scope_edited_at server-side
      setScopeStale(false);
      return true;
    } catch (e) {
      // Surfaced in the panel, never blocking: the estimate page's Generate
      // button covers any miss, and the local preview still stands.
      setScopeError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setScopeBusy(false);
    }
  }, []);

  // Any area wants MVB but the catalog is missing the MVB product.
  const anyAreaMvb = useMemo(() => engineAreas.some((a) => a.mvb === true), [engineAreas]);
  const mvbMissing = anyAreaMvb && !mvbProduct;

  const pricing: PricingResult | null = useMemo(() => {
    // Custom mode: the engine is fully dormant. Everything downstream of
    // `pricing` (hasPrice, finalSell, GP, the AI read) branches off this one
    // null instead of each guarding isCustom separately.
    if (isCustom) return null;
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
  }, [isCustom, engineAreas, salesperson, productsById, recipeSlotsBySystemType, systemTypes, config, mvbProduct, mvbMissing]);

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

  // ---- Custom price (build 24): typed directly, NEVER through the engine ---
  const customPrice = useMemo(() => {
    const n = Number(customPriceInput);
    return Number.isFinite(n) && n > 0 ? r2(n) : null;
  }, [customPriceInput]);
  // Custom sqft (prompt 32): same parse rule as the price. Optional; null
  // means "not typed" and simply hides the readout.
  const customSqft = useMemo(() => {
    const n = Number(customSqftInput);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [customSqftInput]);
  // The system-portion sell price: the typed number in custom mode, else the
  // engine/override number. Add-on lines price on top of either.
  const sellPrice = isCustom ? customPrice : finalSell;
  const totalPrice = sellPrice != null ? r2(sellPrice + addonsBaseTotal) : null;
  const totalAllOptions = sellPrice != null ? r2(sellPrice + addonsAllTotal) : null;
  // Custom mode: commission is well-defined (standard pct of the total), but
  // GP is NOT (there is no cost basis for the custom work), so GP shows as
  // not-applicable instead of a made-up number, and never blocks the save.
  const customCommission = isCustom && totalPrice != null ? r2((config.standardCommissionPct / 100) * totalPrice) : null;
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
      setPendingOps(await listOps());
    } catch {
      /* IndexedDB unavailable */
    }
  }, []);

  useEffect(() => {
    refreshPending();
  }, [refreshPending]);

  // ---- Stuck-sync visibility (prompt 48) -----------------------------------
  // A queued op that failed sync_stuck_threshold_attempts times (default 2:
  // one failure is a blip, two is real) is BROKEN, not "syncing": the header
  // goes red instead of showing the quiet counter that hid the crew_notes
  // incident for a week. Threshold comes from Settings via the catalog, and
  // a pre-48 cached catalog (no field) falls back to 2.
  const stuckThreshold = Math.max(1, Number(config.syncStuckThreshold) || 2);
  const stuckOps = pendingOps.filter((op) => op.attempts >= stuckThreshold);
  const opQueuedAtMs = (op: OutboxOp) => {
    // queuedAt is a prompt-48 field; older ops fall back to the opId's ISO
    // prefix (nextOpId embeds it), else "now" (age simply reads 0).
    const t = Date.parse(op.queuedAt || op.opId.slice(0, 24));
    return Number.isFinite(t) ? t : Date.now();
  };
  const fmtAge = (ms: number) => {
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'under a minute';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
    const d = Math.floor(h / 24);
    return `${d} days`;
  };
  const oldestStuckAge = stuckOps.length
    ? fmtAge(Date.now() - Math.min(...stuckOps.map(opQueuedAtMs)))
    : '';
  const opLabel = (op: OutboxOp) => {
    const row = op.row as Record<string, unknown>;
    if (op.table === 'estimates') {
      const name = typeof row.customer_name === 'string' && row.customer_name ? row.customer_name : null;
      return name ? `Estimate for ${name}` : `Estimate ${op.id.slice(0, 8)}`;
    }
    if (op.table === 'leads') return `Lead ${op.id.slice(0, 8)}`;
    return `${op.table.replace(/_/g, ' ')} ${op.id.slice(0, 8)}`;
  };

  // Server escalation (prompt 48): report stuck-item metadata ONCE per screen
  // session, the first time anything crosses the threshold, so the office gets
  // a bell even when the rep does not read the red banner. Ids and errors
  // only, no row bodies. Gated by sync_stuck_escalation_enabled (checked
  // server-side too). Best-effort: a report failure changes nothing here.
  const stuckReportedRef = useRef(false);
  const stuckCount = stuckOps.length;
  useEffect(() => {
    if (!stuckCount || stuckReportedRef.current || !online) return;
    if (config.syncStuckEscalationEnabled === false) return;
    stuckReportedRef.current = true;
    const payload = {
      ops: stuckOps.map((op) => ({
        opId: op.opId,
        table: op.table,
        id: op.id,
        attempts: op.attempts,
        firstQueuedAt: new Date(opQueuedAtMs(op)).toISOString(),
        lastError: (op.lastError || '').slice(0, 500),
        estimateId: op.table === 'estimates' ? op.id
          : typeof (op.row as Record<string, unknown>).estimate_id === 'string'
            ? String((op.row as Record<string, unknown>).estimate_id) : null,
      })),
    };
    // Send the current staff session token: pec-sync-stuck is staff-gated
    // server-side (it used to be an open endpoint anyone could post fake stuck
    // reports / notifications to). Best-effort, so a missing session just skips.
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) return;
        await fetch('/.netlify/functions/pec-sync-stuck', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
      } catch { /* best-effort */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stuckCount, online]);

  // Manual "Retry now": clears every backoff timer (force) and drains, then
  // reports the outcome in the panel so the rep sees whether it worked.
  const retryNow = useCallback(async () => {
    setRetryState('running');
    setRetryOutcome('');
    try {
      const r = await drainOutbox({ force: true });
      await refreshPending();
      setRetryOutcome(
        r.synced > 0 && r.remaining === 0 ? 'All saved to the office.'
          : r.synced > 0 ? `${r.synced} uploaded, ${r.remaining} still waiting.`
            : r.failed > 0 ? 'Still not uploading. The office has been notified; your work stays saved on this device.'
              : 'Nothing was due to retry.',
      );
    } catch (e) {
      setRetryOutcome(e instanceof Error ? e.message : String(e));
    }
    setRetryState('done');
  }, [refreshPending]);

  useEffect(() => {
    if (!online) return;
    drainOutbox()
      .then(refreshPending)
      .then(() => {
        // Offline-first-save catch-up (build 25): the auto-first proposal
        // generation could not run at save time; now that the outbox has
        // drained, fire it once. This is what makes the offline note's "the
        // proposal writes itself once online" literally true in-session.
        const id = pendingAutoGenRef.current;
        if (id) {
          pendingAutoGenRef.current = null;
          generateScope(id, false);
        }
      })
      .catch(() => {});
  }, [online, refreshPending, generateScope]);
  useEffect(() => {
    setSaveState('idle');
  }, [areas, salespersonId, intake, customer, finalSell, addonForms, scopeAnswers, overrideReason, isCustom, customScope, customPriceInput, customSqftInput]);

  // ---- Card-first early draft save (prompt 47) -----------------------------
  // Writes the PARENT estimate row only (no areas, line items, or pricing) as
  // an "In Draft" card the moment the rep makes their first real edit, so the
  // estimate exists in the Estimates list before the full Save. Requires the
  // locked basics (name, phone, email, address, salesperson), all prefilled in
  // the lead flow. Silent by design: a failure re-arms the trigger and the
  // explicit Save button stays the loud path.
  const saveDraft = useCallback(async () => {
    if (draftWriteRef.current || savedEstimateId || editing) return;
    if (!salesperson) return;
    if (!draftReady({
      isCommercial: customer.isCommercial,
      company: customer.company,
      lastName: customer.lastName,
      phone: customer.phone,
      email: customer.email,
      address1: customer.address1,
      salespersonId: salesperson.id,
    })) {
      // The debounce ran but an edit since emptied a required field: let the
      // edit that completes the fields fire the trigger again.
      draftTrigger.reset();
      return;
    }
    draftWriteRef.current = true;
    try {
      await saveEstimateOffline({
        estimateId: draftId,
        status: 'draft',
        systemTypeId: null,
        salesperson: { id: salesperson.id, name: salesperson.name, commission_pct: salesperson.commission_pct ?? 0 },
        intake: {
          gate_code: intake.gate_code || null,
          coat_past_garage: intake.coat_past_garage,
          stem_walls: intake.stem_walls,
          moisture: intake.moisture ? Number(intake.moisture) : null,
          mohs_hardness: intake.mohs_hardness ? Number(intake.mohs_hardness) : null,
          additional_non_slip: intake.additional_non_slip || null,
          grinder_tooling_grit: intake.grinder_tooling_grit || null,
          special_notes: intake.special_notes || null,
          base_price: null,
          discount_pct: null,
        },
        customer,
        flakeColor: null,
        scopeAnswers,
        lineItems: [],
        pricingSnapshot: null,
        areas: [],
        pricing: null,
        totals: { price: null, gpDollars: null, gpPct: null, gpPerHour: null, laborBudget: null, commissionDollars: null, budgetedHours: null },
        calcPrice: null,
        priceOverride: null,
        createdBy,
        leadId: linkedLead?.id ?? leadLink?.id ?? null,
        isCustom,
        customScope: isCustom ? customScope : null,
        customPrice: null,
        customSqft: isCustom ? customSqft : null,
        crewNotes,
      });
      if (navigator.onLine) drainOutbox().then(refreshPending).catch(() => {});
      else void refreshPending();
    } catch {
      draftTrigger.reset();
      draftWriteRef.current = false;
    }
  }, [savedEstimateId, editing, salesperson, customer, intake, scopeAnswers, createdBy, linkedLead, leadLink, isCustom, customScope, customSqft, crewNotes, draftId, draftTrigger, refreshPending]);
  const saveDraftRef = useRef(saveDraft);
  useEffect(() => { saveDraftRef.current = saveDraft; }, [saveDraft]);

  // First-real-edit watcher: the same inputs that mark the form dirty. The
  // initial-state check (reference compare against the mount snapshot) makes
  // the open itself, including StrictMode's dev double-run, a non-edit, so
  // opening a lead estimate and backing out writes nothing. The debounce
  // collapses a keystroke burst into one write; the trigger guarantees once.
  const draftInitialDepsRef = useRef<unknown[] | null>(null);
  useEffect(() => {
    const deps: unknown[] = [areas, salespersonId, intake, customer, addonForms, scopeAnswers, isCustom, customScope, customPriceInput, customSqftInput, crewNotes, sellInput, discInput, overrideReason];
    let initial = false;
    if (draftInitialDepsRef.current == null) {
      draftInitialDepsRef.current = deps;
      initial = true;
    } else if (draftInitialDepsRef.current.every((v, i) => Object.is(v, deps[i]))) {
      initial = true;
    }
    const fields = {
      isCommercial: customer.isCommercial,
      company: customer.company,
      lastName: customer.lastName,
      phone: customer.phone,
      email: customer.email,
      address1: customer.address1,
      salespersonId,
    };
    if (!draftTrigger.signal(fields, { initial })) return;
    // NOT cleared on re-run: a second edit inside the window must not cancel
    // the (already consumed) trigger; saveDraft re-checks the live state.
    window.setTimeout(() => { void saveDraftRef.current(); }, 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areas, salespersonId, intake, customer, addonForms, scopeAnswers, isCustom, customScope, customPriceInput, customSqftInput, crewNotes, sellInput, discInput, overrideReason]);

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
  // Prompt 58 Part E: soft warning only. Moisture and MOHS hardness are the
  // two site readings the crew work order really needs; an empty one warns
  // here and on the job page but never blocks save, send, or accept. The
  // other work order fields are deliberately never warned about.
  const woMissingFields = [
    !intake.moisture ? 'Moisture' : null,
    !intake.mohs_hardness ? 'MOHS hardness' : null,
  ].filter(Boolean) as string[];
  // Custom mode gates on customer + a typed price > 0, nothing else: no
  // areas, no materials, no calculated price. Standard mode is unchanged.
  const canSave = !!salesperson && !addonsIncomplete && !customerIncomplete && saveState !== 'saving' &&
    (isCustom
      ? customPrice != null
      : hasPrice && !mvbMissing && !overrideNeedsReason);

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

  // "Polish with AI" (custom mode only): cleans the typed scope into proposal
  // language. POLISH, not authorship: the endpoint's contract preserves
  // meaning, exclusions, and dollar figures verbatim and invents nothing. It
  // never fires automatically, and the pre-polish text is kept for undo.
  const polishScope = useCallback(async () => {
    const text = customScope.trim();
    if (!text || polishBusy) return;
    setPolishBusy(true);
    setPolishError('');
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Sign in to use polish.');
      const res = await fetch('/.netlify/functions/pec-estimate-custom-polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.success || !out.polished) throw new Error(out.error || `Polish failed (${res.status})`);
      setPrePolish(customScope);
      setCustomScope(String(out.polished));
    } catch (e) {
      setPolishError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolishBusy(false);
    }
  }, [customScope, polishBusy]);
  const revertPolish = useCallback(() => {
    if (prePolish == null) return;
    setCustomScope(prePolish);
    setPrePolish(null);
  }, [prePolish]);

  // "Generate from proposal" for the crew notes: sends the assembled proposal
  // (or the custom typed scope) plus the site facts already on the estimate to
  // pec-estimate-crew-notes, which drafts the two-part brief (Cliff notes /
  // Watch out for). Summary-allowed but never-fabricate lives server-side; the
  // undo + ask-before-overwriting-a-hand-edit guarantees live here, exactly
  // like Polish. Manual only: this never fires on its own.
  const crewNotesScopeSource = (isCustom ? customScope : scopeDisplay).trim();
  const generateCrewNotes = useCallback(async () => {
    if (crewNotesBusy) return;
    if (crewNotes.trim() && crewNotesEdited &&
        !window.confirm('Replace your typed crew notes with a fresh AI draft? You can undo afterwards.')) return;
    setCrewNotesBusy(true);
    setCrewNotesError('');
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Sign in to generate crew notes.');
      const sqft = isCustom ? customSqft : (totalSqft > 0 ? totalSqft : null);
      const facts: Record<string, unknown> = {
        'system type': isCustom ? 'custom (one-off) job' : dominantSystem?.name ?? null,
        'square footage': sqft != null ? Math.round(sqft) : null,
        'gate code': intake.gate_code || null,
        'moisture (1-5)': intake.moisture || null,
        'MOHS hardness (1-10)': intake.mohs_hardness || null,
        'stem walls': intake.stem_walls ? 'yes' : null,
        'coat past garage door': intake.coat_past_garage ? 'yes' : null,
        'additional non-slip': intake.additional_non_slip || null,
        'grinder tooling / grit': intake.grinder_tooling_grit || null,
        'special notes': intake.special_notes || null,
        'add-on lines': addonForms.map((f) => f.label.trim() + (f.optional ? ' (optional)' : '')).filter(Boolean).join('; ') || null,
      };
      const res = await fetch('/.netlify/functions/pec-estimate-crew-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ scope: crewNotesScopeSource, facts }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.success || !out.notes) throw new Error(out.error || `Generate failed (${res.status})`);
      setPreGenCrewNotes(crewNotes);
      setCrewNotes(String(out.notes));
      setCrewNotesEdited(false);
      setSaveState('idle');
    } catch (e) {
      setCrewNotesError(e instanceof Error ? e.message : String(e));
    } finally {
      setCrewNotesBusy(false);
    }
  }, [crewNotes, crewNotesBusy, crewNotesEdited, crewNotesScopeSource, isCustom, customSqft, totalSqft, dominantSystem, intake, addonForms]);
  const undoCrewNotes = useCallback(() => {
    if (preGenCrewNotes == null) return;
    setCrewNotes(preGenCrewNotes);
    setPreGenCrewNotes(null);
    setCrewNotesEdited(true);
    setSaveState('idle');
  }, [preGenCrewNotes]);

  // The save, callable two ways: the Save button (opts omitted) and the
  // Regenerate flow (skipAutoScope, because it runs its own generation right
  // after). Returns the estimate id on success so callers can chain on it.
  const performSave = useCallback(async (opts?: { skipAutoScope?: boolean }): Promise<string | null> => {
    // sellPrice non-null covers both modes: the typed custom price, or the
    // engine/override price. The engine snapshot is only required in standard.
    if (!salesperson || sellPrice == null || totalPrice == null) return null;
    if (!isCustom && (!pricing || !hasPrice)) return null;
    if (editing && !online) {
      setSaveState('error');
      setSaveError('Editing an existing estimate needs a connection (it rewrites saved areas). Reconnect and save again.');
      return null;
    }
    // Same-id upsert (prompt 47) means a SECOND full save of a new estimate
    // rewrites the same row's children, which needs the live delete below:
    // same online rule as editing. (A draft-only row has no children, so the
    // FIRST full save after an offline draft still works offline.)
    if (!editing && savedEstimateId && !online) {
      setSaveState('error');
      setSaveError('Saving again rewrites this estimate\'s saved areas, which needs a connection. Reconnect and save again.');
      return null;
    }
    // Floor-GP guard (build 17): warn, do not block. Same philosophy as the 15c
    // BLANK-scope send gate.
    if (belowFloor && !window.confirm(`Gross profit is ${combinedGpPct != null ? (combinedGpPct * 100).toFixed(1) : '--'}%, below the ${config.floorGpPct}% floor. Save this estimate anyway?`)) {
      return null;
    }
    setSaveState('saving');
    setSaveError('');
    try {
      // A custom estimate persists NO area rows: any hidden area state stays
      // in the form (the toggle is non-destructive) but never lands in the
      // database, so the proposal shows only the composed custom line.
      const areaInputs: AreaInput[] = isCustom ? [] : pricedAreas.map((a) => {
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
      // Custom mode instead composes ONE line carrying the typed price +
      // scope, so the proposal page and the PDF render a row with zero
      // special-casing (the edit loader filters it back out by label).
      const lineItems: LineItemInput[] = [];
      if (isCustom) {
        lineItems.push({
          addonId: null,
          areaIndex: null,
          label: CUSTOM_LINE_LABEL,
          description: customScope.trim() || null,
          qty: 1,
          unitPrice: sellPrice,
          unitCost: 0,
          total: sellPrice,
          isOptional: false,
          selectedByCustomer: true,
          sortOrder: 0,
        });
      } else {
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
        const parts = allocateProportionally(sellPrice, weights);
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

      // Custom totals: the typed price sells; commission is standard pct of
      // the total; GP has no cost basis, so it stays honestly null (shown as
      // not-applicable, never a blocker).
      const totals: EstimateTotals = isCustom
        ? {
            price: totalPrice,
            gpDollars: null,
            gpPct: null,
            gpPerHour: null,
            laborBudget: null,
            commissionDollars: customCommission,
            budgetedHours: null,
          }
        : {
            price: totalPrice,
            gpDollars: combinedGpDollars,
            gpPct: combinedGpPct,
            gpPerHour: combinedGpPerHour,
            laborBudget: adjusted ? adjusted.laborDollars : null,
            commissionDollars: combinedCommission,
            budgetedHours: adjusted ? adjusted.budgetedHours : null,
          };

      const pricingSnapshot: Record<string, unknown> | null = isCustom ? null : {
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
      // the materials rows cascade). Online-only, checked above. A re-save of
      // a NEW estimate (same draft id, prompt 47) needs the same rewrite; the
      // draft-only row wrote no children, so its first full save skips this.
      if (editing) await deleteEstimateChildren(editing.id);
      else if (savedEstimateId) await deleteEstimateChildren(savedEstimateId);

      // Live proposal (build 25): a panel edit rides this save under the
      // hand-edited lock; otherwise an already-written document (edited or
      // machine-made) is marked stale, because saves no longer regenerate.
      const editedScopeText = !isCustom && panelEdited && scopeText.trim() ? scopeText : null;
      const { id } = await saveEstimateOffline({
        // The screen's pre-minted id (or the edit's), NEVER a fresh one: the
        // early draft card and every Save upsert the same row (prompt 47).
        estimateId: estimateIdForSave(editing?.id ?? null, draftId),
        status: editing?.status ?? 'draft',
        // A custom estimate has no system; writing the dominant one would be
        // a lie the metrics attribute revenue to.
        systemTypeId: isCustom ? null : dominantSystemId,
        salesperson: { id: salesperson.id, name: salesperson.name, commission_pct: salesperson.commission_pct ?? 0 },
        intake: intakePayload,
        // Split shape straight through; saveEstimateOffline trims, composes
        // the combined customer_name/customer_address safety nets, and writes
        // both alongside the split columns.
        customer,
        flakeColor: isCustom ? null : editing?.flakeColor ?? flakeColorFromPicks,
        scopeAnswers,
        lineItems,
        pricingSnapshot,
        areas: areaInputs,
        pricing,
        totals,
        // Provenance: the engine price, and the override reason/who when the rep
        // moved the system sell price off it. Both null in custom mode: the
        // typed price is not an override of anything.
        calcPrice: basePrice,
        priceOverride: discounted ? { reason: overrideReason.trim(), by: createdBy } : null,
        createdBy: editing?.createdBy ?? createdBy,
        // The dedup pick (linkedLead) outranks the URL lead link: the rep
        // explicitly chose that record. An edit keeps its stored lead.
        leadId: editing?.leadId ?? linkedLead?.id ?? leadLink?.id ?? null,
        // Custom saves write the scope themselves (with scope_edited_at). A
        // standard save flags the document stale whenever one exists and this
        // save is not carrying fresh text: with auto-regenerate gone (build
        // 25, cost + edit safety), "the estimate may have moved under the
        // document" is now true of machine text too, not just edited text.
        markScopeStale: isCustom ? false : editedScopeText == null && (dbScopeEdited || scopeGenerated),
        editedScope: editedScopeText,
        isCustom,
        customScope: isCustom ? customScope : null,
        customPrice: isCustom ? sellPrice : null,
        customSqft: isCustom ? customSqft : null,
        crewNotes,
      });
      // Auto-first, then manual (build 25): the ONE automatic generation
      // happens on the save that has a scope-templated estimate with every
      // scope question answered and no document yet. After that, saves only
      // mark the document stale and the Regenerate button is the only writer.
      // Custom estimates NEVER generate: the typed text IS the scope, and the
      // template writer would replace it with add-on snippets.
      const shouldAutoGen = !isCustom && !opts?.skipAutoScope && editedScopeText == null &&
        !dbScopeEdited && !panelEdited && !scopeGenerated && scopeQuestions.length === 0;
      let syncedNumber: number | null = editing?.estimateNumber ?? null;
      if (navigator.onLine) {
        await drainOutbox().catch(() => {});
        if (syncedNumber == null) {
          try {
            const { data } = await supabase.from('estimates').select('estimate_number').eq('id', id).maybeSingle();
            syncedNumber = (data as { estimate_number: number | null } | null)?.estimate_number ?? null;
          } catch { /* the number arrives when the outbox drains */ }
        }
        // Fired in the background (not awaited) like the old post-save
        // trigger, but the panel now shows the result the moment it lands.
        if (shouldAutoGen) generateScope(id, false);
      } else if (shouldAutoGen) {
        // Offline: owed generation fires when the outbox drains (effect above).
        pendingAutoGenRef.current = id;
      }
      // Mirror what the save just wrote into the panel's own state.
      if (!isCustom) {
        if (editedScopeText != null) {
          setDbScopeEdited(true);
          setPanelEdited(false);
          setScopeStale(false);
        } else if (dbScopeEdited || scopeGenerated) {
          setScopeStale(true);
        }
      }
      setSavedEstimateId(id);
      draftWriteRef.current = true; // the row exists; the early draft must never fire after a full save
      await refreshPending();
      setSavedOffline(!navigator.onLine);
      setSaveState('saved');
      if (embed) {
        // The dashboard closes the modal, refreshes the lead, and opens the
        // estimate page off this message (origin-checked on its side).
        postToParent({ type: 'pec-estimate-saved', estimate_id: id, estimate_number: syncedNumber });
      }
      return id;
    } catch (e) {
      setSaveState('error');
      setSaveError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [salesperson, pricing, hasPrice, sellPrice, totalPrice, editing, online, pricedAreas, engineAreas, deriveProducts, slotsFor, intake, basePrice, discounted, adjusted, overrideReason, mvbProduct, totalSqft, inputsKey, comps, compsLabel, ai, customer, flakeColorFromPicks, createdBy, leadLink, linkedLead, refreshPending, embed, postToParent, addonForms, scopeAnswers, belowFloor, combinedGpDollars, combinedGpPct, combinedGpPerHour, combinedCommission, dominantSystemId, systemTypes, productsById, recipeSlotsBySystemType, config, generateScope, isCustom, customScope, customSqft, crewNotes, customCommission, panelEdited, dbScopeEdited, scopeGenerated, scopeText, scopeQuestions, savedEstimateId, draftId]);
  const onSave = useCallback(() => { void performSave(); }, [performSave]);

  // Manual Regenerate (build 25): the only proposal writer after the first
  // generation. Saves first when the form has unsaved changes, so the
  // document always re-assembles from what the rep is looking at, never a
  // stale row. Replacing edited text takes the same explicit confirm as the
  // estimate page's Regenerate, and only then sends force=true.
  const regenerateScope = useCallback(async () => {
    if (scopeBusy || !online || isCustom) return;
    if (scopeEditedAny && !window.confirm('The proposal was edited by hand. Regenerating REPLACES the edited text with a fresh write-up assembled from the estimate. Continue?')) return;
    const force = scopeEditedAny;
    let id = savedEstimateId;
    if (saveState !== 'saved') {
      if (!canSave) {
        setScopeError('Finish the estimate (customer and price) and it will save before regenerating.');
        return;
      }
      id = await performSave({ skipAutoScope: true });
    }
    if (id) await generateScope(id, force);
  }, [scopeBusy, online, isCustom, scopeEditedAny, savedEstimateId, saveState, canSave, performSave, generateScope]);

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

  // Work order questions, ONE source of the field list (prompt 58 Part E):
  // standard mode renders this inside More detail; custom mode gets its own
  // details block below it, since the rest of More detail is recipe/area
  // machinery a custom estimate does not have.
  const workOrderFields = (
    <>
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
      {woMissingFields.length > 0 && (
        <p className="warn">{woMissingFields.join(' and ')} not filled in yet. The crew work order prints them blank; saving and sending still work.</p>
      )}
    </>
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
          {/* Three states (prompt 48): normal, quietly syncing, or BROKEN.
              The red state replaces the counter that let failed saves read
              as normal progress for a week; the age is what makes a rep
              escalate ("6 days" reads very differently from "3 to sync"). */}
          {stuckOps.length > 0 ? (
            <button
              type="button"
              className="sync-broken"
              onClick={() => { setSyncPanelOpen((o) => !o); setRetryState('idle'); setRetryOutcome(''); }}
              aria-expanded={syncPanelOpen}
            >
              <span className="dot broken" />
              {stuckOps.length === 1 ? '1 save not syncing' : `${stuckOps.length} saves not syncing`} · oldest {oldestStuckAge} ▾
            </button>
          ) : (
            <>
              <span className={online ? 'dot online' : 'dot offline'} title={online ? 'Online' : 'Offline'} />
              <span className="status-text">
                {online ? 'Online' : 'Offline'}
                {pending > 0 && ` · ${pending} to sync`}
                {catalogFromCache && ' · cached catalog'}
              </span>
            </>
          )}
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

      {syncPanelOpen && stuckOps.length > 0 && (
        <div className="sync-panel" role="region" aria-label="Saves not syncing">
          <div className="sync-panel-head">
            <strong>Saved on this device, not yet uploaded</strong>
            <p>
              Your work is safe here and keeps retrying on its own. It has not reached the office yet.
              If this stays red after Retry, tell Dylan and read him the message below.
            </p>
          </div>
          <ul>
            {stuckOps.map((op) => (
              <li key={op.opId}>
                <div className="sync-op-title">
                  {opLabel(op)}
                  <span className="sync-op-meta">
                    {op.attempts} tries · stuck {fmtAge(Date.now() - opQueuedAtMs(op))}
                  </span>
                </div>
                {/* The raw error verbatim: "Could not find the 'crew_notes'
                    column" is exactly the string that solves the problem for
                    whoever the rep reads it to. Never prettified. */}
                {op.lastError && <code className="sync-op-error">{op.lastError}</code>}
              </li>
            ))}
          </ul>
          <div className="sync-panel-actions">
            <button type="button" className="as-btn" onClick={retryNow} disabled={retryState === 'running' || !online}>
              {retryState === 'running' ? 'Retrying…' : 'Retry now'}
            </button>
            {!online && <span className="sync-op-meta">You are offline. Retry becomes available once you are back online.</span>}
            {retryState === 'done' && retryOutcome && <span className="sync-retry-outcome">{retryOutcome}</span>}
          </div>
        </div>
      )}

      <main className="cols">
        <div className="left">
          {/* Standard / Custom is an ESTIMATE-level switch (build 24), not a
              system type: Custom turns the whole estimate into typed scope +
              typed price for one-off work. Non-destructive: hidden area and
              answer state survives a toggle round-trip. */}
          <section className="card inputs">
            <div className="areas-head">
              <span>Estimate type</span>
              <div className="cust-type" role="group" aria-label="Estimate type">
                <button type="button" className={isCustom ? '' : 'on'} onClick={() => setIsCustom(false)}>Standard</button>
                <button type="button" className={isCustom ? 'on' : ''} onClick={() => setIsCustom(true)}>Custom</button>
              </div>
            </div>
            {isCustom && (
              <p className="hint">Custom estimate for one-off work: you type the scope and the price yourself. Areas and the material calculator are off (switch back to Standard to use them); add-ons still work.</p>
            )}
          </section>

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
            {custSearchEnabled && (
              <div className="cust-search">
                <label className="field cust-wide">
                  <span>Search existing customers and leads</span>
                  <div className="addr-ac">
                    <input
                      value={custSearch}
                      onChange={(e) => setCustSearch(e.target.value)}
                      onFocus={() => { if (custMatches.length) setCustSearchOpen(true); }}
                      placeholder="Name, phone, email, or address"
                    />
                    {custSearchOpen && custMatches.length > 0 && (
                      <div className="addr-ac-list" role="listbox">
                        {custMatches.map((m) => (
                          <button
                            key={`${m.kind}:${m.id}`}
                            type="button"
                            className="addr-ac-item"
                            onClick={() => void pickCustomerMatch(m)}
                          >
                            <span className="addr-ac-main">
                              {m.name} <span className={`match-kind ${m.kind}`}>{m.kind === 'lead' ? 'Lead' : 'Customer'}</span>
                            </span>
                            {(m.phone || m.addressLine) && (
                              <span className="addr-ac-sec">{[m.phone, m.addressLine].filter(Boolean).join(' · ')}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </label>
                {linkedLead && (
                  <p className="hint link-ok">
                    Linked to existing record: <strong>{linkedLead.name}</strong>. Saving attaches this estimate to it instead of creating a duplicate.{' '}
                    <button type="button" className="as-link" onClick={() => setLinkedLead(null)}>Unlink</button>
                  </p>
                )}
                {linkNote && <p className="hint link-warn">{linkNote}</p>}
              </div>
            )}
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
              {salespersonLocked ? (
                <>
                  <input value={salesperson ? salesperson.name : 'Unassigned'} readOnly disabled />
                  <p className="muted" style={{ fontSize: '.75rem', margin: '4px 0 0' }}>
                    Set when the estimate was started. An admin can change it.
                  </p>
                </>
              ) : (
                <select value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)}>
                  <option value="">Select…</option>
                  {salespeople.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.commission_pct ?? 0}% commission)
                    </option>
                  ))}
                </select>
              )}
            </label>

            {salespersonUnmapped && <p className="warn">{salespersonPrompt}</p>}

            {!isCustom && mvbMissing && (
              <p className="error">The product "{MVB_PRODUCT_NAME}" is missing or inactive in the Catalog, so the moisture vapor barrier cannot be priced. Restore it (Price &amp; Material Catalog) or uncheck MVB on the areas.</p>
            )}
          </section>

          {/* Custom mode: the typed scope replaces the areas/systems flow.
              The textarea is the customer-facing proposal text; Polish is
              optional, never automatic, and always undoable. */}
          {isCustom && (
            <section className="card">
              <div className="areas-head">
                <span>Scope of work</span>
                <span className="scope-actions">
                  {prePolish != null && (
                    <button type="button" className="link" onClick={revertPolish}>Undo polish</button>
                  )}
                  <button type="button" className="link" onClick={polishScope} disabled={polishBusy || !online || !customScope.trim()}>
                    {polishBusy ? 'Polishing…' : 'Polish with AI'}
                  </button>
                </span>
              </div>
              <p className="hint">Type the scope in your own words; this is what the customer reads on the proposal. Polish (optional) cleans grammar and structure only: it keeps your exclusions and dollar figures, adds nothing, and can be undone.</p>
              <textarea
                className="custom-scope"
                rows={10}
                value={customScope}
                onChange={(e) => setCustomScope(e.target.value)}
                placeholder="Describe the work: prep, what gets coated, what is excluded…"
              />
              {polishError && <p className="warn">Polish failed: {polishError}</p>}
              {!online && <p className="hint">Polish needs a connection; your typed text saves fine without it.</p>}
            </section>
          )}

          {!isCustom && <section className="card">
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
          </section>}

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

          {/* Template-driven, so they do not apply to a custom estimate. */}
          {!isCustom && scopeQuestions.length > 0 && (
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

          {/* Live proposal (build 25): the assembled customer-facing scope,
              editable as the estimate is built. Before the first generation
              it is a local template preview (instant, works offline); the
              server-assembled document replaces it on the auto-first save,
              and after that only the explicit Regenerate rewrites it. */}
          {!isCustom && (
            <section className="card scope-live">
              <div className="areas-head">
                <span>Proposal / Scope of work</span>
                <span className="scope-actions">
                  <button
                    type="button"
                    className="link"
                    onClick={regenerateScope}
                    disabled={scopeBusy || !online || (!savedEstimateId && !canSave)}
                  >
                    {scopeBusy ? 'Writing…' : scopeGenerated ? 'Regenerate proposal' : 'Write proposal now'}
                  </button>
                </span>
              </div>
              {!scopeDisplay.trim() ? (
                <p className="hint">The proposal assembles here from your scope templates once an area has a system and square footage.</p>
              ) : (
                <>
                  <textarea
                    className="custom-scope"
                    rows={12}
                    value={scopeDisplay}
                    onChange={(e) => onScopeTextChange(e.target.value)}
                    aria-label="Proposal / scope of work"
                  />
                  {scopeBusy && <p className="hint">Writing the polished proposal…</p>}
                  {!scopeBusy && scopeEditedAny && (
                    <p className="hint">Edited by hand: the AI never replaces this text unless you tap Regenerate and confirm.</p>
                  )}
                  {!scopeBusy && !scopeEditedAny && !scopeGenerated && (
                    <p className="hint">
                      {scopeQuestions.length > 0
                        ? 'Live template preview. Answer the questions above, then save, and the polished proposal writes itself.'
                        : 'Live template preview. Save the estimate and the polished proposal writes itself.'}
                    </p>
                  )}
                  {!scopeBusy && scopeStale && (scopeGenerated || scopeEditedAny) && (
                    <p className="warn">
                      The estimate changed after this proposal was written.
                      {scopeEditedAny ? ' Your text stays as-is unless you tap Regenerate.' : ' Tap Regenerate proposal to bring it up to date.'}
                    </p>
                  )}
                  {scopeContainsBlank(scopeDisplay) && (
                    <p className="warn">The word BLANK is still in the text and the customer will see it. Answer the scope questions above, or edit it out here.</p>
                  )}
                  {scopeError && <p className="warn">{scopeError}</p>}
                  {!online && !scopeGenerated && !scopeEditedAny && (
                    <p className="hint">Offline: showing the template preview. The polished proposal writes itself once you are back online (or from the estimate page).</p>
                  )}
                </>
              )}
            </section>
          )}

          {/* Everything below is OPTIONAL and collapsed: a rep who never opens
              it still gets a correct price off the recipe defaults. Hidden in
              custom mode (it is all recipe/area detail). */}
          {!isCustom && <details className="card more-detail">
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
            {workOrderFields}
          </details>}

          {/* Custom mode still needs the site questions (prompt 58 Part E):
              same field list as above, its own details block because the rest
              of More detail is recipe/area machinery custom mode hides. */}
          {isCustom && <details className="card more-detail">
            <summary>Work order <span className="muted">(site questions)</span></summary>
            {workOrderFields}
          </details>}

          {/* Crew notes (prompt 32, Part B): INTERNAL, both modes. Prints on
              the crew work order only; never on the customer proposal, the
              customer estimate page, or the PDF. Generate is manual-only. */}
          <section className="card">
            <div className="areas-head">
              <span>Crew notes (internal)</span>
              <span className="scope-actions">
                {preGenCrewNotes != null && (
                  <button type="button" className="link" onClick={undoCrewNotes}>Undo generate</button>
                )}
                <button type="button" className="link" onClick={generateCrewNotes} disabled={crewNotesBusy || !online || !crewNotesScopeSource}>
                  {crewNotesBusy ? 'Generating…' : 'Generate from proposal'}
                </button>
              </span>
            </div>
            <p className="hint">Only the crew sees this; it prints on the work order, never on the customer proposal. Generate drafts cliff notes and watch-outs from the proposal; you can edit or undo.</p>
            <textarea
              rows={6}
              value={crewNotes}
              onChange={(e) => { setCrewNotes(e.target.value); setCrewNotesEdited(true); setSaveState('idle'); }}
              placeholder="Cliff notes and watch-outs for the crew: access, prep, site conditions, customer asks…"
            />
            {crewNotesError && <p className="warn">Generate failed: {crewNotesError}</p>}
            {!online && <p className="hint">Generate needs a connection; typed crew notes save fine without it.</p>}
          </section>
        </div>

        <div className="right">
          <section className="card result" aria-live="polite">
            {salespersonPrompt && <p className="hint">{salespersonPrompt}</p>}
            {/* Custom mode: the typed price IS the sell price. No engine, no
                GP basis, no blockers beyond customer + price. */}
            {isCustom && salesperson && (
              <>
                <div className="price">{money(totalPrice)}</div>
                {hasOptionalAddons && totalAllOptions != null && totalAllOptions !== totalPrice && (
                  <p className="hint">with every optional item: {money(totalAllOptions)}</p>
                )}
                {sellPrice != null && addonsBaseTotal > 0 && (
                  <p className="hint">custom work {money(sellPrice)} + add-ons {money(addonsBaseTotal)}</p>
                )}
                <label className="field"><span>Price $ (you set it{customPrice == null ? ', required' : ''})</span>
                  <input inputMode="decimal" value={customPriceInput} placeholder="0" onChange={(e) => setCustomPriceInput(e.target.value.replace(/[^0-9.]/g, ''))} />
                </label>
                <label className="field"><span>Square footage (optional)</span>
                  <input inputMode="decimal" value={customSqftInput} placeholder="0" onChange={(e) => setCustomSqftInput(e.target.value.replace(/[^0-9.]/g, ''))} />
                </label>
                {/* $/sqft READOUT (prompt 32): price / sqft, display only. The
                    typed price is never computed from a rate. INTERNAL, same
                    as the standard-mode ppsf line. */}
                {customPrice != null && customSqft != null && (
                  <div className="ppsf-line">{money2(customPrice / customSqft)}<span className="muted"> / sqft</span></div>
                )}
                <dl className="metrics">
                  <div><dt>Commission (standard {config.standardCommissionPct}%)</dt><dd>{money2(customCommission)}</dd></div>
                  <div><dt>Gross profit</dt><dd>--</dd></div>
                </dl>
                <p className="hint">Custom estimate: the price is typed, not calculated, so GP has no cost basis and is not shown. Commission is the standard {config.standardCommissionPct}% of the total.</p>
                {customerIncomplete && (
                  <p className="warn">{customer.isCommercial ? 'Enter the company name (Customer card) to save.' : 'Enter the customer’s last name (Customer card) to save.'}</p>
                )}
                {woMissingFields.length > 0 && (
                  <p className="warn">Work order: {woMissingFields.join(' and ')} not filled in (see Work order above). Saving still works.</p>
                )}
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
            {!isCustom && salesperson && !hasPrice && !err && !mvbMissing && <p className="hint">Enter the square footage to price the job.</p>}
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
                {woMissingFields.length > 0 && (
                  <p className="warn">Work order: {woMissingFields.join(' and ')} not filled in (see More detail above). Saving still works.</p>
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

          {/* Comps and the AI price read key off system + sqft, which a custom
              estimate does not have; hidden rather than pretending. */}
          {!isCustom && <section className="card comps">
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
          </section>}

          {!isCustom && <section className="card ai-panel">
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
          </section>}
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
