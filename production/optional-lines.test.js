// Prompt 72 tests: optional line items on any line. Covers the nine cases the
// spec names: the three distinct totals, the send gate, pre-selection, the
// partial accept (price patched, price_all_options untouched), the job-side
// area filtering with the keep-unmatched guardrail, the kit-merge proof
// (decision 5), the zero-selection 400, pre-72 byte-identical behavior, and
// the create gate. Server cases drive the REAL pec-public-estimate.cjs with
// the same in-memory PostgREST subset estimate15b.test.js uses.
//
// Run: `node production/optional-lines.test.js` (wired into `npm test`).

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { computeMaterialPlan } from './calculator.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FN_DIR = path.join(__dirname, '..', 'netlify', 'functions');
const {
  splitLineTotals, sendGateError, acceptSelectionInvalid, declinedAreaIdSet,
  filterAreasForJob, declinedNoteLine, selectedScopeDoc, optionalControlsVisible,
  SEND_GATE_MESSAGE, EMPTY_SEND_MESSAGE, emptySendError,
} = require('./optional-lines.cjs');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
}
async function section(name, fn) {
  console.log(`\n# ${name}`);
  try { await fn(); }
  catch (e) { failed++; console.error(`  FAIL ${name} threw: ${e && e.stack || e}`); }
}

// ---------------------------------------------------------------------------
// In-memory PostgREST subset + require-cache loader (the estimate15b harness,
// trimmed to the filters the public estimate function uses).
// ---------------------------------------------------------------------------
function makeMockSb(db) {
  const parseTable = (p) => p.replace(/^\//, '').split('?')[0];
  const decode = (v) => decodeURIComponent(v);
  function matches(row, p) {
    const query = p.split('?')[1] || '';
    for (const clause of query.split('&')) {
      const eqM = clause.match(/^([a-z_]+)=eq\.(.+)$/);
      if (eqM && !['select', 'order', 'limit', 'or'].includes(eqM[1])) {
        if (String(row[eqM[1]]) !== decode(eqM[2])) return false;
        continue;
      }
      const inM = clause.match(/^([a-z_]+)=in\.\(([^)]*)\)/);
      if (inM) {
        const vals = inM[2].split(',').map((v) => decode(v));
        if (!vals.includes(String(row[inM[1]]))) return false;
        continue;
      }
      const isNullM = clause.match(/^([a-z_]+)=is\.null$/);
      if (isNullM) {
        if (row[isNullM[1]] != null) return false;
        continue;
      }
    }
    return true;
  }
  return async function sb(method, p, payload) {
    const table = parseTable(p);
    db[table] = db[table] || [];
    if (method === 'GET') {
      let rows = db[table].filter((r) => matches(r, p));
      const limitM = p.match(/[?&]limit=(\d+)/);
      if (limitM) rows = rows.slice(0, Number(limitM[1]));
      return rows.map((r) => ({ ...r }));
    }
    if (method === 'PATCH') {
      const hit = db[table].filter((r) => matches(r, p));
      for (const r of hit) Object.assign(r, payload);
      return hit.map((r) => ({ ...r }));
    }
    if (method === 'POST') {
      const rows = Array.isArray(payload) ? payload : [payload];
      for (const r of rows) db[table].push({ ...r });
      return rows.map((r) => ({ ...r }));
    }
    throw new Error(`mock sb: unhandled ${method} ${p}`);
  };
}
function loadFn(file, sbImpl) {
  const supPath = require.resolve(path.join(FN_DIR, '_pec-supabase.cjs'));
  const real = require(supPath);
  require.cache[supPath] = {
    id: supPath, filename: supPath, loaded: true,
    exports: { ...real, sb: sbImpl, badSecret: () => false },
  };
  const fnPath = require.resolve(path.join(FN_DIR, file));
  delete require.cache[fnPath];
  return require(fnPath);
}

