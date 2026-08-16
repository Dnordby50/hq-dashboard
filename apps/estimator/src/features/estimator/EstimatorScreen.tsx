import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Addon, Catalog, SalesPerson } from '../../lib/catalog';
import {
  allocateProportionally,
  applyLineSellPrice,
  computePerLinePricing,
  customLinePricing,
  lineItemsTotal,
  lineRowsReady,
  roundEstimatePrice,
  type Area,
  type CustomLineMoney,
  type LineSellResult,
  type PerLinePricingResult,
  type PricedLine,
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
import { composeCustomerAddress, composeCustomerName, emptyCustomer, splitLegacyName, type CustomerForm } from '../../lib/customer';
import AddressAutocomplete from './AddressAutocomplete';
import BottomSheet from './BottomSheet';
import type { LoadedEstimate } from '../../lib/estimateLoad';
import { deleteEstimateChildren } from '../../lib/estimateLoad';
import { listOps, type OutboxOp } from '../../offline/outbox';
import { drainOutbox } from '../../offline/sync';
import { buildComps, compsGpCaveat, compsRuleLabel, loadCompCandidates, type CompCandidate, type CompsResult } from '../../lib/comps';
import { compsForAi, fetchAiRecommendation, type AiLineInput, type AiRecommendation } from '../../lib/ai';
// Per-line AI inputs key (prompt 70): the same CJS module pec-estimate-ai.cjs
// requires, so client and server can never disagree about what re-keys a read.
import { linesInputsKey } from '../../../../../production/ai-lines.cjs';
// Optional-lines money rules (prompt 72): the same CJS module
// pec-public-estimate.cjs uses, so the rep's totals and the customer's page
// can never disagree about what required-only / all-in / opening mean.
import { CLOBBER_DESC_RE, optionalControlsVisible, splitLineTotals } from '../../../../../production/optional-lines.cjs';
// Payment-schedule math (prompt 74): the SAME module pec-public-estimate.cjs
// resolves and freezes with, so the card's dollars and the customer page can
// never disagree.
import { computeScheduleCents, defaultScheduleRows, resolveDepositPct, scheduleValidationError } from '../../../../../production/estimate-installments.cjs';
import { supabase } from '../../lib/supabase';
import { ensureLeadForCustomer, searchCustomersAndLeads, type CustomerMatch } from '../../lib/customerSearch';
import { uuid } from '../../offline/uuid';
import { applyAnswers as scopeApplyAnswers, applyTokens as scopeApplyTokens, containsBlank as scopeContainsBlank, openQuestions as scopeOpenQuestions, tokenFields as scopeTokenFields, type ScopeQuestion, type TokenField } from '../../../../../production/scope.cjs';
// Card-first draft + salesperson default rules (prompt 47): shared CJS module
// (the scope.cjs pattern) so the fixture tests exercise the exact logic the
// screen runs.
import { createDraftTrigger, defaultSalespersonId, draftReady, estimateIdForSave, initialAreas, userUnmapped } from '../../../../../production/estimate-draft.cjs';

// One LINE of the estimate (prompt 69). A calculator area (isCustom false)
// prices through the engine and may carry a per-line price override
// (priceInput). A CUSTOM line (isCustom true) is a typed one-off ON the same
// estimate: name doubles as the customer-facing label, priceInput IS its typed
// price (required), and its cost basis is typed material cost + typed labor
// hours so its GP has the same shape as every other line. notes is INTERNAL
// per-line context fed to the scope writer, never customer-facing.
type AreaForm = {
  name: string;
  sqft: string;
  systemTypeId: string;
  mvb: boolean;
  slotValues: Record<string, string>;
  notes: string;
  priceInput: string;
  isCustom: boolean;
  customScope: string;
  customMaterialCost: string;
  customLaborHours: string;
  // Optional lines (prompt 72): the rep decides per line, default required.
  // preselected = whether an optional line starts TICKED for the customer
  // (opt-out; ignored while optional is false). An area's MVB rides its area:
  // dropping the line drops its barrier, so MVB gets no separate control.
  optional: boolean;
  preselected: boolean;
  // Prompt 74: the line's saved scope DESCRIPTION, round-tripped so a re-save
  // PRESERVES it (a save must never author a calculator line's description;
  // the "970 sqft" clobber erased real scope on sent estimates). Hydrated on
  // edit-load and refreshed after a successful scope generation; empty on a
  // brand-new line (the save writes null and the scope writer fills it).
  lineDescription: string;
};
const emptyLineFields = { notes: '', priceInput: '', isCustom: false, customScope: '', customMaterialCost: '', customLaborHours: '', optional: false, preselected: true, lineDescription: '' };
// A date token's committed value is customer-facing text, so the ISO value
// the picker produces ("2026-09-03") is rewritten as prose. En-US on purpose:
// this string lands on the proposal.
const fmtTokenDate = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
};
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

// One payment-schedule row in form state (prompt 74). valueInput is the
// ready-to-edit string (the areas.sqft pattern); kind picks percent vs
// dollars; trigger is the milestone the customer reads on the estimate.
type ScheduleRowForm = {
  key: string;
  label: string;
  kind: 'percent' | 'fixed';
  valueInput: string;
  trigger: string; // on_acceptance | on_start | on_completion | date
  dueDate: string;
  isDeposit: boolean;
};
const SCHEDULE_TRIGGERS: Array<[string, string]> = [
  ['on_acceptance', 'At signing'],
  ['on_start', 'At job start'],
  ['on_completion', 'At completion'],
  ['date', 'On a date'],
];

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

// ONE completeness rule shared by the save gate and the customer lock: a
// commercial estimate needs its company, a residential one a last name.
// Deliberately nothing else; the address is never a gate.
const customerComplete = (c: CustomerForm) => (c.isCommercial ? c.company.trim() !== '' : c.lastName.trim() !== '');

