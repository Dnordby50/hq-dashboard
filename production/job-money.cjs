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

module.exports = { arDueAsOf, applyChangeOrder };
