import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateMbp, MbpInputError, MBP_VERSION } from './owner-mbp.js';

// Synthetic numbers only. This repository is published as static website files.
const weeks = Array.from({ length: 52 }, (_, index) => new Date(Date.UTC(2026, 0, 4 + index * 7)).toISOString().slice(0, 10));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= Math.max(1e-8, Math.abs(expected) * 1e-10), `${actual} != ${expected}`);
const sheet = (result, kind, id = 'total') => result.sheets.find(item => item.kind === kind && item.businessLineId === id);
function fixture() {
  const makeLine = (id, label, multiplier) => ({
    id, label,
    sales: {
      newSales: 52000 * multiplier, carryOver: 100 * multiplier, recurring: null,
      leadConversion: .5, salesRatio: multiplier === 1 ? .5 : .25, averageJobSize: 1000 * multiplier,
      weekly: weeks.map(weekEnding => ({ weekEnding, weight: 1 / 52, actual: {} })),
    },
    revenue: {
      annualProduced: 52000 * multiplier, chargeRate: 50 * multiplier,
      weekly: weeks.map(weekEnding => ({ weekEnding, weight: 1 / 52, actual: {} })),
    },
  });
  return {
    schemaVersion: 1, year: 2026, weekEndings: [...weeks], asOfWeekEnding: weeks[1],
    lines: [makeLine('painting', 'Painting', 1), makeLine('epoxy', 'Epoxy', 2)],
  };
}

test('six source-shaped grids preserve the 52-week calendar and distinct sales/production plans', () => {
  const input = fixture(), result = calculateMbp(input);
  assert.equal(result.calculatorVersion, MBP_VERSION);
  assert.deepEqual(result.sheets.map(item => item.sourceTabName), [
    'Sales Plan - (Wk) TOTAL', 'SP - (Wk) Painting', 'SP - (Wk) Epoxy',
    'Revenue Produced - (Wk) TOTAL', 'RP - (Wk) Painting', 'RP - (Wk) Epoxy',
  ]);
  for (const item of result.sheets) {
    assert.equal(item.rows.length, 52);
    assert.equal(item.rows[0].weekEnding, '2026-01-04');
    assert.equal(item.rows[51].weekEnding, '2026-12-27');
    for (const quarter of [1, 2, 3, 4]) assert.equal(item.rows.filter(row => row.quarter === quarter).length, 13);
  }
  const sales = sheet(result, 'sales', 'painting'), revenue = sheet(result, 'revenue', 'painting');
  assert.equal(sales.rows[0].sourceRow, 12);
  assert.equal(revenue.rows[0].sourceRow, 11);
  close(sales.rows[0].v.C, 4); close(sales.rows[0].v.I, 2); close(sales.rows[0].v.U, 1);
  close(sales.rows[0].v.AA, 1000); close(revenue.rows[0].v.C, 1000); close(revenue.rows[0].v.J, 20);
  assert.equal(sales.top.C4, 52100);
  close(sales.footer.AA, 52000); // carry-over is top-level only in the source workbook.
  close(sales.rows[51].v.AI, 1);
  input.lines[0].sales.newSales *= 2;
  const revised = calculateMbp(input);
  close(sheet(revised, 'sales', 'painting').footer.AA, 104000);
  close(sheet(revised, 'revenue', 'painting').footer.C, 52000);
});

test('TOTAL sums line plans and uses denominator-weighted rates, not average assumptions', () => {
  const result = calculateMbp(fixture()), sales = sheet(result, 'sales'), revenue = sheet(result, 'revenue');
  close(sales.rows[0].v.C, 12); close(sales.rows[0].v.I, 6); close(sales.rows[0].v.U, 2);
  close(sales.top.K4, .5); close(sales.top.K5, 1 / 3); close(sales.top.K6, 1500);
  close(sales.rows[0].v.AJ, .5); close(sales.rows[0].v.AM, 1 / 3); close(sales.rows[0].v.AP, 1500);
  close(revenue.top.C6, 75); close(revenue.rows[0].v.R, 75);
});

