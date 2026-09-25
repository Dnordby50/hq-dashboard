// Full-screen workbook clone of the owner's MBP sheets.
//
// How it works: production/owner-mbp-workbook-layout.js holds the workbook's
// presentation (geometry, fills, fonts, borders, number-format strings, static
// header labels) generated from the private .xlsx. This module lays that grid out
// in HTML and drops TopCoat's live numbers into the same cells, addressed by the
// original Excel column letters the calculation engine already uses. Nothing here
// calculates: every value comes from owner-mbp.js, owner-finance.js or the saved
// document, so the screens change but the arithmetic does not.
import { MBP_WORKBOOK_LAYOUT } from './owner-mbp-workbook-layout.js';
import { getMbpInput, mbpSaturday } from './owner-mbp-inputs.js';
import { mbpInputValue, mbpSheetFields } from './owner-mbp-ui.js';
import { financeColumn, financeDisplay, financeInputValue } from './owner-finance-ui.js';

const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** Bottom sheet tabs, in workbook order and with the workbook's own names. */
export const WORKBOOK_SHEETS = [
  { id: 'sales_total', label: 'Sales Plan - (Wk) TOTAL', kind: 'sales', businessLineId: 'total' },
  { id: 'sales_painting', label: 'SP - (Wk) Painting', kind: 'sales', businessLineId: 'painting' },
  { id: 'sales_epoxy', label: 'SP - (Wk) Epoxy', kind: 'sales', businessLineId: 'epoxy' },
  { id: 'revenue_total', label: 'Revenue Produced - (Wk) TOTAL', kind: 'revenue', businessLineId: 'total' },
  { id: 'revenue_painting', label: 'RP - (Wk) Painting', kind: 'revenue', businessLineId: 'painting' },
  { id: 'revenue_epoxy', label: 'RP - (Wk) Epoxy', kind: 'revenue', businessLineId: 'epoxy' },
  { id: 'budget', label: 'Budget - 2', kind: 'budget', businessLineId: null },
  { id: 'income', label: 'Income Statement - 2', kind: 'income', businessLineId: null },
];
export const WORKBOOK_SHEET_IDS = WORKBOOK_SHEETS.map(sheet => sheet.id);
export const isWorkbookSheetId = id => WORKBOOK_SHEET_IDS.includes(id);
export const workbookSheet = id => WORKBOOK_SHEETS.find(sheet => sheet.id === id) || null;

// Cells whose workbook text is deliberately left out (decision 7). The cell keeps its
// fill and size so no column or row shifts; only the text is dropped.
const DROPPED_LABELS = new Set(['sales:U4', 'sales:AA3', 'sales:AA4', 'revenue:F3', 'revenue:J3', 'revenue:J4']);
// The workbook averages these plan columns in its bottom row. The engine publishes the
// per-week plan values but not their mean, so the mean is taken here for display only.
const FOOTER_MEANS = { sales: { AJ: 'AJ', AM: 'AM', AP: 'AP' }, revenue: {} };

/* ------------------------------------------------------------------ geometry */

/** Excel column width (characters) to CSS pixels, at the workbook's 7px max digit width. */
export const colPx = width => Math.round(width * 7) + 1;
/** Excel row height (points) to CSS pixels at 96dpi. */
export const rowPx = points => Math.round(points * 4 / 3);

export function sheetGeometry(layout, sheetId) {
  const spec = layout.sheets[sheetId];
  if (!spec) throw new Error(`Unknown workbook sheet: ${sheetId}`);
  const hiddenCols = new Set(spec.hiddenCols), hiddenRows = new Set(spec.hiddenRows);
  const widths = new Map(), heights = new Map();
  for (let c = 1; c <= spec.cols; c++) widths.set(c, colPx(spec.colWidths[c] ?? spec.defaultColWidth));
  for (let r = 1; r <= spec.rows; r++) heights.set(r, rowPx(spec.rowHeights[r] ?? spec.defaultRowHeight));
  return { spec, hiddenCols, hiddenRows, widths, heights };
}

/** Left offsets for the frozen columns, measured across visible columns only. */
function frozenOffsets(geometry, freezeCols, hiddenCols) {
  const offsets = new Map();
  let left = 0;
  for (let c = 1; c <= freezeCols; c++) {
    if (hiddenCols.has(c)) continue;
    offsets.set(c, left);
    left += geometry.widths.get(c);
  }
  return offsets;
}
function frozenRowOffsets(geometry, freezeRows, hiddenRows) {
  const offsets = new Map();
  let top = 0;
  for (let r = 1; r <= freezeRows; r++) {
    if (hiddenRows.has(r)) continue;
    offsets.set(r, top);
    top += geometry.heights.get(r);
  }
  return offsets;
}

/* ------------------------------------------------- Excel number formatting */

const FORMATS = new Map();
const DATE_TOKEN = /^(yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s)/i;

function formatTokens(text) {
  const list = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { list.push(['lit', text[++i] ?? '']); continue; }
    if (ch === '"') { const end = text.indexOf('"', i + 1), stop = end < 0 ? text.length : end; list.push(['lit', text.slice(i + 1, stop)]); i = stop; continue; }
    if (ch === '_') { list.push(['skip', text[++i] ?? '']); continue; }
    if (ch === '*') { list.push(['fill', text[++i] ?? '']); continue; }
    if (ch === '[') { const end = text.indexOf(']', i), stop = end < 0 ? text.length : end; list.push(['bracket', text.slice(i + 1, stop)]); i = stop; continue; }
    if ('#0?,.'.includes(ch)) { list.push(['num', ch]); continue; }
    const date = DATE_TOKEN.exec(text.slice(i));
    if (date) { list.push(['date', date[0]]); i += date[0].length - 1; continue; }
    list.push(['lit', ch]);
  }
  return list;
}

