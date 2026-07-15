// Harness for build prompt 15b's serverless + offline pieces. Drives the REAL
// functions (pec-estimate-scope.cjs, pec-estimate-ai.cjs) with _pec-supabase
// swapped for an in-memory PostgREST subset through the require cache and
// global.fetch captured, and the REAL apps/estimator offline TS bundled by
// esbuild with only IndexedDB + the outbox enqueue stubbed. No reimplementations.
//
// Run: `node production/estimate15b.test.js` (wired into `npm test`).

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import assert from 'assert';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FN_DIR = path.join(__dirname, '..', 'netlify', 'functions');

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
// In-memory PostgREST subset. Only the filters the two functions actually use:
// id=eq / estimate_id=eq / lead_id=eq / event_type=eq, id=in.(...),
// or=(from_number.like.*NNN,to_number.like.*NNN). Enough to drive the real sb()
// callers; a general parser would be more than these paths need.
// ---------------------------------------------------------------------------
function makeMockSb(db) {
  const parseTable = (p) => p.replace(/^\//, '').split('?')[0];
  const decode = (v) => decodeURIComponent(v);

  function matches(row, p) {
    const query = p.split('?')[1] || '';
    for (const clause of query.split('&')) {
      // COL=eq.VALUE (column-generic; only for real columns, skips
      // select/order/limit and the compound in./is./or forms handled below)
      const eqM = clause.match(/^([a-z_]+)=eq\.(.+)$/);
      if (eqM && !['select', 'order', 'limit', 'or'].includes(eqM[1])) {
        if (String(row[eqM[1]]) !== decode(eqM[2])) return false;
        continue;
      }
      // COL=in.(a,b,c) (column-generic)
      const inM = clause.match(/^([a-z_]+)=in\.\(([^)]*)\)/);
      if (inM) {
        const vals = inM[2].split(',').map((v) => decode(v));
        if (!vals.includes(String(row[inM[1]]))) return false;
        continue;
      }
      // COL=is.null
      const isNullM = clause.match(/^([a-z_]+)=is\.null$/);
      if (isNullM) {
        if (row[isNullM[1]] != null) return false;
        continue;
      }
      // or=(from_number.like.*TAIL,to_number.like.*TAIL)
      const orM = clause.match(/^or=\((.*)\)$/);
      if (orM) {
        const tails = [...orM[1].matchAll(/(from_number|to_number)\.like\.\*([0-9]+)/g)];
        const anyHit = tails.some(([, col, tail]) =>
          String(row[col] || '').replace(/\D/g, '').includes(tail));
        if (!anyHit) return false;
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

// Load a function module fresh with a mocked _pec-supabase in the require cache.
function loadFn(file, sbImpl, extra = {}) {
  const supPath = require.resolve(path.join(FN_DIR, '_pec-supabase.cjs'));
  const real = require(supPath);
  // badSecret false = the webhook-secret auth path passes, so the handler skips
  // the getUser() fetch (our fetch stub answers the model, not /auth/v1/user).
  require.cache[supPath] = {
    id: supPath, filename: supPath, loaded: true, exports: { ...real, sb: sbImpl, badSecret: () => false, ...extra },
  };
  const fnPath = require.resolve(path.join(FN_DIR, file));
  delete require.cache[fnPath];
  const mod = require(fnPath);
  return mod;
}

const bearerEvent = (body) => ({
  httpMethod: 'POST',
  headers: { authorization: 'Bearer good-token' },
  body: JSON.stringify(body),
});

// A model response shaped like the Anthropic Messages API, with a thinking
// block FIRST (the 613245a trap: content[0] is not the text block).
function modelResponse(obj) {
  return {
    ok: true,
    json: async () => ({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'considering' },
        { type: 'text', text: JSON.stringify(obj) },
      ],
    }),
  };
}

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';

// ===========================================================================
// pec-estimate-scope.cjs
// ===========================================================================
const SYS_FLAKE = 'sys-flake';
const flakeTemplate = [
  'Scope of work for 100% flake broadcast',
  '- Concrete past garage door is/is not  included',
  '- Stem walls are/are not included',
].join('\n');

function scopeDb({ stemWallsIntake = false, coatPast = false, scopeEditedAt = null, addonSnippet, stemAddon = false } = {}) {
  const lines = [
    { id: 'li-area', estimate_id: 'e1', addon_id: null, estimate_area_id: 'ar1', label: 'Garage: Standard Flake floor coating system', description: null, is_optional: false, selected_by_customer: false, sort_order: 0 },
  ];
  if (addonSnippet !== undefined) {
    lines.push({ id: 'li-addon', estimate_id: 'e1', addon_id: 'ad1', estimate_area_id: null, label: 'Filling Control Joints', description: null, is_optional: false, selected_by_customer: false, sort_order: 1 });
  }
  if (stemAddon) {
    lines.push({ id: 'li-stem', estimate_id: 'e1', addon_id: 'ad-stem', estimate_area_id: null, label: 'Stem Walls', description: null, is_optional: false, selected_by_customer: false, sort_order: 2 });
  }
  return {
    estimates: [{ id: 'e1', mvb: 'none', flake_color: null, intake: { stem_walls: stemWallsIntake, coat_past_garage: coatPast }, scope_of_work: scopeEditedAt ? 'HAND EDITED TEXT' : null, scope_edited_at: scopeEditedAt, estimate_number: 102026 }],
    estimate_areas: [{ id: 'ar1', estimate_id: 'e1', name: 'Garage', sqft: 600, system_type_id: SYS_FLAKE, sort_order: 0 }],
    estimate_line_items: lines,
    pec_prod_system_types: [{ id: SYS_FLAKE, name: 'Standard Flake', scope_template: flakeTemplate, scope_template_mvb: null }],
    pec_prod_addons: [
      { id: 'ad1', name: 'Filling Control Joints', scope_snippet: addonSnippet ?? '' },
      { id: 'ad-stem', name: 'Stem Walls', scope_snippet: 'Stem wall prep and coating.' },
    ],
    leads: [], lead_events: [], pec_call_log: [], pec_sms_log: [],
  };
}

await section('scope: stem walls resolved BOTH ways from the estimate data', async () => {
  // The model is told the facts; here we assert the FACTS the function computes
  // and passes are correct, by capturing the user prompt sent to the model and
  // echoing a resolved template back. We simulate the model doing substitution.
  for (const stem of [true, false]) {
    const db = scopeDb({ stemWallsIntake: stem });
    let capturedPrompt = '';
    global.fetch = async (url, opts) => {
      const b = JSON.parse(opts.body);
      capturedPrompt = b.messages[0].content;
      const resolved = flakeTemplate.replace('Stem walls are/are not included', stem ? 'Stem walls are included' : 'Stem walls are not included');
      return modelResponse({ lines: [{ line_item_id: 'li-area', scope: resolved }] });
    };
    const mod = loadFn('pec-estimate-scope.cjs', makeMockSb(db));
    const res = await mod.handler(bearerEvent({ estimate_id: 'e1' }));
    const body = JSON.parse(res.body);
    ok(res.statusCode === 200 && body.generated === true, `stem=${stem}: generates 200`);
    // The function must have told the model the correct fact.
    ok(capturedPrompt.includes(`"stem_walls_included": ${stem}`), `stem=${stem}: fact passed to model`);
    // The written line description carries the resolved (not the placeholder) text.
    const line = db.estimate_line_items.find((l) => l.id === 'li-area');
    ok(line.description && line.description.includes(stem ? 'Stem walls are included' : 'Stem walls are not included'), `stem=${stem}: resolved text written to the line`);
    ok(!line.description.includes('are/are not'), `stem=${stem}: placeholder is gone`);
    ok(db.estimates[0].scope_of_work && db.estimates[0].scope_stale === false, `stem=${stem}: document assembled, not stale`);
  }
});

await section('scope: a stem-walls ADD-ON on the estimate also counts as included', async () => {
  const db = scopeDb({ stemWallsIntake: false, stemAddon: true });
  let capturedPrompt = '';
  global.fetch = async (url, opts) => {
    capturedPrompt = JSON.parse(opts.body).messages[0].content;
    return modelResponse({ lines: [
      { line_item_id: 'li-area', scope: 'area scope' },
      { line_item_id: 'li-stem', scope: 'stem scope' },
    ] });
  };
  const mod = loadFn('pec-estimate-scope.cjs', makeMockSb(db));
  const res = await mod.handler(bearerEvent({ estimate_id: 'e1' }));
  ok(res.statusCode === 200, 'generates 200 with a stem-walls add-on line');
  ok(capturedPrompt.includes('"stem_walls_included": true'), 'a live Stem Walls add-on line flips the fact to true even when intake says false');
});

await section('scope: NEVER overwrite a hand-edited scope without the explicit click', async () => {
  const db = scopeDb({ scopeEditedAt: '2026-07-13T00:00:00Z' });
  let called = 0;
  global.fetch = async () => { called++; return modelResponse({ lines: [{ line_item_id: 'li-area', scope: 'x' }] }); };
  const mod = loadFn('pec-estimate-scope.cjs', makeMockSb(db));

  const res = await mod.handler(bearerEvent({ estimate_id: 'e1' })); // no force
  const body = JSON.parse(res.body);
  ok(res.statusCode === 409 && body.needs_confirm === true, 'edited scope + no force -> 409 needs_confirm');
  ok(called === 0, 'the model was NOT called (no overwrite attempted)');
  ok(db.estimates[0].scope_of_work === 'HAND EDITED TEXT', 'the human text is untouched');

  // Regeneration requires the explicit force=true click.
  const res2 = await mod.handler(bearerEvent({ estimate_id: 'e1', force: true }));
  ok(res2.statusCode === 200, 'force=true regenerates');
  ok(called === 1, 'the model ran exactly once under force');
  ok(db.estimates[0].scope_edited_at === null, 'regenerating clears scope_edited_at (machine text again)');
  ok(db.estimates[0].scope_of_work !== 'HAND EDITED TEXT', 'the document was replaced under the explicit click');
});

await section('scope: an add-on with an EMPTY snippet is skipped, not invented', async () => {
  const db = scopeDb({ addonSnippet: '' }); // Filling Control Joints line, empty snippet
  global.fetch = async () => modelResponse({ lines: [{ line_item_id: 'li-area', scope: 'area scope' }] });
  const mod = loadFn('pec-estimate-scope.cjs', makeMockSb(db));
  const res = await mod.handler(bearerEvent({ estimate_id: 'e1' }));
  const body = JSON.parse(res.body);
  ok(res.statusCode === 200 && body.generated === true, 'still generates for the area line');
  ok(body.skipped.some((s) => s.id === 'li-addon' && /snippet/.test(s.reason)), 'the empty-snippet add-on is reported skipped, not fabricated');
  ok(db.estimate_line_items.find((l) => l.id === 'li-addon').description == null, 'the empty-snippet add-on line gets no invented description');
});

// --- BLANK scope questions (15c) ---------------------------------------------
const QUARTZ_BLANK = 'Scope of work for quartz coating BLANK AREA\n\nExpected project duration:\n\nBLANK';
function blankDb({ answers = {}, scopeEditedAt = null } = {}) {
  return {
    estimates: [{ id: 'e1', mvb: 'none', flake_color: null, intake: {}, scope_of_work: scopeEditedAt ? 'EDITED' : null, scope_edited_at: scopeEditedAt, scope_answers: answers, estimate_number: 102026 }],
    estimate_areas: [{ id: 'ar1', estimate_id: 'e1', name: 'Patio', sqft: 400, system_type_id: 'sys-quartz', sort_order: 0 }],
    estimate_line_items: [{ id: 'li-area', estimate_id: 'e1', addon_id: null, estimate_area_id: 'ar1', label: 'Patio: Quartz floor coating system', description: null, is_optional: false, selected_by_customer: false, sort_order: 0 }],
    pec_prod_system_types: [{ id: 'sys-quartz', name: 'Quartz', scope_template: QUARTZ_BLANK, scope_template_mvb: null }],
    pec_prod_addons: [],
    leads: [], lead_events: [], pec_call_log: [], pec_sms_log: [],
  };
}
const scope = require(path.join(__dirname, 'scope.cjs'));

await section('scope BLANK: a template with BLANK produces questions', async () => {
  const db = blankDb();
  let captured = '';
  // The model is told to leave BLANK verbatim; echo the (answer-applied) template back.
  global.fetch = async (url, opts) => {
    captured = JSON.parse(opts.body).messages[0].content;
    // The template reaches the model with unanswered BLANKs still present.
    const t = JSON.parse(captured.split('LINE ITEMS TO ASSEMBLE')[1].match(/\[[\s\S]*\]/)[0])[0].template;
    return modelResponse({ lines: [{ line_item_id: 'li-area', scope: t }] });
  };
  const mod = loadFn('pec-estimate-scope.cjs', makeMockSb(db));
  const res = await mod.handler(bearerEvent({ estimate_id: 'e1' }));
  const body = JSON.parse(res.body);
  ok(res.statusCode === 200 && body.generated === true, 'generates');
  ok(body.open_questions.length === 2, 'two BLANK questions detected (BLANK AREA + duration)');
  ok(body.has_blank === true, 'the document still contains BLANK (unanswered)');
  ok(Array.isArray(db.estimates[0].scope_questions) && db.estimates[0].scope_questions.length === 2, 'open questions stored on the estimate for the Finish-the-scope card');
  // The question keys are the SAME ones the estimator computes for that template.
  const clientKeys = scope.detectBlanks(QUARTZ_BLANK, 'Quartz').map((q) => q.key).sort();
  const serverKeys = body.open_questions.map((q) => q.key).sort();
  ok(JSON.stringify(clientKeys) === JSON.stringify(serverKeys), 'server question keys match the client (estimator) keys');
});

await section('scope BLANK: answers substitute into the generated scope', async () => {
  const qs = scope.detectBlanks(QUARTZ_BLANK, 'Quartz');
  const answers = { [qs[0].key]: 'the back patio', [qs[1].key]: '2 days' };
  const db = blankDb({ answers });
  let captured = '';
  global.fetch = async (url, opts) => {
    captured = JSON.parse(opts.body).messages[0].content;
    const t = JSON.parse(captured.split('LINE ITEMS TO ASSEMBLE')[1].match(/\[[\s\S]*\]/)[0])[0].template;
    return modelResponse({ lines: [{ line_item_id: 'li-area', scope: t }] });
  };
  const mod = loadFn('pec-estimate-scope.cjs', makeMockSb(db));
  const res = await mod.handler(bearerEvent({ estimate_id: 'e1' }));
  const body = JSON.parse(res.body);
  ok(captured.includes('the back patio') && !/\bBLANK\b/.test(captured.split('LINE ITEMS TO ASSEMBLE')[1]), 'the answer-applied template reaches the model with NO BLANK left');
  ok(body.open_questions.length === 0, 'no open questions once answered');
  ok(body.has_blank === false, 'the generated document has no BLANK');
  ok(db.estimate_line_items.find((l) => l.id === 'li-area').description.includes('the back patio'), 'the answer is written into the line scope');
});

await section('scope BLANK: a template with NO blank produces no questions', async () => {
  const db = blankDb();
  db.pec_prod_system_types[0].scope_template = 'Scope of work for quartz coating. Grind, coat, topcoat. Do not walk on floor for 24 hours.';
  global.fetch = async () => modelResponse({ lines: [{ line_item_id: 'li-area', scope: 'clean scope' }] });
  const mod = loadFn('pec-estimate-scope.cjs', makeMockSb(db));
  const res = await mod.handler(bearerEvent({ estimate_id: 'e1' }));
  const body = JSON.parse(res.body);
  ok(body.open_questions.length === 0, 'no BLANK, no questions');
  ok(body.has_blank === false, 'no BLANK in the document');
  ok(db.estimates[0].scope_questions.length === 0, 'no questions stored');
});

// --- Per-line MVB scope template (build 17) ----------------------------------
// A line whose AREA has mvb=true uses the system's scope_template_mvb; an area
// without it uses scope_template. The server rule mirrors the estimator's, so a
// two-area estimate can carry both templates.
await section('scope: the MVB template is chosen PER LINE from the area flag', async () => {
  const STD = 'STANDARD FLAKE SCOPE (2 day system)';
  const MVB = 'MOISTURE VAPOR BARRIER REQUIRED (3 day system)';
  const db = {
    estimates: [{ id: 'e1', mvb: 'none', flake_color: null, intake: {}, scope_of_work: null, scope_edited_at: null, scope_answers: {}, estimate_number: 102026 }],
    estimate_areas: [
      { id: 'ar-g', estimate_id: 'e1', name: 'Garage', sqft: 600, system_type_id: 'sys-flake', mvb: true, sort_order: 0 },
      { id: 'ar-p', estimate_id: 'e1', name: 'Patio', sqft: 200, system_type_id: 'sys-flake', mvb: false, sort_order: 1 },
    ],
    estimate_line_items: [
      { id: 'li-g', estimate_id: 'e1', addon_id: null, estimate_area_id: 'ar-g', label: 'Garage: Standard Flake', description: null, is_optional: false, selected_by_customer: false, sort_order: 0 },
      { id: 'li-p', estimate_id: 'e1', addon_id: null, estimate_area_id: 'ar-p', label: 'Patio: Standard Flake', description: null, is_optional: false, selected_by_customer: false, sort_order: 1 },
    ],
    pec_prod_system_types: [{ id: 'sys-flake', name: 'Standard Flake', scope_template: STD, scope_template_mvb: MVB }],
    pec_prod_addons: [], leads: [], lead_events: [], pec_call_log: [], pec_sms_log: [],
  };
  let captured = '';
  global.fetch = async (url, opts) => {
    captured = JSON.parse(opts.body).messages[0].content;
    // Echo each target's template back as its scope.
    const targets = JSON.parse(captured.split('LINE ITEMS TO ASSEMBLE')[1].match(/\[[\s\S]*\]/)[0]);
    return modelResponse({ lines: targets.map((t) => ({ line_item_id: t.line_item_id, scope: t.template })) });
  };
  const mod = loadFn('pec-estimate-scope.cjs', makeMockSb(db));
  const res = await mod.handler(bearerEvent({ estimate_id: 'e1' }));
  ok(res.statusCode === 200, 'generates 200');
  // Mirror the client rule to prove the server matches it.
  const clientTpl = (area, sys) => (area.mvb && sys.scope_template_mvb) ? sys.scope_template_mvb : sys.scope_template;
  const sys = db.pec_prod_system_types[0];
  const garage = db.estimate_line_items.find((l) => l.id === 'li-g');
  const patio = db.estimate_line_items.find((l) => l.id === 'li-p');
  ok(garage.description === MVB && garage.description === clientTpl({ mvb: true }, sys), 'the MVB area uses scope_template_mvb (server == client rule)');
  ok(patio.description === STD && patio.description === clientTpl({ mvb: false }, sys), 'the non-MVB area uses the standard template');
});

// --- Archived estimate: the public route refuses it --------------------------
await section('archived: the public + preview routes 404 a deleted estimate', async () => {
  const TOKEN = '44444444-5555-4666-8777-888888888888';
  const AID = '55555555-6666-4777-8888-999999999999';
  const db = {
    estimates: [{ id: AID, public_token: TOKEN, sent_at: '2026-07-15T00:00:00Z', status: 'sent', deleted_at: '2026-07-15T01:00:00Z', mvb: 'none', system_type_id: 'sys-flake', customer_name: 'Jane', estimate_number: 102030, brand: 'prescott-epoxy', price: 4000 }],
    estimate_areas: [], estimate_line_items: [], pec_prod_system_types: [], pec_brand_identity: [], pec_email_senders: [],
  };
  global.fetch = async (url) => (String(url).includes('/auth/v1/user') ? { ok: true, json: async () => ({ id: 'staff' }) } : { ok: true, text: async () => '', json: async () => ({}) });
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  const pub = await mod.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { token: TOKEN }, path: `/e/${TOKEN}` });
  ok(pub.statusCode === 404, 'the public token route 404s an archived estimate');
  const prev = await mod.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer good' }, queryStringParameters: { preview: AID } });
  ok(prev.statusCode === 404, 'the staff preview route 404s an archived estimate too');
});