test('different seasonal allocations flow to totals and cumulative gaps without rounding plans', () => {
  const input = fixture();
  input.lines[0].sales.weekly[0].weight = 0;
  input.lines[0].sales.weekly[1].weight = 2 / 52;
  input.lines[0].revenue.weekly[0].weight = 0;
  input.lines[0].revenue.weekly[1].weight = 2 / 52;
  const result = calculateMbp(input), sales = sheet(result, 'sales'), revenue = sheet(result, 'revenue');
  close(sales.rows[0].v.AH, 2000 / 156000);
  close(sales.rows[1].v.AH, 4000 / 156000);
  close(sales.rows[1].v.AI, 6000 / 156000);
  close(sales.rows[0].v.AM, .25); close(sales.rows[1].v.AM, 3 / 8);
  close(sales.rows[0].v.AP, 1500); // source TOTAL AP remains its annual K6.
  close(revenue.rows[0].v.R, 100); close(revenue.rows[1].v.R, 4000 / 60);
  close(sales.rows[1].v.AE, -6000); close(revenue.rows[1].v.G, -6000);
  close(sales.rows[51].v.AC, 156000);
});

test('weekly overrides are keyed, preserve base assumptions, and never replace a zero override', () => {
  const input = fixture(), row = input.lines[0].sales.weekly[0];
  row.leadConversionOverride = .25; row.salesRatioOverride = .2;
  let sales = sheet(calculateMbp(input), 'sales', 'painting');
  close(sales.rows[0].v.C, 20); close(sales.rows[0].v.I, 5);
  assert.equal(sales.rows[0].v.AJ, .5); assert.equal(sales.rows[0].v.AL, .25);
  assert.equal(sales.rows[0].v.AM, .5); assert.equal(sales.rows[0].v.AO, .2);
  row.salesRatioOverride = 0;
  const result = calculateMbp(input);
  sales = sheet(result, 'sales', 'painting');
  assert.equal(sales.rows[0].v.I, null); assert.equal(sales.rows[0].v.C, null);
  assert.equal(sales.rows[51].v.K, null); assert.equal(sales.footer.I, null);
  assert.equal(sheet(result, 'sales').footer.I, null);
  assert.equal(sales.issues[0].code, 'zero_sales_ratio');
  close(sales.footer.AA, 52000); // invalid lead planning does not erase valid dollars.
});

test('actual entry, ratios, cumulative totals, and annualization are recalculated', () => {
  const input = fixture();
  input.lines[0].sales.weekly[0].actual = { leads: 4, estimates: 2, jobsBooked: 1, bookedDollars: 900 };
  input.lines[0].sales.weekly[1].actual = { leads: 12, estimates: 3, jobsBooked: 3, bookedDollars: 6000 };
  input.lines[0].revenue.weekly[0].actual = { producedDollars: 600, laborHours: 10, custom: 3 };
  input.lines[0].revenue.weekly[1].actual = { producedDollars: 300, laborHours: 15, custom: 4 };
  input.lines[0].revenue.weekly[0].customPlan = 5;
  const result = calculateMbp(input), sales = sheet(result, 'sales', 'painting'), revenue = sheet(result, 'revenue', 'painting');
  close(sales.rows[1].v.AK, .25); close(sales.rows[1].v.AN, 1); close(sales.rows[1].v.AQ, 2000);
  close(sales.top.L4, 5 / 16); close(sales.top.L5, 4 / 5); close(sales.top.L6, 6900 / 4);
  close(sales.footer.AK, .375); close(sales.footer.AN, .75); close(sales.footer.AQ, 1450);
  close(sales.rows[1].v.AD, 6900); close(sales.rows[51].v.AD, 6900); close(sales.rows[1].v.AE, 4900);
  close(sales.top.E5, 6900 * 26); close(sales.top.E4, 6900 * 26 + 100);
  assert.equal(sales.summary.trend.coverage.state, 'complete');
  close(revenue.rows[1].v.S, 20); close(revenue.rows[1].v.T, 36); close(revenue.top.D6, 36);
  close(revenue.top.D4, 900 * 26); close(revenue.rows[1].v.G, -1100);
  assert.equal(revenue.rows[1].v.Y, 5); assert.equal(revenue.rows[1].v.Z, 7);
  assert.equal(revenue.footer.W, 5); assert.equal(revenue.footer.X, 7);
});

