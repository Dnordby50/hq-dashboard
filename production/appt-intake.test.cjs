// Fixture test for the Routemize -> TopCoat appointment intake (prompt 43).
// Drives the REAL processApptIntake from netlify/functions/pec-appt-intake.cjs
// (and through it the real apptBookingLeadEffects) against the shared
// mini-PostgREST (production/_drip-test-kit.cjs) with captured logIngest and
// reminder-kick stubs. No real Supabase/Quo/Resend is ever touched.
// Run: node production/appt-intake.test.cjs
'use strict';
const assert = require('assert');
const { processApptIntake, parseApptDate, normApptType } = require('../netlify/functions/pec-appt-intake.cjs');
const { makeDb, makeChecker } = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

const NOW = new Date('2026-07-21T17:00:00Z'); // 10:00 Phoenix

function baseTables(over = {}) {
  return {
    pec_appointments: [],
    leads: [{
      id: 'lead1', full_name: 'Jane Doe', first_name: 'Jane',
      phone: '9285551234', email: 'jane@example.com', stage: 'new',
      sms_consent: true, opted_out: false, customer_id: null,
      contacted_at: null, deleted_at: null,
      created_at: '2026-07-19T15:00:00Z',
    }],
    customers: [{
      id: 'cust1', name: 'Bob Builder', phone: '9285559999',
      email: 'bob@example.com', archived_at: null,
      created_at: '2026-05-01T15:00:00Z',
    }],
    pec_sales_team_members: [
      { id: 'sm1', name: 'Dylan N', google_email: 'dylan@finishingtouchpaintingaz.com', active: true },
      { id: 'sm2', name: 'Aron S', google_email: null, active: true },
    ],
    pec_drip_campaigns: [
      { id: 'camp1', kind: 'lead', status: 'active' },
      { id: 'campE', kind: 'estimate', status: 'active' },
    ],
    pec_drip_enrollments: [
      { id: 'enr1', subject_type: 'lead', subject_id: 'lead1', lead_id: 'lead1', campaign_id: 'camp1', status: 'active', next_send_at: '2026-07-22T16:00:00Z', stop_reason: null, stopped_at: null },
      { id: 'enrE', subject_type: 'lead', subject_id: 'lead1', lead_id: 'lead1', campaign_id: 'campE', status: 'active', next_send_at: '2026-07-22T16:00:00Z', stop_reason: null, stopped_at: null },
    ],
    lead_events: [],
    pec_notifications: [],
    ...over,
  };
}

function stubDeps(fx) {
  const captured = { logs: [], kicks: [] };
  return {
    captured,
    deps: {
      sb: fx.sb,
      now: () => NOW,
      logIngest: async (f) => { captured.logs.push(f); },
      runReminders: async (d, o) => { captured.kicks.push(o.appointmentId); },
    },
  };
}

const CREATED = {
  action: 'created',
  routemize_appt_id: 'rm_100',
  appt_type: 'on_site_estimate',
  customer_name: 'Jane Doe',
  phone: '+1 (928) 555-1234',
  email: 'jane@example.com',
  start_at: '2026-07-23T10:00:00', // bare -> Phoenix
  address: '123 Main St', city: 'Prescott', state: 'AZ', zip: '86301',
  assigned_member_email: 'Dylan@FinishingTouchPaintingAZ.com',
  notes: 'Gate code 4321',
  customer_notes: 'We will text when on the way.',
};