// ===========================================================================
// pec-estimate-ai.cjs: Quo history as intent signal + the empty-history honesty
// ===========================================================================
const aiBody = (leadId) => ({
  estimate_id: null, lead_id: leadId, inputs_key: 'k1',
  system_type_name: 'Standard Flake', sqft: 600, mvb: 'none',
  calc_price: 5000, target_gp_pct: 52,
  comps: { rule: 'none', rule_label: 'no comps', sample_size: 0, median_ppsf: null, rows: [] },
});

await section('AI price read: EMPTY Quo history -> "no history", intent never invented', async () => {
  const db = { estimates: [], leads: [{ id: 'lead1', phone: '9285551234' }], lead_events: [], pec_call_log: [], pec_sms_log: [] };
  let capturedPrompt = '';
  // Even if the model tries to invent intent, the server forces it to null.
  global.fetch = async (url, opts) => {
    capturedPrompt = JSON.parse(opts.body).messages[0].content;
    return modelResponse({ recommended_low: 4800, recommended_high: 5200, why: 'no comps; leaning on the calculator', intent_read: 'they seem eager' });
  };
  const mod = loadFn('pec-estimate-ai.cjs', makeMockSb(db));
  const res = await mod.handler(bearerEvent(aiBody('lead1')));
  const body = JSON.parse(res.body);
  ok(res.statusCode === 200 && body.success, 'price read returns 200');
  ok(body.recommendation.history_available === false, 'history_available is false (server fact)');
  ok(body.recommendation.intent_read === null, 'intent_read forced null despite the model returning text');
  ok(/NO CALL OR TEXT HISTORY IS ON FILE/.test(capturedPrompt), 'the prompt tells the model there is no history');
});

