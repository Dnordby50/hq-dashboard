import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculateMbp } from './owner-mbp.js';
import { calculateFinance } from './owner-finance.js';
import { ownerFixture } from './owner-test-fixture.js';
import { WORKBOOK_SHEET_IDS as ROUTINE_SHEET_IDS } from './owner-routine.js';
import {
  WORKBOOK_SHEETS, WORKBOOK_SHEET_IDS, formatExcel, mbpFlag, outlineHiddenRows,
  renderSummaryPL, renderWorkbookSheet, renderWorkbookTopBox, renderWorkbookFinance, workbookFooter, workbookNavigate,
  workbookRowGroups, workbookHiddenValueRows, workbookStyleCss, SUMMARY_PL,
} from './owner-mbp-workbook.js';
import { MBP_WORKBOOK_LAYOUT } from './owner-mbp-workbook-layout.js';

const MONEY = '_($* #,##0_);[red]_($* (#,##0);_($* "-"??_)';
const COUNT = '#,##0_);[Red](#,##0)';
const plan = () => {
  const body = { mbp: ownerFixture(), status: 'draft' };
  return { body, computed: calculateMbp(body.mbp) };
};
const sheetOf = (computed, kind, lineId) => computed.sheets.find(s => s.kind === kind && s.businessLineId === lineId);

test('the workbook sheet list matches the server-side copy used to validate the setting', () => {
  assert.deepEqual([...ROUTINE_SHEET_IDS], WORKBOOK_SHEET_IDS);
  assert.deepEqual([...WORKBOOK_SHEET_IDS].sort(), Object.keys(MBP_WORKBOOK_LAYOUT.sheets).sort());
});

test('the flag rule follows the workbook: future weeks and caught-up weeks are grey', () => {
  const today = '2026-06-14';
  assert.equal(mbpFlag('2026-06-21', 0, 100000, today), 'Grey', 'a week that has not closed is never red');
  assert.equal(mbpFlag('2026-06-07', 100, 100, today), 'Grey');
  assert.equal(mbpFlag('2026-06-07', 101, 100, today), 'Grey');
  assert.equal(mbpFlag('2026-06-07', 99, 100, today), 'Red');
  assert.equal(mbpFlag(today, 99, 100, today), 'Red', 'the current week is compared, not skipped');
  // ROUND to whole units first, half away from zero, so a half-unit gap is not a miss.
  assert.equal(mbpFlag('2026-06-07', 99.5, 100.4, today), 'Grey');
  assert.equal(mbpFlag('2026-06-07', 99.4, 100.4, today), 'Red');
  assert.equal(mbpFlag('2026-06-07', -0.5, 0.4, today), 'Red');
  // A blank actual counts as zero, exactly as the workbook's SUM does.
  assert.equal(mbpFlag('2026-06-07', null, 1, today), 'Red');
  assert.equal(mbpFlag('2026-06-07', null, null, today), 'Grey');
});

test('every flag column on all six weekly sheets renders a red or grey state', () => {
  const { body, computed } = plan();
  let columns = 0;
  for (const meta of WORKBOOK_SHEETS.filter(s => s.businessLineId)) {
    const spec = MBP_WORKBOOK_LAYOUT.sheets[meta.id];
    const html = renderWorkbookSheet(meta.id, { sheet: sheetOf(computed, meta.kind, meta.businessLineId), body, today: '2026-06-14' });
    for (const letter of Object.keys(spec.grid.flags)) {
      if (spec.hiddenCols.includes([...letter].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0))) continue;
      const address = `${letter}${spec.grid.dataFrom}`;
      assert.match(html, new RegExp(`data-cell="${address}"[^>]*>(Red|Grey)<`), `${meta.id} ${address}`);
      columns++;
    }
  }
  assert.equal(columns, 5 + 5 + 5 + 3 + 3 + 3, 'five visible sales flags and three revenue flags per sheet');
});

