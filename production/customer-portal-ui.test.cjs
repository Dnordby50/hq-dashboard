'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('../apps/estimator/node_modules/jsdom');

// Run the actual shipped portal in a real DOM, with synthetic API responses.
// JSDOM never loads remote assets and every fetch/RPC is intercepted here.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('function portalFootHtml(');
const end = html.indexOf('// Helpers\n', start);
assert.ok(start >= 0 && end > start, 'Customer portal source boundaries exist');
const source = html.slice(start, end);
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let n = 0; n < 8; n++) await tick(); }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  return {
    customer: { id: 'customer-1', name: 'Alex Example', company: 'prescott-epoxy' },
    brand: { business_name: 'Synthetic Coatings', phone: '9285550100', website: 'https://example.test', license_number: 'TEST123' },
    config: { referrals_enabled: true, reviews_enabled: true, google_review_url: 'https://g.page/r/synthetic/review', yelp_review_url: 'https://www.yelp.com/biz/synthetic-coatings' },
    referral_reward_amount: '50',
    jobs: [{ id: 'job-1', type: 'epoxy', status: 'scheduled', address: '123 Example Lane', package: 'Garage floor', price: 4200, confirmed: false, colors_confirmed: false,
      scheduled_dates: ['2026-10-05', '2026-10-06'], install_date: '2026-10-05',
      estimate_signature: { signed_name: 'Alex Example', signed_at: '2026-09-21T12:00:00Z', estimate_number: 100001, public_token: 'synthetic-accepted' },
    }],
    estimates: [
      { id: 'estimate-accepted', job_id: 'job-1', estimate_number: 100001, title: 'Garage floor', address: '123 Example Lane', status: 'accepted', price: 4200, sent_at: '2026-09-20T12:00:00Z', signed_at: '2026-09-21T12:00:00Z', signed_name: 'Alex Example', url: '/e/synthetic-accepted' },
      { id: 'estimate-sent', job_id: null, estimate_number: 100002, title: 'Patio option', address: '123 Example Lane', status: 'sent', price: 1800, sent_at: '2026-09-21T12:00:00Z', signed_at: null, signed_name: null, url: '/e/synthetic-sent' },
      { id: 'estimate-rejected', job_id: null, estimate_number: 99999, title: 'Previous proposal', address: '123 Example Lane', status: 'rejected', price: 1300, sent_at: '2026-07-01T12:00:00Z', signed_at: null, signed_name: null, url: '/e/synthetic-rejected' },
    ],
    invoices: [
      { id: 'invoice-due', job_id: 'job-1', invoice_number: 1001, title: 'Garage deposit', address: '123 Example Lane', total: 4200, paid_to_date: 1200, balance_remaining: 3000, amount_due: 600, due_later: 2400, pending_amount: 0, status: 'deposit_due', status_label: 'Deposit due', ask_label: 'Deposit', due_date: '2026-09-25', issued_at: '2026-09-21T12:00:00Z', url: '/pay/synthetic-due', can_pay: true, payments: [] },
      { id: 'invoice-processing', job_id: 'job-1', invoice_number: 1002, title: 'Payment processing', total: 1500, paid_to_date: 200, balance_remaining: 1300, amount_due: 0, due_later: 900, pending_amount: 400, status: 'processing', status_label: 'Processing', ask_label: 'Installment', due_date: null, issued_at: '2026-09-20T12:00:00Z', url: '/pay/synthetic-processing', can_pay: false, payments: [{ amount: 400, method: 'ACH', reference: null, received_date: '2026-09-21', status: 'pending' }] },
      { id: 'invoice-paid', job_id: 'job-1', invoice_number: 1000, title: 'Completed maintenance', total: 320, paid_to_date: 320, balance_remaining: 0, amount_due: 0, due_later: 0, pending_amount: 0, status: 'paid', status_label: 'Paid', ask_label: 'Invoice', due_date: null, issued_at: '2026-08-01T12:00:00Z', url: '/pay/synthetic-paid', can_pay: false, payments: [{ amount: 320, method: 'check', reference: 'TEST-1', received_date: '2026-08-05', status: 'received' }] },
    ],
    referrals: [{ id: 'referral-1', friend_name: 'Taylor Example', service_interest: 'epoxy', status: 'new', reward_amount: 50, paid_at: null, created_at: '2026-09-21T12:00:00Z' }],
  };
}