await section('AI price read: real Quo texts + a transcript feed the intent read', async () => {
  const db = {
    estimates: [],
    leads: [{ id: 'lead1', phone: '(928) 555-1234' }],
    lead_events: [],
    pec_call_log: [{ from_number: '+19285551234', to_number: '+19285550000', direction: 'in', occurred_at: '2026-07-10T00:00:00Z', duration_seconds: 120, summary: 'Customer wants it done before a party', next_steps: null, transcript: [{ identifier: 'cust', content: 'I need this before Saturday' }] }],
    pec_sms_log: [{ from_number: '9285551234', to_number: '9285550000', direction: 'in', created_at: '2026-07-11T00:00:00Z', body: 'Whats your best price?' }],
  };
  let capturedPrompt = '';
  global.fetch = async (url, opts) => {
    capturedPrompt = JSON.parse(opts.body).messages[0].content;
    return modelResponse({ recommended_low: 5000, recommended_high: 5500, why: 'urgent job', intent_read: 'Urgent: "I need this before Saturday".' });
  };
  const mod = loadFn('pec-estimate-ai.cjs', makeMockSb(db));
  const res = await mod.handler(bearerEvent(aiBody('lead1')));
  const body = JSON.parse(res.body);
  ok(body.recommendation.history_available === true, 'history_available true when calls/texts exist');
  ok(body.recommendation.intent_read && /Saturday/.test(body.recommendation.intent_read), 'the intent read survives when history is present');
  ok(capturedPrompt.includes('I need this before Saturday') && capturedPrompt.includes('Whats your best price?'), 'both the transcript and the text reached the model');
});

