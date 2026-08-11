import { supabase } from './supabase';
import { splitLegacyAddress, splitLegacyName, type CustomerForm } from './customer';
import { CUSTOM_LINE_LABEL } from '../offline/estimates';

// Edit-in-place loader: the estimate page's Edit button reopens the estimator
// as ?estimate_id=<uuid>, and this pulls the row + its areas + its line items
// back into form state. Editing is an ONLINE flow by design: it is launched
// from the dashboard (which is online by definition) and rewrites the
// estimate's child rows, which needs a live delete. The offline outbox remains
// the NEW-estimate path.

// A loaded add-on / one-off line (estimate_line_items row). System/area lines
// are NOT loaded into form state: they are regenerated from the areas on save.
export type LoadedAddonLine = {
  addonId: string | null;
  label: string;
  description: string | null;
  qty: number;
  unitPrice: number;
  unitCost: number;
  isOptional: boolean;
  selectedByCustomer: boolean;
};

// One estimate_installments row round-tripped into the schedule card
// (prompt 74). Ready-to-edit shape; empty array = no schedule.
export type LoadedInstallment = {
  seq: number;
  label: string;
  amountKind: 'fixed' | 'percent';
  amountValue: number;
  triggerKind: string;
  dueDate: string | null;
  isDeposit: boolean;
};

export type LoadedEstimate = {
  id: string;
  estimateNumber: number | null;
  status: string;
  // Non-null once the estimate has been sent; with status it decides whether
  // the creator may still change the salesperson (prompt 65 follow-up).
  sentAt: string | null;
  systemTypeId: string | null;
  mvb: 'none' | 'addon' | 'standalone';
  flakeColor: string | null;
  leadId: string | null;
  createdBy: string | null;
  // Ready-to-edit split shape (build 23): mapped from the split columns when
  // present, else derived from the combined customer_name/customer_address so
  // a legacy row still fills the form.
  customer: CustomerForm;
  intake: Record<string, unknown>;
  pricingSnapshot: Record<string, unknown> | null;
  // Non-null means a human edited the scope text: a re-save must MARK IT STALE
  // instead of regenerating (the never-silently-overwrite rule).
  scopeEditedAt: string | null;
  hasScope: boolean;
  // The saved proposal document itself + its stale flag, for the estimator's
  // live proposal panel (build 25). hasScope stays the cheap boolean readers
  // already use; scopeOfWork is the full assembled markdown (null when empty).
  scopeOfWork: string | null;
  scopeStale: boolean;
  scopeAnswers: Record<string, string>;
  priceOverrideReason: string | null;
  // Per-line pricing / custom lines (prompt 69): the new columns round-trip as
  // ready-to-edit input strings (the areas.sqft pattern). A pre-69 row loads
  // them all empty/false and the form behaves exactly as before.
  areas: Array<{
    name: string;
    sqft: string;
    systemTypeId: string | null;
    mvb: boolean;
    slotValues: Record<string, string>;
    isCustom: boolean;
    customLabel: string;
    customScope: string;
    customMaterialCost: string;
    customLaborHours: string;
    notes: string;
    priceOverride: string;
    // Optional lines (prompt 72): hydrated from the AREA columns, never
    // joined back from line items (that select has no area ids; the join
    // would be by position, the fragility these columns exist to avoid).
    isOptional: boolean;
    preselected: boolean;
    // Prompt 74: this area's line-item DESCRIPTION (the AI-assembled scope),
    // round-tripped so a re-save PRESERVES it instead of authoring a new one
    // (the "970 sqft" clobber). Joined by the area id the line carries; empty
    // when the line has no scope yet.
    lineDescription: string;
  }>;
  addonLines: LoadedAddonLine[];
  // Prompt 74: the estimate's payment schedule rows, round-tripped into the
  // schedule card. Empty before the migration or when no schedule exists.
  installments: LoadedInstallment[];
  // Custom estimate mode (build 24). customScope/customPrice are the
  // ready-to-edit form values (customPrice as an input string, same shape as
  // areas.sqft); both empty on a standard estimate.
  isCustom: boolean;
  customScope: string;
  customPrice: string;
  // Typed square footage of a custom estimate (prompt 32), as an input string
  // like customPrice / areas.sqft; empty when not typed or standard.
  customSqft: string;
  // Internal crew brief (prompt 32, Part B); empty when none saved.
  crewNotes: string;
  // Three-lane notes (2026-08-20, DripJobs-parity phase 4). clientNotes is
  // CLIENT VISIBLE (renders on the customer estimate page); companyNotes is
  // INTERNAL ONLY (office). crewNotes above stays crew-work-order-only.
  clientNotes: string;
  companyNotes: string;
};

