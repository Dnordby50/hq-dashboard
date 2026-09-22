'use strict';

// Synthetic service-role REST fixtures; no live data or customer mutations.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, invoiceSummary } = require('../netlify/functions/pec-customer-portal.cjs');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOKEN = 'a'.repeat(64);
const NOW = new Date('2026-09-22T16:00:00Z');
const event = (token = TOKEN) => ({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '192.0.2.1' }, body: JSON.stringify({ token, customer_id: id(2), job_id: id(999), amount: 0 }) });
const decodeLiteral = value => value.startsWith('"') ? JSON.parse(value) : value;
function matches(row, key, filter) {
  if (filter === 'is.null') return row[key] == null;
  if (filter === 'not.is.null') return row[key] != null;
  if (filter.startsWith('eq.')) return String(row[key]) === decodeLiteral(filter.slice(3));
  if (filter.startsWith('in.(')) return (filter.slice(4, -1).match(/"(?:\\.|[^"\\])*"|[^,]+/g) || []).map(decodeLiteral).includes(String(row[key]));
  throw new Error('Unhandled fixture filter: ' + key + ' ' + filter);
}
function fixture(options = {}) {
  const job = { id: id(10), customer_id: id(1), archived_at: null, voided_at: null, dripjobs_deal_id: 'deal-one', public_token_revoked_at: null, package: 'Garage floor', address: '10 Fixture Lane' };
  const bundleJob = { id: id(10), type: 'epoxy', status: 'signed', address: '10 Fixture Lane', package: 'Garage floor', price: 4000, confirmed: false, colors_confirmed: false,
    crew_notes: 'PRIVATE CREW NOTES', timeline: [{ id: id(80), stage_name: 'Scheduled', status: 'pending', sort_order: 1, private_note: 'PRIVATE TIMELINE' }],
    photos: [{ id: id(81), url: 'https://images.invalid/project.jpg', caption: 'Your floor', internal_tag: 'PRIVATE PHOTO' }],
    colors: [{ id: id(82), name: 'Orbit', label: 'Flake', hex: '#abcdef', sku: 'ORB', unit_cost: 99 }],
    review: { id: id(83), rating: 5, feedback: 'Looks good', matched_by: 'PRIVATE REVIEW STAFF' },
    estimate_signature: { estimate_number: 1001, signed_name: 'Fixture Customer', signed_at: '2026-09-20T16:00:00Z', public_token: id(300) },
  };
  const defaultBundle = { customer: { id: id(1), name: 'Fixture Customer', company: options.company || 'prescott-epoxy', phone: '9285550100', token: TOKEN, stripe_customer_id: 'PRIVATE STRIPE' },
    jobs: [bundleJob], referral_reward_amount: '50' };
  const tables = {
    jobs: [job], leads: [{ id: id(20), customer_id: id(1), deleted_at: null }],
    estimates: [{ id: id(30), customer_id: id(1), job_id: id(10), lead_id: id(20), estimate_number: 1001, status: 'accepted', sent_at: '2026-09-19T16:00:00Z', signed_at: '2026-09-20T16:00:00Z', signed_name: 'Fixture Customer', public_token: id(300), price: 4000, deleted_at: null, pec_prod_job_id: id(60), customer_address: '10 Fixture Lane', gp_pct: 99, company_notes: 'PRIVATE ESTIMATE', signed_ip: 'PRIVATE IP' }],
    estimate_line_items: [],
    pec_prod_jobs: [{ id: id(60), crm_job_id: id(10), customer_id: id(1), dripjobs_deal_id: 'deal-one', install_date: '2026-09-25', archived_at: null, is_callback: false, notes: 'PRIVATE PRODUCTION' }],
    pec_prod_job_schedule_days: [{ id: id(70), job_id: id(60), scheduled_date: '2026-09-25', notes: 'PRIVATE SCHEDULE' }, { id: id(71), job_id: id(60), scheduled_date: '2026-09-26' }],
    pec_job_ar: [{ id: id(10), customer_id: id(1), status: 'signed', address: '10 Fixture Lane', price: 4000, paid_to_date: 1000, balance_remaining: 3000, hq_invoice_number: '2001', public_token: id(400), invoice_first_sent_at: '2026-09-20T18:00:00Z', deposit_amount: 2000, deposit_collected: false, deposit_waived: false, invoice_due_date: '2026-09-24', salesperson: 'PRIVATE SALES' }],
    pec_invoice_installments: [{ id: id(50), job_id: id(10), seq: 0, label: 'Deposit', computed_amount: 2000, trigger_kind: 'on_acceptance', status: 'sent', is_deposit: true, sent_at: '2026-09-20T18:00:00Z', created_at: '2026-09-20T18:00:00Z', note: 'PRIVATE PAYMENT NOTE' },
      { id: id(51), job_id: id(10), seq: 1, label: 'At completion', computed_amount: 2000, trigger_kind: 'on_completion', status: 'planned', is_deposit: false }],
    pec_payments: [{ id: id(40), job_id: id(10), amount: 1000, method: 'check', reference: '123', received_date: '2026-09-21', notes: 'PRIVATE LEDGER', recorded_by: 'PRIVATE STAFF' }],
    pec_stripe_pending: [],
    referrals: [{ id: id(90), customer_id: id(1), friend_name: 'Fixture Friend', friend_email: 'PRIVATE FRIEND EMAIL', friend_phone: 'PRIVATE FRIEND PHONE', service_interest: 'epoxy', status: 'booked', payment_amount: 50, created_at: '2026-09-21T16:00:00Z' }],
    settings: [{ key: 'google_review_link_epoxy', value: 'https://search.google.com/local/writereview?placeid=synthetic' }, { key: 'google_review_link_paint', value: 'https://g.page/r/synthetic-paint/review' }, { key: 'portal_yelp_link_epoxy', value: 'https://www.yelp.com/biz/synthetic-epoxy' }, { key: 'unrelated_secret', value: 'PRIVATE SETTINGS' }],
    pec_brand_identity: [{ brand: 'prescott-epoxy', business_name: 'Fixture Epoxy', phone: '9285550123', website: 'https://example.invalid/', primary_color: '#14181C', accent_color: '#D8531C', license_number: 'SYNTHETIC LICENSE', zelle_email: 'PRIVATE BILLING' }, { brand: 'finishing-touch', business_name: 'Fixture Painting', phone: '9285550456', website: 'https://paint.invalid/' }],
    ...options.tables,
  };
  const calls = [];
  const db = async (method, path, payload, opts) => {
    calls.push({ method, path, payload, opts });
    if (options.fail && path.startsWith(options.fail)) throw new Error('PRIVATE FAILURE ' + TOKEN);
    if (path === '/rpc/pec_take_rate_limit') return options.quota || { allowed: true, remaining: 119, retry_after: 0 };
    if (path === '/rpc/get_portal_data') return Object.hasOwn(options, 'bundle') ? options.bundle : defaultBundle;
    assert.equal(method, 'GET', 'portal must not mutate customer data');
    const url = new URL(path, 'https://database.invalid');
    const table = url.pathname.slice(1);
    assert.ok(Object.hasOwn(tables, table), table);
    let rows = tables[table].filter(row => [...url.searchParams].every(([key, value]) => ['select', 'order', 'limit', 'offset'].includes(key) || matches(row, key, value)));
    rows = rows.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || rows.length);
    // Intentionally retain extra fixture columns: output allowlists must
    // protect the response even if a provider unexpectedly returns more.
    return rows.slice(offset, offset + limit);
  };
  return { tables, bundle: defaultBundle, calls, handler: createHandler({ sb: db, now: () => NOW }) };
}
async function body(fx, request = event()) {
  const res = await fx.handler(request);
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body);
}