await section('AI price read: no lead_id -> history read is a no-op, never breaks the read', async () => {
  const db = { estimates: [], leads: [], lead_events: [], pec_call_log: [], pec_sms_log: [] };
  global.fetch = async () => modelResponse({ recommended_low: 4800, recommended_high: 5200, why: 'x', intent_read: null });
  const mod = loadFn('pec-estimate-ai.cjs', makeMockSb(db));
  const res = await mod.handler(bearerEvent(aiBody(null)));
  const body = JSON.parse(res.body);
  ok(res.statusCode === 200 && body.recommendation.history_available === false, 'walk-up (no lead) still prices, no history');
});

// ===========================================================================
// pec-public-estimate.cjs: optional line item EXCLUDED until the customer ticks
// it, and the signed selection freezes onto the ROWS (not a jsonb replace).
// ===========================================================================
await section('public page: optional add-on excluded until ticked; accept freezes it onto the rows', async () => {
  const TOKEN = '11111111-2222-4333-8444-555555555555';
  function freshDb() {
    return {
      estimates: [{
        id: 'pe1', public_token: TOKEN, sent_at: '2026-07-13T00:00:00Z', status: 'sent',
        deleted_at: null, mvb: 'none', flake_color: null, intake: { salesperson_name: 'Aron' },
        system_type_id: 'sys-flake', customer_name: 'Jane', customer_email: 'jane@example.com',
        customer_address: '1 Main', estimate_number: 102026, price: null, brand: 'prescott-epoxy', lead_id: null,
        scope_of_work: null,
      }],
      estimate_areas: [{ id: 'ar1', estimate_id: 'pe1', name: 'Garage', sqft: 600, system_type_id: 'sys-flake', sort_order: 0 }],
      estimate_line_items: [
        { id: 'req1', estimate_id: 'pe1', label: 'Standard Flake floor coating system', description: 'the scope', qty: 1, unit_price: 4200, total: 4200, is_optional: false, selected_by_customer: true, sort_order: 0 },
        { id: 'opt1', estimate_id: 'pe1', label: 'Stem Walls', description: null, qty: 1, unit_price: 350, total: 350, is_optional: true, selected_by_customer: false, sort_order: 1 },
      ],
      pec_prod_system_types: [{ id: 'sys-flake', name: 'Standard Flake' }],
      pec_brand_identity: [], pec_email_senders: [], customers: [], jobs: [], timeline_stages: [],
      job_areas: [], pec_prod_jobs: [], pec_prod_areas: [], leads: [], lead_events: [],
    };
  }

  // The render shows the base total EXCLUDING the unticked optional.
  {
    const db = freshDb();
    global.fetch = async () => ({ ok: true, text: async () => '', json: async () => ({}) });
    const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
    const res = await mod.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { token: TOKEN }, path: `/e/${TOKEN}` });
    ok(res.statusCode === 200, 'sent estimate renders 200');
    ok(res.body.includes('$4,200.00') && !res.body.includes('>$4,550.00<'), 'hero total excludes the unticked optional');
    ok(/Stem Walls/.test(res.body), 'the optional item is listed as tickable');
  }

  // Accept WITHOUT ticking: signs for the base total only.
  {
    const db = freshDb();
    global.fetch = async () => ({ ok: true, text: async () => '', json: async () => ({}) });
    const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
    const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'accept', name: 'Jane Doe', selected_optional_ids: [] }) });
    ok(res.statusCode === 200, 'accept (nothing ticked) succeeds');
    ok(db.estimates[0].price === 4200, 'signed for the base total, optional excluded');
    ok(db.estimate_line_items.find((l) => l.id === 'opt1').selected_by_customer === false, 'the untouched optional stays unselected on its row');
  }

  // Accept WITH the optional ticked: freezes onto the row, price includes it.
  {
    const db = freshDb();
    global.fetch = async () => ({ ok: true, text: async () => '', json: async () => ({}) });
    const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
    const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'accept', name: 'Jane Doe', selected_optional_ids: ['opt1'] }) });
    ok(res.statusCode === 200, 'accept (optional ticked) succeeds');
    ok(db.estimate_line_items.find((l) => l.id === 'opt1').selected_by_customer === true, 'the ticked optional is frozen selected ON THE ROW (not a jsonb write)');
    ok(db.estimates[0].price === 4550, 'signed total includes the ticked optional (4200 + 350)');
    ok(db.estimates[0].status === 'accepted' && db.estimates[0].signed_name === 'Jane Doe', 'the estimate is signed');
    ok(db.jobs.length === 1 && db.pec_prod_jobs.length === 1, 'the job was created in both tables');
    // The job's invoice line items include the ticked optional (it is now included).
    const jobLines = db.jobs[0].line_items || [];
    ok(jobLines.some((l) => l.name === 'Stem Walls'), 'the ticked optional flows into the job line items');
  }
});

