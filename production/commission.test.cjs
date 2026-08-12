// Fixture tests for production/commission.cjs (prompt 90 Task C): pins the
// rate resolution (aliases, exclusions), the per-payment commission atom,
// and the pay-cycle date helpers exactly as renderCommission shipped them.

const { commissionForPayment, buildCommissionRates, commissionFriday, commissionPeriod } = require('./commission.cjs');

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ok  ', msg); } else { failed++; console.log('  FAIL', msg); } };

console.log('# commissionForPayment');
ok(commissionForPayment(1000, 10) === 100, '10% of $1000 = $100');
ok(commissionForPayment(3333.33, 7.5) === 250, '7.5% of 3333.33 = 249.99975 -> 250.00 (cents rounding)');
ok(commissionForPayment(1000, null) === 0, 'null pct (unknown seller) earns 0, never NaN');
ok(commissionForPayment(-500, 10) === -50, 'a refund (negative payment) nets commission back');
ok(commissionForPayment(0, 10) === 0, 'zero collected earns zero');

console.log('# buildCommissionRates: names, aliases, exclusions');
const team = [
  { name: 'Aron Bronson', commission_pct: 10, name_aliases: ['Aron B'] },
  { name: 'Dylan Nordby', commission_pct: 5, name_aliases: [], exclude_from_commission: true },
  { name: 'Aron B', commission_pct: 7, name_aliases: [] }, // live name colliding with an alias
];
const { pctByName, excludedNames } = buildCommissionRates(team);
ok(pctByName['aron bronson'] === 10, 'current name resolves its rate');
ok(pctByName['aron b'] === 7, "a LIVE member's name beats another member's alias (names load first)");
ok(pctByName['dylan nordby'] === 5, 'excluded members still resolve a rate (filtering is separate)');
ok(excludedNames.has('dylan nordby'), 'exclude_from_commission lands in the excluded set, lowercased');
ok(!excludedNames.has('aron bronson'), 'non-excluded stay out');
const { pctByName: p2 } = buildCommissionRates([{ name: 'Old Only', commission_pct: 12, name_aliases: ['Older Name'] }]);
ok(p2['older name'] === 12, 'an alias inherits the rate when no live name claims it');

console.log('# pay-cycle helpers (UTC string math)');
ok(commissionFriday('2026-08-10') === '2026-08-14', 'Monday receipt -> that Friday');
ok(commissionFriday('2026-08-14') === '2026-08-14', 'Friday receipt -> same day');
ok(commissionFriday('2026-08-15') === '2026-08-21', 'Saturday receipt -> NEXT Friday');
const per = commissionPeriod('2026-08-14');
ok(per.start === '2026-08-09' && per.end === '2026-08-15', 'a payday Friday closes the Sun-Sat period around it');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