const TOKEN = '22222222-3333-4333-8444-555555555555';
// A mixed prompt-72 estimate: required garage, PRE-SELECTED optional patio,
// unselected optional add-on, one custom declined-able line worth of areas.
function mixedDb() {
  return {
    estimates: [{
      id: 'e72', public_token: TOKEN, sent_at: '2026-08-05T00:00:00Z', status: 'sent',
      deleted_at: null, mvb: 'none', flake_color: null, intake: { salesperson_name: 'Dylan' },
      system_type_id: 'sys-flake', customer_name: 'Opt Tester', customer_email: null,
      customer_address: '9 Optional Way', estimate_number: 102072, price: 4200,
      price_all_options: 8100, brand: 'prescott-epoxy', lead_id: null,
      scope_of_work: '## Garage: Standard Flake\n\ngarage scope\n\n---\n\n## Patio: Quartz (optional)\n\npatio scope',
      crew_notes: null, is_custom: false, custom_sqft: null,
    }],
    estimate_areas: [
      { id: 'arG', estimate_id: 'e72', name: 'Garage', sqft: 800, system_type_id: 'sys-flake', sort_order: 0, is_optional: false, preselected: true, is_custom: false },
      { id: 'arP', estimate_id: 'e72', name: 'Patio', sqft: 400, system_type_id: 'sys-quartz', sort_order: 1, is_optional: true, preselected: true, is_custom: false },
    ],
    estimate_line_items: [
      { id: 'liG', estimate_id: 'e72', estimate_area_id: 'arG', label: 'Garage: Standard Flake', description: 'garage scope', qty: 1, unit_price: 4200, total: 4200, is_optional: false, selected_by_customer: true, sort_order: 0 },
      { id: 'liP', estimate_id: 'e72', estimate_area_id: 'arP', label: 'Patio: Quartz', description: 'patio scope', qty: 1, unit_price: 3400, total: 3400, is_optional: true, selected_by_customer: true, sort_order: 1 },
      { id: 'liA', estimate_id: 'e72', estimate_area_id: null, addon_id: 'ad1', label: 'Stem Walls', description: null, qty: 1, unit_price: 500, total: 500, is_optional: true, selected_by_customer: false, sort_order: 2 },
    ],
    pec_prod_system_types: [{ id: 'sys-flake', name: 'Standard Flake' }, { id: 'sys-quartz', name: 'Quartz' }],
    settings: [],
    pec_brand_identity: [], pec_email_senders: [], customers: [], jobs: [], timeline_stages: [],
    job_areas: [], pec_prod_jobs: [], pec_prod_areas: [], leads: [], lead_events: [],
    pec_invoice_installments: [], pec_prod_busybusy_projects: [], pec_estimate_views: [],
    pec_notifications: [],
  };
}
function discountDb() {
  const db = mixedDb();
  db.estimate_areas = db.estimate_areas.slice(0, 1);
  db.estimate_line_items = db.estimate_line_items.slice(0, 1);
  db.estimate_line_items[0].unit_cost = 1400;
  db.estimate_line_items.push({
    id: 'liD', estimate_id: 'e72', estimate_area_id: null, addon_id: null,
    label: 'Project discount', description: 'Courtesy discount', qty: 1,
    unit_price: -600.25, unit_cost: 0, total: -600.25,
    is_optional: true, selected_by_customer: false, sort_order: 1,
  });
  db.estimates[0].price_all_options = 3599.75;
  db.estimates[0].commission_pct = 6;
  db.estimates[0].price_override_reason = 'Courtesy discount';
  db.estimates[0].scope_of_work = '## Garage: Standard Flake\n\ngarage scope\n\n---\n\n## Project discount\n\nCourtesy discount';
  db.estimate_installments = [
    { id: 'dep', estimate_id: 'e72', seq: 0, label: 'Deposit', amount_kind: 'percent', amount_value: 50, trigger_kind: 'on_acceptance', is_deposit: true },
    { id: 'bal', estimate_id: 'e72', seq: 1, label: 'Completion', amount_kind: 'percent', amount_value: 50, trigger_kind: 'on_completion', is_deposit: false },
  ];
  return db;
}
const quietFetch = () => { global.fetch = async () => ({ ok: true, text: async () => '', json: async () => ({}) }); };

console.log('optional-lines.test.js');

// --- 1. Three totals, three different numbers, each the exact sum -----------
await section('required-only, all-in, and opening are three distinct exact sums', async () => {
  const items = mixedDb().estimate_line_items;
  const t = splitLineTotals(items);
  ok(t.requiredOnly === 4200, `required-only = 4200 (got ${t.requiredOnly})`);
  ok(t.allIn === 4200 + 3400 + 500, `all-in = 8100 (got ${t.allIn})`);
  ok(t.opening === 4200 + 3400, `opening = 7600: required + pre-selected patio, add-on unticked (got ${t.opening})`);
  ok(new Set([t.requiredOnly, t.allIn, t.opening]).size === 3, 'the three numbers are distinct on a mixed estimate');
});