// ===========================================================================
// Split customer identity (build 23): a commercial estimate renders company
// bold with the contact + split address under it, and accepting passes the
// split identity through to customers.first_name/last_name/company_name
// (company_name is the customer's BUSINESS; customers.company stays the
// brand). A pre-split row (composed columns only) must render unchanged.
// ===========================================================================
await section('public page + accept: commercial company renders and flows to the customer row', async () => {
  const TOKEN = '77777777-2222-4333-8444-555555555555';
  const db = {
    estimates: [{
      id: 'co1', public_token: TOKEN, sent_at: '2026-07-15T00:00:00Z', status: 'sent',
      deleted_at: null, mvb: 'none', flake_color: null, intake: { salesperson_name: 'Aron' },
      system_type_id: 'sys-flake', estimate_number: 102050, price: 8000, brand: 'prescott-epoxy', lead_id: null,
      scope_of_work: null,
      customer_name: 'Acme Coatings LLC (Wile Coyote)', customer_email: 'wile@acme.example',
      customer_address: '9 Desert Rd, Prescott, AZ 86301',
      customer_first_name: 'Wile', customer_last_name: 'Coyote', customer_company: 'Acme Coatings LLC',
      customer_is_commercial: true, customer_address1: '9 Desert Rd', customer_address2: null,
      customer_city: 'Prescott', customer_state: 'AZ', customer_zip: '86301',
    }],
    estimate_areas: [{ id: 'ar1', estimate_id: 'co1', name: 'Shop', sqft: 900, system_type_id: 'sys-flake', sort_order: 0 }],
    estimate_line_items: [
      { id: 'req1', estimate_id: 'co1', label: 'Standard Flake floor coating system', description: 's', qty: 1, unit_price: 8000, total: 8000, is_optional: false, selected_by_customer: true, sort_order: 0 },
    ],
    pec_prod_system_types: [{ id: 'sys-flake', name: 'Standard Flake' }],
    pec_brand_identity: [], pec_email_senders: [], customers: [], jobs: [], timeline_stages: [],
    job_areas: [], pec_prod_jobs: [], pec_prod_areas: [], leads: [], lead_events: [],
  };
  global.fetch = async () => ({ ok: true, text: async () => '', json: async () => ({}) });
  {
    const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
    const res = await mod.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { token: TOKEN }, path: `/e/${TOKEN}` });
    ok(res.statusCode === 200, 'commercial estimate renders 200');
    ok(res.body.includes('<div style="font-weight:700">Acme Coatings LLC</div>'), 'Prepared for leads with the company, bold');
    ok(res.body.includes('Attn: Wile Coyote'), 'the contact person shows under the company');
    ok(res.body.includes('9 Desert Rd, Prescott, AZ, 86301'), 'the address renders from the split fields');
  }
  {
    const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
    const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'accept', name: 'Wile Coyote' }) });
    ok(res.statusCode === 200, 'accept succeeds');
    const cust = db.customers[0];
    ok(cust && cust.company_name === 'Acme Coatings LLC' && cust.first_name === 'Wile' && cust.last_name === 'Coyote', 'split identity lands on the customer row');
    ok(cust.company === 'prescott-epoxy', 'customers.company stays the BRAND, untouched by the business name');
    ok(db.pec_prod_jobs[0] && db.pec_prod_jobs[0].customer_name === 'Acme Coatings LLC (Wile Coyote)', 'the schedule job carries the composed name (company + contact)');
  }
});

// ===========================================================================
// Pre-split row: only the composed columns exist (backfill not run, or an old
// offline save). The Prepared for block must fall back to them verbatim.
// ===========================================================================
await section('public page: pre-split row falls back to the composed columns', async () => {
  const TOKEN = '66666666-2222-4333-8444-555555555555';
  const db = {
    estimates: [{
      id: 'old1', public_token: TOKEN, sent_at: '2026-07-15T00:00:00Z', status: 'sent',
      deleted_at: null, mvb: 'none', flake_color: null, intake: { salesperson_name: 'Aron' },
      system_type_id: 'sys-flake', estimate_number: 102051, price: 5000, brand: 'prescott-epoxy', lead_id: null,
      scope_of_work: null, customer_name: 'Jane Legacy', customer_address: '1 Old Rd, Prescott AZ',
    }],
    estimate_areas: [{ id: 'ar1', estimate_id: 'old1', name: 'Garage', sqft: 500, system_type_id: 'sys-flake', sort_order: 0 }],
    estimate_line_items: [
      { id: 'req1', estimate_id: 'old1', label: 'Standard Flake floor coating system', description: 's', qty: 1, unit_price: 5000, total: 5000, is_optional: false, selected_by_customer: true, sort_order: 0 },
    ],
    pec_prod_system_types: [{ id: 'sys-flake', name: 'Standard Flake' }],
    pec_brand_identity: [], pec_email_senders: [], customers: [], jobs: [], timeline_stages: [],
    job_areas: [], pec_prod_jobs: [], pec_prod_areas: [], leads: [], lead_events: [],
  };
  global.fetch = async () => ({ ok: true, text: async () => '', json: async () => ({}) });
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  const res = await mod.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { token: TOKEN }, path: `/e/${TOKEN}` });
  ok(res.statusCode === 200, 'legacy estimate renders 200');
  ok(res.body.includes('<div style="font-weight:700">Jane Legacy</div>'), 'composed name renders bold, unchanged');
  ok(res.body.includes('1 Old Rd, Prescott AZ') && !res.body.includes('Attn:'), 'composed address renders; no phantom contact line');
});

// ===========================================================================
// Accept copies the estimate's areas onto the job (build 20): system, sqft,
// order_index, AND the per-area mvb flag, so the job carries its system(s)
// from acceptance and downstream (calendar color, materials, per-system
// metrics) has something to attribute to. Multi-system estimates copy ALL
// areas, one pec_prod_areas row each.
// ===========================================================================
await section('accept: estimate areas (incl. per-area mvb) copy onto pec_prod_areas', async () => {
  const TOKEN = '99999999-2222-4333-8444-555555555555';
  const db = {
    estimates: [{
      id: 'ma1', public_token: TOKEN, sent_at: '2026-07-14T00:00:00Z', status: 'sent',
      deleted_at: null, mvb: 'none', flake_color: null, intake: { salesperson_name: 'Aron' },
      system_type_id: 'sys-flake', customer_name: 'Multi Area', customer_email: 'multi@example.com',
      customer_address: '7 Oak', estimate_number: 102040, price: 9000, brand: 'prescott-epoxy', lead_id: null,
      scope_of_work: null,
    }],
    estimate_areas: [
      { id: 'ar-g', estimate_id: 'ma1', name: 'Garage', sqft: 600, system_type_id: 'sys-flake', mvb: true, sort_order: 0 },
      { id: 'ar-p', estimate_id: 'ma1', name: 'Patio', sqft: 200, system_type_id: 'sys-quartz', mvb: false, sort_order: 1 },
    ],
    estimate_line_items: [
      { id: 'req1', estimate_id: 'ma1', label: 'Standard Flake', description: 's', qty: 1, unit_price: 9000, total: 9000, is_optional: false, selected_by_customer: true, sort_order: 0 },
    ],
    pec_prod_system_types: [{ id: 'sys-flake', name: 'Standard Flake' }, { id: 'sys-quartz', name: 'Quartz' }],
    pec_brand_identity: [], pec_email_senders: [], customers: [], jobs: [], timeline_stages: [],
    job_areas: [], pec_prod_jobs: [], pec_prod_areas: [], leads: [], lead_events: [],
  };
  global.fetch = async () => ({ ok: true, text: async () => '', json: async () => ({}) });
  const mod = loadFn('pec-public-estimate.cjs', makeMockSb(db));
  const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ token: TOKEN, action: 'accept', name: 'Multi Area' }) });
  ok(res.statusCode === 200, 'accept succeeds');
  ok(db.pec_prod_areas.length === 2, 'BOTH estimate areas copied onto pec_prod_areas (multi-system job)');
  const garage = db.pec_prod_areas.find((a) => a.order_index === 0);
  const patio = db.pec_prod_areas.find((a) => a.order_index === 1);
  ok(garage && garage.system_type_id === 'sys-flake' && Number(garage.sqft) === 600 && garage.mvb === true, 'garage: system, sqft, order_index, and mvb=true all carried');
  ok(patio && patio.system_type_id === 'sys-quartz' && patio.mvb === false, 'patio: its OWN system copied, mvb=false');
});

