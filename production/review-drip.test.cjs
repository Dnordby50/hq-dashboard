// Fixture test for the review drip kind (prompt 60, Parts C/D/H). Drives the
// REAL engine from netlify/functions/_pec-drip.cjs against the shared
// mini-PostgREST harness. Run: node production/review-drip.test.cjs
'use strict';
const {
  runDrips, enrollReviewDrip, reviewCopyViolation, buildRenderPrompt,
  kindTail, RENDER_SYSTEM_PROMPTS, STOP_LINE, SITE_URL,
} = require('../netlify/functions/_pec-drip.cjs');
const { makeDb, baseTables, stubDeps, makeChecker, NOW_IN_WINDOW } = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

// The campaign ships LIVE (decision 15): its safety is the approval gate, so
// these fixtures default to drip_approval_required 'true'.
const REV_CAMP = { id: 'campR', name: 'Review request', kind: 'review', status: 'active', mode: 'live', max_touches: 4, created_at: '2026-07-01T00:00:00Z' };
const REV_STEPS = [
  { id: 'rs0', campaign_id: 'campR', step_index: 0, day_offset: 1, channel: 'sms', ai_guidance: 'review day-1', email_subject: null, active: true },
  { id: 'rs1', campaign_id: 'campR', step_index: 1, day_offset: 3, channel: 'sms', ai_guidance: 'review nudge', email_subject: null, active: true },
  { id: 'rs2', campaign_id: 'campR', step_index: 2, day_offset: 7, channel: 'email', ai_guidance: 'review email', email_subject: 'How did we do on your floor?', active: true },
  { id: 'rs3', campaign_id: 'campR', step_index: 3, day_offset: 14, channel: 'sms', ai_guidance: 'review final', email_subject: null, active: true },
];

function revTables(over = {}) {
  return baseTables({
    settings: [
      { id: 'set1', key: 'drip_sending_enabled', value: 'true' },
      { id: 'set2', key: 'drip_approval_required', value: 'true' },
    ],
    pec_drip_campaigns: [{ ...REV_CAMP }],
    pec_drip_steps: REV_STEPS.map(s => ({ ...s })),
    pec_drip_enrollments: [{
      id: 'enrR', subject_type: 'job', subject_id: 'job1', lead_id: null,
      campaign_id: 'campR', status: 'active', next_step_index: 0,
      next_send_at: '2026-07-20T16:00:00Z', enrolled_at: '2026-07-19T16:00:00Z',
      stop_reason: null, stopped_at: null,
    }],
    jobs: [{
      id: 'job1', price: 5000, public_token: 'tok-pay-1', customer_id: 'cust1',
      voided_at: null, archived_at: null, completed_date: '2026-07-15',
      hq_invoice_number: 'INV-207', invoice_first_sent_at: null,
      address: '123 Pine St, Prescott',
    }],
    customers: [{
      id: 'cust1', name: 'Bob Builder', first_name: 'Bob', phone: '9285559876',
      phone_norm: '9285559876', email: 'bob@example.com', sms_opt_out: false,
    }],
    pec_review_requests: [{
      id: 'req1', job_id: 'job1', prod_job_id: 'prod1', customer_id: 'cust1',
      token: 'tok-rev-1', status: 'asked', crew_lead: 'Kyle Smith', crew_id: 'crew1',
      brand: 'epoxy', asked_at: '2026-07-19T16:00:00Z', job_completed_date: '2026-07-15',
      first_clicked_at: null, click_count: 0, review_id: null, stop_reason: null,
      created_at: '2026-07-19T16:00:00Z',
    }],
    pec_prod_jobs: [{ id: 'prod1', is_callback: false, touchup_state: null, touchup_closed_at: null, original_job_id: null }],
    pec_payments: [],
    ...over,
  });
}

