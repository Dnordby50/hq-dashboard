// Self-asserting Node script, same harness style as calculator.test.js.
// Run with `npm test` or `node production/estimate-views.test.cjs`.
'use strict';
const { estimateIsHot } = require('./estimate-views.cjs');

let passed = 0;
let failed = 0;
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); }
}

const NOW = Date.parse('2026-08-07T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

// --- The hot rule: count AND recency, both tunable ---------------------------
assertEq(estimateIsHot({ viewCount: 3, lastViewedAt: hoursAgo(1), now: NOW }), true, '3 views, last 1h ago -> hot (defaults 3/48)');
assertEq(estimateIsHot({ viewCount: 2, lastViewedAt: hoursAgo(1), now: NOW }), false, '2 views -> not hot (below min)');
assertEq(estimateIsHot({ viewCount: 5, lastViewedAt: hoursAgo(49), now: NOW }), false, '5 views but quiet 49h -> cooled off');
assertEq(estimateIsHot({ viewCount: 5, lastViewedAt: hoursAgo(48), now: NOW }), true, 'exactly at the 48h window edge -> still hot (inclusive)');
assertEq(estimateIsHot({ viewCount: 3, lastViewedAt: hoursAgo(1), minViews: 5, now: NOW }), false, 'raising estimate_hot_min_views to 5 demotes a 3-view estimate');
assertEq(estimateIsHot({ viewCount: 5, lastViewedAt: hoursAgo(49), windowHours: 72, now: NOW }), true, 'widening estimate_hot_window_hours to 72 re-heats a 49h-quiet estimate');
assertEq(estimateIsHot({ viewCount: 5, lastViewedAt: null, now: NOW }), false, 'no last-view timestamp is never hot');
assertEq(estimateIsHot({ viewCount: 0, lastViewedAt: hoursAgo(1), now: NOW }), false, 'zero views is never hot');
assertEq(estimateIsHot({ viewCount: 3, lastViewedAt: hoursAgo(1), minViews: 'garbage', windowHours: -5, now: NOW }), true, 'invalid settings fall back to the 3/48 defaults');
assertEq(estimateIsHot({ viewCount: 3, lastViewedAt: NOW - 1000, now: NOW }), true, 'accepts an epoch-ms timestamp as well as ISO');
assertEq(estimateIsHot(), false, 'no arguments at all -> false, never throws');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