// --- 2. Send gate ------------------------------------------------------------
await section('send gate: all-optional blocks, one required line passes', async () => {
  const allOpt = [
    { total: 100, is_optional: true }, { total: 200, is_optional: true },
  ];
  ok(sendGateError(allOpt) === SEND_GATE_MESSAGE, 'every line optional -> the gate message');
  ok(sendGateError(mixedDb().estimate_line_items) === null, 'one required line -> passes');
  ok(sendGateError([]) === null, 'no lines at all is a different problem, not this gate');
});

// --- 2b. Empty-estimate send gate (prompt 84, "the different problem") -------
await section('empty send gate: zero lines block, null total blocks, zero total blocks, one priced line passes', async () => {
  ok(emptySendError([]) === EMPTY_SEND_MESSAGE, 'zero line items -> blocked');
  ok(emptySendError(null) === EMPTY_SEND_MESSAGE, 'no items array at all -> blocked');
  ok(emptySendError([{ label: 'Garage', total: null }]) === EMPTY_SEND_MESSAGE, 'one line with a null total -> blocked (opening resolves to 0)');
  ok(emptySendError([{ label: 'Garage', total: 0 }]) === EMPTY_SEND_MESSAGE, 'one line with a zero total -> blocked');
  ok(emptySendError([{ label: 'Patio', total: 3400, is_optional: true, selected_by_customer: false }]) === EMPTY_SEND_MESSAGE,
    'only an UNSELECTED optional line -> blocked (the opening page would show $0)');
  ok(emptySendError([{ label: 'Garage', total: 4200 }]) === null, 'one priced required line -> passes');
  ok(emptySendError([{ label: 'Patio', total: 3400, is_optional: true, selected_by_customer: true }]) === null,
    'a pre-selected optional line with a price -> passes (it is in the opening total)');
  ok(emptySendError(mixedDb().estimate_line_items) === null, 'the mixed fixture passes');
});

await section('discount send gate protects every selection, including an unticked credit', async () => {
  const items = discountDb().estimate_line_items;
  ok(emptySendError(items) === null, 'a discount smaller than the required work can be sent');
  ok(splitLineTotals(items).opening === 4200 && splitLineTotals(items).allIn === 3599.75, 'an unticked discount lowers all-in but not the opening price');
  for (const total of [-4200, -4200.01, -10000]) {
    const unsafe = [...items.slice(0, 1), { ...items[1], total }, { total: 20000, is_optional: true, selected_by_customer: true }];
    ok(/Discounts must leave/.test(emptySendError(unsafe) || ''), `credit ${total} cannot depend on optional paid work to stay positive`);
  }
  const requiredCredit = [{ total: -100 }, { total: 1000, is_optional: true, selected_by_customer: true }];
  ok(/Discounts must leave/.test(emptySendError(requiredCredit) || ''), 'a required credit alone does not establish required paid work');
  const legacyFlag = [{ total: 100 }, { total: -100, optional: true, selected_by_customer: false }];
  ok(/Discounts must leave/.test(emptySendError(legacyFlag) || ''), 'legacy optional flags receive the same minimum-selection check');
  ok(acceptSelectionInvalid([{ total: 100 }, { total: -100, is_optional: true, selected_by_customer: true }]), 'the accept defense rejects a zero total after a selected discount');
  ok(acceptSelectionInvalid([{ total: 100 }, { total: -101, is_optional: true, selected_by_customer: true }]), 'the accept defense rejects a negative discounted total');
  ok(emptySendError([{ total: 100 }, { total: -99.99, is_optional: true }]) === null, 'a positive one-cent minimum is valid');
});

