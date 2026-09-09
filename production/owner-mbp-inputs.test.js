import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMbp } from './owner-mbp.js';
import { ownerFixture } from './owner-test-fixture.js';
import { mbpInputFields, getMbpInput, applyMbpEdits, applyMbpLive, validateMbpInputState, MbpInputEditError } from './owner-mbp-inputs.js';
const at = '2026-01-12T18:00:00.000Z';
const later = '2026-01-13T18:00:00.000Z';
const final = '2026-01-14T18:00:00.000Z';
const week = '2026-01-11';
const key = (field = 'leads', kind = 'sales', line = 'epoxy', date = week) => `${line}/${kind}/${date}/${field}`;
const body = () => ({ mbp: ownerFixture(), status: 'draft', source: { untouched: 'Synthetic source' }, mbpInputRequest: { id: 'synthetic', digest: 'retained' } });
const feed = (values = { leads: 8 }, queriedAt = at, weekEnding = week) => ({ queriedAt, throughWeek: '2026-01-18', warnings: [], weeks: [{ weekEnding, actual: values, available: Object.fromEntries(Object.keys(values).map(name => [name, true])) }] });

test('editable descriptor catalog matches source cells and excludes all calculated totals and ratios', () => {
  const b = body(), fields = mbpInputFields(b), find = target => fields.find(field => field.key === target);
  assert.equal(find(key('newSales', 'sales', 'painting', 'annual')).sourceAddress, 'C5');
  assert.equal(find(key()).sourceAddress, 'D13');
  assert.equal(find(key('weight')).sourceAddress, 'AH13');
  assert.equal(find(key('leadConversionOverride')).sourceAddress, 'AL13');
  assert.equal(find(key('producedDollars', 'revenue')).sourceAddress, 'D12');
  assert.equal(find(key('plan', 'revenue', 'total')).sourceAddress, 'W12');
  assert.equal(find(key('actual', 'revenue', 'total')).scope, 'total-custom');
  assert.equal(find(key()).live, true);
  assert.equal(find(key('custom', 'revenue')).live, false);
  assert.equal(find(key('leads', 'sales', 'painting')).live, false);
  assert.equal(find(key('averageJobSize', 'sales', 'epoxy', 'annual')).exclusiveMin, true);
  assert.equal(new Set(fields.map(field => field.key)).size, fields.length);
  for (const target of ['total/sales/annual/newSales', key('leads', 'sales', 'total'), key('annualProduced', 'revenue', 'total', 'annual'), key('C'), key('chargeRate', 'revenue')]) assert.throws(() => getMbpInput(b, target), MbpInputEditError);
});

test('refresh then manual then refresh retains override; explicit Use TopCoat resumes future refreshes', () => {
  const original = body(), initial = applyMbpLive(original, feed()), manual = applyMbpEdits(initial, [{ key: key(), value: 12 }], later);
  const updated = applyMbpLive(manual, feed({ leads: 9 }, final));
  assert.equal(getMbpInput(initial, key()), 8);
  assert.equal(getMbpInput(updated, key()), 12);
  assert.deepEqual(updated.mbpCellState[key()], { origin: 'manual', updatedAt: later, sourceValue: 9, sourceUpdatedAt: final, sourceAvailable: true });
  const reset = applyMbpEdits(updated, [{ key: key(), mode: 'topcoat' }], final);
  assert.equal(getMbpInput(reset, key()), 9);
  assert.equal(reset.mbpCellState[key()].origin, 'topcoat');
  assert.equal(getMbpInput(applyMbpLive(reset, feed({ leads: 10 }, '2026-01-15T18:00:00.000Z')), key()), 10);
  assert.equal(getMbpInput(original, key()), null);
  assert.deepEqual(reset.mbpInputRequest, original.mbpInputRequest);
});

test('manual zero and manual blank both persist through automatic source refreshes', () => {
  for (const value of [0, null]) {
    const initial = applyMbpLive(body(), feed());
    const manual = applyMbpEdits(initial, [{ key: key(), value }], later);
    const next = applyMbpLive(manual, feed({ leads: 22 }, final));
    assert.equal(getMbpInput(next, key()), value);
    assert.equal(next.mbpCellState[key()].origin, 'manual');
    assert.equal(next.mbpCellState[key()].sourceValue, 22);
  }
});

