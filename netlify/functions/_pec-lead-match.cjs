// Shared "same human" lead matching (prompt 56, landmine 2). Extracted from
// pec-lead-intake.cjs so every intake path that must decide "is this person
// already a lead?" uses ONE rule: a live (not soft-deleted) lead whose
// normalized last-10 phone or exact lowercased email matches. Two callers:
//   - pec-lead-intake.cjs: dedupe 2 (same person re-inquiring inside the
//     90-day window folds onto the existing lead).
//   - pec-appt-intake.cjs: the Routemize adapter both links appointments to
//     leads (windowless: an old lead booking an estimate is exactly the
//     linkage we want) and guards its create-a-lead path (decision 9) with
//     the same windowed dedupe as lead-intake, so the two intakes cannot
//     drift apart on what counts as a duplicate.

const { randomToken } = require('./_pec-supabase.cjs');

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
function sameHumanOr(phone10, email) {
  const parts = [];
  if (phone10) parts.push(`phone.ilike.*${phone10}`);
  if (email) parts.push(`email.eq.${email}`);
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
  const or = sameHumanOr(f.phone10, f.email);
  if (or) {
    const rows = await db('GET',
      `/customers?or=(${or})&archived_at=is.null&select=id&order=created_at.desc&limit=1`);
    if (Array.isArray(rows) && rows[0]) return { customer_id: rows[0].id, created: false };
  }
  if (!f.name) return { customer_id: null, created: false }; // nothing to create from
  const created = await db('POST', '/customers', {
    token: randomToken(),
    name: f.name,
    first_name: f.firstName || null,
    last_name: f.lastName || null,
    company_name: f.businessName || null,
    email: f.email || null,
    phone: f.phone10 || f.phone || null,
    billing_address_line1: f.address || null,
    billing_city: f.city || null,
    billing_state: f.state || null,
    billing_zip: f.zip || null,
    lead_source: f.source || null,
    company: (f.brand === 'FTP' || f.brand === 'finishing-touch') ? 'finishing-touch' : 'prescott-epoxy',
  }, true);
  const row = Array.isArray(created) && created[0];
  if (!row) throw new Error('customer insert returned no row');
  return { customer_id: row.id, created: true };
}

module.exports = { DEDUPE_WINDOW_DAYS, normPhone, sameHumanOr, findRecentLiveLead, resolveOrCreateCustomer };