await section('public discount toggle updates the live total, deposit and signature selection', async () => {
  const db = discountDb();
  quietFetch();
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  const res = await mod.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { token: TOKEN }, path: `/e/${TOKEN}` });
  const estimatorRequire = createRequire(path.join(__dirname, '..', 'apps', 'estimator', 'package.json'));
  const { JSDOM } = estimatorRequire('jsdom');
  const dom = new JSDOM(res.body, { url: 'https://fixture.invalid', runScripts: 'outside-only' });
  try {
    const { window } = dom;
    const requests = [];
    window.fetch = (_url, opts) => { requests.push(JSON.parse(opts.body)); return new Promise(() => {}); };
    for (const script of window.document.querySelectorAll('script:not([src])')) window.eval(script.textContent);
    const toggle = window.document.querySelector('[data-li-id="liD"]');
    ok(res.statusCode === 200 && !!toggle, 'the optional discount renders as a customer checkbox');
    ok(res.body.includes('-$600.25') && !res.body.includes('$-600.25'), 'discount currency renders with the minus before the dollar sign');
    ok(window.document.getElementById('heroTotal').textContent === '$4,200.00', 'the unchecked discount leaves the opening price unchanged');
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change'));
    ok(window.document.getElementById('heroTotal').textContent === '$3,599.75', 'selecting the discount subtracts its exact amount');
    ok(window.document.getElementById('acceptTotal').textContent === '$3,599.75', 'the signature button uses the discounted amount');
    const amounts = [...window.document.querySelectorAll('td.amt[data-sched-kind]')].map(el => el.textContent);
    ok(amounts.join('|') === '$1,799.88|$1,799.87', 'deposit and final payment preserve every cent after the discount');
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event('change'));
    ok(window.document.getElementById('heroTotal').textContent === '$4,200.00', 'unticking the discount restores the total');
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change'));
    window.document.getElementById('sigName').value = 'Discount Tester';
    window.document.getElementById('goAccept').click();
    const accept = requests.find(r => r.action === 'accept');
    ok(accept && accept.selected_optional_ids.join(',') === 'liD', 'the real signature click submits the selected discount ID');
  } finally { dom.window.close(); }
});

await section('accepting or declining a discount preserves signed job lines and the payment schedule', async () => {
  for (const selected of [true, false]) {
    const db = discountDb();
    quietFetch();
    const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
    const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'accept', name: 'Discount Tester', selected_optional_ids: selected ? ['liD'] : [] }) });
    const total = selected ? 3599.75 : 4200;
    ok(res.statusCode === 200 && db.estimates[0].price === total, `${selected ? 'selected' : 'declined'} discount signs for ${total}`);
    ok(db.jobs[0].price === total && db.pec_prod_jobs[0].revenue === total, 'both job records keep the signed net revenue');
    ok(db.jobs[0].line_items.some(li => li.name === 'Project discount' && li.price === -600.25) === selected, 'the invoice lines include only a selected discount at its negative price');
    ok(db.job_areas.some(area => area.name === 'Project discount' && area.price === -600.25 && area.system_type_id === null) === selected, 'job editing receives a standalone negative line without a coating system');
    ok(db.pec_prod_areas.length === 1 && db.jobs[0].sqft === '800', 'the discount contributes no material area or square footage');
    const schedule = db.estimates[0].signature.schedule;
    ok(Math.round(schedule.reduce((sum, row) => sum + row.computed_amount, 0) * 100) === Math.round(total * 100), 'the frozen payment schedule equals the signed net total');
    ok(db.pec_invoice_installments.length === 2 && db.jobs[0].deposit_amount === (selected ? 1799.88 : 2100), 'deposit and installments use the discounted signed price');
    if (selected) {
      db.pec_job_ar = [{ ...db.jobs[0], public_token: TOKEN, customer_name: 'Discount Tester', paid_to_date: 0, balance_remaining: total }];
      const invoice = loadFn('pec-public-invoice.cjs', makeMockSb(db));
      const page = await invoice.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { token: TOKEN } });
      ok(page.statusCode === 200 && page.body.includes('Project discount') && page.body.includes('-$600.25'), 'the real customer invoice displays the signed negative discount line');
      ok(page.body.includes('$3,599.75'), 'the invoice displays the signed net project price');
    }
    if (!selected) ok(String(db.pec_prod_jobs[0].notes).includes('Declined by customer: Project discount, -$600'), 'declined discount notes keep clear negative currency');
  }
});

await section('unsafe discounts are held on an existing public link before any signature or job write', async () => {
  const db = discountDb();
  db.estimate_line_items[1].unit_price = -4200;
  db.estimate_line_items[1].total = -4200;
  quietFetch();
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'accept', name: 'Discount Tester', selected_optional_ids: ['liD'] }) });
  ok(res.statusCode === 409 && /being updated/.test(res.body), 'an oversized discount blocks a previously sent estimate pending correction');
  ok(db.estimates[0].status === 'sent' && !db.estimates[0].signature && db.jobs.length === 0, 'status, signature and job creation are untouched');
});