test('Excel number formats render money, counts, percentages and dates as the workbook does', () => {
  assert.deepEqual(formatExcel(125430, MONEY), { lead: '$', text: '125,430', red: false, accounting: true });
  assert.deepEqual(formatExcel(-2500, MONEY), { lead: '$', text: '(2,500)', red: true, accounting: true });
  assert.equal(formatExcel(0, MONEY).text, '-', 'the accounting zero is a dash');
  assert.equal(formatExcel(-2500, COUNT).text, '(2,500)');
  assert.equal(formatExcel(0.0725, '0.0%').text, '7.2%');
  assert.equal(formatExcel(0, '0.0%;[red](0.0)%;""').text, '');
  assert.equal(formatExcel('2026-01-03', 'd mmm').text, '3 Jan');
  assert.equal(formatExcel(null, MONEY).text, '');
  assert.equal(formatExcel(undefined, MONEY).text, '');
});

test('the bottom row totals only the columns the workbook totals, plus its plan averages', () => {
  const { computed } = plan();
  const sales = sheetOf(computed, 'sales', 'painting');
  const footer = workbookFooter(sales);
  assert.ok(Number.isFinite(footer.C) && Number.isFinite(footer.AA));
  assert.ok(Number.isFinite(footer.AJ), 'AJ is the workbook average of the weekly plan conversion');
  assert.equal(footer.AJ, sales.rows[0].v.AJ, 'a constant plan column averages to itself');
  assert.equal(footer.E, undefined, 'cumulative columns stay blank in the workbook footer');
  const revenue = sheetOf(computed, 'revenue', 'painting');
  assert.equal(workbookFooter(revenue).AJ, undefined);
});

test('the period filter hides week rows without changing the top box or the bottom row', () => {
  const { body, computed } = plan();
  const sheet = sheetOf(computed, 'sales', 'painting');
  const all = renderWorkbookSheet('sales_painting', { sheet, body, today: '2026-06-14', period: 'all' });
  const q2 = renderWorkbookSheet('sales_painting', { sheet, body, today: '2026-06-14', period: '2' });
  const weekRows = html => [...html.matchAll(/data-row="(\d+)"/g)].map(m => Number(m[1])).filter(r => r >= 12 && r <= 63).length;
  assert.equal(weekRows(all), 52);
  assert.equal(weekRows(q2), 13);
  const box = html => /data-cell="C4"[^]*?<\/td>/.exec(html)[0];
  const bottom = html => /data-cell="AA65"[^]*?<\/td>/.exec(html)[0];
  assert.equal(box(q2), box(all), 'the annual plan box is unchanged by the filter');
  assert.equal(bottom(q2), bottom(all), 'the full-year bottom row is unchanged by the filter');
});

test('keyboard moves skip calculated cells because only editable cells are in the list', () => {
  const cells = ['D12', 'J12', 'V12', 'D13', 'J13', 'V13'];
  assert.equal(workbookNavigate(cells, 'D12', 'Enter'), 'D13', 'Enter moves down the same column');
  assert.equal(workbookNavigate(cells, 'D13', 'Enter'), 'D13', 'the last row in a column stays put');
  assert.equal(workbookNavigate(cells, 'D13', 'Enter', true), 'D12', 'Shift+Enter moves up');
  assert.equal(workbookNavigate(cells, 'D12', 'Tab'), 'J12', 'Tab skips the calculated E..I cells');
  assert.equal(workbookNavigate(cells, 'V12', 'Tab'), 'D13', 'Tab wraps to the next row of editable cells');
  assert.equal(workbookNavigate(cells, 'J12', 'Tab', true), 'D12');
  assert.equal(workbookNavigate(cells, 'J12', 'ArrowRight'), 'V12');
  assert.equal(workbookNavigate(cells, 'D12', 'ArrowLeft'), 'D12');
  assert.equal(workbookNavigate(cells, 'D12', 'ArrowUp'), 'D12');
  assert.equal(workbookNavigate([], 'D12', 'Enter'), null);
});