test('portal authenticates by token, applies persistent limits first, and returns private uncached responses', async () => {
  const fx = fixture(), res = await fx.handler(event());
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(res.headers['X-Robots-Tag'], 'noindex, nofollow');
  assert.ok(fx.calls.slice(0, 2).every(call => call.path === '/rpc/pec_take_rate_limit'));
  assert.deepEqual(fx.calls[2].payload, { p_token: TOKEN });
  assert.ok(fx.calls.slice(0, 2).every(call => /^[a-f0-9]{64}$/.test(call.payload.p_key) && call.payload.p_limit === 120));
  assert.ok(fx.calls.every(call => call.method === 'GET' || ['/rpc/get_portal_data', '/rpc/pec_take_rate_limit'].includes(call.path)));
  assert.ok(fx.calls.every(call => call.opts.timeoutMs === 8000));
});

test('invalid/missing tokens and malformed requests never read customer records', async () => {
  for (const request of [event('bad'), event(null), event('x'.repeat(129)), { httpMethod: 'GET' }, { ...event(), body: '{' }, { ...event(), body: 'x'.repeat(4097) }, { ...event(), httpMethod: 'DELETE' }]) {
    const fx = fixture(), res = await fx.handler(request);
    assert.ok([400, 404, 405].includes(res.statusCode));
    assert.equal(fx.calls.length, 0);
  }
  const fx = fixture({ bundle: null });
  assert.equal((await fx.handler(event())).statusCode, 404);
  assert.equal(fx.calls.filter(call => call.method === 'GET').length, 0);
});

