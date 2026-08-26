import { supabase } from './supabase';
import type { CustomerForm } from './customer';
import { splitLegacyName } from './customer';

// Duplicate-customer search for the estimator (prompt 44). Searches BOTH
// public.customers and leads by name, phone, email, and address so a rep
// starting an estimate finds the existing record instead of typing a
// duplicate. Picking a match prefills the CustomerForm AND links the estimate
// via lead_id (the spine every downstream reader keys off: drips,
// appointments). A matched CUSTOMER with no lead gets one found-or-created
// here, because estimates has no customer_id column and adding one was
// rejected in favor of the lead spine.
//
// Online-only by design: the caller hides the search offline; the offline
// save path (outbox) is untouched.

export type CustomerMatch = {
  kind: 'customer' | 'lead';
  id: string;
  // For kind 'lead' this IS the id; for 'customer' it is the lead found or
  // created at pick time (ensureLeadForCustomer), not known at search time.
  name: string;
  phone: string | null;
  email: string | null;
  addressLine: string | null;
  // The record's stored attribution (customers.lead_source / leads.source);
  // prefills the estimator's required Lead source picker so an existing
  // record never forces a redundant re-pick.
  leadSource: string | null;
  form: CustomerForm;
};

const t = (s: string | null | undefined) => (s ?? '').trim();

// PostgREST .or() strings are comma/paren-delimited, so strip the delimiters
// (and the pattern wildcards) out of the typed query rather than trying to
// escape them.
const sanitize = (q: string) => q.replace(/[,()*%]/g, ' ').replace(/\s+/g, ' ').trim();

function customerToForm(c: CustomerRow): CustomerForm {
  const legacy = splitLegacyName(c.name);
  return {
    isCommercial: !!t(c.company_name),
    firstName: t(c.first_name) || legacy.firstName,
    lastName: t(c.last_name) || legacy.lastName,
    company: t(c.company_name),
    phone: t(c.phone),
    email: t(c.email),
    address1: t(c.billing_address_line1),
    address2: t(c.billing_address_line2),
    city: t(c.billing_city),
    state: t(c.billing_state),
    zip: t(c.billing_zip),
  };
}

function leadToForm(l: LeadRow): CustomerForm {
  const legacy = splitLegacyName(l.full_name);
  return {
    isCommercial: false,
    firstName: t(l.first_name) || legacy.firstName,
    lastName: t(l.last_name) || legacy.lastName,
    company: '',
    phone: t(l.phone),
    email: t(l.email),
    address1: t(l.address),
    address2: '',
    city: t(l.city),
    state: t(l.state),
    zip: t(l.zip),
  };
}

type CustomerRow = {
  id: string; name: string; first_name: string | null; last_name: string | null;
  company_name: string | null; email: string | null; phone: string | null;
  lead_source: string | null;
  billing_address_line1: string | null; billing_address_line2: string | null;
  billing_city: string | null; billing_state: string | null; billing_zip: string | null;
};
type LeadRow = {
  id: string; full_name: string | null; first_name: string | null; last_name: string | null;
  email: string | null; phone: string | null; source: string | null; address: string | null;
  city: string | null; state: string | null; zip: string | null; customer_id: string | null;
};