test('blank, zero, partial TOTAL, and zero-denominator ratios stay distinguishable', () => {
  const input = fixture();
  let result = calculateMbp(input), sales = sheet(result, 'sales');
  assert.equal(sheet(result, 'sales', 'painting').rows[0].v.D, null);
  assert.equal(sales.rows[0].v.D, 0); assert.equal(sales.rows[0].coverage.D.state, 'missing');
  assert.equal(sales.rows[0].v.AK, null); assert.equal(sales.summary.trend.coverage.state, 'missing');
  input.lines[0].sales.weekly[0].actual = { leads: 0, estimates: 0, jobsBooked: 0, bookedDollars: 0 };
  result = calculateMbp(input); sales = sheet(result, 'sales');
  assert.equal(sheet(result, 'sales', 'painting').rows[0].coverage.D.state, 'complete');
  assert.deepEqual(sales.rows[0].coverage.D, { entered: 1, expected: 2, state: 'partial' });
  input.lines[1].sales.weekly[0].actual = { leads: 10 };
  result = calculateMbp(input); sales = sheet(result, 'sales');
  assert.equal(sales.rows[0].coverage.D.state, 'complete');
  assert.equal(sales.rows[0].coverage.J.state, 'partial');
  assert.equal(sales.rows[0].v.AK, 0); // Excel treats missing numerator as zero, with provenance retained.
  assert.equal(sales.rows[0].v.AQ, null);
  assert.equal(sheet(result, 'revenue').rows[0].v.S, null);
});

test('as-of summary excludes later entries while the source annual footer retains them', () => {
  const input = fixture();
  input.lines[0].sales.weekly[0].actual.bookedDollars = 900;
  input.lines[0].sales.weekly[51].actual.bookedDollars = 9999;
  const sales = sheet(calculateMbp(input), 'sales', 'painting');
  assert.equal(sales.footer.AB, 10899);
  assert.equal(sales.summary.recordedThroughWeek, 900);
  assert.equal(sales.summary.coverage.AB.entered, 1);
  assert.equal(sales.summary.annualCoverage.AB.entered, 2);
  close(sales.top.E5, 900 * 26);
});

