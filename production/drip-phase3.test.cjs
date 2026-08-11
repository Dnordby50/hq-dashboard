// Fixture test for the Phase 3 drip engine work (prompt 35): subject
// generalization, estimate follow-up drips, invoice payment reminders, and
// the blast drain. Drives the REAL engine from netlify/functions/_pec-drip.cjs
// against the shared mini-PostgREST harness (production/_drip-test-kit.cjs).
// Run: node production/drip-phase3.test.cjs
'use strict';
const {
  runDrips, drainBlasts, computeBlastAudience, enrollLead, enrollSubject,
  enrollEstimateDrip, enrollJobInvoiceDrip, resolveRecipient,
  STOP_LINE, SITE_URL, BLAST_BATCH,
} = require('../netlify/functions/_pec-drip.cjs');
const {
  makeDb, baseTables, stubDeps, makeChecker, NOW_IN_WINDOW,
} = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

// Estimate-drip fixtures: campaign kind estimate + a sent estimate for lead1.
const EST_CAMP = { id: 'campE', name: 'Estimate follow-up', kind: 'estimate', status: 'active', mode: 'dry_run', max_touches: 4 };
const EST_STEPS = [
  { id: 'es0', campaign_id: 'campE', step_index: 0, day_offset: 1, channel: 'both', ai_guidance: 'estimate day-1', email_subject: 'Your Prescott Epoxy estimate', active: true },
  { id: 'es1', campaign_id: 'campE', step_index: 1, day_offset: 3, channel: 'sms', ai_guidance: 'estimate nudge', email_subject: null, active: true },
];
const INV_CAMP = { id: 'campI', name: 'Invoice reminders', kind: 'invoice', status: 'active', mode: 'dry_run', max_touches: 4 };
const INV_STEPS = [
  { id: 'is0', campaign_id: 'campI', step_index: 0, day_offset: 0, channel: 'sms', ai_guidance: 'invoice day-0', email_subject: null, active: true },
  { id: 'is1', campaign_id: 'campI', step_index: 1, day_offset: 3, channel: 'both', ai_guidance: 'invoice reminder', email_subject: 'Your Prescott Epoxy invoice', active: true },
];

function estTables(over = {}) {
  return baseTables({
    pec_drip_campaigns: [{ ...EST_CAMP }],
    pec_drip_steps: EST_STEPS.map(s => ({ ...s })),
    pec_drip_enrollments: [{
      id: 'enrE', subject_type: 'lead', subject_id: 'lead1', lead_id: 'lead1',
      campaign_id: 'campE', status: 'active', next_step_index: 0,
      next_send_at: '2026-07-20T16:00:00Z', enrolled_at: '2026-07-19T16:00:00Z',
      stop_reason: null, stopped_at: null,
    }],
    estimates: [{
      id: 'est1', lead_id: 'lead1', status: 'sent', price: 4850,
      public_token: 'tok-est-1', estimate_number: 'E-1042',
      sent_at: '2026-07-19T15:30:00Z', deleted_at: null,
    }],
    ...over,
  });
}

function invTables(over = {}) {
  return baseTables({
    pec_drip_campaigns: [{ ...INV_CAMP }],
    pec_drip_steps: INV_STEPS.map(s => ({ ...s })),
    pec_drip_enrollments: [{
      id: 'enrI', subject_type: 'job', subject_id: 'job1', lead_id: null,
      campaign_id: 'campI', status: 'active', next_step_index: 0,
      next_send_at: '2026-07-20T16:00:00Z', enrolled_at: '2026-07-19T16:00:00Z',
      stop_reason: null, stopped_at: null,
    }],
    jobs: [{
      id: 'job1', price: 5000, public_token: 'tok-pay-1', customer_id: 'cust1',
      voided_at: null, archived_at: null, completed_date: '2026-07-15',
      hq_invoice_number: 'INV-207', invoice_first_sent_at: '2026-07-19T16:00:00Z',
      address: '123 Pine St, Prescott',
    }],
    customers: [{
      id: 'cust1', name: 'Bob Builder', first_name: 'Bob', phone: '9285559876',
      phone_norm: '9285559876', email: 'bob@example.com', sms_opt_out: false,
    }],
    pec_payments: [],
    ...over,
  });
}

