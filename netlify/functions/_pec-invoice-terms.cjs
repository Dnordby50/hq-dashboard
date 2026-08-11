// Invoice terms shared helpers (2026-08-17, DripJobs-parity phase 1).
//
// The TERM is the rule ('net_30'), the DUE DATE is its resolution (a date
// stamped when the rule's trigger fires: first send for net terms, completion
// for due_on_completion, hand-picked for custom_date). Keeping both lets the
// rule survive resends and lets staff overwrite the date without losing the
// rule. PRECEDENCE (locked with Dylan): when a payment schedule exists, the
// schedule owns every amount and the due box; the terms line is informational
// only. Nothing in this module moves money.
//
// The client mirror in index.html (pecInvoiceTermsLabel / pecInvoiceTermsDue)
// must match this logic. No em dashes in any label: they are customer-facing.

const TERMS_LABELS = {
  due_on_completion: 'Due upon completion',
  due_on_receipt: 'Due upon receipt',
  net_15: 'Net 15',
  net_30: 'Net 30',
  custom_date: 'Due by date',
};

const NET_DAYS = { net_15: 15, net_30: 30 };

// Phoenix has no DST, so a fixed -07:00 offset is always correct.
function phoenixDateOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const shifted = new Date(d.getTime() - 7 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function addDaysToDate(ymd, days) {
  const d = new Date(ymd + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Customer-facing label for the term itself ('' when no term is set: surfaces
// simply skip the line, they never guess).
function termsLabel(terms) {
  return TERMS_LABELS[terms] || '';
}

// The due date a term resolves to, as YYYY-MM-DD or null.
//   net_15 / net_30: first-send Phoenix day + N
//   due_on_completion: the completed date
//   due_on_receipt: the first-send Phoenix day
//   custom_date: only ever hand-set; never computed
function computeDueDate(terms, { firstSentIso = null, completedDate = null } = {}) {
  if (NET_DAYS[terms]) {
    const day = phoenixDateOf(firstSentIso);
    return day ? addDaysToDate(day, NET_DAYS[terms]) : null;
  }
  if (terms === 'due_on_completion') return completedDate || null;
  if (terms === 'due_on_receipt') return phoenixDateOf(firstSentIso);
  return null;
}

// Deterministic commercial rule, first hit wins (mirrored in the 2026-08-17
// migration backfill and the client). companyName must be the BUSINESS name
// (customers.company_name or estimates.customer_company), never
// customers.company (that column is the brand slug).
function isCommercial({ jobClass = null, estimateCommercial = null, companyName = null } = {}) {
  if (jobClass === 'commercial') return true;
  if (jobClass === 'residential') return false;
  if (estimateCommercial === true) return true;
  if (estimateCommercial === false) return false;
  return !!(companyName && String(companyName).trim());
}

// Default term for a new job. `settings` is a {key: value} map (may be empty:
// falls back to Dylan's locked defaults).
function resolveDefaultTerms(who, settings = {}) {
  const commercial = isCommercial(who);
  const key = commercial ? 'invoice_terms_commercial_default' : 'invoice_terms_residential_default';
  const fallback = commercial ? 'net_30' : 'due_on_completion';
  const v = settings[key];
  return TERMS_LABELS[v] ? v : fallback;
}

module.exports = { TERMS_LABELS, NET_DAYS, termsLabel, computeDueDate, isCommercial, resolveDefaultTerms, phoenixDateOf };