test('GET and base64 POST retain the same token scope and ignore browser-selected identities', async () => {
  const normal = await body(fixture());
  assert.deepEqual(await body(fixture(), { httpMethod: 'GET', queryStringParameters: { token: TOKEN, customer_id: id(2) } }), normal);
  assert.deepEqual(await body(fixture(), { ...event(), body: Buffer.from(JSON.stringify({ token: TOKEN })).toString('base64'), isBase64Encoded: true }), normal);
  assert.equal(normal.customer.id, id(1));
});

test('quota exhaustion and quota failure fail before private reads', async () => {
  for (const options of [{ quota: { allowed: false, retry_after: 27, remaining: 0 } }, { quota: {} }, { fail: '/rpc/pec_take_rate_limit' }]) {
    const fx = fixture(options), res = await fx.handler(event());
    assert.ok([429, 503].includes(res.statusCode));
    if (res.statusCode === 429) assert.equal(res.headers['Retry-After'], '27');
    assert.ok(fx.calls.every(call => call.path === '/rpc/pec_take_rate_limit'));
    assert.ok(!res.body.includes(TOKEN));
  }
});

test('explicit response projections exclude internal fields and expose document tokens only as links', async () => {
  const out = await body(fixture());
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('PRIVATE'));
  for (const field of ['public_token', 'stripe_customer_id', 'unit_cost', 'gp_pct', 'signed_ip', 'customer_token', 'company_notes', 'friend_email', 'friend_phone', 'recorded_by', 'dripjobs_deal_id', 'pec_prod_job_id']) assert.ok(!serialized.includes('"' + field + '"'), field);
  assert.equal(out.estimates[0].url, '/e/' + id(300));
  assert.equal(out.jobs[0].estimate_signature.url, '/e/' + id(300));
  assert.equal(out.invoices[0].url, '/pay/' + id(400));
  assert.equal(out.referrals[0].friend_name, 'Fixture Friend');
});