test('untracked imported values and FTP entries stay unchanged until explicit owner adoption', () => {
  const original = body();
  original.mbp.lines.find(line => line.id === 'epoxy').sales.weekly[1].actual.leads = 3;
  original.mbp.lines.find(line => line.id === 'painting').sales.weekly[1].actual.leads = 7;
  original.mbp.lines.find(line => line.id === 'epoxy').revenue.weekly[1].actual.producedDollars = 123.456789;
  const before = structuredClone(original), next = applyMbpLive(original, feed({ leads: 8, producedDollars: 700 }));
  assert.equal(getMbpInput(next, key()), 3);
  assert.equal(next.mbpCellState[key()].origin, undefined);
  assert.equal(next.mbpCellState[key()].sourceValue, 8);
  assert.equal(getMbpInput(next, key('producedDollars', 'revenue')), 123.456789);
  assert.equal(getMbpInput(next, key('leads', 'sales', 'painting')), 7);
  assert.deepEqual(original, before);
  assert.equal(getMbpInput(applyMbpEdits(next, [{ key: key(), mode: 'topcoat' }], later), key()), 8);
  assert.throws(() => applyMbpEdits(next, [{ key: key('leads', 'sales', 'painting'), mode: 'topcoat' }], later), MbpInputEditError);
});

test('missing or unavailable sources preserve recorded values but disable reset to stale cache', () => {
  const initial = applyMbpEdits(applyMbpLive(body(), feed()), [{ key: key(), value: 12 }], later);
  for (const update of [
    { ...feed({}, final), weeks: [] },
    { ...feed({ leads: null }, final), weeks: [{ weekEnding: week, actual: { leads: null }, available: { leads: false } }] },
  ]) {
    const next = applyMbpLive(initial, update);
    assert.equal(getMbpInput(next, key()), 12);
    assert.equal(next.mbpCellState[key()].sourceValue, 8);
    assert.equal(next.mbpCellState[key()].sourceAvailable, false);
    assert.throws(() => applyMbpEdits(next, [{ key: key(), mode: 'topcoat' }], final), MbpInputEditError);
  }
  assert.throws(() => applyMbpEdits(body(), [{ key: key(), mode: 'topcoat' }], at), MbpInputEditError);
});

test('older responses cannot roll back current source values or availability', () => {
  const initial = applyMbpLive(body(), feed({ leads: 10 }, final));
  assert.deepEqual(applyMbpLive(initial, feed({ leads: 1 }, at)), initial);
  const unavailable = applyMbpLive(initial, { ...feed({}, '2026-01-15T18:00:00.000Z'), weeks: [] });
  assert.deepEqual(applyMbpLive(unavailable, feed({ leads: 1 }, final)), unavailable);
});

test('current in-progress Phoenix week is eligible while future weeks and different-year actuals are isolated', () => {
  const input = body();
  const update = feed({ leads: 6 }, '2026-01-12T06:00:00.000Z', '2026-01-11'); // Sunday night in Phoenix.
  update.throughWeek = '2026-01-25';
  update.weeks.push({ weekEnding: '2026-01-18', actual: { leads: 99 }, available: { leads: true } });
  const sunday = applyMbpLive(input, update);
  assert.equal(getMbpInput(sunday, key()), 6);
  assert.equal(getMbpInput(sunday, key('leads', 'sales', 'epoxy', '2026-01-18')), null);
  const monday = applyMbpLive(input, { ...update, queriedAt: '2026-01-12T18:00:00.000Z' });
  assert.equal(getMbpInput(monday, key('leads', 'sales', 'epoxy', '2026-01-18')), 99);
  const foreignYear = applyMbpLive(input, feed({ leads: 20 }, at, '2025-01-05'));
  assert.deepEqual(foreignYear.mbp, input.mbp);
  const futurePlan = applyMbpLive(input, { queriedAt: '2025-12-01T18:00:00.000Z', throughWeek: null, weeks: [], warnings: ['Calendar has not started.'] });
  assert.deepEqual(futurePlan.mbp, input.mbp);
});

