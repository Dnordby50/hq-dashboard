// Private workbook values belong in the owner document store, never in this module.
// Deliberately limited spreadsheet interpreter: formulas are parsed as data, never JavaScript.
export const FINANCE_VERSION = '2026-09-08.1';
export class FinanceInputError extends Error {
  constructor(path, message) { super(`${path}: ${message}`); this.name = 'FinanceInputError'; this.path = path; }
}
class FormulaError extends Error { constructor(code) { super(code); this.code = code; } }
const fault = code => { throw new FormulaError(code); };
const fail = (path, message) => { throw new FinanceInputError(path, message); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const CELL = /^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i;
const DAY = 86400000, EPOCH = Date.UTC(1899, 11, 30);
const TYPES = new Set(['money', 'percent', 'number', 'text', 'date']);
const ROLES = new Set(['actual', 'plan', 'year', 'year-date', 'historical', 'selector']);
export function financeColumnNumber(label) {
  let n = 0;
  for (const ch of label.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}
export function financeColumnName(number) {
  let result = '';
  while (number > 0) { number--; result = String.fromCharCode(65 + number % 26) + result; number = Math.floor(number / 26); }
  return result;
}
function point(address) {
  const match = CELL.exec(address);
  return match ? { col: financeColumnNumber(match[1]), row: Number(match[2]) } : null;
}
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function safeJson(value, path, state, depth = 0) {
  if (++state.nodes > 1800000 || depth > 20) fail(path, 'document is too complex');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(path, 'expected a finite number'); return; }
  if (typeof value === 'string') { if (value.length > 250000) fail(path, 'text is too long'); return; }
  if (Array.isArray(value)) { value.forEach((item, i) => safeJson(item, `${path}[${i}]`, state, depth + 1)); return; }
  if (!plain(value)) fail(path, 'expected JSON data');
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(path, 'unsafe object key');
    safeJson(item, `${path}.${key}`, state, depth + 1);
  }
}

