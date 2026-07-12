import { supabase } from './supabase';

// Edit-in-place loader: the estimate page's Edit button reopens the estimator
// as ?estimate_id=<uuid>, and this pulls the row + its areas back into form
// state. Editing is an ONLINE flow by design: it is launched from the dashboard
// (which is online by definition) and rewrites the estimate's child area rows,
// which needs a live delete. The offline outbox remains the NEW-estimate path.

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
  areas: Array<{ name: string; sqft: string; slotValues: Record<string, string> }>;
};

export async function loadEstimateForEdit(id: string): Promise<LoadedEstimate | null> {
  const [estRes, areasRes] = await Promise.all([
    supabase
      .from('estimates')
      .select('id,estimate_number,status,system_type_id,mvb,flake_color,lead_id,created_by,customer_name,customer_phone,customer_email,customer_address,intake,pricing_snapshot')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle(),
    supabase
      .from('estimate_areas')
      .select('name,sqft,answers,sort_order')
      .eq('estimate_id', id)
      .order('sort_order', { ascending: true }),
  ]);
  if (estRes.error) throw estRes.error;
  if (!estRes.data) return null;
  const e = estRes.data as Record<string, unknown>;
  const areas = ((areasRes.error ? [] : areasRes.data) ?? []).map((a) => {
    const row = a as { name: string | null; sqft: number | null; answers: Record<string, string> | null };
    return {
      name: row.name || 'Main',
      sqft: row.sqft != null ? String(row.sqft) : '',
      slotValues: row.answers ?? {},
    };
  });
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
    areas: areas.length ? areas : [{ name: 'Main', sqft: '', slotValues: {} }],
  };
}

// Area rewrite for edit-save: the outbox only upserts (idempotent by id), so
// replacing an estimate's areas needs a live delete first. estimate_area_materials
// rows cascade from estimate_areas.
export async function deleteEstimateAreas(estimateId: string): Promise<void> {
  const { error } = await supabase.from('estimate_areas').delete().eq('estimate_id', estimateId);
  if (error) throw error;
}