// Split columns win; a row without them (saved before the migration/backfill)
// falls back to the same naive split the SQL backfill uses, so the form is
// never empty for a named customer. The toggle restores from the stored
// boolean, with "has a company" as the tiebreaker so the two never disagree.
function loadCustomer(e: Record<string, unknown>): CustomerForm {
  const s = (k: string) => {
    const v = e[k];
    return v == null ? '' : String(v);
  };
  const legacyName = splitLegacyName((e.customer_name as string | null) ?? null);
  const hasSplitName = !!(s('customer_first_name') || s('customer_last_name') || s('customer_company'));
  const hasSplitAddress = !!(
    s('customer_address1') || s('customer_address2') || s('customer_city') || s('customer_state') || s('customer_zip')
  );
  const company = s('customer_company');
  return {
    isCommercial: e.customer_is_commercial === true || company.trim() !== '',
    firstName: hasSplitName ? s('customer_first_name') : legacyName.firstName,
    lastName: hasSplitName ? s('customer_last_name') : legacyName.lastName,
    company,
    phone: s('customer_phone'),
    email: s('customer_email'),
    address1: hasSplitAddress
      ? s('customer_address1')
      : splitLegacyAddress((e.customer_address as string | null) ?? null).address1,
    address2: s('customer_address2'),
    city: s('customer_city'),
    state: s('customer_state'),
    zip: s('customer_zip'),
  };
}