function harness(data = fixture()) {
  const dom = new JSDOM('<!doctype html><html><body class="pec-portal-mode"><main id="customerPortalRoot"></main></body></html>', {
    url: 'https://portal.test/?portal=synthetic-token#home', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  let latest = clone(data), beforeFetch = async () => null, beforeRpc = async () => null;
  const requests = [], rpcs = [], alerts = [];
  w.$ = id => w.document.getElementById(id);
  w.esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // The internal dashboard helper rounds whole dollars. Portal billing must
  // preserve cents independently instead of inheriting that display format.
  w.fmtMoney = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  w.fmtDate = value => value ? new Date(String(value).length === 10 ? value + 'T12:00:00Z' : value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/Phoenix' }) : '';
  w.alert = message => alerts.push(message);
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => ({ scale() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} });
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,c3ludGhldGlj';
  w.fetch = async (url, init = {}) => {
    const snapshot = clone(latest);
    requests.push({ url: String(url), init: clone(init) });
    const override = await beforeFetch(url, init, snapshot);
    return override || { ok: true, status: 200, json: async () => snapshot };
  };
  const query = new Proxy({}, { get: (_target, key) => key === 'then'
    ? (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject)
    : () => query });
  w.supabase = {
    from: () => query,
    async rpc(name, payload) {
      rpcs.push({ name, payload: clone(payload) });
      const override = await beforeRpc(name, payload);
      if (override) return override;
      if (name === 'get_portal_data') return { data: clone(latest), error: null };
      if (name === 'get_portal_job_catalog') return { data: { areas: [] }, error: null };
      if (name === 'portal_submit_referral') {
        const existing = latest.referrals.find(r => r.friend_name === payload.p_friend_name);
        if (!existing) latest.referrals.unshift({ id: 'new-referral', friend_name: payload.p_friend_name, service_interest: payload.p_service_interest, status: 'new', reward_amount: 50, paid_at: null, created_at: '2026-09-22T12:00:00Z' });
        return { data: existing?.id || 'new-referral', error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  new vm.Script(source, { filename: 'actual-customer-portal.js' }).runInContext(dom.getInternalVMContext());
  const root = w.$('customerPortalRoot');
  return {
    window: w, document: w.document, root, requests, rpcs, alerts,
    data: () => latest,
    replace(value) { latest = clone(value); },
    beforeFetch(callback) { beforeFetch = callback; },
    beforeRpc(callback) { beforeRpc = callback; },
    async render(route = 'home', token = 'synthetic-token') {
      w.history.replaceState(null, '', `?portal=${encodeURIComponent(token)}#${route}`);
      await w.renderCustomerPortal(token);
      await settle();
    },
    text: () => root.textContent.replace(/\s+/g, ' ').trim(),
    async submitReferral() {
      const form = w.$('pecPortalRef');
      assert.ok(form, 'The real referral form renders');
      form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await settle();
    },
    fillReferral() {
      const form = w.$('pecPortalRef');
      form.elements.namedItem('friend_name').value = 'Morgan Example';
      form.elements.namedItem('friend_phone').value = '9285550199';
      form.elements.namedItem('friend_email').value = 'morgan@example.test';
      form.elements.namedItem('service_interest').value = 'epoxy';
      const consent = form.querySelector('input[type="checkbox"]');
      if (consent) consent.checked = true;
    },
    close: () => dom.window.close(),
  };
}

test('portal loads through the token-scoped API and exposes all approved navigation destinations', async t => {
  const h = harness(); t.after(h.close);
  await h.render();
  assert.equal(h.requests[0].url, '/api/portal');
  assert.equal(h.requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(h.requests[0].init.body), { token: 'synthetic-token' });
  assert.doesNotMatch(h.requests[0].url, /synthetic-token/);
  for (const route of ['home', 'estimates', 'invoices', 'referrals', 'reviews']) assert.ok(h.root.querySelector(`a[href="#${route}"]`), route);
  assert.match(h.text(), /Alex/);
  assert.doesNotMatch(h.text(), /Timeline|Progress tracker/);
});

test('estimate history links to actual signed and unsigned documents without adding a second signature', async t => {
  const h = harness(); t.after(h.close);
  await h.render('estimates');
  for (const token of ['accepted', 'sent', 'rejected']) {
    const link = h.root.querySelector(`a[href="/e/synthetic-${token}"]`);
    assert.ok(link, `History includes ${token} estimate`);
    assert.equal(link.target, '_blank');
    assert.match(link.rel, /noopener/);
    assert.match(link.rel, /noreferrer/);
  }
  assert.match(h.text(), /100001|EST-100001/);
  assert.match(h.text(), /100002|EST-100002/);
  assert.match(h.text(), /Signed|Accepted/);
  assert.equal(h.root.querySelector('#pecPortalSig'), null);
  assert.equal(h.root.querySelector('#pecSigConfirm'), null);
});

test('estimate filters retain signed history and keep signature actions on unsigned quotes only', async t => {
  const h = harness(); t.after(h.close);
  await h.render('estimates');
  h.root.querySelector('[data-estimate-filter="signed"]').click();
  assert.ok(h.root.querySelector('a[href="/e/synthetic-accepted"]'));
  assert.equal(h.root.querySelector('a[href="/e/synthetic-sent"]'), null);
  assert.equal(h.root.querySelector('a[href="/e/synthetic-rejected"]'), null);
  assert.equal(h.root.querySelector('a[href="/e/synthetic-accepted"]').textContent, 'View signed estimate');
  h.root.querySelector('[data-estimate-filter="sent"]').click();
  assert.ok(h.root.querySelector('a[href="/e/synthetic-sent"]'));
  assert.equal(h.root.querySelector('a[href="/e/synthetic-accepted"]'), null);
  assert.match(h.root.querySelector('a[href="/e/synthetic-sent"]').textContent, /sign/i);
  h.root.querySelector('[data-estimate-filter="archived"]').click();
  assert.ok(h.root.querySelector('a[href="/e/synthetic-rejected"]'));
  assert.doesNotMatch(h.root.querySelector('a[href="/e/synthetic-rejected"]').textContent, /sign/i);
});

test('an unselected choice estimate shows Select an option in Home and Estimates without a provisional amount', async t => {
  const data = fixture();
  data.jobs = [];
  data.invoices = [];
  data.estimates = [{ ...data.estimates[1], title: 'Choose your patio scope', needs_choice: true, price: null }];
  const h = harness(data); t.after(h.close);
  for (const route of ['home', 'estimates']) {
    await h.render(route);
    assert.match(h.text(), /Choose your patio scope/);
    assert.match(h.text(), /Select an option/);
    assert.doesNotMatch(h.text(), /\$0(?:\.00)?|\$1,800|\$4,200/);
    assert.ok(h.root.querySelector('a[href="/e/synthetic-sent"]'), 'Selection happens on the real estimate document');
  }
});

test('invoice display keeps currently due, remaining balance, future amount and pending payments distinct', async t => {
  const h = harness(); t.after(h.close);
  await h.render('invoices');
  const text = h.text();
  assert.match(text, /Amount currently due\s*\$600\.00/i);
  assert.match(text, /\$3,000\.00/);
  assert.match(text, /\$2,400\.00/);
  assert.match(text, /\$400\.00/);
  assert.match(text, /Processing|Pending/i);
  assert.match(text, /Paid/);
  for (const token of ['due', 'processing', 'paid']) assert.ok(h.root.querySelector(`a[href="/pay/synthetic-${token}"]`));
  const processing = h.root.querySelector('a[href="/pay/synthetic-processing"]');
  assert.doesNotMatch(processing.textContent, /Pay now|Review & pay/);
  assert.doesNotMatch(text, /Amount currently due\s*\$(?:4,300|3,000|7,500)/i);
});

test('portal billing retains cents even though the staff dashboard money formatter rounds whole dollars', async t => {
  const data = fixture();
  data.invoices = [{ ...data.invoices[0], total: 4200.12, paid_to_date: 1200, balance_remaining: 3000.12, amount_due: 600.37, due_later: 2399.75 }];
  const h = harness(data); t.after(h.close);
  await h.render('invoices');
  assert.match(h.text(), /Amount currently due\s*\$600\.37/);
  assert.match(h.text(), /\$4,200\.12/);
  assert.match(h.text(), /\$3,000\.12/);
  assert.match(h.text(), /\$2,399\.75/);
  await h.render('home');
  assert.match(h.text(), /\$600\.37/);
});

test('home and project details show actual scheduled dates and an honest unscheduled state', async t => {
  const h = harness(); t.after(h.close);
  await h.render('job/job-1');
  assert.match(h.text(), /Oct(?:ober)?[^\n]{0,25}5/);
  assert.match(h.text(), /(?:Oct(?:ober)?[^\n]{0,25})?6(?:,|\s|$)/);
  assert.doesNotMatch(h.text(), /Timeline|Estimate signed.*Installation scheduled/);
  h.data().jobs[0].scheduled_dates = [];
  h.data().jobs[0].install_date = null;
  await h.render('job/job-1');
  assert.match(h.text(), /not scheduled|date to be confirmed|schedule.*confirm|dates.*confirm/i);
  assert.doesNotMatch(h.text(), /Oct(?:ober)?[^\n]{0,25}5/);
});

test('review links use configured destinations and disappear when absent or disabled', async t => {
  const h = harness(); t.after(h.close);
  await h.render('reviews');
  assert.ok(h.root.querySelector('a[href="https://g.page/r/synthetic/review"]'));
  assert.ok(h.root.querySelector('a[href="https://www.yelp.com/biz/synthetic-coatings"]'));
  assert.equal(h.root.querySelector('.pec-stars'), null, 'No rating gate before public review links');
  h.data().config.yelp_review_url = '';
  await h.render('reviews');
  assert.equal(h.root.querySelector('a[href*="yelp.com"]'), null);
  h.data().config.reviews_enabled = false;
  await h.render('reviews');
  assert.equal(h.root.querySelector('a[href*="g.page"]'), null);
  assert.equal(h.root.querySelector('a[href="#reviews"]'), null);
});

test('company contact and review options do not borrow another company defaults', async t => {
  const data = fixture();
  data.customer.company = 'finishing-touch';
  data.brand = { business_name: 'Synthetic Painting', phone: '', website: '', logo_url: '', license_number: '' };
  data.config.google_review_url = '';
  data.config.yelp_review_url = '';
  const h = harness(data); t.after(h.close);
  await h.render('reviews');
  assert.match(h.text(), /Synthetic Painting/);
  assert.doesNotMatch(h.text(), /Prescott Epoxy|ROC353243/);
  assert.equal(h.root.querySelector('a[href^="tel:"]'), null);
  assert.equal(h.root.querySelector('a[href*="yelp.com"],a[href*="g.page"]'), null);
});

test('untrusted customer content and unsafe action URLs cannot introduce executable markup', async t => {
  const data = fixture();
  data.customer.name = '<img src=x onerror=alert(1)>';
  data.estimates[0].title = '<svg onload=alert(2)>';
  data.estimates[0].url = 'javascript:alert(3)';
  data.config.google_review_url = 'javascript:alert(4)';
  const h = harness(data); t.after(h.close);
  await h.render('estimates');
  assert.equal(h.root.querySelector('[onerror],[onload],a[href^="javascript:"]'), null);
  await h.render('reviews');
  assert.equal(h.root.querySelector('a[href^="javascript:"]'), null);
});

test('referral submission preserves contact draft after failure and uses the actual scoped RPC', async t => {
  const h = harness(); t.after(h.close);
  await h.render('referrals');
  assert.match(h.text(), /Taylor Example/);
  h.fillReferral();
  h.beforeRpc(async name => name === 'portal_submit_referral' ? { error: { message: 'Synthetic save failed' }, data: null } : null);
  await h.submitReferral();
  const form = h.window.$('pecPortalRef');
  assert.equal(form.elements.namedItem('friend_name').value, 'Morgan Example');
  assert.equal(form.elements.namedItem('friend_phone').value, '9285550199');
  assert.equal(form.elements.namedItem('friend_email').value, 'morgan@example.test');
  assert.match(h.window.$('pecPortalRefError').textContent, /Synthetic save failed/);
  const call = h.rpcs.find(row => row.name === 'portal_submit_referral');
  assert.ok(call);
  assert.equal(call.payload.p_token, 'synthetic-token');
  assert.equal(call.payload.p_friend_name, 'Morgan Example');
  assert.equal(h.window.$('pecPortalRefSubmit').disabled, false);
});

test('repeated referral submit events share one pending write and produce one success', async t => {
  const h = harness(); t.after(h.close);
  await h.render('referrals'); h.fillReferral();
  const entered = deferred(), release = deferred();
  h.beforeRpc(async name => {
    if (name === 'portal_submit_referral') { entered.resolve(); await release.promise; }
  });
  const first = h.submitReferral();
  await entered.promise;
  await h.submitReferral();
  assert.equal(h.rpcs.filter(row => row.name === 'portal_submit_referral').length, 1);
  assert.equal(h.window.$('pecPortalRefSubmit').disabled, true);
  release.resolve(); await first; await settle();
  assert.equal(h.data().referrals.filter(row => row.friend_name === 'Morgan Example').length, 1);
  assert.ok(h.window.$('pecPortalRefSuccess'));
  assert.match(h.text(), /Thank|received|submitted|sent/i);
});

test('referral draft survives navigation and clears after submitting a restored draft', async t => {
  const h = harness(); t.after(h.close);
  await h.render('referrals'); h.fillReferral();
  await h.render('invoices');
  await h.render('referrals');
  assert.equal(h.window.$('pecPortalRef').elements.namedItem('friend_name').value, 'Morgan Example');
  await h.submitReferral();
  assert.equal(h.window.$('pecPortalRef').elements.namedItem('friend_name').value, '');
  assert.equal(h.window.$('pecPortalRef').elements.namedItem('friend_phone').value, '');
  assert.equal(h.window.$('pecPortalRef').elements.namedItem('friend_email').value, '');
  assert.match(h.text(), /Morgan Example/);
});

test('uncertain referral result or missing receipt preserves the draft and blocks unverified repeat submissions', async t => {
  for (const missingReceipt of [false, true]) {
    const h = harness(); t.after(h.close);
    await h.render('referrals'); h.fillReferral();
    h.beforeRpc(async name => {
      if (name !== 'portal_submit_referral') return null;
      if (missingReceipt) return { data: null, error: null };
      throw new Error('Network connection interrupted');
    });
    await h.submitReferral(); await h.submitReferral();
    assert.equal(h.rpcs.filter(row => row.name === 'portal_submit_referral').length, 1);
    assert.equal(h.window.$('pecPortalRef').elements.namedItem('friend_name').value, 'Morgan Example');
    assert.equal(h.window.$('pecPortalRefSubmit').disabled, true);
    assert.match(h.window.$('pecPortalRefError').textContent, /could not confirm|check.*history|contact.*office/i);
    assert.equal(h.window.$('pecPortalRefSuccess').textContent, '', 'A missing receipt cannot claim submission');
  }
});

test('a referral result cannot replace another route and one token cannot inherit another token draft', async t => {
  const h = harness(); t.after(h.close);
  await h.render('referrals', 'customer-token-one'); h.fillReferral();
  const entered = deferred(), release = deferred();
  h.beforeRpc(async name => {
    if (name === 'portal_submit_referral') { entered.resolve(); await release.promise; }
  });
  const pending = h.submitReferral();
  await entered.promise;
  await h.render('invoices', 'customer-token-one');
  release.resolve(); await pending;
  assert.match(h.text(), /Amount currently due/);
  assert.equal(h.window.$('pecPortalRef'), null);
  await h.render('referrals', 'customer-token-two');
  assert.equal(h.window.$('pecPortalRef').elements.namedItem('friend_name').value, '');
  assert.equal(h.window.$('pecPortalRefSubmit').disabled, false);
});

test('returning to a pending referral form resolves its sending state on success or a definite failure', async t => {
  for (const fail of [false, true]) {
    const h = harness(); t.after(h.close);
    await h.render('referrals'); h.fillReferral();
    const entered = deferred(), release = deferred();
    h.beforeRpc(async name => {
      if (name === 'portal_submit_referral') {
        entered.resolve(); await release.promise;
        if (fail) return { data: null, error: { message: 'Synthetic validation failed' } };
      }
    });
    const pending = h.submitReferral();
    await entered.promise;
    await h.render('invoices'); await h.render('referrals');
    assert.equal(h.window.$('pecPortalRefSubmit').disabled, true);
    release.resolve(); await pending; await settle();
    assert.equal(h.window.$('pecPortalRefSubmit').disabled, false);
    assert.doesNotMatch(h.window.$('pecPortalRefSubmit').textContent, /Sending/);
    assert.equal(h.window.$('pecPortalRef').elements.namedItem('friend_name').value, fail ? 'Morgan Example' : '');
    if (fail) assert.match(h.window.$('pecPortalRefError').textContent, /Synthetic validation failed/);
    else assert.match(h.window.$('pecPortalRefSuccess').textContent, /submitted/);
    assert.equal(h.rpcs.filter(row => row.name === 'portal_submit_referral').length, 1);
  }
});

test('edits made to a returned referral form while the prior introduction saves remain available', async t => {
  const h = harness(); t.after(h.close);
  await h.render('referrals'); h.fillReferral();
  const entered = deferred(), release = deferred();
  h.beforeRpc(async name => {
    if (name === 'portal_submit_referral') { entered.resolve(); await release.promise; }
  });
  const pending = h.submitReferral();
  await entered.promise;
  await h.render('invoices'); await h.render('referrals');
  const form = h.window.$('pecPortalRef');
  form.elements.namedItem('friend_name').value = 'Second Friend';
  form.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  release.resolve(); await pending; await settle();
  assert.equal(h.window.$('pecPortalRef').elements.namedItem('friend_name').value, 'Second Friend');
  assert.equal(h.window.$('pecPortalRefSubmit').disabled, false);
  assert.equal(h.data().referrals.filter(row => row.friend_name === 'Morgan Example').length, 1);
  assert.equal(h.data().referrals.filter(row => row.friend_name === 'Second Friend').length, 0);
});

test('a detached estimate filter cannot restore stale history over a newer route', async t => {
  const h = harness(); t.after(h.close);
  await h.render('estimates');
  const oldFilter = h.root.querySelector('[data-estimate-filter="signed"]');
  await h.render('invoices');
  oldFilter.click();
  assert.match(h.text(), /Amount currently due/);
  assert.equal(h.root.querySelector('[data-estimate-filter]'), null);
});

test('older portal responses cannot replace a newer route or a different customer token', async t => {
  const h = harness(); t.after(h.close);
  const entered = deferred(), release = deferred();
  let pauseFirst = true;
  h.beforeFetch(async () => {
    if (pauseFirst) { pauseFirst = false; entered.resolve(); await release.promise; }
  });
  const first = h.render('home', 'synthetic-old-token');
  await entered.promise;
  h.data().customer.name = 'New Customer';
  h.data().estimates[0].title = 'Current customer estimate';
  await h.render('estimates', 'synthetic-new-token');
  release.resolve(); await first;
  assert.match(h.text(), /Current customer estimate/);
  assert.doesNotMatch(h.text(), /Alex Example/);
  assert.match(h.window.location.hash, /estimates/);
  assert.deepEqual(h.requests.map(request => JSON.parse(request.init.body).token), ['synthetic-old-token', 'synthetic-new-token']);
});

test('an API error displays a retryable error instead of inventing empty history or zero due', async t => {
  const h = harness(); t.after(h.close);
  h.beforeFetch(async () => ({ ok: false, status: 503, json: async () => ({ error: 'Synthetic portal unavailable' }) }));
  await h.render('invoices');
  assert.match(h.text(), /unavailable|could not|try again/i);
  assert.doesNotMatch(h.text(), /Amount currently due\s*\$0|No invoices/);
});

test('a failed partial refresh replaces stale invoice totals with an error and retains navigation', async t => {
  const h = harness(); t.after(h.close);
  await h.render('invoices');
  assert.match(h.text(), /Amount currently due\s*\$600\.00/i);
  h.beforeFetch(async () => ({ ok: false, status: 503, json: async () => ({ customer: clone(h.data().customer), estimates: clone(h.data().estimates), error: 'Invoice information unavailable' }) }));
  await h.render('invoices');
  assert.match(h.text(), /Invoice information unavailable/);
  assert.ok(h.root.querySelector('a[href="#estimates"]'));
  assert.ok(h.root.querySelector('#pecPortalRetry'));
  assert.doesNotMatch(h.text(), /Amount currently due|No invoices|\$0\.00|\$600\.00/i);
});

test('an incomplete success payload cannot turn missing invoice information into zero due', async t => {
  const h = harness(); t.after(h.close);
  const incomplete = fixture();
  delete incomplete.invoices;
  h.beforeFetch(async () => ({ ok: true, status: 200, json: async () => incomplete }));
  await h.render('invoices');
  assert.ok(h.root.querySelector('#pecPortalRetry'), 'Incomplete API responses must be retryable errors');
  assert.doesNotMatch(h.text(), /Amount currently due|No invoices|no shared invoices|\$0\.00/i);
});

test('missing or invalid financial amounts fail closed instead of becoming zero', async t => {
  for (const [field, value] of [['amount_due', null], ['paid_to_date', 'unavailable']]) {
    const data = fixture(); data.invoices[0][field] = value;
    const h = harness(data); t.after(h.close);
    await h.render('invoices');
    assert.ok(h.root.querySelector('#pecPortalRetry'), `Invalid ${field} shows an error`);
    assert.doesNotMatch(h.text(), /Amount currently due|\$0\.00/i);
  }
});

test('returning from a document refreshes signed and paid status without replacing active forms', async t => {
  const h = harness(); t.after(h.close);
  await h.render('estimates');
  const updated = h.data();
  updated.estimates[1].status = 'accepted';
  updated.estimates[1].signed_at = '2026-09-22T15:00:00Z';
  await h.window.portalRefreshAfterDocument('synthetic-token');
  assert.equal(h.root.querySelector('a[href="/e/synthetic-sent"]').textContent, 'View signed estimate');
  const count = h.requests.length;
  await h.window.portalRefreshAfterDocument('synthetic-token');
  assert.equal(h.requests.length, count, 'Focus and visibility events coalesce');
  await h.render('invoices');
  h.data().invoices[0].amount_due = 0;
  h.data().invoices[0].can_pay = false;
  h.data().invoices[0].status = 'paid';
  h.window.Date.now = () => Date.now() + 1100;
  await h.window.portalRefreshAfterDocument('synthetic-token');
  assert.equal(h.root.querySelector('a[href="/pay/synthetic-due"]').textContent, 'View receipt');
  await h.render('referrals'); h.fillReferral();
  const form = h.window.$('pecPortalRef'), requests = h.requests.length;
  await h.window.portalRefreshAfterDocument('synthetic-token');
  assert.equal(h.window.$('pecPortalRef'), form);
  assert.equal(h.requests.length, requests);
  assert.equal(form.elements.namedItem('friend_name').value, 'Morgan Example');
  await h.window.portalRefreshAfterDocument('another-token');
  assert.equal(h.requests.length, requests);
});