test('estimate history includes only sent, undeleted exact or explicitly linked customer records', async () => {
  const fx = fixture();
  const est = fx.tables.estimates[0];
  fx.tables.estimates.push(
    { ...est, id: id(31), job_id: null, public_token: id(301), status: 'sent', signed_at: null },
    { ...est, id: id(32), customer_id: null, public_token: id(302) },
    { ...est, id: id(33), customer_id: null, job_id: null, public_token: id(303) },
    { ...est, id: id(34), sent_at: null, public_token: id(304) },
    { ...est, id: id(35), deleted_at: NOW.toISOString(), public_token: id(305) },
    { ...est, id: id(36), customer_id: id(2), public_token: id(306) },
    { ...est, id: id(37), customer_id: null, job_id: id(999), public_token: id(307) },
    { ...est, id: id(38), customer_id: null, job_id: null, lead_id: id(999), public_token: id(308) },
    { ...est, id: id(39), status: 'draft', sent_at: '2026-09-21T16:00:00Z', public_token: id(309), company_notes: 'UNSENT WORKING REVISION' },
  );
  const out = await body(fx);
  assert.deepEqual(new Set(out.estimates.map(row => row.id)), new Set([id(30), id(31), id(32), id(33)]));
  assert.equal(out.estimates.find(row => row.id === id(31)).job_id, null);
  assert.ok(!out.estimates.some(row => row.id === id(39)), 'reverted draft stays private even with its original sent_at');
});

test('archived, voided, foreign jobs and revoked invoices never enter the portal', async () => {
  const fx = fixture();
  for (const [n, patch] of [[11, { customer_id: id(2) }], [12, { archived_at: NOW.toISOString() }], [13, { voided_at: NOW.toISOString() }], [14, { public_token_revoked_at: NOW.toISOString() }]]) {
    fx.tables.jobs.push({ ...fx.tables.jobs[0], id: id(n), ...patch });
    fx.bundle.jobs.push({ ...fx.bundle.jobs[0], id: id(n) });
    fx.tables.pec_job_ar.push({ ...fx.tables.pec_job_ar[0], id: id(n), customer_id: patch.customer_id || id(1), public_token: id(400 + n) });
  }
  fx.tables.referrals.push({ ...fx.tables.referrals[0], id: id(91), customer_id: id(2) });
  const out = await body(fx);
  assert.deepEqual(out.jobs.map(row => row.id), [id(10), id(14)]);
  assert.deepEqual(out.invoices.map(row => row.id), [id(10)]);
  assert.deepEqual(out.referrals.map(row => row.id), [id(90)]);
});

test('legacy shared quotes retain ownership through archived jobs without exposing archived projects or invoices', async () => {
  const fx = fixture();
  fx.tables.jobs.push({ ...fx.tables.jobs[0], id: id(11), archived_at: NOW.toISOString() });
  fx.bundle.jobs.push({ ...fx.bundle.jobs[0], id: id(11) });
  fx.tables.estimates.push({ ...fx.tables.estimates[0], id: id(31), customer_id: null, job_id: id(11), lead_id: null, public_token: id(301) });
  fx.tables.pec_job_ar.push({ ...fx.tables.pec_job_ar[0], id: id(11), public_token: id(401) });
  const out = await body(fx);
  assert.ok(out.estimates.some(estimate => estimate.id === id(31)));
  assert.deepEqual(out.jobs.map(job => job.id), [id(10)]);
  assert.deepEqual(out.invoices.map(invoice => invoice.id), [id(10)]);
});

test('job signed receipts are rechecked for ownership and never link to an unsent document', async () => {
  const fx = fixture();
  fx.tables.estimates[0].customer_id = id(2);
  assert.equal((await body(fx)).jobs[0].estimate_signature, null, 'legacy RPC receipt cannot bypass explicit estimate ownership');
  fx.tables.estimates[0].customer_id = id(1);
  fx.tables.estimates[0].sent_at = null;
  const out = await body(fx);
  assert.equal(out.jobs[0].estimate_signature.signed_name, 'Fixture Customer');
  assert.equal(out.jobs[0].estimate_signature.url, null);
  assert.deepEqual(out.estimates, []);
});

