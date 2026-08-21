// Prompt 42: approval-gate fixture tests. Drives the REAL engine
// (runDrips gate branch, resolvePendingStep, flushApprovedDrips,
// settings-driven quietHours) against the shared mini-PostgREST.
// Run: node production/drip-approval.test.cjs
'use strict';

const {
  runDrips, resolvePendingStep, flushApprovedDrips, quietHours,
  parseQuietSettings, scrubEditedCopy,
} = require('../netlify/functions/_pec-drip.cjs');
const {
  makeDb, baseTables, stubDeps, makeChecker,
  NOW_IN_WINDOW, NOW_BEFORE_OPEN,
} = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

// Fixture with the lead campaign LIVE and the approval gate ON.
function gatedTables(over = {}) {
  const t = baseTables(over);
  t.pec_drip_campaigns[0].mode = 'live';
  t.settings.push({ id: 'set2', key: 'drip_approval_required', value: 'true' });
  return t;
}
const pendings = (fx) => fx.db.pec_drip_sends.filter(r => r.status === 'pending');

(async () => {
  // -------------------------------------------------------------------------
  console.log('gate ON: a due step renders into pending rows, sends nothing, never advances');
  {
    const fx = makeDb(gatedTables());
    const { deps, providers } = stubDeps(fx);
    const s1 = await runDrips(deps);
    const p = pendings(fx);
    ok(s1.pending === 2 && p.length === 2, 'one pending row per sendable leg (both = sms + email)');
    ok(p.every(r => r.enrollment_id === 'enr1' && r.step_index === 0), 'pending rows carry enrollment + step');
    ok(p.find(r => r.channel === 'sms' && /Reply STOP to opt out/.test(r.body)), 'pending SMS body is the exact would-send copy (STOP line included)');
    ok(providers.sms.length === 0 && providers.email.length === 0, 'no provider was touched');
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.status === 'active' && enr.next_step_index === 0 && enr.next_send_at === '2026-07-20T16:00:00Z', 'enrollment did NOT advance and the schedule did not move');

    const s2 = await runDrips(deps);
    ok(s2.pending === 0 && s2.pending_held === 1 && pendings(fx).length === 2, 'second tick holds: no duplicate pending rows');
    ok(providers.ai.length === 1, 'the copy is rendered once, not re-rendered while held');
  }

  // -------------------------------------------------------------------------
  console.log('gate OFF: exact Phase-3 live behavior');
  {
    const fx = makeDb(gatedTables());
    fx.db.settings.find(r => r.key === 'drip_approval_required').value = 'false';
    const { deps, providers } = stubDeps(fx);
    const s = await runDrips(deps);
    ok(s.sent === 2 && s.pending === 0 && providers.sms.length === 1 && providers.email.length === 1, 'live send goes straight out with the gate off');
    ok(fx.db.pec_drip_enrollments[0].next_step_index === 1, 'and the enrollment advances');
  }

  // -------------------------------------------------------------------------
  console.log('gate OFF with a leftover pending row: the runner FLUSHES it through the approve path (2026-08-21, Dylan: approvals off means off)');
  {
    const fx = makeDb(gatedTables());
    fx.db.settings.find(r => r.key === 'drip_approval_required').value = 'false';
    fx.db.pec_drip_sends.push({ id: 'oldpend', enrollment_id: 'enr1', campaign_id: 'camp1', lead_id: 'lead1', step_index: 0, channel: 'sms', status: 'pending', body: 'held draft' });
    const { deps, providers } = stubDeps(fx);
    const s = await runDrips(deps);
    const row = fx.db.pec_drip_sends.find(r => r.id === 'oldpend');
    ok(s.pending_flushed === 1 && providers.sms.length === 1 && row.status === 'sent'
      && fx.db.pec_drip_enrollments[0].next_step_index === 1,
      'gate off: the leftover pending row sends via resolvePendingStep and the enrollment advances');
  }

  // -------------------------------------------------------------------------
  console.log('gate ON with a pending row: the prompt-42 hold still stands');
  {
    const fx = makeDb(gatedTables());
    fx.db.pec_drip_sends.push({ id: 'oldpend2', enrollment_id: 'enr1', campaign_id: 'camp1', lead_id: 'lead1', step_index: 0, channel: 'sms', status: 'pending', body: 'held draft' });
    const { deps, providers } = stubDeps(fx);
    const s = await runDrips(deps);
    ok(s.pending_held === 1 && providers.sms.length === 0 && fx.db.pec_drip_enrollments[0].next_step_index === 0,
      'gate on: a step a human is mid-review on is never auto-sent');
  }

  // -------------------------------------------------------------------------
  console.log('dry-run campaigns ignore the gate (review copy, advance as before)');
  {
    const fx = makeDb(gatedTables());
    fx.db.pec_drip_campaigns[0].mode = 'dry_run';
    const { deps } = stubDeps(fx);
    const s = await runDrips(deps);
    ok(s.dry_run === 2 && s.pending === 0 && fx.db.pec_drip_enrollments[0].next_step_index === 1, 'dry run writes previews and advances; nothing pends');
  }

  // -------------------------------------------------------------------------
  console.log('approve: sends the EDITED copy, logs sent, advances like an auto-send');
  {
    const fx = makeDb(gatedTables());
    const { deps, providers } = stubDeps(fx);
    await runDrips(deps);
    const smsRow = pendings(fx).find(r => r.channel === 'sms');
    const res = await resolvePendingStep(deps, {
      enrollmentId: 'enr1', stepIndex: 0, action: 'approve',
      edits: { [smsRow.id]: { body: 'Hi Jane — Anne here from Prescott Epoxy. Reply STOP to opt out.' } },
    });
    ok(res.ok && res.outcome === 'approved' && res.sent === 2, 'both legs sent');
    ok(providers.sms[0].content === 'Hi Jane, Anne here from Prescott Epoxy. Reply STOP to opt out.', 'edited body goes out, em dash scrubbed (rule 6), URLs untouched');
    const rows = fx.db.pec_drip_sends.filter(r => r.enrollment_id === 'enr1');
    ok(rows.every(r => r.status === 'sent' && r.sent_at), 'ledger rows land as sent with sent_at');
    ok(fx.db.pec_sms_log.some(l => l.kind === 'drip' && l.direction === 'out'), 'send mirrors into pec_sms_log kind drip');
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.next_step_index === 1 && enr.next_send_at === '2026-07-21T16:00:00.000Z', 'enrollment advanced exactly like an auto-send (enrolled_at + day 2)');
    ok(fx.db.leads[0].contacted_at, 'first-touch stamp set');
    const again = await resolvePendingStep(deps, { enrollmentId: 'enr1', stepIndex: 0, action: 'approve' });
    ok(!again.ok && again.error === 'nothing_pending', 'a second approve is a clean no-op (no double-send)');
  }

  // -------------------------------------------------------------------------
  console.log('skip: advances without sending');
  {
    const fx = makeDb(gatedTables());
    const { deps, providers } = stubDeps(fx);
    await runDrips(deps);
    const res = await resolvePendingStep(deps, { enrollmentId: 'enr1', stepIndex: 0, action: 'skip' });
    ok(res.ok && res.outcome === 'skipped', 'skip resolves');
    ok(providers.sms.length === 0 && providers.email.length === 0, 'nothing sent');
    ok(fx.db.pec_drip_sends.every(r => r.status === 'skipped' && r.error_message === 'skipped_by_reviewer'), 'pending rows marked skipped_by_reviewer');
    ok(fx.db.pec_drip_enrollments[0].next_step_index === 1, 'enrollment moved to the next step');
  }

  // -------------------------------------------------------------------------
  console.log('kill-switch between render and approve: voided, never sent');
  {
    const fx = makeDb(gatedTables());
    const { deps, providers } = stubDeps(fx);
    await runDrips(deps);
    // The lead replies AFTER the draft was held for review.
    fx.db.pec_sms_log.push({ id: 'in9', direction: 'in', from_number: '+19285551234', created_at: '2026-07-20T18:00:00Z' });
    const res = await resolvePendingStep(deps, { enrollmentId: 'enr1', stepIndex: 0, action: 'approve' });
    ok(res.ok && res.outcome === 'voided' && res.reason === 'replied', 'approve refuses: the customer replied');
    ok(providers.sms.length === 0 && providers.email.length === 0, 'no provider was touched');
    ok(fx.db.pec_drip_sends.every(r => r.status === 'skipped' && r.error_message === 'voided: replied'), 'pending rows voided with the visible reason');
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.status === 'stopped' && enr.stop_reason === 'replied', 'enrollment ended, same as the runner kill-switch');
  }

  // -------------------------------------------------------------------------
  console.log('master switch OFF blocks approve');
  {
    const fx = makeDb(gatedTables());
    const { deps } = stubDeps(fx);
    await runDrips(deps);
    fx.db.settings.find(r => r.key === 'drip_sending_enabled').value = 'false';
    const res = await resolvePendingStep(deps, { enrollmentId: 'enr1', stepIndex: 0, action: 'approve' });
    ok(!res.ok && res.error === 'master_off', 'approve refuses while sending is globally off');
    ok(pendings(fx).length === 2, 'the pending rows stay put for later');
  }

  // -------------------------------------------------------------------------
  console.log('approve during quiet hours: SMS deferred to the window, email sends now');
  {
    const fx = makeDb(gatedTables());
    const { deps, providers } = stubDeps(fx);
    await runDrips(deps);   // held at 10am Phoenix (in window; pending is written any time)
    const night = stubDeps(fx, { now: NOW_BEFORE_OPEN });  // 3am Phoenix Monday
    const res = await resolvePendingStep(night.deps, { enrollmentId: 'enr1', stepIndex: 0, action: 'approve' });
    ok(res.ok && res.sent === 1 && res.deferred === 1, 'email sent immediately, SMS deferred');
    const q = fx.db.pec_drip_sends.find(r => r.channel === 'sms');
    ok(q.status === 'queued' && q.scheduled_for === '2026-07-20T15:00:00.000Z', 'SMS held as queued until 8am Phoenix');
    ok(night.providers.sms.length === 0 && night.providers.email.length === 1, 'only the email touched a provider');
    ok(fx.db.pec_drip_enrollments[0].next_step_index === 1, 'the step is consumed at approve time');

    // The runner flush at night holds it...
    const heldFlush = await flushApprovedDrips(night.deps);
    ok(heldFlush.held === true && heldFlush.flushed === 0, 'flush outside the window leaves it queued');
    // ...and sends it once the window opens, with the approved copy.
    const day = stubDeps(fx, { now: NOW_IN_WINDOW });
    day.providers.sms.length = 0;
    const flush = await flushApprovedDrips(day.deps);
    ok(flush.flushed === 1 && day.providers.sms.length === 1, 'in-window flush sends the approved SMS');
    ok(fx.db.pec_drip_sends.find(r => r.channel === 'sms').status === 'sent', 'row finalized as sent');
  }

  // -------------------------------------------------------------------------
  console.log('flush re-checks at send time: a STOP between approve and flush wins');
  {
    const fx = makeDb(gatedTables());
    const { deps } = stubDeps(fx);
    await runDrips(deps);
    const night = stubDeps(fx, { now: NOW_BEFORE_OPEN });
    await resolvePendingStep(night.deps, { enrollmentId: 'enr1', stepIndex: 0, action: 'approve' });
    fx.db.leads[0].opted_out = true;   // STOP lands overnight
    const day = stubDeps(fx, { now: NOW_IN_WINDOW });
    const flush = await flushApprovedDrips(day.deps);
    ok(flush.skipped === 1 && flush.flushed === 0 && day.providers.sms.length === 0, 'queued SMS voided instead of sent');
    ok(fx.db.pec_drip_sends.find(r => r.channel === 'sms').error_message === 'voided: opted_out', 'with the reason on the row');
  }

  // -------------------------------------------------------------------------
  console.log('quiet hours come from Settings, not the hardcoded window');
  {
    const cfg = parseQuietSettings([
      { key: 'drip_quiet_start', value: '09:00' },
      { key: 'drip_quiet_end', value: '17:00' },
      { key: 'drip_quiet_days', value: 'tue' },
    ]);
    ok(cfg.startMin === 540 && cfg.endMin === 1020 && cfg.days.join(',') === '2', 'settings parse into the cfg');
    // NOW_IN_WINDOW is Monday 10:00 Phoenix: inside the default window but
    // outside a Tuesday-only config.
    ok(quietHours(NOW_IN_WINDOW).inWindow === true, 'default window unchanged (Mon 10am ok)');
    const qq = quietHours(NOW_IN_WINDOW, cfg);
    ok(qq.inWindow === false && qq.nextOpen.toISOString() === '2026-07-21T16:00:00.000Z', 'Tuesday-only config defers Monday to Tue 9am Phoenix');
    const bad = parseQuietSettings([{ key: 'drip_quiet_start', value: '22:00' }, { key: 'drip_quiet_end', value: '06:00' }]);
    ok(bad.startMin === 480 && bad.endMin === 1200, 'inverted window falls back to the default');
    // The runner honors the settings window for the live defer.
    const fx = makeDb(gatedTables());
    fx.db.settings.find(r => r.key === 'drip_approval_required').value = 'false';
    fx.db.settings.push({ id: 'set3', key: 'drip_quiet_days', value: 'tue' });
    const { deps, providers } = stubDeps(fx);
    const s = await runDrips(deps);
    ok(s.deferred === 1 && providers.sms.length === 0, 'live SMS due on a non-send day is deferred');
    ok(fx.db.pec_drip_enrollments[0].next_send_at === '2026-07-21T15:00:00.000Z', 'to the settings window open (Tue 8am Phoenix = 15:00Z)');
  }

  // -------------------------------------------------------------------------
  console.log('scrubEditedCopy keeps links, kills em dashes');
  {
    ok(scrubEditedCopy('Pay here — https://x.co/pay') === 'Pay here, https://x.co/pay', 'link survives the human-edit scrub');
    ok(scrubEditedCopy('   ') === null, 'blank collapses to null');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