function formatSection(text) {
  const list = formatTokens(text);
  const pattern = list.filter(([type]) => type === 'num').map(([, value]) => value).join('');
  const numeric = /[#0]/.test(pattern);
  const dated = !numeric && list.some(([type]) => type === 'date');
  const fillAt = list.findIndex(([type]) => type === 'fill');
  const lits = (from, to) => list.slice(from, to).filter(([type]) => type === 'lit').map(([, value]) => value).join('');
  const numAt = list.findIndex(([type]) => type === 'num');
  const lastNum = list.map(([type]) => type).lastIndexOf('num');
  const section = {
    red: list.some(([type, value]) => type === 'bracket' && /^red$/i.test(value)),
    percent: list.some(([type, value]) => type === 'lit' && value.includes('%')),
    accounting: fillAt >= 0,
    numeric, dated,
    decimals: pattern.includes('.') ? pattern.split('.')[1].replace(/[^#0?]/g, '').length : 0,
    grouping: /[#0?],[#0?]/.test(pattern),
    // "#" suppresses a digit; a pattern with no required "0" shows nothing for zero.
    blankZero: numeric && !pattern.includes('0'),
    tokens: list,
  };
  if (dated) return section;
  if (numeric) {
    section.lead = fillAt >= 0 ? lits(0, fillAt) : '';
    section.prefix = (fillAt >= 0 ? lits(fillAt + 1, numAt < 0 ? list.length : numAt) : lits(0, numAt < 0 ? list.length : numAt));
    section.suffix = lits(lastNum + 1, list.length);
  } else {
    // No digit placeholders: a literal section such as the accounting dash.
    section.lead = fillAt >= 0 ? lits(0, fillAt) : '';
    section.prefix = '';
    section.suffix = '';
    section.literal = fillAt >= 0 ? lits(fillAt + 1, list.length) : lits(0, list.length);
  }
  return section;
}

function splitFormatSections(nf) {
  const out = [];
  let current = '', quoted = false, bracketed = false;
  for (let i = 0; i < nf.length; i++) {
    const ch = nf[i];
    if (ch === '\\') { current += ch + (nf[++i] ?? ''); continue; }
    if (ch === '"') { quoted = !quoted; current += ch; continue; }
    if (!quoted && ch === '[') bracketed = true;
    if (!quoted && ch === ']') bracketed = false;
    if (ch === ';' && !quoted && !bracketed) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out;
}

/** Parse one Excel number-format string into its positive/negative/zero/text sections. */
export function parseExcelFormat(nf) {
  if (FORMATS.has(nf)) return FORMATS.get(nf);
  const parsed = splitFormatSections(nf).map(formatSection);
  FORMATS.set(nf, parsed);
  return parsed;
}

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function renderDate(date, section) {
  return section.tokens.map(([type, value]) => {
    if (type === 'skip' || type === 'fill' || type === 'bracket') return '';
    if (type !== 'date') return value;
    const token = value.toLowerCase();
    if (token === 'yyyy') return String(date.getUTCFullYear());
    if (token === 'yy') return String(date.getUTCFullYear()).slice(-2);
    if (token === 'mmmmm') return MONTHS_LONG[date.getUTCMonth()][0];
    if (token === 'mmmm') return MONTHS_LONG[date.getUTCMonth()];
    if (token === 'mmm') return MONTHS_LONG[date.getUTCMonth()].slice(0, 3);
    if (token === 'mm') return String(date.getUTCMonth() + 1).padStart(2, '0');
    if (token === 'm') return String(date.getUTCMonth() + 1);
    if (token === 'dddd') return DAYS_LONG[date.getUTCDay()];
    if (token === 'ddd') return DAYS_LONG[date.getUTCDay()].slice(0, 3);
    if (token === 'dd') return String(date.getUTCDate()).padStart(2, '0');
    if (token === 'd') return String(date.getUTCDate());
    return value;
  }).join('');
}

/**
 * Format one value the way the workbook's number format does.
 * Returns { lead, text, red, accounting }: `lead` is the currency symbol an
 * accounting format floats to the left edge of the cell, `text` the rest.
 */
export function formatExcel(value, nf) {
  const blank = { lead: '', text: '', red: false, accounting: false };
  if (value === null || value === undefined || value === '') return blank;
  if (!nf) {
    if (typeof value === 'number') return { ...blank, text: Number.isInteger(value) ? value.toLocaleString('en-US') : String(Number(value.toPrecision(12))) };
    return { ...blank, text: String(value) };
  }
  const sections = parseExcelFormat(nf);
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && sections[0]?.dated) return { ...blank, text: renderDate(new Date(`${value}T00:00:00Z`), sections[0]) };
    return { ...blank, text: value };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ...blank, text: String(value ?? '') };
  if (sections[0]?.dated) return { ...blank, text: renderDate(new Date(Date.UTC(1899, 11, 30) + value * 86400000), sections[0]) };
  const negative = value < 0, zero = value === 0;
  let section = sections[0], signed = false;
  if (negative && sections[1]) section = sections[1];
  else if (negative) signed = true;
  else if (zero && sections[2]) section = sections[2];
  const result = { lead: section.lead || '', red: !!section.red, accounting: !!section.accounting };
  if (!section.numeric) return { ...result, text: section.literal || '' };
  const scaled = Math.abs(section.percent ? value * 100 : value);
  if (section.blankZero && Number(scaled.toFixed(section.decimals)) === 0) return { ...result, text: '' };
  const body = scaled.toLocaleString('en-US', { minimumFractionDigits: section.decimals, maximumFractionDigits: section.decimals, useGrouping: section.grouping });
  return { ...result, text: `${signed ? '-' : ''}${section.prefix}${body}${section.suffix}` };
}

/* ------------------------------------------------------------- flag columns */

/** Excel ROUND: half away from zero, not JavaScript's half up. */
const roundHalf = value => Math.sign(value) * Math.round(Math.abs(value));
const numberOr0 = value => (Number.isFinite(value) ? value : 0);

/**
 * The workbook's red/grey flag: grey for a week that has not closed yet, grey when the
 * rounded cumulative actual has caught up with the rounded cumulative plan, else red.
 * `today` and `weekEnding` are both the saved Sunday source keys, as the workbook compares them.
 */
export function mbpFlag(weekEnding, actual, plan, today) {
  if (weekEnding > today) return 'Grey';
  return roundHalf(numberOr0(actual)) >= roundHalf(numberOr0(plan)) ? 'Grey' : 'Red';
}

/** Footer values for one sheet, including the plan averages the workbook shows. */
export function workbookFooter(sheet) {
  const footer = { ...sheet.footer };
  for (const column of Object.keys(FOOTER_MEANS[sheet.kind] || {})) {
    const values = sheet.rows.map(row => row.v[column]).filter(value => Number.isFinite(value));
    footer[column] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }
  return footer;
}

/* ------------------------------------------------------------- outline groups */

/**
 * Row groups with their current open/closed state. `open` holds the group ids the viewer
 * expanded; everything else keeps the workbook's saved collapsed state.
 */
export function workbookRowGroups(layout, sheetId, open = new Set()) {
  return (layout.sheets[sheetId]?.rowGroups || []).map(group => ({
    ...group, id: `${group.from}-${group.to}`, expanded: open.has(`${group.from}-${group.to}`) || !group.collapsed,
  }));
}

/**
 * Rows the source hides outside every outline group, that still hold a typed value.
 * No +/- control can reach these, so the toolbar offers to reveal them. Only entered
 * values count: a formula cell in a hidden template row is not somebody's entry.
 */
export function workbookHiddenValueRows(sheetId, sheet, layout = MBP_WORKBOOK_LAYOUT) {
  const spec = layout.sheets[sheetId];
  if (!spec || !sheet) return [];
  const grouped = row => (spec.rowGroups || []).some(group => row >= group.from && row <= group.to);
  return (spec.hiddenRows || []).filter(row => {
    if (grouped(row)) return false;
    for (let c = 3; c <= 14; c++) {
      const cell = sheet.cells[`${financeColumn(c)}${row}`];
      if (!cell || cell.f) continue;
      if (cell.v !== null && cell.v !== undefined && cell.v !== '' && cell.v !== 0) return true;
    }
    return false;
  });
}

/** Rows hidden by the outline, given which groups the viewer opened. */
export function outlineHiddenRows(layout, sheetId, open = new Set()) {
  const hidden = new Set();
  for (const group of workbookRowGroups(layout, sheetId, open)) {
    if (group.expanded) continue;
    for (let r = group.from; r <= group.to; r++) hidden.add(r);
  }
  return hidden;
}

/* --------------------------------------------------------------------- CSS */

/** One CSS class per workbook style, emitted once for the whole overlay. */
export function workbookStyleCss(layout = MBP_WORKBOOK_LAYOUT) {
  return layout.styles.map((style, index) => {
    const rules = [];
    // Excel hides its gridlines under a fill, so a filled cell's default border takes
    // the fill colour and only the workbook's explicit sides stay visible.
    if (style.bg) rules.push(`background:${style.bg}`, `border-color:${style.bg}`);
    if (style.fg) rules.push(`color:${style.fg}`);
    if (style.bold) rules.push('font-weight:700');
    if (style.italic) rules.push('font-style:italic');
    if (style.underline) rules.push('text-decoration:underline');
    rules.push(`font-size:${style.size ?? 10}pt`);
    if (style.face) rules.push(`font-family:'${style.face}',Roboto,system-ui,sans-serif`);
    for (const [key, side] of [['bt', 'top'], ['brt', 'right'], ['bb', 'bottom'], ['bl', 'left']]) {
      if (!style[key]) continue;
      const [weight, color] = style[key].split(' ');
      rules.push(`border-${side}:${weight === 'thick' ? 3 : weight === 'medium' ? 2 : 1}px solid ${color}`);
    }
    if (style.h) rules.push(`text-align:${style.h}`);
    if (style.v) rules.push(`vertical-align:${style.v === 'center' ? 'middle' : style.v}`);
    if (style.wrap) rules.push('white-space:pre-wrap');
    if (style.indent) rules.push(`padding-left:${style.indent * 8 + 2}px`);
    return `.tc-wb-table .wbs${index + 1}{${rules.join(';')}}`;
  }).join('');
}

/* --------------------------------------------------------------- grid engine */

function coordinate(address) {
  const match = /^([A-Z]+)(\d+)$/.exec(address);
  return [Number(match[2]), [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0)];
}

/**
 * Lay one workbook sheet out as a table. `contentOf(row, col, address)` returns the cell
 * body; everything else (widths, heights, merges, frozen panes, hidden rows and columns)
 * comes from the generated layout so the grid matches the .xlsx cell for cell.
 */
/* ------------------------------------------------------------- text measurement */

// Roboto is proportional, so a cell's text is measured from per-character widths in ems
// rather than a character count. Deliberately a shade generous: the grid should give
// every value room rather than clip it.
const CHAR_EM = { narrow: 0.30, digit: 0.56, lower: 0.52, upper: 0.66, wide: 0.86 };
const NARROW = new Set([...' .,:;\'"|!ilj()[]-']);
const WIDE = new Set([...'MW@%']);
export function textWidthPx(text, { bold = false, size = 10 } = {}) {
  const em = size * 4 / 3;
  let total = 0;
  for (const ch of String(text ?? '')) {
    total += em * (NARROW.has(ch) ? CHAR_EM.narrow : WIDE.has(ch) ? CHAR_EM.wide
      : ch >= '0' && ch <= '9' ? CHAR_EM.digit : ch >= 'a' && ch <= 'z' ? CHAR_EM.lower : CHAR_EM.upper);
  }
  return Math.ceil(total * (bold ? 1.06 : 1));
}
/** Room a cell needs: its text, the cell padding, borders and the accounting gap. */
export const CELL_PADDING = 5;
function contentWidth(content, style, lines = 1) {
  const text = String(content.text ?? '');
  if (!text) return 0;
  const size = style?.size ?? 10, bold = !!style?.bold;
  let width = textWidthPx(text, { bold, size });
  // A wrapped cell keeps the workbook's row height, so it only needs the room its longest
  // word takes and an even share of the rest.
  if (lines > 1) {
    const longest = Math.max(...text.split(/\s+/).map(word => textWidthPx(word, { bold, size })));
    width = Math.max(longest, Math.ceil(width / lines));
  }
  if (content.lead) width += textWidthPx(content.lead, { bold, size }) + 6;
  if (content.marker) width += textWidthPx('*', { bold: true, size }) + 2;
  return width + CELL_PADDING * 2 + 2;
}
/** Lines a wrapped cell has room for at the workbook's own row height. */
const wrapLines = (height, style) => Math.max(1, Math.round(height / ((style?.size ?? 10) * 4 / 3 * 1.1)));

/* --------------------------------------------------------------- grid engine */

function renderGrid({ geometry, rows, cols, merges, classOf, contentOf, styleOf = () => null, freeze, gutter = null, label }) {
  const { spec, heights } = geometry;
  const widths = new Map(geometry.widths);
  const visibleRows = new Set(rows), visibleCols = new Set(cols);
  const freezeCols = freeze?.col || 0, freezeRows = freeze?.row || 0;
  const spans = new Map(), covered = new Set();
  for (const merge of merges) {
    const [a, b = a] = merge.split(':'), [r1, c1] = coordinate(a), [r2, c2] = coordinate(b);
    const rr = rows.filter(r => r >= r1 && r <= r2), cc = cols.filter(c => c >= c1 && c <= c2);
    if (!rr.length || !cc.length) continue;
    const anchor = `${financeColumn(cc[0])}${rr[0]}`;
    spans.set(anchor, { rowspan: rr.length, colspan: cc.length, source: a });
    for (const r of rr) for (const c of cc) { const key = `${financeColumn(c)}${r}`; if (key !== anchor) covered.add(key); }
  }
  // Build every cell first, then widen any column whose own text does not fit. A merged or
  // spilling cell is skipped: it already has more than its own column to sit in.
  const grid = rows.map(r => cols.map(c => {
    const address = `${financeColumn(c)}${r}`;
    return covered.has(address) ? null : (contentOf(r, c, spans.get(address)?.source || address) || {});
  }));
  // Pass 1: a cell that sits in one column widens that column.
  for (const [rowIndex, r] of rows.entries()) {
    for (const [index, c] of cols.entries()) {
      const content = grid[rowIndex][index];
      if (!content || content.spill || spans.has(`${financeColumn(c)}${r}`)) continue;
      const style = styleOf(r, c);
      const needed = contentWidth(content, style, content.clip ? wrapLines(heights.get(r), style) : 1);
      if (needed > widths.get(c)) widths.set(c, needed);
    }
  }
  // Pass 2: a merged cell has its whole span to sit in, and a spilling label has its own
  // column plus the empty run after it. Only the shortfall goes on the last column it owns.
  for (const [rowIndex, r] of rows.entries()) {
    for (const [index, c] of cols.entries()) {
      const content = grid[rowIndex][index];
      if (!content) continue;
      const span = spans.get(`${financeColumn(c)}${r}`);
      if (!span && !content.spill) continue;
      let owned = [c];
      if (span) owned = cols.slice(index, index + span.colspan);
      else for (let n = index + 1; n < grid[rowIndex].length; n++) {
        if (grid[rowIndex][n] === null) continue;
        if (grid[rowIndex][n].html) break;
        owned.push(cols[n]);
      }
      const available = owned.reduce((sum, n) => sum + widths.get(n), 0);
      const style = styleOf(r, c);
      const rowsOwned = span ? rows.slice(rowIndex, rowIndex + span.rowspan) : [r];
      const height = rowsOwned.reduce((sum, n) => sum + heights.get(n), 0);
      const needed = contentWidth(content, style, content.clip ? wrapLines(height, style) : 1);
      if (needed > available) { const last = owned.at(-1); widths.set(last, widths.get(last) + needed - available); }
    }
  }
  const hiddenCols = new Set([...Array(spec.cols).keys()].map(i => i + 1).filter(c => !visibleCols.has(c)));
  const hiddenRows = new Set([...Array(spec.rows).keys()].map(i => i + 1).filter(r => !visibleRows.has(r)));
  const leftOf = frozenOffsets({ ...geometry, widths }, freezeCols, hiddenCols);
  const topOf = frozenRowOffsets(geometry, freezeRows, hiddenRows);
  const lastFrozenRow = Math.max(...[...topOf.keys()], -Infinity);
  const gutterWidth = gutter ? 18 : 0;
  const head = `<colgroup>${gutter ? `<col style="width:${gutterWidth}px">` : ''}${cols.map(c => `<col style="width:${widths.get(c)}px">`).join('')}</colgroup>`;
  const body = rows.map((r, rowIndex) => {
    const sticky = topOf.has(r);
    const contents = grid[rowIndex];
    const cells = cols.map((c, index) => {
      const address = `${financeColumn(c)}${r}`;
      if (covered.has(address)) return '';
      const span = spans.get(address);
      const content = contents[index];
      // Excel spills a label across the empty cells that follow it and clips at the first
      // one with something in it, so the spill box is exactly that wide. A merged cell
      // centres inside its merge and never spills, which is what Excel does too.
      let spillWidth = 0;
      if (content.spill && !span) {
        for (let n = index + 1; n < contents.length; n++) {
          if (contents[n] === null) continue;
          if (contents[n].html) break;
          spillWidth += widths.get(cols[n]);
        }
      }
      const spill = content.spill && !span && spillWidth > 0;
      const pinnedCol = leftOf.has(c);
      // A spilling label has to paint over the empty neighbour it spills into, and later
      // siblings win at an equal z-index, so it is lifted one step.
      const layer = (pinnedCol && sticky ? 5 : pinnedCol ? 3 : 4) + (spill ? 1 : 0);
      const position = [
        pinnedCol ? `left:${leftOf.get(c)}px` : '',
        sticky ? `top:${topOf.get(r)}px` : '',
        pinnedCol || sticky ? `position:sticky;z-index:${layer}` : '',
      ].filter(Boolean).join(';');
      const classes = ['wb-cell', classOf(r, c, span?.source || address), ...(content.classes || []),
        spill ? 'wb-spill' : '', sticky ? 'wb-frozen' : '', r === lastFrozenRow ? 'wb-freeze-edge' : ''].filter(Boolean).join(' ');
      // A wrapped cell has already widened its column to fit at the workbook's row height,
      // so it is left to wrap rather than clipped part way through a line.
      const html = spill ? `<span class="wb-spill-text" style="width:${widths.get(c) + spillWidth - CELL_PADDING * 2}px">${content.html ?? ''}</span>`
        : (content.html ?? '');
      return `<td class="${classes}" data-cell="${e(address)}"${span ? ` rowspan="${span.rowspan}" colspan="${span.colspan}"` : ''}`
        + `${position ? ` style="${position}"` : ''}${content.title ? ` title="${e(content.title)}"` : ''}>${html}</td>`;
    }).join('');
    return `<tr data-row="${r}" style="height:${heights.get(r)}px">${gutter ? gutter(r) : ''}${cells}</tr>`;
  }).join('');
  const width = gutterWidth + cols.reduce((sum, c) => sum + widths.get(c), 0);
  return `<div class="tc-wb-surface" tabindex="0" role="region" aria-label="${e(label)}"><table class="tc-wb-table" style="width:${width}px">`
    + `${head}<tbody>${body}</tbody></table></div>`;
}

/** Accounting formats float the currency symbol at the left edge of the cell. */
function cellHtml(formatted, extra = '') {
  const text = e(formatted.text);
  if (!formatted.accounting || !formatted.lead) return text + extra;
  return `<span class="wb-acc"><i>${e(formatted.lead)}</i><em>${text}${extra}</em></span>`;
}

/* ------------------------------------------------- Sales Plan / Revenue Produced */

const PERIOD_MONTH = /^month:(\d{2})$/;
function inPeriod(row, period, dateOf) {
  if (period === 'all') return true;
  const month = PERIOD_MONTH.exec(period);
  if (month) return dateOf(row.weekEnding).slice(5, 7) === month[1];
  return String(row.quarter).replace('Q', '') === String(period).replace('Q', '');
}

/**
 * Render one of the six weekly sheets. Values come from the calculation engine's sheet
 * output, addressed by the original workbook column letters.
 */
export function renderWorkbookSheet(sheetId, {
  sheet, body = null, layout = MBP_WORKBOOK_LAYOUT, today, period = 'all', readOnly = false,
} = {}) {
  const geometry = sheetGeometry(layout, sheetId), { spec } = geometry;
  const grid = spec.grid;
  const templates = spec.templates, rowTemplate = spec.rowTemplate;
  const fields = body && !readOnly
    ? new Map(mbpSheetFields(body, sheet).map(field => [field.sourceAddress, field]))
    : new Map();
  const footer = workbookFooter(sheet);
  const footerCells = new Set(grid.footerCells);
  const flagOf = new Map(Object.entries(grid.flags));
  const rows = [];
  for (let r = 1; r <= spec.rows; r++) {
    if (geometry.hiddenRows.has(r)) continue;
    if (r >= grid.dataFrom && r <= grid.dataTo) {
      const row = sheet.rows[r - grid.dataFrom];
      if (!row || !inPeriod(row, period, value => mbpSaturday(value))) continue;
    }
    rows.push(r);
  }
  const cols = [];
  for (let c = 1; c <= spec.cols; c++) if (!geometry.hiddenCols.has(c)) cols.push(c);
  const styleOf = (r, c) => layout.styles[templates[rowTemplate[r]]?.[c - 1] - 1] || null;
  const classOf = (r, c) => {
    const index = templates[rowTemplate[r]]?.[c - 1];
    return index ? `wbs${index}` : '';
  };
  const cellState = body?.mbpCellState || {};
  const contentOf = (r, c, address) => {
    const style = styleOf(r, c), nf = style?.nf || null;
    const letter = financeColumn(c);
    const label = spec.labels[address];
    if (r >= grid.dataFrom && r <= grid.dataTo) {
      const row = sheet.rows[r - grid.dataFrom];
      if (!row) return {};
      if (c === grid.quarterCol) return { html: e(`Q${String(row.quarter).replace('Q', '')}`) };
      if (c === grid.dateCol) return { html: e(formatExcel(mbpSaturday(row.weekEnding), nf).text), title: `${spec.tab}!${address} · Sunday ${row.weekEnding} through Saturday ${mbpSaturday(row.weekEnding)}` };
      if (flagOf.has(letter)) {
        const [actualCol, planCol] = flagOf.get(letter);
        const flag = mbpFlag(row.weekEnding, row.v[actualCol], row.v[planCol], today);
        return { html: e(flag), classes: flag === 'Red' ? ['is-flag-red'] : [], title: `${spec.tab}!${address} · ${flag === 'Red' ? 'Cumulative actual is behind cumulative plan' : 'On or ahead of plan, or the week has not closed'}` };
      }
      const field = fields.get(address);
      if (field) return inputContent(body, field, cellState, spec, address, row.coverage?.[letter], nf);
      return valueContent(row.v[letter], nf, spec, address, row.coverage?.[letter]);
    }
    if (r === grid.footerRow) {
      if (!footerCells.has(letter)) return {};
      return valueContent(footer[letter], nf, spec, address, null);
    }
    const field = fields.get(address);
    if (field) return inputContent(body, field, cellState, spec, address, null, nf);
    if (address in sheet.top) return valueContent(sheet.top[address], nf, spec, address, null);
    if (label !== undefined && !DROPPED_LABELS.has(`${spec.kind}:${address}`)) return { html: e(label), text: label, spill: !style?.wrap && (!style?.h || style.h === 'left'), clip: !!style?.wrap };
    return {};
  };
  return renderGrid({ geometry, rows, cols, merges: spec.merges, classOf, contentOf, styleOf, freeze: spec.freeze, label: `${spec.tab}. Workbook grid.` });
}

function valueContent(value, nf, spec, address, coverage) {
  const formatted = formatExcel(value, nf);
  const incomplete = coverage && coverage.state !== 'complete';
  return {
    html: cellHtml(formatted, incomplete ? '<span class="wb-incomplete" aria-label="Missing inputs">*</span>' : ''),
    classes: formatted.red ? ['is-negative'] : [],
    text: formatted.text, lead: formatted.lead, marker: !!incomplete,
    title: `${spec.tab}!${address}${incomplete ? ' · Missing inputs; not a confirmed zero' : ''}`,
  };
}

/**
 * An input cell shows what the workbook shows and reveals the editable number only while
 * it has focus, exactly as Excel swaps the cell display for the formula bar's value.
 * `data-raw` is the value to edit, `data-display` the formatted one to put back.
 */
function inputHtml(extra, { raw, formatted, incomplete }) {
  const input = `<input class="wb-input" type="text" inputmode="decimal" autocomplete="off" ${extra}`
    + ` data-raw="${e(raw)}" data-display="${e(formatted.text)}" value="${e(formatted.text)}">`;
  const marker = incomplete ? '<span class="wb-incomplete wb-mark" aria-label="Missing inputs">*</span>' : '';
  if (!formatted.accounting || !formatted.lead) return input + marker;
  return `<span class="wb-acc"><i>${e(formatted.lead)}</i><em>${input}</em></span>${marker}`;
}

function inputContent(body, field, cellState, spec, address, coverage, nf) {
  const state = cellState[field.key] || {};
  const manual = state.origin === 'manual', automatic = state.origin === 'topcoat';
  const value = getMbpInput(body, field.key);
  const incomplete = coverage && coverage.state !== 'complete';
  const resettable = field.live && state.sourceAvailable === true && state.origin !== 'topcoat' && manual;
  const context = `${field.lineId === 'painting' ? 'FTP' : field.lineId === 'epoxy' ? 'PEC' : 'TOTAL'} ${field.kind === 'sales' ? 'Sales' : 'Revenue'} `
    + `${field.weekEnding === 'annual' ? 'annual' : mbpSaturday(field.weekEnding)} ${field.label}`;
  const formatted = formatExcel(value, nf);
  return {
    classes: ['wb-edit', manual ? 'is-manual' : '', automatic ? 'is-automatic' : ''].filter(Boolean),
    text: formatted.text, lead: formatted.lead, marker: !!incomplete,
    title: `${spec.tab}!${address} · ${manual ? 'Manually edited' : automatic ? (state.sourceAvailable === false ? 'TopCoat · last available' : 'TopCoat') : field.actual ? 'Manual input' : 'Plan input'}`,
    html: inputHtml(`data-mbp-key="${e(field.key)}" data-cell="${e(address)}"${resettable ? ` data-mbp-reset="${e(field.key)}"` : ''} aria-label="${e(context)}"`,
      { raw: mbpInputValue(value, field), formatted, incomplete }),
  };
}

/* --------------------------------------------- Budget - 2 / Income Statement - 2 */

/**
 * Render a finance sheet with the workbook's own presentation. Values, account names,
 * formulas and input ranges all come from the private finance document; only the
 * geometry and cell styles come from the generated layout.
 */
export function renderWorkbookFinance(sheetId, {
  body, computed, layout = MBP_WORKBOOK_LAYOUT, readOnly = false, openGroups = new Set(), sectionRows = new Map(),
  showHiddenValues = false,
} = {}) {
  const geometry = sheetGeometry(layout, sheetId), { spec } = geometry;
  const sheet = body.sheets.find(item => item.kind === spec.kind);
  const result = computed?.sheets?.find(item => item.id === sheet?.id);
  if (!sheet) return '';
  const templates = spec.templates, rowTemplate = spec.rowTemplate;
  const outlineHidden = outlineHiddenRows(layout, sheetId, openGroups);
  const revealed = new Set(showHiddenValues ? workbookHiddenValueRows(sheetId, sheet, layout) : []);
  const rows = [];
  for (let r = 1; r <= spec.rows; r++) {
    if (revealed.has(r)) { rows.push(r); continue; }
    if (!outlineHidden.has(r) && !(geometry.hiddenRows.has(r) && !insideGroup(layout, sheetId, r))) rows.push(r);
  }
  const cols = [];
  for (let c = 1; c <= spec.cols; c++) if (!geometry.hiddenCols.has(c)) cols.push(c);
  const inputs = new Map();
  for (const item of sheet.inputRanges || []) {
    const [a, b = a] = item.range.split(':'), [r1, c1] = coordinate(a), [r2, c2] = coordinate(b);
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const key = `${financeColumn(c)}${r}`; if (!inputs.has(key)) inputs.set(key, item); }
  }
  const classOf = (r, c) => { const index = templates[rowTemplate[r]]?.[c - 1]; return index ? `wbs${index}` : ''; };
  const contentOf = (r, c, address) => {
    const style = layout.styles[templates[rowTemplate[r]]?.[c - 1] - 1] || null;
    const raw = sheet.cells[address] || {};
    const range = inputs.get(address);
    const editable = !readOnly && !raw.f && (raw.editable === true || !!range);
    const cell = { ...raw, ...result?.cells?.[address] };
    const section = c === 2 ? sectionRows.get(r) : null;
    const title = `${spec.tab}!${address}${cell.f ? ` ${cell.f}` : ''}${cell.error ? ' · Source formula needs attention' : ''}`;
    if (cell.error) return { html: e(cell.error), classes: ['wb-error'], title, text: cell.error };
    if (section && !readOnly) {
      return {
        classes: ['wb-edit', 'wb-text'], title: `${title} · ${section.label}. Renaming updates the Budget tab.`,
        html: `<input class="wb-input" type="text" data-finance-label="${r}" data-cell="${e(address)}" maxlength="120" autocomplete="off"`
          + ` aria-label="${e(`Account name, row ${r}, ${section.label}`)}" placeholder="Empty slot" value="${e(typeof cell.v === 'string' ? cell.v : '')}">`,
        text: typeof cell.v === 'string' ? cell.v : '',
      };
    }
    const nf = style?.nf || cell.format || null;
    if (editable) {
      const shown = formatExcel(cell.v, nf);
      return {
        classes: ['wb-edit'], title, text: shown.text, lead: shown.lead,
        html: inputHtml(`data-finance-cell="${e(address)}" data-cell="${e(address)}" aria-label="${e(`${sheet.name} ${address}`)}"`,
          { raw: financeInputValue({ ...raw, ...range }), formatted: shown, incomplete: false }),
      };
    }
    const text = typeof cell.v === 'string';
    const formatted = text || !nf ? { lead: '', text: cell.v == null ? '' : text ? cell.v : financeDisplay(cell), red: false, accounting: false } : formatExcel(cell.v, nf);
    return { html: cellHtml(formatted), classes: formatted.red ? ['is-negative'] : [], title,
      text: formatted.text, lead: formatted.lead,
      spill: text && !style?.wrap && (!style?.h || style.h === 'left'), clip: text && !!style?.wrap };
  };
  const groups = workbookRowGroups(layout, sheetId, openGroups);
  const summaryOf = new Map(groups.filter(group => group.summary).map(group => [group.summary, group]));
  const gutter = r => {
    const group = summaryOf.get(r);
    if (!group) return '<th class="wb-outline" scope="row"></th>';
    return `<th class="wb-outline" scope="row"><button type="button" data-action="workbook-group" data-group="${e(group.id)}"`
      + ` aria-expanded="${group.expanded}" aria-label="${group.expanded ? 'Collapse' : 'Expand'} rows ${group.from} to ${group.to}">${group.expanded ? '−' : '+'}</button></th>`;
  };
  return renderGrid({ geometry, rows, cols, merges: spec.merges, classOf, contentOf, styleOf: (r, c) => layout.styles[templates[rowTemplate[r]]?.[c - 1] - 1] || null, freeze: spec.freeze, gutter, label: `${spec.tab}. Workbook grid.` });
}

function insideGroup(layout, sheetId, row) {
  return (layout.sheets[sheetId]?.rowGroups || []).some(group => row >= group.from && row <= group.to);
}

/* --------------------------------------------------------------- summary page */

// Budget - 2 summary addresses. Column I is this fiscal year's plan, BL the year-to-date
// actual and BM the gap; the label cell is checked before a number is shown so a changed
// workbook layout reports itself instead of printing the wrong line.
export const SUMMARY_PL = [
  { label: 'Revenue · FTP', check: ['H6', 'FTP'], plan: 'I6', actual: 'BL6', gap: 'BM6' },
  { label: 'Revenue · PEC', check: ['H7', 'PEC'], plan: 'I7', actual: 'BL7', gap: 'BM7' },
  { label: 'Total Revenue', check: ['I27', 'Total Revenue'], plan: 'I28', actual: 'BL28', gap: 'BM28' },
  { label: 'Total Variable Expenses', check: ['H787', 'Total Variable Expenses'], plan: 'I787', actual: 'BL787', gap: 'BM787' },
  { label: 'Gross Profit', check: ['H790', 'Gross Profit'], plan: 'I790', actual: 'BL790', gap: 'BM790', planRate: 'J790', actualRate: 'BN790' },
  { label: 'Total Fixed Expenses', check: ['I896', 'Fixed Expenses'], plan: 'I897', actual: 'BL897', gap: 'BM897' },
  { label: 'Net Profit', check: ['I900', 'Net Profit'], plan: 'I901', actual: 'BL901', gap: 'BM901', planRate: 'J901', actualRate: 'BN901' },
];
const MONEY = '_($* #,##0_);[red]_($* (#,##0);_($* "-"??_)';
const RATE = '0.0%;[red](0.0)%;""';

/** The P&L box on the MBP summary page, read straight from Budget - 2's own cells. */
export function renderSummaryPL(body, computed) {
  const sheet = body?.sheets?.find(item => item.kind === 'budget');
  const result = computed?.sheets?.find(item => item.id === sheet?.id);
  if (!sheet) return '<p class="tc-small tc-muted">No budget year is loaded.</p>';
  const value = address => result?.cells?.[address]?.v ?? sheet.cells[address]?.v ?? null;
  const cell = (address, nf) => `<td>${cellHtml(formatExcel(value(address), nf))}</td>`;
  const rows = SUMMARY_PL.map(line => {
    const [address, expected] = line.check;
    const label = String(result?.cells?.[address]?.v ?? sheet.cells[address]?.v ?? '').trim();
    if (label !== expected) return `<tr><th scope="row">${e(line.label)}</th><td colspan="3" class="tc-small tc-muted">Unavailable · Budget - 2 row moved</td></tr>`;
    return `<tr><th scope="row">${e(line.label)}${line.actualRate ? ` <span class="tc-small tc-muted">${e(formatExcel(value(line.actualRate), RATE).text || '')}</span>` : ''}</th>`
      + cell(line.plan, MONEY) + cell(line.actual, MONEY) + cell(line.gap, MONEY) + '</tr>';
  }).join('');
  return `<table class="tc-wb-pl"><caption>Budget - 2 · Plan versus year-to-date actual</caption><thead><tr><th></th><th>Plan</th><th>YTD actual</th><th>Gap</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// The workbook's own top boxes, reused unchanged so the summary page and the full-screen
// sheet show the same thing in the same style.
const TOP_BOX = { sales: { from: 3, to: 7, cols: 13 }, revenue: { from: 3, to: 6, cols: 4 } };

/** One sheet's top box, rendered from the same layout as the full-screen grid. */
export function renderWorkbookTopBox(sheetId, { sheet, layout = MBP_WORKBOOK_LAYOUT } = {}) {
  const geometry = sheetGeometry(layout, sheetId), { spec } = geometry;
  const box = TOP_BOX[spec.kind];
  const templates = spec.templates, rowTemplate = spec.rowTemplate;
  const rows = [];
  for (let r = box.from; r <= box.to; r++) if (!geometry.hiddenRows.has(r)) rows.push(r);
  const cols = [];
  for (let c = 1; c <= box.cols; c++) if (!geometry.hiddenCols.has(c)) cols.push(c);
  const classOf = (r, c) => { const index = templates[rowTemplate[r]]?.[c - 1]; return index ? `wbs${index}` : ''; };
  const contentOf = (r, c, address) => {
    const style = layout.styles[templates[rowTemplate[r]]?.[c - 1] - 1] || null;
    if (address in sheet.top) return valueContent(sheet.top[address], style?.nf || null, spec, address, null);
    const label = spec.labels[address];
    if (label !== undefined && !DROPPED_LABELS.has(`${spec.kind}:${address}`)) return { html: e(label), text: label, spill: !style?.wrap && (!style?.h || style.h === 'left'), clip: !!style?.wrap };
    return {};
  };
  const merges = spec.merges.filter(merge => {
    const [a] = merge.split(':'), [r] = coordinate(a);
    return r >= box.from && r <= box.to;
  });
  const styleOf = (r, c) => layout.styles[templates[rowTemplate[r]]?.[c - 1] - 1] || null;
  return `<div class="tc-wb-box"><h3>${e(spec.tab)}</h3>`
    + renderGrid({ geometry, rows, cols, merges, classOf, contentOf, styleOf, freeze: null, label: `${spec.tab} summary box` })
    + `<button type="button" class="tc-button" data-action="workbook-open" data-sheet="${e(sheetId)}">Open ${e(spec.tab)}</button></div>`;
}

/* ---------------------------------------------------------- notes and keyboard */

/** Every note that used to sit above the grids, gathered for the toolbar's side panel. */
export function workbookNotes({ mbpBody = null, financeBody = null, financeIssues = [], liveMessage = '', config = {}, sourceFeed = null } = {}) {
  const notes = [];
  const live = mbpBody?.mbpLiveState;
  notes.push({ kind: 'source', text: config.mbpLiveEnabled === false
    ? 'PEC automatic updates are paused in Routine settings. FTP stays manual.'
    : `PEC updates on opening these plans and every ${config.mbpRefreshMinutes || 5} minutes while they are open. FTP stays manual.` });
  if (live?.queriedAt) notes.push({ kind: 'source', text: `TopCoat checked ${new Date(live.queriedAt).toLocaleString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} Arizona time. The current week is still in progress.` });
  if (liveMessage) notes.push({ kind: 'source', text: liveMessage });
  for (const warning of live?.warnings || []) notes.push({ kind: 'coverage', text: warning });
  notes.push({ kind: 'legend', text: 'Yellow cells were manually edited. A star marks missing inputs, which are not a confirmed zero.' });
  if (mbpBody?.source) notes.push({ kind: 'source', text: `Imported reference: ${mbpBody.source.file || 'MBP 2026'}. Original actuals stop ${mbpBody.source.lastEntry || 'May 10, 2026'}. Blank weeks are not zero.` });
  for (const exception of sourceFeed?.exceptions || []) notes.push({ kind: 'exception', text: `${exception.label} · ${exception.reason} ${exception.action}` });
  for (const warning of financeBody?.source?.warnings || []) notes.push({ kind: 'workbook', text: warning });
  if (financeIssues.length) notes.push({ kind: 'formula', text: `${financeIssues.length} source formula cells need attention: ${financeIssues.slice(0, 12).map(issue => `${issue.sheetId}!${issue.address}: ${issue.code}`).join(' · ')}` });
  return notes;
}

/**
 * Next cell for a keyboard move. `cells` is the ordered list of editable cell addresses
 * as they appear in the grid; formula cells are never in it, so Enter and Tab skip them.
 */
export function workbookNavigate(cells, current, key, shift = false) {
  if (!cells.length) return null;
  const index = cells.indexOf(current);
  if (index < 0) return cells[0];
  const [row, col] = coordinate(current);
  if (key === 'Enter' || key === 'ArrowDown' || key === 'ArrowUp') {
    const wanted = key === 'ArrowUp' || (key === 'Enter' && shift) ? -1 : 1;
    const column = cells.filter(address => coordinate(address)[1] === col).sort((a, b) => coordinate(a)[0] - coordinate(b)[0]);
    const at = column.indexOf(current);
    return column[at + wanted] ?? current;
  }
  if (key === 'Tab' || key === 'ArrowRight' || key === 'ArrowLeft') {
    const wanted = key === 'ArrowLeft' || (key === 'Tab' && shift) ? -1 : 1;
    if (key === 'Tab') return cells[index + wanted] ?? current;
    const line = cells.filter(address => coordinate(address)[0] === row).sort((a, b) => coordinate(a)[1] - coordinate(b)[1]);
    const at = line.indexOf(current);
    return line[at + wanted] ?? current;
  }
  return current;
}