// ===========================================================================
// Estimate preview (15c): the staff preview renders the SAME page as the
// public route (one renderer, no drift) while leaving sent_at null + status
// unchanged and never exposing the public token.
// ===========================================================================
await section('preview: identical body to the public route, no send, no token', async () => {
  const TOKEN = '22222222-3333-4333-8444-555555555555';
  const PVID = '33333333-3333-4333-8444-666666666666';
  const estRow = () => ({
    id: PVID, public_token: TOKEN, sent_at: '2026-07-13T00:00:00Z', status: 'sent',
    deleted_at: null, mvb: 'none', flake_color: 'Domino', intake: { salesperson_name: 'Aron' },
    system_type_id: 'sys-flake', customer_name: 'Jane', customer_email: 'jane@example.com',
    customer_address: '1 Main', estimate_number: 102026, price: null, brand: 'prescott-epoxy', lead_id: null,
    scope_of_work: null,
  });
  const seed = () => ({
    estimates: [estRow()],
    estimate_areas: [{ id: 'ar1', estimate_id: PVID, name: 'Garage', sqft: 600, system_type_id: 'sys-flake', sort_order: 0 }],
    estimate_line_items: [
      { id: 'req1', estimate_id: PVID, label: 'Standard Flake floor coating system', description: 'the scope', qty: 1, unit_price: 4200, total: 4200, is_optional: false, selected_by_customer: true, sort_order: 0 },
      { id: 'opt1', estimate_id: PVID, label: 'Stem Walls', description: null, qty: 1, unit_price: 350, total: 350, is_optional: true, selected_by_customer: false, sort_order: 1 },
    ],
    pec_prod_system_types: [{ id: 'sys-flake', name: 'Standard Flake' }],
    pec_brand_identity: [], pec_email_senders: [], customers: [], jobs: [], timeline_stages: [],
    job_areas: [], pec_prod_jobs: [], pec_prod_areas: [], leads: [], lead_events: [],
  });

  // Public GET (token) render.
  global.fetch = async () => ({ ok: true, text: async () => '', json: async () => ({}) });
  const pubDb = seed();
  const pubMod = loadFn('pec-public-estimate.cjs', makeMockSb(pubDb));
  const pubRes = await pubMod.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { token: TOKEN }, path: `/e/${TOKEN}` });

  // Staff preview: getUser() must pass. It calls fetch(/auth/v1/user); return a
  // user with an id. The mock sb is the SAME, so the data is identical.
  global.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'staff-1' }) };
    return { ok: true, text: async () => '', json: async () => ({}) };
  };
  const prevDb = seed();
  const prevMod = loadFn('pec-public-estimate.cjs', makeMockSb(prevDb));
  const prevRes = await prevMod.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer good' }, queryStringParameters: { preview: PVID } });

  ok(prevRes.statusCode === 200, 'preview renders 200 for a staff user');
  // Same renderer, so the CONTENT is identical once the deliberate
  // interactivity chrome is normalized out (disabled attrs, the tick-to-update
  // hints, the optional-items helper copy). What remains, hero -> footer, must
  // match byte-for-byte: proof the preview cannot drift from the customer page.
  // Compare the customer-facing CONTENT (hero -> the start of the decision
  // card). The actions card itself is where preview deliberately differs
  // (disabled buttons + a preview note), so it is excluded; everything a
  // customer reads before deciding must be identical.
  const core = (html) => html.slice(html.indexOf('<div class="hero">'), html.indexOf('id="actionsCard"'))
    .replace(/ disabled/g, '')
    .replace(/cursor:(pointer|default)/g, 'cursor:X')
    .replace('<div class="sub">Updates as you tick optional items</div>', '')
    .replace('Tick any you would like to add. The total updates as you choose.', 'OPTHELP')
    .replace('The selection below is what was chosen.', 'OPTHELP')
    .replace(/\s+/g, ' '); // collapse the empty-template-slot spacing so structural content compares cleanly
  ok(core(prevRes.body) === core(pubRes.body), 'preview customer content (hero -> decision card) matches the public page once the interactive chrome is normalized');
  // Preview-only chrome + safety:
  ok(/PREVIEW/.test(prevRes.body) && !/PREVIEW/.test(pubRes.body), 'preview shows the PREVIEW banner; the public page does not');
  ok(prevRes.body.includes('disabled>Accept') || /id="btnAccept" disabled/.test(prevRes.body) || /btnAccept"? disabled/.test(prevRes.body.replace(/\s+/g, ' ')), 'preview renders the Accept button disabled');
  ok(!prevRes.body.includes(TOKEN), 'preview never contains the public token');
  ok(pubRes.body.includes(TOKEN), '(the live public page DOES embed the token in its action script)');
  ok(!/<script>[\s\S]*fetch\('\/api\/estimate\/action'/.test(prevRes.body), 'preview has no live action script');
  // Nothing was mutated by the preview.
  ok(prevDb.estimates[0].status === 'sent' && prevDb.estimates[0].sent_at === '2026-07-13T00:00:00Z', 'preview left status + sent_at unchanged');

  // A preview WITHOUT a staff token is refused (not a token-based route).
  global.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: false, json: async () => ({}) };
    return { ok: true, text: async () => '', json: async () => ({}) };
  };
  const noAuthMod = loadFn('pec-public-estimate.cjs', makeMockSb(seed()));
  const noAuthRes = await noAuthMod.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { preview: PVID } });
  ok(noAuthRes.statusCode === 401, 'preview without a staff token is 401');

  // Preview works on an UNSENT (draft) estimate, which the public route 404s.
  const draftDb = seed();
  draftDb.estimates[0].status = 'draft';
  draftDb.estimates[0].sent_at = null;
  global.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'staff-1' }) };
    return { ok: true, text: async () => '', json: async () => ({}) };
  };
  const draftMod = loadFn('pec-public-estimate.cjs', makeMockSb(draftDb));
  const draftRes = await draftMod.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer good' }, queryStringParameters: { preview: PVID } });
  ok(draftRes.statusCode === 200 && /Estimate EST-102026/.test(draftRes.body), 'preview renders an UNSENT draft (the public route would 404 it)');
});

