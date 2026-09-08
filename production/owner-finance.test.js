import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFinance, newFinanceYear, validateFinance, FinanceInputError } from './owner-finance.js';
const fixture = () => ({ schemaVersion: 1, year: 2026, source: { name: 'Synthetic workbook' }, sheets: [
  { id: 'budget', name: 'Budget - 2', kind: 'budget', rows: 30, cols: 20, cells: {
    A1: { v: 2026, role: 'year', editable: true }, A2: { v: '2026-01-31', role: 'year-date', t: 'date' },
    B1: { v: 120000, editable: true, role: 'plan' }, B2: { v: 0.25, editable: true, role: 'plan', t: 'percent' },
    B3: { f: '=B1*B2' }, C1: { v: 'Labor' }, C2: { v: 'Supplies' }, C3: { v: 'LABOR' }, D1: { v: 10 }, D2: { v: 20 }, D3: { v: 30 },
    E1: { v: 'Q1' }, E2: { v: 'Q2' }, E3: { v: 'Q1' },
  } },
  { id: 'income', name: 'Income Statement - 2', kind: 'income', rows: 30, cols: 20, inputRanges: [{ range: 'C1:C12', role: 'actual', t: 'money' }], cells: {
    A1: { f: "='Budget - 2'!B1" }, B1: { v: 10000, editable: true, role: 'actual' }, C1: { v: 8000, editable: true },
    D1: { f: '=B1-C1' }, E1: { f: '=IFERROR(D1/B1,"")' },
  } },
] });
const value = (result, sheet, address) => result.sheets[sheet].cells[address].v;

test('plan references recalculate across tabs while actual edits stay independent and inputs unchanged', () => {
  const input = fixture(), original = structuredClone(input), before = calculateFinance(input);
  assert.equal(value(before, 0, 'B3'), 30000);
  assert.equal(value(before, 1, 'A1'), 120000);
  assert.equal(value(before, 1, 'D1'), 2000);
  assert.equal(value(before, 1, 'E1'), 0.2);
  assert.deepEqual(input, original);
  input.sheets[0].cells.B1.v = 160000;
  const after = calculateFinance(input);
  assert.equal(value(after, 0, 'B3'), 40000);
  assert.equal(value(after, 1, 'A1'), 160000);
  assert.equal(value(after, 1, 'B1'), 10000);
});

test('source SUMIF/SUMIFS support case-insensitive criteria and multiple filters', () => {
  const input = fixture(), cells = input.sheets[0].cells;
  cells.F1 = { f: '=SUMIF(C1:C3,"labor",D1:D3)' };
  cells.F2 = { f: '=SUMIFS(D1:D3,C1:C3,"labor",E1:E3,"Q1")' };
  cells.F3 = { f: '=SUMIF(D1:D3,">=20")' };
  cells.F4 = { f: '=SUMIF(C:C,"L*",D:D)' };
  cells.F5 = { f: '=SUM(D1:D3,5,TRUE)' };
  const result = calculateFinance(input);
  assert.deepEqual(['F1', 'F2', 'F3', 'F4', 'F5'].map(a => value(result, 0, a)), [40, 40, 50, 40, 66]);
});

test('safe interpreter preserves errors, short-circuits IF/IFERROR, and never reuses cached values', () => {
  const input = fixture(), cells = input.sheets[0].cells;
  cells.G1 = { f: '=1/0', v: 9000 };
  cells.G2 = { f: '=G1+1', v: 9001 };
  cells.G3 = { f: '=IFERROR(G1,"")', v: 9000 };
  cells.G4 = { f: '=IF(FALSE,1/0,7)' };
  cells.G5 = { f: '=#REF!+10', v: 99999 };
  cells.G6 = { f: '=RUNJAVASCRIPT("process.exit()")' };
  const result = calculateFinance(input);
  assert.equal(value(result, 0, 'G1'), null);
  assert.equal(result.sheets[0].cells.G1.error, '#DIV/0!');
  assert.equal(result.sheets[0].cells.G2.error, '#DIV/0!');
  assert.equal(value(result, 0, 'G3'), '');
  assert.equal(value(result, 0, 'G4'), 7);
  assert.equal(result.sheets[0].cells.G5.error, '#REF!');
  assert.equal(result.sheets[0].cells.G6.error, '#NAME?');
  assert.throws(() => { cells.G6.f = '=(()=>{throw 1})()'; validateFinance(input); }, FinanceInputError);
});

