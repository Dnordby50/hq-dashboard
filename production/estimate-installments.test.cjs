// Fixture test for the estimate-side payment schedule math (prompt 74),
// driving the SAME production/estimate-installments.cjs module the estimator
// card, the customer page, and the accept-time freeze use, plus the shared
// scope send-gate rules in production/optional-lines.cjs.
// Run: node production/estimate-installments.test.cjs
'use strict';
const {
  resolveDepositPct, defaultScheduleRows, scheduleValidationError,
  computeScheduleCents, freezeSchedule, scheduleSumsToTotal, triggerLabel,
} = require('./estimate-installments.cjs');
const { scopeSendBlockers, CLOBBER_DESC_RE, CLOBBER_DESC_EXACT_RE, isMvbOnlyLineLabel } = require('./optional-lines.cjs');
const { makeChecker } = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

const pctRow = (pct, extra) => ({ seq: 0, label: 'Row', amount_kind: 'percent', amount_value: pct, trigger_kind: 'manual', due_date: null, is_deposit: false, ...extra });
const fixRow = (usd, extra) => ({ seq: 0, label: 'Row', amount_kind: 'fixed', amount_value: usd, trigger_kind: 'manual', due_date: null, is_deposit: false, ...extra });

(() => {
  console.log('# resolveDepositPct: system > setting > 50 (mirrors prepareDepositInstallment)');
  {
    ok(resolveDepositPct(30, 40) === 30, 'system deposit_pct wins');
    ok(resolveDepositPct(null, 40) === 40, 'settings default_deposit_pct next');
    ok(resolveDepositPct(0, null) === 50, 'zero/absent everywhere falls back to 50');
    ok(resolveDepositPct('junk', '') === 50, 'unparseable values fall back to 50');
  }

  console.log('# defaultScheduleRows: deposit + balance, percent, summing to 100');
  {
    const rows = defaultScheduleRows(50);
    ok(rows.length === 2 && rows[0].is_deposit === true && rows[1].is_deposit === false, 'two rows, deposit first');
    ok(rows[0].amount_value === 50 && rows[1].amount_value === 50, '50/50 at the default');
    ok(rows[0].trigger_kind === 'on_acceptance' && rows[1].trigger_kind === 'on_completion', 'signing then completion');
    const r30 = defaultScheduleRows(30);
    ok(r30[0].amount_value === 30 && r30[1].amount_value === 70, 'seed follows the resolved percent');
  }

  console.log('# scheduleValidationError: must resolve to exactly the total');
  {
    ok(scheduleValidationError([], 100000) === null, 'no rows, no error (schedule deleted = page as today)');
    ok(scheduleValidationError([pctRow(50), pctRow(50)], 100000) === null, 'percent rows summing to 100 pass');
    const short = scheduleValidationError([pctRow(50), pctRow(47)], 100000);
    ok(short && short.diffCents === -3000 && /short/.test(short.message), '97% is named as short, in dollars');
    const over = scheduleValidationError([pctRow(60), pctRow(50)], 100000);
    ok(over && over.diffCents === 10000 && /MORE/.test(over.message), '110% is named as over');
    ok(scheduleValidationError([fixRow(400), fixRow(600)], 100000) === null, 'fixed rows summing to the total pass');
    ok(scheduleValidationError([fixRow(400), pctRow(60)], 100000) === null, 'a mix resolving exactly to the total passes');
    ok(scheduleValidationError([fixRow(500), pctRow(60)], 100000) !== null, 'a mix that overshoots fails');
    const twoDep = scheduleValidationError([pctRow(50, { is_deposit: true }), pctRow(50, { is_deposit: true })], 100000);
    ok(twoDep && /one row/i.test(twoDep.message), 'two deposit rows are refused');
    // Sub-cent percent rounding is the allocator's job, not a validation error.
    ok(scheduleValidationError([pctRow(33.33), pctRow(33.33), pctRow(33.34)], 9999) === null, 'sub-cent drift from thirds passes validation');
  }

  console.log('# computeScheduleCents: exact-to-the-cent, last row absorbs');
  {
    eq(computeScheduleCents([pctRow(50), pctRow(50)], 99999), [50000, 49999], 'odd-cent total: last row absorbs the penny');
    ok(scheduleSumsToTotal(computeScheduleCents([pctRow(33.33), pctRow(33.33), pctRow(33.34)], 9999), 9999), 'thirds sum exactly');
    eq(computeScheduleCents([fixRow(400), pctRow(60)], 100000), [40000, 60000], 'fixed stays fixed, percent recomputes');
    // The customer unticks an option: percent rows recompute, the fixed row
    // stays, the final row absorbs.
    eq(computeScheduleCents([fixRow(1000), pctRow(50), pctRow(0, { label: 'Balance' })], 685000, 685000)[0], 100000, 'fixed row untouched by the recompute');
    const declined = computeScheduleCents([pctRow(50), pctRow(50)], 399500, 685000);
    eq(declined, [199750, 199750], 'percent schedule recomputes against the new total to the cent');
  }

  console.log('# clamp path: a fixed row bigger than the shrunken total');
  {
    // $5,000 fixed deposit + balance, customer declines down to a $3,000 job:
    // the naive last row would be negative, so the whole schedule re-allocates
    // as proportions of the ORIGINAL schedule. Never a negative installment.
    const rows = [fixRow(5000, { label: 'Deposit', is_deposit: true }), pctRow(0, { label: 'Balance', amount_kind: 'fixed', amount_value: 5000 })];
    const out = computeScheduleCents(rows, 300000, 1000000);
    ok(out.every((c) => c >= 0), 'no negative installments after the decline');
    ok(scheduleSumsToTotal(out, 300000), 'clamped schedule still sums to the new total');
    eq(out, [150000, 150000], '50/50 of the original re-allocates 50/50 of the new');
    const lop = computeScheduleCents([fixRow(9000), fixRow(1000)], 500000, 1000000);
    eq(lop, [450000, 50000], '90/10 of the original stays 90/10 of the new');
  }

  console.log('# freezeSchedule: the signed record carries final dollars');
  {
    const rows = [pctRow(50, { seq: 0, label: 'Deposit', trigger_kind: 'on_acceptance', is_deposit: true }), pctRow(50, { seq: 1, label: 'Balance at completion', trigger_kind: 'on_completion' })];
    const frozen = freezeSchedule(rows, 685001);
    ok(frozen.length === 2 && frozen[0].computed_amount === 3425.01 && frozen[1].computed_amount === 3425, 'frozen dollars come from the cents allocator (deposit gets the rounded half, balance absorbs)');
    ok(frozen[0].is_deposit === true && frozen[0].trigger_kind === 'on_acceptance' && frozen[0].amount_kind === 'percent' && frozen[0].amount_value === 50, 'kind/value/trigger ride the freeze for the job-side copy');
  }

  console.log('# triggerLabel: plain language, no em dashes');
  {
    ok(triggerLabel('on_acceptance') === 'Due at signing', 'signing');
    ok(triggerLabel('on_completion') === 'Due at completion', 'completion');
    ok(triggerLabel('date', '2026-09-01') === 'Due 2026-09-01', 'date');
    ok(!/—/.test([triggerLabel('on_start'), triggerLabel('manual')].join('')), 'no em dashes in due phrasing');
  }

  console.log('# scope send gate (prompt 74 Part B rules 1-3)');
  {
    const area = (id, desc, extra) => ({ id: 'li-' + id, estimate_area_id: 'a' + id, label: 'Garage: Standard Flake', description: desc, ...extra });
    ok(scopeSendBlockers({ scopeStale: false, items: [area(1, 'Full scope text here.')], customAreaIds: new Set() }).length === 0, 'real scope on every line passes');
    const stale = scopeSendBlockers({ scopeStale: true, items: [area(1, 'Full scope text here.')], customAreaIds: new Set() });
    ok(stale.length === 1 && /out of date/.test(stale[0]), 'scope_stale blocks by itself');
    const missing = scopeSendBlockers({ scopeStale: false, items: [area(1, null), area(2, 'ok scope')], customAreaIds: new Set() });
    ok(missing.length === 1 && missing[0].includes('Garage: Standard Flake'), 'a null description blocks AND names the line');
    ok(scopeSendBlockers({ scopeStale: false, items: [area(1, '   ')], customAreaIds: new Set() }).length === 1, 'whitespace-only description blocks');
    const clob = scopeSendBlockers({ scopeStale: false, items: [area(1, '970 sqft, includes moisture vapor barrier (MVB)')], customAreaIds: new Set() });
    ok(clob.length === 1 && /square footage/.test(clob[0]), 'the clobber fingerprint blocks (stale-client defense)');
    ok(CLOBBER_DESC_RE.test('1430 sqft') && CLOBBER_DESC_RE.test(' 970 sq ft') && !CLOBBER_DESC_RE.test('Approx. 970 sqft of coating'), 'fingerprint anchors at the start');
    ok(scopeSendBlockers({ scopeStale: false, items: [area(1, null)], customAreaIds: new Set(['a1']) }).length === 0, 'a custom line with no typed scope is the rep\'s call, never blocked');
    ok(scopeSendBlockers({ scopeStale: false, items: [{ id: 'x', estimate_area_id: 'a9', label: 'MVB Only', description: null }], customAreaIds: new Set() }).length === 0, 'MVB-only line is exempt (no template describes a barrier-only job)');
    ok(isMvbOnlyLineLabel('Garage: MVB Only') && !isMvbOnlyLineLabel('MVB Only floor coating system'), 'MVB-only label forms');
    ok(scopeSendBlockers({ scopeStale: false, items: [{ id: 'x', estimate_area_id: null, label: 'Drive Time', description: null }], customAreaIds: new Set() }).length === 0, 'an add-on with no snippet never blocks (Drive Time ships without language)');
    ok(scopeSendBlockers({ scopeStale: false, items: [{ id: 'x', estimate_area_id: null, label: 'Stem Walls', description: '120 sqft' }], customAreaIds: new Set() }).length === 1, 'an add-on carrying the clobber fingerprint still blocks');
  }

  console.log('# exact clobber fingerprint (prompt 76 Part B: what the writer may CLEAR)');
  {
    ok(CLOBBER_DESC_EXACT_RE.test('385 sqft') && CLOBBER_DESC_EXACT_RE.test('  1430 sq ft  '), 'bare sqft strings match');
    ok(!CLOBBER_DESC_EXACT_RE.test('970 sqft, includes moisture vapor barrier (MVB)'), 'sqft followed by real words never matches (rep text is never cleared)');
    ok(!CLOBBER_DESC_EXACT_RE.test('We will grind 385 sqft of concrete.'), 'sqft inside a sentence never matches');
    ok(!CLOBBER_DESC_EXACT_RE.test(''), 'empty string never matches');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  if (state.failed) process.exit(1);
})();
