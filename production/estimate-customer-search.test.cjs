const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../apps/estimator/node_modules/typescript');
const root = path.join(__dirname, '..');

const business = {
  id: 'business-customer', name: 'Unacem NA', company_name: 'Unacem NA',
  first_name: 'Dan', last_name: 'Mosby', email: 'dan@example.test', phone: '(928) 555-0100',
  phone_norm: '9285550100', billing_address_line1: '100 Example Way', billing_city: 'Prescott',
  lead_source: 'Referral', archived_at: null,
};
const businessLead = {
  id: 'business-lead', full_name: 'Mesa Cement', business_name: 'Mesa Cement',
  first_name: 'Lena', last_name: 'Garcia', email: 'lena@example.test', phone: '9285550200',
  phone_norm: '9285550200', address: '200 Example Way', source: 'Google', stage: 'new',
  deleted_at: null, archived_at: null,
};

function splitClauses(value) {
  let depth = 0, start = 0;
  const parts = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    if (value[i] === ')') depth--;
    if (value[i] === ',' && !depth) { parts.push(value.slice(start, i)); start = i + 1; }
    assert.ok(depth >= 0, 'balanced query groups');
  }
  assert.equal(depth, 0, 'balanced query groups');
  return [...parts, value.slice(start)];
}
function matches(row, expression) {
  if (expression.startsWith('and(')) return splitClauses(expression.slice(4, -1)).every(clause => matches(row, clause));
  const match = /^(\w+)\.ilike\.(.*)$/.exec(expression);
  assert.ok(match, `supported filter ${expression}`);
  const pattern = match[2].split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + pattern + '$', 'i').test(String(row[match[1]] || ''));
}

