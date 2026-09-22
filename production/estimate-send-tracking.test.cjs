'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const ESTIMATE_ID = '11111111-1111-4111-8111-111111111111';
const estimate = () => ({
  id: ESTIMATE_ID, brand: 'PEC', estimate_number: 102500, price: 5000, calc_price: 5000,
  gp_pct: .5, customer_name: 'Fixture Customer', customer_first_name: 'Fixture',
  pricing_snapshot: { send_readiness: { version: 1, combinedGpPct: .5, calcTotal: 5000, finalSell: 5000, isCustom: false, lines: [{ label: 'Garage', gpPct: .5 }] } },
  estimate_line_items: [{ label: 'Garage', total: 5000, qty: 1, unit_cost: 2500, estimate_area_id: 'area', is_optional: false }],
});

function fixture(options = {}) {
  const attempts = new Map(), firstSends = new Map(), logs = [], trace = [];
  let providerCalls = 0;
  const db = async (method, path, row) => {
    if (path.startsWith('/pec_estimate_send_attempts')) {
      if (method === 'GET') {
        const query = new URLSearchParams(path.split('?')[1]);
        return [...attempts.values()].filter(row => row.estimate_id === query.get('estimate_id').slice(3) && row.channel === query.get('channel').slice(3) && row.status === 'pending').map(row => ({ id: row.id })).slice(0, 1);
      }
      if (method === 'POST') {
        trace.push('pending');
        if (options.failInsert) throw new Error('database unavailable');
        attempts.set(row.id, structuredClone(row));
        return options.emptyInsert ? [] : [structuredClone(row)];
      }
      assert.equal(method, 'PATCH');
      const id = new URLSearchParams(path.split('?')[1]).get('id').slice(3);
      trace.push(row.status);
      if (options.failComplete && row.status === 'sent') throw new Error('database unavailable after provider success');
      if (options.emptyComplete && row.status === 'sent') return [];
      const prior = attempts.get(id);
      assert.equal(prior.status, 'pending');
      const updated = { ...prior, ...row };
      attempts.set(id, updated);
      // Mirror the migration's unique estimate_id first-send projection. The
      // migration contract has separate tests; these exercise endpoint ordering.
      if (updated.status === 'sent' && !firstSends.has(updated.estimate_id)) firstSends.set(updated.estimate_id, { first_sent_at: updated.completed_at, channel: updated.channel, evidence_ref: id });
      return [structuredClone(updated)];
    }
    if (method === 'GET') {
      if (path.startsWith('/estimates?')) return [estimate()];
      if (path.startsWith('/pec_email_senders?')) return [{ from_name: 'Fixture', from_email: 'fixture@example.com' }];
      if (path.startsWith('/pec_sms_senders?')) return [{ from_number: '+19285550100' }];
      return [];
    }
    assert.ok(path === '/pec_email_log' || path === '/pec_sms_log', `unexpected write ${path}`);
    logs.push({ path, ...structuredClone(row) });
    return [{ id: `log-${logs.length}` }];
  };
  const fetch = async url => {
    providerCalls++;
    trace.push('provider');
    assert.ok([...attempts.values()].some(row => row.status === 'pending'), 'the attempt must exist before provider delivery');
    if (options.networkError) throw new Error('request timed out');
    if (options.serverError || options.timeoutResponse) return { ok: false, status: options.serverError ? 503 : 408, json: async () => ({ message: 'Delivery status unavailable' }) };
    if (options.reject) return { ok: false, status: 422, json: async () => ({ message: 'Recipient refused' }) };
    const id = `provider-${providerCalls}`;
    return { ok: true, status: 200, json: async () => options.missingId ? {} : url.includes('openphone') ? { data: { id } } : { id } };
  };
  const handlers = {};
  for (const channel of ['email', 'sms']) {
    const file = require.resolve(`../netlify/functions/pec-send-${channel}.cjs`);
    const localRequire = createRequire(file);
    const context = {
      exports: {}, console: { error() {}, warn() {} },
      process: { env: { RESEND_API_KEY: 'synthetic', QUO_API_KEY: 'synthetic' } },
      require: name => name === './_pec-supabase.cjs' ? { sb: db, requireStaff: async () => ({ ok: true, user: { id: 'staff' } }) } : localRequire(name),
      fetch,
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    handlers[channel] = context.exports.handler;
  }
  const call = async (channel, patch = {}) => {
    const input = channel === 'email'
      ? { brand: 'prescott-epoxy', to_email: 'fixture@example.com', subject: 'Fixture proposal', body_html: `<a href="https://example.com/e/${ESTIMATE_ID}">Review</a>`, estimate_id: ESTIMATE_ID, log_template_key: 'estimate', ...patch }
      : { brand: 'prescott-epoxy', to_number: '9285550101', kind: 'estimate', estimate_token: ESTIMATE_ID, ...patch };
    const result = await handlers[channel]({ httpMethod: 'POST', headers: {}, body: JSON.stringify(input) });
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  return { call, attempts, firstSends, logs, trace, get providerCalls() { return providerCalls; } };
}

for (const channel of ['email', 'sms']) {
  test(`${channel}: provider success completes the recorded attempt before responding`, async () => {
    const fx = fixture(), result = await fx.call(channel);
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.tracking_pending, false);
    assert.deepEqual(fx.trace, ['pending', 'provider', 'sent']);
    assert.equal(fx.firstSends.size, 1);
    assert.equal(fx.logs[0].status, 'sent');
    const row = [...fx.attempts.values()][0];
    assert.equal(row.channel, channel);
    assert.equal(row.brand, 'PEC');
    assert.equal(row.estimate_id, ESTIMATE_ID);
    assert.equal(row.recipient, channel === 'email' ? 'fixture@example.com' : '+19285550101');
    assert.equal(row.provider_id, 'provider-1');
    assert.ok(row.completed_at);
  });

  test(`${channel}: failure to persist or confirm a pending attempt prevents delivery`, async () => {
    for (const option of ['failInsert', 'emptyInsert']) {
      const fx = fixture({ [option]: true }), result = await fx.call(channel);
      assert.equal(result.status, 503);
      assert.equal(result.body.ok, false);
      assert.match(result.body.error, /was not sent/);
      assert.equal(fx.providerCalls, 0);
      assert.equal(fx.firstSends.size, 0);
    }
  });

  test(`${channel}: explicit rejection is recorded as failed and never counted`, async () => {
    const fx = fixture({ reject: true }), result = await fx.call(channel);
    assert.equal(result.status, 502);
    assert.equal(result.body.ok, false);
    assert.equal([...fx.attempts.values()][0].status, 'failed');
    assert.equal(fx.firstSends.size, 0);
    assert.equal(fx.logs[0].status, 'failed');
  });

  test(`${channel}: provider success with a failed or zero-row completion warns without asking to resend`, async () => {
    for (const option of ['failComplete', 'emptyComplete']) {
      const fx = fixture({ [option]: true }), result = await fx.call(channel);
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      assert.equal(result.body.tracking_pending, true);
      assert.match(result.body.warning, /was sent.*pending/);
      assert.match(result.body.warning, /Do not resend/);
      assert.equal([...fx.attempts.values()][0].status, 'pending');
      assert.equal(fx.firstSends.size, 0);
      assert.equal(fx.logs[0].status, 'sent', 'provider success remains available for recovery');
      assert.equal(fx.providerCalls, 1);
    }
  });

  test(`${channel}: network, HTTP 5xx/408 uncertainty or missing provider ID stays pending and requires verification`, async () => {
    for (const option of ['networkError', 'serverError', 'timeoutResponse', 'missingId']) {
      const fx = fixture({ [option]: true }), result = await fx.call(channel);
      assert.equal(result.status, 502);
      assert.equal(result.body.send_unknown, true);
      assert.match(result.body.error, /before sending/);
      assert.doesNotMatch(result.body.error, /Try again|not sent|Send failed/);
      assert.equal([...fx.attempts.values()][0].status, 'pending');
      assert.equal(fx.firstSends.size, 0);
      assert.equal(fx.logs.length, 0, 'ambiguous delivery must not be logged as failed');
      assert.equal(fx.providerCalls, 1);
    }
  });

  test(`${channel}: a pending attempt blocks another provider call across requests`, async () => {
    const fx = fixture({ networkError: true });
    const first = await fx.call(channel), second = await fx.call(channel);
    assert.equal(second.body.send_unknown, true);
    assert.equal(second.body.tracking_attempt_id, first.body.tracking_attempt_id);
    assert.equal(fx.providerCalls, 1);
    assert.equal(fx.attempts.size, 1);
  });
}

test('email plus SMS and later resends retain one first-send fact for the proposal', async () => {
  const fx = fixture();
  await fx.call('email');
  const first = structuredClone(fx.firstSends.get(ESTIMATE_ID));
  await fx.call('sms');
  await fx.call('email');
  assert.equal(fx.attempts.size, 3);
  assert.equal(fx.firstSends.size, 1);
  assert.deepEqual(fx.firstSends.get(ESTIMATE_ID), first);
});

test('estimate email cannot bypass tracking by omitting its estimate ID', async () => {
  const fx = fixture(), result = await fx.call('email', { estimate_id: null });
  assert.equal(result.status, 400);
  assert.equal(fx.providerCalls, 0);
});

test('the recovery record preserves the actual overridden email recipient', async () => {
  const fx = fixture({ networkError: true });
  await fx.call('email', { to_email: 'alternate@example.com' });
  assert.equal([...fx.attempts.values()][0].recipient, 'alternate@example.com');
});
