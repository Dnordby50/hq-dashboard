'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { estimatePricingSendBlockers: blockers } = require('./estimate-send-readiness.cjs');

const snapshot = patch => ({ version: 1, combinedGpPct: .5, calcTotal: 5000, finalSell: 5000, isCustom: false, lines: [{ label: 'Garage', gpPct: .5 }], ...patch });
const estimate = (snap = {}, rest = {}) => ({ id: '11111111-1111-4111-8111-111111111111', status: 'sent', sent_at: '2026-09-01T00:00:00Z', price: 5000, pricing_snapshot: { send_readiness: snapshot(snap) }, estimate_line_items: [{ label: 'Garage', total: 5000, qty: 1, unit_cost: 2500, estimate_area_id: 'area', is_optional: false }], ...rest });
const dashboard = fs.readFileSync(require.resolve('../index.html'), 'utf8');

test('browser mirror is identical to the executable server pricing policy', () => {
  const browserSource = dashboard.slice(dashboard.indexOf('function estimatePricingSendBlockers('), dashboard.indexOf('\nasync function flushEstimateBeforeSend'));
  const browserRule = vm.runInNewContext(`(${browserSource.trim()})`);
  assert.equal(browserRule.toString(), blockers.toString());
});

test('ordinary pricing and custom estimates are sendable', () => {
  assert.deepEqual(blockers(estimate()), []);
  assert.deepEqual(blockers(estimate({ combinedGpPct: null, calcTotal: null, finalSell: 500, isCustom: true }, { is_custom: true })), []);
  assert.deepEqual(blockers({ is_custom: true, gp_pct: null, calc_price: null }), []);
});

test('missing override reason blocks send above floor and clears after typing a reason', () => {
  assert.match(blockers(estimate({ finalSell: 4800 }))[0].msg, /reason.*before sending/);
  assert.deepEqual(blockers(estimate({ finalSell: 4800 }, { price_override_reason: 'Competitor match' })), []);
  assert.deepEqual(blockers(estimate({ finalSell: 4900 })), []);
  assert.equal(blockers(estimate({ finalSell: 4800 }), { line_pricing_reason_threshold_pct: '5', line_pricing_reason_threshold_dollars: '100' }).length, 0);
});

test('below-floor job blocks send even with an override reason; rounding tolerance stays unchanged', () => {
  assert.match(blockers(estimate({ combinedGpPct: .25 }, { price_override_reason: 'Match' }))[0].msg, /25.0%.*40% floor/);
  assert.deepEqual(blockers(estimate({ combinedGpPct: .3996 })), []);
  assert.equal(blockers(estimate({ combinedGpPct: .3994 })).length, 1);
  assert.deepEqual(blockers(estimate({ combinedGpPct: .35 }), { estimator_floor_gp_pct: '30' }), []);
});

test('per-line floor remains controlled by its existing setting', () => {
  const est = estimate({ lines: [{ label: 'Patio', gpPct: .2 }] });
  assert.deepEqual(blockers(est), []);
  assert.match(blockers(est, { line_pricing_block_below_floor: 'true' })[0].msg, /Patio.*20.0%.*line floor/);
  assert.deepEqual(blockers(est, { line_pricing_block_below_floor: 'true', line_pricing_gp_floor_pct: '15' }), []);
});

test('legacy pricing derives area cost and addon commission without confusing optional totals', () => {
  const est = { calc_price: 5000, price: 4000, gp_pct: .1, commission_pct: 10, estimate_line_items: [
    { estimate_area_id: 'area', label: 'Garage', total: 4000, unit_cost: 2000, qty: 1, is_optional: false },
    { estimate_area_id: 'area2', label: 'Patio', total: 1000, unit_cost: 500, qty: 1, is_optional: true, selected_by_customer: true },
    { label: 'Travel', total: 100, unit_cost: 20, qty: 1, is_optional: false },
  ] };
  assert.deepEqual(blockers(est), []);
  est.estimate_line_items[0].total = 2000;
  assert.equal(blockers(est).length, 2);
  assert.match(blockers(est)[0].msg, /reason/);
  assert.match(blockers(est)[1].msg, /floor/);
  assert.deepEqual(blockers({ price: 1000, calc_price: 1000, gp_pct: .5 }), []);
  assert.match(blockers({ price: 1000, calc_price: 1000, gp_pct: .2 })[0].msg, /floor/);
});

