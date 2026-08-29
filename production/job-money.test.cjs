// Fixture tests for production/job-money.cjs (prompt 90 Task C): the
// Metrics AR-as-of-date predicate and the change-order price mutation,
// pinned exactly as they shipped.

const { arDueAsOf, applyChangeOrder, editChangeOrder, removeChangeOrder } = require('./job-money.cjs');

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

console.log('# editChangeOrder');
{
  const items = [
    { name: 'Base', price: 10000 },
    { name: 'Extra crack fill', description: 'old note', price: 350, is_change_order: true, completed: true, completed_at: '2026-08-20T00:00:00Z' },
  ];
  const out = editChangeOrder(10350, items, { name: 'Extra crack fill', amount: 350 }, { name: 'Extra crack + patch', description: 'new note', amount: 500 });
  ok(out.matched === true, 'edit: the CO line matches by title + amount');
  ok(out.price === 10500, 'edit: price moves by the amount delta');
  ok(out.line_items[1].name === 'Extra crack + patch' && out.line_items[1].price === 500 && out.line_items[1].description === 'new note', 'edit: the line is replaced in place');
  ok(out.line_items[1].completed === true && out.line_items[1].completed_at === '2026-08-20T00:00:00Z', 'edit: completed flags survive the replace');
  ok(items[1].price === 350 && items[1].name === 'Extra crack fill', 'edit: inputs are not mutated');
}
{
  const items = [{ name: 'Extra crack fill', price: 350.0004, is_change_order: true }];
  const out = editChangeOrder(10350, items, { name: ' extra crack fill ', amount: 350 }, { name: 'X', amount: 100 });
  ok(out.matched === true, 'edit: match tolerates case/whitespace and half-cent amount drift');
}
{
  const items = [
    { name: 'Return trip', price: 200, is_change_order: true },
    { name: 'Return trip', price: 500, is_change_order: true },
  ];
  const out = editChangeOrder(10700, items, { name: 'Return trip', amount: 500 }, { name: 'Return trip', amount: 600 });
  ok(out.matched && out.line_items[0].price === 200 && out.line_items[1].price === 600, 'edit: duplicate titles pick the line by amount');
}
{
  const items = [{ name: 'Diverged by hand', price: 999, is_change_order: true }];
  const out = editChangeOrder(10999, items, { name: 'Extra crack fill', amount: 350 }, { name: 'X', amount: 500 });
  ok(out.matched === false && out.price === 10999 && out.line_items === items, 'edit: no match leaves price and lines untouched');
}
{
  const items = [{ name: 'Legacy CO', total: 300, is_change_order: true }];
  const out = editChangeOrder(10300, items, { name: 'Legacy CO', amount: 300 }, { name: 'Legacy CO', amount: 400 });
  ok(out.matched && out.line_items[0].price === 400 && !('total' in out.line_items[0]), 'edit: a legacy total-shaped line matches and normalizes to { price }');
}

console.log('# removeChangeOrder');
{
  const items = [
    { name: 'Base', price: 10000 },
    { name: 'Extra crack fill', price: 350, is_change_order: true },
  ];
  const out = removeChangeOrder(10350, items, { name: 'Extra crack fill', amount: 350 });
  ok(out.matched === true && out.price === 10000, 'remove: price drops by the CO amount');
  ok(out.line_items.length === 1 && out.line_items[0].name === 'Base', 'remove: exactly the matched line is spliced');
  ok(items.length === 2, 'remove: inputs are not mutated');
}
{
  const items = [{ name: 'Something else', price: 350, is_change_order: true }];
  const out = removeChangeOrder(10350, items, { name: 'Extra crack fill', amount: 350 });
  ok(out.matched === false && out.price === 10350 && out.line_items === items, 'remove: no match leaves everything untouched');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
