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

module.exports = { DEDUPE_WINDOW_DAYS, normPhone, sameHumanOr, findRecentLiveLead };
