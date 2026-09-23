const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../apps/estimator/node_modules/typescript');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function dashboardFunction(name, next) {
  const start = html.indexOf(`async function ${name}(`);
  const end = html.indexOf(next, start);
  assert.ok(start >= 0 && end > start, `${name} boundaries exist`);
  return html.slice(start, end);
}
const draftSource = dashboardFunction('createDraftEstimate', '\n// The "this lead already');
const pickerSource = dashboardFunction('openEstimateStartPicker', '\n// The iframe talks back');
const salesLeadSource = dashboardFunction('ensureSalesLead', '\nasync function openCustomerForm');

// Project the requested columns so omitting attribution from a real select
// fails these tests, even though the in-memory profile holds that value.
function database(seed = {}, failures = {}) {
  const tables = Object.fromEntries(Object.entries(seed).map(([table, rows]) => [table, rows.map(row => ({ ...row }))]));
  const writes = [], reads = [], rpcCalls = [];
  return {
    writes, reads, rpcCalls,
    async rpc(name, payload) {
      assert.equal(name, 'record_sales_inquiry');
      rpcCalls.push(payload);
      if (failures.rpc) { failures.rpc = false; return { error: new Error('pipeline unavailable') }; }
      const customer = (tables.customers || []).find(row => row.id === payload.p_customer_id);
      assert.ok(customer, 'pipeline inquiry links the customer just saved');
      const lead = { id: 'canonical-lead', customer_id: customer.id, brand: payload.p_brand, source: customer.lead_source,
        full_name: customer.name, first_name: customer.first_name, last_name: customer.last_name,
        email: customer.email, phone: customer.phone, inquiry_date: payload.p_inquiry_date };
      (tables.leads ||= []).push(lead);
      writes.push({ table: 'leads', row: lead });
      return { data: lead.id, error: null };
    },
    from(table) {
      let columns = '*', id, insert, patch;
      const finish = (single = false) => {
        if (!insert) {
          reads.push({ table, columns, id });
          if (failures[table] === 'throw') throw new Error('lookup offline');
          if (failures[table]) return { data: null, error: { message: 'lookup unavailable' } };
        }
        let rows = tables[table] || [];
        if (insert) {
          const saved = { id: `${table}-new`, created_at: '2026-09-22T17:00:00Z', ...insert };
          writes.push({ table, row: saved });
          (tables[table] ||= []).push(saved);
          rows = [saved];
        } else if (id != null) rows = rows.filter(row => row.id === id);
        if (patch) {
          rows.forEach(row => Object.assign(row, patch));
          writes.push({ table, update: true, row: rows[0] });
        }
        const selected = rows.map(row => columns === '*' ? { ...row } : Object.fromEntries(columns.split(',').map(key => [key, row[key]])));
        return { data: single ? selected[0] || null : selected, error: null };
      };
      const q = {
        select(value) { columns = value; return q; },
        eq(key, value) { if (key === 'id') id = value; return q; },
        is() { return q; }, in() { return q; }, order() { return q; }, limit() { return q; },
        insert(value) { insert = { ...value }; return q; },
        update(value) { patch = { ...value }; return q; },
        maybeSingle: async () => finish(true), single: async () => finish(true),
        then(resolve, reject) { return Promise.resolve().then(() => finish()).then(resolve, reject); },
      };
      return q;
    },
  };
}

function dashboard(db) {
  const fields = new Map();
  const field = selector => {
    if (!fields.has(selector)) fields.set(selector, {
      value: '', checked: false, style: {}, handlers: {}, focus() {},
      addEventListener(name, handler) { this.handlers[name] = handler; },
      querySelectorAll() { return []; },
    });
    return fields.get(selector);
  };
  const context = vm.createContext({
    console: { warn() {} }, crypto: require('node:crypto'), supabase: db, navigator: { onLine: true },
    state: { session: { user: { id: 'staff' } } }, pecEstInline: {},
    withDeadline: callback => callback(), withFreshWriteRetry: callback => callback(), showToast() {}, switchView() {},
    openEstimatorFrame() { throw new Error('unexpected offline launch'); },
    closeModal() {},
    openModal(_html, options) { options.onMount({ querySelector: field, querySelectorAll: () => [] }); },
    leadOpenEstimates: async () => [],
    esc: value => String(value ?? ''), titleCaseValue: value => value,
    randomToken: () => 'fixture-token',
    pecPhoneValid: value => value.replace(/\D/g, '').length === 10,
    pecEmailValid: value => value.includes('@'),
  });
  vm.runInContext(draftSource + '\n' + pickerSource + '\n' + salesLeadSource, context);
  return { context, field };
}