// Apply projection and filters before LIMIT, just as the server does.
function database(seed = {}) {
  const reads = [];
  return {
    reads,
    from(table) {
      let columns = '*', filter = null, limit = Infinity;
      const nullChecks = [];
      const q = {
        select(value) { columns = value; return q; },
        eq() { return q; },
        is(column) { nullChecks.push(column); return q; },
        or(value) { filter = value; return q; },
        order() { return q; },
        limit(value) { limit = value; return q; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            reads.push({ table, columns, filter, limit });
            const rows = (seed[table] || [])
              .filter(row => nullChecks.every(column => row[column] == null))
              .filter(row => !filter || splitClauses(filter).some(clause => matches(row, clause)))
              .slice(0, limit)
              .map(row => columns === '*' ? { ...row } : Object.fromEntries(columns.split(',').map(column => [column, row[column]])));
            return { data: rows, error: null };
          }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

async function modalHarness(seed) {
  const db = database(seed), fields = new Map(), timers = new Map();
  let timerId = 0, modalHtml = '';
  function field(selector) {
    if (!fields.has(selector)) {
      let html = '', results = [];
      fields.set(selector, {
        value: '', style: {}, handlers: {}, checked: false,
        focus() {},
        addEventListener(event, callback) { this.handlers[event] = callback; },
        get innerHTML() { return html; },
        set innerHTML(value) {
          html = value;
          results = [...value.matchAll(/data-esp-pick="([^"]+)"/g)].map(match => ({
            dataset: { espPick: match[1] }, style: {}, handlers: {},
            addEventListener(event, callback) { this.handlers[event] = callback; },
          }));
        },
        querySelectorAll() { return results; },
        get firstElementChild() { return results[0]; },
      });
    }
    return fields.get(selector);
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function openEstimateStartPicker(');
  const end = html.indexOf('\n// The iframe talks back', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    supabase: db, state: {},
    esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    titleCaseValue: value => String(value ?? ''), qoFmtPhone: value => value,
    openModal(html, { onMount }) { modalHtml = html; onMount({ querySelector: field, querySelectorAll: () => [] }); },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(html.slice(start, end), context);
  await context.openEstimateStartPicker();
  return {
    field, db, modalHtml,
    search(value) {
      field('#espSearch').value = value;
      field('#espSearch').handlers.input();
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
      return field('#espSearchResults').innerHTML;
    },
    pick() { field('#espSearchResults').querySelectorAll()[0].handlers.mousedown({ preventDefault() {} }); },
  };
}

test('New Estimate finds a business by the contact full name, partial name, company, phone and email', async () => {
  const h = await modalHarness({ customers: [business] });
  assert.match(h.modalHtml, /<option value="cust:business-customer">Unacem NA \(Dan Mosby\)<\/option>/);
  for (const query of ['Dan Mosby', 'dan', 'Mosby', '  DAN   MOSBY ', 'unac', '9285550100', 'dan@example.test']) {
    const html = h.search(query);
    assert.match(html, /data-esp-pick="cust:business-customer"/, query);
    assert.match(html, /Unacem NA \(Dan Mosby\)/);
    assert.match(html, /Dan Mosby/, 'result explains which contact matched');
  }
  h.pick();
  assert.equal(h.field('#espContact').value, 'cust:business-customer');
  assert.match(h.field('#espSummary').innerHTML, /Dan Mosby/);
  assert.equal(h.field('#espAddr1').value, business.billing_address_line1);
});

test('New Estimate finds lead business and split contact names and keeps the lead selection path', async () => {
  const h = await modalHarness({ leads: [businessLead] });
  for (const query of ['Lena Garcia', 'Garcia', 'Mesa Cement']) {
    assert.match(h.search(query), /data-esp-pick="lead:business-lead"/, query);
  }
  h.pick();
  assert.equal(h.field('#espContact').value, 'lead:business-lead');
  assert.match(h.field('#espSummary').innerHTML, /Mesa Cement/);
  assert.match(h.field('#espSummary').innerHTML, /Lena Garcia/);
  assert.equal(h.field('#espAddr1').value, businessLead.address);
});

test('New Estimate retains legacy-name search and excludes archived records', async () => {
  const h = await modalHarness({ customers: [
    { id: 'legacy', name: 'Legacy Customer' },
    { id: 'person', name: 'Sam Example', first_name: 'Sam', last_name: 'Example' },
    { ...business, archived_at: '2026-01-01' },
  ] });
  assert.match(h.search('Legacy Customer'), /cust:legacy/);
  assert.match(h.search('Sam Example'), /<strong>Sam Example<\/strong>/);
  assert.match(h.search('Dan Mosby'), /No match/);
  h.search('D');
  assert.equal(h.field('#espSearchResults').style.display, 'none');
});

function compile(file, imports = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require(name) { assert.ok(name in imports, `known import ${name}`); return imports[name]; } });
  return exports;
}
const customerModule = compile('apps/estimator/src/lib/customer.ts');
function estimatorSearch(db) {
  return compile('apps/estimator/src/lib/customerSearch.ts', { './supabase': { supabase: db }, './customer': customerModule }).searchCustomersAndLeads;
}

test('estimator matches combined contact names on the server before limiting results', async () => {
  const decoys = Array.from({ length: 12 }, (_, index) => ({ ...business, id: 'other-' + index, first_name: 'Dan', last_name: 'Other ' + index }));
  const db = database({ customers: [...decoys, business] });
  const found = await estimatorSearch(db)('Dan Mosby');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, business.id);
  assert.equal(found[0].name, 'Unacem NA (Dan Mosby)');
  assert.equal(found[0].form.company, 'Unacem NA');
  assert.equal(found[0].form.firstName, 'Dan');
  assert.equal(found[0].leadSource, 'Referral');
  assert.match(db.reads.find(read => read.table === 'customers').filter, /and\(first_name\.ilike\.\*Dan\*,last_name\.ilike\.\*Mosby\*\)/);
});

test('estimator matches multiword first names and surnames', async () => {
  const db = database({ customers: [
    { ...business, id: 'first', first_name: 'Mary Ann', last_name: 'Lee' },
    { ...business, id: 'last', first_name: 'Juan', last_name: 'de la Cruz' },
  ] });
  const search = estimatorSearch(db);
  assert.equal((await search('Mary Ann Lee'))[0].id, 'first');
  assert.equal((await search('Juan de la Cruz'))[0].id, 'last');
});

test('estimator searches a business lead by contact or company and preserves its business form', async () => {
  const db = database({ leads: [businessLead] });
  const search = estimatorSearch(db);
  for (const query of ['Lena Garcia', 'Mesa Cement']) {
    const [found] = await search(query);
    assert.equal(found.id, businessLead.id);
    assert.equal(found.name, 'Mesa Cement (Lena Garcia)');
    assert.equal(found.form.isCommercial, true);
    assert.equal(found.form.company, businessLead.business_name);
    assert.equal(found.form.firstName, 'Lena');
  }
});

test('estimator strips filter delimiters and wildcard characters from typed queries', async () => {
  const db = database({ customers: [business] });
  const found = await estimatorSearch(db)(String.raw`Dan (Mosby),%_"\\`);
  assert.equal(found[0].id, business.id);
  for (const read of db.reads) assert.ok(!/["\\%_]/.test(read.filter.replace(/first_name|last_name|company_name|billing_address_line1|phone_norm|full_name|business_name/g, '')));
});

test('estimator keeps phone, company, legacy names and short-query behavior', async () => {
  const db = database({ customers: [business, { id: 'legacy', name: 'Legacy Customer' }, { id: 'person', name: 'Sam Example', first_name: 'Sam', last_name: 'Example' }] });
  const search = estimatorSearch(db);
  for (const query of ['Unac', '(928) 555-0100']) assert.equal((await search(query))[0].id, business.id);
  assert.equal((await search('Legacy Customer'))[0].id, 'legacy');
  assert.equal((await search('Sam Example'))[0].name, 'Sam Example');
  const before = db.reads.length;
  assert.equal((await search('D')).length, 0);
  assert.equal(db.reads.length, before);
});
