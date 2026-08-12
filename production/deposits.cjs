// The deposit-owed rule (prompt 90 Task C). Before extraction this exact
// formula lived in NINE places: five inline copies in index.html
// (renderInvoicing, the invoice row render, the payment-form default, the
// auto-mark-collected check, the Metrics AR chart) and four in functions
// (pec-public-invoice, pec-stripe-checkout, pec-stripe-webhook,
// pec-public-estimate) — the textbook surface-disagreement setup. The four
// functions now require this file; index.html carries a commented client
// mirror (pecDepositOwed / pecCoversDeposit), the same pattern as
// optional-lines.cjs.
//
// THE RULE, verbatim from every copy: an explicit jobs.deposit_amount wins;
// otherwise the deposit owed is 50% of price. DELIBERATELY not the same as
// estimate-installments.cjs resolveDepositPct (which resolves a PERCENT
// through system-type and settings for building a schedule): this is the
// collection-side "how many dollars until the deposit is satisfied" rule,
// and it has always hardwired 50%. Changing that behavior is out of scope
// here (Task C is zero-behavior-change); the fixture pins what IS.

const round2 = (n) => Math.round(n * 100) / 100;
const EPS = 0.005;

// Dollars owed for the deposit. deposit_amount (nullable) wins; else 50% of
// price. Null/undefined price reads as 0 (matching Number(null) === 0 at
// every original call site).
function depositOwed(depositAmount, price) {
  return depositAmount != null ? round2(Number(depositAmount)) : round2(Number(price || 0) * 0.5);
}

// True when a payment being recorded pushes total paid past the owed
// deposit (the dashboard's auto-mark deposit_collected rule, and the Stripe
// webhook's settlement-side twin): waived never needs collecting, and the
// half-cent epsilon absorbs float drift.
function coversDeposit({ paidToDate, amount, owed, waived }) {
  if (waived) return false;
  return Number(paidToDate || 0) + Number(amount || 0) + EPS >= Number(owed || 0);
}

module.exports = { depositOwed, coversDeposit, round2, EPS };
