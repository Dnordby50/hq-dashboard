'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { runDrips, sendInstantTouch, resolvePendingStep, flushApprovedDrips, resolveRecipient, checkKillSwitches } = require('../netlify/functions/_pec-drip.cjs');
const { makeDb, baseTables, stubDeps, NOW_IN_WINDOW } = require('./_drip-test-kit.cjs');
function fixture(enabled = false) {
  const t = baseTables();
  t.customers = [{ id: 'cust1', drips_enabled: enabled, phone: '9285551234', email: 'fixture@example.test' }];
  t.leads[0].customer_id = 'cust1';
  t.pec_drip_campaigns[0].mode = 'live';
  t.settings.push({ key: 'drip_approval_required', value: 'false' });
  const fx = makeDb(t); return { ...fx, ...stubDeps(fx) };
}
function noSends(f) { assert.equal(f.providers.sms.length, 0); assert.equal(f.providers.email.length, 0); }
test('disabled customer stops lead drip without generating or sending copy', async () => {
  const f = fixture(); await runDrips(f.deps); noSends(f);
  assert.equal(f.providers.ai.length, 0);
  assert.equal(f.db.pec_drip_enrollments[0].stop_reason, 'customer_drips_disabled');
});
test('preference is customer-scoped; enabled customer retains existing sending', async () => {
  const f = fixture(true); f.db.customers.push({ id: 'other', drips_enabled: false });
  await runDrips(f.deps); assert.equal(f.providers.sms.length, 1); assert.equal(f.providers.email.length, 1);
});
test('all job campaign kinds stop, without altering manual/blast consent', async () => {
  const f = fixture(); f.db.jobs.push({ id: 'job1', customer_id: 'cust1' });
  const rcpt = await resolveRecipient(f.sb, 'job', 'job1');
  assert.equal(rcpt.smsAllowed, true); assert.equal(rcpt.emailAllowed, true);
  for (const kind of ['invoice', 'review', 'estimate']) {
    assert.equal((await checkKillSwitches(f.sb, f.db.pec_drip_enrollments[0], { kind }, rcpt)).reason, 'customer_drips_disabled');
  }
});
test('disabled instant touch never calls a provider', async () => {
  const f = fixture(); f.db.settings.push({ key: 'drip_instant_touch_enabled', value: 'true' });
  Object.assign(f.db.pec_drip_steps[0], { auto_send: true, fixed_template: 'Hello {first_name}' });
  const out = await sendInstantTouch(f.sb, 'lead1', { now: () => NOW_IN_WINDOW, senders: f.deps });
  assert.equal(out.reason, 'customer_drips_disabled'); noSends(f);
});
test('turning off while copy renders blocks both provider legs and records skipped', async () => {
  const f = fixture(true), render = f.deps.renderCopy;
  f.deps.renderCopy = async (...args) => { const copy = await render(...args); f.db.customers[0].drips_enabled = false; return copy; };
  const out = await runDrips(f.deps); noSends(f); assert.equal(out.failed, 0);
  assert.ok(f.db.pec_drip_sends.every(r => r.status === 'skipped')); assert.equal(f.db.pec_sms_log.length, 0);
});
test('preference is rechecked between SMS and email', async () => {
  const f = fixture(true), sms = f.deps.sendSms;
  f.deps.sendSms = async args => { const result = await sms(args); f.db.customers[0].drips_enabled = false; return result; };
  await runDrips(f.deps); assert.equal(f.providers.sms.length, 1); assert.equal(f.providers.email.length, 0);
  assert.equal(f.db.pec_drip_sends.find(r => r.channel === 'email').status, 'skipped');
});
test('failed fresh preference lookup fails closed', async () => {
  const f = fixture(true), sb = f.deps.sb; let reads = 0;
  f.deps.sb = async (method, path, ...args) => { if (method === 'GET' && path.startsWith('/customers') && ++reads > 1) throw new Error('offline'); return sb(method, path, ...args); };
  await runDrips(f.deps); noSends(f);
});
test('pending approval and previously approved queued messages honor off', async () => {
  for (const queued of [false, true]) {
    const f = fixture(); f.db.pec_drip_sends.push({ id: 'send1', enrollment_id: 'enr1', campaign_id: 'camp1', subject_type: 'lead', subject_id: 'lead1', lead_id: 'lead1', step_index: 0, channel: 'email', status: queued ? 'queued' : 'pending', body: 'Hello', blast_id: null });
    if (queued) await flushApprovedDrips(f.deps);
    else await resolvePendingStep(f.deps, { enrollmentId: 'enr1', stepIndex: 0, action: 'approve' });
    noSends(f); assert.equal(f.db.pec_drip_sends[0].status, 'skipped');
  }
});
test('re-enabling does not allow an in-flight stopped sequence to send', async () => {
  const f = fixture(true), render = f.deps.renderCopy;
  f.deps.renderCopy = async (...args) => { const copy = await render(...args); Object.assign(f.db.pec_drip_enrollments[0], { status: 'stopped', stop_reason: 'customer_drips_disabled' }); return copy; };
  await runDrips(f.deps); noSends(f);
});