test('cycles and missing external sheets have visible error states', () => {
  const input = fixture(), cells = input.sheets[0].cells;
  cells.G1 = { f: '=G2' }; cells.G2 = { f: '=G1' }; cells.G3 = { f: "='Missing'!A1" };
  const result = calculateFinance(input);
  assert.equal(result.sheets[0].cells.G1.error, '#CYCLE!');
  assert.equal(result.sheets[0].cells.G2.error, '#CYCLE!');
  assert.equal(result.sheets[0].cells.G3.error, '#REF!');
  assert.equal(result.issues.length, 3);
});

test('new years retain planning inputs, clear actuals, update dates, and preserve prior history', () => {
  const input = fixture(), original = structuredClone(input);
  input.sheets[0].cells.F1 = { f: '=EDATE(A2,1)' };
  input.sheets[0].cells.F2 = { f: '=A1&" BUDGET"' };
  const next = newFinanceYear(input, 2027), calculated = calculateFinance(next);
  assert.equal(next.year, 2027);
  assert.equal(next.sheets[0].cells.B1.v, original.sheets[0].cells.B1.v);
  assert.equal(next.sheets[0].cells.A1.v, 2027);
  assert.equal(next.sheets[0].cells.A2.v, '2027-01-31');
  assert.equal(next.sheets[1].cells.B1.v, null);
  assert.equal(next.sheets[1].cells.C1, undefined);
  assert.equal(value(calculated, 0, 'F2'), '2027 BUDGET');
  assert.equal(new Date(Date.UTC(1899, 11, 30) + value(calculated, 0, 'F1') * 86400000).toISOString().slice(0, 10), '2027-02-28');
  assert.equal(input.sheets[1].cells.C1.v, 8000);
  assert.equal(input.sheets[0].cells.A1.v, 2026);
  assert.equal(next.sheets[0].cells.F1.v, undefined);
  assert.deepEqual(next, newFinanceYear(input, 2027));
  assert.throws(() => newFinanceYear(input, 2026), FinanceInputError);
  assert.throws(() => newFinanceYear(input, 2028), /next consecutive year/);
});

test('year rollover clamps leap dates and retains independent actual entry slots', () => {
  const input = fixture(); input.year = 2024;
  input.sheets[0].cells.A2.v = '2024-02-29';
  input.sheets[0].cells.J1 = { v: (Date.UTC(2024, 1, 29) - Date.UTC(1899, 11, 30)) / 86400000, role: 'year-date' };
  const next = newFinanceYear(input, 2025);
  assert.equal(next.sheets[0].cells.A2.v, '2025-02-28');
  assert.equal(new Date(Date.UTC(1899, 11, 30) + next.sheets[0].cells.J1.v * 86400000).toISOString().slice(0, 10), '2025-02-28');
  assert.deepEqual(next.sheets[1].inputRanges, input.sheets[1].inputRanges);
});

test('formula text, percentages, comparisons and quoted sheet apostrophes retain spreadsheet behavior', () => {
  const input = fixture(); input.sheets[0].name = "Owner's Budget";
  input.sheets[1].cells.A1.f = "='Owner''s Budget'!$B$1*50%";
  input.sheets[0].cells.J1 = { f: '=IF(OR(B1>0,B2=0),"Net "&UPPER(C1),"None")' };
  input.sheets[0].cells.J2 = { f: '=IF(0="",1,2)' };
  const result = calculateFinance(input);
  assert.equal(value(result, 1, 'A1'), 60000);
  assert.equal(value(result, 0, 'J1'), 'Net LABOR');
  assert.equal(value(result, 0, 'J2'), 2);
});

