import { supabase } from './supabase';

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
  customer: { name: string | null; phone: string | null; email: string | null; address: string | null };
  intake: Record<string, unknown>;
  pricingSnapshot: Record<string, unknown> | null;
  // Non-null means a human edited the scope text: a re-save must MARK IT STALE
  // instead of regenerating (the never-silently-overwrite rule).
  scopeEditedAt: string | null;
  hasScope: boolean;
  scopeAnswers: Record<string, string>;
  areas: Array<{ name: string; sqft: string; systemTypeId: string | null; slotValues: Record<string, string> }>;
  addonLines: LoadedAddonLine[];
};

export async function loadEstimateForEdit(id: string): Promise<LoadedEstimate | null> {
  const [estRes, areasRes, linesRes] = await Promise.all([
    supabase
      .from('estimates')
      .select('id,estimate_number,status,system_type_id,mvb,flake_color,lead_id,created_by,customer_name,customer_phone,customer_email,customer_address,intake,pricing_snapshot,scope_edited_at,scope_of_work,scope_answers')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle(),
    supabase
      .from('estimate_areas')
      .select('name,sqft,system_type_id,answers,sort_order')
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
    const row = a as { name: string | null; sqft: number | null; system_type_id: string | null; answers: Record<string, string> | null };
    return {
      name: row.name || 'Main',
      sqft: row.sqft != null ? String(row.sqft) : '',
      systemTypeId: row.system_type_id ?? null,
      slotValues: row.answers ?? {},
    };
  });
  // Only add-on / one-off lines round-trip into the form; area/system lines
  // (estimate_area_id set, or no addon_id and not optional with an area) are
  // regenerated from the areas at save time. The discriminator: a line bound
  // to an area is a system line; everything else is add-on or one-off.
  const addonLines: LoadedAddonLine[] = (((linesRes.error ? [] : linesRes.data) ?? []) as Array<Record<string, unknown>>)
    .filter((li) => li.estimate_area_id == null && !(li.addon_id == null && String(li.label || '').endsWith('floor coating system')) && String(li.label || '') !== 'Moisture vapor barrier (MVB)')
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
    customer: {
      name: (e.customer_name as string | null) ?? null,
      phone: (e.customer_phone as string | null) ?? null,
      email: (e.customer_email as string | null) ?? null,
      address: (e.customer_address as string | null) ?? null,
    },
    intake: (e.intake as Record<string, unknown>) ?? {},
    pricingSnapshot: (e.pricing_snapshot as Record<string, unknown> | null) ?? null,
    scopeEditedAt: (e.scope_edited_at as string | null) ?? null,
    hasScope: e.scope_of_work != null && String(e.scope_of_work).trim() !== '',
    scopeAnswers: (e.scope_answers && typeof e.scope_answers === 'object' ? e.scope_answers : {}) as Record<string, string>,
    areas: areas.length ? areas : [{ name: 'Main', sqft: '', systemTypeId: null, slotValues: {} }],
    addonLines,
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