test('unpicked choice estimates show no provisional price; valid picks and accepted quotes keep their saved price', async () => {
  const fx = fixture();
  fx.tables.estimates[0].status = 'sent';
  fx.tables.estimate_line_items = [{ id: id(500), estimate_id: id(30), choice_group: 'group-1', unit_cost: 99 }];
  let estimate = (await body(fx)).estimates[0];
  assert.equal(estimate.needs_choice, true);
  assert.equal(estimate.price, null);
  fx.tables.estimates[0].choice_picked_line_id = id(501);
  assert.equal((await body(fx)).estimates[0].needs_choice, true, 'stale choice ID is not a valid pick');
  fx.tables.estimates[0].choice_picked_line_id = id(500);
  estimate = (await body(fx)).estimates[0];
  assert.equal(estimate.needs_choice, false);
  assert.equal(estimate.price, 4000);
  fx.tables.estimates[0].choice_picked_line_id = null;
  fx.tables.estimates[0].status = 'accepted';
  assert.equal((await body(fx)).estimates[0].price, 4000);
});

test('native multi-day schedule outranks a conflicting legacy deal and excludes notes', async () => {
  const fx = fixture();
  fx.tables.pec_prod_jobs[0].dripjobs_deal_id = null;
  fx.tables.pec_prod_jobs[0].install_date = null;
  fx.tables.pec_prod_jobs.push({ id: id(61), customer_id: id(1), dripjobs_deal_id: 'deal-one', install_date: '2026-10-10', crm_job_id: null });
  const out = await body(fx);
  assert.deepEqual(out.jobs[0].scheduled_dates, ['2026-09-25', '2026-09-26']);
  assert.equal(out.jobs[0].install_date, '2026-09-25');
  assert.equal(out.jobs[0].schedule_status, 'scheduled');
});

test('estimate production pointer and unique legacy deal are valid schedule fallbacks', async () => {
  for (const mode of ['estimate', 'deal']) {
    const fx = fixture();
    fx.tables.pec_prod_jobs[0].crm_job_id = null;
    if (mode === 'estimate') fx.tables.pec_prod_jobs[0].dripjobs_deal_id = null;
    else fx.tables.estimates[0].pec_prod_job_id = null;
    fx.tables.pec_prod_job_schedule_days = [];
    const out = await body(fx);
    assert.deepEqual(out.jobs[0].scheduled_dates, ['2026-09-25']);
  }
});

test('ambiguous, cross-customer, archived, callback or explicitly separate schedule bridges are not published', async () => {
  for (const patch of [{ customer_id: id(2) }, { archived_at: NOW.toISOString() }, { is_callback: true }, { crm_job_id: id(999) }, { crm_job_id: null, crm_link_declined: true }]) {
    const fx = fixture();
    Object.assign(fx.tables.pec_prod_jobs[0], patch);
    const out = await body(fx);
    assert.deepEqual(out.jobs[0].scheduled_dates, []);
  }
  const fx = fixture();
  fx.tables.pec_prod_jobs[0].crm_job_id = null;
  fx.tables.estimates[0].pec_prod_job_id = null;
  fx.tables.pec_prod_jobs.push({ ...fx.tables.pec_prod_jobs[0], id: id(61), install_date: '2026-09-30' });
  assert.deepEqual((await body(fx)).jobs[0].scheduled_dates, []);
});

test('PostgREST punctuation in legacy deal IDs stays one quoted literal', async () => {
  const fx = fixture(), value = 'deal,crm_job_id.eq."other"\\test';
  fx.tables.jobs[0].dripjobs_deal_id = value;
  fx.tables.estimates[0].pec_prod_job_id = null;
  Object.assign(fx.tables.pec_prod_jobs[0], { crm_job_id: null, dripjobs_deal_id: value });
  assert.deepEqual((await body(fx)).jobs[0].scheduled_dates, ['2026-09-25', '2026-09-26']);
  const request = fx.calls.find(call => call.path.startsWith('/pec_prod_jobs?dripjobs_deal_id='));
  assert.equal(new URL(request.path, 'https://database.invalid').searchParams.get('dripjobs_deal_id'), 'in.("deal,crm_job_id.eq.\\"other\\"\\\\test")');
});

