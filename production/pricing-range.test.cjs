'use strict';
// Instant Pricing range math tests.
// Run: node production/pricing-range.test.cjs

const { computePriceRange, fmtMoney, renderRevealCopy } = require('./pricing-range.cjs');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${label}`); }
}
function eq(got, want, label) {
  ok(JSON.stringify(got) === JSON.stringify(want), `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// Happy path: 1000 sqft at the seeded Standard Flake range, roundTo 50.
eq(computePriceRange({ sqft: 1000, rateLow: 5.25, rateHigh: 7.00, roundTo: 50 }),
  { ok: true, low: 5250, high: 7000 }, 'flake 1000 sqft');

// Rounding direction: low floors, high ceils, so the shown bracket always
// contains the raw products. 433 * 5.25 = 2273.25 -> 2250; 433 * 7 = 3031 -> 3050.
eq(computePriceRange({ sqft: 433, rateLow: 5.25, rateHigh: 7.00, roundTo: 50 }),
  { ok: true, low: 2250, high: 3050 }, 'low floors, high ceils');

// String inputs (settings values arrive as text) parse like numbers.
eq(computePriceRange({ sqft: '400', rateLow: '5.25', rateHigh: '7.00', roundTo: '50' }),
  { ok: true, low: 2100, high: 2800 }, 'string inputs');

// min_price lifts both bounds and never inverts: 100 sqft * 5.25 = 525 -> 500,
// floor 1500 pushes low to 1500; high 700 also rises to 1500.
eq(computePriceRange({ sqft: 100, rateLow: 5.25, rateHigh: 7.00, minPrice: 1500, roundTo: 50 }),
  { ok: true, low: 1500, high: 1500 }, 'min price floor lifts both bounds');

// min_price below the computed low changes nothing.
eq(computePriceRange({ sqft: 1000, rateLow: 5.25, rateHigh: 7.00, minPrice: 1500, roundTo: 50 }),
  { ok: true, low: 5250, high: 7000 }, 'min price below range is inert');

// roundTo 1 (or missing) is a passthrough of the exact products.
eq(computePriceRange({ sqft: 433, rateLow: 5.25, rateHigh: 7.00, roundTo: 1 }),
  { ok: true, low: 2273, high: 3031 }, 'roundTo 1');
eq(computePriceRange({ sqft: 400, rateLow: 5, rateHigh: 7 }),
  { ok: true, low: 2000, high: 2800 }, 'roundTo missing defaults to 1');

// Sqft bounds.
eq(computePriceRange({ sqft: 40, rateLow: 5, rateHigh: 7, minSqft: 50, maxSqft: 20000 }),
  { ok: false, error: 'SQFT_TOO_SMALL' }, 'below min sqft');
eq(computePriceRange({ sqft: 25000, rateLow: 5, rateHigh: 7, minSqft: 50, maxSqft: 20000 }),
  { ok: false, error: 'SQFT_TOO_LARGE' }, 'above max sqft');
eq(computePriceRange({ sqft: 50, rateLow: 5, rateHigh: 7, minSqft: 50, maxSqft: 20000 }).ok,
  true, 'min sqft boundary inclusive');

// Junk sqft.
eq(computePriceRange({ sqft: 'garage', rateLow: 5, rateHigh: 7 }), { ok: false, error: 'BAD_SQFT' }, 'NaN sqft');
eq(computePriceRange({ sqft: -100, rateLow: 5, rateHigh: 7 }), { ok: false, error: 'BAD_SQFT' }, 'negative sqft');
eq(computePriceRange({ sqft: 0, rateLow: 5, rateHigh: 7 }), { ok: false, error: 'BAD_SQFT' }, 'zero sqft');
eq(computePriceRange({}), { ok: false, error: 'BAD_SQFT' }, 'empty input');

// Bad rates: missing, inverted, negative.
eq(computePriceRange({ sqft: 400, rateHigh: 7 }), { ok: false, error: 'BAD_RATES' }, 'missing rateLow');
eq(computePriceRange({ sqft: 400, rateLow: 7, rateHigh: 5 }), { ok: false, error: 'BAD_RATES' }, 'inverted rates');
eq(computePriceRange({ sqft: 400, rateLow: -1, rateHigh: 5 }), { ok: false, error: 'BAD_RATES' }, 'negative rate');

// Money formatting: whole dollars, grouped, rounds.
eq(fmtMoney(5250), '$5,250', 'fmtMoney groups');
eq(fmtMoney(999.6), '$1,000', 'fmtMoney rounds');
eq(fmtMoney(null), '$0', 'fmtMoney null');

// Reveal copy substitution; unknown tokens survive so Settings typos are visible.
eq(renderRevealCopy('Between {low} and {high}.', 5250, 7000), 'Between $5,250 and $7,000.', 'copy substitution');
eq(renderRevealCopy('{low} {low} {oops}', 100, 200), '$100 $100 {oops}', 'repeat + unknown tokens');
eq(renderRevealCopy(null, 1, 2), '', 'null template');

console.log(`pricing-range: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
