import { supabase } from './supabase';

// The dashboard's lead detail page has a "Start estimate" button that deep-links
// here as /estimator/?lead_id=<uuid>. This module is the estimator side of that
// contract: read the param, prove it is a uuid, and (best effort) put a name on
// it so the rep can see WHICH lead the estimate will attach to.
//
// Why the uuid check: lead_id is written straight onto estimates.lead_id (a uuid
// column with an FK to leads). A junk value would blow up the outbox POST at
// sync time, on a phone, at a job site, long after the rep hit Save. Rejecting
// it here means a bad link simply produces an unattached estimate instead.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LeadLink = { id: string; name: string | null };

export function leadIdFromUrl(search: string = window.location.search): string | null {
  const raw = new URLSearchParams(search).get('lead_id');
  if (!raw) return null;
  const id = raw.trim();
  return UUID_RE.test(id) ? id : null;
}

// Name lookup is a nicety, never a gate: offline (the estimator's normal state
// at a job site) or an RLS denial just leaves name null, and the estimate still
// attaches to the lead.
export async function loadLeadLink(id: string | null): Promise<LeadLink | null> {
  if (!id) return null;
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('full_name')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return { id, name: null };
    return { id, name: (data as { full_name: string | null }).full_name ?? null };
  } catch {
    return { id, name: null };
  }
}