test('dashboard flush waits for its own frame and blocks on save failure', async () => {
  const start = dashboard.indexOf('async function flushEstimateBeforeSend(');
  const source = dashboard.slice(start, dashboard.indexOf('\nasync function estimateSendGateOk(', start));
  let listener, sent, blocked;
  const frame = { postMessage: message => { sent = message; } };
  const context = {
    crypto: { randomUUID: () => 'request' },
    pecInlineEstimatorAlive: () => true,
    pecEstInline: { estimateId: 'estimate', iframe: { contentWindow: frame } },
    window: { location: { origin: 'https://test.local' }, addEventListener: (_, fn) => { listener = fn; }, removeEventListener: () => {} },
    setTimeout: () => 1, clearTimeout: () => {},
    showEstimateSendBlockers: (_, rows) => { blocked = rows; },
  };
  const flush = vm.runInNewContext(`(${source})`, context);
  let resolved = false;
  const pending = flush({ id: 'estimate' }).then(value => { resolved = true; return value; });
  assert.equal(sent.type, 'pec-estimator-flush');
  listener({ origin: 'https://wrong.local', source: frame, data: { type: 'pec-estimator-flushed', request_id: 'request', estimate_id: 'estimate', ok: true } });
  await Promise.resolve();
  assert.equal(resolved, false);
  listener({ origin: 'https://test.local', source: frame, data: { type: 'pec-estimator-flushed', request_id: 'request', estimate_id: 'estimate', ok: false, error: 'Sync pending' } });
  assert.equal(await pending, false);
  assert.equal(blocked[0].msg, 'Sync pending');
});

test('dashboard gate waits for saving, judges fresh prices, and fails closed when refresh fails', async () => {
  const start = dashboard.indexOf('async function estimateSendGateOk(');
  const source = dashboard.slice(start, dashboard.indexOf('\n// Prompt 76 Part F: the blocker list', start));
  let current = estimate({ combinedGpPct: .2 });
  let saveDone = false, readError = false, shown = [];
  const trace = [];
  const context = {
    flushEstimateBeforeSend: async () => { trace.push('flush'); await Promise.resolve(); saveDone = true; return true; },
    estimateOpeningTotal: est => est.estimate_line_items.reduce((sum, li) => sum + li.total, 0),
    estimateOptionalGateOk: () => true,
    estimatePricingSendBlockers: blockers,
    pecScopePlainText: text => String(text || ''),
    estScopeBlanks: () => [],
    EST_CLOBBER_DESC_RE: /^\s*\d+\s*sq\s*ft/i,
    showEstimateSendBlockers: (_, rows) => { shown = rows; },
    supabase: { from: table => {
      trace.push(table);
      assert.equal(saveDone, true);
      const data = table === 'estimates' ? current
        : table === 'estimate_line_items' ? current.estimate_line_items.map(li => ({ ...li, description: 'Prepare and coat the floor.', sort_order: 0 }))
        : table === 'estimate_areas' ? [{ id: 'area', is_custom: false }] : [];
      const chain = { then: resolve => resolve({ data, error: readError ? { message: 'offline' } : null }) };
      for (const name of ['select', 'eq', 'order', 'maybeSingle', 'in']) chain[name] = () => chain;
      return chain;
    } },
  };
  const gate = vm.runInNewContext(`(${source})`, context);
  const stale = estimate();
  assert.equal(await gate(stale), false);
  assert.equal(trace[0], 'flush');
  assert.match(shown[0].msg, /20.0%/);
  current = estimate();
  assert.equal(await gate(stale), true, 'fixing the saved price clears the blocker without remounting the page');
  readError = true;
  assert.equal(await gate(stale), false);
  assert.match(shown[0].msg, /Could not check/);
});

