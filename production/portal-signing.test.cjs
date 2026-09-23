'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('../apps/estimator/node_modules/jsdom');
const { estimatePage } = require('../netlify/functions/pec-public-estimate.cjs')._internals;

// Exercise the shipped portal renderer and its real event handlers with only
// synthetic token-scoped responses. No customer records or network writes.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('function portalFootHtml(');
const end = html.indexOf('// Helpers\n', start);
assert.ok(start >= 0 && end > start, 'Portal source boundaries exist');
const source = html.slice(start, end);
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const openDoms = new Set();
test.afterEach(() => { for (const dom of openDoms) dom.window.close(); openDoms.clear(); });
const signedEstimate = {
  estimate_number: 100001, signed_name: 'Synthetic Customer',
  signed_at: '2026-09-21T12:00:00Z', public_token: 'synthetic-estimate-token',
};
const catalog = {
  areas: [{ id: 'area-1', name: 'Garage', slots: [{
    recipe_slot_id: 'slot-1', label: 'Flake', selected_product_id: null,
    options: [{ product_id: 'product-1', name: 'Synthetic color', color: 'Gray' }],
  }] }],
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(overrides = {}, catalogData = null) {
  const job = {
    id: 'job-1', type: 'paint', status: 'signed', confirmed: false,
    colors_confirmed: false, estimate_signature: null, ...overrides,
  };
  const latest = {
    customer: { id: 'customer-1', name: 'Synthetic Customer', company: 'prescott-epoxy' },
    jobs: [clone(job)], referral_reward_amount: '50', statusDescriptions: {},
    estimates: [], invoices: [], referrals: [], brand: {}, config: {},
  };
  const dom = new JSDOM('<!doctype html><body class="pec-portal-mode"><main id="customerPortalRoot"></main>', {
    url: 'https://portal.test/?portal=synthetic-portal-token#job/job-1', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  openDoms.add(dom);
  const context = dom.window, calls = [], alerts = [], listeners = new WeakMap(), canvasStates = new WeakMap();
  let beforeRpc = async () => {};
  const originalAddListener = context.EventTarget.prototype.addEventListener;
  context.EventTarget.prototype.addEventListener = function(event, callback, options) {
    const own = listeners.get(this) || new Map();
    own.set(event, callback); listeners.set(this, own);
    return originalAddListener.call(this, event, callback, options);
  };
  context.Element.prototype.emit = async function(event, values = {}) {
    return listeners.get(this)?.get(event)?.call(this, { target: this, clientX: 10, clientY: 10, preventDefault() {}, ...values });
  };
  context.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 160, left: 0, top: 0 });
  context.HTMLCanvasElement.prototype.getContext = function() {
    let state = canvasStates.get(this);
    if (!state) { state = { ink: false, fills: 0, strokes: 0, points: [] }; canvasStates.set(this, state); }
    return {
      scale() {}, beginPath() {},
      fillRect() { state.ink = false; state.fills++; },
      moveTo(x, y) { state.points.push(['move', x, y]); },
      lineTo(x, y) { state.points.push(['line', x, y]); },
      stroke() { state.ink = true; state.strokes++; },
    };
  };
  context.HTMLCanvasElement.prototype.toDataURL = function() {
    return canvasStates.get(this)?.ink ? 'data:image/png;base64,c3ludGhldGlj' : 'data:image/png;base64,Ymxhbms=';
  };
  context.$ = id => context.document.getElementById(id);
  context.esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  context.fmtDate = value => String(value ?? '');
  context.fmtMoney = value => `$${value}`;
  context.alert = message => alerts.push(message);
  context.fetch = async () => ({ ok: true, status: 200, json: async () => clone(latest) });
  const query = new Proxy({}, { get: (_target, key) => key === 'then'
    ? (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject)
    : () => query });
  context.supabase = {
    from: () => query,
    async rpc(name, payload) {
      calls.push({ name, payload: clone(payload) });
      const override = await beforeRpc(name, payload);
      if (override) return override;
      if (name === 'get_portal_data') return { data: clone(latest), error: null };
      if (name === 'get_portal_job_catalog') return { data: clone(catalogData), error: null };
      if (name === 'portal_set_area_colors') latest.jobs[0].colors_confirmed = true;
      else if (name === 'portal_confirm_job') {
        latest.jobs[0].confirmed = true;
        latest.jobs[0].signature_data = payload.p_signature;
        latest.jobs[0].confirmed_at = '2026-09-21T12:30:00Z';
      } else throw new Error(`Unexpected RPC ${name}`);
      return { data: { ok: true }, error: null };
    },
  };
  vm.runInContext(source, dom.getInternalVMContext());
  const root = context.$('customerPortalRoot');
  return {
    root, latest, calls, alerts, context, canvasState: canvas => canvasStates.get(canvas),
    render: () => context.portalJobDetail('synthetic-portal-token', 'job-1', clone(latest)),
    renderHome: () => { context.location.hash = ''; return context.renderCustomerPortal('synthetic-portal-token'); },
    element: id => context.$(id),
    beforeRpc(callback) { beforeRpc = callback; },
    writes: () => calls.filter(call => call.name.startsWith('portal_')),
    async ink() {
      const canvas = context.$('pecPortalSig');
      assert.ok(canvas, 'An unsigned project has a canvas');
      await canvas.emit('pointerdown');
      await canvas.emit('pointermove', { clientX: 20, clientY: 20 });
      await canvas.emit('pointerup');
    },
    pick: () => root.querySelector('[data-pick-grid]').emit('click', { target: root.querySelector('[data-prod]') }),
  };
}

test('accepted estimate is read-only for current or legacy document links and a missing signer name', async () => {
  for (const signature of [signedEstimate, { ...signedEstimate, signed_name: null }, { ...signedEstimate, public_token: undefined, url: '/e/synthetic-estimate-token' }]) {
    const h = harness({ estimate_signature: signature });
    await h.render();
    assert.match(h.root.innerHTML, /Your signed estimate/);
    assert.match(h.root.innerHTML, /href="\/e\/synthetic-estimate-token"/);
    assert.doesNotMatch(h.root.innerHTML, /pecPortalSig|pecSigConfirm|Sign your project/);
    assert.equal(h.writes().length, 0);
    await h.renderHome();
    assert.match(h.root.innerHTML, /Signed/);
  }
});

test('accepted epoxy estimate retains a separate color confirmation without a second signature', async () => {
  const h = harness({ type: 'epoxy', estimate_signature: signedEstimate }, catalog);
  await h.render();
  assert.doesNotMatch(h.root.innerHTML, /pecPortalSig|pecSigConfirm|Sign your project/);
  const button = h.element('pecColorsConfirm');
  assert.ok(button);
  assert.equal(button.disabled, true, 'Color selection remains required');
  await h.pick();
  assert.equal(button.disabled, false);
  await button.emit('click');
  await tick();
  assert.deepEqual(h.writes().map(call => call.name), ['portal_set_area_colors']);
  assert.deepEqual(h.writes()[0].payload.p_picks, [{ job_area_id: 'area-1', recipe_slot_id: 'slot-1', product_id: 'product-1' }]);
  assert.equal(h.latest.jobs[0].confirmed, false);
  assert.deepEqual(h.latest.jobs[0].estimate_signature, signedEstimate);
});

test('signed epoxy with no catalog and legacy confirmed projects never offer another signature', async () => {
  for (const overrides of [
    { type: 'epoxy', estimate_signature: signedEstimate },
    { type: 'epoxy', confirmed: true, confirmed_at: '2026-09-21', signature_data: 'data:image/png;base64,b2xk' },
  ]) {
    const h = harness(overrides);
    await h.render();
    assert.doesNotMatch(h.root.innerHTML, /pecPortalSig|pecSigConfirm|pecColorsConfirm/);
    if (overrides.confirmed) assert.match(h.root.innerHTML, /data:image\/png;base64,b2xk/);
  }
});

test('unsigned legacy projects still require ink and all colors, then save colors before signing', async () => {
  const h = harness({ type: 'epoxy' }, catalog);
  await h.render();
  const button = h.element('pecSigConfirm');
  assert.ok(button, 'The default status signed does not count as a signature');
  assert.equal(button.disabled, true);
  await h.ink();
  assert.equal(button.disabled, true, 'Ink alone cannot bypass required colors');
  await h.pick();
  assert.equal(button.disabled, false);
  await button.emit('click');
  await tick();
  assert.deepEqual(h.writes().map(call => call.name), ['portal_set_area_colors', 'portal_confirm_job']);
  assert.equal(h.writes()[1].payload.p_signature, 'data:image/png;base64,c3ludGhldGlj');
  assert.equal(h.writes()[1].payload.p_colors, null);
  assert.doesNotMatch(h.root.innerHTML, /pecPortalSig|pecSigConfirm/);
});

test('an estimate signed in another tab closes a stale unsigned form before any color or signature write', async () => {
  const h = harness({ type: 'epoxy' }, catalog);
  await h.render();
  await h.ink();
  await h.pick();
  const oldButton = h.element('pecSigConfirm');
  h.latest.jobs[0].estimate_signature = clone(signedEstimate);
  await oldButton.emit('click');
  await oldButton.emit('click');
  assert.equal(h.writes().length, 0);
  assert.doesNotMatch(h.root.innerHTML, /pecPortalSig|pecSigConfirm/);
  assert.ok(h.element('pecColorsConfirm'), 'Customer can continue with colors only');
});

test('repeated clicks and input while saving cannot submit twice or re-enable signing', async () => {
  for (const signed of [false, true]) {
    const h = harness({ type: 'epoxy', estimate_signature: signed ? signedEstimate : null }, catalog);
    await h.render();
    if (!signed) await h.ink();
    await h.pick();
    const button = h.element(signed ? 'pecColorsConfirm' : 'pecSigConfirm');
    const entered = deferred(), release = deferred();
    h.beforeRpc(async name => {
      if (name === 'get_portal_data') { entered.resolve(); await release.promise; }
    });
    const first = button.emit('click');
    await entered.promise;
    await button.emit('click');
    await h.pick();
    if (!signed) await h.ink();
    assert.equal(button.disabled, true);
    assert.equal(h.calls.filter(call => call.name === 'get_portal_data').length, 1);
    release.resolve();
    await first;
    await tick();
    await button.emit('click');
    assert.deepEqual(h.writes().map(call => call.name), signed ? ['portal_set_area_colors'] : ['portal_set_area_colors', 'portal_confirm_job']);
  }
});

test('failed freshness read leaves the drawn signature available and makes no writes', async () => {
  const h = harness();
  await h.render();
  await h.ink();
  const button = h.element('pecSigConfirm');
  h.beforeRpc(async name => name === 'get_portal_data' ? { error: { message: 'Please reconnect' }, data: null } : null);
  await button.emit('click');
  assert.equal(h.writes().length, 0);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Confirm & sign');
  assert.deepEqual(h.alerts, ['Please reconnect']);
  assert.ok(h.element('pecPortalSig'));
});

test('navigating away while freshness is pending leaves the new screen intact and makes no writes', async () => {
  const h = harness();
  await h.render();
  await h.ink();
  const button = h.element('pecSigConfirm');
  const entered = deferred(), release = deferred();
  h.beforeRpc(async name => {
    if (name === 'get_portal_data') { entered.resolve(); await release.promise; }
  });
  const pending = button.emit('click');
  await entered.promise;
  h.root.innerHTML = '<div id="other-screen">Other screen</div>';
  release.resolve();
  await pending;
  await button.emit('click');
  assert.equal(h.writes().length, 0);
  assert.match(h.root.innerHTML, /Other screen/);
});

test('resizing preserves actual signature ink and scales saved strokes before confirmation', async () => {
  const h = harness();
  await h.render();
  const canvas = h.element('pecPortalSig'), button = h.element('pecSigConfirm');
  h.context.dispatchEvent(new h.context.Event('resize'));
  assert.equal(button.disabled, true, 'A resized blank canvas is still unsigned');
  await h.ink();
  const bitmap = h.canvasState(canvas), beforeStrokes = bitmap.strokes;
  canvas.getBoundingClientRect = () => ({ width: 600, height: 320, left: 0, top: 0 });
  h.context.dispatchEvent(new h.context.Event('resize'));
  assert.equal(bitmap.strokes, beforeStrokes + 1, 'The cleared bitmap is redrawn from saved strokes');
  assert.deepEqual(bitmap.points.slice(-2), [['move', 20, 20], ['line', 40, 40]], 'Signature geometry scales with the new canvas');
  assert.equal(bitmap.ink, true);
  assert.equal(button.disabled, false);
  await button.emit('click'); await tick();
  const signature = h.writes().find(call => call.name === 'portal_confirm_job');
  assert.equal(signature.payload.p_signature, 'data:image/png;base64,c3ludGhldGlj', 'The submission contains ink, not the resized blank bitmap');
});

test('cleared signatures stay blank after resizing and detached canvases stop receiving resize writes', async () => {
  const h = harness();
  await h.render(); await h.ink();
  const canvas = h.element('pecPortalSig'), button = h.element('pecSigConfirm');
  await h.element('pecSigClear').emit('click');
  h.context.dispatchEvent(new h.context.Event('resize'));
  assert.equal(h.canvasState(canvas).ink, false);
  assert.equal(button.disabled, true);
  await button.emit('click');
  assert.equal(h.writes().length, 0);
  await h.renderHome();
  const fillCount = h.canvasState(canvas).fills;
  h.context.dispatchEvent(new h.context.Event('resize'));
  assert.equal(h.canvasState(canvas).fills, fillCount, 'Navigation removed the detached canvas resize listener');
});

test('signed estimate link still shows the existing read-only contract and deposit payment action', () => {
  const response = estimatePage({
    id: 'synthetic-estimate', status: 'accepted', public_token: signedEstimate.public_token,
    signed_name: signedEstimate.signed_name, signed_at: signedEstimate.signed_at,
    price: 2000, line_items: [{ label: 'Garage', description: 'Prepare and coat floor', qty: 1, total: 2000 }],
  }, {}, { acceptedPay: { url: '/pay/synthetic-token', amount: 500, isDeposit: true } });
  assert.match(response.body, /Accepted and signed/);
  assert.match(response.body, /href="\/pay\/synthetic-token"/);
  assert.doesNotMatch(response.body, /id="goAccept"|id="openAccept"/);
});

test('staff external contract acceptance blocks signatures while preserving separate color confirmation', async () => {
  const h = harness({ type: 'epoxy', estimate_signature: { acceptance_method: 'staff_external_contract', accepted_at: '2026-09-20T07:00:00Z', signed_at: null } }, catalog);
  await h.render();
  assert.match(h.root.textContent, /Accepted under your contract/);
  assert.doesNotMatch(h.root.textContent, /Your signed estimate/);
  assert.equal(h.root.querySelector('canvas'), null);
  assert.ok(h.root.textContent.includes('Choose your colors'));
  assert.equal(h.writes().length, 0);
});