test('unchanged saves retain original precision and provenance without creating manual markers', () => {
  const b = applyMbpLive(body(), feed()), original = structuredClone(b);
  const target = key('averageJobSize', 'sales', 'painting', 'annual');
  b.mbp.lines[0].sales.averageJobSize = 1234.567890123;
  const before = structuredClone(b);
  const next = applyMbpEdits(b, [{ key: target, value: 1234.567890123 }, { key: key(), value: 8 }], later);
  assert.deepEqual(next, before);
  assert.equal(next.mbpCellState[target], undefined);
  assert.deepEqual(next.mbpCellState[key()], original.mbpCellState[key()]);
});

test('batch plan edits preserve exact seasonal weight totals and recompute linked source cells', () => {
  const b = body(), before = structuredClone(b), weight0 = key('weight', 'sales', 'painting', '2026-01-04'), weight1 = key('weight', 'sales', 'painting');
  assert.throws(() => applyMbpEdits(b, [{ key: weight0, value: 0.1 }], at), /sum to 1/);
  const delta = 0.005;
  const next = applyMbpEdits(b, [
    { key: weight0, value: getMbpInput(b, weight0) + delta },
    { key: weight1, value: getMbpInput(b, weight1) - delta },
    { key: key('newSales', 'sales', 'painting', 'annual'), value: 78000 },
  ], at);
  const computed = calculateMbp(next.mbp), sheet = computed.sheets.find(sheet => sheet.kind === 'sales' && sheet.businessLineId === 'painting');
  assert.equal(sheet.top.C5, 78000);
  assert.equal(sheet.rows[0].v.AA, 78000 * getMbpInput(next, weight0));
  assert.deepEqual(b, before);
});

test('independent total revenue custom inputs stay editable without changing brand actuals', () => {
  const b = body();
  const next = applyMbpEdits(b, [
    { key: key('plan', 'revenue', 'total'), value: 12.5 },
    { key: key('actual', 'revenue', 'total'), value: 7.25 },
    { key: key('custom', 'revenue', 'painting'), value: 2 },
  ], at);
  const result = calculateMbp(next.mbp), total = result.sheets.find(sheet => sheet.kind === 'revenue' && sheet.businessLineId === 'total');
  assert.equal(total.rows[1].v.W, 12.5);
  assert.equal(total.rows[1].v.X, 7.25);
  assert.equal(getMbpInput(next, key('custom', 'revenue', 'epoxy')), null);
  assert.equal(b.mbp.totalRevenueCustom, undefined);
});

test('malformed keys, formula fields, invalid values and duplicate edits are rejected atomically', () => {
  for (const edits of [
    [{ key: '__proto__/sales/annual/newSales', value: 1 }],
    [{ key: 'epoxy/sales/annual/__proto__', value: 1 }],
    [{ key: key('claimsEnabled', 'sales', 'epoxy', 'annual'), value: 1 }],
    [{ key: key(), value: -1 }], [{ key: key(), value: 1.5 }], [{ key: key(), value: Infinity }],
    [{ key: key('newSales', 'sales', 'epoxy', 'annual'), value: null }],
    [{ key: key('averageJobSize', 'sales', 'epoxy', 'annual'), value: 0 }],
    [{ key: key('weight'), value: 1.2 }],
    [{ key: key(), value: 1 }, { key: key(), value: 2 }],
  ]) { const b = body(), before = structuredClone(b); assert.throws(() => applyMbpEdits(b, edits, at), MbpInputEditError); assert.deepEqual(b, before); }
});

test('source feeds and persisted input history are validated before any change', () => {
  for (const mutate of [
    f => { f.queriedAt = 'yesterday'; }, f => { f.throughWeek = '2026-01-14'; },
    f => { f.weeks[0].actual.leads = null; }, f => { f.weeks[0].actual.leads = -1; },
    f => { f.weeks[0].available.leads = 1; }, f => { f.weeks.push(f.weeks[0]); },
  ]) { const f = feed(); mutate(f); assert.throws(() => applyMbpLive(body(), f), MbpInputEditError); }
  const invalid = body(); invalid.mbpCellState = { [key('leads', 'sales', 'painting')]: { origin: 'topcoat', updatedAt: at } };
  assert.throws(() => validateMbpInputState(invalid), MbpInputEditError);
  assert.equal(validateMbpInputState(body()).status, 'draft');
});
