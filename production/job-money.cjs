// Job-side money rules (prompt 90 Task C): the Metrics AR-as-of-date
// predicate and the change-order price mutation, extracted verbatim from
// index.html (which keeps commented client mirrors; no Netlify function
// duplicates either rule today, so this module simply gives them fixtures
// and a single owner before any server twin appears).

const { depositOwed, round2 } = require('./deposits.cjs');

// How much a job contributes to Total AR as of date D, given dollars paid
// through D — the Metrics per-week AR chart's rule, verbatim:
//   completed on/before D -> the unpaid remainder (0 once inside the
//   half-cent epsilon); else signed on/before D with NOTHING paid and the
//   deposit not waived -> the deposit owed; else 0.
// NOTE (pre-existing, documented in renderMetrics): this chart rule
// deliberately diverges from renderInvoicing's live Total AR headline in
// two known ways; extraction pins each rule as it IS, it does not unify
// them (Task C is zero-behavior-change). The headline's bucketing stays
// inline in renderInvoicing — entangled with schedule bridging — and is a
// named follow-up in the 2026-08-12 PROJECT-LOG entry.
function arDueAsOf(job, dateIso, paidThroughDate) {
  const paid = Number(paidThroughDate || 0);
  if (job.completed_date && job.completed_date <= dateIso) {
    return (Number(job.price) - paid > 0.005) ? Number(job.price) - paid : 0;
  }
  if (job.signed_date && job.signed_date <= dateIso && paid <= 0.005 && !job.deposit_waived) {
    return depositOwed(job.deposit_amount, job.price);
  }
  return 0;
}

// A change order appends one is_change_order line item and adds its amount
// to jobs.price (the pec_job_ar view derives the new balance from price).
// Returns { price, line_items }; inputs are never mutated.
function applyChangeOrder(price, lineItems, { name, description, amount }) {
  return {
    price: round2(Number(price || 0) + Number(amount || 0)),
    line_items: (Array.isArray(lineItems) ? lineItems : []).concat([
      { name, description: description || '', price: round2(Number(amount || 0)), is_change_order: true },
    ]),
  };
}

// Tolerate legacy line shapes ({ total } / { unit_price }) the same way the
// invoice renderer does; edits normalize the matched line to { price }.
function coLinePrice(it) {
  const v = it && (it.price ?? it.total ?? it.unit_price);
  return v == null ? null : Number(v);
}

// Find the invoice line a change-order signature row bills through: the SAME
// heuristic the CO card uses to detect orphans (is_change_order + title match
// + amount within half a cent). First match wins; old values are captured
// from a fresh signature-row read before calling, so both layers agree.
function findChangeOrderLine(lineItems, { name, amount }) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const want = String(name || '').trim().toLowerCase();
  return items.findIndex(it => it && it.is_change_order
    && String(it.name || '').trim().toLowerCase() === want
    && Math.abs((coLinePrice(it) || 0) - Number(amount || 0)) < 0.005);
}

// Edit a pending change order's billing: replace its matched line (name,
// description, price; completed flags and any other keys are preserved) and
// move jobs.price by the amount delta. matched:false means the line was
// hand-edited out from under the CO (Edit line items) and NOTHING changed;
// the caller surfaces a reconcile message instead of guessing a line.
// Inputs are never mutated.
function editChangeOrder(price, lineItems, old, next) {
  const idx = findChangeOrderLine(lineItems, old);
  if (idx < 0) return { price: round2(Number(price || 0)), line_items: Array.isArray(lineItems) ? lineItems : [], matched: false };
  const items = (Array.isArray(lineItems) ? lineItems : []).slice();
  const { total, unit_price, ...keep } = items[idx];
  items[idx] = { ...keep, name: next.name, description: next.description || '', price: round2(Number(next.amount || 0)), is_change_order: true };
  return {
    price: round2(Number(price || 0) - Number(old.amount || 0) + Number(next.amount || 0)),
    line_items: items,
    matched: true,
  };
}

// Delete a pending change order's billing: splice exactly its matched line
// and subtract its amount from jobs.price. Same matched:false contract as
// editChangeOrder. Inputs are never mutated.
function removeChangeOrder(price, lineItems, old) {
  const idx = findChangeOrderLine(lineItems, old);
  if (idx < 0) return { price: round2(Number(price || 0)), line_items: Array.isArray(lineItems) ? lineItems : [], matched: false };
  const items = (Array.isArray(lineItems) ? lineItems : []).slice();
  items.splice(idx, 1);
  return { price: round2(Number(price || 0) - Number(old.amount || 0)), line_items: items, matched: true };
}

module.exports = { arDueAsOf, applyChangeOrder, editChangeOrder, removeChangeOrder, findChangeOrderLine };