(async () => {
  console.log('# review enrollment + the live-campaign approval-gate guard (decision 15)');
  {
    const fx = makeDb(revTables({ pec_drip_enrollments: [] }));
    const r = await enrollReviewDrip(fx.sb, 'job1', NOW_IN_WINDOW);
    const enr = fx.db.pec_drip_enrollments[0];
    ok(r.enrolled && enr.subject_type === 'job' && enr.subject_id === 'job1' && enr.lead_id === null, 'enrollReviewDrip creates a job-keyed enrollment when the gate is on');
    ok(enr.next_send_at === new Date(NOW_IN_WINDOW.getTime() + 864e5).toISOString(), 'step 0 (day 1) is anchored to enrollment time');
    const r2 = await enrollReviewDrip(fx.sb, 'job1', NOW_IN_WINDOW);
    ok(!r2.enrolled && r2.reason === 'already_active', 'double enrollment 409s cleanly');
  }
  {
    // Gate OFF + campaign never approved a send: enrollment REFUSES. This is
    // the only thing standing between a live campaign and a real customer.
    const fx = makeDb(revTables({ pec_drip_enrollments: [] }));
    fx.db.settings.find(s => s.key === 'drip_approval_required').value = 'false';
    const r = await enrollReviewDrip(fx.sb, 'job1', NOW_IN_WINDOW);
    ok(!r.enrolled && r.reason === 'approval_gate_off' && fx.db.pec_drip_enrollments.length === 0, 'gate off + never-sent campaign refuses to enroll');
    // One approved (sent) send on record means a human has vetted copy:
    // flipping the gate off is now an informed choice and enrollment proceeds.
    fx.db.pec_drip_sends.push({ id: 'sent1', enrollment_id: 'x', campaign_id: 'campR', step_index: 0, channel: 'sms', status: 'sent' });
    const r3 = await enrollReviewDrip(fx.sb, 'job1', NOW_IN_WINDOW);
    ok(r3.enrolled === true, 'gate off but campaign HAS an approved send: enrollment proceeds');
  }

  console.log('# due step renders real copy, link appended by CODE, held at the gate');
  {
    const fx = makeDb(revTables());
    const { deps, providers } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(sum.pending === 1 && providers.ai.length === 1 && providers.ai[0].kind === 'review', 'due review step renders once with the review prompt kind and lands PENDING (gate), never sent');
    const row = fx.db.pec_drip_sends.find(r => r.status === 'pending');
    ok(row && row.channel === 'sms' && row.body.includes(`${SITE_URL}/r/tok-rev-1`), 'pending SMS carries the code-appended /r/ tracking link (post-scrub)');
    ok(row.body.trim().endsWith(STOP_LINE.trim()), 'first review SMS ends with the STOP line after the link');
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.status === 'active' && enr.next_step_index === 0, 'the gate holds: enrollment does NOT advance until a human approves or skips');
    ok(providers.sms.length === 0 && providers.email.length === 0, 'no provider was touched');
    const sum2 = await runDrips(deps);
    ok(sum2.pending_held === 1 && fx.db.pec_drip_sends.filter(r => r.status === 'pending').length === 1, 'a second tick holds on the existing pending row (no duplicate render)');
  }

  console.log('# stop conditions, each with its own reason');
  for (const [mut, reason, label] of [
    [fx => { fx.db.pec_review_requests[0].status = 'reviewed'; }, 'reviewed', 'a detected review stops with reason reviewed'],
    [fx => { fx.db.pec_review_requests[0].review_id = 'rev1'; }, 'reviewed', 'a linked review_id also counts as reviewed'],
    [fx => { fx.db.pec_prod_jobs[0].touchup_state = 'open'; }, 'touchup_opened', 'an open touch-up on the prod job stops with touchup_opened'],
    [fx => { fx.db.pec_prod_jobs.push({ id: 'prodCB', is_callback: true, touchup_state: 'scheduled', touchup_closed_at: null, original_job_id: 'prod1' }); }, 'touchup_opened', 'an open CHILD callback row also stops with touchup_opened'],
    [fx => { fx.db.jobs[0].voided_at = '2026-07-20T00:00:00Z'; }, 'job_closed', 'a voided job stops with job_closed'],
    [fx => { fx.db.pec_sms_log.push({ id: 'in1', direction: 'in', customer_id: 'cust1', from_number: '+19285559876', created_at: '2026-07-20T01:00:00Z' }); }, 'replied', 'an inbound text from the customer stops as replied (universal core, not re-implemented)'],
    [fx => { fx.db.pec_review_requests[0].status = 'stopped'; fx.db.pec_review_requests[0].stop_reason = 'bad_review'; }, 'bad_review', 'a request stopped by the bad-review intake path stops the enrollment as bad_review'],
  ]) {
    const fx = makeDb(revTables());
    mut(fx);
    const { deps, providers } = stubDeps(fx);
    await runDrips(deps);
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.status === 'stopped' && enr.stop_reason === reason && providers.ai.length === 0, label);
  }
  {
    // review_stop_on_touchup='false' disables the touch-up stop (rule 12 knob).
    const fx = makeDb(revTables());
    fx.db.pec_prod_jobs[0].touchup_state = 'open';
    fx.db.settings.push({ id: 'setT', key: 'review_stop_on_touchup', value: 'false' });
    const { deps } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(fx.db.pec_drip_enrollments[0].status === 'active' && sum.pending === 1, 'review_stop_on_touchup off: the touch-up no longer stops the drip');
  }
  {
    // A closed touch-up ('done') does not block.
    const fx = makeDb(revTables());
    fx.db.pec_prod_jobs[0].touchup_state = 'done';
    const { deps } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(fx.db.pec_drip_enrollments[0].status === 'active' && sum.pending === 1, 'a done touch-up does not stop the drip');
  }

  console.log('# review_drip_enabled: its own master switch, holds in place');
  {
    const fx = makeDb(revTables());
    fx.db.settings.push({ id: 'setR', key: 'review_drip_enabled', value: 'false' });
    const { deps, providers } = stubDeps(fx);
    const sum = await runDrips(deps);
    ok(sum.pending === 0 && providers.ai.length === 0 && fx.db.pec_drip_enrollments[0].status === 'active', 'review_drip_enabled=false holds the enrollment in place (nothing rendered, nothing stopped)');
  }

  console.log('# crew-lead copy context: explicit null, never re-derived');
  {
    const ctxWith = { first_name: 'Bob', job: { address: '123 Pine St', completed_date: '2026-07-15' }, reviewRequest: { crew_lead: 'Kyle Smith', job_completed_date: '2026-07-15' } };
    const p1 = buildRenderPrompt(ctxWith, REV_STEPS[0], REV_CAMP, { sms: true, email: false });
    ok(p1.includes('"crew_lead":"Kyle Smith"'), 'crew_lead from the request SNAPSHOT lands in the fact record');
    const ctxNull = { ...ctxWith, reviewRequest: { crew_lead: null, job_completed_date: '2026-07-15' } };
    const p2 = buildRenderPrompt(ctxNull, REV_STEPS[0], REV_CAMP, { sms: true, email: false });
    ok(p2.includes('"crew_lead":null'), 'a missing crew lead is an EXPLICIT null in the record (generic wording, never the string null)');
    ok(/NEVER write the word null/.test(RENDER_SYSTEM_PROMPTS.review) && /of value in exchange for a review/i.test(RENDER_SYSTEM_PROMPTS.review), 'the review system prompt forbids the word null and any incentive');
  }

  console.log('# the /r/ link is code-appended (kindTail), never model-written');
  {
    const tail = kindTail('review', { reviewRequest: { token: 'tok-rev-1' } });
    ok(tail && tail.sms.includes(`${SITE_URL}/r/tok-rev-1`) && tail.text.includes(`${SITE_URL}/r/tok-rev-1`), 'kindTail builds the /r/<token> link for both channels');
    ok(kindTail('review', {}) === null, 'no request token: no tail (and the scrubber already strips model links)');
  }

  console.log('# incentive scrubber (Google policy, landmine 10)');
  {
    ok(reviewCopyViolation('Leave a review and get a $50 gift card!'), 'dollar-amount incentive is flagged');
    ok(reviewCopyViolation('Review us for 10% off your next coating'), 'percent-off incentive is flagged');
    ok(reviewCopyViolation('a free upgrade if you review us'), 'freebie incentive is flagged');
    ok(!reviewCopyViolation('Hi Bob, thanks for choosing Prescott Epoxy. How did Kyle and the crew do? A quick Google review means a lot.'), 'normal review copy passes');
  }

  console.log('# backfill anchoring (Part H): a 25-day-old completion yields ONE due step, not three');
  {
    const fx = makeDb(revTables({ pec_drip_enrollments: [] }));
    // The job completed 25 days before enrollment; enrollReviewDrip anchors
    // to NOW, so only step 0 (day 1) is due tomorrow.
    fx.db.jobs[0].completed_date = '2026-06-25';
    fx.db.pec_review_requests[0].job_completed_date = '2026-06-25';
    const r = await enrollReviewDrip(fx.sb, 'job1', NOW_IN_WINDOW);
    ok(r.enrolled, 'backfilled job enrolls');
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.next_send_at === new Date(NOW_IN_WINDOW.getTime() + 864e5).toISOString(), 'next_send_at is enrollment time + day 1, NOT completed_date + day 1');
    // One tick a day later: exactly ONE pending item renders, never three.
    const dayLater = new Date(NOW_IN_WINDOW.getTime() + 864e5 + 3600e3);
    const { deps, providers } = stubDeps(fx, { now: dayLater });
    const sum = await runDrips(deps);
    ok(sum.pending === 1 && providers.ai.length === 1, 'one runner tick renders exactly ONE pending approval item');
    const sum2 = await runDrips(deps);
    ok(sum2.pending_held === 1 && fx.db.pec_drip_sends.filter(x => x.status === 'pending').length === 1, 'and it stays exactly one on the next tick (no step pileup)');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
})().catch(err => { console.error('fixture crashed:', err); process.exit(1); });