test('editable weekly actuals and annual inputs render as inputs; calculated cells never do', () => {
  const { body, computed } = plan();
  const html = renderWorkbookSheet('sales_painting', { sheet: sheetOf(computed, 'sales', 'painting'), body, today: '2026-06-14' });
  assert.match(html, /<input[^>]*data-mbp-key="[^"]*sales\/2026-01-04\/leads"[^>]*data-cell="D12"/, 'the weekly leads actual is editable');
  assert.match(html, /<input[^>]*data-cell="C5"/, 'the annual new-sales plan is editable');
  assert.ok(!/<input[^>]*data-cell="E12"/.test(html), 'a cumulative cell is read only');
  assert.ok(!/<input[^>]*data-cell="G12"/.test(html), 'a flag cell is read only');
  // The cell shows the workbook's formatting; the editable number waits behind data-raw.
  assert.match(html, /<input[^>]*data-cell="C5"[^>]*data-raw="52000" data-display="52,000" value="52,000"/);
  const readOnly = renderWorkbookSheet('sales_painting', { sheet: sheetOf(computed, 'sales', 'painting'), body, today: '2026-06-14', readOnly: true });
  assert.ok(!readOnly.includes('<input'));
});

test('Use TopCoat is offered only on an eligible PEC override, never on FTP', () => {
  const { body, computed } = plan();
  const key = 'epoxy/sales/2026-01-04/leads';
  body.mbpCellState = {
    [key]: { origin: 'manual', sourceAvailable: true },
    'painting/sales/2026-01-04/leads': { origin: 'manual', sourceAvailable: true },
  };
  const epoxy = renderWorkbookSheet('sales_epoxy', { sheet: sheetOf(computed, 'sales', 'epoxy'), body, today: '2026-06-14' });
  assert.match(epoxy, new RegExp(`data-mbp-reset="${key.replace(/\//g, '\\/')}"`));
  const painting = renderWorkbookSheet('sales_painting', { sheet: sheetOf(computed, 'sales', 'painting'), body, today: '2026-06-14' });
  assert.ok(!painting.includes('data-mbp-reset'), 'FTP is never a live source target');
  body.mbpCellState[key].sourceAvailable = false;
  const stale = renderWorkbookSheet('sales_epoxy', { sheet: sheetOf(computed, 'sales', 'epoxy'), body, today: '2026-06-14' });
  assert.ok(!stale.includes('data-mbp-reset'), 'an unavailable source cannot be adopted');
});

test('a manual override keeps its yellow cell and a missing input keeps its star', () => {
  const { body, computed } = plan();
  body.mbpCellState = { 'epoxy/sales/2026-01-04/leads': { origin: 'manual', sourceAvailable: true } };
  const html = renderWorkbookSheet('sales_epoxy', { sheet: sheetOf(computed, 'sales', 'epoxy'), body, today: '2026-06-14' });
  assert.match(html, /class="[^"]*is-manual[^"]*" data-cell="D12"/);
  assert.match(html, /wb-incomplete/);
});

test('outline groups start where the workbook saved them and only change what is shown', () => {
  const budget = workbookRowGroups(MBP_WORKBOOK_LAYOUT, 'budget');
  assert.ok(budget.length >= 5);
  const collapsed = budget.filter(group => !group.expanded);
  assert.ok(collapsed.length >= 4, 'the workbook saves most budget groups collapsed');
  for (const group of budget) assert.ok(group.summary === null || group.summary === group.from - 1, 'summaryBelow is false in this workbook');
  const hidden = outlineHiddenRows(MBP_WORKBOOK_LAYOUT, 'budget');
  assert.ok(hidden.has(collapsed[0].from) && hidden.has(collapsed[0].to));
  const opened = outlineHiddenRows(MBP_WORKBOOK_LAYOUT, 'budget', new Set([collapsed[0].id]));
  assert.ok(!opened.has(collapsed[0].from), 'expanding a group only reveals rows');
  assert.equal(opened.size, hidden.size - (collapsed[0].to - collapsed[0].from + 1));
});