test('calculation is deterministic, does not mutate inputs, and aligns reordered weekly rows by date', () => {
  const input = fixture();
  input.lines[0].sales.weekly[0].actual.bookedDollars = 123;
  const before = JSON.stringify(input), first = calculateMbp(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(calculateMbp(input), first);
  input.lines.forEach(line => { line.sales.weekly.reverse(); line.revenue.weekly.reverse(); });
  assert.deepEqual(calculateMbp(input), first);
  first.sheets[0].rows[0].v.AB = 456;
  assert.equal(sheet(calculateMbp(input), 'sales').rows[0].v.AB, 123);
});

test('signed money adjustments and optional custom values preserve their original meaning', () => {
  const input = fixture();
  input.lines[0].sales.weekly[0].actual.bookedDollars = -125.37;
  input.lines[0].revenue.weekly[0].actual = { producedDollars: -50.25, laborHours: 2.5, custom: -3 };
  const result = calculateMbp(input);
  assert.equal(sheet(result, 'sales').footer.AB, -125.37);
  assert.equal(sheet(result, 'revenue').footer.D, -50.25);
  assert.equal(sheet(result, 'revenue').footer.K, 2.5);
  assert.equal(sheet(result, 'revenue', 'painting').footer.X, -3);
  assert.equal(sheet(result, 'revenue').footer.X, 0);
  assert.equal(sheet(result, 'revenue').rows[0].v.X, null);
});

test('TOTAL Custom Option is independently entered, not an accidental sum of unlike brand KPIs', () => {
  const input = fixture();
  input.lines[0].revenue.weekly[0].customPlan = 2;
  input.lines[0].revenue.weekly[0].actual.custom = 3;
  input.totalRevenueCustom = weeks.map(weekEnding => ({ weekEnding, plan: null, actual: null }));
  input.totalRevenueCustom[0] = { weekEnding: weeks[0], plan: 10, actual: 8 };
  const total = sheet(calculateMbp(input), 'revenue');
  assert.equal(total.rows[0].v.W, 10); assert.equal(total.rows[0].v.X, 8);
  assert.equal(total.rows[1].v.Y, 10); assert.equal(total.rows[1].v.Z, 8);
  assert.equal(total.footer.W, 10); assert.equal(total.footer.X, 8);
  assert.deepEqual(total.rows[0].coverage.X, { entered: 1, expected: 1, state: 'complete' });
});

test('zero annual plans do not yield NaN, infinite rates, or a false valid TOTAL annualization', () => {
  const input = fixture();
  for (const line of input.lines) { line.sales.newSales = 0; line.revenue.annualProduced = 0; }
  const result = calculateMbp(input);
  assert.equal(sheet(result, 'sales').top.K6, null);
  assert.equal(sheet(result, 'sales').top.E5, null);
  assert.equal(sheet(result, 'revenue').top.C6, null);
  assert.equal(sheet(result, 'revenue').top.D4, null);
  for (const item of result.sheets) for (const row of item.rows) {
    assert.ok(Object.values(row.v).every(value => value === null || Number.isFinite(value)));
  }
});

test('invalid inputs fail explicitly without coercion, silent normalization, or claims substitution', () => {
  const cases = [
    input => { input.schemaVersion = 2; },
    input => { input.asOfWeekEnding = '2026-12-31'; },
    input => { input.weekEndings[1] = input.weekEndings[0]; },
    input => { input.weekEndings[0] = '2026-01-05'; },
    input => { input.weekEndings[0] = '2026-02-30'; },
    input => { input.weekEndings.pop(); },
    input => { input.lines[1].id = 'painting'; },
    input => { input.lines[0].id = 'total'; },
    input => { input.lines[0].sales.newSales = '52000'; },
    input => { input.lines[0].sales.newSales = NaN; },
    input => { input.lines[0].sales.averageJobSize = 0; },
    input => { input.lines[0].sales.weekly[0].weight = .3; },
    input => { input.lines[0].sales.weekly[0].actual.leads = ''; },
    input => { input.lines[0].sales.weekly[0].actual.leads = 1.5; },
    input => { input.lines[0].sales.weekly[0].actual.leads = -1; },
    input => { input.lines[0].sales.weekly[0].leadConversionOverride = 1.1; },
    input => { input.lines[0].sales.weekly[0].salesRatioOverride = false; },
    input => { input.lines[0].sales.weekly[1].weekEnding = weeks[0]; },
    input => { input.lines[0].sales.weekly.pop(); },
    input => { input.lines[0].revenue.weekly[0].actual.laborHours = -1; },
    input => { input.lines[0].revenue.chargeRate = Infinity; },
    input => { input.lines[0].sales.claimsEnabled = true; },
    input => { input.lines[0].sales.newSales = Number.MAX_VALUE; input.lines[0].sales.averageJobSize = Number.MIN_VALUE; },
  ];
  for (const change of cases) { const input = fixture(); change(input); assert.throws(() => calculateMbp(input), MbpInputError); }
});

test('an explicitly supplied 53rd source week is supported, never silently added to 2026', () => {
  const input = fixture();
  input.year = 2023;
  input.weekEndings = Array.from({ length: 53 }, (_, index) => new Date(Date.UTC(2023, 0, 1 + index * 7)).toISOString().slice(0, 10));
  input.asOfWeekEnding = '2023-12-31';
  for (const line of input.lines) for (const kind of ['sales', 'revenue']) {
    line[kind].weekly = input.weekEndings.map(weekEnding => ({ weekEnding, weight: 1 / 53 }));
  }
  assert.equal(calculateMbp(input).calendar[52].quarter, 4);
  assert.equal(calculateMbp(fixture()).calendar.length, 52);
});