for (const [name, records, args, expected] of [
  ['existing customer', { customers: [{ id: 'c1', lead_source: 'Google' }] }, { customerId: 'c1' }, 'Google'],
  ['existing lead', { leads: [{ id: 'l1', source: 'Facebook' }] }, { leadId: 'l1' }, 'Facebook'],
  ['lead linked to a customer', { leads: [{ id: 'l1', source: '', customer_id: 'c1' }], customers: [{ id: 'c1', lead_source: 'Word of Mouth' }] }, { leadId: 'l1' }, 'Word of Mouth'],
  ['lead attribution wins over linked customer', { leads: [{ id: 'l1', source: 'Angi', customer_id: 'c1' }], customers: [{ id: 'c1', lead_source: 'Google' }] }, { leadId: 'l1' }, 'Angi'],
  ['blank attribution stays blank', { customers: [{ id: 'c1', lead_source: '  ' }] }, { customerId: 'c1' }, null],
]) {
  test(`draft source carries from ${name}`, async () => {
    const db = database(records);
    await dashboard(db).context.createDraftEstimateNow(args);
    assert.equal(db.writes.find(write => write.table === 'estimates').row.lead_source, expected);
  });
}

test('new contact form carries the entered source through customer creation into the estimate', async () => {
  const db = database({ pec_lead_sources: [{ name: 'Google' }] });
  const h = dashboard(db);
  await h.context.openEstimateStartPicker();
  for (const [name, value] of Object.entries({ espFirst: 'Sam', espLast: 'Example', espPhone: '9285550100', espEmail: 'sam@example.test', espSource: 'Google' })) {
    h.field('#' + name).value = value;
  }
  await h.field('#espGo').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.field('#espErr').textContent, '');
  assert.deepEqual(db.writes.map(write => [write.table, write.row.lead_source || write.row.source]), [['customers', 'Google'], ['leads', 'Google'], ['estimates', 'Google']]);
  assert.equal(db.writes[2].row.customer_id, db.writes[0].row.id);
  assert.equal(db.writes[2].row.lead_id, db.writes[1].row.id);
  assert.equal(db.rpcCalls[0].p_inquiry_date, '2026-09-22');
});

test('new contact attribution survives a failed follow-up customer lookup', async () => {
  const db = database({}, { customers: 'error' });
  await dashboard(db).context.createDraftEstimateNow({ customerId: 'c1', extras: { leadSource: 'Google' } });
  assert.equal(db.writes[0].row.lead_source, 'Google');
});

test('new estimate contact retry keeps edited details and original inquiry date after pipeline failure', async () => {
  const db = database({ pec_lead_sources: [{ name: 'Google' }] }, { rpc: true });
  const h = dashboard(db);
  await h.context.openEstimateStartPicker();
  for (const [name, value] of Object.entries({ espFirst: 'Sam', espLast: 'Example', espPhone: '9285550100', espEmail: 'sam@example.test', espSource: 'Google' })) h.field('#' + name).value = value;
  await h.field('#espGo').handlers.click();
  assert.match(h.field('#espErr').textContent, /pipeline unavailable/);
  h.field('#espFirst').value = 'Samuel'; h.field('#espEmail').value = 'samuel@example.test'; h.field('#espSource').value = 'Referral';
  await h.field('#espGo').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.field('#espErr').textContent, '');
  assert.equal(db.writes.filter(row => row.table === 'customers' && !row.update).length, 1);
  const corrected = db.writes.find(row => row.table === 'customers' && row.update).row;
  assert.equal(corrected.name, 'Samuel Example'); assert.equal(corrected.email, 'samuel@example.test');
  const estimate = db.writes.find(row => row.table === 'estimates').row;
  assert.equal(estimate.customer_name, 'Samuel Example'); assert.equal(estimate.customer_email, 'samuel@example.test');
  assert.equal(estimate.lead_source, 'Referral');
  assert.equal(db.rpcCalls[1].p_inquiry_date, '2026-09-22');
  assert.equal(db.rpcCalls[1].p_request_key, db.rpcCalls[0].p_request_key);
});

