// Prompt 74: the estimate-side payment schedule. Pure math shared by the
// estimator PWA (the schedule card), pec-public-estimate.cjs (the customer
// render, the accept-time freeze, and the copy to pec_invoice_installments),
// and the send gate, with fixture tests driving the same code (the
// optional-lines.cjs pattern).
//
// Row shape everywhere here is the estimate_installments ROW shape:
//   { seq, label, amount_kind: 'fixed'|'percent', amount_value,
//     trigger_kind, due_date, is_deposit }
//
// ALL MONEY IS IN CENTS inside this module (locked decision 7: the signed
// schedule matches the signed total to the cent). Callers convert once at the
// boundary. The public estimate page carries a client mirror of
// computeScheduleCents in its inline recompute script -- keep the two in
// lockstep (the pecInstallmentAsk / resolveCurrentAsk convention).
'use strict';

// The deposit-percent resolution shared with the job side. SAME precedence as
// prepareDepositInstallment in netlify/functions/_pec-installments.cjs (which
// now calls this): the system type's deposit_pct, else settings
// default_deposit_pct, else the code's long-standing 50 fallback.
function resolveDepositPct(systemDepositPct, settingDepositPct) {
  const sys = Number(systemDepositPct);
  if (Number.isFinite(sys) && sys > 0) return sys;
  const def = Number(settingDepositPct);
  if (Number.isFinite(def) && def > 0) return def;
  return 50;
}

// The default two-row schedule seeded on first open of the schedule editor
// (locked decision 5): deposit at the resolved percent due at signing, the
// remainder due at completion. Labels are customer-facing: no em dashes.
function defaultScheduleRows(depositPct) {
  const pct = Math.min(100, Math.max(0, Number(depositPct) || 0)) || 50;
  return [
    { seq: 0, label: 'Deposit', amount_kind: 'percent', amount_value: pct, trigger_kind: 'on_acceptance', due_date: null, is_deposit: true },
    { seq: 1, label: 'Balance at completion', amount_kind: 'percent', amount_value: Math.round((100 - pct) * 100) / 100, trigger_kind: 'on_completion', due_date: null, is_deposit: false },
  ];
}

// One row's UNROUNDED cents at a given total. Percent rows scale with the
// total; fixed rows do not.
function rowCentsExact(row, totalCents) {
  if (!row) return 0;
  const v = Number(row.amount_value) || 0;
  if (row.amount_kind === 'percent') return (Number(totalCents) || 0) * v / 100;
  return Math.round(v * 100);
}

// Structural validation (estimator card + send gate rule 4): the schedule must
// resolve to EXACTLY the estimate total. Percent-only schedules must sum to
// 100; fixed rows must combine with the percent rows to land on the total.
// Sub-cent drift from percent rounding is NOT an error (the allocator's
// last-row absorption exists for exactly that). Returns null when valid, else
// { message, diffCents } with diffCents signed (positive = schedule is OVER
// the total) so the UI can show the live shortfall/overage in dollars.
function scheduleValidationError(rows, totalCents) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (!list.length) return null; // no schedule = no schedule, never an error
  if (list.filter((r) => r.is_deposit === true).length > 1) {
    return { message: 'Only one row can be the deposit.', diffCents: 0 };
  }
  for (const r of list) {
    const v = Number(r.amount_value);
    if (!Number.isFinite(v) || v < 0) {
      return { message: `"${r.label || 'Installment'}" needs an amount.`, diffCents: 0 };
    }
    if (r.amount_kind === 'percent' && v > 100) {
      return { message: `"${r.label || 'Installment'}" is more than 100 percent.`, diffCents: 0 };
    }
  }
  const total = Number(totalCents) || 0;
  const sumExact = list.reduce((s, r) => s + rowCentsExact(r, total), 0);
  const diff = sumExact - total;
  if (Math.abs(diff) >= 0.5) {
    const usd = (c) => '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return {
      message: diff > 0
        ? `The schedule adds up to ${usd(diff)} MORE than the estimate total.`
        : `The schedule is ${usd(diff)} short of the estimate total.`,
      diffCents: Math.round(diff),
    };
  }
  return null;
}