test('validation rejects corrupted models and dangerous or excessive metadata', () => {
  for (const mutate of [
    input => { input.year = '2026'; },
    input => { input.sheets[0].cells.A1.v = Infinity; },
    input => { input.sheets[0].cells.B3.editable = true; },
    input => { input.sheets[0].cells.Z99 = { v: 1 }; },
    input => { input.sheets[1].id = 'budget'; },
    input => { input.sheets[0].merges = ['A1:Z99']; },
    input => { input.sheets[1].inputRanges[0].range = 'C0:C12'; },
    input => { input.source = JSON.parse('{"__proto__":{"polluted":true}}'); },
  ]) { const input = fixture(); mutate(input); assert.throws(() => validateFinance(input), FinanceInputError); }
});

test('historical rollover carries recorded actuals and labels, marks partial coverage, and preserves missing entries', () => {
  const input = fixture();
  input.historicalMappings = [
    { fromSheetId: 'income', from: 'B1:C3', toSheetId: 'budget', to: 'H1:H3', mode: 'sum-actuals' },
    { fromSheetId: 'budget', from: 'C1:C3', toSheetId: 'budget', to: 'I1:I3', mode: 'copy' },
  ];
  input.sheets[1].cells.B2 = { v: 0, role: 'actual', editable: true };
  const next = newFinanceYear(input, 2027);
  assert.equal(next.sheets[0].cells.H1.v, 18000);
  assert.equal(next.sheets[0].cells.H2.v, 0);
  assert.equal(next.sheets[0].cells.H3.v, null);
  assert.equal(next.sheets[0].cells.I1.v, 'Labor');
  assert.equal(next.sheets[0].cells.H2.carryForward, undefined);
  assert.equal(next.carryForward.partialRows, 1);
  assert.equal(next.carryForward.basis, 'recorded-actuals');
  assert.equal(input.sheets[1].cells.B1.v, 10000);
  assert.equal(next.sheets[1].cells.B1.v, null);
});

test('historical rollover never turns source errors into zero or replaces calculated cells', () => {
  const input = fixture();
  input.sheets[1].cells.B2 = { f: '=1/0' };
  input.historicalMappings = [{ fromSheetId: 'income', from: 'B1:C2', toSheetId: 'budget', to: 'H1:H2', mode: 'sum-actuals' }];
  const next = newFinanceYear(input, 2027);
  assert.equal(next.sheets[0].cells.H2.v, '#DIV/0!');
  assert.equal(calculateFinance(next).sheets[0].cells.H2.error, '#DIV/0!');
  assert.equal(next.carryForward.issues.length, 1);
  input.historicalMappings[0].to = 'B2:B3';
  assert.throws(() => validateFinance(input), FinanceInputError);
});

test('new-year historical labels snapshot their matching stream, with formula overrides limited to historical text', () => {
  const input = fixture();
  input.sheets[0].cells.H1 = { v: 'Equipment Rental' };
  input.sheets[0].cells.I1 = { f: '=C1' };
  input.sheets[0].inputRanges = [{ range: 'I1:I2', role: 'historical', t: 'text' }];
  input.historicalMappings = [{ fromSheetId: 'budget', from: 'H1', toSheetId: 'budget', to: 'I1', mode: 'copy' }];
  const next = newFinanceYear(input, 2027);
  assert.equal(next.sheets[0].cells.I1.v, 'Equipment Rental');
  assert.equal(next.sheets[0].cells.I1.f, undefined);
  assert.equal(next.sheets[0].inputRanges[0].role, 'historical');
  assert.equal(input.sheets[0].cells.I1.f, '=C1');
  delete input.sheets[0].inputRanges;
  assert.throws(() => newFinanceYear(input, 2027), FinanceInputError);
});