export async function loadEstimateForEdit(id: string): Promise<LoadedEstimate | null> {
  const [estRes, areasRes, linesRes] = await Promise.all([
    supabase
      .from('estimates')
      // select('*') on purpose (build 23): the split customer columns arrive
      // by migration, and an explicit list would 400 the whole edit load on a
      // database the migration has not reached yet. Same forward-compat
      // pattern the dashboard uses for pec_prod_job_bonuses.
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle(),
    supabase
      .from('estimate_areas')
      .select('id,name,sqft,system_type_id,mvb,answers,sort_order,is_custom,custom_label,custom_scope,custom_material_cost,custom_labor_hours,notes,calc_price,price_override,is_optional,preselected')
      .eq('estimate_id', id)
      .order('sort_order', { ascending: true }),
    supabase
      .from('estimate_line_items')
      .select('addon_id,estimate_area_id,label,description,qty,unit_price,unit_cost,is_optional,selected_by_customer,sort_order')
      .eq('estimate_id', id)
      .order('sort_order', { ascending: true }),
  ]);
  if (estRes.error) throw estRes.error;
  if (!estRes.data) return null;
  const e = estRes.data as Record<string, unknown>;
  // Prompt 74: each area line's saved DESCRIPTION (the assembled scope),
  // keyed by the area id its line item carries, so the save can write it back
  // verbatim instead of authoring a new one. First line per area wins (an
  // area has at most one system line).
  const descByAreaId = new Map<string, string>();
  for (const li of (((linesRes.error ? [] : linesRes.data) ?? []) as Array<Record<string, unknown>>)) {
    const areaId = li.estimate_area_id;
    if (typeof areaId === 'string' && li.description != null && !descByAreaId.has(areaId)) {
      descByAreaId.set(areaId, String(li.description));
    }
  }
  const areas = ((areasRes.error ? [] : areasRes.data) ?? []).map((a) => {
    const row = a as {
      id: string; name: string | null; sqft: number | null; system_type_id: string | null; mvb: boolean | null;
      answers: Record<string, string> | null; is_custom: boolean | null; custom_label: string | null;
      custom_scope: string | null; custom_material_cost: number | null; custom_labor_hours: number | null;
      notes: string | null; price_override: number | null;
      is_optional: boolean | null; preselected: boolean | null;
    };
    const isCustomLine = row.is_custom === true;
    return {
      name: row.name || (isCustomLine ? (row.custom_label || 'Custom work') : 'Main'),
      sqft: row.sqft != null ? String(row.sqft) : '',
      systemTypeId: row.system_type_id ?? null,
      mvb: row.mvb === true,
      slotValues: row.answers ?? {},
      isCustom: isCustomLine,
      customLabel: row.custom_label != null ? String(row.custom_label) : '',
      customScope: row.custom_scope != null ? String(row.custom_scope) : '',
      customMaterialCost: row.custom_material_cost != null ? String(row.custom_material_cost) : '',
      customLaborHours: row.custom_labor_hours != null ? String(row.custom_labor_hours) : '',
      notes: row.notes != null ? String(row.notes) : '',
      priceOverride: row.price_override != null ? String(row.price_override) : '',
      isOptional: row.is_optional === true,
      preselected: row.preselected !== false,
      // Custom lines keep their scope in custom_scope; the round-tripped line
      // description is only meaningful for CALCULATOR lines.
      lineDescription: !isCustomLine && descByAreaId.has(row.id) ? (descByAreaId.get(row.id) as string) : '',
    };
  });
  // Payment schedule rows (prompt 74). Loaded separately and tolerantly: a
  // database the estimate_installments migration has not reached yet must not
  // 400 the whole edit load (the forward-compat pattern above).
  let installments: LoadedInstallment[] = [];
  try {
    const instRes = await supabase
      .from('estimate_installments')
      .select('seq,label,amount_kind,amount_value,trigger_kind,due_date,is_deposit')
      .eq('estimate_id', id)
      .order('seq', { ascending: true });
    if (!instRes.error) {
      installments = ((instRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        seq: Number(r.seq) || 0,
        label: String(r.label ?? ''),
        amountKind: r.amount_kind === 'fixed' ? 'fixed' : 'percent',
        amountValue: Number(r.amount_value) || 0,
        triggerKind: String(r.trigger_kind ?? 'manual'),
        dueDate: (r.due_date as string | null) ?? null,
        isDeposit: r.is_deposit === true,
      }));
    }
  } catch {
    /* pre-migration */
  }
  // Only add-on / one-off lines round-trip into the form; area/system lines
  // (estimate_area_id set, or no addon_id and not optional with an area) are
  // regenerated from the areas at save time. The discriminator: a line bound
  // to an area is a system line; everything else is add-on or one-off. On a
  // custom estimate the composed price+scope line (CUSTOM_LINE_LABEL) is
  // likewise regenerated from custom_scope/custom_price at save time, so it
  // must not round-trip as a one-off either.
  const isCustom = e.is_custom === true;
  const addonLines: LoadedAddonLine[] = (((linesRes.error ? [] : linesRes.data) ?? []) as Array<Record<string, unknown>>)
    .filter((li) => li.estimate_area_id == null && !(li.addon_id == null && String(li.label || '').endsWith('floor coating system')) && String(li.label || '') !== 'Moisture vapor barrier (MVB)')
    .filter((li) => !(isCustom && li.addon_id == null && String(li.label || '') === CUSTOM_LINE_LABEL))
    .map((li) => ({
      addonId: (li.addon_id as string | null) ?? null,
      label: String(li.label || ''),
      description: (li.description as string | null) ?? null,
      qty: Number(li.qty) > 0 ? Number(li.qty) : 1,
      unitPrice: Number(li.unit_price) || 0,
      unitCost: Number(li.unit_cost) || 0,
      isOptional: li.is_optional === true,
      selectedByCustomer: li.selected_by_customer === true,
    }));
  return {
    id: String(e.id),
    estimateNumber: e.estimate_number != null ? Number(e.estimate_number) : null,
    status: String(e.status || 'draft'),
    sentAt: (e.sent_at as string | null) ?? null,
    systemTypeId: (e.system_type_id as string | null) ?? null,
    mvb: (['none', 'addon', 'standalone'].includes(String(e.mvb)) ? String(e.mvb) : 'none') as 'none' | 'addon' | 'standalone',
    flakeColor: (e.flake_color as string | null) ?? null,
    leadId: (e.lead_id as string | null) ?? null,
    createdBy: (e.created_by as string | null) ?? null,
    customer: loadCustomer(e),
    intake: (e.intake as Record<string, unknown>) ?? {},
    pricingSnapshot: (e.pricing_snapshot as Record<string, unknown> | null) ?? null,
    scopeEditedAt: (e.scope_edited_at as string | null) ?? null,
    hasScope: e.scope_of_work != null && String(e.scope_of_work).trim() !== '',
    scopeOfWork: e.scope_of_work != null && String(e.scope_of_work).trim() !== '' ? String(e.scope_of_work) : null,
    scopeStale: e.scope_stale === true,
    scopeAnswers: (e.scope_answers && typeof e.scope_answers === 'object' ? e.scope_answers : {}) as Record<string, string>,
    priceOverrideReason: (e.price_override_reason as string | null) ?? null,
    // Returned as-is, INCLUDING empty: EstimatorScreen seeds the create-path
    // Main area (with the system's default slot values) when a loaded draft
    // has none. A placeholder here would skip that default seeding.
    areas,
    addonLines,
    installments,
    isCustom,
    customScope: e.custom_scope != null ? String(e.custom_scope) : '',
    customPrice: e.custom_price != null ? String(e.custom_price) : '',
    customSqft: e.custom_sqft != null ? String(e.custom_sqft) : '',
    crewNotes: e.crew_notes != null ? String(e.crew_notes) : '',
    clientNotes: e.client_notes != null ? String(e.client_notes) : '',
    companyNotes: e.company_notes != null ? String(e.company_notes) : '',
  };
}

// Child rewrite for edit-save: the outbox only upserts (idempotent by id), so
// replacing an estimate's areas and line items needs a live delete first.
// LINE ITEMS FIRST: estimate_line_items.estimate_area_id is ON DELETE SET NULL,
// so deleting areas first would orphan the old system lines as area-less rows
// instead of removing them. estimate_area_materials rows cascade from
// estimate_areas.
export async function deleteEstimateChildren(estimateId: string): Promise<void> {
  const items = await supabase.from('estimate_line_items').delete().eq('estimate_id', estimateId);
  if (items.error) throw items.error;
  const areas = await supabase.from('estimate_areas').delete().eq('estimate_id', estimateId);
  if (areas.error) throw areas.error;
  // Payment schedule rows (prompt 74) rewrite like the other children. A
  // missing-table error (pre-migration database) is tolerated: there is
  // nothing to delete and the save enqueues no installment rows either.
  const inst = await supabase.from('estimate_installments').delete().eq('estimate_id', estimateId);
  if (inst.error && !/does not exist|schema cache/i.test(inst.error.message || '')) throw inst.error;
}
