'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { estimatePage } = require('../netlify/functions/pec-public-estimate.cjs')._internals;

// Exercise the shipped portal renderer and its real event handlers with only
// synthetic token-scoped responses. No customer records or network writes.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('function portalFootHtml(company) {');
const end = html.indexOf('\nasync function portalReferralForm(', start);
assert.ok(start >= 0 && end > start, 'Portal source boundaries exist');
const source = html.slice(start, end);
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
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
  };
  const ids = new Map(), calls = [], alerts = [];
  let rendered = '', grids = [], beforeRpc = async () => {};
  function node(id = '') {
    const listeners = new Map();
    return {
      id, style: {}, dataset: {}, disabled: false, textContent: '',
      addEventListener(event, callback) { listeners.set(event, callback); },
      async emit(event, values = {}) {
        return listeners.get(event)?.({ clientX: 10, clientY: 10, preventDefault() {}, ...values });
      },
      getBoundingClientRect: () => ({ width: 300, height: 160, left: 0, top: 0 }),
      getContext: () => ({ scale() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} }),
      toDataURL: () => 'data:image/png;base64,c3ludGhldGlj',
      removeAttribute(name) { if (name === 'data-sel') delete this.dataset.sel; },
      setAttribute(name, value) { if (name === 'data-sel') this.dataset.sel = value; },
    };
  }
  let back = node();
  const root = {
    style: {},
    get innerHTML() { return rendered; },
    set innerHTML(value) {
      rendered = value;
      ids.clear();
      for (const match of value.matchAll(/\bid="([^"]+)"/g)) {
        const element = node(match[1]);
        element.disabled = new RegExp(`id="${match[1]}"[^>]*\\bdisabled`).test(value);
        ids.set(match[1], element);
      }
      back = node();
      grids = value.includes('data-pick-grid') ? (catalogData?.areas || []).flatMap(area => area.slots.map(slot => {
        const grid = node();
        grid.dataset = { area: area.id, slot: slot.recipe_slot_id };
        grid.options = slot.options.map(option => {
          const swatch = node();
          swatch.dataset.prod = option.product_id;
          if (slot.selected_product_id === option.product_id) swatch.dataset.sel = '1';
          swatch.closest = selector => selector === '[data-prod]' ? swatch : null;
          return swatch;
        });
        grid.querySelector = () => grid.options.find(option => option.dataset.sel === '1') || null;
        grid.querySelectorAll = () => grid.options;
        return grid;
      })) : [];
    },
    contains(element) { return [...ids.values()].includes(element); },
    querySelector: selector => selector === 'a[href="#"]' ? back : null,
    querySelectorAll: selector => selector === '[data-pick-grid]' ? grids : [],
  };
  const query = new Proxy({}, { get: (_target, key) => key === 'then'
    ? (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject)
    : () => query });
  const context = vm.createContext({
    console, Promise, Map,
    $: id => id === 'customerPortalRoot' ? root : ids.get(id) || null,
    document: { getElementById: id => ids.get(id) || null, body: { classList: { toggle() {} } } },
    location: { hash: '#job/job-1' }, window: { addEventListener() {} }, devicePixelRatio: 1,
    esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    fmtDate: value => String(value ?? ''), fmtMoney: value => `$${value}`,
    alert: message => alerts.push(message),
    supabase: {
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
    },
  });
  vm.runInContext(source, context);
  return {
    root, latest, calls, alerts, context,
    render: () => context.portalJobDetail('synthetic-portal-token', 'job-1', clone(latest)),
    renderHome: () => { context.location.hash = ''; return context.renderCustomerPortal('synthetic-portal-token'); },
    element: id => ids.get(id),
    beforeRpc(callback) { beforeRpc = callback; },
    writes: () => calls.filter(call => call.name.startsWith('portal_')),
    async ink() {
      const canvas = ids.get('pecPortalSig');
      assert.ok(canvas, 'An unsigned project has a canvas');
      await canvas.emit('pointerdown');
      await canvas.emit('pointermove', { clientX: 20, clientY: 20 });
      await canvas.emit('pointerup');
    },
    pick: () => grids[0].emit('click', { target: grids[0].options[0] }),
  };
}

test('accepted estimate is read-only even when legacy confirmed is false or signer name is absent', async () => {
  for (const signature of [signedEstimate, { ...signedEstimate, signed_name: null }]) {
    const h = harness({ estimate_signature: signature });
    await h.render();
    assert.match(h.root.innerHTML, /Your signed estimate/);
    assert.match(h.root.innerHTML, /href="\/e\/synthetic-estimate-token"/);
    assert.doesNotMatch(h.root.innerHTML, /pecPortalSig|pecSigConfirm|Sign your project/);
    assert.equal(h.writes().length, 0);
    await h.renderHome();
    assert.match(h.root.innerHTML, /Signed ✓/);
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