test('an unavailable linked-customer source does not prevent a lead draft from opening', async () => {
  const db = database({ leads: [{ id: 'l1', customer_id: 'c1' }] }, { customers: 'throw' });
  await dashboard(db).context.createDraftEstimateNow({ leadId: 'l1' });
  assert.equal(db.writes[0].row.lead_id, 'l1');
  assert.equal(db.writes[0].row.lead_source, null);
});

function compile(file, imports = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const exports = {};
  vm.runInNewContext(output, {
    exports,
    require(name) { assert.ok(name in imports, `known import ${name}`); return imports[name]; },
  });
  return exports;
}
const customerModule = compile('apps/estimator/src/lib/customer.ts');
function loadWith(db) {
  const account = { ownerId: 'staff', sessionId: 'fixture-session', generation: 1 };
  return compile('apps/estimator/src/lib/estimateLoad.ts', {
    './supabase': { scopedSupabase: () => db }, './customer': customerModule,
    '../offline/account': { captureAccount: () => account },
    '../offline/estimates': { CUSTOM_LINE_LABEL: 'Custom scope of work' },
  }).loadEstimateForEdit('e1');
}

for (const [name, estimate, profiles, expected] of [
  ['customer source', { customer_id: 'c1' }, { customers: [{ id: 'c1', lead_source: 'Google' }] }, 'Google'],
  ['lead source first', { lead_id: 'l1', customer_id: 'c1' }, { leads: [{ id: 'l1', source: 'Angi' }], customers: [{ id: 'c1', lead_source: 'Google' }] }, 'Angi'],
  ['customer linked through a blank-source lead', { lead_id: 'l1' }, { leads: [{ id: 'l1', source: ' ', customer_id: 'c1' }], customers: [{ id: 'c1', lead_source: 'Google' }] }, 'Google'],
  ['blank estimate source', { lead_source: '  ', customer_id: 'c1' }, { customers: [{ id: 'c1', lead_source: 'Google' }] }, 'Google'],
  ['no known source', {}, {}, null],
]) {
  test(`reopened estimate recovers ${name}`, async () => {
    const db = database({ estimates: [{ id: 'e1', ...estimate }], ...profiles });
    const loaded = await loadWith(db);
    assert.equal(loaded.leadSource, expected);
    assert.equal(db.writes.length, 0, 'opening an estimate makes no database writes');
  });
}

test('a saved estimate source wins without fetching different profile attribution', async () => {
  const db = database({ estimates: [{ id: 'e1', lead_source: 'Word of Mouth', lead_id: 'l1', customer_id: 'c1' }] });
  assert.equal((await loadWith(db)).leadSource, 'Word of Mouth');
  assert.equal(db.reads.some(read => ['leads', 'customers'].includes(read.table)), false);
});

for (const failure of ['error', 'throw']) {
  test(`profile lookup ${failure} does not prevent opening the estimate`, async () => {
    const db = database({
      estimates: [{ id: 'e1', lead_id: 'l1', customer_id: 'c1', crew_notes: 'Keep this note' }],
      customers: [{ id: 'c1', lead_source: 'Google' }],
    }, { leads: failure });
    const loaded = await loadWith(db);
    assert.equal(loaded.leadSource, 'Google');
    assert.equal(loaded.crewNotes, 'Keep this note');
  });
}