test('invoice due uses the shared installment ask and pending ACH, not full contract balance', async () => {
  const fx = fixture();
  fx.tables.pec_stripe_pending.push({ id: id(95), job_id: id(10), amount: 1000, status: 'pending', created_at: '2026-09-22T10:00:00Z', payment_intent: 'PRIVATE STRIPE INTENT' });
  const invoice = (await body(fx)).invoices[0];
  assert.equal(invoice.balance_remaining, 3000);
  assert.equal(invoice.amount_due, 0);
  assert.equal(invoice.due_later, 2000);
  assert.equal(invoice.pending_amount, 1000);
  assert.equal(invoice.status, 'processing');
  assert.equal(invoice.can_pay, false);
  assert.equal(invoice.payments[1].status, 'pending');
  assert.equal(invoice.payments[1].received_date, '2026-09-22');
});

test('invoice statuses agree with paid, future milestone, deposit, balance and failed transfer states', async () => {
  const base = { id: id(10), price: 4000, balance_remaining: 3000, paid_to_date: 1000, status: 'signed' };
  const pay = [{ amount: 1000, received_date: '2026-09-20' }];
  const upcoming = [{ id: id(50), computed_amount: 4000, trigger_kind: 'on_completion', status: 'planned' }];
  const summary = (row = {}, inst = [], marks = [], payments = pay) => invoiceSummary({ ...base, ...row }, {}, inst, payments, marks, '2026-09-22');
  assert.equal(summary({ balance_remaining: 0, paid_to_date: 4000 }, [], [], [{ amount: 4000 }]).status, 'paid');
  assert.equal(summary({}, upcoming).status, 'scheduled');
  assert.equal(summary({}, upcoming).amount_due, 0);
  assert.equal(summary().status, 'balance_due', 'the legacy full-balance amount must not be described as a deposit');
  assert.equal(summary({ deposit_collected: true }).status, 'balance_due');
  assert.equal(summary({ status: 'completed' }).status, 'payment_due');
  assert.equal(summary().amount_due, 3000);
  const failed = { status: 'failed', amount: 1000, created_at: '2026-09-22T06:00:00Z' };
  assert.equal(summary({}, [], [failed]).ach_failed, true);
  assert.equal(summary({}, [], [failed], [{ amount: 1000, received_date: '2026-09-21' }]).ach_failed, false);
  assert.equal(summary({}, [], [failed, { status: 'pending', amount: 1000, created_at: '2026-09-22T08:00:00Z' }]).ach_failed, false);
});

test('unsent prepared invoices are withheld while issued requests and real payment records remain visible', async () => {
  const fx = fixture();
  fx.tables.pec_job_ar[0].invoice_first_sent_at = null;
  fx.tables.pec_invoice_installments.forEach(row => { row.sent_at = null; row.status = 'planned'; });
  fx.tables.pec_payments = [];
  assert.equal((await body(fx)).invoices.length, 0);
  fx.tables.pec_invoice_installments[0].sent_at = NOW.toISOString();
  assert.equal((await body(fx)).invoices.length, 1);
  fx.tables.pec_invoice_installments[0].sent_at = null;
  fx.tables.pec_payments.push({ id: id(40), job_id: id(10), amount: 1000, received_date: '2026-09-21' });
  assert.equal((await body(fx)).invoices.length, 1);
});