(async () => {
  console.log('# pure helpers: datetime + type normalization');
  {
    ok(parseApptDate('2026-07-23T10:00:00') === '2026-07-23T17:00:00.000Z', 'bare datetime reads as Phoenix (-07:00)');
    ok(parseApptDate('2026-07-23T10:00:00-07:00') === '2026-07-23T17:00:00.000Z', 'explicit offset trusted');
    ok(parseApptDate('2026-07-23T17:00:00Z') === '2026-07-23T17:00:00.000Z', 'Z trusted');
    ok(parseApptDate('2026-07-23') === '2026-07-23T07:00:00.000Z', 'bare date anchors to Phoenix midnight');
    ok(parseApptDate('nonsense') === null && parseApptDate('') === null, 'garbage and empty are null');
    ok(normApptType('Site Visit') === 'site_visit' && normApptType('walkthrough') === 'project_walkthrough', 'labels normalize');
    ok(normApptType('') === 'on_site_estimate' && normApptType('mystery') === 'on_site_estimate', 'unknown defaults to on_site_estimate');
  }

  console.log('# created: insert, lead link, rep by email, side effects');
  {
    const fx = makeDb(baseTables());
    const { deps, captured } = stubDeps(fx);
    const out = await processApptIntake(deps, { ...CREATED });
    ok(out.status === 200 && out.body.created === true, 'created returns 200');
    const appt = fx.db.pec_appointments[0];
    ok(appt && appt.source === 'routemize' && appt.status === 'scheduled' && appt.routemize_appt_id === 'rm_100', 'row lands with source=routemize');
    ok(appt.start_at === '2026-07-23T17:00:00.000Z' && appt.end_at === '2026-07-23T18:00:00.000Z', 'Phoenix start + default 60-min end');
    ok(appt.lead_id === 'lead1', 'lead matched by last-10 phone');
    ok(appt.sales_member_id === 'sm1', 'rep matched by google_email, case-insensitive');
    ok(appt.title === 'Jane Doe' && appt.location_address === '123 Main St' && appt.location_zip === '86301', 'title defaults to customer name; address carried');
    ok(appt.notes === 'Gate code 4321' && appt.customer_notes === 'We will text when on the way.', 'notes split preserved');

    const lead = fx.db.leads[0];
    ok(lead.stage === 'contacted' && lead.contacted_at === NOW.toISOString(), 'new lead advanced to contacted (in-app parity)');
    const ev = fx.db.lead_events.find(e => e.event_type === 'stage_change');
    ok(ev && ev.from_stage === 'new' && ev.to_stage === 'contacted' && ev.payload.appointment_id === appt.id, 'stage_change lead_event written');
    const enr = fx.db.pec_drip_enrollments.find(e => e.id === 'enr1');
    ok(enr.status === 'stopped' && enr.stop_reason === 'appointment_booked' && enr.next_send_at === null, 'nurture drip paused (stopped, reason appointment_booked)');
    ok(fx.db.pec_drip_enrollments.find(e => e.id === 'enrE').status === 'active', 'estimate drip left alone');
    const bell = fx.db.pec_notifications[0];
    ok(bell && bell.type === 'appointment_booked' && /Routemize booked Jane Doe for Dylan N/.test(bell.body), 'staff bell row written');
    ok(!/—/.test(bell.body), 'no em dash in the bell body');
    ok(captured.kicks.length === 1 && captured.kicks[0] === appt.id, 'confirmation kick fired once');
    ok(captured.logs.length === 1 && captured.logs[0].outcome === 'ok' && captured.logs[0].endpoint === 'appt-intake', 'ingest log ok');

    console.log('# created again with the same routemize_appt_id: update, not duplicate');
    const out2 = await processApptIntake(deps, { ...CREATED, start_at: '2026-07-24T09:00:00', notes: 'Moved a day' });
    ok(out2.status === 200 && out2.body.updated === true, 'retry became an update');
    ok(fx.db.pec_appointments.length === 1, 'still one row');
    ok(fx.db.pec_appointments[0].start_at === '2026-07-24T16:00:00.000Z' && /Moved a day/.test(fx.db.pec_appointments[0].notes), 'reschedule applied');
    ok(captured.kicks.length === 1, 'no second confirmation kick on update');
    ok(fx.db.lead_events.filter(e => e.event_type === 'stage_change').length === 1, 'no duplicate stage event');

    console.log('# canceled flips status; deleted behaves the same');
    const out3 = await processApptIntake(deps, { action: 'canceled', routemize_appt_id: 'rm_100' });
    ok(out3.status === 200 && out3.body.canceled === true && fx.db.pec_appointments[0].status === 'canceled', 'canceled sets status=canceled, row kept');
    const out4 = await processApptIntake(deps, { action: 'deleted', routemize_appt_id: 'rm_100' });
    ok(out4.status === 200 && fx.db.pec_appointments.length === 1 && fx.db.pec_appointments[0].status === 'canceled', 'deleted = canceled, never a hard delete');
    const out5 = await processApptIntake(deps, { action: 'canceled', routemize_appt_id: 'rm_nope' });
    ok(out5.status === 200 && out5.body.matched === false, 'cancel of an unknown id is a clean no-op 200');
  }

  console.log('# no contact match: lands unlinked with the contact carried in notes');
  {
    const fx = makeDb(baseTables());
    const { deps, captured } = stubDeps(fx);
    const out = await processApptIntake(deps, {
      routemize_appt_id: 'rm_200', customer_name: 'Stranger Sam',
      phone: '5205550000', start_at: '2026-07-23T14:00:00',
      assigned_member_name: 'Nobody Known',
    });
    ok(out.status === 200 && out.body.created === true, '200 created');
    const appt = fx.db.pec_appointments[0];
    ok(appt.lead_id == null && appt.customer_id == null, 'no auto-created lead/customer, both null');
    ok(appt.title === 'Stranger Sam', 'customer name kept as the title');
    ok(/Routemize contact/.test(appt.notes) && /5205550000/.test(appt.notes), 'phone carried in internal notes');
    ok(appt.sales_member_id == null && /rep not matched/.test(appt.notes), 'unmatched rep leaves it unassigned and notes it');
    ok(fx.db.leads.length === 1 && fx.db.customers.length === 1, 'nothing was auto-created');
    ok(captured.kicks.length === 1, 'confirmation kick still fires (engine skips no-contact legs itself)');
  }

  console.log('# customer fallback + rep by name + type default');
  {
    const fx = makeDb(baseTables());
    const { deps } = stubDeps(fx);
    const out = await processApptIntake(deps, {
      routemize_appt_id: 'rm_300', customer_name: 'Bob Builder',
      phone: '(928) 555-9999', start_at: '2026-07-25T08:00:00',
      assigned_member_name: 'aron s',
    });
    ok(out.status === 200, '200');
    const appt = fx.db.pec_appointments[0];
    ok(appt.lead_id == null && appt.customer_id === 'cust1', 'no lead, so the customer matched by phone links');
    ok(appt.sales_member_id === 'sm2', 'rep matched by name, case-insensitive');
    ok(appt.appt_type === 'on_site_estimate', 'missing appt_type defaults');
  }

  console.log('# validation + already-linked update keeps the manual link');
  {
    const fx = makeDb(baseTables());
    const { deps, captured } = stubDeps(fx);
    const bad1 = await processApptIntake(deps, { action: 'created', start_at: '2026-07-23T10:00:00' });
    ok(bad1.status === 400 && captured.logs[0].outcome === 'rejected', 'missing routemize_appt_id -> 400, logged rejected');
    const bad2 = await processApptIntake(deps, { routemize_appt_id: 'rm_x' });
    ok(bad2.status === 400, 'missing start_at on created -> 400');
    const bad3 = await processApptIntake(deps, { action: 'exploded', routemize_appt_id: 'rm_x' });
    ok(bad3.status === 400, 'unknown action -> 400');

    // A staff-linked row: an update whose payload matches a DIFFERENT lead
    // must not clobber the hand-set link, and google_* stays untouched.
    fx.db.pec_appointments.push({
      id: 'apptG', routemize_appt_id: 'rm_400', appt_type: 'site_visit',
      title: 'Manual link', lead_id: 'leadManual', customer_id: null,
      sales_member_id: null, start_at: '2026-07-26T17:00:00.000Z',
      end_at: '2026-07-26T18:00:00.000Z', all_day: false, status: 'scheduled',
      source: 'routemize', google_event_id: 'gev9', google_calendar_id: 'cal9',
      notes: null, created_at: '2026-07-20T00:00:00Z',
    });
    const upd = await processApptIntake(deps, {
      action: 'updated', routemize_appt_id: 'rm_400',
      phone: '9285551234', start_at: '2026-07-27T09:00:00',
    });
    ok(upd.status === 200 && upd.body.updated === true, 'update matched by routemize_appt_id');
    const row = fx.db.pec_appointments.find(a => a.id === 'apptG');
    ok(row.lead_id === 'leadManual', 'existing lead link never clobbered');
    ok(row.google_event_id === 'gev9' && row.google_calendar_id === 'cal9', 'google_* columns untouched');
    ok(row.start_at === '2026-07-27T16:00:00.000Z' && row.status === 'scheduled', 'time moved, still scheduled');
    ok(row.appt_type === 'on_site_estimate', 'update with no appt_type falls to the default (Zapier maps it when it matters)');
  }

  console.log('# updated with no existing row: upsert-safe insert');
  {
    const fx = makeDb(baseTables());
    const { deps } = stubDeps(fx);
    const out = await processApptIntake(deps, {
      action: 'updated', routemize_appt_id: 'rm_500',
      customer_name: 'Jane Doe', phone: '9285551234',
      start_at: '2026-07-28T13:00:00',
    });
    ok(out.status === 200 && out.body.created === true, 'missing row on updated inserts instead');
    ok(fx.db.pec_appointments[0].lead_id === 'lead1' && fx.db.pec_appointments[0].source === 'routemize', 'inserted row fully linked');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  if (state.failed) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