await section('legacy discount links enforce pricing floors even while the discount is unticked', async () => {
  const db = discountDb();
  db.estimate_line_items[0].unit_cost = 2350;
  quietFetch();
  const mockSb = makeMockSb(db);
  const reads = [];
  const mod = loadFn('pec-public-estimate.cjs', async (...args) => { if (args[0] === 'GET') reads.push(args[1]); return mockSb(...args); });
  const res = await mod.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { token: TOKEN }, path: `/e/${TOKEN}` });
  ok(res.statusCode === 200 && /This estimate is being updated/.test(res.body), 'a discount below the configured GP floor is held without a send-readiness snapshot');
  ok(reads.some(p => p.startsWith('/estimate_line_items?') && /select=[^&]*addon_id/.test(p)), 'the public line query includes catalog identity for discount classification');
  ok(db.estimates[0].status === 'sent' && db.jobs.length === 0, 'checking the legacy link creates no job or status write');
});

await section('settling a selected discount reduces GP and credits its commission saving', async () => {
  const db = discountDb();
  quietFetch();
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'select', signing: true, selected_optional_ids: ['liD'] }) });
  ok(res.statusCode === 200 && db.estimates[0].price === 3599.75, 'opening the signature panel settles at the selected net price');
  ok(db.estimates[0].gp_dollars === 2235.77, 'GP is 3599.75 - 1400 cost + 36.015 commission saving, rounded to cents');
  ok(Math.abs(db.estimates[0].gp_pct - (2235.77 / 3599.75)) < 1e-9, 'GP percentage uses net revenue');
});

// --- 3. Pre-selected optional line and the stored floor ----------------------
await section('pre-selected optional: in the opening total, out after untick, price (required-only) unmoved', async () => {
  const items = mixedDb().estimate_line_items;
  const before = splitLineTotals(items);
  ok(before.opening === 7600, 'pre-selected patio is in the opening total');
  const unticked = items.map((li) => li.id === 'liP' ? { ...li, selected_by_customer: false } : li);
  const after = splitLineTotals(unticked);
  ok(after.opening === 4200, 'untick removes exactly the patio from the opening total');
  ok(before.requiredOnly === after.requiredOnly && after.requiredOnly === 4200, 'the required-only floor is unchanged by either state');
});

// --- 4 + 5. Partial accept: signed total, price columns, job-side filtering --
await section('accept with the patio DECLINED: signed total exact, price patched, price_all_options untouched, declined area absent from job_areas and pec_prod_areas', async () => {
  const db = mixedDb();
  quietFetch();
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  // The customer unticked the pre-selected patio and left the add-on unticked.
  const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'accept', name: 'Opt Tester', selected_optional_ids: [] }) });
  ok(res.statusCode === 200, 'partial accept succeeds');
  ok(db.estimates[0].price === 4200, `price patched to the signed total, the sum of ticked lines to the cent (got ${db.estimates[0].price})`);
  ok(db.estimates[0].price_all_options === 8100, 'price_all_options is untouched at accept: the record of what was offered');
  ok(db.estimate_line_items.find((l) => l.id === 'liP').selected_by_customer === false, 'the patio line is the declined record (optional + not selected)');
  const sig = db.estimates[0].signature || {};
  ok(Array.isArray(sig.selected_optional_ids) && sig.selected_optional_ids.length === 0, 'the signature jsonb lists the ticked ids (none)');
  // E1: job side is built from the SELECTED areas only.
  ok(db.job_areas.length === 1 && db.job_areas[0].name === 'Garage', 'job_areas has the garage and NOT the declined patio');
  ok(db.pec_prod_areas.length === 1 && db.pec_prod_areas[0].name === 'Garage', 'pec_prod_areas (the recipe side that re-costs the job) has the garage only');
  ok(db.jobs[0].sqft === '800', 'job sqft counts the sold areas only');
  // E4: the crew note carries no patio scope and names the declined line.
  const notes = String(db.pec_prod_jobs[0].notes || '');
  ok(!/patio scope/.test(notes), 'no declined scope on the crew note');
  ok(/Declined by customer: Patio: Quartz, \$3,400/.test(notes), 'the crew note names what was offered and not sold');
  ok(/garage scope/.test(notes), 'the sold line\'s scope is on the crew note');
  ok(!/patio scope/.test(String(db.jobs[0].scope || '')), 'jobs.scope carries selected lines only');
  ok(/patio scope/.test(String(db.estimates[0].scope_of_work || '')), 'estimates.scope_of_work is NEVER rewritten after signature');
});

