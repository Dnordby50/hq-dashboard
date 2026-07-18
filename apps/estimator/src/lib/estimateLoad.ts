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

export type LoadedEstimate = {
  id: string;
  estimateNumber: number | null;
  status: string;
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
  areas: Array<{ name: string; sqft: string; systemTypeId: string | null; mvb: boolean; slotValues: Record<string, string> }>;
  addonLines: LoadedAddonLine[];
  // Custom estimate mode (build 24). customScope/customPrice are the
  // ready-to-edit form values (customPrice as an input string, same shape as
  // areas.sqft); both empty on a standard estimate.
  isCustom: boolean;
  customScope: string;
  customPrice: string;
  // Typed square footage of a custom estimate (prompt 32), as an input string
  // like customPrice / areas.sqft; empty when not typed or standard.
  customSqft: string;
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
      .select('name,sqft,system_type_id,mvb,answers,sort_order')
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
  const areas = ((areasRes.error ? [] : areasRes.data) ?? []).map((a) => {
    const row = a as { name: string | null; sqft: number | null; system_type_id: string | null; mvb: boolean | null; answers: Record<string, string> | null };
    return {
      name: row.name || 'Main',
      sqft: row.sqft != null ? String(row.sqft) : '',
      systemTypeId: row.system_type_id ?? null,
      mvb: row.mvb === true,
      slotValues: row.answers ?? {},
    };
  });
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
    areas: areas.length ? areas : [{ name: 'Main', sqft: '', systemTypeId: null, mvb: false, slotValues: {} }],
    addonLines,
    isCustom,
    customScope: e.custom_scope != null ? String(e.custom_scope) : '',
    customPrice: e.custom_price != null ? String(e.custom_price) : '',
    customSqft: e.custom_sqft != null ? String(e.custom_sqft) : '',
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
}