// ===========================================================================
// Price per sqft on jobs (build 17): the REAL jobEffectiveSqft rule from
// index.html; a null/dash with no sqft, and null jobs excluded from averages.
// ===========================================================================
await section('price per sqft: no sqft -> dash, excluded from the by-system average', async () => {
  const { readFileSync } = require('fs');
  const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function jobEffectiveSqft[\s\S]*?\n}/);
  ok(!!m, 'jobEffectiveSqft is defined in index.html');
  // eslint-disable-next-line no-new-func
  const jobEffectiveSqft = new Function(`${m[0]}; return jobEffectiveSqft;`)();

  // The $/sqft rule the Jobs table + costing panel use.
  const ppsf = (j) => {
    const eff = jobEffectiveSqft(j.sqft, (j.areas || []).map((a) => a.sqft));
    return eff > 0 && Number(j.price) > 0 ? Number(j.price) / eff : null;
  };
  ok(jobEffectiveSqft(null, []) === 0, 'no manual sqft + no areas = 0 sqft');
  ok(jobEffectiveSqft(850, [{ sqft: 100 }]) === 850, 'manual sqft wins over the areas sum');
  ok(jobEffectiveSqft(0, [300, 200]) === 500, 'no manual sqft falls back to the areas sum');
  ok(ppsf({ price: 4000, sqft: null, areas: [] }) === null, 'a job with no sqft yields null $/sqft (a dash, never a fabricated number)');
  ok(Math.abs(ppsf({ price: 4000, areas: [{ sqft: 800 }] }) - 5) < 1e-9, 'a job with areas yields price / sqft');

  // By-system average excludes null-sqft jobs and reports the exclusion count
  // (mirrors the metrics rule: only push when eff>0 && price>0).
  const jobs = [
    { price: 4000, areas: [{ sqft: 800 }] }, // $5.00
    { price: 6000, areas: [{ sqft: 1000 }] }, // $6.00
    { price: 5000, sqft: null, areas: [] },   // no sqft -> excluded
  ];
  const counted = jobs.map(ppsf).filter((p) => p != null);
  const excluded = jobs.length - counted.length;
  const avg = counted.reduce((s, p) => s + p, 0) / counted.length;
  ok(counted.length === 2 && excluded === 1, 'the no-sqft job is excluded, not counted as zero');
  ok(Math.abs(avg - 5.5) < 1e-9, 'the average is over the 2 costed jobs, not dragged to 0 by the excluded one');
});

