'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const names = ['ensureSalesLead', 'updateNewSalesCustomer', 'openNewLeadModal', 'openCustomerForm', 'markEstimateSent', 'estimateSentLeadEffects', 'pecSendEmail', 'pecSendSms', 'sendEstimateText'];
const source = names.map(name => html.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}'))[0]).join('\n');
const NOW = '2026-09-22T17:00:00.000Z';

function fixture({ customer = null, lead = null, rpcError = false } = {}) {
  const rows = { customers: customer ? [customer] : [], leads: lead ? [lead] : [], pec_lead_sources: [] };
  const calls = { rpc: [], insert: [], update: [], toasts: [], closes: 0 };
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, { value: '', checked: false, style: {}, handlers: {},
      addEventListener(type, fn) { this.handlers[type] = fn; }, focus() {}, querySelectorAll() { return []; },
    });
    return elements.get(selector);
  }
  const modal = { querySelector: element, querySelectorAll: () => [] };
  const db = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'test-only' } } }) },
    async rpc(name, payload) {
      calls.rpc.push({ name, payload });
      if (rpcError) { rpcError = false; return { error: new Error('pipeline unavailable') }; }
      let found = rows.leads.find(row => row.customer_id === payload.p_customer_id && row.brand === payload.p_brand);
      if (!found) {
        const c = rows.customers.find(row => row.id === payload.p_customer_id);
        found = { id: 'canonical', brand: payload.p_brand, customer_id: c.id, full_name: c.name, stage: 'new', created_at: payload.p_occurred_at || NOW };
        rows.leads.push(found);
      }
      return { data: found.id, error: null };
    },
    from(table) {
      let single = false, filters = [], patch = null, insert = null;
      const query = {
        select() { return query; }, order() { return query; }, limit() { return query; }, or() { return query; },
        eq(k, v) { filters.push(row => row[k] === v); return query; },
        is(k, v) { filters.push(row => v === null ? row[k] == null : row[k] === v); return query; },
        single() { single = true; return query; },
        insert(value) { insert = value; return query; }, update(value) { patch = value; return query; },
        then(resolve, reject) {
          if (insert) { calls.insert.push({ table, insert }); rows[table].push({ id: 'customer-new', created_at: NOW, ...insert }); }
          const found = rows[table].filter(row => filters.every(filter => filter(row)));
          if (patch) { calls.update.push({ table, patch }); found.forEach(row => Object.assign(row, patch)); }
          return Promise.resolve({ data: single ? found[0] : found, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const context = vm.createContext({
    console, Date, supabase: db, state: { session: { user: { id: 'staff' } }, leadsData: { sources: ['Google'] } },
    withFreshWrite: fn => fn(), withFreshWriteRetry: fn => fn(), randomToken: () => 'test-token',
    openModal: (_body, options) => options.onMount(modal), closeModal: () => calls.closes++,
    showToast: text => calls.toasts.push(text), alert: text => calls.toasts.push(text),
    esc: value => String(value == null ? '' : value), qoFmtPhone: value => value, leadSourceLabel: value => value, leadSourceOptionsHtml: () => '',
    pecPhoneValid: () => true, pecEmailValid: () => true, pecAttachPlacesAutocomplete() {},
    enrollLeadInDrip: async () => {}, renderLeads() {}, renderCustomers() {},
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  });
  vm.runInContext(source, context);
  return { context, rows, calls, element, db };
}

function setNewLeadFields(fx) {
  for (const [id, value] of Object.entries({ nlFirst: 'Jane', nlLast: 'Doe', nlPhone: '9285551212', nlEmail: 'jane@example.com', nlSource: 'Google' })) fx.element('#' + id).value = value;
}

test('manual new lead reuses the customer and canonical lead without resetting stage, source or first inquiry', async () => {
  const fx = fixture({ customer: { id: 'customer', company: 'prescott-epoxy' }, lead: {
    id: 'old-lead', brand: 'PEC', customer_id: 'customer', stage: 'estimate_sent', source: 'Referral', created_at: '2026-08-01T00:00:00Z', notes: 'Original notes',
  } });
  fx.context.openNewLeadModal(); setNewLeadFields(fx);
  await fx.element('#nlSave').handlers.click();
  assert.equal(fx.calls.insert.length, 0);
  assert.equal(fx.rows.leads.length, 1);
  assert.equal(fx.rows.leads[0].stage, 'estimate_sent');
  assert.equal(fx.rows.leads[0].source, 'Referral');
  assert.equal(fx.rows.leads[0].created_at, '2026-08-01T00:00:00Z');
  assert.equal(fx.calls.rpc[0].payload.p_occurred_at, null);
  assert.equal(fx.calls.closes, 1);
});

test('manual new lead retains a newly saved customer when pipeline linking fails and retry does not duplicate it', async () => {
  const fx = fixture({ rpcError: true });
  fx.context.openNewLeadModal(); setNewLeadFields(fx);
  await fx.element('#nlSave').handlers.click();
  assert.equal(fx.calls.closes, 0);
  assert.match(fx.element('#nlErr').textContent, /pipeline unavailable/);
  fx.element('#nlFirst').value = 'Janet';
  fx.element('#nlEmail').value = 'janet@example.com';
  fx.element('#nlPhone').value = '9285553434';
  fx.element('#nlAddress').value = '2 Corrected Street';
  await fx.element('#nlSave').handlers.click();
  assert.equal(fx.rows.customers.length, 1);
  assert.equal(fx.rows.leads.length, 1);
  assert.equal(fx.calls.rpc[1].payload.p_occurred_at, NOW);
  assert.equal(fx.rows.customers[0].name, 'Janet Doe');
  assert.equal(fx.rows.customers[0].email, 'janet@example.com');
  assert.equal(fx.rows.customers[0].phone, '9285553434');
  assert.equal(fx.rows.customers[0].billing_address_line1, '2 Corrected Street');
  assert.equal(fx.rows.customers[0].created_at, NOW);
  assert.equal(fx.calls.closes, 1);
});

test('new CRM customer records its fresh inquiry with correct company and retains identity on retry', async () => {
  const fx = fixture({ rpcError: true });
  const values = { cust_type: 'individual', first_name: 'Jane', last_name: 'Doe', phone: '9285551212', email: 'jane@example.com', lead_source: 'Google', company: 'finishing-touch' };
  fx.context.FormData = class { get(key) { return values[key] || ''; } };
  await fx.context.openCustomerForm();
  const event = { preventDefault() {}, target: {} };
  await fx.element('#pecCustForm').handlers.submit(event);
  assert.equal(fx.calls.closes, 0);
  values.first_name = 'Janet'; values.email = 'janet@example.com'; values.billing_city = 'Prescott Valley';
  await fx.element('#pecCustForm').handlers.submit(event);
  assert.equal(fx.rows.customers.length, 1);
  assert.equal(fx.calls.rpc[1].payload.p_brand, 'FTP');
  assert.equal(fx.calls.rpc[1].payload.p_occurred_at, NOW);
  assert.equal(fx.rows.customers[0].name, 'Janet Doe');
  assert.equal(fx.rows.customers[0].email, 'janet@example.com');
  assert.equal(fx.rows.customers[0].billing_city, 'Prescott Valley');
  assert.equal(fx.rows.customers[0].created_at, NOW);
  assert.equal(fx.calls.closes, 1);
});

test('CRM retry refuses a changed company before profile or pipeline writes', async () => {
  const fx = fixture({ rpcError: true });
  const values = { cust_type: 'individual', first_name: 'Jane', last_name: 'Doe', phone: '9285551212', email: 'jane@example.com', lead_source: 'Google', company: 'finishing-touch' };
  fx.context.FormData = class { get(key) { return values[key] || ''; } };
  await fx.context.openCustomerForm();
  const event = { preventDefault() {}, target: {} };
  await fx.element('#pecCustForm').handlers.submit(event);
  values.company = 'prescott-epoxy';
  await fx.element('#pecCustForm').handlers.submit(event);
  assert.equal(fx.calls.rpc.length, 1);
  assert.equal(fx.calls.update.length, 0);
  assert.equal(fx.rows.customers[0].company, 'finishing-touch');
  assert.match(fx.calls.toasts.at(-1), /Finish linking the inquiry before changing the company/);
});

test('appointment contact retry saves edited details on its original customer before linking', async () => {
  const fx = fixture({ rpcError: true });
  const startMarker = "custWrap.querySelector('#afNewCustSave').addEventListener('click', async () => {";
  const start = html.indexOf(startMarker) + startMarker.length;
  const end = html.indexOf('\n      });\n    };', start);
  assert.ok(start > startMarker.length && end > start);
  const picked = [];
  fx.context.custWrap = fx.context.modal = { querySelector: fx.element };
  fx.context.pick = row => picked.push(row);
  vm.runInContext('let createdAppointmentCustomer = null, creatingAppointmentCustomer = false;\nasync function saveAppointmentCustomer() {' + html.slice(start, end) + '\n}', fx.context);
  for (const [key, value] of Object.entries({ First: 'Jane', Last: 'Doe', Phone: '9285551212', Email: 'jane@example.com', Source: 'Google' })) fx.element('#afNewCust' + key).value = value;
  await fx.context.saveAppointmentCustomer();
  assert.equal(picked.length, 0);
  fx.element('#afNewCustFirst').value = 'Janet'; fx.element('#afNewCustEmail').value = 'janet@example.com';
  await fx.context.saveAppointmentCustomer();
  assert.equal(fx.rows.customers.length, 1);
  assert.equal(fx.rows.customers[0].created_at, NOW);
  assert.equal(picked[0].name, 'Janet Doe');
  assert.equal(picked[0].email, 'janet@example.com');
});

test('new-contact retry rejects zero-row profile writes and never rewrites identity fields', async () => {
  const fx = fixture({ customer: { id: 'customer', created_at: NOW, company: 'prescott-epoxy' } });
  const saved = await fx.context.updateNewSalesCustomer(fx.rows.customers[0], { name: 'Corrected', company: 'prescott-epoxy', id: 'other', created_at: '2000-01-01', token: 'replacement' });
  assert.equal(saved.id, 'customer'); assert.equal(saved.created_at, NOW);
  assert.equal(fx.calls.update[0].patch.id, undefined); assert.equal(fx.calls.update[0].patch.token, undefined);
  await assert.rejects(fx.context.updateNewSalesCustomer({ id: 'missing', created_at: NOW }, { company: 'prescott-epoxy' }), /customer changed/);
});

test('pipeline helper rejects zero-result and denied writes instead of claiming saved inquiry', async () => {
  const fx = fixture();
  fx.db.rpc = async () => ({ data: null });
  await assert.rejects(fx.context.ensureSalesLead('customer'), /could not be linked/);
  fx.db.rpc = async () => ({ error: new Error('denied') });
  await assert.rejects(fx.context.ensureSalesLead('customer'), /denied/);
});

test('sent-state write verifies affected record before updating local state or running effects', async () => {
  const fx = fixture(); let effects = 0;
  fx.context.estimateSentLeadEffects = () => effects++;
  fx.db.from = () => { const q = { update: () => q, eq: () => q, in: () => q, select: () => q, single: async () => ({ data: null }) }; return q; };
  const estimate = { id: 'estimate', status: 'draft' };
  await assert.rejects(fx.context.markEstimateSent(estimate), /estimate changed/);
  assert.equal(estimate.status, 'draft'); assert.equal(effects, 0);
});

test('estimate sender preserves tracking flags and treats browser network uncertainty honestly', async () => {
  const fx = fixture();
  fx.context.fetch = async () => ({ ok: false, status: 502, json: async () => ({ ok: false, send_unknown: true, tracking_attempt_id: 'attempt', error: 'Check provider history' }) });
  await assert.rejects(fx.context.pecSendEmail({ estimate_id: 'estimate' }), err => err.send_unknown && err.tracking_attempt_id === 'attempt');
  fx.context.fetch = async () => { throw new Error('connection lost'); };
  await assert.rejects(fx.context.pecSendSms({ kind: 'estimate' }), err => err.send_unknown && /could not be confirmed/.test(err.message));
  fx.context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, tracking_pending: true, warning: 'Sent; recording pending' }) });
  assert.equal((await fx.context.pecSendEmail({ estimate_id: 'estimate' })).tracking_pending, true);
});

test('server-tracked sends retain drip handoff without duplicating stage changes or send events', async () => {
  const fx = fixture(); const enrolled = [];
  fx.context.enrollEstimateDripClient = async id => enrolled.push(id);
  fx.db.from = () => { throw new Error('server already wrote lifecycle evidence'); };
  await fx.context.estimateSentLeadEffects({ lead_id: 'canonical' }, NOW, { serverTracked: true });
  assert.deepEqual(enrolled, ['canonical']);
});

test('unknown text delivery blocks repeated sending without claiming no delivery', async () => {
  const fx = fixture(); let attempts = 0;
  Object.assign(fx.context, { ensureEstimateToken: async () => true, estimateSendGateOk: async () => true, confirm: () => true,
    estNumberLabel: () => 'EST-1', pecSendSms: async () => { attempts++; throw Object.assign(new Error('Check provider history'), { send_unknown: true }); } });
  const estimate = { id: 'estimate', customer_phone: '9285551212' };
  assert.equal(await fx.context.sendEstimateText(estimate), false);
  assert.equal(await fx.context.sendEstimateText(estimate), false);
  assert.equal(attempts, 1);
  assert.match(fx.calls.toasts[0], /delivery needs review/);
});
