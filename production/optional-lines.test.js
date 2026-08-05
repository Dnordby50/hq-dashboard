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
  SEND_GATE_MESSAGE,
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

// --- 9. The create gate --------------------------------------------------------
await section('optional_lines_enabled=false: blocks creating a new optional line, never hides an existing one', async () => {
  ok(optionalControlsVisible(false, false) === false, 'disabled + not optional: the checkbox does not render, so no new optional line can be created');
  ok(optionalControlsVisible(false, true) === true, 'disabled + ALREADY optional: the controls still render (a create gate, never a data-hiding gate)');
  ok(optionalControlsVisible(true, false) === true, 'enabled: renders everywhere');
  ok(optionalControlsVisible(undefined, false) === true, 'a pre-72 cached catalog (no key) fails open to enabled');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