// ===========================================================================
// Duplicate-estimate guard (15c): the REAL status set + wiring, read from
// index.html so the test tracks the shipped code, not a copy.
// ===========================================================================
await section('duplicate guard: open-status set + every-path wiring', async () => {
  const { readFileSync } = require('fs');
  const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  // Extract and evaluate the REAL OPEN_ESTIMATE_STATUSES array literal.
  const m = html.match(/const OPEN_ESTIMATE_STATUSES\s*=\s*(\[[^\]]*\])/);
  ok(!!m, 'OPEN_ESTIMATE_STATUSES is defined in index.html');
  const statuses = JSON.parse(m[1].replace(/'/g, '"'));
  const isOpen = (s) => statuses.includes(s);
  ok(isOpen('draft') && isOpen('sent') && isOpen('signed') && isOpen('change_requested'), 'guard fires on draft/sent/signed/change_requested');
  ok(!isOpen('rejected') && !isOpen('lost') && !isOpen('accepted'), 'guard stays silent on rejected/lost/accepted');
  ok(statuses.length === 4, 'exactly the four open statuses, nothing else');

  // The guard lives in the SHARED openEstimatorModal (so every caller is
  // covered), keyed on the lead and the open statuses.
  ok(/async function openEstimatorModal/.test(html), 'openEstimatorModal is async (can await the check)');
  const fnStart = html.indexOf('async function openEstimatorModal');
  const fnSlice = html.slice(fnStart, fnStart + 1600);
  ok(/\.eq\('lead_id', leadId\)/.test(fnSlice) && /\.in\('status', OPEN_ESTIMATE_STATUSES\)/.test(fnSlice), 'the guard queries the lead\'s estimates filtered to the open statuses');
  ok(/showDuplicateEstimateModal\(openEstimates/.test(fnSlice), 'when open estimates exist it shows the duplicate prompt instead of opening');
  ok(/leadId && !estimateId/.test(fnSlice), 'editing an existing estimate and walk-ups skip the guard');

  // Every create-for-a-lead path routes through openEstimatorModal (the lead
  // detail button does; there is no other lead-attached create call).
  ok(/leadStartEstimate.*openEstimatorModal\(\{ leadId: lead\.id \}\)/s.test(html) || /openEstimatorModal\(\{ leadId: lead\.id \}\)/.test(html), 'the Start-estimate button routes through the guarded openEstimatorModal');
  const leadIdCreateCalls = (html.match(/openEstimatorFrame\(\{ leadId \}\)/g) || []).length;
  ok(leadIdCreateCalls >= 1 && !/openEstimatorFrame\(\{ leadId: lead/.test(html), 'the raw frame opener is only reached AFTER the guard (never called directly with a fresh lead)');

  // The prompt lists all open estimates, offers Open + Create new anyway.
  ok(/function showDuplicateEstimateModal/.test(html), 'the duplicate modal exists');
  const dupStart = html.indexOf('function showDuplicateEstimateModal');
  const dupSlice = html.slice(dupStart, dupStart + 1800);
  ok(/Create new anyway/.test(dupSlice) && /data-open-est=/.test(dupSlice), 'the modal offers Create-new-anyway and an Open action per estimate');
});

// ===========================================================================
// Offline save: areas + add-ons ride the outbox in FK order and drain complete.
// Drives the REAL apps/estimator saveEstimateOffline + drainOutbox, bundled by
// esbuild with IndexedDB and supabase stubbed.
// ===========================================================================
await section('offline save: areas + add-on line items land complete when the outbox drains', async () => {
  const esbuild = require(path.join(__dirname, '..', 'apps', 'estimator', 'node_modules', 'esbuild'));

  // In-memory IndexedDB + supabase stubs, injected by rewriting the two lib
  // imports to virtual modules. The REAL offline code (estimates.ts, outbox.ts,
  // sync.ts) runs unchanged.
  const entry = `
    import { saveEstimateOffline } from ${JSON.stringify(path.join(__dirname, '..', 'apps', 'estimator', 'src', 'offline', 'estimates.ts'))};
    import { drainOutbox } from ${JSON.stringify(path.join(__dirname, '..', 'apps', 'estimator', 'src', 'offline', 'sync.ts'))};
    import { listOps } from ${JSON.stringify(path.join(__dirname, '..', 'apps', 'estimator', 'src', 'offline', 'outbox.ts'))};
    globalThis.__run = async (args) => {
      const { id } = await saveEstimateOffline(args);
      const queued = (await listOps()).map(o => ({ table: o.table, row: o.row }));
      const drain = await drainOutbox();
      return { id, queued, drain, uploaded: globalThis.__uploads };
    };
  `;

  // Virtual stubs for the offline layer's own deps.
  const stubPlugin = {
    name: 'stubs',
    setup(build) {
      build.onResolve({ filter: /idb$/ }, () => ({ path: 'stub-idb', namespace: 'stub' }));
      build.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'stub-supa', namespace: 'stub' }));
      build.onResolve({ filter: /offline\/uuid$/ }, () => ({ path: 'stub-uuid', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
        if (a.path === 'stub-idb') return { contents: `
          const store = { estimates: {}, outbox: {}, catalog: {} };
          export async function idbPut(s, v, key){ store[s] = store[s]||{}; store[s][key ?? v.opId ?? v.id] = v; }
          export async function idbGet(s, k){ return (store[s]||{})[k]; }
          export async function idbGetAll(s){ return Object.values(store[s]||{}); }
          export async function idbDelete(s, k){ delete (store[s]||{})[k]; }
        `, loader: 'js' };
        if (a.path === 'stub-supa') return { contents: `
          globalThis.__uploads = globalThis.__uploads || [];
          export const supabase = {
            from(table){ return { upsert: async (row) => { globalThis.__uploads.push({ table, id: row.id }); return { error: null }; } }; },
          };
        `, loader: 'js' };
        if (a.path === 'stub-uuid') return { contents: `let n=0; export function uuid(){ return 'uuid-'+(++n); }`, loader: 'js' };
      });
    },
  };

  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: __dirname, loader: 'ts' },
    bundle: true, format: 'cjs', write: false, platform: 'node', plugins: [stubPlugin],
    external: [],
  });
  const code = built.outputFiles[0].text;
  const mod = { exports: {} };
  new Function('module', 'exports', 'globalThis', code)(mod, mod.exports, globalThis);

  const args = {
    estimateId: null, status: 'draft', systemTypeId: 'sys-flake',
    salesperson: { id: 'sp1', name: 'Aron', commission_pct: 6 },
    intake: { gate_code: '1234' },
    // Split shape (build 23): saveEstimateOffline composes the combined
    // customer_name/customer_address safety-net columns from these.
    customer: { isCommercial: false, firstName: 'Jane', lastName: 'Doe', company: '', phone: '', email: '', address1: '1 Main St', address2: '', city: 'Prescott', state: 'AZ', zip: '86301' },
    mvb: 'none', flakeColor: null,
    lineItems: [
      { addonId: null, areaIndex: 0, label: 'Garage: Standard Flake floor coating system', description: '600 sqft', qty: 1, unitPrice: 3000, unitCost: 900, total: 3000, isOptional: false, selectedByCustomer: true, sortOrder: 0 },
      { addonId: null, areaIndex: 1, label: 'Patio: Quartz floor coating system', description: '200 sqft', qty: 1, unitPrice: 2000, unitCost: 800, total: 2000, isOptional: false, selectedByCustomer: true, sortOrder: 1 },
      { addonId: 'ad-stem', areaIndex: null, label: 'Stem Walls', description: null, qty: 40, unitPrice: 10, unitCost: 4, total: 400, isOptional: true, selectedByCustomer: false, sortOrder: 2 },
    ],
    pricingSnapshot: null,
    areas: [
      { name: 'Garage', sqft: 600, systemTypeId: 'sys-flake', flakeProductId: null, basecoatProductId: null, topcoatProductId: null, answers: {}, materials: [] },
      { name: 'Patio', sqft: 200, systemTypeId: 'sys-quartz', flakeProductId: null, basecoatProductId: null, topcoatProductId: null, answers: {}, materials: [] },
    ],
    pricing: { materialsCost: 1700, fixedAddons: 0, laborPct: 17.5, commissionPct: 6, targetGpPct: 51.5, calcVersion: '2026-07-13.1', materialLines: [] },
    totals: { price: 5000, gpDollars: 2000, gpPct: 0.4, gpPerHour: null, laborBudget: null, commissionDollars: null, budgetedHours: null },
    createdBy: 'user1', leadId: 'lead1',
  };

  const out = await globalThis.__run(args);
  const tables = out.queued.map((q) => q.table);
  // FK order: the estimate first, then areas, then the line items (which FK the
  // areas). No child may precede its parent.
  ok(tables[0] === 'estimates', 'the estimate is enqueued first');
  const firstArea = tables.indexOf('estimate_areas');
  const firstLine = tables.indexOf('estimate_line_items');
  ok(firstArea > 0 && firstLine > firstArea, 'areas enqueue before line items (FK order)');
  ok(tables.filter((t) => t === 'estimate_areas').length === 2, 'both areas enqueued');
  ok(tables.filter((t) => t === 'estimate_line_items').length === 3, 'all three line items enqueued');

  // The two system lines resolved their areaIndex to REAL minted area ids.
  const lineRows = out.queued.filter((q) => q.table === 'estimate_line_items').map((q) => q.row);
  const areaRows = out.queued.filter((q) => q.table === 'estimate_areas').map((q) => q.row);
  const areaIds = new Set(areaRows.map((r) => r.id));
  const garageLine = lineRows.find((r) => r.label.startsWith('Garage'));
  const patioLine = lineRows.find((r) => r.label.startsWith('Patio'));
  const stemLine = lineRows.find((r) => r.label === 'Stem Walls');
  ok(garageLine && areaIds.has(garageLine.estimate_area_id), 'garage line bound to a real area id');
  ok(patioLine && garageLine.estimate_area_id !== patioLine.estimate_area_id, 'each system line bound to its OWN area');
  ok(stemLine && stemLine.estimate_area_id == null && stemLine.addon_id === 'ad-stem', 'the add-on line has no area, keeps its addon_id');
  ok(stemLine.is_optional === true && stemLine.unit_cost === 4, 'the add-on line carries optional + a unit cost (GP honesty)');

  // The split customer fields persist AND the combined safety-net columns are
  // composed on the same row, so an offline save carries both.
  const estRow = out.queued.find((q) => q.table === 'estimates').row;
  ok(estRow.customer_first_name === 'Jane' && estRow.customer_last_name === 'Doe', 'split name persisted');
  ok(estRow.customer_is_commercial === false && estRow.customer_company === null, 'residential: no company, toggle stored false');
  ok(estRow.customer_name === 'Jane Doe', 'customer_name composed from the split name');
  ok(estRow.customer_address === '1 Main St, Prescott, AZ, 86301', 'customer_address composed from the split address');

  // Draining uploads everything; the estimate lands before its children.
  ok(out.drain.synced === out.queued.length && out.drain.failed === 0, 'the whole outbox drains clean');
  const upTables = out.uploaded.map((u) => u.table);
  ok(upTables.indexOf('estimates') < upTables.indexOf('estimate_areas'), 'upload order keeps the estimate before its areas');
  ok(upTables.filter((t) => t === 'estimate_line_items').length === 3, 'all three line items uploaded');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