function tokenize(formula) {
  const text = formula.startsWith('=') ? formula.slice(1) : formula;
  const tokens = []; let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (tokens.length > 4000) throw new Error('formula is too complex');
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let value = '', closed = false; i++;
      while (i < text.length) {
        if (text[i] === ch) {
          if (text[i + 1] === ch) { value += ch; i += 2; continue; }
          i++; closed = true; break;
        }
        value += text[i++];
      }
      if (!closed) throw new Error('unterminated quote');
      tokens.push({ type: ch === '"' ? 'string' : 'sheet', value }); continue;
    }
    const remainder = text.slice(i);
    const error = /^(#REF!|#DIV\/0!|#VALUE!|#N\/A|#NAME\?|#NUM!|#NULL!)/i.exec(remainder);
    if (error) { tokens.push({ type: 'error', value: error[0].toUpperCase() }); i += error[0].length; continue; }
    const num = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/.exec(remainder);
    if (num) { tokens.push({ type: 'number', value: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^\$?[A-Za-z_][A-Za-z0-9_.$]*/.exec(remainder);
    if (id) { tokens.push({ type: 'id', value: id[0] }); i += id[0].length; continue; }
    const operator = /^(<=|>=|<>|[+\-*/^&=<>:!,;()%])/.exec(remainder);
    if (operator) { tokens.push({ type: operator[0] === ';' ? ',' : operator[0], value: operator[0] }); i += operator[0].length; continue; }
    throw new Error(`unsupported formula character at ${i + 1}`);
  }
  tokens.push({ type: 'end' }); return tokens;
}
function parseFormula(formula) {
  const tokens = tokenize(formula); let i = 0, depth = 0;
  const peek = () => tokens[i];
  const take = type => { if (peek().type === type) return tokens[i++]; return null; };
  const need = type => { const token = take(type); if (!token) throw new Error(`expected ${type}`); return token; };
  const precedence = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
  function reference(token, sheet = null) {
    const start = point(token.value);
    const column = /^\$?[A-Z]{1,3}$/i.test(token.value) ? financeColumnNumber(token.value.replace('$', '')) : null;
    if (take(':')) {
      const endToken = need('id'), end = point(endToken.value);
      if (start && end) return { type: 'range', sheet, start, end };
      if (column && /^\$?[A-Z]{1,3}$/i.test(endToken.value)) return { type: 'range', sheet, start: { col: column, row: 1 }, end: { col: financeColumnNumber(endToken.value.replace('$', '')), row: null } };
      throw new Error('invalid range');
    }
    if (start) return { type: 'ref', sheet, address: `${financeColumnName(start.col)}${start.row}` };
    return { type: 'name', value: token.value };
  }
  function primary() {
    if (++depth > 120) throw new Error('formula nesting is too deep');
    try {
      if (take('+')) return { type: 'unary', operator: '+', arg: primary() };
      if (take('-')) return { type: 'unary', operator: '-', arg: primary() };
      if (take('(')) { const node = expression(0); need(')'); return node; }
      const token = peek(); i++;
      if (['number', 'string', 'error'].includes(token.type)) return token;
      if (!['id', 'sheet'].includes(token.type)) throw new Error('expected a value or reference');
      if (take('!')) {
        const refToken = peek();
        if (take('error')) return refToken;
        return reference(need('id'), token.value);
      }
      if (token.type === 'sheet') throw new Error('quoted sheet needs a cell reference');
      if (take('(')) {
        const args = [];
        if (!take(')')) {
          do { args.push([',', ')'].includes(peek().type) ? { type: 'blank' } : expression(0)); } while (take(','));
          need(')');
        }
        return { type: 'call', name: token.value.toUpperCase().replace(/^_XLFN\./, ''), args };
      }
      if (/^(TRUE|FALSE)$/i.test(token.value)) return { type: 'boolean', value: token.value.toUpperCase() === 'TRUE' };
      return reference(token);
    } finally { depth--; }
  }
  function expression(minimum) {
    let left = primary();
    while (true) {
      if (take('%')) { left = { type: 'unary', operator: '%', arg: left }; continue; }
      const operator = peek().type, rank = precedence[operator];
      if (!rank || rank < minimum) break;
      i++;
      left = { type: 'binary', operator, left, right: expression(rank + 1) };
    }
    return left;
  }
  const result = expression(0); need('end'); return result;
}

export function validateFinance(body) {
  if (!plain(body)) fail('finance', 'expected an object');
  safeJson(body, 'finance', { nodes: 0 });
  if (body.schemaVersion !== 1) fail('schemaVersion', 'unsupported finance schema');
  if (!Number.isInteger(body.year) || body.year < 1900 || body.year > 2200) fail('year', 'expected a year from 1900 through 2200');
  if (!plain(body.source)) fail('source', 'expected source metadata');
  if (!Array.isArray(body.sheets) || body.sheets.length < 1 || body.sheets.length > 12) fail('sheets', 'expected 1 to 12 sheets');
  const ids = new Set(), names = new Set(); let cells = 0;
  for (const [index, sheet] of body.sheets.entries()) {
    const path = `sheets[${index}]`;
    if (!plain(sheet)) fail(path, 'expected a sheet');
    if (typeof sheet.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(sheet.id) || ids.has(sheet.id)) fail(`${path}.id`, 'expected a unique sheet id');
    if (typeof sheet.name !== 'string' || !sheet.name.trim() || sheet.name.length > 120 || names.has(sheet.name.toLowerCase())) fail(`${path}.name`, 'expected a unique sheet name');
    ids.add(sheet.id); names.add(sheet.name.toLowerCase());
    if (!['budget', 'income', 'support'].includes(sheet.kind)) fail(`${path}.kind`, 'unknown sheet kind');
    if (!Number.isInteger(sheet.rows) || sheet.rows < 1 || sheet.rows > 5000 || !Number.isInteger(sheet.cols) || sheet.cols < 1 || sheet.cols > 512) fail(path, 'sheet dimensions are outside the permitted range');
    if (!plain(sheet.cells)) fail(`${path}.cells`, 'expected cell data');
    for (const [address, cell] of Object.entries(sheet.cells)) {
      if (++cells > 180000) fail('sheets', 'too many cells');
      const p = point(address), cp = `${path}.cells.${address}`;
      if (!p || address !== `${financeColumnName(p.col)}${p.row}` || p.row > sheet.rows || p.col > sheet.cols) fail(cp, 'cell is outside the sheet dimensions');
      if (!plain(cell) || (!own(cell, 'v') && !cell.f) || (own(cell, 'v') && !(cell.v === null || ['string', 'boolean', 'number'].includes(typeof cell.v)))) fail(cp, 'expected a primitive cell value');
      if (cell.t !== undefined && !TYPES.has(cell.t)) fail(`${cp}.t`, 'unknown cell type');
      if (cell.role !== undefined && !ROLES.has(cell.role)) fail(`${cp}.role`, 'unknown cell role');
      if (cell.editable !== undefined && typeof cell.editable !== 'boolean') fail(`${cp}.editable`, 'expected a boolean');
      if (cell.f !== undefined) {
        if (typeof cell.f !== 'string' || !cell.f.startsWith('=') || cell.f.length > 16000) fail(`${cp}.f`, 'expected a formula beginning with =');
        if (cell.editable) fail(cp, 'calculated cells cannot be editable');
        try { parseFormula(cell.f); } catch (error) { fail(`${cp}.f`, error.message); }
      }
      if (cell.role === 'actual' && cell.f) fail(cp, 'actual entry cells cannot contain formulas');
    }
    if (sheet.inputRanges !== undefined) {
      if (!Array.isArray(sheet.inputRanges) || sheet.inputRanges.length > 5000) fail(`${path}.inputRanges`, 'invalid input ranges');
      for (const input of sheet.inputRanges) {
        if (!plain(input) || !['plan', 'actual', 'historical', 'selector'].includes(input.role) || (input.t !== undefined && !TYPES.has(input.t))) fail(`${path}.inputRanges`, 'invalid input metadata');
        const ends = typeof input.range === 'string' ? input.range.split(':').map(point) : [];
        if (ends.length === 1) ends.push(ends[0]);
        if (ends.length !== 2 || ends.some(p => !p || p.row > sheet.rows || p.col > sheet.cols) || ends[0].row > ends[1].row || ends[0].col > ends[1].col) fail(`${path}.inputRanges`, 'invalid input range');
      }
    }
    for (const field of ['hiddenRows', 'hiddenCols']) {
      if (sheet[field] !== undefined && (!Array.isArray(sheet[field]) || sheet[field].some(n => !Number.isInteger(n) || n < 1 || n > sheet[field === 'hiddenRows' ? 'rows' : 'cols']))) fail(`${path}.${field}`, 'invalid hidden row or column');
    }
    if (sheet.merges !== undefined) {
      if (!Array.isArray(sheet.merges) || sheet.merges.length > 10000) fail(`${path}.merges`, 'invalid merged cells');
      for (const merge of sheet.merges) {
        const ends = typeof merge === 'string' ? merge.split(':').map(point) : [];
        if (ends.length !== 2 || ends.some(p => !p || p.row > sheet.rows || p.col > sheet.cols) || ends[0].row > ends[1].row || ends[0].col > ends[1].col) fail(`${path}.merges`, 'invalid merged cells');
      }
    }
  }
  if (body.historicalMappings !== undefined) {
    if (!Array.isArray(body.historicalMappings) || body.historicalMappings.length > 5000) fail('historicalMappings', 'invalid historical mappings');
    const byId = new Map(body.sheets.map(sheet => [sheet.id, sheet]));
    for (const [index, mapping] of body.historicalMappings.entries()) {
      const path = `historicalMappings[${index}]`;
      if (!plain(mapping) || !['copy', 'sum-actuals'].includes(mapping.mode)) fail(path, 'invalid historical mapping');
      const fromSheet = byId.get(mapping.fromSheetId), toSheet = byId.get(mapping.toSheetId);
      const from = rectangle(mapping.from), to = rectangle(mapping.to);
      if (!fromSheet || !toSheet || !from || !to || from.end.row > fromSheet.rows || from.end.col > fromSheet.cols || to.end.row > toSheet.rows || to.end.col > toSheet.cols || from.height !== to.height || (mapping.mode === 'copy' ? from.width !== to.width : to.width !== 1)) fail(path, 'historical mapping dimensions do not match');
      for (let row = to.start.row; row <= to.end.row; row++) for (let col = to.start.col; col <= to.end.col; col++) {
        if (toSheet.cells[`${financeColumnName(col)}${row}`]?.f && !(mapping.mode === 'copy' && historicalLabel(toSheet, row, col))) fail(path, 'historical mappings cannot replace calculated cells outside historical labels');
      }
    }
  }
  return body;
}
function rectangle(value) {
  if (typeof value !== 'string') return null;
  const ends = value.split(':').map(point);
  if (ends.length < 1 || ends.length > 2 || ends.some(p => !p)) return null;
  const start = ends[0], end = ends[1] || start;
  if (start.col > end.col || start.row > end.row) return null;
  return { start, end, width: end.col - start.col + 1, height: end.row - start.row + 1 };
}
function historicalLabel(sheet, row, col) {
  return (sheet.inputRanges || []).some(input => {
    if (input.role !== 'historical' || input.t !== 'text') return false;
    const bounds = rectangle(input.range);
    return bounds && row >= bounds.start.row && row <= bounds.end.row && col >= bounds.start.col && col <= bounds.end.col;
  });
}
function numeric(value) {
  if (value === null || value === '') return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fault('#VALUE!');
}
function finite(value) { return Number.isFinite(value) ? value : fault('#NUM!'); }
function scalar(value) { if (value?.range) return value.values.length === 1 ? value.get(0) : fault('#VALUE!'); return value; }
function truth(value) { value = scalar(value); return value === null || value === '' ? false : typeof value === 'string' ? (/^true$/i.test(value) ? true : /^false$/i.test(value) ? false : fault('#VALUE!')) : Boolean(value); }
function textValue(value) { value = scalar(value); return value === null ? '' : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value); }
function compare(left, right, operator) {
  // Excel compares text case-insensitively; blank references compare as zero or empty text.
  if (left === null) left = typeof right === 'string' ? '' : 0;
  if (right === null) right = typeof left === 'string' ? '' : 0;
  if (typeof left === 'string' && typeof right === 'string') { left = left.toLowerCase(); right = right.toLowerCase(); }
  const sameType = typeof left === typeof right;
  const equals = sameType && left === right;
  const rank = value => typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : 2;
  const ordering = sameType ? (left < right ? -1 : left > right ? 1 : 0) : rank(left) - rank(right);
  return ({ '=': equals, '<>': !equals, '<': ordering < 0, '>': ordering > 0, '<=': ordering <= 0, '>=': ordering >= 0 })[operator];
}
function criterionMatcher(raw) {
  raw = scalar(raw);
  if (typeof raw !== 'string') return value => compare(value, raw, '=');
  const match = /^(<=|>=|<>|=|<|>)(.*)$/.exec(raw);
  const operator = match?.[1] ?? '=', text = match?.[2] ?? raw;
  const target = text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : text;
  if (typeof target === 'string' && /[*?~]/.test(target) && ['=', '<>'].includes(operator)) {
    let pattern = '';
    const escape = char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (let i = 0; i < target.length; i++) {
      const ch = target[i];
      if (ch === '~' && i + 1 < target.length) pattern += escape(target[++i]);
      else pattern += ch === '*' ? '.*' : ch === '?' ? '.' : escape(ch);
    }
    const re = new RegExp(`^${pattern}$`, 'i');
    return value => operator === '=' ? re.test(value ?? '') : !re.test(value ?? '');
  }
  return value => {
    if (typeof target === 'number' && typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) value = Number(value);
    return compare(value, target, operator);
  };
}
function serialDate(value) {
  value = scalar(value);
  const ms = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : EPOCH + numeric(value) * DAY;
  if (!Number.isFinite(ms)) fault('#VALUE!');
  return new Date(ms);
}

export function calculateFinance(body) {
  validateFinance(body);
  const output = JSON.parse(JSON.stringify(body)); output.issues = [];
  const sheets = new Map(output.sheets.map(sheet => [sheet.name.toLowerCase(), sheet]));
  const memo = new Map(), active = new Set(), syntax = new Map(); let operations = 0;
  const tick = () => { if (++operations > 30000000) fault('#LIMIT!'); };
  function get(sheet, address) {
    tick(); const key = `${sheet.id}!${address}`;
    if (memo.has(key)) { const stored = memo.get(key); if (stored instanceof FormulaError) throw stored; return stored; }
    if (active.has(key)) fault('#CYCLE!');
    const cell = sheet.cells[address]; if (!cell) return null;
    if (!cell.f) {
      delete cell.error;
      if (typeof cell.v === 'string' && /^#(?:REF!|DIV\/0!|VALUE!|N\/A|NAME\?|NUM!|NULL!)$/.test(cell.v)) { const err = new FormulaError(cell.v); cell.error = err.code; output.issues.push({ sheetId: sheet.id, address, code: err.code }); memo.set(key, err); throw err; }
      memo.set(key, cell.v); return cell.v;
    }
    active.add(key);
    try {
      let ast = syntax.get(cell.f);
      if (!ast) { ast = parseFormula(cell.f); syntax.set(cell.f, ast); }
      const result = scalar(evaluate(ast, sheet));
      cell.v = typeof result === 'number' ? finite(result) : result;
      delete cell.error; memo.set(key, cell.v); return cell.v;
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error;
      cell.v = null; cell.error = error.code; memo.set(key, error);
      output.issues.push({ sheetId: sheet.id, address, code: error.code }); throw error;
    } finally { active.delete(key); }
  }
  function range(node, current) {
    const sheet = node.sheet ? sheets.get(node.sheet.toLowerCase()) : current;
    if (!sheet) fault('#REF!');
    const endRow = node.end.row ?? sheet.rows;
    if (node.start.col > node.end.col || node.start.row > endRow || node.end.col > 16384 || endRow > 1048576) fault('#REF!');
    const width = node.end.col - node.start.col + 1, height = endRow - node.start.row + 1;
    if (width * height > 180000) fault('#LIMIT!');
    // Address arrays avoid computing cells that IF/SUMIFS never need.
    return { range: true, width, height, values: { length: width * height }, get(index) {
      return get(sheet, `${financeColumnName(node.start.col + index % width)}${node.start.row + Math.floor(index / width)}`);
    } };
  }
  function evaluate(node, sheet) {
    tick();
    if (['number', 'string', 'boolean'].includes(node.type)) return node.value;
    if (node.type === 'blank') return null;
    if (node.type === 'error') fault(node.value);
    if (node.type === 'name') fault('#NAME?');
    if (node.type === 'ref') {
      const target = node.sheet ? sheets.get(node.sheet.toLowerCase()) : sheet;
      if (!target) fault('#REF!'); return get(target, node.address);
    }
    if (node.type === 'range') return range(node, sheet);
    if (node.type === 'unary') { const value = numeric(scalar(evaluate(node.arg, sheet))); return node.operator === '-' ? -value : node.operator === '%' ? value / 100 : value; }
    if (node.type === 'binary') {
      const left = scalar(evaluate(node.left, sheet)), right = scalar(evaluate(node.right, sheet)), op = node.operator;
      if (op === '&') return textValue(left) + textValue(right);
      if (['=', '<>', '<', '>', '<=', '>='].includes(op)) return compare(left, right, op);
      const a = numeric(left), b = numeric(right);
      if (op === '/' && b === 0) fault('#DIV/0!');
      return finite(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : a ** b);
    }
    if (node.type !== 'call') fault('#VALUE!');
    const args = node.args, arg = index => args[index] ? evaluate(args[index], sheet) : null;
    if (node.name === 'IF') return truth(arg(0)) ? arg(1) : args.length > 2 ? arg(2) : false;
    if (node.name === 'IFERROR') { try { return scalar(arg(0)); } catch (error) { if (!(error instanceof FormulaError)) throw error; return arg(1); } }
    if (node.name === 'SUM') {
      let total = 0;
      for (let i = 0; i < args.length; i++) {
        const item = arg(i);
        if (item?.range) { for (let j = 0; j < item.values.length; j++) { const v = item.get(j); if (typeof v === 'number') total += v; } }
        else total += numeric(item);
      }
      return finite(total);
    }
    if (node.name === 'OR' || node.name === 'AND') {
      let result = node.name === 'AND';
      for (let i = 0; i < args.length; i++) {
        const item = arg(i), values = item?.range ? Array.from({ length: item.values.length }, (_, j) => item.get(j)).filter(v => typeof v !== 'string' && v !== null) : [item];
        for (const value of values) { const yes = truth(value); result = node.name === 'OR' ? result || yes : result && yes; }
      }
      return result;
    }
    if (node.name === 'SUMIF' || node.name === 'SUMIFS') {
      const sums = node.name === 'SUMIF' ? (args.length > 2 ? arg(2) : arg(0)) : arg(0);
      if (!sums?.range) fault('#VALUE!');
      const criteria = [];
      if (node.name === 'SUMIF') criteria.push({ range: arg(0), matches: criterionMatcher(arg(1)) });
      else {
        if (args.length < 3 || args.length % 2 !== 1) fault('#VALUE!');
        for (let i = 1; i < args.length; i += 2) criteria.push({ range: arg(i), matches: criterionMatcher(arg(i + 1)) });
      }
      if (criteria.some(c => !c.range?.range || c.range.width !== sums.width || c.range.height !== sums.height)) fault('#VALUE!');
      let total = 0;
      for (let i = 0; i < sums.values.length; i++) {
        let matches = true;
        for (const criterion of criteria) if (!criterion.matches(criterion.range.get(i))) { matches = false; break; }
        if (matches) { const value = sums.get(i); if (typeof value === 'number') total += value; }
      }
      return finite(total);
    }
    if (node.name === 'EDATE') {
      const date = serialDate(arg(0)), months = Math.trunc(numeric(scalar(arg(1))));
      if (!Number.isFinite(months) || Math.abs(months) > 120000) fault('#NUM!');
      const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
      const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      return finite((Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(date.getUTCDate(), last)) - EPOCH) / DAY);
    }
    if (node.name === 'DATE') {
      let year = Math.trunc(numeric(scalar(arg(0)))); if (year >= 0 && year < 1900) year += 1900;
      return finite((Date.UTC(year, Math.trunc(numeric(scalar(arg(1)))) - 1, Math.trunc(numeric(scalar(arg(2))))) - EPOCH) / DAY);
    }
    if (['YEAR', 'MONTH', 'DAY'].includes(node.name)) { const d = serialDate(arg(0)); return node.name === 'YEAR' ? d.getUTCFullYear() : node.name === 'MONTH' ? d.getUTCMonth() + 1 : d.getUTCDate(); }
    if (node.name === 'UPPER') return textValue(arg(0)).toUpperCase();
    if (node.name === 'LOWER') return textValue(arg(0)).toLowerCase();
    if (node.name === 'NOT') return !truth(arg(0));
    if (node.name === 'ABS') return Math.abs(numeric(scalar(arg(0))));
    if (node.name === 'ROUND') { const n = numeric(scalar(arg(0))), places = numeric(scalar(arg(1))), power = 10 ** places; return finite(Math.sign(n) * Math.round(Math.abs(n) * power + Number.EPSILON) / power); }
    fault('#NAME?');
  }
  for (const sheet of output.sheets) for (const address of Object.keys(sheet.cells)) {
    try { get(sheet, address); } catch (error) {
      if (!(error instanceof FormulaError)) throw error;
      const cell = sheet.cells[address];
      // Even a global work limit must never leave a formula's old cache visible.
      if (cell.f && !cell.error) {
        cell.v = null; cell.error = error.code;
        output.issues.push({ sheetId: sheet.id, address, code: error.code });
      }
    }
  }
  return output;
}

export function newFinanceYear(body, year) {
  validateFinance(body);
  if (!Number.isInteger(year) || year < 1900 || year > 2200 || year !== body.year + 1) fail('year', 'create the next consecutive year so historical actuals keep the correct fiscal year');
  const next = JSON.parse(JSON.stringify(body)), delta = year - body.year;
  next.year = year; delete next.issues;
  if (body.historicalMappings?.length) {
    const calculated = calculateFinance(body);
    const oldSheets = new Map(calculated.sheets.map(sheet => [sheet.id, sheet]));
    const nextSheets = new Map(next.sheets.map(sheet => [sheet.id, sheet]));
    next.carryForward = { fromYear: body.year, basis: 'recorded-actuals', entered: 0, expected: 0, partialRows: 0, issues: [] };
    for (const mapping of body.historicalMappings) {
      const from = rectangle(mapping.from), to = rectangle(mapping.to);
      const fromSheet = oldSheets.get(mapping.fromSheetId), toSheet = nextSheets.get(mapping.toSheetId);
      for (let row = 0; row < from.height; row++) {
        if (mapping.mode === 'copy') {
          for (let col = 0; col < from.width; col++) {
            const oldCell = fromSheet.cells[`${financeColumnName(from.start.col + col)}${from.start.row + row}`];
            const address = `${financeColumnName(to.start.col + col)}${to.start.row + row}`;
            const target = toSheet.cells[address] ||= { v: null };
            if (target.f) {
              // Snapshot prior labels beside their recorded actuals. Inherited links can
              // otherwise show a different stream's category as its name changes.
              delete target.f;
            }
            target.v = oldCell?.error ?? oldCell?.v ?? null;
          }
          continue;
        }
        let entered = 0, total = 0, error = null;
        for (let col = 0; col < from.width; col++) {
          const cell = fromSheet.cells[`${financeColumnName(from.start.col + col)}${from.start.row + row}`];
          if (cell?.error) { error ||= cell.error; continue; }
          if (cell?.v === null || cell?.v === undefined || cell?.v === '') continue;
          if (typeof cell.v !== 'number') { error ||= '#VALUE!'; continue; }
          entered++; total += cell.v;
        }
        const address = `${financeColumnName(to.start.col)}${to.start.row + row}`;
        const target = toSheet.cells[address] ||= { v: null };
        target.v = error || (entered ? total : null);
        next.carryForward.entered += entered; next.carryForward.expected += from.width;
        if (entered > 0 && entered < from.width) next.carryForward.partialRows++;
        if (error) next.carryForward.issues.push({ sheetId: toSheet.id, address, code: error });
      }
    }
  }
  for (const sheet of next.sheets) for (const [address, cell] of Object.entries(sheet.cells)) {
    delete cell.error;
    if (cell.f) { delete cell.v; continue; }
    const p = point(address);
    const inActualRange = (sheet.inputRanges || []).some(input => {
      if (input.role !== 'actual') return false;
      const ends = input.range.split(':').map(point), end = ends[1] || ends[0];
      return p.row >= ends[0].row && p.row <= end.row && p.col >= ends[0].col && p.col <= end.col;
    });
    if (cell.role === 'actual' || inActualRange) {
      cell.v = null;
      // Sparse entry ranges already preserve the input slot and its metadata.
      if (inActualRange && Object.keys(cell).every(key => ['v', 'editable', 'role', 't', 'carryForward'].includes(key))) {
        delete sheet.cells[address]; continue;
      }
    }
    delete cell.carryForward;
    if (cell.role === 'year') cell.v = year;
    if (cell.role === 'year-date' && cell.v !== null && cell.v !== '') {
      const date = serialDate(cell.v), targetYear = date.getUTCFullYear() + delta;
      const maxDay = new Date(Date.UTC(targetYear, date.getUTCMonth() + 1, 0)).getUTCDate();
      const stamp = Date.UTC(targetYear, date.getUTCMonth(), Math.min(date.getUTCDate(), maxDay));
      cell.v = typeof cell.v === 'string' ? new Date(stamp).toISOString().slice(0, 10) : (stamp - EPOCH) / DAY;
    }
  }
  return next;
}