test('the summary P&L box reads the Budget - 2 cells it names, and says so when they move', () => {
  const cells = {
    H6: { v: 'FTP' }, I6: { v: 400000 }, BL6: { v: 180000 }, BM6: { v: -220000 },
    H7: { v: 'PEC' }, I7: { v: 600000 }, BL7: { v: 350000 }, BM7: { v: -250000 },
    I27: { v: 'Total Revenue' }, I28: { v: 1000000 }, BL28: { v: 530000 }, BM28: { v: -470000 },
    H787: { v: 'Total Variable Expenses' }, I787: { v: 500000 }, BL787: { v: 260000 }, BM787: { v: -240000 },
    H790: { v: 'Gross Profit' }, I790: { v: 500000 }, BL790: { v: 270000 }, BM790: { v: -230000 }, BN790: { v: 0.509 },
    I896: { v: 'Fixed Expenses' }, I897: { v: 300000 }, BL897: { v: 150000 }, BM897: { v: -150000 },
    I900: { v: 'Net Profit' }, I901: { v: 200000 }, BL901: { v: 120000 }, BM901: { v: -80000 }, BN901: { v: 0.226 },
  };
  const body = { year: 2026, sheets: [{ id: 'budget', name: 'Budget - 2', kind: 'budget', rows: 918, cols: 89, cells }] };
  const html = renderSummaryPL(body, { sheets: [{ id: 'budget', cells }] });
  assert.match(html, /Total Revenue<\/th><td><span class="wb-acc"><i>\$<\/i><em>1,000,000<\/em>/);
  assert.match(html, /<em>530,000<\/em>/);
  assert.match(html, /Net Profit.*?22\.6%/s);
  for (const line of SUMMARY_PL) assert.ok(html.includes(line.label));
  const moved = structuredClone(body);
  moved.sheets[0].cells.H790 = { v: 'Something else' };
  assert.match(renderSummaryPL(moved, { sheets: [{ id: 'budget', cells: moved.sheets[0].cells }] }), /Budget - 2 row moved/);
});

test('the summary top boxes reuse the workbook styles and open their own sheet', () => {
  const { computed } = plan();
  const html = renderWorkbookTopBox('revenue_epoxy', { sheet: sheetOf(computed, 'revenue', 'epoxy') });
  assert.match(html, /data-action="workbook-open" data-sheet="revenue_epoxy"/);
  assert.match(html, /data-cell="C4"/);
  assert.ok(!html.includes('data-row="11"'), 'only the top box rows are in the box');
  assert.ok(!html.includes('MBP Support'), 'the workbook support link is left out');
});

test('excluded workbook chrome is dropped without moving any cell', () => {
  const { body, computed } = plan();
  const html = renderWorkbookSheet('sales_painting', { sheet: sheetOf(computed, 'sales', 'painting'), body, today: '2026-06-14' });
  assert.ok(!html.includes('USER INSTRUCTIONS'), 'the instructions box text is left out');
  assert.ok(!html.includes('MBP Support'));
  assert.match(html, /data-cell="AA3"/, 'the cell itself is still there, so nothing shifts');
  assert.match(html, /data-cell="U4"/);
});