export async function searchCustomersAndLeads(rawQuery: string): Promise<CustomerMatch[]> {
  const q = sanitize(rawQuery);
  if (q.length < 2) return [];
  const pat = `*${q}*`;
  const digits = q.replace(/\D/g, '');
  // phone_norm (generated digits-only column on both tables) makes a typed
  // "(928) 555-0147" match "9285550147" and vice versa.
  const phoneClause = digits.length >= 4 ? (col: string) => `,${col}.ilike.*${digits}*` : () => '';

  const [custRes, leadRes] = await Promise.all([
    supabase
      .from('customers')
      .select('id,name,first_name,last_name,company_name,email,phone,lead_source,billing_address_line1,billing_address_line2,billing_city,billing_state,billing_zip')
      .is('archived_at', null)
      .or(`name.ilike.${pat},first_name.ilike.${pat},last_name.ilike.${pat},company_name.ilike.${pat},email.ilike.${pat},billing_address_line1.ilike.${pat}${phoneClause('phone_norm')}`)
      .limit(8),
    supabase
      .from('leads')
      .select('id,full_name,first_name,last_name,email,phone,source,address,city,state,zip,customer_id')
      .is('deleted_at', null)
      .or(`full_name.ilike.${pat},first_name.ilike.${pat},last_name.ilike.${pat},email.ilike.${pat},address.ilike.${pat}${phoneClause('phone_norm')}`)
      .limit(8),
  ]);
  if (custRes.error) throw custRes.error;
  if (leadRes.error) throw leadRes.error;

  const leads = (leadRes.data ?? []) as LeadRow[];
  // A lead that references a matched customer IS that customer's live record;
  // showing both rows would read as two different people.
  const leadCustomerIds = new Set(leads.map((l) => l.customer_id).filter(Boolean));
  const customers = ((custRes.data ?? []) as CustomerRow[]).filter((c) => !leadCustomerIds.has(c.id));

  const matches: CustomerMatch[] = [
    ...leads.map((l): CustomerMatch => ({
      kind: 'lead',
      id: l.id,
      name: t(l.full_name) || [t(l.first_name), t(l.last_name)].filter(Boolean).join(' ') || '(no name)',
      phone: t(l.phone) || null,
      email: t(l.email) || null,
      addressLine: [t(l.address), t(l.city)].filter(Boolean).join(', ') || null,
      leadSource: t(l.source) || null,
      form: leadToForm(l),
    })),
    ...customers.map((c): CustomerMatch => ({
      kind: 'customer',
      id: c.id,
      name: t(c.company_name) || t(c.name) || '(no name)',
      phone: t(c.phone) || null,
      email: t(c.email) || null,
      addressLine: [t(c.billing_address_line1), t(c.billing_city)].filter(Boolean).join(', ') || null,
      leadSource: t(c.lead_source) || null,
      form: customerToForm(c),
    })),
  ];
  // Rank: name hits first (starts-with above contains), everything else after,
  // stable within tiers so the DB order (and lead-before-customer) survives.
  const ql = q.toLowerCase();
  const tier = (m: CustomerMatch) => {
    const n = m.name.toLowerCase();
    if (n.startsWith(ql)) return 0;
    if (n.includes(ql)) return 1;
    return 2;
  };
  return matches
    .map((m, i) => ({ m, i }))
    .sort((a, b) => tier(a.m) - tier(b.m) || a.i - b.i)
    .map((x) => x.m);
}

// The link target is ALWAYS a lead (estimates.lead_id). For a customer match:
// reuse their newest live lead, else create one from the customer's contact
// block. Insert failures bubble to the caller, which degrades to
// prefill-without-link (never blocks the estimate).
export async function ensureLeadForCustomer(customerId: string, form: CustomerForm, source?: string | null): Promise<string> {
  const existing = await supabase
    .from('leads')
    .select('id')
    .eq('customer_id', customerId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (existing.error) throw existing.error;
  const row = (existing.data ?? [])[0] as { id: string } | undefined;
  if (row) return row.id;

  const fullName = t(form.company) || [t(form.firstName), t(form.lastName)].filter(Boolean).join(' ') || null;
  const ins = await supabase
    .from('leads')
    .insert({
      customer_id: customerId,
      // The rep's picked lead source when one is known (the customer's
      // stored attribution or the estimator picker); 'estimator' only as the
      // last resort so attribution reports stop seeing a tool name.
      source: (source ?? '').trim() || 'estimator',
      first_name: t(form.firstName) || null,
      last_name: t(form.lastName) || null,
      full_name: fullName,
      email: t(form.email) || null,
      phone: t(form.phone) || null,
      address: t(form.address1) || null,
      city: t(form.city) || null,
      state: t(form.state) || null,
      zip: t(form.zip) || null,
    })
    .select('id')
    .single();
  if (ins.error) throw ins.error;
  return (ins.data as { id: string }).id;
}