await section('E1 guardrail: an area with NO line item at all is KEPT', async () => {
  const db = mixedDb();
  // A data-bug area: exists on the estimate, no line item references it.
  db.estimate_areas.push({ id: 'arX', estimate_id: 'e72', name: 'Orphan Bay', sqft: 100, system_type_id: 'sys-flake', sort_order: 2, is_optional: false, preselected: true, is_custom: false });
  quietFetch();
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'accept', name: 'Opt Tester', selected_optional_ids: [] }) });
  ok(db.job_areas.some((a) => a.name === 'Orphan Bay'), 'the line-item-less area survives (silently deleting a bay from a signed job is the worse failure)');
  ok(!db.job_areas.some((a) => a.name === 'Patio'), 'the declined patio still drops');
  // The pure helpers prove the same rule directly.
  const set = declinedAreaIdSet(db.estimate_line_items);
  ok(set.has('arP') && set.size === 1, 'only areas named on a DECLINED line enter the drop set');
  ok(filterAreasForJob([{ id: 'arX' }], set).length === 1, 'filterAreasForJob keeps unmatched areas structurally');
});

// --- 6. The kit-merge proof (decision 5) --------------------------------------
await section('kit merge under a declined line: the selected-areas plan buys the FULL kit (decision 5: material estimate changes, prices do not)', async () => {
  // Two bays, each 200 sqft on the same basecoat (150 sqft/gal x 3 gal kit =
  // 450 sqft per kit): each alone needs 0.44 kit; together they buy ONE.
  const productsById = { bc: { id: 'bc', name: 'Basecoat', material_type: 'Basecoat', spread_rate: 150, kit_size: 3, unit_cost: 240 } };
  const slots = { std: [{ id: 's1', order_index: 1, material_type: 'Basecoat', default_product_id: 'bc', required: true }] };
  const bay = (id) => ({ id, name: id, sqft: 200, system_type_id: 'std' });
  const both = computeMaterialPlan({ areas: [bay('a'), bay('b')], productsById, recipeSlotsBySystemType: slots });
  const aloneAfterDecline = computeMaterialPlan({ areas: [bay('a')], productsById, recipeSlotsBySystemType: slots });
  ok(both.lines[0].qty_needed === 1, 'offered together: ONE shared kit between the bays');
  ok(aloneAfterDecline.lines[0].qty_needed === 1, 'after the decline, the remaining bay buys the FULL kit alone: same 1 kit, now all on the sold bay\'s cost basis');
  ok(aloneAfterDecline.lines[0].line_cost === 240, 'the sold job\'s material estimate carries the full kit cost; nobody "optimizes" this back into a shared kit');
});

// --- 7. Zero-selection accept -------------------------------------------------
await section('accept with zero selected lines: 400, status never flips', async () => {
  const db = mixedDb();
  // A crafted estimate where EVERY line is optional and the POST unticks all.
  for (const li of db.estimate_line_items) { li.is_optional = true; li.selected_by_customer = false; }
  quietFetch();
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'accept', name: 'Zero Attacker', selected_optional_ids: [] }) });
  ok(res.statusCode === 400, 'zero-selection accept returns 400');
  ok(/select at least one item/i.test(JSON.parse(res.body).error || ''), 'with the please-select message');
  ok(db.estimates[0].status === 'sent', 'status never flipped');
  ok(db.jobs.length === 0, 'no job was created');
  ok(acceptSelectionInvalid(db.estimate_line_items) === true, 'the pure guard agrees');
});

