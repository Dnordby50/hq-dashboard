// Fixture tests for production/job-money.cjs (prompt 90 Task C): the
// Metrics AR-as-of-date predicate and the change-order price mutation,
// pinned exactly as they shipped.

const { arDueAsOf, applyChangeOrder } = require('./job-money.cjs');

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ok  ', msg); } else { failed++; console.log('  FAIL', msg); } };

console.log('# arDueAsOf');
const D = '2026-08-01';
ok(arDueAsOf({ completed_date: '2026-07-20', price: 10000 }, D, 4000) === 6000, 'completed before D owes the unpaid remainder');
ok(arDueAsOf({ completed_date: '2026-07-20', price: 10000 }, D, 10000) === 0, 'paid in full owes nothing');
ok(arDueAsOf({ completed_date: '2026-07-20', price: 10000 }, D, 9999.996) === 0, 'half-cent epsilon: effectively paid reads 0');
ok(arDueAsOf({ completed_date: '2026-08-02', signed_date: '2026-07-01', price: 10000 }, D, 0) === 5000, 'not yet completed AS OF D falls through to the signed/deposit branch');
ok(arDueAsOf({ signed_date: '2026-07-25', price: 10000, deposit_amount: null }, D, 0) === 5000, 'signed, nothing paid -> deposit owed (50% fallback)');
ok(arDueAsOf({ signed_date: '2026-07-25', price: 10000, deposit_amount: 2000 }, D, 0) === 2000, 'explicit deposit_amount wins');
ok(arDueAsOf({ signed_date: '2026-07-25', price: 10000, deposit_waived: true }, D, 0) === 0, 'waived deposit owes nothing pre-completion');
ok(arDueAsOf({ signed_date: '2026-07-25', price: 10000 }, D, 100) === 0, 'ANY payment clears the pending-deposit branch (the documented chart rule)');
ok(arDueAsOf({ signed_date: '2026-08-05', price: 10000 }, D, 0) === 0, 'signed AFTER D owes nothing as of D');
ok(arDueAsOf({ price: 10000 }, D, 0) === 0, 'no dates, no AR');

console.log('# applyChangeOrder');
const before = { price: 10000, items: [{ name: 'Base', price: 10000 }] };
const out = applyChangeOrder(before.price, before.items, { name: 'Extra crack fill', amount: 350.555 });
ok(out.price === 10350.56, 'price adds the cents-rounded amount');
ok(out.line_items.length === 2 && out.line_items[1].is_change_order === true, 'one is_change_order line appended');
ok(out.line_items[1].price === 350.56 && out.line_items[1].name === 'Extra crack fill', 'line carries the rounded amount and title');
ok(before.items.length === 1 && before.price === 10000, 'inputs are not mutated');
const out2 = applyChangeOrder(10000, null, { name: 'CO on legacy job', amount: 100 });
ok(out2.line_items.length === 1 && out2.price === 10100, 'null line_items (legacy job) starts a fresh array');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