export default function EstimatorScreen({
  catalog,
  createdBy,
  viewerIsAdmin,
  catalogFromCache,
  leadLink,
  embed,
  editing,
  focusLine,
}: {
  catalog: Catalog;
  createdBy: string | null;
  viewerIsAdmin: boolean;
  catalogFromCache: boolean;
  leadLink: LeadLink | null;
  embed: boolean;
  editing: LoadedEstimate | null;
  // Prompt 76 Part F: a send-gate blocker deep link (?focus_line=<sort_order>)
  // opens that line's editor sheet with the description focused.
  focusLine?: number | null;
}) {
  const { systemTypes, productsById, recipeSlotsBySystemType, salespeople, config } = catalog;
  // A catalog cached before 2026-07-13 has no addons key; tolerate it so an
  // offline rep still prices (the add-on picker is just empty until a refresh).
  const addonCatalog: Addon[] = catalog.addons ?? [];
  const online = useOnline();
  // Prefilled label on a new custom line (prompt 69). Tolerates a pre-69
  // cached catalog (key absent) with the same default the migration seeds.
  const customLabelDefault = config.linePricingCustomLabelDefault || 'Custom work';

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

  // ---- Scope templates on lines (prompt 94 B1) -----------------------------
  // Picking a system drops its scope_template into the line description,
  // fully editable. An MVB line prefers scope_template_mvb when the system
  // has one (today only Standard Flake does) and falls back to the standard
  // template otherwise. This replaces the AI Generate path: the template
  // lands at pick time, and {{tokens}} in it get a fill-in form in the sheet.
  const templateForSystem = useCallback((sysId: string, mvb: boolean): string | null => {
    const sys = systemTypes.find((s) => s.id === sysId);
    if (!sys) return null;
    const t = (mvb && sys.scope_template_mvb) ? sys.scope_template_mvb : sys.scope_template;
    return t && String(t).trim() ? String(t) : null;
  }, [systemTypes]);
  // "Machine-written" = replaceable without asking: empty, the sqft clobber
  // fingerprint, or byte-identical (trimmed) to SOME system's raw template
  // (either variant; raw, because a token-substituted or hand-edited template
  // is the rep's work and must survive a system change unprompted-over).
  // Anything else is the rep's words; replacing those asks first.
  const isMachineDesc = useCallback((desc: string): boolean => {
    const d = String(desc || '').trim();
    if (!d) return true;
    if (CLOBBER_DESC_RE.test(d)) return true;
    return systemTypes.some((s) =>
      (s.scope_template != null && String(s.scope_template).trim() === d)
      || (s.scope_template_mvb != null && String(s.scope_template_mvb).trim() === d));
  }, [systemTypes]);
  // Nothing auto-fills once the estimate has been sent: line descriptions
  // inherit the never-rewritten-after-send rule (prompt 94 B1). Draft-only.
  const templateAutoFillOk = editing == null || (editing.status === 'draft' && editing.sentAt == null);
  // Prompt 94 B4: ONE flag now gates every AI generate/polish entry point
  // (per-line Generate, custom Polish, the whole-document writer and its
  // auto-fire). Flipped off in prod once templates fill at pick time; the
  // code stays for rollback, and the server enforces the same flag.
  const generateOn = config.estimateLineGenerateEnabled !== false;
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
  // Loosened by Dylan's call 2026-08-03 (prompt 65 follow-up): the CREATOR
  // may change the salesperson while the estimate is still an unsent draft;
  // the lock lands at send. A brand-new estimate (editing null) is by
  // definition an unsent draft this login is creating. Fail-closed otherwise:
  // a null createdBy on either side keeps the lock for non-admins.
  const [salespersonSetAtOpen] = useState<boolean>(() => salespersonId !== '');
  const creatorUnsentDraft = editing == null
    || (editing.status === 'draft' && editing.sentAt == null
      && editing.createdBy != null && createdBy != null
      && String(editing.createdBy) === String(createdBy));
  const salespersonLocked = salespersonSetAtOpen && !viewerIsAdmin && !creatorUnsentDraft;
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
  // Customer lock (Dylan's ask): once the info is inputted the card collapses
  // into a summary bar at the top of the estimate; clicking the bar reopens
  // it. Starts locked only when the seed already carries a savable identity
  // (editing an estimate, or a lead deep link with a name); a fresh estimate
  // opens with the fields ready to type into.
  const [custLocked, setCustLocked] = useState<boolean>(() => customerComplete(customer));
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
    // Picking a match IS "info inputted", so the card locks right away when
    // the record carries a savable identity. Plain typing never auto-locks.
    if (customerComplete(m.form)) setCustLocked(true);
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
  // Editing an estimate WITH areas maps them straight in. Editing one with NO
  // areas (a dashboard-created draft, prompt 61 Part B: the row exists before
  // the estimator ever opens) seeds the SAME single Main area the create path
  // uses, defaults included, instead of an empty area list the rep cannot
  // price from. The rule lives in estimate-draft.cjs (initialAreas) so the
  // fixture test drives it; the fix lives here, not in a fake database row.
  const [areas, setAreas] = useState<AreaForm[]>(() =>
    initialAreas({
      editingAreas: editing
        ? editing.areas.map((a) => ({
            name: a.name,
            sqft: a.sqft,
            // A custom line has no system on purpose; do not backfill one.
            systemTypeId: a.systemTypeId ?? (a.isCustom ? '' : fallbackSystemId),
            mvb: a.mvb === true,
            slotValues: a.slotValues,
            notes: a.notes ?? '',
            priceInput: a.priceOverride ?? '',
            isCustom: a.isCustom === true,
            customScope: a.customScope ?? '',
            customMaterialCost: a.customMaterialCost ?? '',
            customLaborHours: a.customLaborHours ?? '',
            optional: a.isOptional === true,
            preselected: a.preselected !== false,
            lineDescription: a.lineDescription ?? '',
          }))
        : null,
      // Prompt 94 B1: the default area is born with its system's template
      // already in the description (only on an unsent draft; editing a sent
      // estimate never auto-fills).
      makeDefaultArea: () => ({ name: 'Main', sqft: '', systemTypeId: fallbackSystemId, mvb: false, slotValues: fallbackSystemId ? defaultSlotValues(fallbackSystemId) : {}, ...emptyLineFields, lineDescription: (templateAutoFillOk && fallbackSystemId ? templateForSystem(fallbackSystemId, false) : null) ?? '' }),
    }) as AreaForm[],
  );
  // Prompt 63 Part A: product-kind slots are HIDDEN at estimate time (Dylan:
  // "only things that drive sales on the estimate"). This flag is the escape
  // hatch for commercial bids / a customer who already picked: session-only,
  // never persisted, defaults collapsed on every open, reveals for ALL areas.
  // Hiding is display-only: slotValues keeps the prefilled defaults either
  // way, so the material plan, the price, and the saved slot rows are
  // byte-identical whether or not the dropdowns render.
  const [specifyProducts, setSpecifyProducts] = useState(false);
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
  // ---- Assembled scope document (build 25, reshaped by prompt 76) ----------
  // The whole-document scope PANEL is gone (Part D): reps read and edit scope
  // PER LINE in the sheet now. The assembled document itself still exists,
  // because estimates.scope_of_work keeps feeding jobScope, the crew scope,
  // and the declined filter; scopeText holds it here only as the crew-notes
  // generator's source and for the BLANK warning on the Line items card.
  const [scopeText, setScopeText] = useState<string>(() => editing?.scopeOfWork ?? '');
  const [scopeGenerated, setScopeGenerated] = useState<boolean>(() => editing?.hasScope === true);
  // A scope already edited in the database (the old whole-document Edit text
  // flow, or a custom-mode save) gates force/stale semantics. The prompt-76
  // rework deleted the whole-document textarea, so there is no panel edit
  // path anymore; per-line edits ride the save as lineDescription instead.
  const [dbScopeEdited, setDbScopeEdited] = useState<boolean>(() => !!editing?.scopeEditedAt);
  // ---- Line editor sheet (prompt 76 Part C) --------------------------------
  // The line list is a compact table now; tapping a row opens the bottom
  // sheet for that ONE line. Area/custom lines address by index into areas[];
  // add-on/one-off lines by their stable form key.
  const [openLine, setOpenLine] = useState<{ kind: 'area'; idx: number } | { kind: 'addon'; key: string } | null>(null);
  const [sheetFocusDesc, setSheetFocusDesc] = useState(false);
  // Prompt 76 Part A3 (precedence): form indexes whose description the rep
  // edited since the last EXPLICIT generation. The post-generation re-fetch
  // skips these so a generation can never silently discard typed text; the
  // rep pressing Generate/Regenerate clears the flag (that IS asking).
  // A ref, not state: nothing renders from it.
  const lineDescEditedRef = useRef<Set<number>>(new Set());
  const addonDescEditedRef = useRef<Set<string>>(new Set());
  // Per-line skip reasons from the last generation (Part B3): why the writer
  // could not serve a line (no template on the system), keyed by form index.
  const [skipReasonByIdx, setSkipReasonByIdx] = useState<Record<number, string>>({});
  const [scopeStale, setScopeStale] = useState<boolean>(() => editing?.scopeStale === true);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeError, setScopeError] = useState('');
  const [savedEstimateId, setSavedEstimateId] = useState<string | null>(() => editing?.id ?? null);
  // Estimate saved OFFLINE with the auto-first generation still owed: the id
  // waits here until the outbox drains, then the generation fires by itself.
  const pendingAutoGenRef = useRef<string | null>(null);
  // Prompt 74: the last save's sort_order -> areas[] form index map, so a
  // successful scope generation can write the freshly assembled per-line
  // descriptions back into form state (lineDescription) and the NEXT save
  // preserves them instead of nulling them. Set by performSave (standard
  // mode), read by generateScope after the server writes the descriptions.
  const lastSaveFormIdxBySortRef = useRef<number[]>([]);
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
  // Three-lane notes (2026-08-20, DripJobs-parity phase 4): client notes are
  // CLIENT VISIBLE (customer estimate page, "A note from us"); company notes
  // are INTERNAL ONLY. Crew notes above keep their crew-work-order contract.
  const [clientNotes, setClientNotes] = useState<string>(() => editing?.clientNotes ?? '');
  const [companyNotes, setCompanyNotes] = useState<string>(() => editing?.companyNotes ?? '');
  // Bottom tab strip (Settings | Notes), the DripJobs editor shape.
  const [estTab, setEstTab] = useState<'settings' | 'notes'>('settings');
  const [crewNotesEdited, setCrewNotesEdited] = useState(false);
  const [preGenCrewNotes, setPreGenCrewNotes] = useState<string | null>(null);
  const [crewNotesBusy, setCrewNotesBusy] = useState(false);
  const [crewNotesError, setCrewNotesError] = useState('');
  // ---- Payment schedule (prompt 74): deposit + progress payments, created
  // and approved on the ESTIMATE before the customer ever sees it (locked
  // decision 5). Round-trips through estimate_installments; zero rows = no
  // schedule block anywhere and the legacy auto-deposit flow on accept.
  const [scheduleRows, setScheduleRows] = useState<ScheduleRowForm[]>(() =>
    (editing?.installments ?? []).map((r) => ({
      key: uuid(),
      label: r.label,
      kind: r.amountKind,
      valueInput: String(r.amountValue),
      trigger: r.triggerKind,
      dueDate: r.dueDate ?? '',
      isDeposit: r.isDeposit,
    })),
  );
  const [scheduleOpen, setScheduleOpen] = useState<boolean>(() => (editing?.installments ?? []).length > 0);
  // Auto-seed bookkeeping (2026-08-18): the first hand edit to any schedule
  // row ends auto behavior for the session, and Remove schedule is remembered
  // so the seed never fights the rep inside one sitting.
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [scheduleRemoved, setScheduleRemoved] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [savedOffline, setSavedOffline] = useState(false);
  // Autosave (prompt 87 Task D). lastSavedAt feeds the "All changes saved
  // HH:MM" status line; autosaveHold names why the timer is deliberately NOT
  // saving ('confirm' = a below-floor save needs the human's OK, 'offline' =
  // an already-synced estimate cannot rewrite its child rows without a
  // connection). Both clear on the next successful save.
  const [lastSavedAt, setLastSavedAt] = useState('');
  const [autosaveHold, setAutosaveHold] = useState<'' | 'confirm' | 'offline'>('');
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

  // The pricable CALCULATOR areas, in form order, each with its own system.
  // Custom lines (isCustom) never enter the engine: their price is typed.
  // engineAreas derives from this ONE filtered list so pricing.lines stays
  // index-aligned with it.
  const pricedAreas = useMemo(() => areas.filter((a) => !a.isCustom && Number(a.sqft) > 0 && a.systemTypeId), [areas]);
  // Every SAVEABLE line in form order: calculator areas that price, plus every
  // custom line. The save's areaInputs and the line items both walk this list,
  // so line items bind to areas by position across both kinds.
  const lineForms = useMemo(
    () => areas
      .map((a, formIdx) => ({ a, formIdx }))
      .filter(({ a }) => (a.isCustom ? true : Number(a.sqft) > 0 && !!a.systemTypeId)),
    [areas],
  );

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
    const calcCount = lineForms.filter(({ a }) => !a.isCustom).length;
    lineForms.forEach(({ a }, i) => {
      // Optional lines carry the SAME "(optional)" head convention the
      // add-on sections already use (prompt 72 Part G): one phrasing, so the
      // signed document says which parts were optional.
      const optTag = a.optional ? ' (optional)' : '';
      if (a.isCustom) {
        // A custom line's typed scope is used VERBATIM (prompt 69, Part E):
        // the scope writer never rewrites it, and neither does this preview.
        const label = (a.name.trim() || customLabelDefault) + optTag;
        const body = a.customScope.trim();
        sections.push(body ? `## ${label}\n\n${body}` : `## ${label}`);
        return;
      }
      const sys = systemTypes.find((s) => s.id === a.systemTypeId);
      if (!sys) return;
      const isMvbOnly = sys.name === MVB_ONLY_SYSTEM_NAME;
      const name = a.name || `Area ${i + 1}`;
      const label = (calcCount > 1 ? `${name}: ${sys.name}` : isMvbOnly ? sys.name : `${sys.name} floor coating system`) + optTag;
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
  }, [isCustom, lineForms, customLabelDefault, systemTypes, scopeAnswers, addonForms, addonCatalog]);

  const scopeEditedAny = dbScopeEdited;
  // The assembled document (server-written, or DB-edited via the old flow),
  // else the live local preview. The whole-document textarea is GONE (prompt
  // 76 Part D); this now only feeds the crew-notes generator's source text.
  const scopeDisplay = scopeGenerated || scopeEditedAny ? scopeText : localScopePreview;

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
        // Even a nothing-to-generate run knows WHY each line was skipped
        // (Part B3): an all-templateless estimate should still tell the rep,
        // per line, to type the scope.
        try {
          const aRes = await supabase.from('estimate_areas').select('id,sort_order').eq('estimate_id', estimateId);
          if (!aRes.error) {
            const sortToFormIdx = lastSaveFormIdxBySortRef.current;
            const formIdxByAreaId = new Map<string, number>();
            for (const ar of (aRes.data ?? []) as Array<{ id: string; sort_order: number | null }>) {
              const formIdx = sortToFormIdx[Number(ar.sort_order) || 0];
              if (formIdx != null) formIdxByAreaId.set(ar.id, formIdx);
            }
            const reasons: Record<number, string> = {};
            for (const s of (Array.isArray(out.skipped) ? out.skipped : []) as Array<{ area_id?: string | null; reason?: string; needs_rep_text?: boolean }>) {
              if (!s || s.needs_rep_text !== true || !s.area_id) continue;
              const formIdx = formIdxByAreaId.get(s.area_id);
              if (formIdx != null) reasons[formIdx] = String(s.reason || 'No scope template for this line.');
            }
            setSkipReasonByIdx(reasons);
          }
        } catch { /* best-effort */ }
        return false;
      }
      setScopeText(String(out.scope_of_work ?? ''));
      setScopeGenerated(true);
      setDbScopeEdited(false); // a successful write clears scope_edited_at server-side
      setScopeStale(false);
      // Prompt 74: pull the freshly written per-line descriptions back into
      // form state so the NEXT save preserves them (the save never authors a
      // description now; without this refresh, a save-after-generate in the
      // same session would null them and the send gate would block).
      // Prompt 76 Part A3: a line whose description the rep edited THIS
      // SESSION (lineDescEditedRef) is skipped, so a generation triggered
      // elsewhere (the auto-first save) can never silently replace typed
      // text in the form; the rep's words win on the next save.
      // Best-effort: a miss here is healed by reopening the estimate, which
      // round-trips descriptions through estimateLoad.
      try {
        const [aRes, lRes] = await Promise.all([
          supabase.from('estimate_areas').select('id,sort_order,is_custom').eq('estimate_id', estimateId),
          supabase.from('estimate_line_items').select('estimate_area_id,addon_id,label,description,sort_order').eq('estimate_id', estimateId).order('sort_order', { ascending: true }),
        ]);
        if (!aRes.error && !lRes.error) {
          type LiRow = { estimate_area_id: string | null; addon_id: string | null; label: string | null; description: string | null; sort_order: number | null };
          const liRows = (lRes.data ?? []) as LiRow[];
          const descByAreaId = new Map<string, string>();
          for (const li of liRows) {
            if (li.estimate_area_id && li.description != null && !descByAreaId.has(li.estimate_area_id)) {
              descByAreaId.set(li.estimate_area_id, String(li.description));
            }
          }
          const sortToFormIdx = lastSaveFormIdxBySortRef.current;
          const formIdxByAreaId = new Map<string, number>();
          const patches = new Map<number, string>();
          for (const ar of (aRes.data ?? []) as Array<{ id: string; sort_order: number | null; is_custom: boolean | null }>) {
            const formIdx = sortToFormIdx[Number(ar.sort_order) || 0];
            if (formIdx != null) formIdxByAreaId.set(ar.id, formIdx);
            if (ar.is_custom === true) continue;
            const desc = descByAreaId.get(ar.id);
            if (formIdx != null && desc != null && !lineDescEditedRef.current.has(formIdx)) patches.set(formIdx, desc);
          }
          if (patches.size) {
            setAreas((prev) => prev.map((a, i) => (patches.has(i) ? { ...a, lineDescription: patches.get(i) as string } : a)));
          }
          // Add-on lines refresh the same way: the writer fills snippet-bearing
          // add-on descriptions server-side, and without this the next save
          // would write the stale form value back over them. Saved add-on
          // lines are the area-less rows minus the custom-mode composed line,
          // in the same order the save appended them from addonForms.
          const addonRows = liRows.filter((li) => li.estimate_area_id == null && String(li.label || '') !== CUSTOM_LINE_LABEL);
          setAddonForms((prev) => {
            if (addonRows.length !== prev.length) return prev; // shape moved under us: reopen heals
            let changed = false;
            const next = prev.map((f, i) => {
              const desc = addonRows[i].description;
              if (desc == null || addonDescEditedRef.current.has(f.key) || f.description === String(desc)) return f;
              changed = true;
              return { ...f, description: String(desc) };
            });
            return changed ? next : prev;
          });
          // Part B3: surface per-line skip reasons ("no scope template on
          // system X") so the sheet can tell the rep to type the scope.
          const reasons: Record<number, string> = {};
          for (const s of (Array.isArray(out.skipped) ? out.skipped : []) as Array<{ area_id?: string | null; reason?: string; needs_rep_text?: boolean }>) {
            if (!s || s.needs_rep_text !== true || !s.area_id) continue;
            const formIdx = formIdxByAreaId.get(s.area_id);
            if (formIdx != null) reasons[formIdx] = String(s.reason || 'No scope template for this line.');
          }
          setSkipReasonByIdx(reasons);
        }
      } catch { /* best-effort, see above */ }
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

  const pricing: PerLinePricingResult | null = useMemo(() => {
    // Custom mode: the engine is fully dormant. Everything downstream of
    // `pricing` (hasPrice, finalSell, GP, the AI read) branches off this one
    // null instead of each guarding isCustom separately.
    if (isCustom) return null;
    if (!salesperson || !engineAreas.length) return null;
    if (mvbMissing) return null; // surfaced below
    // Per-line solve (prompt 69): ONE estimate-wide kit-merged material plan,
    // attributed back to areas, each area solved at its OWN system's rates.
    // The job price is the SUM of the line prices; pricing.lines carries them.
    return computePerLinePricing({
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
    } as Parameters<typeof computePerLinePricing>[0]);
  }, [isCustom, engineAreas, salesperson, productsById, recipeSlotsBySystemType, systemTypes, config, mvbProduct, mvbMissing]);

  const err = pricing?.error ?? null;
  const hasPrice = !!pricing && !err && pricing.price != null;
  const engineLines: PricedLine[] = useMemo(
    () => (hasPrice && pricing && pricing.lines ? pricing.lines : []),
    [hasPrice, pricing],
  );

  // ---- Per-line rows (prompt 69) -------------------------------------------
  // ONE ordered list of the estimate's lines: calculator areas carry the
  // engine's solved calc price plus an optional per-line typed override;
  // custom lines carry their typed price. `current` is what the job base sums.
  type LineRow = {
    formIdx: number; // index into areas[]
    kind: 'calc' | 'custom';
    label: string;
    line: PricedLine | null;
    calcPrice: number | null;
    override: number | null;
    current: number | null;
  };
  const lineRows: LineRow[] = useMemo(() => {
    let calcIdx = 0;
    return lineForms.map(({ a, formIdx }) => {
      if (a.isCustom) {
        const p = Number(a.priceInput);
        const typed = Number.isFinite(p) && p > 0 ? r2(p) : null;
        return { formIdx, kind: 'custom' as const, label: a.name.trim() || customLabelDefault, line: null, calcPrice: null, override: typed, current: typed };
      }
      const line = engineLines[calcIdx] ?? null;
      calcIdx++;
      const ov = Number(a.priceInput);
      const override = a.priceInput.trim() !== '' && Number.isFinite(ov) && ov > 0 ? r2(ov) : null;
      return { formIdx, kind: 'calc' as const, label: a.name || 'Area', line, calcPrice: line ? line.price : null, override, current: override ?? (line ? line.price : null) };
    });
  }, [lineForms, engineLines, customLabelDefault]);
  const customLineRows = useMemo(() => lineRows.filter((r) => r.kind === 'custom'), [lineRows]);
  // A custom line missing its typed price blocks pricing the job (its share
  // of the total would be a guess). Engine errors already null the calc rows.
  const customLineUnpriced = customLineRows.some((r) => r.current == null);
  const calcLineCount = lineRows.filter((r) => r.kind === 'calc').length;
  // The engine is legitimately dormant when there is nothing for it to price
  // (prompt 82): an estimate whose lines are all custom is not broken, and
  // conflating "the engine produced nothing" with "the estimate has no price"
  // is what made Ron's custom-line-only estimate unsaveable.
  const engineDormant = !isCustom && calcLineCount === 0;
  // The engine price is required only when a calculator line exists; a
  // custom-line-only estimate with a typed price is ready (lineRowsReady in
  // production/calculator.js, where the fixture test drives it).
  const linesReady = lineRowsReady(lineRows, hasPrice);

  // The system-portion BASE price: the sum of the lines' current prices
  // (per-line overrides applied). The job-level sell/discount operates on it.
  const basePrice = linesReady ? r2(lineRows.reduce((s, r) => s + (r.current ?? 0), 0)) : null;
  // The CALCULATED system total, the reason rule's baseline: each calc line's
  // solved price (ignoring per-line edits) plus each custom line's typed
  // price. A rep must not route around the audit trail by editing lines
  // instead of using the discount box, so the shortfall compares against
  // THIS, not against basePrice.
  const calcTotal = linesReady ? r2(lineRows.reduce((s, r) => s + (r.kind === 'calc' ? (r.calcPrice ?? 0) : (r.current ?? 0)), 0)) : null;

  // ---- Sell price / discount (decision 9: nothing is blocked, GP goes red) --
  const [sellInput, setSellInput] = useState('');
  const [discInput, setDiscInput] = useState('');
  const [priceOverride, setPriceOverride] = useState<null | 'sell' | 'disc'>(null);
  // Build 17: overriding the total sell price requires a reason (the paper
  // trail for who is discounting and why). Prefilled from a reopened override.
  const [overrideReason, setOverrideReason] = useState<string>(() => editing?.priceOverrideReason ?? '');

  // A structural change to the price (system, sqft, MVB, products, a per-line
  // edit) resets any manual override: the old discount was negotiated against
  // the old number.
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

  // Each line's FINAL amount: the current prices as-is, or, when the rep set
  // a job-level sell/discount, the typed total allocated across the lines
  // proportionally to their current prices. allocateProportionally makes the
  // parts sum to the typed number exactly (the last line absorbs the cent).
  const finalLineAmounts: number[] | null = useMemo(() => {
    if (basePrice == null || finalSell == null) return null;
    const currents = lineRows.map((r) => r.current ?? 0);
    if (Math.abs(finalSell - basePrice) < 0.005) return currents;
    return allocateProportionally(finalSell, currents);
  }, [basePrice, finalSell, lineRows]);

  // Per-line money at the FINAL amounts, GP included, decision 4: per-line
  // pricing without per-line GP lets a rep discount a line into the negative
  // and never see it. Calc lines rescale labor/commission/sundries at the new
  // price over their fixed attributed materials; custom lines keep their
  // typed cost basis (material cost + hours x rate).
  const lineMoney: (LineSellResult | CustomLineMoney)[] | null = useMemo(() => {
    if (!finalLineAmounts) return null;
    return lineRows.map((r, k) => {
      const amt = finalLineAmounts[k];
      if (r.kind === 'calc' && r.line) {
        return applyLineSellPrice(r.line, amt, { commissionPct: config.standardCommissionPct, sundriesPct: config.sundriesPct, laborRate: config.laborRate });
      }
      const a = areas[r.formIdx];
      return customLinePricing({
        price: amt,
        materialCost: Number(a.customMaterialCost) || 0,
        laborHours: Number(a.customLaborHours) || 0,
        laborRate: config.laborRate,
        commissionPct: config.standardCommissionPct,
        sundriesPct: config.sundriesPct,
      });
    });
  }, [lineRows, finalLineAmounts, areas, config.standardCommissionPct, config.sundriesPct, config.laborRate]);

  // System-portion money = SUM of the line buckets (the job total is the sum
  // of the lines, decision 2; there is no second job-level solve).
  const adjusted = useMemo(() => {
    if (!lineMoney || finalSell == null || basePrice == null) return null;
    const sum = (pick: (m: LineSellResult | CustomLineMoney) => number | null) =>
      r2(lineMoney.reduce((s, m) => s + (Number(pick(m)) || 0), 0));
    const laborDollars = sum((m) => m.laborDollars);
    const commissionDollars = sum((m) => m.commissionDollars);
    const sundriesDollars = sum((m) => m.sundriesDollars);
    const gpDollars = sum((m) => m.gpDollars);
    const hoursSum = r2(lineMoney.reduce((s, m) => s + (Number(m.budgetedHours) || 0), 0));
    const budgetedHours = hoursSum > 0 ? hoursSum : null;
    return {
      sellPrice: finalSell,
      discountPct: basePrice > 0 ? r2((1 - finalSell / basePrice) * 100) : null,
      laborDollars,
      commissionDollars,
      sundriesDollars,
      gpDollars,
      gpPct: finalSell > 0 ? gpDollars / finalSell : null,
      budgetedHours,
      gpPerHour: budgetedHours != null ? r2(gpDollars / budgetedHours) : null,
    };
  }, [lineMoney, finalSell, basePrice]);
  const discounted = basePrice != null && finalSell != null && Math.abs(finalSell - basePrice) >= 0.5;
  // Any route below the calculated total counts toward the reason rule: a
  // per-line edit, the job discount, or both (they all land in finalSell vs
  // calcTotal). The threshold keeps a rounding nudge from nagging: a reason
  // is demanded only when the shortfall exceeds the GREATER of the pct and
  // dollar thresholds, measured on the WHOLE estimate.
  const shortfall = calcTotal != null && finalSell != null ? r2(calcTotal - finalSell) : 0;
  const reasonThreshold = Math.max(
    (calcTotal ?? 0) * ((Number(config.linePricingReasonThresholdPct ?? 2) || 0) / 100),
    Number(config.linePricingReasonThresholdDollars ?? 100) || 0,
  );
  const reasonRequired = shortfall > reasonThreshold + 1e-9;
  const anyLineEdited = lineRows.some((r) => r.kind === 'calc' && r.override != null && r.calcPrice != null && Math.abs(r.override - r.calcPrice) >= 0.5);
  const priceMoved = discounted || anyLineEdited;

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

  // ---- Optional-lines money (prompt 72) ------------------------------------
  // ONE shaped list (area/custom lines at their FINAL amounts with the rep's
  // optional/preselected flags, then add-ons which stay opt-in/unselected)
  // feeds three totals with three DIFFERENT meanings:
  //   required-only = the guaranteed floor (estimates.price while open),
  //   all-in        = every line at full value (estimates.price_all_options),
  //   opening       = required + pre-selected optional = the HEADLINE number,
  //                   because it is exactly what the customer sees when the
  //                   public page opens (and what the send email quotes).
  // Pre-72 estimates (nothing optional): opening equals today's total and
  // every GP number lands where it always has.
  const shapedLines = useMemo(() => {
    const commFrac = config.standardCommissionPct / 100;
    const rows = lineRows.map((r, k) => {
      const a = areas[r.formIdx];
      const m = lineMoney ? lineMoney[k] : null;
      return {
        total: finalLineAmounts ? finalLineAmounts[k] : (r.current ?? 0),
        is_optional: a.optional === true,
        selected_by_customer: a.optional !== true || a.preselected !== false,
        gp: m && m.gpDollars != null ? Number(m.gpDollars) : 0,
        laborDollars: m && m.laborDollars != null ? Number(m.laborDollars) : 0,
        commissionDollars: m && m.commissionDollars != null ? Number(m.commissionDollars) : 0,
        budgetedHours: m && m.budgetedHours != null ? Number(m.budgetedHours) : 0,
      };
    });
    const addons = addonMoneyItems.map((li) => ({
      total: li.total,
      is_optional: li.is_optional,
      selected_by_customer: li.selected_by_customer === true,
      gp: li.total - li.qty * li.unit_cost - commFrac * li.total,
      laborDollars: 0,
      commissionDollars: commFrac * li.total,
      budgetedHours: 0,
    }));
    return [...rows, ...addons];
  }, [lineRows, areas, lineMoney, finalLineAmounts, addonMoneyItems, config.standardCommissionPct]);
  const lineTotalsSplit = useMemo(() => splitLineTotals(shapedLines), [shapedLines]);
  const hasOptionalLines = useMemo(() => shapedLines.some((l) => l.is_optional), [shapedLines]);
  const moneyOver = useCallback((pred: (l: (typeof shapedLines)[number]) => boolean) => {
    const set = shapedLines.filter(pred);
    const gp = r2(set.reduce((s, l) => s + l.gp, 0));
    const labor = r2(set.reduce((s, l) => s + l.laborDollars, 0));
    const comm = r2(set.reduce((s, l) => s + l.commissionDollars, 0));
    const hours = r2(set.reduce((s, l) => s + l.budgetedHours, 0));
    return { gp, labor, comm, hours: hours > 0 ? hours : null };
  }, [shapedLines]);
  const openingMoney = useMemo(() => moneyOver((l) => !l.is_optional || l.selected_by_customer), [moneyOver]);
  const requiredMoney = useMemo(() => moneyOver((l) => !l.is_optional), [moneyOver]);
  const moneyReady = !isCustom && linesReady && adjusted != null;

  const totalPrice = isCustom
    ? (sellPrice != null ? r2(sellPrice + addonsBaseTotal) : null)
    : (moneyReady ? lineTotalsSplit.opening : null);
  const totalAllOptions = isCustom
    ? (sellPrice != null ? r2(sellPrice + addonsAllTotal) : null)
    : (moneyReady ? lineTotalsSplit.allIn : null);
  const requiredOnlyTotal = moneyReady ? lineTotalsSplit.requiredOnly : null;
  const requiredGpPct = requiredOnlyTotal != null && requiredOnlyTotal > 0 ? requiredMoney.gp / requiredOnlyTotal : null;
  // Decision 8: warn (never block) when the required-only GP lands under the
  // optional-lines threshold. Only meaningful once something IS optional.
  const optionalGpWarn = hasOptionalLines && requiredGpPct != null &&
    requiredGpPct * 100 < (Number(config.optionalLinesGpWarnPct ?? config.linePricingGpFloorPct ?? 40) - 0.05);

  // Custom mode: commission is well-defined (standard pct of the total), but
  // GP is NOT (there is no cost basis for the custom work), so GP shows as
  // not-applicable instead of a made-up number, and never blocks the save.
  const customCommission = isCustom && totalPrice != null ? r2((config.standardCommissionPct / 100) * totalPrice) : null;
  const combinedGpDollars = moneyReady ? openingMoney.gp : null;
  const combinedGpPct = combinedGpDollars != null && totalPrice != null && totalPrice > 0 ? combinedGpDollars / totalPrice : null;
  const combinedCommission = moneyReady ? openingMoney.comm : null;
  const combinedGpPerHour = combinedGpDollars != null && openingMoney.hours != null && openingMoney.hours > 0
    ? r2(combinedGpDollars / openingMoney.hours)
    : null;

  // GP threshold: the sqft-weighted target across the areas' systems (the
  // engine computes it; a naive mean would let a small high-target area drag
  // the warning). Falls back to the config default before pricing exists.
  const targetGpPctResolved = pricing && !err && pricing.targetGpPct != null
    ? Number(pricing.targetGpPct)
    : (dominantSystem?.target_gp_pct != null ? Number(dominantSystem.target_gp_pct) : config.targetGpPct);
  const gpBelowTarget =
    combinedGpPct != null && combinedGpPct * 100 < targetGpPctResolved - 0.05;

  // ---- Payment schedule derived values (prompt 74) --------------------------
  // Validated against the customer's OPENING total (totalPrice: required +
  // pre-selected), the number the page shows when the link opens. Percent
  // rows recompute live on the customer page as options are ticked, so a
  // percent-complete schedule stays exact for every selection.
  const scheduleEnabled = config.estimateScheduleEnabled !== false;
  const scheduleShared = useMemo(() => scheduleRows.map((r, i) => ({
    seq: i,
    label: r.label.trim() || (r.isDeposit ? 'Deposit' : 'Installment'),
    amount_kind: r.kind,
    amount_value: Number(r.valueInput) || 0,
    trigger_kind: r.trigger,
    due_date: r.trigger === 'date' && r.dueDate ? r.dueDate : null,
    is_deposit: r.isDeposit,
  })), [scheduleRows]);
  const scheduleTotalCents = totalPrice != null ? Math.round(totalPrice * 100) : null;
  const scheduleError = useMemo(
    () => (scheduleRows.length && scheduleTotalCents != null ? scheduleValidationError(scheduleShared, scheduleTotalCents) : null),
    [scheduleRows.length, scheduleShared, scheduleTotalCents],
  );
  const scheduleCents: number[] | null = useMemo(
    () => (scheduleRows.length && scheduleTotalCents != null && !scheduleError ? computeScheduleCents(scheduleShared, scheduleTotalCents) : null),
    [scheduleRows.length, scheduleShared, scheduleTotalCents, scheduleError],
  );
  // Seed on FIRST OPEN of the editor, never on estimate create (a draft with
  // no schedule keeps behaving exactly as today). Deposit percent resolution
  // is the shared resolveDepositPct: dominant system's deposit_pct, else the
  // company default_deposit_pct, else 50 (same rule prepareDepositInstallment
  // applies on the job side).
  const seedSchedule = useCallback(() => {
    const pctResolved = resolveDepositPct(dominantSystem?.deposit_pct, config.defaultDepositPct);
    setScheduleRows(defaultScheduleRows(pctResolved).map((r: { label: string; amount_kind: 'fixed' | 'percent'; amount_value: number; trigger_kind: string; is_deposit: boolean }) => ({
      key: uuid(),
      label: r.label,
      kind: r.amount_kind,
      valueInput: String(r.amount_value),
      trigger: r.trigger_kind,
      dueDate: '',
      isDeposit: r.is_deposit,
    })));
    setSaveState('idle');
  }, [dominantSystem, config.defaultDepositPct]);
  const openScheduleEditor = useCallback(() => {
    setScheduleOpen(true);
    if (!scheduleRows.length) seedSchedule();
  }, [scheduleRows.length, seedSchedule]);
  const setScheduleRow = (key: string, patch: Partial<ScheduleRowForm>) => {
    setScheduleRows((prev) => prev.map((r) => {
      if (r.key !== key) return patch.isDeposit === true ? { ...r, isDeposit: false } : r; // one deposit max
      return { ...r, ...patch };
    }));
    setScheduleTouched(true);
    setSaveState('idle');
  };
  const addScheduleRow = () => {
    setScheduleRows((prev) => [...prev, { key: uuid(), label: '', kind: 'percent', valueInput: '', trigger: 'on_completion', dueDate: '', isDeposit: false }]);
    setScheduleTouched(true);
    setSaveState('idle');
  };
  const removeScheduleRow = (key: string) => {
    setScheduleRows((prev) => prev.filter((r) => r.key !== key));
    setScheduleTouched(true);
    setSaveState('idle');
  };

  // Auto-seed (2026-08-18, widened 2026-08-13): every NEW estimate starts
  // with the default schedule, so the customer proposal always shows a
  // payment plan (Dylan's locked decision; the seeded shape is deposit
  // percent + remaining balance at completion, which passes the send gate by
  // construction). The original `editing` bail made this dead code on the
  // normal path: since prompt 61 the dashboard pre-inserts the draft row and
  // mounts the estimator with ?estimate_id=, so editing is non-null for
  // essentially every real estimate and nothing ever seeded. The seed now
  // also applies to a loaded UNSENT DRAFT with zero saved installments (a
  // pre-minted draft never had a schedule to remove); a sent/signed estimate
  // or one carrying saved rows keeps the original never-auto-seed contract.
  // While untouched, a dominant-system change re-seeds so that system's own
  // deposit_pct is honored; the first hand edit or Remove schedule ends all
  // auto behavior for this session.
  const scheduleAutoseedOn = scheduleEnabled && config.estimateScheduleAutoseed !== false;
  const hasOpeningTotal = totalPrice != null && totalPrice > 0;
  const seedableEstimate = !editing
    || (editing.status === 'draft' && editing.sentAt == null && (editing.installments ?? []).length === 0);
  useEffect(() => {
    if (!seedableEstimate || !scheduleAutoseedOn || scheduleTouched || scheduleRemoved || !hasOpeningTotal) return;
    seedSchedule();
    setScheduleOpen(true);
  }, [seedableEstimate, scheduleAutoseedOn, scheduleTouched, scheduleRemoved, hasOpeningTotal, seedSchedule]);

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
  // Heuristic since per-line rounding (prompt 69): compares the summed raw
  // price plain-rounded against the summed charm-rounded line prices.
  const charmFired = pricing && !err && pricing.priceRaw != null && pricing.price != null &&
    roundEstimatePrice(pricing.priceRaw, { increment: config.priceIncrement, charmThreshold: 0, charmBand: 0 }) !== pricing.price;
  // Floor GP: below it a save asks a hard confirm (warns, does not block).
  const belowFloor = combinedGpPct != null && combinedGpPct * 100 < config.floorGpPct - 0.05;
  // Per-LINE floor (prompt 69): a line under it goes red; whether it also
  // forces the save confirmation is the line_pricing_block_below_floor knob.
  // Tolerates a pre-69 cached catalog (keys absent) by falling back to the
  // estimate-wide floor.
  const lineFloorPct = Number(config.linePricingGpFloorPct ?? config.floorGpPct) || config.floorGpPct;
  const belowFloorLines = useMemo(() => {
    if (!lineMoney) return [] as Array<{ label: string; gpPct: number }>;
    return lineRows
      .map((r, k) => ({ label: r.label, gpPct: lineMoney[k].gpPct }))
      .filter((x): x is { label: string; gpPct: number } => x.gpPct != null && x.gpPct * 100 < lineFloorPct - 0.05);
  }, [lineRows, lineMoney, lineFloorPct]);
  // Typed material cost across the custom lines, shown with the engine's
  // materials number so the cost stack covers the whole estimate.
  const customMaterialsTotal = useMemo(
    () => r2(customLineRows.reduce((s, r) => s + (Number(areas[r.formIdx].customMaterialCost) || 0), 0)),
    [customLineRows, areas],
  );

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

  // Comps key off the DOMINANT system. Since prompt 87 nothing here renders
  // them; they feed the per-line AI inputs and the pricing_snapshot write,
  // which the estimate detail page renders.
  const comps: CompsResult | null = useMemo(() => {
    if (!compCandidates || !dominantSystemId || !(totalSqft > 0)) return null;
    return buildComps({ candidates: compCandidates, systemTypeId: dominantSystemId, sqft: totalSqft, now: new Date(), minSample: config.compsMinSample });
  }, [compCandidates, dominantSystemId, totalSqft, config.compsMinSample]);
  const compsLabel = comps ? compsRuleLabel(comps, dominantSystem?.name ?? null) : '';
  const compsCaveat = comps ? compsGpCaveat(comps) : null;

  // ---- AI recommendation: automatic once system + sqft are present ---------
  // PER-LINE since prompt 70: one debounced call sends every line with ITS
  // OWN hard-filtered comps and gets back one recommendation per line plus a
  // job roll-up. The inputs key is the join of per-line keys (ai-lines.cjs),
  // so a sqft edit, an mvb toggle, a custom price change, or a custom scope
  // edit each re-key exactly once; the cached read on a reopened estimate's
  // row still short-circuits the call entirely.
  const aiLines: AiLineInput[] = useMemo(() => {
    return lineRows.map((r, k) => {
      const a = areas[r.formIdx];
      if (r.kind === 'custom') {
        return {
          line_key: `L${k}`,
          kind: 'custom' as const,
          label: r.label,
          sqft: Number(a.sqft) > 0 ? Number(a.sqft) : null,
          calc_price: r.current ?? 0,
          scope_text: a.customScope.trim() || null,
          comps: null,
        };
      }
      const sys = systemTypes.find((s) => s.id === a.systemTypeId);
      // This LINE's comps: its own system (hard filter), its own sqft.
      const lc = compCandidates && Number(a.sqft) > 0
        ? buildComps({ candidates: compCandidates, systemTypeId: a.systemTypeId, sqft: Number(a.sqft), now: new Date(), minSample: config.compsMinSample })
        : null;
      return {
        line_key: `L${k}`,
        kind: 'calc' as const,
        label: r.label,
        system_type_id: a.systemTypeId,
        system_type_name: sys?.name ?? 'Unknown system',
        sqft: Number(a.sqft) > 0 ? Number(a.sqft) : null,
        mvb: a.mvb === true,
        calc_price: r.calcPrice ?? 0,
        target_gp_pct: r.line?.targetGpPct ?? null,
        comps: lc ? compsForAi(lc, compsRuleLabel(lc, sys?.name ?? null)) : null,
      };
    });
  }, [lineRows, areas, systemTypes, compCandidates, config.compsMinSample]);
  const inputsKey = useMemo(() => linesInputsKey(aiLines), [aiLines]);
  const [ai, setAi] = useState<{ key: string; status: 'loading' | 'ready' | 'error' | 'disabled'; rec?: AiRecommendation; err?: string } | null>(null);
  const editingSnapshot = editing?.pricingSnapshot ?? null;
  const aiLeadId = editing?.leadId ?? leadLink?.id ?? null;

  useEffect(() => {
    if (config.estimateAiEnabled === false) return; // Settings kill switch; the panel says so
    if (!hasPrice || !(totalSqft > 0) || !dominantSystemId || basePrice == null || !linesReady) return;
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
        const rec = await fetchAiRecommendation({
          estimate_id: editing?.id ?? null,
          lead_id: aiLeadId,
          inputs_key: inputsKey,
          lines: aiLines,
          sqft: totalSqft,
          calc_price: calcTotal ?? basePrice,
        });
        setAi((cur) => (cur && cur.key === inputsKey
          ? (rec ? { key: inputsKey, status: 'ready', rec } : { key: inputsKey, status: 'disabled' })
          : cur));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setAi((cur) => (cur && cur.key === inputsKey ? { key: inputsKey, status: 'error', err: msg } : cur));
      }
    }, 900);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsKey, hasPrice, linesReady, online, compCandidates, compsFailed, basePrice]);

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
          // Prompt 94 B4: gated with every other generate entry point.
          if (generateOn) generateScope(id, false);
        }
      })
      .catch(() => {});
  }, [online, refreshPending, generateScope, generateOn]);
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
    // Prompt 87 Task D: no more hollow-shell drafts. Nothing is written until
    // the estimate is REAL: a customer (checked by draftReady below) AND at
    // least one line with content. The auto-seeded Main area does not count
    // (every new estimate has it); an area with square footage, any custom
    // line, or (custom mode) a typed price or scope does.
    const hasContent = isCustom
      ? (customPrice != null || customScope.trim().length > 0)
      : areas.some((a) => a.isCustom || Number(a.sqft) > 0);
    if (!hasContent) {
      draftTrigger.reset();
      return;
    }
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
        clientNotes,
        companyNotes,
      });
      if (navigator.onLine) drainOutbox().then(refreshPending).catch(() => {});
      else void refreshPending();
    } catch {
      draftTrigger.reset();
      draftWriteRef.current = false;
    }
  }, [savedEstimateId, editing, salesperson, customer, intake, scopeAnswers, createdBy, linkedLead, leadLink, isCustom, customScope, customPrice, customSqft, areas, crewNotes, clientNotes, companyNotes, draftId, draftTrigger, refreshPending]);
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
  // Adding a line OPENS its sheet (prompt 76 Part C): the table row carries
  // no inline inputs anymore, so the add flow is tap-add, edit in the sheet.
  const addArea = () => {
    const newIdx = areas.length;
    setAreas((prev) => {
      // New areas inherit the previous CALCULATOR area's system (a second
      // garage bay is likelier than a system switch; one tap changes it
      // either way). Custom lines carry no system, so they are skipped.
      const lastCalc = [...prev].reverse().find((a) => !a.isCustom);
      const sysId = lastCalc?.systemTypeId ?? fallbackSystemId;
      // Prompt 94 B1: born with the system's template in the description.
      return [...prev, { name: `Area ${prev.length + 1}`, sqft: '', systemTypeId: sysId, mvb: false, slotValues: defaultSlotValues(sysId), ...emptyLineFields, lineDescription: (templateAutoFillOk && sysId ? templateForSystem(sysId, false) : null) ?? '' }];
    });
    setSheetFocusDesc(false);
    setOpenLine({ kind: 'area', idx: newIdx });
  };
  // A custom LINE on a normal estimate (prompt 69, decision 1): a typed
  // one-off scope with its own price, cost, and hours, riding the same
  // area-row pipeline. No system, no recipe, no catalog products.
  const addCustomLine = () => {
    const newIdx = areas.length;
    setAreas((prev) => [...prev, {
      name: customLabelDefault, sqft: '', systemTypeId: '', mvb: false, slotValues: {},
      ...emptyLineFields, isCustom: true,
    }]);
    setSheetFocusDesc(false);
    setOpenLine({ kind: 'area', idx: newIdx });
  };
  const removeArea = (i: number) => {
    setAreas((prev) => prev.filter((_, idx) => idx !== i));
    // Indexes shift on removal: drop every index-keyed per-line state rather
    // than let an undo, an edited flag, or a skip reason land on the wrong
    // line. The next generation rebuilds the skip reasons.
    setLinePrePolish({});
    setLinePolishError({});
    lineDescEditedRef.current.clear();
    setSkipReasonByIdx({});
    setOpenLine((cur) => (cur && cur.kind === 'area' ? null : cur));
  };

  const onAreaSystemChange = (i: number, sysId: string) => {
    // New system, new slot set: re-seed THIS area with the new defaults.
    // Prompt 94 B1: the new system's template follows the pick. Machine text
    // (empty, sqft junk, or an untouched template) is replaced silently; the
    // rep's own words are only replaced after an explicit confirm whose
    // default (Cancel) KEEPS them. The system itself changes either way.
    // Nothing auto-fills on a sent estimate.
    const a = areas[i];
    const patch: Partial<AreaForm> = { systemTypeId: sysId, slotValues: defaultSlotValues(sysId) };
    if (a && !a.isCustom && templateAutoFillOk) {
      const tpl = templateForSystem(sysId, a.mvb);
      if (isMachineDesc(a.lineDescription)) {
        // Replacing one system's untouched template with another's; when the
        // new system has NO template the stale one is cleared, because a
        // Metallic write-up on a now-Quartz line is worse than the send
        // gate's "has no scope yet" block.
        patch.lineDescription = tpl ?? '';
        lineDescEditedRef.current.delete(i);
      } else if (tpl) {
        const sysName = systemTypes.find((s) => s.id === sysId)?.name ?? 'this system';
        if (window.confirm(`Replace the scope you wrote with the ${sysName} template?`)) {
          patch.lineDescription = tpl;
          lineDescEditedRef.current.delete(i);
        }
      }
    }
    setAreas((prev) => prev.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  };

  // The MVB toggle swaps between a system's standard and MVB template
  // variants, but ONLY over machine text; a rep's words survive the toggle.
  const onAreaMvbChange = (i: number, mvb: boolean) => {
    const a = areas[i];
    const patch: Partial<AreaForm> = { mvb };
    if (a && !a.isCustom && templateAutoFillOk && isMachineDesc(a.lineDescription)) {
      const tpl = templateForSystem(a.systemTypeId, mvb);
      if (tpl) {
        patch.lineDescription = tpl;
        lineDescEditedRef.current.delete(i);
      }
    }
    setAreas((prev) => prev.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
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
    const key = uuid();
    setAddonForms((prev) => [
      ...prev,
      {
        key,
        addonId: a.id,
        label: a.name,
        description: a.description ?? '',
        qty: '1',
        unitPrice: String(a.default_price ?? 0),
        unitCost: String(a.default_cost ?? 0),
        optional: a.is_optional_default,
      },
    ]);
    setSheetFocusDesc(false);
    setOpenLine({ kind: 'addon', key });
  };
  const addOneOff = () => {
    const key = uuid();
    setAddonForms((prev) => [
      ...prev,
      { key, addonId: null, label: '', description: '', qty: '1', unitPrice: '', unitCost: '', optional: false },
    ]);
    setSheetFocusDesc(false);
    setOpenLine({ kind: 'addon', key });
  };
  const setAddonForm = (key: string, patch: Partial<AddonForm>) =>
    setAddonForms((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  const removeAddonForm = (key: string) => {
    setAddonForms((prev) => prev.filter((f) => f.key !== key));
    addonDescEditedRef.current.delete(key);
    setOpenLine((cur) => (cur && cur.kind === 'addon' && cur.key === key ? null : cur));
  };

  const addonsIncomplete = addonForms.some((f) => !f.label.trim() || !(Number(f.qty) > 0) || !(Number(f.unitPrice) >= 0));
  // The reason rule (prompt 69, tightened with a threshold): a written reason
  // is required whenever the FINAL system total lands below the CALCULATED
  // total by more than the threshold, no matter how the rep got there (a
  // per-line edit, the job discount, or both). Small trims pass silently.
  const overrideNeedsReason = reasonRequired && !overrideReason.trim();
  // Identity gate (build 23): the rule itself lives in customerComplete at
  // module scope, shared with the customer lock.
  const customerIncomplete = !customerComplete(customer);
  // Locked-bar content: composed name plus whatever contact parts exist,
  // joined so empty fields drop out instead of leaving stray separators.
  const custSummaryName = composeCustomerName(customer);
  const custSummarySub = [customer.phone.trim(), customer.email.trim(), composeCustomerAddress(customer) ?? ''].filter(Boolean).join(' · ');
  // Prompt 58 Part E: soft warning only. Moisture and MOHS hardness are the
  // two site readings the crew work order really needs; an empty one warns
  // here and on the job page but never blocks save, send, or accept. The
  // other work order fields are deliberately never warned about.
  const woMissingFields = [
    !intake.moisture ? 'Moisture' : null,
    !intake.mohs_hardness ? 'MOHS hardness' : null,
  ].filter(Boolean) as string[];
  // Prompt 82: the SINGLE source of truth for "why can't I save?". Every save
  // gate lives here as one plain-English line; the Save button now renders in
  // every state and shows the first entry beside it when disabled, because a
  // silently absent (or silently disabled) Save is the bug class this kills.
  // Empty array = saveable.
  const saveBlockers: string[] = useMemo(() => {
    const list: string[] = [];
    if (!salesperson) list.push('Pick a salesperson.');
    if (customerIncomplete) {
      list.push(customer.isCommercial ? 'Enter the company name (Customer card) to save.' : 'Enter the customer’s last name (Customer card) to save.');
    }
    if (isCustom) {
      if (customPrice == null) list.push('Type the price (the Price field, custom mode has no calculator).');
    } else {
      if (mvbMissing) list.push(`The product "${MVB_PRODUCT_NAME}" is missing or inactive in the Catalog, so the moisture vapor barrier cannot be priced. Restore it or uncheck MVB on the areas.`);
      if (err) list.push(ERROR_COPY[err] ?? err);
      if (areas.length === 0) list.push('Add at least one area or custom line.');
      areas.forEach((a, i) => {
        if (a.isCustom) return;
        const label = a.name || `Area ${i + 1}`;
        if (!(Number(a.sqft) > 0)) list.push(`Enter the square footage on "${label}" (or remove that line).`);
        else if (!a.systemTypeId) list.push(`Pick a system on "${label}".`);
      });
      for (const r of lineRows) {
        if (r.kind === 'custom' && r.current == null) list.push(`Type a price on the custom line "${r.label}".`);
      }
      if (overrideNeedsReason) list.push('Type a reason for the price change.');
      // Safety net: if the chain is not ready for a reason none of the checks
      // above named, still refuse with SOMETHING rather than diverge from
      // linesReady and ship an enabled button whose save no-ops.
      if (list.length === 0 && !linesReady) list.push('The job is not priced yet.');
    }
    if (addonsIncomplete) list.push('Finish the add-on lines (each needs a label and a price).');
    return list;
  }, [salesperson, customerIncomplete, customer.isCommercial, isCustom, customPrice, mvbMissing, err, areas, lineRows, overrideNeedsReason, linesReady, addonsIncomplete]);
  const canSave = saveBlockers.length === 0 && saveState !== 'saving';

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

  // ---- Inline-embed plumbing (prompt 61 Part A) ----------------------------
  // Height posting: the dashboard hosts this app INLINE in the estimate
  // detail page now, and a fixed-height frame plus the page's own scrollbar
  // is the nested-scroll smell the inline move exists to avoid. A
  // ResizeObserver on the app root posts the content height up, throttled to
  // one message per animation frame; the parent sizes the iframe to match
  // (with its own fallback if no message ever arrives).
  useEffect(() => {
    if (!embed) return;
    const el = document.getElementById('root');
    if (!el || typeof ResizeObserver === 'undefined') return;
    document.body.classList.add('embed');
    let raf = 0;
    const post = () => {
      raf = 0;
      const px = Math.ceil(Math.max(el.scrollHeight, el.offsetHeight));
      if (px > 0) postToParent({ type: 'pec-estimator-height', px });
    };
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(post); });
    ro.observe(el);
    post();
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [embed, postToParent]);

  // Theme follows the DASHBOARD, never the OS (Part A item 9): the parent
  // posts { type: 'pec-theme', theme } on mount and on change; a light panel
  // inside a dark page (or vice versa) is the two-UIs seam at its worst.
  // Origin-checked like every message on this channel.
  useEffect(() => {
    if (!embed) return;
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const msg = ev.data as { type?: string; theme?: string } | null;
      if (!msg || msg.type !== 'pec-theme') return;
      document.documentElement.dataset.theme = msg.theme === 'dark' ? 'dark' : 'light';
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [embed]);

  // Prompt 76 Part F: a send-gate blocker link opens the offending line's
  // sheet with the description focused, addressed by the saved line item's
  // sort_order. Area/custom lines are lineForms[k] (the save writes them in
  // that order); add-on lines follow in addonForms order.
  const openLineBySortOrder = useCallback((k: number) => {
    if (!Number.isFinite(k) || k < 0) return;
    if (k < lineForms.length) {
      setSheetFocusDesc(true);
      setOpenLine({ kind: 'area', idx: lineForms[k].formIdx });
      return;
    }
    const f = addonForms[k - lineForms.length];
    if (f) { setSheetFocusDesc(true); setOpenLine({ kind: 'addon', key: f.key }); }
  }, [lineForms, addonForms]);
  // Fresh mounts arrive with ?focus_line=<sort_order>; consumed once.
  const focusLineConsumedRef = useRef(false);
  useEffect(() => {
    if (focusLine == null || focusLineConsumedRef.current) return;
    focusLineConsumedRef.current = true;
    openLineBySortOrder(focusLine);
  }, [focusLine, openLineBySortOrder]);
  // An already-mounted estimator gets the same ask by message, origin-checked
  // like everything on this channel.
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const msg = ev.data as { type?: string; sortOrder?: number } | null;
      if (!msg || msg.type !== 'pec-estimator-open-line') return;
      openLineBySortOrder(Number(msg.sortOrder));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [openLineBySortOrder]);

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

  // ---- ONE per-line AI button (prompt 76 Part E) ---------------------------
  // The separate Polish button is gone. "Generate with AI" lives in the
  // sheet's Description header and branches by context, so the rep never
  // chooses a mode:
  //   description empty + a template exists -> run the scope writer,
  //   description has text                  -> polish that text,
  //   description empty + no template       -> polish the internal notes if
  //                                            any, else ask for typed text.
  // Polish keeps its undo (the pre-polish text, per line, cleared when a
  // line is removed so it can never land on the wrong index).
  const [linePrePolish, setLinePrePolish] = useState<Record<number, { field: 'customScope' | 'lineDescription'; text: string }>>({});

  // ---- Template fill-in tokens (prompt 94 B2) ------------------------------
  // The description keeps its {{tokens}} until the rep answers them; drafts
  // of the answers live here (keyed `${lineIdx}:${tokenName}`) and COMMIT
  // (blur / Enter / a completed date pick) substitutes the value into the
  // text, after which it is ordinary text: nothing re-templatizes it, and
  // the field disappears because its token no longer exists in the text.
  const [tokenDraft, setTokenDraft] = useState<Record<string, string>>({});
  const commitLineToken = (i: number, tok: TokenField, raw: string) => {
    const v = String(raw || '').trim();
    if (!v) return;
    const value = tok.type === 'date' ? fmtTokenDate(v) : v;
    setAreas((prev) => prev.map((a, idx) => (idx === i
      ? { ...a, lineDescription: scopeApplyTokens(a.lineDescription, { [tok.name]: value }) }
      : a)));
    lineDescEditedRef.current.add(i);
    setTokenDraft((prev) => { const n = { ...prev }; delete n[`${i}:${tok.name}`]; return n; });
    setSaveState('idle');
  };
  const [linePolishBusy, setLinePolishBusy] = useState<number | null>(null);
  const [linePolishError, setLinePolishError] = useState<Record<number, string>>({});
  const [addonPrePolish, setAddonPrePolish] = useState<Record<string, string>>({});
  const [addonPolishBusy, setAddonPolishBusy] = useState<string | null>(null);
  const [addonPolishError, setAddonPolishError] = useState<Record<string, string>>({});

  // The shared polish call: POLISH, not authorship (the endpoint's contract
  // preserves meaning, exclusions, and dollar figures and invents nothing).
  const callPolish = useCallback(async (text: string): Promise<string> => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Sign in to use Generate.');
    const res = await fetch('/.netlify/functions/pec-estimate-custom-polish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.success || !out.polished) throw new Error(out.error || `Generate failed (${res.status})`);
    return String(out.polished);
  }, []);

  // regenerateScope is defined below (it needs performSave); a ref lets the
  // per-line Generate call it without a declaration-order knot.
  const regenerateScopeRef = useRef<() => Promise<void>>(async () => {});

  const generateForLine = useCallback(async (i: number) => {
    const a = areas[i];
    if (!a || linePolishBusy != null) return;
    setLinePolishError((prev) => ({ ...prev, [i]: '' }));
    const field: 'customScope' | 'lineDescription' = a.isCustom ? 'customScope' : 'lineDescription';
    const text = (a.isCustom ? a.customScope : a.lineDescription).trim();
    if (!a.isCustom && !text) {
      const sys = systemTypes.find((s) => s.id === a.systemTypeId);
      const tpl = sys ? ((a.mvb && sys.scope_template_mvb) ? sys.scope_template_mvb : sys.scope_template) : null;
      if (tpl) {
        // Empty + template: the writer fills it. Pressing Generate IS asking,
        // so this line's edited flag clears and the refresh may patch it.
        lineDescEditedRef.current.delete(i);
        await regenerateScopeRef.current();
        return;
      }
    }
    const source = text || a.notes.trim();
    if (!source) {
      setLinePolishError((prev) => ({
        ...prev,
        [i]: a.isCustom
          ? 'Type the scope first (or add internal notes for Generate to draft from).'
          : 'No scope template exists for this system, so nothing writes itself. Type the scope here (or add internal notes for Generate to draft from).',
      }));
      return;
    }
    setLinePolishBusy(i);
    try {
      const polished = await callPolish(source);
      setLinePrePolish((prev) => ({ ...prev, [i]: { field, text: a.isCustom ? a.customScope : a.lineDescription } }));
      setAreas((prev) => prev.map((x, idx) => (idx === i ? { ...x, [field]: polished } : x)));
      if (field === 'lineDescription') lineDescEditedRef.current.add(i);
      setSaveState('idle');
    } catch (e) {
      setLinePolishError((prev) => ({ ...prev, [i]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLinePolishBusy(null);
    }
  }, [areas, linePolishBusy, systemTypes, callPolish]);
  const revertLinePolish = useCallback((i: number) => {
    setLinePrePolish((prev) => {
      const undo = prev[i];
      if (undo == null) return prev;
      setAreas((cur) => cur.map((a, idx) => (idx === i ? { ...a, [undo.field]: undo.text } : a)));
      if (undo.field === 'lineDescription') lineDescEditedRef.current.add(i);
      const next = { ...prev };
      delete next[i];
      return next;
    });
    setSaveState('idle');
  }, []);

  // Add-on / one-off lines: same branches. A catalog add-on with a scope
  // snippet generates through the writer; otherwise typed text polishes.
  const generateForAddon = useCallback(async (key: string) => {
    const f = addonForms.find((x) => x.key === key);
    if (!f || addonPolishBusy != null) return;
    setAddonPolishError((prev) => ({ ...prev, [key]: '' }));
    const text = f.description.trim();
    if (!text) {
      const cat = f.addonId ? addonCatalog.find((x) => x.id === f.addonId) : null;
      if (cat && cat.scope_snippet && cat.scope_snippet.trim()) {
        addonDescEditedRef.current.delete(key);
        await regenerateScopeRef.current();
        return;
      }
      setAddonPolishError((prev) => ({ ...prev, [key]: 'Type a description first; this line has no catalog scope language to generate from.' }));
      return;
    }
    setAddonPolishBusy(key);
    try {
      const polished = await callPolish(text);
      setAddonPrePolish((prev) => ({ ...prev, [key]: f.description }));
      setAddonForms((prev) => prev.map((x) => (x.key === key ? { ...x, description: polished } : x)));
      addonDescEditedRef.current.add(key);
      setSaveState('idle');
    } catch (e) {
      setAddonPolishError((prev) => ({ ...prev, [key]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setAddonPolishBusy(null);
    }
  }, [addonForms, addonPolishBusy, addonCatalog, callPolish]);
  const revertAddonPolish = useCallback((key: string) => {
    setAddonPrePolish((prev) => {
      if (prev[key] == null) return prev;
      const text = prev[key];
      setAddonForms((cur) => cur.map((x) => (x.key === key ? { ...x, description: text } : x)));
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setSaveState('idle');
  }, []);

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
  // ---- Autosave fingerprint (prompt 87 Task D) -----------------------------
  // One string over everything a save writes. Dirty = the current fingerprint
  // differs from the one captured at the last successful save (seeded from the
  // mount state, so opening an estimate and reading it is never "dirty").
  // Derived values (lineRows, totals, the snapshot) all flow from these
  // inputs, so fingerprinting the inputs is fingerprinting the save.
  const autosaveKey = useMemo(() => JSON.stringify([
    customer, salesperson?.id ?? null, intake, areas, addonForms, overrideReason,
    isCustom, customScope, customPrice, customSqft, crewNotes, clientNotes,
    companyNotes, scheduleShared, scopeAnswers,
  ]), [customer, salesperson, intake, areas, addonForms, overrideReason, isCustom,
    customScope, customPrice, customSqft, crewNotes, clientNotes, companyNotes,
    scheduleShared, scopeAnswers]);
  const autosaveKeyRef = useRef(autosaveKey);
  useEffect(() => { autosaveKeyRef.current = autosaveKey; }, [autosaveKey]);
  // null until the mount snapshot seeds it (first render effect below).
  const lastSavedKeyRef = useRef<string | null>(null);
  useEffect(() => { if (lastSavedKeyRef.current === null) lastSavedKeyRef.current = autosaveKey; }, [autosaveKey]);
  const [dirtyTick, setDirtyTick] = useState(0); // re-render signal when a save lands (refs alone don't repaint the bar)

  const performSave = useCallback(async (opts?: { skipAutoScope?: boolean; auto?: boolean }): Promise<string | null> => {
    const auto = opts?.auto === true;
    // Captured at entry: state typed DURING the await stays dirty and re-arms
    // the autosave timer instead of being silently marked saved.
    const keyAtSave = autosaveKeyRef.current;
    // sellPrice non-null covers both modes: the typed custom price, or the
    // engine/override price. The engine snapshot is only required when a
    // calculator line exists (prompt 82): a custom-line-only estimate saves
    // with the engine dormant. Never bail silently; a guard that trips here
    // names its reason in the save slot instead of no-oping (the old silent
    // `return null` is how Ron's bug hid).
    if (
      !salesperson || sellPrice == null || totalPrice == null ||
      (!isCustom && calcLineCount > 0 && (!pricing || !hasPrice))
    ) {
      setSaveState('error');
      setSaveError(saveBlockers[0] ?? 'The estimate is not ready to save yet.');
      return null;
    }
    if (editing && !online) {
      // An autosave hitting this is expected in a driveway edit; it waits
      // quietly for signal instead of painting the bar red every 2.5s.
      if (auto) { setAutosaveHold('offline'); return null; }
      setSaveState('error');
      setSaveError('Editing an existing estimate needs a connection (it rewrites saved areas). Reconnect and save again.');
      return null;
    }
    // Same-id upsert (prompt 47) means a SECOND full save of a new estimate
    // rewrites the same row's children, which needs the live delete below:
    // same online rule as editing. RELAXED by prompt 87 D's outbox
    // coalescing: while NOTHING from the previous save has drained, the new
    // save simply replaces the queued ops, so offline re-saving is safe. The
    // outbox is FIFO parent-first and children are blocked behind a failed
    // parent, so "the parent op is still queued" is exactly "no child row of
    // this save reached the server", which is the only thing the live child
    // delete exists to handle.
    if (!editing && savedEstimateId && !online) {
      let parentQueued = false;
      try {
        parentQueued = (await listOps()).some((op) => op.table === 'estimates' && op.id === savedEstimateId);
      } catch { parentQueued = false; }
      if (!parentQueued) {
        if (auto) { setAutosaveHold('offline'); return null; }
        setSaveState('error');
        setSaveError('Saving again rewrites this estimate\'s saved areas, which needs a connection. Reconnect and save again.');
        return null;
      }
    }
    // Floor-GP guard (build 17, per-line since prompt 69): warn, do not
    // block. The confirmation NAMES the below-floor lines, not just the
    // combined percentage; line_pricing_block_below_floor makes a below-floor
    // LINE force the confirm even when the combined GP clears the floor.
    const lineFloorConfirm = !isCustom && config.linePricingBlockBelowFloor === true && belowFloorLines.length > 0;
    if (belowFloor || lineFloorConfirm) {
      // A timer must never pop a confirm (prompt 87 D): a below-floor save
      // stays a deliberate human act. The status bar names the hold and the
      // manual Save button is the confirm path.
      if (auto) { setAutosaveHold('confirm'); return null; }
      const lineList = belowFloorLines.length
        ? ` Below the ${lineFloorPct}% line floor: ${belowFloorLines.map((l) => `${l.label} (${(l.gpPct * 100).toFixed(1)}%)`).join(', ')}.`
        : '';
      const combinedPart = belowFloor
        ? `Gross profit is ${combinedGpPct != null ? (combinedGpPct * 100).toFixed(1) : '--'}%, below the ${config.floorGpPct}% floor.`
        : `Combined GP is above the floor, but a line is not.`;
      if (!window.confirm(`${combinedPart}${lineList} Save this estimate anyway?`)) {
        return null;
      }
    }
    setSaveState('saving');
    setSaveError('');
    try {
      // A custom estimate persists NO area rows: any hidden area state stays
      // in the form (the toggle is non-destructive) but never lands in the
      // database, so the proposal shows only the composed custom line.
      // Standard mode walks lineRows (prompt 69): calculator areas AND custom
      // lines, in form order, so estimate_areas carries BOTH kinds and the
      // line items bind to them by position.
      const areaInputs: AreaInput[] = isCustom ? [] : lineRows.map((row) => {
        const a = areas[row.formIdx];
        if (row.kind === 'custom') {
          const label = a.name.trim() || customLabelDefault;
          const matCost = Number(a.customMaterialCost);
          const hours = Number(a.customLaborHours);
          const sqftNum = Number(a.sqft);
          return {
            name: label,
            sqft: Number.isFinite(sqftNum) && sqftNum > 0 ? sqftNum : null,
            systemTypeId: null,
            flakeProductId: null,
            basecoatProductId: null,
            topcoatProductId: null,
            mvb: false,
            answers: {},
            materials: [],
            isCustom: true,
            customLabel: label,
            customScope: a.customScope.trim() || null,
            customMaterialCost: Number.isFinite(matCost) && matCost > 0 ? r2(matCost) : null,
            customLaborHours: Number.isFinite(hours) && hours > 0 ? hours : null,
            notes: a.notes.trim() || null,
            calcPrice: null,
            // Decision 5/1: a custom line's typed price lives in
            // price_override (calc_price stays null: nothing was calculated).
            priceOverride: row.current,
            isOptional: a.optional === true,
            preselected: a.preselected !== false,
          };
        }
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
          isCustom: false,
          customLabel: null,
          customScope: null,
          customMaterialCost: null,
          customLaborHours: null,
          notes: a.notes.trim() || null,
          // This line's own solved price and the rep's per-line override
          // (null = sell at calc_price). The job discount stays estimate-level.
          calcPrice: row.calcPrice,
          priceOverride: row.override,
          isOptional: a.optional === true,
          preselected: a.preselected !== false,
        };
      });

      // Prompt 74: areaInputs[i] is saved with sort_order=i, so this map lets
      // generateScope route each area's written description back to its form
      // row afterwards.
      lastSaveFormIdxBySortRef.current = isCustom ? [] : lineRows.map((row) => row.formIdx);

      const intakePayload: Record<string, unknown> = {
        gate_code: intake.gate_code || null,
        coat_past_garage: intake.coat_past_garage,
        stem_walls: intake.stem_walls,
        moisture: intake.moisture ? Number(intake.moisture) : null,
        mohs_hardness: intake.mohs_hardness ? Number(intake.mohs_hardness) : null,
        additional_non_slip: intake.additional_non_slip || null,
        grinder_tooling_grit: intake.grinder_tooling_grit || null,
        base_price: basePrice,
        discount_pct: discounted && adjusted ? adjusted.discountPct : null,
      };

      // ---- Line items: one per LINE (prompt 69). Each line's amount is its
      // OWN solved (or typed) price, adjusted per-line by the rep's edit and
      // the job-level discount allocation; the parts sum EXACTLY to the sell
      // price because finalLineAmounts comes from allocateProportionally.
      // The old proportional back-allocation of a single job price is gone.
      // unit_cost carries the line's REAL cost (materials + labor +
      // commission + sundries at its final price, i.e. price minus its GP$).
      // Custom mode (whole-estimate, build 24) still composes ONE line
      // carrying the typed price + scope, unchanged.
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
        const calcCount = calcLineCount;
        lineRows.forEach((row, k) => {
          const a = areas[row.formIdx];
          const amt = finalLineAmounts ? finalLineAmounts[k] : (row.current ?? 0);
          const money = lineMoney ? lineMoney[k] : null;
          const unitCost = money && money.gpDollars != null ? r2(amt - money.gpDollars) : 0;
          // Optional lines (prompt 72): the rep's per-line flag, mirrored
          // from the area row. A required line stays selected (it is part of
          // the job); an optional line's opening tick is the rep's
          // preselected choice (opt-out for area/custom lines, decision 3).
          const lineOptional = a.optional === true;
          const lineSelected = !lineOptional || a.preselected !== false;
          if (row.kind === 'custom') {
            lineItems.push({
              addonId: null,
              areaIndex: k,
              label: row.label,
              // The typed scope is used VERBATIM as this line's description
              // (Part E); the scope writer never rewrites it.
              description: a.customScope.trim() || null,
              qty: 1,
              unitPrice: amt,
              unitCost,
              total: amt,
              isOptional: lineOptional,
              selectedByCustomer: lineSelected,
              sortOrder: k,
            });
            return;
          }
          const sys = systemTypes.find((s) => s.id === a.systemTypeId);
          const sysName = sys?.name ?? 'Floor coating';
          const isMvbOnly = sys?.name === MVB_ONLY_SYSTEM_NAME;
          lineItems.push({
            addonId: null,
            areaIndex: k,
            label: calcCount > 1 || lineRows.length > 1 ? `${a.name || 'Area'}: ${sysName}` : (isMvbOnly ? sysName : `${sysName} floor coating system`),
            // Prompt 74 (the clobber fix): a save NEVER authors a calculator
            // line's description. The description is the line's SCOPE, written
            // only by pec-estimate-scope; the save round-trips whatever the
            // load (or the last generation) put in lineDescription, and a new
            // line starts null. The sqft moved to the customer page's
            // area-derived subtitle. The old `${sqft} sqft` string here erased
            // real scope on every re-save (EST-102066, EST-102064).
            description: a.lineDescription.trim() ? a.lineDescription : null,
            qty: 1,
            unitPrice: amt,
            unitCost,
            total: amt,
            isOptional: lineOptional,
            selectedByCustomer: lineSelected,
            sortOrder: k,
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
      // Decision 7: while the estimate is OPEN, estimates.price stores the
      // REQUIRED-only floor (what pipeline and forecasting count) and every
      // stored money bucket follows that same set so the numbers qualify the
      // number they sit next to. price_all_options stores the ceiling. On an
      // estimate with nothing optional the two are equal and every value
      // lands exactly where it always has. Accept later overwrites price
      // with the signed total (existing behavior, unchanged).
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
            price: requiredOnlyTotal,
            gpDollars: requiredMoney.gp,
            gpPct: requiredGpPct,
            gpPerHour: requiredMoney.hours != null && requiredMoney.hours > 0 ? r2(requiredMoney.gp / requiredMoney.hours) : null,
            laborBudget: requiredMoney.labor,
            commissionDollars: requiredMoney.comm,
            budgetedHours: requiredMoney.hours,
          };
      const priceAllOptions = isCustom ? totalPrice : totalAllOptions;

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
      // Online-only by the guards above except the coalescing path: offline
      // with the parent op still queued means no child row ever reached the
      // server, so there is nothing live to delete and the replacement set in
      // the outbox is the whole story.
      if (online) {
        if (editing) await deleteEstimateChildren(editing.id);
        else if (savedEstimateId) await deleteEstimateChildren(savedEstimateId);
      }

      const { id } = await saveEstimateOffline({
        // The screen's pre-minted id (or the edit's), NEVER a fresh one: the
        // early draft card and every Save upsert the same row (prompt 47).
        estimateId: estimateIdForSave(editing?.id ?? null, draftId),
        // Prompt 84: status is written ONLY when this save CREATES the row.
        // An edit, a re-save after the early draft card pre-minted the row
        // (draftWriteRef), or a second Save in the same session
        // (savedEstimateId) must not touch it: the old `editing?.status ??
        // 'draft'` re-wrote the open-time snapshot on every save, so a save
        // queued offline before a send could land after it and clobber
        // status='sent' back to 'draft' (EST-102054). The dashboard owns the
        // sent flip; the estimator only ever births a row as 'draft'.
        status: editing || savedEstimateId || draftWriteRef.current ? undefined : 'draft',
        // A custom estimate has no system; writing the dominant one would be
        // a lie the metrics attribute revenue to. A custom-line-only standard
        // estimate has none either (dominantSystemId falls through to '' when
        // no calc area exists, and '' is not a uuid), so it lands null too.
        systemTypeId: isCustom ? null : (dominantSystemId || null),
        salesperson: { id: salesperson.id, name: salesperson.name, commission_pct: salesperson.commission_pct ?? 0 },
        intake: intakePayload,
        // Split shape straight through; saveEstimateOffline trims, composes
        // the combined customer_name/customer_address safety nets, and writes
        // both alongside the split columns.
        customer,
        flakeColor: isCustom ? null : editing?.flakeColor ?? flakeColorFromPicks,
        scopeAnswers,
        lineItems,
        // Payment schedule (prompt 74): the card's rows, rewritten like every
        // other child. Kind + entered value only; dollars are computed at
        // render and frozen at signature, never stored here.
        installments: scheduleShared.map((r) => ({
          seq: r.seq,
          label: r.label,
          amountKind: r.amount_kind,
          amountValue: r.amount_value,
          triggerKind: r.trigger_kind,
          dueDate: r.due_date,
          isDeposit: r.is_deposit,
        })),
        pricingSnapshot,
        areas: areaInputs,
        pricing,
        totals,
        // Provenance: the CALCULATED total (sum of the lines' solved prices,
        // custom lines at their typed price), and the override reason/who
        // when the price moved off it BY ANY ROUTE (a per-line edit, the job
        // discount, or both) and a reason exists. The reason is only DEMANDED
        // past the threshold; a recorded one is kept regardless. Both null in
        // custom mode: the typed price is not an override of anything.
        calcPrice: isCustom ? null : calcTotal,
        // Decision 7: the ceiling (every line at full value). Equal to
        // totals.price on an estimate with nothing optional.
        priceAllOptions,
        priceOverride: !isCustom && (priceMoved || shortfall >= 0.5) && overrideReason.trim()
          ? { reason: overrideReason.trim(), by: createdBy }
          : null,
        createdBy: editing?.createdBy ?? createdBy,
        // The dedup pick (linkedLead) outranks the URL lead link: the rep
        // explicitly chose that record. An edit keeps its stored lead.
        leadId: editing?.leadId ?? linkedLead?.id ?? leadLink?.id ?? null,
        // Custom saves write the scope themselves (with scope_edited_at).
        // Prompt 94: a standard save now WRITES the assembled document (the
        // same line-text assembly localScopePreview shows) instead of
        // flagging it stale, so estimates.scope_of_work keeps feeding
        // jobs.scope and the crew scope with the AI writer gated off. The
        // one exception is a legacy hand-edited document (scope_edited_at
        // set): a human's words are never overwritten, so that save leaves
        // every scope column alone. markScopeStale is never set anymore;
        // the stale flag is dead once the prod cleanup clears old rows.
        markScopeStale: false,
        assembledScope: (!isCustom && !dbScopeEdited) ? localScopePreview : null,
        isCustom,
        customScope: isCustom ? customScope : null,
        customPrice: isCustom ? sellPrice : null,
        customSqft: isCustom ? customSqft : null,
        crewNotes,
        clientNotes,
        companyNotes,
      });
      // Auto-first, then manual (build 25): the ONE automatic generation
      // happens on the save that has a scope-templated estimate with every
      // scope question answered and no document yet. Prompt 94 B4: only
      // while the generate flag is on; with it off (prod), templates land
      // at pick time and the save above wrote the assembled document.
      // Custom estimates NEVER generate: the typed text IS the scope, and the
      // template writer would replace it with add-on snippets.
      const shouldAutoGen = generateOn && !isCustom && !opts?.skipAutoScope &&
        !dbScopeEdited && !scopeGenerated && scopeQuestions.length === 0;
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
      // Prompt 94: the save writes the current assembly (or, on a legacy
      // hand-edited document, touches nothing), so nothing is stale after it.
      setScopeStale(false);
      setSavedEstimateId(id);
      draftWriteRef.current = true; // the row exists; the early draft must never fire after a full save
      await refreshPending();
      setSavedOffline(!navigator.onLine);
      setSaveState('saved');
      // Autosave bookkeeping: this form state is now on disk. Edits made
      // while the save ran keep the CURRENT key different from keyAtSave, so
      // the debounce re-arms on its own.
      lastSavedKeyRef.current = keyAtSave;
      setLastSavedAt(new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
      setAutosaveHold('');
      setDirtyTick((n) => n + 1);
      if (embed && !auto) {
        // The dashboard closes the modal / refreshes the page off this
        // message (origin-checked on its side) — which is exactly why an
        // AUTOSAVE must never send it: a background save that closed the
        // estimator or re-rendered the page around the iframe every few
        // seconds would be the bug, not the feature. Manual Save keeps the
        // existing close-and-navigate behavior.
        postToParent({ type: 'pec-estimate-saved', estimate_id: id, estimate_number: syncedNumber });
      }
      return id;
    } catch (e) {
      setSaveState('error');
      setSaveError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [salesperson, pricing, hasPrice, calcLineCount, saveBlockers, sellPrice, totalPrice, totalAllOptions, requiredOnlyTotal, requiredMoney, requiredGpPct, editing, online, areas, lineRows, lineMoney, finalLineAmounts, calcTotal, priceMoved, shortfall, belowFloorLines, lineFloorPct, deriveProducts, slotsFor, intake, basePrice, discounted, adjusted, overrideReason, totalSqft, inputsKey, comps, compsLabel, ai, customer, flakeColorFromPicks, createdBy, leadLink, linkedLead, refreshPending, embed, postToParent, addonForms, scopeAnswers, belowFloor, combinedGpDollars, combinedGpPct, combinedGpPerHour, combinedCommission, dominantSystemId, systemTypes, config, generateScope, isCustom, customScope, customSqft, crewNotes, clientNotes, companyNotes, customCommission, dbScopeEdited, scopeGenerated, scopeQuestions, savedEstimateId, draftId, customLabelDefault, scheduleShared, localScopePreview, generateOn]);
  const onSave = useCallback(() => { void performSave(); }, [performSave]);

  // ---- Autosave engine (prompt 87 Task D) ----------------------------------
  // Debounced 2.5s behind the last change, plus an immediate flush when the
  // tab hides or the page unloads (visibilitychange covers phone pocketing
  // and app switches; pagehide covers tab close and the embed iframe being
  // torn down). It only ever fires through canSave, so the first save of a
  // NEW estimate happens once the estimate is real (customer + a priced
  // line): saveBlockers requires both, and the prompt-47 early draft has the
  // same content gate now, so hollow-shell rows are gone in both paths. All
  // writes are the same idempotent-by-id upserts as manual Save, and the
  // outbox coalesces per estimate (newest wins), so a driveway session
  // queues one save's worth of rows, not forty. Status never rides an
  // autosave of an existing row (prompt 84), so a queued autosave can never
  // regress a sent estimate; the DB trigger backstops even that.
  const autosaveOn = config.estimateAutosaveEnabled !== false;
  const dirty = lastSavedKeyRef.current !== null && autosaveKey !== lastSavedKeyRef.current;
  void dirtyTick; // reading it ties the bar's repaint to save completions
  // Each fingerprint gets ONE automatic attempt after a failure or a
  // needs-confirm hold: without this, the error/hold render loop would retry
  // the identical save every 2.5s forever. A new edit (new key) retries; the
  // offline hold is exempt because `online` flipping true IS its retry signal.
  const lastAutoAttemptKeyRef = useRef('');
  useEffect(() => {
    if (!autosaveOn) return;
    if (!dirty || !canSave) return;
    if ((saveState === 'error' || autosaveHold === 'confirm') && lastAutoAttemptKeyRef.current === autosaveKey) return;
    const t = window.setTimeout(() => {
      lastAutoAttemptKeyRef.current = autosaveKeyRef.current;
      void performSave({ auto: true });
    }, 2500);
    return () => window.clearTimeout(t);
    // `online` is a dep so an offline-held autosave retries when signal returns.
  }, [autosaveOn, dirty, canSave, autosaveKey, dirtyTick, online, saveState, autosaveHold, performSave]);
  // Flush refs: the unload listeners are mounted once and must see current
  // state, not the closure from mount.
  const flushRef = useRef<() => void>(() => {});
  useEffect(() => {
    flushRef.current = () => {
      if (autosaveOn && dirty && canSave) void performSave({ auto: true });
    };
  }, [autosaveOn, dirty, canSave, performSave]);
  useEffect(() => {
    const onVis = () => { if (document.hidden) flushRef.current(); };
    const onPageHide = () => flushRef.current();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  // Manual Regenerate (build 25): the only whole-estimate scope writer after
  // the first generation, now surfaced as "Regenerate scope" on the Line
  // items card (prompt 76 Part D3). Saves first when the form has unsaved
  // changes, so the document always re-assembles from what the rep is looking
  // at, never a stale row. Replacing DB-edited text takes an explicit
  // confirm, and only then sends force=true. Pressing Regenerate clears the
  // per-line edited flags: the rep ASKED for a rewrite, so the refresh may
  // replace typed text on templated lines (Part A3 precedence).
  const regenerateScope = useCallback(async () => {
    if (scopeBusy || !online || isCustom) return;
    if (scopeEditedAny && !window.confirm('The scope was edited by hand. Regenerating REPLACES the edited text with a fresh write-up assembled from the estimate. Continue?')) return;
    const force = scopeEditedAny;
    lineDescEditedRef.current.clear();
    addonDescEditedRef.current.clear();
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
  useEffect(() => { regenerateScopeRef.current = regenerateScope; }, [regenerateScope]);

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
      {/* Special notes retired (prompt 62 Part H): the one crew text box is
          "Notes for the crew" (crew_notes) at the bottom of the page. Old
          intake.special_notes values were migrated into crew_notes; the key
          stays readable in old rows but is never written again. The quiet
          missing-fields line is replaced by the red wo-banner up top. */}
    </>
  );

  // ---- Stale-bundle self-heal (prompt 85 Task D) ---------------------------
  // Root cause of the 2026-08-11 missing-Save report: the precached app shell
  // serves the OLD index.html (and its old hashed JS) on a cold open right
  // after a deploy, and skipWaiting/clientsClaim cannot swap JavaScript that
  // is already executing, so a whole session can run last week's bundle. On
  // open, when online, compare the live index.html's main asset hash to the
  // running one. Mismatch + untouched screen: reload once (sessionStorage
  // guards the once; if the SW has not swapped the shell yet, the second pass
  // falls through to the notice instead of reload-looping). Mismatch + ANY
  // work in progress (editing, or customer/areas differ from their mount
  // snapshot, which keeps a lead-prefilled open eligible for the quiet
  // notice, never a reload): a one-line non-blocking notice only. Silently
  // destroying typed work to install an update would be the worse bug.
  const bootSnapshotRef = useRef<string | null>(null);
  if (bootSnapshotRef.current === null) bootSnapshotRef.current = JSON.stringify({ c: customer, a: areas });
  const workInProgressRef = useRef(false);
  workInProgressRef.current = !!editing || JSON.stringify({ c: customer, a: areas }) !== bootSnapshotRef.current;
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/estimator/index.html', { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const liveMatch = (await res.text()).match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
        const runningMatch = String(import.meta.url).match(/(index-[A-Za-z0-9_-]+\.js)/);
        if (!liveMatch || !runningMatch || cancelled || liveMatch[1] === runningMatch[1]) return;
        const reloadKey = 'pecEstimatorReloadedFor';
        if (!workInProgressRef.current && sessionStorage.getItem(reloadKey) !== liveMatch[1]) {
          sessionStorage.setItem(reloadKey, liveMatch[1]);
          location.reload();
          return;
        }
        setUpdateReady(true);
      } catch {
        // Offline or transient network failure: the estimator must open in a
        // no-signal driveway regardless. The check simply does not run.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The ONE Save row for both modes (prompt 82). It renders UNCONDITIONALLY,
  // outside every pricing gate: when the estimate cannot be saved the button
  // is disabled with the first blocker named beside it in plain text (no
  // tooltip; Dylan hit this on a phone, where there is no hover). The custom
  // and standard rows used to be two near-identical copies inside their mode
  // gates; one helper means they cannot drift again.
  // The row is a live STATUS INDICATOR now (prompt 87 Task D, the Google Docs
  // pattern): Saving… / All changes saved HH:MM / Offline — saved on this
  // device / Save failed — Retry, with the manual Save button kept as the
  // immediate-flush (and confirm-path) escape hatch. Ordering matters:
  // in-flight beats everything, a real failure beats a hold, a hold beats
  // plain dirty, and the blocker line keeps explaining WHY a not-yet-real
  // estimate has not written anything (the prompt-82 invariant, unchanged).
  const saveNote = (() => {
    if (saveState === 'saving') return <span className="save-note">Saving…</span>;
    if (saveState === 'error') return <span className="save-note bad">{(saveError || 'Save failed')} — press Save to retry.</span>;
    if (saveBlockers.length > 0) return <span className="save-note bad">{saveBlockers[0]}</span>;
    if (autosaveHold === 'confirm') return <span className="save-note bad">Below-floor GP needs your OK — press Save.</span>;
    if (autosaveHold === 'offline') return <span className="save-note bad">Offline — this estimate needs a connection to save again. Your edits stay on this screen; press Save once you have signal.</span>;
    if (dirty) return <span className="save-note">{autosaveOn ? 'Unsaved changes — autosaving…' : 'Unsaved changes.'}</span>;
    if (saveState === 'saved') {
      return (
        <span className="save-note ok">
          {savedOffline
            ? (isCustom ? 'Offline — saved on this device, syncs when back online.' : 'Offline — saved on this device, syncs when back online. The scope writes itself once connected.')
            : `All changes saved${lastSavedAt ? ` ${lastSavedAt}` : ''}`}
        </span>
      );
    }
    return autosaveOn ? <span className="save-note">Autosaves as you work.</span> : null;
  })();
  const saveRow = (
    <div className="save-row">
      <button type="button" className="save" disabled={!canSave} onClick={onSave}>
        {saveState === 'saving' ? 'Saving…' : editing ? 'Save changes' : 'Save estimate'}
      </button>
      {saveNote}
    </div>
  );

  return (
    <div className={embed ? 'screen embed' : 'screen'}>
      <header className="topbar">
        <div className="brand">
          {/* Embedded, the estimate detail page already names the estimate, so
              the app title is duplicated chrome and is dropped (Part A item
              9). The chips stay: linkage is real information either way. */}
          {!embed && <>PEC Estimator <span className="beta">beta</span></>}
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

      {updateReady && (
        <div className="update-note">A newer version of the estimator is available. Reload this page once your estimate is saved.</div>
      )}

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

      {/* Customer header (Dylan's ask): full width above the two columns.
          Once the info is inputted the card locks into a compact summary bar;
          the WHOLE bar is a button that reopens the editable card. */}
      <div className="cust-top">
        {custLocked ? (
          <section
            className="card cust-summary"
            role="button"
            tabIndex={0}
            aria-label="Customer info, click to edit"
            onClick={() => setCustLocked(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCustLocked(false); } }}
          >
            {custSummaryName
              ? <strong className="cust-summary-name">{custSummaryName}</strong>
              : <strong className="cust-summary-name cust-summary-empty">Add customer info</strong>}
            <span className="cust-tag">{customer.isCommercial ? 'Commercial' : 'Residential'}</span>
            {custSummarySub && <span className="cust-summary-sub">{custSummarySub}</span>}
            <span className="cust-summary-edit" aria-hidden="true">✎ Edit</span>
          </section>
        ) : (
          <section className="card inputs cust-full">
            <div className="areas-head">
              <span>Customer</span>
              <div className="cust-head-actions">
                {/* Residential = first + last name; Commercial = company
                    (required) + optional contact person. One fact, two views. */}
                <div className="cust-type" role="group" aria-label="Customer type">
                  <button type="button" className={customer.isCommercial ? '' : 'on'} onClick={() => setCommercial(false)}>Residential</button>
                  <button type="button" className={customer.isCommercial ? 'on' : ''} onClick={() => setCommercial(true)}>Commercial</button>
                </div>
                {/* Done collapses back to the summary even with fields still
                    missing; the save gate elsewhere names what is absent. */}
                <button type="button" className="link" onClick={() => setCustLocked(true)}>Done</button>
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
        )}
      </div>

      <main className="cols">
        <div className="left">
          {/* MOHS + moisture banner (prompt 62 Part H): loud, never a block.
              Dylan wrote "required for every quote" but chose warning-only
              and confirmed it on a second pass, so this is an unmissable red
              banner (here AND on the estimate detail page), not a gate. It
              replaces the old quiet woMissingFields line. */}
          {woMissingFields.length > 0 && (
            <div className="wo-banner" role="alert">
              {woMissingFields.join(' and ')} {woMissingFields.length === 1 ? 'is' : 'are'} blank. The crew work order will print {woMissingFields.length === 1 ? 'it' : 'them'} blank. Fill {woMissingFields.length === 1 ? 'it' : 'them'} in under Work order below. Saving and sending still work.
            </div>
          )}
          {/* Standard / Custom is an ESTIMATE-level switch (build 24), not a
              system type: Custom turns the whole estimate into typed scope +
              typed price for one-off work. Non-destructive: hidden area and
              answer state survives a toggle round-trip. */}
          {/* Estimate type + Salesperson share ONE card (2026-08-10 phase 4
              declutter): both are set-once-per-estimate controls, and two
              stacked two-line boxes were the exact "boxes" Dylan wanted
              fewer of. The Customer card lives in the full-width header. */}
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
            <label className="field">
              <span>Salesperson</span>
              {salespersonLocked ? (
                <>
                  <input value={salesperson ? salesperson.name : 'Unassigned'} readOnly disabled />
                  <p className="muted" style={{ fontSize: '.75rem', margin: '4px 0 0' }}>
                    Locked once the estimate is sent, or when someone else started it. An admin can change it.
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
                    <button type="button" className="link" onClick={revertPolish}>Undo generate</button>
                  )}
                  {config.estimateLineGenerateEnabled !== false && (
                    <button type="button" className="link" onClick={polishScope} disabled={polishBusy || !online || !customScope.trim()}>
                      {polishBusy ? 'Working…' : '✨ Generate with AI'}
                    </button>
                  )}
                </span>
              </div>
              <p className="hint">Type the scope in your own words; this is what the customer reads on the proposal. Generate (optional) cleans grammar and structure only: it keeps your exclusions and dollar figures, adds nothing, and can be undone.</p>
              <textarea
                className="custom-scope"
                rows={10}
                value={customScope}
                onChange={(e) => setCustomScope(e.target.value)}
                placeholder="Describe the work: prep, what gets coated, what is excluded…"
              />
              {polishError && <p className="warn">Generate failed: {polishError}</p>}
              {!online && <p className="hint">Generate needs a connection; your typed text saves fine without it.</p>}
            </section>
          )}

          {/* Line items (prompt 76 Part C): the per-area stacked cards
              collapsed to compact tappable rows, DripJobs-shaped. Everything
              editable (name, system, sqft, price, options, scope description,
              internal notes) lives in the bottom-sheet editor a tap opens.
              "Regenerate scope" here is the whole-estimate writer the deleted
              scope panel used to own (Part D3); it renders only while the AI
              generate flag is on (prompt 94 B4: off in prod, templates fill
              line scopes at pick time and the save assembles the document). */}
          {!isCustom && <section className="card">
            <div className="areas-head">
              <span>Line items</span>
              {generateOn && (
                <span className="scope-actions">
                  <button
                    type="button"
                    className="link"
                    onClick={regenerateScope}
                    disabled={scopeBusy || !online || (!savedEstimateId && !canSave)}
                  >
                    {scopeBusy ? 'Writing…' : scopeGenerated ? 'Regenerate scope' : 'Write scope now'}
                  </button>
                </span>
              )}
            </div>
            {generateOn && !scopeBusy && scopeStale && (scopeGenerated || scopeEditedAny) && (
              <p className="warn">The estimate changed after the scope was written. Tap Regenerate scope before sending.</p>
            )}
            {scopeGenerated && scopeContainsBlank(scopeText) && (
              <p className="warn">The word BLANK is still in the scope. You will not be able to send this estimate until it is filled in. Answer the scope questions below, or edit the line descriptions.</p>
            )}
            {scopeError && <p className="warn">{scopeError}</p>}
            <div className="line-table">
              {areas.map((a, i) => {
                const rowIdx = lineRows.findIndex((r) => r.formIdx === i);
                const row = rowIdx >= 0 ? lineRows[rowIdx] : null;
                const lm = row && lineMoney ? lineMoney[rowIdx] : null;
                const finalAmt = row && finalLineAmounts ? finalLineAmounts[rowIdx] : null;
                const lineRed = lm?.gpPct != null && lm.gpPct * 100 < lineFloorPct - 0.05;
                const sys = systemTypes.find((s) => s.id === a.systemTypeId);
                const name = a.isCustom ? (a.name.trim() || customLabelDefault) : (a.name || `Area ${i + 1}`);
                const sqftNum = Number(a.sqft);
                const scopePresent = (a.isCustom ? a.customScope : a.lineDescription).trim() !== '';
                const price = row ? (finalAmt ?? row.current ?? row.calcPrice) : null;
                return (
                  <button
                    type="button"
                    className="line-row"
                    key={`area${i}`}
                    onClick={() => { setSheetFocusDesc(false); setOpenLine({ kind: 'area', idx: i }); }}
                    aria-label={`Edit line ${name}`}
                  >
                    <span className="line-row-main">
                      <span className="line-row-name">{name}</span>
                      {a.isCustom
                        ? <span className="line-chip custom">custom</span>
                        : <span className="line-row-sys">{sys?.name ?? 'No system'}{a.mvb ? ' +MVB' : ''}</span>}
                      {!a.isCustom && (
                        <span className="line-row-sys">{sqftNum > 0 ? `${Math.round(sqftNum).toLocaleString()} sqft` : 'no sqft yet'}</span>
                      )}
                    </span>
                    <span className="line-row-price">{price != null ? money2(price) : '--'}</span>
                    <span className="line-row-sub">
                      {a.optional && <span className="line-chip optional">optional{a.preselected ? '' : ' · starts unticked'}</span>}
                      {scopePresent
                        ? <span className="line-chip scope-ok">scope ✓</span>
                        : <span className="line-chip scope-missing">no scope yet</span>}
                      {row?.kind === 'calc' && row.override != null && row.calcPrice != null && <span>calc {money2(row.calcPrice)}</span>}
                      {lm?.gpPct != null && (
                        <span className={lineRed ? 'gp-red' : ''}>GP {money2(lm.gpDollars)} ({pct(lm.gpPct)}){lineRed ? ` · below ${lineFloorPct}% floor` : ''}</span>
                      )}
                    </span>
                  </button>
                );
              })}
              {addonForms.map((f) => {
                const qty = Number(f.qty) > 0 ? Number(f.qty) : 1;
                const total = r2(qty * (Number(f.unitPrice) || 0));
                return (
                  <button
                    type="button"
                    className="line-row"
                    key={f.key}
                    onClick={() => { setSheetFocusDesc(false); setOpenLine({ kind: 'addon', key: f.key }); }}
                    aria-label={`Edit line ${f.label.trim() || 'one-off'}`}
                  >
                    <span className="line-row-main">
                      <span className="line-row-name">{f.label.trim() || 'One-off line'}</span>
                      <span className={f.addonId ? 'line-chip addon' : 'line-chip custom'}>{f.addonId ? 'add-on' : 'one-off'}</span>
                      {qty !== 1 && <span className="line-row-sys">x{qty}</span>}
                    </span>
                    <span className="line-row-price">{money2(total)}</span>
                    <span className="line-row-sub">
                      {f.optional && <span className="line-chip optional">optional</span>}
                      {f.description.trim()
                        ? <span className="line-chip scope-ok">description ✓</span>
                        : <span className="line-chip addon">no description</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* The old "give at least one area a system and square footage"
                hint is gone (prompt 82): a custom-line-only estimate is a
                first-class priceable estimate now, and that advice was
                exactly wrong for it. */}
            <div className="line-actions">
              <button type="button" className="link" onClick={addArea}>+ Add area</button>
              <button type="button" className="link" onClick={addCustomLine}>+ Add custom line</button>
              <button type="button" className="link" onClick={addOneOff}>+ One-off line</button>
              <select
                value=""
                aria-label="Add an add-on from the catalog"
                onChange={(e) => { if (e.target.value) addAddonFromCatalog(e.target.value); }}
              >
                <option value="">+ Add-on from catalog…</option>
                {availableAddons.map((ad) => (
                  <option key={ad.id} value={ad.id}>
                    {ad.name}{ad.default_price > 0 ? ` (${money2(ad.default_price)}/${ad.unit})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <p className="hint">Tap a line to edit its price, options, and the scope the customer reads. Optional items stay out of the total until the customer picks them.</p>
          </section>}

          {/* Template-driven, so they do not apply to a custom estimate. */}
          {!isCustom && scopeQuestions.length > 0 && (
            <section className="card scope-questions">
              <div className="areas-head"><span>Finish the scope</span></div>
              <p className="hint">Your template leaves these blanks for you to fill in. Do it now while you are on site; anything left blank stops the estimate from being sent.</p>
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

          {/* The work order questions render ALWAYS VISIBLE (prompt 62 Part H
              dropped the More detail accordion: a collapsed section kept
              getting skipped in the driveway). Product dropdowns are hidden
              behind Specify products (prompt 63 Part A: they detract from the
              sale; picks happen later, on the job). Still optional: a rep who
              never touches any of it gets a correct price off the recipe
              defaults. Hidden in custom mode (recipe/area detail). */}
          {!isCustom && <section className="card">
            {(() => {
              // Prompt 63 Part A: product-kind slots (Basecoat, Topcoat, Flake,
              // Quartz, ... anything kindOf === 'product', so a future product
              // material_type hides automatically) are hidden while selling;
              // choice/text slots (e.g. Topcoat cure speed) stay, and the
              // Specify products link reveals everything for this session.
              // Display-only: slotValues keeps the prefilled defaults, so
              // pricing and the saved rows never change.
              const areaBlocks = areas.map((a, i) => {
                const areaSlots = slotsFor(a.systemTypeId)
                  .filter((s) => specifyProducts || kindOf(s) !== 'product');
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
              });
              // Never leave an empty titled card: when no area has a visible
              // slot, the heading and hint go too and only the link renders.
              const anyVisible = areaBlocks.some(Boolean);
              const specifyLink = (
                <button type="button" className="link" onClick={() => setSpecifyProducts((v) => !v)}>
                  {specifyProducts ? 'Hide products' : 'Specify products'}
                </button>
              );
              return (
                <>
                  {anyVisible ? (
                    <>
                      <div className="areas-head"><span>Products and colors</span><span className="scope-actions">{specifyLink}</span></div>
                      {areaBlocks}
                      <p className="hint">Colors and products are picked after the sale, on the job. The price already includes standard materials. Use Specify products if this job needs a spec now.</p>
                    </>
                  ) : (
                    <div className="areas-head"><span /><span className="scope-actions">{specifyLink}</span></div>
                  )}
                </>
              );
            })()}
            <div className="areas-head" style={{ marginTop: 10 }}><span>Work order</span></div>
            {workOrderFields}
          </section>}

          {/* Custom mode still needs the site questions (prompt 58 Part E):
              same field list as above, its own always-visible card because
              the products/colors card is recipe/area machinery custom mode
              hides. */}
          {isCustom && <section className="card">
            <div className="areas-head"><span>Work order (site questions)</span></div>
            {workOrderFields}
          </section>}

          {/* Crew notes moved to the Notes tab below the columns (2026-08-10
              phase 4): the three-lane notes strip is the DripJobs shape. */}
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
              </>
            )}
            {/* Only when a CALCULATOR line is missing its square footage: a
                custom-line-only estimate needs no sqft, and telling Ron to
                enter one was exactly the wrong advice (prompt 82). */}
            {!isCustom && salesperson && !hasPrice && !err && !mvbMissing &&
              areas.some((a) => !a.isCustom && !(Number(a.sqft) > 0 && a.systemTypeId)) &&
              <p className="hint">Enter the square footage to price the job.</p>}
            {err && <p className="error">{(ERROR_COPY[err] ?? err) + (pricing?.errorArea ? ` (area: ${pricing.errorArea})` : '')}</p>}
            {!isCustom && hasPrice && customLineUnpriced && (
              <p className="warn">A custom line has no price yet. Type its price on the line (Areas card) to price the job.</p>
            )}
            {/* The money block keys off the LINE chain, not the engine
                (prompt 82): with only custom lines the engine is dormant and
                `pricing` is legitimately null, but the estimate still prices. */}
            {!isCustom && linesReady && adjusted && (
              <>
                <div className="price">{money(totalPrice)}</div>
                {/* Optional-lines totals (prompt 72, decision 6). The
                    headline above is the customer's OPENING total (required +
                    pre-selected). All-in replaces the old "with every
                    optional item" hint; required-only is the floor with its
                    own GP so a rep never has to do that math in the truck. */}
                {(hasOptionalLines || hasOptionalAddons) && totalAllOptions != null && requiredOnlyTotal != null && (
                  <div className="hint" style={{ display: 'grid', gap: 2 }}>
                    <span><strong>All-in</strong> {money(totalAllOptions)} (every line at full value)</span>
                    <span><strong>Required only</strong> {money(requiredOnlyTotal)}{requiredGpPct != null ? ` · GP ${pct(requiredGpPct)}` : ''}</span>
                  </div>
                )}
                {optionalGpWarn && requiredGpPct != null && (
                  <p className="warn gp-warn">
                    If they take only the required lines, this job runs at {(requiredGpPct * 100).toFixed(1)}% GP, below your {Number(config.optionalLinesGpWarnPct ?? 40).toFixed(0)}% floor. Consider pricing the required lines to stand on their own.
                  </p>
                )}
                {(discounted || anyLineEdited || addonsBaseTotal > 0) && (
                  <p className="hint">
                    system {money(finalSell)}
                    {calcTotal != null && finalSell != null && Math.abs(finalSell - calcTotal) >= 0.5 ? ` (calculated ${money(calcTotal)}${shortfall > 0 ? `, ${money(shortfall)} under` : ''})` : ''}
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
                {/* Override reason (prompt 69): shown whenever the price
                    moved off the calculated total by ANY route (a per-line
                    edit, the job discount, or both); REQUIRED only when the
                    shortfall exceeds the threshold, so a rounding nudge does
                    not nag but three small line trims that add up still ask. */}
                {(priceMoved || shortfall >= 0.5 || overrideReason.trim() !== '') && (
                  <label className="field override-reason">
                    <span>Why the price was changed{overrideNeedsReason ? ' (required)' : ''}</span>
                    <input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="problem customer, large sqft, competitor match…" />
                  </label>
                )}
                {overrideNeedsReason && <p className="warn">The final price is {money(shortfall)} under the calculated total, past the allowed {money(reasonThreshold)} leeway. A written reason is required to save.</p>}
                <dl className="metrics">
                  <div><dt>Gross profit</dt><dd className={gpBelowTarget ? 'gp-red' : ''}>{money(combinedGpDollars)} ({pct(combinedGpPct)})</dd></div>
                  <div><dt>Target GP</dt><dd>{Number(targetGpPctResolved).toFixed(1).replace(/\.0$/, '')}%</dd></div>
                  <div><dt>GP / hour</dt><dd>{money2(combinedGpPerHour)}</dd></div>
                  {/* Engine dormant (custom lines only): materials is the
                      typed custom cost alone, and the pct labels fall back to
                      the config (labor is a RATE, not a pct, so it shows as
                      $/hr). The dollar figures come from `adjusted`, summed
                      from customLinePricing, and are right either way. */}
                  <div><dt>Materials</dt><dd>{money2(r2((pricing?.materialsCost ?? 0) + customMaterialsTotal))}{pricing != null && customMaterialsTotal > 0 ? <span className="muted"> · incl. {money2(customMaterialsTotal)} custom</span> : null}</dd></div>
                  <div><dt>Labor ({pricing != null ? `${pricing.laborPct != null ? Number(pricing.laborPct).toFixed(1).replace(/\.0$/, '') : '--'}%` : `${money2(config.laborRate)}/hr`})</dt><dd>{money2(adjusted.laborDollars)}<span className="muted"> · {adjusted.budgetedHours?.toFixed(1) ?? '--'}h</span></dd></div>
                  <div><dt>Sundries ({Number(pricing?.sundriesPct ?? config.sundriesPct).toFixed(1).replace(/\.0$/, '')}%)</dt><dd>{money2(adjusted.sundriesDollars)}</dd></div>
                  <div><dt>Commission (standard {pricing?.standardCommissionPct ?? config.standardCommissionPct}%)</dt><dd>{money2(combinedCommission)}</dd></div>
                  {addonCost > 0 && <div><dt>Add-on cost</dt><dd>{money2(addonCost)}</dd></div>}
                </dl>
                {/* How the price was reached, in one plain-English line.
                    Engine dormant: the custom-lines-only phrasing, no engine
                    sentence, and no empty <p> either way (prompt 82). */}
                {engineCost != null && pricing != null && pricing.price != null ? (
                  <p className="derivation">
                    {`cost of ${money(engineCost)} priced to a ${Number(targetGpPctResolved).toFixed(1).replace(/\.0$/, '')}% target GP = ${money(pricing.priceRaw)}, rounded to ${money(pricing.price)}${mixedSystems ? `, each area solved at its own system's target` : ''}${customLineRows.length > 0 ? ` + ${customLineRows.length} custom line${customLineRows.length > 1 ? 's' : ''} at typed prices` : ''}${charmFired ? ' (charm-priced just under a round number, so GP dips slightly under target on purpose)' : ''}`}
                  </p>
                ) : engineDormant && customLineRows.length > 0 ? (
                  <p className="derivation">
                    {customLineRows.length === 1 ? '1 custom line at a typed price' : `${customLineRows.length} custom lines at typed prices`}
                  </p>
                ) : null}
                {gpBelowTarget && (
                  <p className="warn gp-warn">GP is below the {Number(targetGpPctResolved).toFixed(1).replace(/\.0$/, '')}% target{mixedSystems ? ' (price-weighted across the area systems)' : ' for this system'}. Saving still works; the number is just red on purpose.</p>
                )}
                {belowFloor && (
                  <p className="warn gp-warn">GP is below the {config.floorGpPct}% floor. Saving asks you to confirm.</p>
                )}
                {!belowFloor && belowFloorLines.length > 0 && (
                  <p className="warn gp-warn">
                    Below the {lineFloorPct}% line floor: {belowFloorLines.map((l) => `${l.label} (${(l.gpPct * 100).toFixed(1)}%)`).join(', ')}.
                    {config.linePricingBlockBelowFloor === true ? ' Saving asks you to confirm.' : ' Saving still works; the line is red on purpose.'}
                  </p>
                )}
                {pricing?.materialsMissingCost && pricing.materialsMissingCost.length > 0 && (
                  <p className="warn">No cost set for: {pricing.materialsMissingCost.join(', ')}. Price may be understated until these are priced in the Catalog.</p>
                )}
                {/* No engine result, no engine version line. */}
                {pricing != null && <p className="calcver">engine {pricing.calcVersion}</p>}
                {customerIncomplete && (
                  <p className="warn">{customer.isCommercial ? 'Enter the company name (Customer card) to save.' : 'Enter the customer’s last name (Customer card) to save.'}</p>
                )}
                {woMissingFields.length > 0 && (
                  <p className="warn">Work order: {woMissingFields.join(' and ')} not filled in (see More detail above). Saving still works.</p>
                )}
              </>
            )}
            {/* Save renders in EVERY state of BOTH modes (prompt 82): outside
                the money gates, disabled with its blocker named when it must
                be. A missing Save button is never the interface again. */}
            {saveRow}
          </section>

          {/* Payment schedule moved to the Settings tab below the columns
              (2026-08-10 phase 4), the DripJobs editor shape. */}

          {/* The "Comparable jobs" and "AI price read" panels used to render
              here as collapsed disclosures (the phase-4 declutter parked them
              under the Money card). Prompt 87 (Dylan, 2026-08-12) reversed
              that: reps never opened them and the column was still too busy,
              so the panels moved OUT of the estimator entirely. The pipeline
              behind them still runs silently — the comps computation, the
              per-line AI fetch effect, and the pricing_snapshot write below
              are all intact — and the estimate DETAIL page (index.html
              renderEstimateDetail, snapAi.lines) is where the read lives now.
              Do not re-add panels here without a new decision from Dylan. */}
        </div>
      </main>

      {/* Bottom tab strip (2026-08-10, DripJobs-parity phase 4): the DripJobs
          proposal editor's Settings | Notes tabs, full width below the
          columns. React state keeps hidden tabs' inputs alive; the iframe
          height listener on the dashboard side follows the height change. */}
      <div className="cust-type" role="tablist" aria-label="Estimate sections" style={{ display: 'inline-flex', margin: '14px 0 10px' }}>
        <button type="button" role="tab" aria-selected={estTab === 'settings'} className={estTab === 'settings' ? 'on' : ''} onClick={() => setEstTab('settings')}>Settings</button>
        <button type="button" role="tab" aria-selected={estTab === 'notes'} className={estTab === 'notes' ? 'on' : ''} onClick={() => setEstTab('notes')}>Notes</button>
      </div>

      {estTab === 'settings' && (
        <>
          {/* Payment schedule (prompt 74): created and approved HERE, before
              the customer ever sees the estimate (locked decision 5). Zero
              rows = no schedule block on the page and the legacy auto-deposit
              on accept. Percent rows recompute live on the customer page as
              options are ticked; the send gate blocks a schedule that does
              not resolve to the estimate total. Hidden company-wide by the
              estimate_schedule_enabled setting (rule 12). Auto-seeded on new
              estimates (2026-08-18) unless the rep removed it. */}
          {scheduleEnabled && (
            <section className="card">
              <div className="areas-head">
                <span>Payment schedule</span>
                {scheduleRows.length > 0 && (
                  <button type="button" className="link" onClick={() => { setScheduleRows([]); setScheduleRemoved(true); setSaveState('idle'); }}>Remove schedule</button>
                )}
              </div>
              {!scheduleOpen && scheduleRows.length === 0 ? (
                <>
                  <p className="hint">The customer sees and agrees to the deposit and progress payments when signing. On accept, the signed schedule becomes the job's real installments.</p>
                  <button type="button" className="link" onClick={openScheduleEditor}>Set up payment schedule</button>
                </>
              ) : scheduleRows.length === 0 ? (
                <>
                  <p className="hint">No schedule: after signing, the job gets the standard deposit ask, same as today.</p>
                  <button type="button" className="link" onClick={seedSchedule}>Add the default schedule</button>
                </>
              ) : (
                <>
                  {scheduleRows.map((r, i) => (
                    <div key={r.key} style={{ borderTop: i === 0 ? 'none' : '1px solid rgba(128,128,128,.25)', paddingTop: i === 0 ? 0 : 8, marginTop: i === 0 ? 0 : 8, display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <label className="field" style={{ flex: '1 1 140px' }}><span>Label</span>
                          <input value={r.label} placeholder={r.isDeposit ? 'Deposit' : 'Installment'} onChange={(e) => setScheduleRow(r.key, { label: e.target.value })} />
                        </label>
                        <label className="field" style={{ flex: '0 0 92px' }}><span>Amount</span>
                          <input inputMode="decimal" value={r.valueInput} placeholder="0" onChange={(e) => setScheduleRow(r.key, { valueInput: e.target.value.replace(/[^0-9.]/g, '') })} />
                        </label>
                        <label className="field" style={{ flex: '0 0 64px' }}><span>&nbsp;</span>
                          <select value={r.kind} onChange={(e) => setScheduleRow(r.key, { kind: e.target.value === 'fixed' ? 'fixed' : 'percent' })}>
                            <option value="percent">%</option>
                            <option value="fixed">$</option>
                          </select>
                        </label>
                        <label className="field" style={{ flex: '1 1 130px' }}><span>Due</span>
                          <select value={r.trigger} onChange={(e) => setScheduleRow(r.key, { trigger: e.target.value })}>
                            {SCHEDULE_TRIGGERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                          </select>
                        </label>
                        {r.trigger === 'date' && (
                          <label className="field" style={{ flex: '0 0 140px' }}><span>Date</span>
                            <input type="date" value={r.dueDate} onChange={(e) => setScheduleRow(r.key, { dueDate: e.target.value })} />
                          </label>
                        )}
                        <button type="button" className="link" style={{ marginBottom: 6 }} onClick={() => removeScheduleRow(r.key)} title="Remove this row">✕</button>
                      </div>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                        <label className="check" style={{ margin: 0 }}>
                          <input type="checkbox" checked={r.isDeposit} onChange={(e) => setScheduleRow(r.key, { isDeposit: e.target.checked })} />
                          <span>This is the deposit</span>
                        </label>
                        {scheduleCents && scheduleCents[i] != null && (
                          <span className="muted" style={{ fontSize: '.82rem' }}>= {money2(scheduleCents[i] / 100)}{totalPrice != null ? ' of ' + money2(totalPrice) : ''}</span>
                        )}
                      </div>
                    </div>
                  ))}
                  <div style={{ marginTop: 10, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button type="button" className="link" onClick={addScheduleRow}>+ Add installment</button>
                  </div>
                  {totalPrice == null && <p className="hint">Dollar amounts appear once the job is priced.</p>}
                  {scheduleError && <p className="warn">{scheduleError.message} Sending is blocked until the schedule resolves to the total exactly.</p>}
                  {!scheduleError && scheduleCents && <p className="hint">Schedule matches the estimate total to the cent. Percent rows re-balance automatically if the customer changes optional items.</p>}
                </>
              )}
            </section>
          )}

          {/* Read-only payments summary: WHERE the deposit percent comes from
              (system type vs company default), so a rep never wonders why a
              seeded deposit says 25 on one job and 50 on another. Per-estimate
              display toggles (DripJobs' "Show schedule on proposal") are a
              deliberate follow-up, not built here. */}
          <section className="card">
            <div className="areas-head"><span>Payments</span></div>
            <p className="hint">
              Deposit percent for this estimate resolves to {String(resolveDepositPct(dominantSystem?.deposit_pct, config.defaultDepositPct))}%
              ({dominantSystem?.deposit_pct != null ? `the ${dominantSystem.name} system's own percent` : 'the company default'}).
              Card and bank payment, check, Zelle, and financing are offered automatically on the signed job's invoice.
            </p>
          </section>
        </>
      )}

      {estTab === 'notes' && (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {/* Crew notes (prompt 32, Part B): INTERNAL, both modes. Prints on
              the crew work order only; never on the customer proposal, the
              customer estimate page, or the PDF. Generate is manual-only. */}
          <section className="card">
            <div className="areas-head">
              <span>Crew notes <span className="muted" style={{ fontSize: '.68rem', fontWeight: 700, letterSpacing: '.5px' }}>TEAM ONLY</span></span>
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
              rows={8}
              value={crewNotes}
              onChange={(e) => { setCrewNotes(e.target.value); setCrewNotesEdited(true); setSaveState('idle'); }}
              placeholder="Cliff notes and watch-outs for the crew: access, prep, site conditions, customer asks…"
            />
            {crewNotesError && <p className="warn">Generate failed: {crewNotesError}</p>}
            {!online && <p className="hint">Generate needs a connection; typed crew notes save fine without it.</p>}
          </section>

          {/* Client notes (2026-08-20): CLIENT VISIBLE. Renders on the
              customer estimate page as "A note from us". */}
          <section className="card">
            <div className="areas-head">
              <span>Client notes <span style={{ fontSize: '.68rem', fontWeight: 700, letterSpacing: '.5px', color: '#b45309' }}>CLIENT VISIBLE</span></span>
            </div>
            <p className="hint">The customer reads this on their estimate page, above the line items. Keep it warm and specific; leave it blank for no note.</p>
            <textarea
              rows={8}
              value={clientNotes}
              onChange={(e) => { setClientNotes(e.target.value); setSaveState('idle'); }}
              placeholder="A note the customer will read on their estimate…"
            />
          </section>

          {/* Company notes (2026-08-20): INTERNAL ONLY, office context that
              belongs to the estimate rather than the crew work order. */}
          <section className="card">
            <div className="areas-head">
              <span>Company notes <span className="muted" style={{ fontSize: '.68rem', fontWeight: 700, letterSpacing: '.5px' }}>INTERNAL ONLY</span></span>
            </div>
            <p className="hint">Office-only context for this estimate (pricing history, callbacks, who talked to whom). Never printed, never sent.</p>
            <textarea
              rows={8}
              value={companyNotes}
              onChange={(e) => { setCompanyNotes(e.target.value); setSaveState('idle'); }}
              placeholder="Internal context for the office…"
            />
          </section>
        </div>
      )}

      {/* The line editor sheet (prompt 76 Part C): one line at a time,
          DripJobs-shaped sections (Area, Pricing, Description, Internal
          notes). BottomSheet owns the modal lifecycle. */}
      {openLine && (() => {
        const sheetBreakpoint = Number(config.lineSheetBreakpointPx) > 0 ? Number(config.lineSheetBreakpointPx) : 700;
        const close = () => { setOpenLine(null); setSheetFocusDesc(false); };
        if (openLine.kind === 'area') {
          const i = openLine.idx;
          const a = areas[i];
          if (!a) return null;
          const rowIdx = lineRows.findIndex((r) => r.formIdx === i);
          const row = rowIdx >= 0 ? lineRows[rowIdx] : null;
          const lm = row && lineMoney ? lineMoney[rowIdx] : null;
          const finalAmt = row && finalLineAmounts ? finalLineAmounts[rowIdx] : null;
          const lineRed = lm?.gpPct != null && lm.gpPct * 100 < lineFloorPct - 0.05;
          const sys = systemTypes.find((s) => s.id === a.systemTypeId);
          const isMvbOnly = !a.isCustom && isMvbOnlySystem(a.systemTypeId);
          const tpl = !a.isCustom && sys ? ((a.mvb && sys.scope_template_mvb) ? sys.scope_template_mvb : sys.scope_template) : null;
          const descValue = a.isCustom ? a.customScope : a.lineDescription;
          // Prompt 94 B2: one input per distinct {{token}} still in the text.
          const lineTokens = a.isCustom ? [] : scopeTokenFields(descValue);
          const title = a.isCustom ? (a.name.trim() || customLabelDefault) : (a.name || `Area ${i + 1}`);
          return (
            <BottomSheet
              open
              onClose={close}
              title={`Edit line: ${title}`}
              breakpointPx={sheetBreakpoint}
              focusSelector={sheetFocusDesc ? 'textarea[data-sheet-desc]' : null}
              footer={<>
                <button
                  type="button"
                  className="sheet-remove"
                  disabled={!a.isCustom && areas.length === 1}
                  onClick={() => { if (window.confirm('Remove this line from the estimate?')) removeArea(i); }}
                >
                  Remove line
                </button>
                <button type="button" className="sheet-done" onClick={close}>Done</button>
              </>}
            >
              <div className="sheet-section">
                <div className="sheet-section-title"><span>{a.isCustom ? 'Line' : 'Area'}</span>{a.isCustom ? <span className="line-chip custom">custom</span> : null}</div>
                <label className="field"><span>{a.isCustom ? 'Line label (customer sees this)' : 'Area name'}</span>
                  <input value={a.name} onChange={(e) => setArea(i, { name: e.target.value })} placeholder={a.isCustom ? customLabelDefault : 'Area name'} />
                </label>
                {!a.isCustom && (
                  <>
                    <label className="field"><span>System</span>
                      <select value={a.systemTypeId} onChange={(e) => onAreaSystemChange(i, e.target.value)}>
                        {systemTypes.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                      </select>
                    </label>
                    <label className="field"><span>Square footage</span>
                      <input inputMode="decimal" value={a.sqft} onChange={(e) => setArea(i, { sqft: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="sq ft" />
                    </label>
                    {!isMvbOnly && (
                      <label className="check">
                        <input type="checkbox" checked={a.mvb} onChange={(e) => onAreaMvbChange(i, e.target.checked)} />
                        <span>Add moisture vapor barrier (MVB) to this area</span>
                      </label>
                    )}
                  </>
                )}
              </div>
              <div className="sheet-section">
                <div className="sheet-section-title"><span>Pricing</span></div>
                {a.isCustom ? (
                  <>
                    <div className="addon-nums">
                      <label className="field"><span>Price $ (you set it{Number(a.priceInput) > 0 ? '' : ', required'})</span>
                        <input inputMode="decimal" value={a.priceInput} onChange={(e) => setArea(i, { priceInput: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="0" />
                      </label>
                      <label className="field"><span>Material cost $</span>
                        <input inputMode="decimal" value={a.customMaterialCost} onChange={(e) => setArea(i, { customMaterialCost: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="0" />
                      </label>
                      <label className="field"><span>Crew hours</span>
                        <input inputMode="decimal" value={a.customLaborHours} onChange={(e) => setArea(i, { customLaborHours: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="0" />
                      </label>
                      <label className="field"><span>Sq ft (optional)</span>
                        <input inputMode="decimal" value={a.sqft} onChange={(e) => setArea(i, { sqft: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="0" />
                      </label>
                    </div>
                    {Number(a.priceInput) > 0 && !(Number(a.customMaterialCost) > 0) && !(Number(a.customLaborHours) > 0) && (
                      <p className="warn addon-warn">No material cost or hours on this line: it books as pure margin and inflates GP until they are typed.</p>
                    )}
                  </>
                ) : row && row.calcPrice != null ? (
                  <label className="field"><span>Line price $ (calc {money(row.calcPrice)})</span>
                    <input inputMode="decimal" value={a.priceInput} placeholder={String(row.calcPrice)} onChange={(e) => setArea(i, { priceInput: e.target.value.replace(/[^0-9.]/g, '') })} />
                  </label>
                ) : (
                  <p className="hint">Enter the square footage (and pick a salesperson) and this line prices itself.</p>
                )}
                {optionalControlsVisible(config.optionalLinesEnabled, a.optional) && (
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
                    <label className="check addon-opt">
                      <input
                        type="checkbox"
                        checked={a.optional}
                        onChange={(e) => setArea(i, {
                          optional: e.target.checked,
                          preselected: e.target.checked ? (config.optionalLinesPreselectDefault !== false) : a.preselected,
                        })}
                      />
                      <span>Optional (customer picks)</span>
                    </label>
                    {a.optional && (
                      <label className="check addon-opt">
                        <input type="checkbox" checked={a.preselected} onChange={(e) => setArea(i, { preselected: e.target.checked })} />
                        <span>Starts selected for the customer</span>
                      </label>
                    )}
                  </div>
                )}
                {row && row.current != null && (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', fontSize: '.8rem', marginTop: 8 }}>
                    {row.kind === 'calc' && (
                      <span className="muted">calc {money2(row.calcPrice)}{row.override != null ? ` · selling ${money2(row.override)}` : ''}</span>
                    )}
                    {finalAmt != null && Math.abs(finalAmt - (row.current ?? 0)) >= 0.005 && (
                      <span className="muted">after discount {money2(finalAmt)}</span>
                    )}
                    {lm && lm.gpPct != null && (
                      <span className={lineRed ? 'gp-red' : ''} style={lineRed ? { color: '#dc2626', fontWeight: 600 } : undefined}>
                        GP {money2(lm.gpDollars)} ({pct(lm.gpPct)}){lineRed ? ` · below ${lineFloorPct}% floor` : ''}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="sheet-section">
                <div className="sheet-section-title">
                  <span>Description (customer reads this)</span>
                  <span className="scope-actions">
                    {linePrePolish[i] != null && (
                      <button type="button" className="link" onClick={() => revertLinePolish(i)}>Undo</button>
                    )}
                    {generateOn && (
                      <button
                        type="button"
                        className="link"
                        onClick={() => void generateForLine(i)}
                        disabled={linePolishBusy != null || scopeBusy || !online}
                      >
                        {linePolishBusy === i || scopeBusy ? 'Working…' : '✨ Generate with AI'}
                      </button>
                    )}
                  </span>
                </div>
                {/* Precedence (prompt 94 B1), stated where it happens: the
                    system's template lands here at pick time, but a rep edit
                    WINS (the save round-trips it verbatim); changing systems
                    over rep text asks first, defaulting to keep. */}
                <textarea
                  data-sheet-desc="1"
                  className="custom-scope"
                  rows={7}
                  value={descValue}
                  onChange={(e) => {
                    if (a.isCustom) setArea(i, { customScope: e.target.value });
                    else { lineDescEditedRef.current.add(i); setArea(i, { lineDescription: e.target.value }); }
                  }}
                  placeholder={a.isCustom
                    ? "Describe this line's work: prep, what gets done, what is excluded…"
                    : 'The scope of work for this line. Picking a system fills it from that system’s template, or type your own.'}
                />
                {lineTokens.length > 0 && (
                  <div className="sheet-token-form">
                    <p className="hint">Fill in the job details below; each answer drops straight into the text. Sending is blocked until every field is filled.</p>
                    {lineTokens.map((t) => (
                      <label className="field" key={t.name}><span>{t.label}</span>
                        <input
                          type={t.type === 'date' ? 'date' : 'text'}
                          value={tokenDraft[`${i}:${t.name}`] ?? ''}
                          onChange={(e) => {
                            const val = e.target.value;
                            setTokenDraft((prev) => ({ ...prev, [`${i}:${t.name}`]: val }));
                            // A date input's change IS the pick: commit now.
                            if (t.type === 'date' && val) commitLineToken(i, t, val);
                          }}
                          onBlur={(e) => commitLineToken(i, t, e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitLineToken(i, t, (e.target as HTMLInputElement).value); } }}
                          placeholder={t.type === 'date' ? '' : t.label}
                        />
                      </label>
                    ))}
                  </div>
                )}
                {a.isCustom && <p className="hint">Used word for word on the customer proposal; the scope writer never rewrites it. Generate cleans up your typed text and can be undone.</p>}
                {!a.isCustom && !tpl && (
                  <p className="warn">
                    {skipReasonByIdx[i] ? `The scope writer skipped this line (${skipReasonByIdx[i]}). ` : `No scope template exists for ${sys?.name ?? 'this system'}, so nothing fills itself in. `}
                    Type the scope here; the customer reads it word for word, and sending stays blocked until it has one.
                  </p>
                )}
                {!a.isCustom && tpl && descValue.trim() !== '' && (
                  <p className="hint">Your edit wins: saves keep this text as-is. Re-picking the system swaps in its template again (it asks first over your own words).</p>
                )}
                {linePolishError[i] && <p className="warn">{linePolishError[i]}</p>}
                {scopeError && <p className="warn">{scopeError}</p>}
              </div>
              <div className="sheet-section">
                <div className="sheet-section-title"><span>Internal notes (never shown to the customer)</span></div>
                <input
                  value={a.notes}
                  onChange={(e) => setArea(i, { notes: e.target.value })}
                  placeholder={a.isCustom ? 'Context for this line…' : "Context for this line's scope (fed to the scope writer)…"}
                />
              </div>
            </BottomSheet>
          );
        }
        const f = addonForms.find((x) => x.key === openLine.key);
        if (!f) return null;
        const qty = Number(f.qty) > 0 ? Number(f.qty) : 1;
        const total = r2(qty * (Number(f.unitPrice) || 0));
        const cat = f.addonId ? addonCatalog.find((x) => x.id === f.addonId) ?? null : null;
        const hasSnippet = !!(cat && cat.scope_snippet && cat.scope_snippet.trim());
        return (
          <BottomSheet
            open
            onClose={close}
            title={`Edit line: ${f.label.trim() || 'One-off'}`}
            breakpointPx={sheetBreakpoint}
            focusSelector={sheetFocusDesc ? 'textarea[data-sheet-desc]' : null}
            footer={<>
              <button
                type="button"
                className="sheet-remove"
                onClick={() => { if (window.confirm('Remove this line from the estimate?')) removeAddonForm(f.key); }}
              >
                Remove line
              </button>
              <button type="button" className="sheet-done" onClick={close}>Done</button>
            </>}
          >
            <div className="sheet-section">
              <div className="sheet-section-title"><span>Line</span><span className={f.addonId ? 'line-chip addon' : 'line-chip custom'}>{f.addonId ? 'catalog add-on' : 'one-off'}</span></div>
              {f.addonId ? (
                <p style={{ margin: 0, fontWeight: 700 }}>{f.label}</p>
              ) : (
                <label className="field"><span>One-off item name</span>
                  <input value={f.label} placeholder="One-off item name" onChange={(e) => setAddonForm(f.key, { label: e.target.value })} />
                </label>
              )}
            </div>
            <div className="sheet-section">
              <div className="sheet-section-title"><span>Pricing</span></div>
              <div className="addon-nums">
                <label className="field"><span>Qty</span><input inputMode="decimal" value={f.qty} onChange={(e) => setAddonForm(f.key, { qty: e.target.value.replace(/[^0-9.]/g, '') })} /></label>
                <label className="field"><span>Price $</span><input inputMode="decimal" value={f.unitPrice} onChange={(e) => setAddonForm(f.key, { unitPrice: e.target.value.replace(/[^0-9.]/g, '') })} /></label>
                <label className="field"><span>Cost $</span><input inputMode="decimal" value={f.unitCost} onChange={(e) => setAddonForm(f.key, { unitCost: e.target.value.replace(/[^0-9.]/g, '') })} /></label>
                <label className="check addon-opt"><input type="checkbox" checked={f.optional} onChange={(e) => setAddonForm(f.key, { optional: e.target.checked })} /><span>Optional (customer picks)</span></label>
                <span className="addon-total">{money2(total)}</span>
              </div>
              {Number(f.unitPrice) > 0 && !(Number(f.unitCost) > 0) && (
                <p className="warn addon-warn">No cost on this line: it books as pure margin and inflates GP until a cost is set{f.addonId ? ' (set a default in the Catalog)' : ''}.</p>
              )}
            </div>
            <div className="sheet-section">
              <div className="sheet-section-title">
                <span>Description (customer reads this)</span>
                <span className="scope-actions">
                  {addonPrePolish[f.key] != null && (
                    <button type="button" className="link" onClick={() => revertAddonPolish(f.key)}>Undo</button>
                  )}
                  {generateOn && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => void generateForAddon(f.key)}
                      disabled={addonPolishBusy != null || scopeBusy || !online}
                    >
                      {addonPolishBusy === f.key || scopeBusy ? 'Working…' : '✨ Generate with AI'}
                    </button>
                  )}
                </span>
              </div>
              <textarea
                data-sheet-desc="1"
                className="custom-scope"
                rows={5}
                value={f.description}
                onChange={(e) => { addonDescEditedRef.current.add(f.key); setAddonForm(f.key, { description: e.target.value }); }}
                placeholder="Description (customer sees this)"
              />
              {hasSnippet && f.description.trim() === '' && (
                <p className="hint">Empty: Generate fills it from the catalog scope language on the next scope write, or type your own.</p>
              )}
              {addonPolishError[f.key] && <p className="warn">{addonPolishError[f.key]}</p>}
            </div>
          </BottomSheet>
        );
      })()}
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