test('rendered geometry matches the workbook: widths, merges, hidden columns, frozen panes', () => {
  const { body, computed } = plan();
  const spec = MBP_WORKBOOK_LAYOUT.sheets.sales_painting;
  const html = renderWorkbookSheet('sales_painting', { sheet: sheetOf(computed, 'sales', 'painting'), body, today: '2026-06-14' });
  assert.equal(spec.freeze.row, 11);
  assert.equal(spec.freeze.col, 2);
  assert.ok(!html.includes('data-cell="O12"'), 'the hidden claims columns are not rendered');
  assert.ok(!html.includes('data-cell="AL12"'), 'the hidden weekly override columns are not rendered');
  assert.match(html, /data-cell="C4" rowspan="1" colspan="2"/, 'the C4:D4 merge is kept');
  const cols = [...html.matchAll(/<col style="width:(\d+)px">/g)].map(m => Number(m[1]));
  assert.equal(cols.length, spec.cols - spec.hiddenCols.length);
  // Columns start at the workbook's width and only ever grow, so nothing is clipped.
  const visible = [];
  for (let c = 1; c <= spec.cols; c++) if (!spec.hiddenCols.includes(c)) visible.push(c);
  for (const [i, c] of visible.entries()) assert.ok(cols[i] >= Math.round((spec.colWidths[c] ?? spec.defaultColWidth) * 7) + 1, `column ${c} shrank`);
  assert.ok(cols[0] > Math.round(spec.colWidths[1] * 7) + 1, 'column A grew to fit QUARTER:');
  assert.match(html, /position:sticky/, 'the frozen header and week column are pinned');
});

test('a cell that does not fit widens its column, and a wrapped one only needs its longest word', () => {
  const { body, computed } = plan();
  const html = renderWorkbookSheet('sales_painting', { sheet: sheetOf(computed, 'sales', 'painting'), body, today: '2026-06-14' });
  const widths = [...html.matchAll(/<col style="width:(\d+)px">/g)].map(m => Number(m[1]));
  assert.ok(widths[0] >= 66, 'column A fits QUARTER: rather than clipping it');
  assert.ok(html.includes('>QUARTER:<') || html.includes('QUARTER:'), 'the header is still there');
  assert.ok(widths.every(w => w > 0));
});

test('the generated layout carries presentation only, never owner numbers or account names', async () => {
  const source = await readFile(new URL('./owner-mbp-workbook-layout.js', import.meta.url), 'utf8');
  assert.ok(!/\$\s?\d/.test(source), 'no currency amounts');
  for (const id of ['budget', 'income']) {
    assert.deepEqual(MBP_WORKBOOK_LAYOUT.sheets[id].labels, {}, `${id} keeps its account names in the private document`);
  }
  for (const sheet of Object.values(MBP_WORKBOOK_LAYOUT.sheets)) {
    for (const label of Object.values(sheet.labels)) {
      assert.ok(!/\d[\d,]{2,}/.test(label), `label looks like a number: ${label}`);
    }
  }
  assert.ok(workbookStyleCss().startsWith('.tc-wb-table .wbs1{'));
});

test('rows the source buries outside every outline group are found and can be opened', () => {
  // Income Statement - 2 hides rows 73 and 74 outside every group, so no +/- control
  // reaches them; the toolbar reveal is the only way in.
  const cells = { C73: { v: 1200 }, C74: { v: 900 }, C96: { v: 50 }, D100: { f: '=1+1', v: 5 }, C700: { v: 0 } };
  assert.deepEqual(workbookHiddenValueRows('income', { cells }), [73, 74]);
  assert.ok(!workbookHiddenValueRows('income', { cells }).includes(96), 'a row inside a collapsed group is reached by its own control');
  assert.ok(!workbookHiddenValueRows('income', { cells }).includes(100), 'a formula cell is not somebody\'s entry');
  assert.ok(!workbookHiddenValueRows('income', { cells }).includes(700), 'an explicit zero is not a value here');
  const sheet = { id: 'income', name: 'Income Statement - 2', kind: 'income', rows: 829, cols: 23, cells, inputRanges: [] };
  const body = { year: 2026, sheets: [sheet] }, computed = { sheets: [{ id: 'income', cells }] };
  const closed = renderWorkbookFinance('income', { body, computed });
  const open = renderWorkbookFinance('income', { body, computed, showHiddenValues: true });
  assert.ok(!closed.includes('data-row="73"'), 'the default view matches the workbook');
  assert.match(open, /data-row="73"/);
  assert.match(open, /data-row="74"/);
  assert.ok(!open.includes('data-row="96"'), 'revealing buried rows does not expand the outline groups');
  assert.equal((open.match(/data-row="/g) || []).length, (closed.match(/data-row="/g) || []).length + 2);
});
