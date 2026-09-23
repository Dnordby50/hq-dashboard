// Shared customer identity matching. Matching a person never decides whether
// a quote request is new: _pec-sales-inquiry and its database RPC own that.
// The legacy recent-lead helper remains exported for compatibility only.

const DEDUPE_WINDOW_DAYS = 90;

// Last 10 digits, so '+1 (928) 555-1212' and '9285551212' match (the same
// normalization pec-lead-intake writes into leads.phone).
function normPhone(s) {
  const d = String(s == null ? '' : s).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : (d || null);
}

// PostgREST or=() clause for "same human": last-10 phone suffix OR exact
// email. Returns the ENCODED clause (ready to embed in a query string) or
// null when there is nothing to match on.
// URL encoding alone does not escape PostgREST's filter grammar. Quote the
// value first, including embedded quotes/backslashes, then encode the clause.
function postgrestLiteral(value) {
  return '"' + String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function sameHumanOr(phone10, email) {
  const parts = [];
  const digits = normPhone(phone10);
  if (digits && digits.length === 10) parts.push(`phone.ilike.*${digits}`);
  if (email) parts.push(`email.eq.${postgrestLiteral(email)}`);
  return parts.length ? encodeURIComponent(parts.join(',')) : null;
}

// The lead-intake dedupe query: newest live lead matching phone/email created
// inside the window (pass windowDays: null for a windowless match). Returns
// the lead row (id, stage, source, customer_id) or null. Never creates.
async function findRecentLiveLead(sb, { phone10, email, now, windowDays = DEDUPE_WINDOW_DAYS } = {}) {
  const or = sameHumanOr(phone10, email);
  if (!or) return null;
  const windowFilter = windowDays
    ? `&created_at=gte.${encodeURIComponent(new Date((now ? now.getTime() : Date.now()) - windowDays * 24 * 60 * 60 * 1000).toISOString())}`
    : '';
  const rows = await sb('GET',
    `/leads?or=(${or})&deleted_at=is.null${windowFilter}&select=id,stage,source,customer_id&order=created_at.desc&limit=1`);
  return (Array.isArray(rows) && rows[0]) || null;
}

// Prompt 89: customers are the source of truth; every lead hangs off one.
// Resolve the person to a live customer row by the SAME same-human rule
// (last-10 phone / exact email), creating the row when nobody matches. Lives
// here so the two intakes and any future lead creator share ONE rule for
// "is this person already a customer?" exactly as they already do for leads.
// Matching is deliberately read-only on hit (no field backfilled onto an
// existing customer: a typo in a web form must never overwrite a curated
// customer record). Brand maps PEC -> 'prescott-epoxy', FTP ->
// 'finishing-touch' (the same mapping pec-public-estimate uses).
async function resolveOrCreateCustomer(db, f = {}) {
  if (!f.name) return { customer_id: null, created: false };
  const customerId = await db('POST', '/rpc/resolve_sales_customer', { p_profile: {
    name: f.name, first_name: f.firstName || null, last_name: f.lastName || null,
    company_name: f.businessName || null, email: f.email || null, phone: f.phone10 || f.phone || null,
    billing_address_line1: f.address || null, billing_city: f.city || null,
    billing_state: f.state || null, billing_zip: f.zip || null, lead_source: f.source || null,
    company: (f.brand === 'FTP' || f.brand === 'finishing-touch') ? 'finishing-touch' : 'prescott-epoxy',
  }});
  if (typeof customerId !== 'string' || !customerId) throw new Error('Customer identity could not be resolved');
  return { customer_id: customerId, created: false };
}

module.exports = { DEDUPE_WINDOW_DAYS, normPhone, postgrestLiteral, sameHumanOr, findRecentLiveLead, resolveOrCreateCustomer };
