import { supabase } from './supabase';

// The dashboard's lead detail page has a "Start estimate" button that deep-links
// here as /estimator/?lead_id=<uuid>. This module is the estimator side of that
// contract: read the param, prove it is a uuid, and (best effort) load the
// lead's contact block so the customer fields prefill.
//
// Why the uuid check: lead_id is written straight onto estimates.lead_id (a uuid
// column with an FK to leads). A junk value would blow up the outbox POST at
// sync time, on a phone, at a job site, long after the rep hit Save. Rejecting
// it here means a bad link simply produces an unattached estimate instead.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Address stays SPLIT here (build 23): leads already store address/city/
// state/zip separately, and the estimator's customer form is split now too,
// so pre-joining would only force a lossy re-parse on the other side.
export type LeadLink = {
  id: string;
  name: string | null;
  source: string | null;
  phone: string | null;
  email: string | null;
  address1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

export function leadIdFromUrl(search: string = window.location.search): string | null {
  const raw = new URLSearchParams(search).get('lead_id');
  if (!raw) return null;
  const id = raw.trim();
  return UUID_RE.test(id) ? id : null;
}

// The dashboard opens the estimator in an iframe modal as ?embed=1; the app
// hides its own Dashboard link (it is already inside the dashboard) and posts
// save/close messages to the parent instead.
export function embedFromUrl(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get('embed') === '1';
}

// Prompt 76 Part F: a send-gate blocker deep link adds ?focus_line=<sort_order>
// so the estimator opens that line's editor sheet with the description
// focused. Only a small non-negative integer is honored; anything else reads
// as "no focus" (a junk value must never break the open).
export function focusLineFromUrl(search: string = window.location.search): number | null {
  const raw = new URLSearchParams(search).get('focus_line');
  if (raw == null || !/^\d{1,3}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

// Edit-in-place: the estimate page's Edit button reopens the estimator as
// ?estimate_id=<uuid>. Same uuid discipline as lead_id.
export function estimateIdFromUrl(search: string = window.location.search): string | null {
  const raw = new URLSearchParams(search).get('estimate_id');
  if (!raw) return null;
  const id = raw.trim();
  return UUID_RE.test(id) ? id : null;
}

// Contact lookup is a nicety, never a gate: offline (the estimator's normal
// state at a job site) or an RLS denial just leaves the fields null, and the
// estimate still attaches to the lead.
export async function loadLeadLink(id: string | null): Promise<LeadLink | null> {
  if (!id) return null;
  const empty: LeadLink = { id, name: null, source: null, phone: null, email: null, address1: null, city: null, state: null, zip: null };
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('full_name,source,phone,email,address,city,state,zip')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return empty;
    const d = data as {
      full_name: string | null; source: string | null; phone: string | null; email: string | null;
      address: string | null; city: string | null; state: string | null; zip: string | null;
    };
    return {
      id,
      name: d.full_name ?? null,
      source: d.source ?? null,
      phone: d.phone ?? null,
      email: d.email ?? null,
      address1: d.address ?? null,
      city: d.city ?? null,
      state: d.state ?? null,
      zip: d.zip ?? null,
    };
  } catch {
    return empty;
  }
}