test('actual email, SMS and public signing handlers reject saved invalid pricing before any delivery or signature', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.QUO_API_KEY = 'test-key';
  const supabasePath = require.resolve('../netlify/functions/_pec-supabase.cjs');
  const originalSupa = require(supabasePath);
  let current = estimate({ combinedGpPct: .25 });
  let providerCalls = 0;
  const writes = [];
  const originalFetch = global.fetch;
  const sb = async (method, path, payload) => {
    if (method !== 'GET') { writes.push({ method, path, payload }); return [{ id: 'logged' }]; }
    if (path.startsWith('/estimates?')) return [structuredClone(current)];
    if (path.startsWith('/estimate_line_items?')) return structuredClone(current.estimate_line_items);
    if (path.startsWith('/settings?')) return [];
    if (path.startsWith('/pec_sms_senders?')) return [{ from_number: '+19285550100' }];
    if (path.startsWith('/pec_email_senders?')) return [{ from_name: 'Test', from_email: 'test@example.com' }];
    return [];
  };
  require.cache[supabasePath].exports = { ...originalSupa, sb, requireStaff: async () => ({ ok: true, user: { id: 'staff' } }) };
  global.fetch = async () => { providerCalls++; return { ok: true, json: async () => ({ id: 'sent', data: { id: 'sent' } }) }; };
  const names = ['pec-send-email.cjs', 'pec-send-sms.cjs', 'pec-public-estimate.cjs'];
  try {
    const [email, sms, publicEstimate] = names.map(name => {
      const path = require.resolve(`../netlify/functions/${name}`); delete require.cache[path]; return require(path);
    });
    const emailInput = { brand: 'prescott-epoxy', to_email: 'test@example.com', subject: 'Estimate', body_html: '<p>Estimate</p>', estimate_id: current.id };
    const smsInput = { brand: 'prescott-epoxy', to_number: '9285550101', kind: 'estimate', estimate_token: current.id };
    const post = body => ({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });
    assert.equal((await email.handler(post(emailInput))).statusCode, 400);
    assert.equal((await sms.handler(post(smsInput))).statusCode, 400);
    const accept = await publicEstimate.handler(post({ action: 'accept', token: current.id, name: 'Customer' }));
    assert.equal(accept.statusCode, 409);
    assert.match(accept.body, /being updated/);
    assert.doesNotMatch(accept.body, /profit|floor|reason/);
    assert.equal(providerCalls, 0);
    assert.deepEqual(writes, []);
    const page = await publicEstimate.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { token: current.id } });
    assert.match(page.body, /being updated/);
    assert.doesNotMatch(page.body, /profit|floor|reason/);
    current = estimate({ finalSell: 4800 });
    assert.match((await email.handler(post(emailInput))).body, /reason/);
    assert.match((await sms.handler(post(smsInput))).body, /reason/);
    current = estimate();
    assert.equal((await email.handler(post(emailInput))).statusCode, 200);
    assert.equal((await sms.handler(post(smsInput))).statusCode, 200);
    assert.equal(providerCalls, 2);
    current = estimate({ combinedGpPct: .25 }, { status: 'accepted' });
    assert.equal((await publicEstimate._internals.loadEstimate(current.id)).pricing_review_pending, undefined);
    current = estimate({ combinedGpPct: .25 }, { pricing_snapshot: null });
    assert.equal((await publicEstimate._internals.loadEstimate(current.id)).pricing_review_pending, undefined);
  } finally {
    global.fetch = originalFetch;
    require.cache[supabasePath].exports = originalSupa;
    for (const name of names) delete require.cache[require.resolve(`../netlify/functions/${name}`)];
  }
});