test('brand-specific configured contact/review links and toggles never fall back to another business', async () => {
  const fx = fixture({ company: 'finishing-touch' });
  fx.tables.settings.push({ key: 'customer_portal_referrals_enabled', value: 'false' }, { key: 'customer_portal_reviews_enabled', value: 'false' }, { key: 'portal_yelp_link_paint', value: 'https://www.yelp.ca/biz/synthetic-paint' });
  const out = await body(fx);
  assert.equal(out.brand.business_name, 'Fixture Painting');
  assert.equal(out.brand.phone, '9285550456');
  assert.equal(out.config.google_review_url, 'https://g.page/r/synthetic-paint/review');
  assert.equal(out.config.yelp_review_url, 'https://www.yelp.ca/biz/synthetic-paint');
  assert.equal(out.config.referrals_enabled, false);
  assert.equal(out.config.reviews_enabled, false);
  assert.deepEqual(out.referrals, []);
  assert.ok(!fx.calls.some(call => call.path.startsWith('/referrals?')));
  fx.tables.pec_brand_identity = [];
  assert.equal((await body(fx)).brand.phone, null);
  assert.equal((await body(fx)).brand.logo_url, null);
});

test('review destinations reject scripts, wrong hosts, credentials, ports and nonbusiness Yelp pages', async () => {
  for (const value of ['javascript:alert(1)', 'https://google.com.evil.invalid/', 'http://google.com/', 'https://user:pass@google.com/', 'https://google.com:444/']) {
    const fx = fixture();
    fx.tables.settings.find(row => row.key === 'google_review_link_epoxy').value = value;
    assert.equal((await body(fx)).config.google_review_url, null, value);
  }
  for (const value of ['', 'https://www.yelp.com/', 'https://evil.yelp.com/biz/fixture', 'https://yelp.com:444/biz/fixture', 'https://yelp.com.evil.invalid/biz/fixture']) {
    const fx = fixture();
    fx.tables.settings.find(row => row.key === 'portal_yelp_link_epoxy').value = value;
    assert.equal((await body(fx)).config.yelp_review_url, null, value);
  }
});

test('history and ledger pagination includes old documents and all payments beyond one page', async () => {
  const fx = fixture();
  const est = fx.tables.estimates[0], payment = fx.tables.pec_payments[0];
  fx.tables.estimates = Array.from({ length: 205 }, (_, i) => ({ ...est, id: id(1000 + i), public_token: id(2000 + i) }));
  fx.tables.pec_payments = Array.from({ length: 205 }, (_, i) => ({ ...payment, id: id(3000 + i), amount: 1 }));
  Object.assign(fx.tables.pec_job_ar[0], { paid_to_date: 205, balance_remaining: 3795 });
  const out = await body(fx);
  assert.equal(out.estimates.length, 205);
  assert.equal(out.invoices[0].payments.length, 205);
  assert.equal(out.invoices[0].amount_due, 1795);
  assert.ok(fx.calls.some(call => call.path.startsWith('/estimates?customer_id=') && call.path.endsWith('&offset=200')));
  assert.ok(fx.calls.some(call => call.path.startsWith('/pec_payments?') && call.path.endsWith('&offset=200')));
});

test('any required financial/history read failure returns a generic error instead of fake zero or empty records', async () => {
  for (const path of ['/rpc/get_portal_data', '/jobs?', '/leads?', '/estimates?', '/estimate_line_items?', '/pec_job_ar?', '/pec_payments?', '/pec_invoice_installments?', '/pec_stripe_pending?', '/pec_prod_job_schedule_days?', '/settings?', '/referrals?']) {
    const fx = fixture({ fail: path }), res = await fx.handler(event());
    assert.equal(res.statusCode, 503, path);
    assert.deepEqual(Object.keys(JSON.parse(res.body)), ['error']);
    assert.ok(!res.body.includes(TOKEN));
    assert.ok(!res.body.includes('PRIVATE'));
  }
});

test('missing or invalid financial amounts fail visibly rather than being coerced to zero', async () => {
  for (const [table, column, value] of [['pec_job_ar', 'price', null], ['pec_job_ar', 'balance_remaining', 'invalid'], ['pec_payments', 'amount', null], ['pec_invoice_installments', 'computed_amount', '']]) {
    const fx = fixture();
    fx.tables[table][0][column] = value;
    const res = await fx.handler(event());
    assert.equal(res.statusCode, 503);
    assert.deepEqual(Object.keys(JSON.parse(res.body)), ['error']);
  }
});
