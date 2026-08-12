// Commission math (prompt 90 Task C). Extracted verbatim from index.html's
// renderCommission so the money rules are fixture-tested; index.html keeps
// commented client mirrors (no require() in the single-file dashboard). No
// Netlify function computes commission today, so this module is the future
// server surface's ready-made authority.
//
// The attribution model (unchanged): pec_job_ar.salesperson is FREE TEXT
// frozen at estimate time, so rates resolve by lowercased name with
// name_aliases as the rename safety net (current names load first and
// always win; an alias never overrides another member's live name), and
// exclude_from_commission members (plus their aliases) vanish from the
// report entirely. Commission is earned on COLLECTED dollars: each payment
// line earns round2(amount * pct / 100).

const round2 = (n) => Math.round(n * 100) / 100;

// One payment's commission at a given percent. pct null/0 earns 0.
function commissionForPayment(amount, pct) {
  return round2(Number(amount || 0) * ((pct || 0) / 100));
}

// Rate + exclusion resolution from pec_sales_team_members rows:
// { pctByName: { lowername: pct }, excludedNames: Set<lowername> }.
function buildCommissionRates(teamRows) {
  const rows = Array.isArray(teamRows) ? teamRows : [];
  const pctByName = {};
  for (const m of rows) pctByName[String(m.name || '').toLowerCase()] = Number(m.commission_pct || 0);
  for (const m of rows) for (const a of (m.name_aliases || [])) {
    const k = String(a || '').toLowerCase();
    if (k && !(k in pctByName)) pctByName[k] = Number(m.commission_pct || 0);
  }
  const excludedNames = new Set(rows.filter(m => m.exclude_from_commission)
    .flatMap(m => [m.name, ...(m.name_aliases || [])]).map(n => String(n || '').toLowerCase()));
  return { pctByName, excludedNames };
}

// Pay-cycle date helpers (UTC string math, no timezone surprises): the
// correlating payday Friday for a receipt date, and the Sun-Sat pay period
// a payday Friday closes.
const parseDay = (d) => d ? new Date(String(d).slice(0, 10) + 'T00:00:00Z') : null;
function addDays(d, n) { const x = parseDay(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function commissionFriday(dateStr) {
  const d = parseDay(dateStr); if (!d) return dateStr;
  return addDays(dateStr, (5 - d.getUTCDay() + 7) % 7);
}
function commissionPeriod(dateStr) {
  const d = parseDay(dateStr); if (!d) return { start: dateStr, end: dateStr };
  const start = addDays(dateStr, -d.getUTCDay());
  return { start, end: addDays(start, 6) };
}

module.exports = { commissionForPayment, buildCommissionRates, commissionFriday, commissionPeriod, round2 };
