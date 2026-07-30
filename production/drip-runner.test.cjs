// Fixture test for the lead drip engine (prompt 34). Drives the REAL
// runDrips / enrollLead / helpers from netlify/functions/_pec-drip.cjs
// against a stubbed Supabase REST layer plus stubbed Quo / Resend / Anthropic,
// same rigor as the prompt-31 batch-handler fixture. Run: node production/drip-runner.test.cjs
// Phase 3 note: the harness (mini-PostgREST + fixtures) moved to
// production/_drip-test-kit.cjs, shared with drip-phase3.test.cjs. The stub
// now enforces the PHASE 3 uniqueness (one active enrollment per subject per
// campaign); every lead-drip behavior asserted here is unchanged.
'use strict';
const assert = require('assert');
const {
  runDrips, enrollLead, quietHours, scrubCopy, capSms, STOP_LINE,
} = require('../netlify/functions/_pec-drip.cjs');
const {
  makeDb, baseTables, stubDeps, makeChecker,
  NOW_IN_WINDOW, NOW_BEFORE_OPEN, NOW_AFTER_CLOSE, CAMP,
} = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

(async () => {
  console.log('# master switch off: nothing runs');
  {
    const fx = makeDb(baseTables({ settings: [{ id: 'set1', key: 'drip_sending_enabled', value: 'false' }] }));
    const { deps, providers } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(sum.master_off === true && sum.checked === 0, 'master off short-circuits before any work');
    ok(fx.db.pec_drip_sends.length === 0 && providers.sms.length === 0 && providers.email.length === 0 && providers.ai.length === 0, 'no ledger rows, no provider or AI calls');
  }

  console.log('# dry_run: real copy written, providers untouched, schedule advances');
  {
    const fx = makeDb(baseTables());
    const { deps, providers } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(sum.dry_run === 2 && sum.sent === 0, 'both legs recorded as dry_run, nothing sent');
    ok(providers.sms.length === 0 && providers.email.length === 0, 'Quo/Resend never called in dry_run');
    ok(providers.ai.length === 1, 'exactly one AI render per touch');
    const smsRow = fx.db.pec_drip_sends.find(r => r.channel === 'sms');
    const emailRow = fx.db.pec_drip_sends.find(r => r.channel === 'email');
    ok(smsRow && smsRow.status === 'dry_run' && smsRow.body.endsWith(STOP_LINE.trim()), 'first dry-run SMS carries the STOP line (review copy matches what would send)');
    ok(emailRow && emailRow.status === 'dry_run' && emailRow.subject === 'Your epoxy floor project' && /Prescott Epoxy team/.test(emailRow.body), 'email dry-run row has subject + body');
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.status === 'active' && enr.next_step_index === 1 && enr.next_send_at === '2026-07-21T16:00:00.000Z', 'advanced exactly one step; next_send_at = enrolled_at + day 2');
    ok(fx.db.leads[0].contacted_at === null, 'dry_run never stamps contacted_at');
  }

  console.log('# kill-switches at send time');
  {
    const fx = makeDb(baseTables({ pec_sms_log: [{ id: 'in1', direction: 'in', from_number: '+19285551234', created_at: '2026-07-20T01:00:00Z' }] }));
    const { deps, providers } = stubDeps(fx);
    const sum = await runDrips(deps);
    const enr = fx.db.pec_drip_enrollments[0];
    ok(sum.stopped === 1 && enr.status === 'stopped' && enr.stop_reason === 'replied', 'inbound text after enrollment stops with reason replied');
    ok(fx.db.pec_drip_sends.length === 0 && providers.ai.length === 0, 'replied stop happens BEFORE any render or send');
  }
  {
    const fx = makeDb(baseTables({ pec_call_log: [{ id: 'c1', direction: 'in', from_number: '+19285551234', occurred_at: '2026-07-20T01:00:00Z' }] }));
    const { deps } = stubDeps(fx);
    await runDrips(deps);
    ok(fx.db.pec_drip_enrollments[0].stop_reason === 'replied', 'an inbound CALL also counts as replied');
  }
  {
    const fx = makeDb(baseTables());
    fx.db.leads[0].stage = 'estimate_sent';
    const { deps } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(sum.stopped === 1 && fx.db.pec_drip_enrollments[0].stop_reason === 'stage_advanced', 'stage past contacted stops with stage_advanced');
  }
  {
    // prompt 59: a lead dragged into Estimate Scheduled by hand fires nothing
    // server-side, so the runner's stage check is the drip's safety net.
    const fx = makeDb(baseTables());
    fx.db.leads[0].stage = 'estimate_scheduled';
    const { deps } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(sum.stopped === 1 && fx.db.pec_drip_enrollments[0].stop_reason === 'stage_advanced', 'estimate_scheduled stops the nurture drip with stage_advanced');
  }
  {
    const fx = makeDb(baseTables());
    fx.db.leads[0].stage = 'contacted';
    const { deps } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(sum.dry_run === 2 && fx.db.pec_drip_enrollments[0].status === 'active', 'stage contacted keeps dripping (pre-sale window)');
  }
  {
    const fx = makeDb(baseTables());
    fx.db.leads[0].stage = 'lost';
    const { deps } = stubDeps(fx);
    await runDrips(deps);
    ok(fx.db.pec_drip_enrollments[0].stop_reason === 'lost', 'lost lead stops with reason lost');
  }
  {
    const fx = makeDb(baseTables());
    fx.db.leads[0].opted_out = true;
    const { deps, providers } = stubDeps(fx);
    await runDrips(deps);
    ok(fx.db.pec_drip_enrollments[0].stop_reason === 'opted_out' && providers.ai.length === 0, 'opted_out stops the whole enrollment');
  }
  {
    const fx = makeDb(baseTables());
    fx.db.pec_drip_enrollments[0].next_step_index = 8;
    const { deps } = stubDeps(fx);
    const sum = await runDrips(deps);
    const enr = fx.db.pec_drip_enrollments[0];
    ok(sum.completed === 1 && enr.status === 'completed' && enr.stop_reason === 'max_touches', 'max-touches ceiling completes the enrollment');
  }

  console.log('# live send happy path');
  {
    const fx = makeDb(baseTables());
    fx.db.pec_drip_campaigns[0].mode = 'live';
    const { deps, providers } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(sum.sent === 2 && providers.sms.length === 1 && providers.email.length === 1, 'live both-step sends one SMS and one email');
    ok(providers.sms[0].from === '+19280001111' && providers.sms[0].to === '+19285551234', 'SMS uses the brand sender and the E164 lead phone');
    ok(providers.sms[0].content.endsWith(STOP_LINE.trim()), 'first live SMS carries the STOP line');
    ok(providers.email[0].from === 'Prescott Epoxy <hello@prescottepoxy.com>' && providers.email[0].to === 'jane@example.com' && providers.email[0].reply_to === 'dylan@prescottepoxy.com', 'email uses the brand sender + reply_to');
    const sRow = fx.db.pec_drip_sends.find(r => r.channel === 'sms');
    const eRow = fx.db.pec_drip_sends.find(r => r.channel === 'email');
    ok(sRow.status === 'sent' && sRow.provider_id === 'quo-msg-1' && sRow.sent_at, 'SMS ledger row: sent + provider id + sent_at');
    ok(eRow.status === 'sent' && eRow.provider_id === 'resend-1', 'email ledger row: sent + provider id');
    const mirror = fx.db.pec_sms_log.find(r => r.direction === 'out');
    ok(mirror && mirror.kind === 'drip' && mirror.status === 'sent' && mirror.quo_message_id === 'quo-msg-1', 'SMS mirrored into pec_sms_log with kind drip (thread completeness; excluded from contact count)');
    ok(fx.db.pec_email_log[0] && fx.db.pec_email_log[0].template_key === 'drip', 'email mirrored into pec_email_log with template_key drip');
    ok(fx.db.leads[0].contacted_at === NOW_IN_WINDOW.toISOString(), 'first live touch stamps contacted_at (was null)');

    // Second touch: STOP line must not repeat.
    fx.db.pec_drip_enrollments[0].next_send_at = '2026-07-20T16:30:00Z';
    await runDrips(deps);
    ok(providers.sms.length === 2 && !providers.sms[1].content.includes('STOP'), 'second SMS does not repeat the STOP line');
    ok(fx.db.leads[0].contacted_at === NOW_IN_WINDOW.toISOString(), 'contacted_at is write-once (not restamped)');
  }

  console.log('# quiet hours (America/Phoenix, fixed UTC-7)');
  {
    const q = quietHours(NOW_BEFORE_OPEN);
    ok(!q.inWindow && q.nextOpen.toISOString() === '2026-07-20T15:00:00.000Z', '3am Phoenix defers to 8am Phoenix same day (15:00Z)');
    const q2 = quietHours(NOW_AFTER_CLOSE);
    ok(!q2.inWindow && q2.nextOpen.toISOString() === '2026-07-21T15:00:00.000Z', '9pm Phoenix defers to 8am next day');
    ok(quietHours(NOW_IN_WINDOW).inWindow, '10am Phoenix is inside the window');
  }
  {
    const fx = makeDb(baseTables());
    fx.db.pec_drip_campaigns[0].mode = 'live';
    fx.db.pec_drip_enrollments[0].next_send_at = '2026-07-20T09:00:00Z';  // due before the 10:00Z clock
    const { deps, providers } = stubDeps(fx, { now: NOW_BEFORE_OPEN });
    const sum = await runDrips(deps);
    const enr = fx.db.pec_drip_enrollments[0];
    ok(sum.deferred === 1 && providers.sms.length === 0 && providers.email.length === 0, 'live SMS step outside window sends nothing');
    ok(enr.next_step_index === 0 && enr.next_send_at === '2026-07-20T15:00:00.000Z', 'deferred, not skipped: same step, next_send_at = window open');
  }
  {
    const fx = makeDb(baseTables());
    fx.db.pec_drip_campaigns[0].mode = 'live';
    fx.db.pec_drip_enrollments[0].next_step_index = 2;   // email-only step
    fx.db.pec_drip_enrollments[0].next_send_at = '2026-07-20T09:00:00Z';
    const { deps, providers } = stubDeps(fx, { now: NOW_BEFORE_OPEN });
    const sum = await runDrips(deps);
    ok(sum.sent === 1 && providers.email.length === 1 && providers.sms.length === 0, 'email-only step sends any time (quiet hours are SMS-only)');
  }

  console.log('# consent: skip the SMS leg, never the whole drip');
  {
    const fx = makeDb(baseTables());
    fx.db.pec_drip_campaigns[0].mode = 'live';
    fx.db.leads[0].sms_consent = false;
    const { deps, providers } = stubDeps(fx);
    const sum = await runDrips(deps);
    const skip = fx.db.pec_drip_sends.find(r => r.channel === 'sms');
    ok(skip && skip.status === 'skipped' && skip.error_message === 'no_sms_consent', 'no-consent SMS leg recorded as skipped');
    ok(providers.sms.length === 0 && providers.email.length === 1 && sum.sent === 1, 'email leg still sends; enrollment stays active');
    ok(fx.db.pec_drip_enrollments[0].status === 'active' && fx.db.pec_drip_enrollments[0].next_step_index === 1, 'sequence advances past the skipped leg');
  }
  {
    const fx = makeDb(baseTables());
    fx.db.pec_drip_campaigns[0].mode = 'live';
    fx.db.leads[0].sms_consent = false;
    fx.db.pec_drip_enrollments[0].next_step_index = 1;   // sms-only step
    const { deps, providers } = stubDeps(fx);
    await runDrips(deps);
    ok(fx.db.pec_drip_sends.every(r => r.status === 'skipped') && providers.ai.length === 0, 'sms-only step with no consent: skipped row, no AI call, no send');
    ok(fx.db.pec_drip_enrollments[0].next_step_index === 2, 'and the sequence moves on to the email step');
  }

  console.log('# failures consume the step, never blind-retry');
  {
    const fx = makeDb(baseTables());
    const { deps } = stubDeps(fx, { aiThrows: true });
    const sum = await runDrips(deps);
    ok(sum.failed === 1 && fx.db.pec_drip_sends.filter(r => r.status === 'failed').length === 2, 'AI render failure records failed rows for both wanted legs');
    ok(fx.db.pec_drip_enrollments[0].next_step_index === 1, 'step consumed; next run does NOT re-render the same touch');
  }
  {
    const fx = makeDb(baseTables());
    fx.db.pec_drip_campaigns[0].mode = 'live';
    const { deps } = stubDeps(fx, { smsFails: true });
    await runDrips(deps);
    const sRow = fx.db.pec_drip_sends.find(r => r.channel === 'sms');
    ok(sRow.status === 'failed' && /quo 500/.test(sRow.error_message), 'provider failure recorded on the ledger');
    ok(fx.db.pec_sms_log[0].status === 'failed', 'and mirrored as a failed sms_log row');
    ok(fx.db.leads[0].contacted_at !== null, 'email leg still sent, so contacted_at stamps');
  }

  console.log('# concurrency: two overlapping runs cannot double-send a step');
  {
    const fx = makeDb(baseTables());
    fx.db.pec_drip_campaigns[0].mode = 'live';
    // Freeze the due-list snapshot both runs see (the race window).
    const realSb = fx.sb;
    const frozenDue = JSON.parse(JSON.stringify(fx.db.pec_drip_enrollments));
    const racySb = async (method, path, payload, returnRow) => {
      if (method === 'GET' && path.startsWith('/pec_drip_enrollments?status=eq.active&next_send_at=lte.')) {
        return JSON.parse(JSON.stringify(frozenDue));
      }
      return realSb(method, path, payload, returnRow);
    };
    const a = stubDeps(fx); a.deps.sb = racySb;
    const b = stubDeps(fx); b.deps.sb = racySb;
    const [sa, sc] = await Promise.all([runDrips(a.deps), runDrips(b.deps)]);
    const totalSms = a.providers.sms.length + b.providers.sms.length;
    const totalEmail = a.providers.email.length + b.providers.email.length;
    ok(totalSms === 1 && totalEmail === 1, 'exactly one send per channel across both racing runs');
    ok(sa.claimed_lost + sc.claimed_lost === 1, 'the losing run reports claimed_lost and walks away');
    ok(fx.db.pec_drip_enrollments[0].next_step_index === 1, 'enrollment advanced exactly once');
  }

  console.log('# paused campaign holds in place');
  {
    const fx = makeDb(baseTables());
    fx.db.pec_drip_campaigns[0].status = 'paused';
    const { deps, providers } = stubDeps(fx);
    await runDrips(deps);
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.status === 'active' && enr.next_step_index === 0 && providers.ai.length === 0 && fx.db.pec_drip_sends.length === 0, 'paused campaign: no send, no advance, resumes when unpaused');
  }

  console.log('# enrollment');
  {
    const fx = makeDb(baseTables({ pec_drip_enrollments: [] }));
    const r = await enrollLead(fx.sb, 'lead1', NOW_IN_WINDOW);
    const enr = fx.db.pec_drip_enrollments[0];
    ok(r.enrolled === true && enr && enr.next_step_index === 0, 'enrollLead creates an active enrollment at step 0');
    ok(enr.next_send_at === '2026-07-21T17:00:00.000Z', 'first touch scheduled at enrolled_at + day_offset 1');
    const r2 = await enrollLead(fx.sb, 'lead1', NOW_IN_WINDOW);
    ok(r2.enrolled === false && r2.reason === 'already_active' && fx.db.pec_drip_enrollments.length === 1, 'second enroll hits the partial unique index and is swallowed gracefully');
  }
  {
    const fx = makeDb(baseTables({ pec_drip_campaigns: [{ ...CAMP, status: 'paused' }], pec_drip_enrollments: [] }));
    const r = await enrollLead(fx.sb, 'lead1', NOW_IN_WINDOW);
    ok(r.enrolled === false && r.reason === 'no_active_campaign', 'no active lead campaign: enroll is a clean no-op');
  }

  console.log('# copy scrubbers (customer-facing discipline)');
  {
    ok(scrubCopy('Hello — check https://x.com now') === 'Hello, check now', 'em dash and link scrubbed');
    ok(scrubCopy(null) === null && scrubCopy('  ') === null, 'empty stays null');
    const long = 'word '.repeat(200);
    ok(capSms(long).length <= 480, 'SMS hard cap enforced');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
})().catch(err => { console.error('fixture crashed:', err); process.exit(1); });