// --- 8. Pre-72 rows behave byte-identically -----------------------------------
await section('pre-72 shaped rows (nothing optional): identical totals, job rows, and prod notes', async () => {
  const db = mixedDb();
  // Strip the prompt-72 shape: nothing optional anywhere.
  for (const li of db.estimate_line_items) { li.is_optional = false; li.selected_by_customer = true; }
  db.estimate_line_items = db.estimate_line_items.filter((li) => li.id !== 'liA');
  for (const a of db.estimate_areas) { a.is_optional = false; a.preselected = true; }
  const t = splitLineTotals(db.estimate_line_items);
  ok(t.requiredOnly === t.allIn && t.allIn === t.opening && t.opening === 7600, 'all three totals collapse to ONE number when nothing is optional');
  quietFetch();
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'accept', name: 'Pre72', selected_optional_ids: [] }) });
  ok(db.estimates[0].price === 7600, 'signed for the full total');
  ok(db.job_areas.length === 2 && db.pec_prod_areas.length === 2, 'every area flows to the job (nothing filtered)');
  const notes = String(db.pec_prod_jobs[0].notes || '');
  ok(notes.startsWith(String(db.estimates[0].scope_of_work)), 'the crew note starts with the FULL scope document, byte-for-byte (no declined composition ran)');
  ok(!/Declined by customer/.test(notes), 'no declined line on the note');
  ok(declinedNoteLine([]) === null && selectedScopeDoc([]) === '', 'the helpers no-op on empty declines');
});

// --- Prompt 78 A3: the select action -----------------------------------------
await section('select action: ticks persist immediately, price waits for the accept panel', async () => {
  const db = mixedDb();
  quietFetch();
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'select', selected_optional_ids: ['liP', 'liA'], signing: false }) });
  ok(res.statusCode === 200, 'plain tick save succeeds');
  ok(db.estimate_line_items.find((l) => l.id === 'liA').selected_by_customer === true, 'the add-on tick landed on its row');
  ok(db.estimates[0].price === 4200, 'estimates.price did NOT move on a plain tick (decision 5: the required-only floor holds)');
  ok(db.estimates[0].gp_dollars === undefined && db.estimates[0].gp_pct === undefined, 'no GP write on a plain tick');
});

await section('select with signing:true settles price + GP at the selection (honesty rule respected)', async () => {
  const db = mixedDb();
  // Give every line real cost data so the GP write is allowed.
  db.estimate_line_items.forEach((l) => { l.unit_cost = { liG: 1400, liP: 1200, liA: 100 }[l.id]; });
  quietFetch();
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'select', selected_optional_ids: ['liP'], signing: true }) });
  ok(res.statusCode === 200, 'signing select succeeds');
  ok(db.estimates[0].price === 7600, `price settles at required + ticked patio (got ${db.estimates[0].price})`);
  ok(db.estimates[0].gp_dollars === 7600 - 1400 - 1200, `gp_dollars over the SAME included set (got ${db.estimates[0].gp_dollars})`);
  ok(Math.abs(db.estimates[0].gp_pct - (5000 / 7600)) < 1e-9, 'gp_pct stored as a FRACTION, matching the estimator convention');
});

await section('select honesty rule: a zero unit_cost on a priced line writes NO gp at all', async () => {
  const db = mixedDb();
  db.estimate_line_items.forEach((l) => { l.unit_cost = l.id === 'liP' ? 0 : 1000; });
  db.estimates[0].gp_dollars = 999; db.estimates[0].gp_pct = 0.5; // stored values must survive
  quietFetch();
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'select', selected_optional_ids: ['liP'], signing: true }) });
  ok(res.statusCode === 200, 'signing select still succeeds');
  ok(db.estimates[0].price === 7600, 'price still settles');
  ok(db.estimates[0].gp_dollars === 999 && db.estimates[0].gp_pct === 0.5, 'stored GP untouched: a fabricated margin is worse than a stale one');
});

await section('select refuses a terminal estimate: 409 and nothing written', async () => {
  const db = mixedDb();
  db.estimates[0].status = 'accepted';
  quietFetch();
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'select', selected_optional_ids: ['liA'], signing: true }) });
  ok(res.statusCode === 409, 'a signed document is never re-selected (409)');
  ok(db.estimate_line_items.find((l) => l.id === 'liA').selected_by_customer === false, 'no row write on a terminal status');
  ok(db.estimates[0].price === 4200, 'price untouched on a terminal status');
});

// --- 9. The create gate --------------------------------------------------------
await section('optional_lines_enabled=false: blocks creating a new optional line, never hides an existing one', async () => {
  ok(optionalControlsVisible(false, false) === false, 'disabled + not optional: the checkbox does not render, so no new optional line can be created');
  ok(optionalControlsVisible(false, true) === true, 'disabled + ALREADY optional: the controls still render (a create gate, never a data-hiding gate)');
  ok(optionalControlsVisible(true, false) === true, 'enabled: renders everywhere');
  ok(optionalControlsVisible(undefined, false) === true, 'a pre-72 cached catalog (no key) fails open to enabled');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
