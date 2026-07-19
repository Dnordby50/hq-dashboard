// Fixture test for the Phase 3 drip engine work (prompt 35): subject
// generalization, estimate follow-up drips, invoice payment reminders, and
// the blast drain. Drives the REAL engine from netlify/functions/_pec-drip.cjs
// against the shared mini-PostgREST harness (production/_drip-test-kit.cjs).
// Run: node production/drip-phase3.test.cjs
'use strict';
const {
  runDrips, enrollLead, enrollSubject, resolveRecipient, STOP_LINE, SITE_URL,
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

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
})().catch(err => { console.error('fixture crashed:', err); process.exit(1); });
