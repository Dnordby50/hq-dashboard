// Fixture tests for production/deposits.cjs (prompt 90 Task C). These pin
// CURRENT behavior (the nine-site rule as it shipped); any future change to
// the deposit rule must change these on purpose, never by drift.

const { depositOwed, coversDeposit, round2, EPS } = require('./deposits.cjs');

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ok  ', msg); } else { failed++; console.log('  FAIL', msg); } };

console.log('# depositOwed: explicit amount wins, else 50% of price');
ok(depositOwed(1200, 10000) === 1200, 'explicit deposit_amount wins over the fallback');
ok(depositOwed(null, 10000) === 5000, 'null deposit_amount -> 50% of price');
ok(depositOwed(undefined, 10000) === 5000, 'undefined behaves like null (the != null test)');
ok(depositOwed(0, 10000) === 0, 'explicit ZERO is respected, not treated as missing');
ok(depositOwed(null, 3333.33) === 1666.67, 'fallback rounds to cents (3333.33 -> 1666.665 -> 1666.67)');
ok(depositOwed(null, null) === 0, 'no price reads as 0, never NaN');
ok(depositOwed('1500', '9000') === 1500, 'string inputs coerce like every original call site (invNum/Number)');
ok(depositOwed(1234.567, 10000) === 1234.57, 'explicit amount is cents-rounded');

console.log('# coversDeposit: the auto-mark-collected predicate');
ok(coversDeposit({ paidToDate: 0, amount: 5000, owed: 5000, waived: false }) === true, 'exact payment covers');
ok(coversDeposit({ paidToDate: 0, amount: 4999.996, owed: 5000, waived: false }) === true, 'half-cent epsilon absorbs float drift');
ok(coversDeposit({ paidToDate: 0, amount: 4999.99, owed: 5000, waived: false }) === false, 'a real cent short does not cover');
ok(coversDeposit({ paidToDate: 3000, amount: 2000, owed: 5000, waived: false }) === true, 'prior payments count');
ok(coversDeposit({ paidToDate: 0, amount: 99999, owed: 5000, waived: true }) === false, 'waived never needs collecting');
ok(coversDeposit({ paidToDate: null, amount: 5000, owed: 5000, waived: false }) === true, 'null paid_to_date reads as 0');

console.log('# shared vocabulary');
// Float reality, pinned on purpose (current output wins the fixture):
// 1.005 * 100 is 100.4999... in IEEE 754, so Math.round lands on 1.00, not
// 1.01. Every surface ships this same round2, so they agree WITH each other;
// a future "fix" to banker's/epsilon rounding must change all of them and
// this line together.
ok(round2(1.005) === 1 && round2(1.004) === 1 && round2(1.006) === 1.01, 'round2 is Math.round cents (with the documented 1.005 float quirk)');
ok(EPS === 0.005, 'the money epsilon is half a cent');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