(async () => {
  console.log('# recipient resolution');
  {
    const fx = makeDb(invTables());
    const r = await resolveRecipient(fx.sb, 'job', 'job1');
    ok(r.ok && r.kind === 'job' && r.smsTo === '+19285559876' && r.email === 'bob@example.com', 'job subject resolves to the customer contact');
    ok(r.smsAllowed && r.emailAllowed && r.optedOut === false && r.first_name === 'Bob', 'customer consent model: opt-out only, both channels allowed by default');
  }
  {
    const fx = makeDb(invTables());
    fx.db.customers[0].sms_opt_out = true;
    const r = await resolveRecipient(fx.sb, 'job', 'job1');
    ok(!r.smsAllowed && r.smsSkipReason === 'sms_opted_out' && r.emailAllowed && !r.optedOut, 'customer sms_opt_out silences the SMS leg only, never the whole enrollment');
  }
  {
    const fx = makeDb(invTables({ jobs: [] }));
    const r = await resolveRecipient(fx.sb, 'job', 'job1');
    ok(!r.ok && r.reason === 'job_missing', 'missing job resolves ok:false (drip will stop, not crash)');
  }
  {
    const fx = makeDb(baseTables());
    fx.db.leads[0].email_consent = false;
    const r = await resolveRecipient(fx.sb, 'lead', 'lead1');
    ok(!r.emailAllowed && r.emailSkipReason === 'no_email_consent', 'lead email_consent=false skips the email leg');
  }

  console.log('# per-subject-per-campaign uniqueness');
  {
    // A lead can hold a lead-nurture drip AND an estimate drip, but never two
    // of the same campaign.
    const fx = makeDb(estTables({
      pec_drip_campaigns: [{ ...EST_CAMP }, { id: 'camp1', name: 'Lead follow-up', kind: 'lead', status: 'active', mode: 'dry_run', max_touches: 8 }],
      pec_drip_steps: [...EST_STEPS.map(s => ({ ...s })), { id: 's0', campaign_id: 'camp1', step_index: 0, day_offset: 1, channel: 'both', ai_guidance: 'first touch', email_subject: null, active: true }],
      pec_drip_enrollments: [],
    }));
    const r1 = await enrollLead(fx.sb, 'lead1', NOW_IN_WINDOW);
    const r2 = await enrollSubject(fx.sb, 'estimate', 'lead', 'lead1', 'lead1', NOW_IN_WINDOW);
    ok(r1.enrolled && r2.enrolled && fx.db.pec_drip_enrollments.length === 2, 'lead-nurture and estimate drips co-exist on one lead');
    const r3 = await enrollSubject(fx.sb, 'estimate', 'lead', 'lead1', 'lead1', NOW_IN_WINDOW);
    ok(!r3.enrolled && r3.reason === 'already_active' && fx.db.pec_drip_enrollments.length === 2, 'a second active estimate enrollment for the same lead 409s cleanly');
  }

  console.log('# estimate drip: sends with the real estimate link, never a model link');
  {
    const fx = makeDb(estTables());
    const { deps, providers } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(sum.dry_run === 2 && providers.ai.length === 1 && providers.ai[0].kind === 'estimate', 'estimate touch renders once with the estimate prompt kind');
    const smsRow = fx.db.pec_drip_sends.find(r => r.channel === 'sms');
    const emailRow = fx.db.pec_drip_sends.find(r => r.channel === 'email');
    ok(smsRow && smsRow.body.includes(`${SITE_URL}/e/tok-est-1`), 'SMS carries the code-appended estimate link (post-scrub)');
    ok(smsRow.body.trim().endsWith(STOP_LINE.trim()), 'first estimate SMS still ends with the STOP line after the link');
    ok(emailRow && emailRow.body.includes(`${SITE_URL}/e/tok-est-1`), 'email body carries the estimate link paragraph');
    ok(smsRow.subject_type === 'lead' && smsRow.subject_id === 'lead1' && smsRow.lead_id === 'lead1', 'ledger rows keep lead attribution (contact-count join)');
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.status === 'active' && enr.next_step_index === 1 && enr.next_send_at === '2026-07-22T16:00:00.000Z', 'advances to step 1 at enrolled_at + day 3');
  }

  console.log('# estimate drip: stop conditions at send time');
  for (const [mut, reason, label] of [
    [fx => { fx.db.estimates[0].status = 'accepted'; }, 'accepted', 'accepted estimate stops with reason accepted'],
    [fx => { fx.db.estimates[0].status = 'signed'; }, 'accepted', 'interim signed state ALSO counts as accepted (never nag a signer)'],
    [fx => { fx.db.estimates[0].status = 'rejected'; }, 'lost', 'all estimates rejected stops with reason lost'],
    [fx => { fx.db.leads[0].stage = 'lost'; }, 'lost', 'lead marked lost stops the estimate drip'],
    [fx => { fx.db.estimates[0].status = 'change_requested'; }, 'replied', 'a portal change request means the customer engaged: stop as replied'],
    [fx => { fx.db.pec_sms_log.push({ id: 'in1', direction: 'in', from_number: '+19285551234', created_at: '2026-07-20T01:00:00Z' }); }, 'replied', 'an inbound text stops the estimate drip as replied'],
  ]) {
    const fx = makeDb(estTables());
    mut(fx);
    const { deps, providers } = stubDeps(fx);
    await runDrips(deps);
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.status === 'stopped' && enr.stop_reason === reason && providers.ai.length === 0, label);
  }
  {
    // A lead with BOTH statuses present: any accepted wins over open ones.
    const fx = makeDb(estTables());
    fx.db.estimates.push({ id: 'est2', lead_id: 'lead1', status: 'accepted', price: 500, public_token: 'tok2', estimate_number: 'E-1043', sent_at: '2026-07-18T15:00:00Z', deleted_at: null });
    const { deps } = stubDeps(fx);
    await runDrips(deps);
    ok(fx.db.pec_drip_enrollments[0].stop_reason === 'accepted', 'any accepted estimate for the lead stops the drip even if another is still open');
  }

  console.log('# estimate drip: eager hand-off from lead nurture');
  {
    const fx = makeDb(estTables({
      pec_drip_campaigns: [{ ...EST_CAMP }, { id: 'camp1', name: 'Lead follow-up', kind: 'lead', status: 'active', mode: 'dry_run', max_touches: 8 }],
      pec_drip_enrollments: [{
        id: 'enrL', subject_type: 'lead', subject_id: 'lead1', lead_id: 'lead1',
        campaign_id: 'camp1', status: 'active', next_step_index: 2,
        next_send_at: '2026-07-23T16:00:00Z', enrolled_at: '2026-07-19T16:00:00Z',
        stop_reason: null, stopped_at: null,
      }],
    }));
    const r = await enrollEstimateDrip(fx.sb, 'lead1', NOW_IN_WINDOW);
    const nurture = fx.db.pec_drip_enrollments.find(e => e.id === 'enrL');
    const estEnr = fx.db.pec_drip_enrollments.find(e => e.campaign_id === 'campE');
    ok(r.enrolled === true && estEnr && estEnr.status === 'active', 'estimate drip enrolls on estimate sent');
    ok(nurture.status === 'stopped' && nurture.stop_reason === 'estimate_sent', 'active lead-nurture drip is eagerly stopped with reason estimate_sent (no double-touching)');
    ok(estEnr.next_send_at === '2026-07-21T17:00:00.000Z', 'first estimate touch lands a day after the send');
  }

  console.log('# invoice drip: real balance + pay link, recomputed every run');
  {
    const fx = makeDb(invTables());
    const { deps, providers } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(sum.dry_run === 1 && providers.ai.length === 1 && providers.ai[0].kind === 'invoice', 'invoice touch renders once with the invoice prompt kind');
    const smsRow = fx.db.pec_drip_sends.find(r => r.channel === 'sms');
    ok(smsRow && smsRow.body.includes('Balance: $5,000.00') && smsRow.body.includes(`${SITE_URL}/pay/tok-pay-1`), 'SMS carries the code-appended REAL balance and pay link');
    ok(smsRow.subject_type === 'job' && smsRow.subject_id === 'job1' && smsRow.lead_id === null, 'ledger row is job-keyed with no lead attribution');
  }
  {
    const fx = makeDb(invTables({ pec_payments: [{ id: 'p1', job_id: 'job1', amount: 5000 }] }));
    const { deps, providers } = stubDeps(fx);
    await runDrips(deps);
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.status === 'stopped' && enr.stop_reason === 'paid' && providers.ai.length === 0, 'a fully paid balance stops the reminders before any render');
  }

  console.log('# invoice drip: a future due date holds reminders (invoice terms, 2026-08-17)');
  {
    // Net 30: due date in the future -> the touch HOLDS (enrollment stays
    // active, nothing renders) and the sequence re-anchors to the due-date
    // morning so touches run due+0/+3/+7/+14, never day-3 dunning off the
    // send date. The adapter compares against real wall-clock time, so the
    // fixture uses a far-future date.
    const fx = makeDb(invTables());
    fx.db.jobs[0].invoice_terms = 'net_30';
    fx.db.jobs[0].invoice_due_date = '2099-01-01';
    const { deps, providers } = stubDeps(fx);
    const sum = await runDrips(deps);
    const enr = fx.db.pec_drip_enrollments[0];
    ok(sum.held === 1 && providers.ai.length === 0, 'future due date holds the touch before any render');
    ok(enr.status === 'active' && enr.next_send_at === '2099-01-01T15:00:00.000Z' && enr.enrolled_at === '2099-01-01T15:00:00.000Z',
      'enrollment stays active, re-anchored to the due-date morning (8 AM Phoenix)');
  }
  {
    // Due date already past -> reminders run exactly as before (no hold).
    const fx = makeDb(invTables());
    fx.db.jobs[0].invoice_terms = 'net_30';
    fx.db.jobs[0].invoice_due_date = '2026-07-01';
    const { deps, providers } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(sum.dry_run === 1 && providers.ai.length === 1 && !sum.held, 'a past due date never holds: reminders run');
  }
  {
    // Partial payment: keeps reminding with the LOWERED balance; a later full
    // payment stops the next run (recompute-per-run, never cached).
    const fx = makeDb(invTables({ pec_payments: [{ id: 'p1', job_id: 'job1', amount: 2000 }] }));
    const { deps } = stubDeps(fx);
    await runDrips(deps);
    const smsRow = fx.db.pec_drip_sends.find(r => r.channel === 'sms');
    ok(fx.db.pec_drip_enrollments[0].status === 'active' && smsRow && smsRow.body.includes('Balance: $3,000.00'), 'a partial payment does NOT stop it; the copy shows the remaining balance');
    fx.db.pec_payments.push({ id: 'p2', job_id: 'job1', amount: 3000 });
    fx.db.pec_drip_enrollments[0].next_send_at = '2026-07-20T16:30:00Z';
    await runDrips(deps);
    ok(fx.db.pec_drip_enrollments[0].stop_reason === 'paid', 'the payment that clears the balance stops it on the next run');
  }
  {
    const fx = makeDb(invTables());
    fx.db.customers[0].sms_opt_out = true;
    fx.db.pec_drip_enrollments[0].next_step_index = 1;   // 'both' step
    const { deps } = stubDeps(fx);
    await runDrips(deps);
    const skip = fx.db.pec_drip_sends.find(r => r.channel === 'sms');
    const email = fx.db.pec_drip_sends.find(r => r.channel === 'email');
    ok(skip && skip.status === 'skipped' && skip.error_message === 'sms_opted_out', 'customer STOP skips the SMS leg with its own reason');
    ok(email && email.status === 'dry_run' && email.body.includes(`${SITE_URL}/pay/tok-pay-1`), 'the email reminder still goes (opt-out is an SMS-scope signal)');
  }
  {
    const fx = makeDb(invTables());
    fx.db.jobs[0].voided_at = '2026-07-20T00:00:00Z';
    const { deps } = stubDeps(fx);
    await runDrips(deps);
    ok(fx.db.pec_drip_enrollments[0].stop_reason === 'job_closed', 'a voided/archived job stops the reminders');
  }
  {
    // Live mode: mirrors carry the job + customer so the conversation threads
    // attach to the right records.
    const fx = makeDb(invTables());
    fx.db.pec_drip_campaigns[0].mode = 'live';
    const { deps, providers } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(sum.sent === 1 && providers.sms[0].to === '+19285559876', 'live invoice SMS goes to the CUSTOMER phone');
    const mirror = fx.db.pec_sms_log.find(r => r.direction === 'out');
    ok(mirror && mirror.kind === 'drip' && mirror.job_id === 'job1' && mirror.customer_id === 'cust1', 'pec_sms_log mirror carries job_id + customer_id');
    ok(providers.sms[0].content.includes('Balance: $5,000.00') && providers.sms[0].content.trim().endsWith(STOP_LINE.trim()), 'live SMS has balance, pay link, and the STOP line');
  }
  {
    const fx = makeDb(invTables({ pec_drip_enrollments: [] }));
    const r = await enrollJobInvoiceDrip(fx.sb, 'job1', NOW_IN_WINDOW);
    const enr = fx.db.pec_drip_enrollments[0];
    ok(r.enrolled && enr.subject_type === 'job' && enr.subject_id === 'job1' && enr.lead_id === null, 'enrollJobInvoiceDrip creates a job-keyed enrollment');
    ok(enr.next_send_at === NOW_IN_WINDOW.toISOString(), 'day-0 step is due immediately (anchored to the send moment, never backdated)');
    const r2 = await enrollJobInvoiceDrip(fx.sb, 'job1', NOW_IN_WINDOW);
    ok(!r2.enrolled && r2.reason === 'already_active', 'double enrollment 409s cleanly');
  }

  console.log('# blast audience: consent hard-filter + de-dupe with lead priority');
  {
    const candidates = [
      { source: 'lead', id: 'L1', full_name: 'Ann Ash', phone: '9285550001', phone_norm: '9285550001', email: 'ann@x.com', sms_consent: true, opted_out: false },
      { source: 'lead', id: 'L2', full_name: 'Bo Ban', phone: '9285550002', phone_norm: '9285550002', email: null, sms_consent: false, opted_out: false },  // no consent, no email -> removed for SMS-only blast
      { source: 'lead', id: 'L3', full_name: 'Cy Cox', phone: '9285550003', phone_norm: '9285550003', email: 'cy@x.com', sms_consent: true, opted_out: true },   // opted out -> removed always
      { source: 'customer', id: 'C1', name: 'Ann Ash', phone: '(928) 555-0001', phone_norm: '9285550001', email: 'ann@x.com', sms_opt_out: false },              // dupe of L1 by phone+email
      { source: 'customer', id: 'C2', name: 'Dee Dot', phone: '9285550004', phone_norm: '9285550004', email: 'dee@x.com', sms_opt_out: true },                   // SMS opted out, email fine
    ];
    const sms = computeBlastAudience(candidates, 'sms');
    ok(sms.recipients.length === 1 && sms.recipients[0].key === 'lead:L1', 'SMS-only: consent hard-filter leaves just the consenting lead');
    ok(sms.removedConsent === 3 && sms.removedDupes === 1, 'removed-for-consent and removed-dupe counts are reported');
    const both = computeBlastAudience(candidates, 'both');
    ok(both.recipients.length === 2 && both.recipients.every(r => r.key !== 'customer:C1'), 'both-channel: the lead wins the phone/email collision with the customer');
    const dee = both.recipients.find(r => r.key === 'customer:C2');
    ok(dee && !dee.smsOk && dee.emailOk, 'sms_opt_out customer stays in the audience as email-only');
    ok(both.recipients.find(r => r.key === 'lead:L1').smsOk && both.recipients.find(r => r.key === 'lead:L1').emailOk, 'per-channel eligibility is what the queue insert (and the confirm count) uses');
  }

  console.log('# blast drain: master switch, claims, resume, consent re-check');
  const blastTables = (rows, over = {}) => baseTables({
    pec_blasts: [{
      id: 'b1', name: 'July special', channel: 'both', status: 'confirmed',
      sms_body: 'Hello from Prescott Epoxy. Reply STOP to opt out.',
      email_subject: 'Hello', email_body: 'Hello from Prescott Epoxy.',
      audience_filter: {}, total_queued: rows.length, total_sent: 0, total_failed: 0, total_skipped: 0,
      confirmed_at: '2026-07-20T16:00:00Z', completed_at: null,
    }],
    pec_drip_sends: rows,
    ...over,
  });
  const qrow = (n, channel, subjOver = {}) => ({
    id: 'q' + n, blast_id: 'b1', enrollment_id: null, campaign_id: null,
    subject_type: 'lead', subject_id: 'lead1', lead_id: 'lead1', step_index: 0,
    channel, status: 'queued', body: 'Hello from Prescott Epoxy. Reply STOP to opt out.',
    subject: channel === 'email' ? 'Hello' : null,
    created_at: `2026-07-20T15:${String(n).padStart(2, '0')}:00Z`, sent_at: null, scheduled_for: '2026-07-20T16:00:00Z',
    ...subjOver,
  });
  {
    const fx = makeDb(blastTables([qrow(1, 'sms'), qrow(2, 'email')], { settings: [{ id: 'set1', key: 'drip_sending_enabled', value: 'false' }] }));
    const { deps, providers } = stubDeps(fx);
    const sum = await drainBlasts(deps);
    ok(sum.master_off === true && providers.sms.length === 0 && providers.email.length === 0, 'master switch OFF: a confirmed blast moves nothing');
    ok(fx.db.pec_drip_sends.every(r => r.status === 'queued') && fx.db.pec_blasts[0].status === 'confirmed', 'queued rows just wait (they resume when the switch turns on)');
  }
  {
    const fx = makeDb(blastTables([qrow(1, 'sms'), qrow(2, 'email')]));
    const { deps, providers } = stubDeps(fx, { now: new Date('2026-07-20T10:00:00Z') });  // 3am Phoenix
    const sum = await drainBlasts(deps);
    ok(sum.sent === 1 && providers.email.length === 1 && providers.sms.length === 0 && sum.sms_held_quiet, 'outside quiet hours: email legs send, SMS legs are not claimed');
    ok(fx.db.pec_drip_sends.find(r => r.channel === 'sms').status === 'queued' && fx.db.pec_blasts[0].status === 'sending', 'held SMS stays queued and the blast stays in sending for the next in-window tick');
    const { deps: deps2, providers: p2 } = stubDeps(fx);   // back inside the window
    await drainBlasts(deps2);
    ok(p2.sms.length === 1 && p2.email.length === 0 && fx.db.pec_blasts[0].status === 'done', 'the next in-window pass sends ONLY the held SMS and completes the blast (no email re-send)');
  }
  {
    // 30 email recipients: pass 1 claims BLAST_BATCH (25), pass 2 the rest.
    // Total provider calls must equal total rows: resumable, never double.
    const rows = Array.from({ length: 30 }, (_, i) => qrow(i + 10, 'email'));
    const fx = makeDb(blastTables(rows));
    const { deps, providers } = stubDeps(fx);
    const s1 = await drainBlasts(deps);
    ok(s1.sent === BLAST_BATCH && fx.db.pec_blasts[0].status === 'sending', 'pass 1 sends exactly BLAST_BATCH rows and leaves the blast in sending');
    const s2 = await drainBlasts(deps);
    ok(s2.sent === 5 && s2.done === 1, 'pass 2 sends the remaining 5 and completes');
    ok(providers.email.length === 30 && fx.db.pec_drip_sends.every(r => r.status === 'sent'), 'every recipient sent exactly once across passes (claim-first, no double-send)');
    const b = fx.db.pec_blasts[0];
    ok(b.total_sent === 30 && b.total_failed === 0 && b.status === 'done' && b.completed_at, 'counts rolled up onto the blast header, status walked confirmed -> sending -> done');
  }
  {
    // A STOP that lands between confirm and send must win.
    const fx = makeDb(blastTables([qrow(1, 'sms'), qrow(2, 'email')]));
    fx.db.leads[0].opted_out = true;
    const { deps, providers } = stubDeps(fx);
    const sum = await drainBlasts(deps);
    ok(sum.skipped === 2 && providers.sms.length === 0 && providers.email.length === 0, 'opt-out after queueing skips every leg at send time');
    ok(fx.db.pec_drip_sends.every(r => r.status === 'skipped' && r.error_message === 'opted_out_after_queue'), 'skips are recorded with the opted_out_after_queue reason');
    ok(fx.db.pec_blasts[0].status === 'done' && fx.db.pec_blasts[0].total_skipped === 2, 'a fully-skipped blast still completes with honest counts');
  }
  {
    // Customer recipient: mirror rows carry kind/template_key 'blast' so the
    // Phase 1 contact counter can drop them (it counts the ledger instead).
    const fx = makeDb(blastTables(
      [qrow(1, 'sms', { subject_type: 'customer', subject_id: 'cust1', lead_id: null })],
      { customers: [{ id: 'cust1', name: 'Bob Builder', first_name: 'Bob', phone: '9285559876', phone_norm: '9285559876', email: 'bob@example.com', sms_opt_out: false }] }
    ));
    const { deps, providers } = stubDeps(fx);
    await drainBlasts(deps);
    ok(providers.sms.length === 1 && providers.sms[0].to === '+19285559876', 'customer blast SMS resolves the live customer phone at send time');
    const mirror = fx.db.pec_sms_log[0];
    ok(mirror && mirror.kind === 'blast' && mirror.customer_id === 'cust1', 'pec_sms_log mirror is kind blast with customer attribution');
    ok(fx.db.pec_drip_sends[0].status === 'sent' && fx.db.pec_drip_sends[0].provider_id, 'ledger row finalized with the provider id');
  }
  {
    // Stalled 'sending' rows (a crashed pass) are failed, never re-sent.
    const fx = makeDb(blastTables([
      qrow(1, 'email', { status: 'sending', scheduled_for: '2026-07-20T10:00:00Z' }),  // claimed 7h ago
      qrow(2, 'email'),
    ]));
    fx.db.pec_blasts[0].status = 'sending';
    const { deps, providers } = stubDeps(fx);
    const sum = await drainBlasts(deps);
    ok(sum.stalled === 1 && fx.db.pec_drip_sends.find(r => r.id === 'q1').status === 'failed', 'a stale claim is marked failed by the stall sweep');
    ok(providers.email.length === 1 && sum.done === 1 && fx.db.pec_blasts[0].total_failed === 1, 'the stalled row is never re-sent; the rest of the blast finishes');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
})().catch(err => { console.error('fixture crashed:', err); process.exit(1); });