// Resolve every row to whole cents that sum to totalCents EXACTLY.
//
// Normal path: each row except the LAST gets its rounded amount (percent of
// the current total, or its fixed cents); the last row absorbs the remainder,
// so rounding pennies and customer-driven total changes both land there
// (locked decision 7 + the C4 rule: dollar rows stay fixed, the final row
// absorbs the difference).
//
// Clamp path: when a fixed row would exceed the new total after a big decline
// (the last row's remainder would go negative), the WHOLE schedule is
// recomputed as proportions of what each row was worth at the ORIGINAL total,
// allocated over the new total (largest share of the original = largest share
// of the new). Never renders a negative installment.
function computeScheduleCents(rows, totalCents, originalTotalCents) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (!list.length) return [];
  const total = Math.max(0, Math.round(Number(totalCents) || 0));

  const rounded = list.map((r) => Math.round(rowCentsExact(r, total)));
  const sumOthers = rounded.slice(0, -1).reduce((s, c) => s + c, 0);
  const last = total - sumOthers;
  if (last >= 0) {
    rounded[rounded.length - 1] = last;
    return rounded;
  }

  // Clamp: proportional re-allocation over the new total, weighted by each
  // row's dollars at the original total (falling back to the new total when
  // no original was given).
  const origTotal = Math.max(0, Math.round(Number(originalTotalCents != null ? originalTotalCents : totalCents) || 0));
  const weights = list.map((r) => Math.max(0, rowCentsExact(r, origTotal)));
  const wsum = weights.reduce((s, w) => s + w, 0);
  if (!(wsum > 0)) {
    const out = list.map(() => 0);
    out[out.length - 1] = total;
    return out;
  }
  const out = weights.map((w) => Math.floor(total * w / wsum));
  // Remainder cents to the LAST row (the balance line), per the rounding rule.
  const allocated = out.reduce((s, c) => s + c, 0);
  out[out.length - 1] += total - allocated;
  return out;
}

// The frozen record written into estimates.signature at accept and copied to
// pec_invoice_installments: every row's label, trigger, kind/value, and the
// FINAL computed dollars at the signed total. This is what the customer
// agreed to.
function freezeSchedule(rows, totalCents) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const cents = computeScheduleCents(list, totalCents);
  return list.map((r, i) => ({
    seq: r.seq != null ? Number(r.seq) : i,
    label: String(r.label || ''),
    amount_kind: r.amount_kind === 'fixed' ? 'fixed' : 'percent',
    amount_value: Number(r.amount_value) || 0,
    trigger_kind: r.trigger_kind || 'manual',
    due_date: r.due_date || null,
    is_deposit: r.is_deposit === true,
    computed_amount: (cents[i] || 0) / 100,
  }));
}

// Assertion helper used by renders and tests: the resolved rows must sum to
// the displayed total exactly.
function scheduleSumsToTotal(cents, totalCents) {
  const sum = (Array.isArray(cents) ? cents : []).reduce((s, c) => s + (Number(c) || 0), 0);
  return sum === Math.max(0, Math.round(Number(totalCents) || 0));
}

// Plain-language due phrasing for the customer page (no em dashes).
function triggerLabel(triggerKind, dueDate) {
  switch (triggerKind) {
    case 'on_acceptance': return 'Due at signing';
    case 'on_start': return 'Due when the job starts';
    case 'on_completion': return 'Due at completion';
    case 'date': return dueDate ? `Due ${dueDate}` : 'Due by date';
    default: return 'Invoiced separately';
  }
}

module.exports = {
  resolveDepositPct,
  defaultScheduleRows,
  rowCentsExact,
  scheduleValidationError,
  computeScheduleCents,
  freezeSchedule,
  scheduleSumsToTotal,
  triggerLabel,
};
