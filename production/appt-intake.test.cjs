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
      { id: 'smA', name: 'Aron Bronson', google_email: 'aron@prescottepoxy.com', active: true },
    ],
    settings: [
      { id: 'setR', key: 'routemize_service_type_map', value: '{"estimate":"on_site_estimate","walkthrough":"project_walkthrough"}' },
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
    ok(appt.title === 'On-site estimate for Jane Doe' && appt.location_address === '123 Main St' && appt.location_zip === '86301', 'title auto-derives "{Type label} for {Name}" (prompt 89); address carried');
    ok(appt.notes === 'Gate code 4321' && appt.customer_notes === 'We will text when on the way.', 'notes split preserved');

    const lead = fx.db.leads[0];
    ok(lead.stage === 'estimate_scheduled' && lead.estimate_scheduled_at === NOW.toISOString(), 'new lead advanced to estimate_scheduled (in-app parity)');
    ok(lead.contacted_at === NOW.toISOString(), 'contacted_at stamped too (a booked visit proves contact)');
    const ev = fx.db.lead_events.find(e => e.event_type === 'stage_change');
    ok(ev && ev.from_stage === 'new' && ev.to_stage === 'estimate_scheduled' && ev.payload.appointment_id === appt.id, 'stage_change lead_event written');
    const enr = fx.db.pec_drip_enrollments.find(e => e.id === 'enr1');
    ok(enr.status === 'stopped' && enr.stop_reason === 'appointment_booked' && enr.next_send_at === null, 'nurture drip paused (stopped, reason appointment_booked)');
    ok(fx.db.pec_drip_enrollments.find(e => e.id === 'enrE').status === 'active', 'estimate drip left alone');
    const bell = fx.db.pec_notifications[0];
    ok(bell && bell.type === 'appointment_booked' && /Routemize booked On-site estimate for Jane Doe, assigned to Dylan N/.test(bell.body), 'staff bell row written');
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
    ok(fx.db.leads[0].stage === 'contacted', 'cancellation walks the estimate_scheduled lead back to contacted');
    const backEv = fx.db.lead_events.find(e => e.event_type === 'stage_change' && e.to_stage === 'contacted');
    ok(backEv && backEv.from_stage === 'estimate_scheduled' && backEv.payload.via === 'appointment_canceled', 'walk-back stage_change event carries via appointment_canceled');
    const out4 = await processApptIntake(deps, { action: 'deleted', routemize_appt_id: 'rm_100' });
    ok(out4.status === 200 && fx.db.pec_appointments.length === 1 && fx.db.pec_appointments[0].status === 'canceled', 'deleted = canceled, never a hard delete');
    const out5 = await processApptIntake(deps, { action: 'canceled', routemize_appt_id: 'rm_nope' });
    ok(out5.status === 200 && out5.body.matched === false, 'cancel of an unknown id is a clean no-op 200');
  }

  console.log('# prompt 59: contacted lead advances without rewriting contacted_at');
  {
    const earlier = '2026-07-20T12:00:00.000Z';
    const fx = makeDb(baseTables({ leads: [{ ...baseTables().leads[0], stage: 'contacted', contacted_at: earlier }] }));
    const { deps } = stubDeps(fx);
    await processApptIntake(deps, { ...CREATED });
    const lead = fx.db.leads[0];
    ok(lead.stage === 'estimate_scheduled' && lead.estimate_scheduled_at === NOW.toISOString(), 'contacted lead advanced to estimate_scheduled');
    ok(lead.contacted_at === earlier, 'contacted_at NOT rewritten (first touch wins)');
    const ev = fx.db.lead_events.find(e => e.event_type === 'stage_change');
    ok(ev && ev.from_stage === 'contacted' && ev.to_stage === 'estimate_scheduled', 'event carries the real from_stage');
  }

  console.log('# prompt 59: a lead at estimate_sent is untouched by a booking');
  {
    const fx = makeDb(baseTables({ leads: [{ ...baseTables().leads[0], stage: 'estimate_sent', contacted_at: '2026-07-20T12:00:00.000Z' }] }));
    const { deps } = stubDeps(fx);
    await processApptIntake(deps, { ...CREATED });
    const lead = fx.db.leads[0];
    ok(lead.stage === 'estimate_sent' && lead.estimate_scheduled_at == null, 'estimate_sent lead keeps its stage, no timestamp faked');
    ok(!fx.db.lead_events.some(e => e.event_type === 'stage_change'), 'no stage_change event when nothing flipped');
  }

  console.log('# prompt 59: canceling one of TWO scheduled estimates leaves the stage alone');
  {
    const fx = makeDb(baseTables());
    const { deps } = stubDeps(fx);
    await processApptIntake(deps, { ...CREATED });
    await processApptIntake(deps, { ...CREATED, routemize_appt_id: 'rm_101', start_at: '2026-07-25T10:00:00' });
    ok(fx.db.pec_appointments.length === 2, 'two scheduled on-site estimates on the lead');
    ok(fx.db.leads[0].stage === 'estimate_scheduled', 'lead sits in estimate_scheduled');
    await processApptIntake(deps, { action: 'canceled', routemize_appt_id: 'rm_100' });
    ok(fx.db.leads[0].stage === 'estimate_scheduled', 'reschedule guard: a second scheduled visit keeps the stage');
    await processApptIntake(deps, { action: 'canceled', routemize_appt_id: 'rm_101' });
    ok(fx.db.leads[0].stage === 'contacted', 'canceling the LAST scheduled estimate walks the lead back');
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
    ok(appt.title === 'On-site estimate for Stranger Sam', 'unmatched contact still derives the auto-title');
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

  // -------------------------------------------------------------------------
  // Routemize NATIVE envelope (prompt 56). The shape below mirrors the real
  // AppointmentCreated captured from Routemize's own DripJobs delivery log.
  // -------------------------------------------------------------------------
  function rzEnvelope(over = {}, dataOver = {}) {
    return {
      eventId: '58289007-04c2-459e-bfa8-1bd566c06699',
      eventType: 'AppointmentCreated',
      timestamp: '2026-07-28T20:32:25.866442Z',
      tenantId: 'f99ef972-3ac5-cc90-51f5-3a217775511f',
      apiVersion: 'v1',
      data: {
        relatedEntityId: '5ce70ae6-da0e-96da-1729-3a22bc9a90e6',
        relatedEntityType: 'Appointment',
        startTime: '2026-07-29T15:00:00Z',
        endTime: '2026-07-29T16:00:00Z',
        contactName: 'John Courtis',
        contact: {
          contactId: '6e43abf5-aaaa-bbbb-cccc-ddddeeee0001',
          firstName: 'John', lastName: 'Courtis',
          email: 'john.courtis@example.com', phoneNumber: '+1 (928) 555-7777',
          businessName: null, leadSource: 'Other', leadSourceText: 'Google',
        },
        address: { addressLine1: '100 Desert Rd', addressLine2: null, city: 'DEWEY', state: 'AZ', zipCode: '86327-5311', latitude: 34.6, longitude: -112.2 },
        serviceName: 'Estimate',
        eventTypeId: 'evtype-1',
        appointmentTitle: 'Meeting with - John',
        assignedUsers: [{ userId: 'u1', firstName: 'Aron', lastName: 'Bronson', email: 'aron.personal@gmail.com', userName: 'aron@prescottepoxy.com' }],
        customerAnswers: [
          { questionId: 'q1', question: 'What type of project?', answer: 'Epoxy Patio / Pool Deck', attachments: [] },
          { questionId: 'q2', question: 'Anything else?', answer: 'Cool deck on the back patio', attachments: [] },
        ],
        customQuestions: [],
        Template: { AppointmentId: '5ce70ae6-da0e-96da-1729-3a22bc9a90e6', AppointmentNotes: '' },
        ...dataOver,
      },
      metadata: { actorName: 'Booking Form', sourceIp: '1.2.3.4', userAgent: 'Routemize', additionalData: null },
      ...over,
    };
  }

  console.log('# routemize native: create + lead creation + replay idempotency (verify 2/3/5)');
  {
    const fx = makeDb(baseTables());
    const { deps, captured } = stubDeps(fx);
    const out = await processApptIntake(deps, rzEnvelope());
    ok(out.status === 200 && out.body.created === true, 'native AppointmentCreated returns 200 created');
    const appt = fx.db.pec_appointments[0];
    ok(appt && appt.source === 'routemize' && appt.routemize_appt_id === '5ce70ae6-da0e-96da-1729-3a22bc9a90e6', 'row lands keyed on relatedEntityId');
    ok(appt.start_at === '2026-07-29T15:00:00.000Z' && appt.end_at === '2026-07-29T16:00:00.000Z', 'explicit Z trusted: 15:00Z stays 15:00Z, not shifted');
    ok(appt.appt_type === 'on_site_estimate', 'serviceName Estimate mapped via the settings map');
    ok(appt.title === 'On-site estimate for John Courtis', 'auto-title format, appointmentTitle ignored');
    ok(appt.sales_member_id === 'smA', 'rep resolved by assignedUsers[0].userName against google_email');
    ok(/What type of project\?: Epoxy Patio \/ Pool Deck/.test(appt.customer_notes) && /Cool deck/.test(appt.customer_notes), 'customerAnswers land as Q&A pairs in customer_notes');
    ok(appt.location_address === '100 Desert Rd' && appt.location_city === 'DEWEY' && appt.location_zip === '86327-5311', 'address block carried');

    const lead = fx.db.leads.find(l => l.full_name === 'John Courtis');
    ok(!!lead && fx.db.leads.length === 2, 'exactly ONE lead created for the unmatched booker (decision 9)');
    ok(appt.lead_id === lead.id, 'appointment linked to the created lead');
    ok(lead.source === 'google', "lead source is Routemize's own (leadSourceText slug), person-level");
    // Prompt 89: the lead is born hanging off a customer row, and the
    // appointment carries the same customer link.
    const cust = fx.db.customers.find(c => c.name === 'John Courtis');
    ok(!!cust && lead.customer_id === cust.id, 'customer row created and lead born linked to it (prompt 89)');
    ok(cust.lead_source === 'google' && cust.company === 'prescott-epoxy', 'customer carries lead_source and PEC company');
    ok(appt.customer_id === cust.id, 'appointment linked to the customer too');
    ok(lead.routemize_contact_id === '6e43abf5-aaaa-bbbb-cccc-ddddeeee0001' && lead.source_ref === '6e43abf5-aaaa-bbbb-cccc-ddddeeee0001', 'contact.contactId stored on the created lead');
    ok(lead.sms_consent === false, 'consent never inferred from a booking');
    ok(lead.stage === 'estimate_scheduled', 'created at new, then advanced by apptBookingLeadEffects like an in-app booking');
    ok(fx.db.lead_events.some(e => e.lead_id === lead.id && e.event_type === 'created' && e.payload.via === 'routemize_booking'), "created lead_event written with via 'routemize_booking'");
    ok(fx.db.lead_events.some(e => e.lead_id === lead.id && e.event_type === 'stage_change'), 'stage_change event from the booking effects');
    ok(!fx.db.pec_drip_enrollments.some(e => e.lead_id === lead.id), 'created lead NOT nurture-enrolled (landmine 3: no enroll-then-pause churn)');
    ok(captured.logs[0].outcome === 'ok' && captured.logs[0].payload.eventType === 'AppointmentCreated', 'ingest log carries the RAW envelope, not the mapping');

    const out2 = await processApptIntake(deps, rzEnvelope());
    ok(out2.status === 200 && out2.body.updated === true, 'replay of the same envelope updates');
    ok(fx.db.pec_appointments.length === 1, 'still one appointment');
    ok(fx.db.leads.length === 2, 'replay did NOT create a second lead (verify 5)');
    ok(fx.db.lead_events.filter(e => e.event_type === 'created').length === 1, 'no duplicate created event');

    console.log('# routemize native: AppointmentCancelled + dotted-lowercase casing');
    const out3 = await processApptIntake(deps, rzEnvelope({ eventType: 'appointment.cancelled' }));
    ok(out3.status === 200 && fx.db.pec_appointments[0].status === 'canceled', 'cancelled (any casing) flips status to canceled');
  }

  console.log('# routemize native: unknown eventType is a 200 no-op (verify 4)');
  {
    const fx = makeDb(baseTables());
    const { deps, captured } = stubDeps(fx);
    const out = await processApptIntake(deps, {
      eventId: 'x', eventType: 'test.webhook', timestamp: '2026-07-29T00:00:00Z',
      tenantId: 't', apiVersion: 'v1', data: { message: 'This is a test' },
    });
    ok(out.status === 200 && out.body.ignored === true, 'test.webhook returns 200 ignored, never a 4xx');
    ok(fx.db.pec_appointments.length === 0 && fx.db.leads.length === 1, 'nothing written');
    ok(captured.logs.length === 1 && captured.logs[0].outcome === 'ok', 'still logged for Sync Health');
    const out2 = await processApptIntake(deps, rzEnvelope({ eventType: 'ContactCreated' }));
    ok(out2.status === 200 && out2.body.ignored === true && fx.db.pec_appointments.length === 0, 'other entity events are ignored too');
  }

  console.log('# routemize native: existing lead links, source fill-if-blank only (verify 6)');
  {
    const fx = makeDb(baseTables());
    fx.db.leads[0].source = 'meta'; // attribution already set
    const { deps } = stubDeps(fx);
    const env = rzEnvelope({}, {
      contactName: 'Jane Doe',
      contact: { contactId: 'rz-contact-jane', firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phoneNumber: '928-555-1234', leadSource: 'Other', leadSourceText: 'Google' },
    });
    const out = await processApptIntake(deps, env);
    ok(out.status === 200 && out.body.created === true, '200 created');
    ok(fx.db.leads.length === 1, 'no new lead: matched the existing one');
    ok(fx.db.pec_appointments[0].lead_id === 'lead1', 'linked to the matched lead');
    ok(fx.db.leads[0].source === 'meta', 'an already-set source is NEVER overwritten (decision 10)');
    ok(fx.db.leads[0].routemize_contact_id === 'rz-contact-jane', 'contactId stored on the matched lead');
    ok(fx.db.lead_events.some(e => e.lead_id === 'lead1' && e.event_type === 'note' && e.payload.via === 'routemize_booking'), 'booking note lands on the existing lead timeline (landmine 2)');

    // Blank source fills exactly once.
    const fx2 = makeDb(baseTables());
    fx2.db.leads[0].source = null;
    const d2 = stubDeps(fx2);
    await processApptIntake(d2.deps, env);
    ok(fx2.db.leads[0].source === 'google', 'a blank source is filled from Routemize');
  }

  console.log('# routemize native: customer fallback stores contactId, creates no lead');
  {
    const fx = makeDb(baseTables());
    const { deps } = stubDeps(fx);
    const out = await processApptIntake(deps, rzEnvelope({}, {
      contactName: 'Bob Builder',
      contact: { contactId: 'rz-contact-bob', firstName: 'Bob', lastName: 'Builder', email: 'nomatch@example.com', phoneNumber: '928-555-9999', leadSource: null, leadSourceText: null },
    }));
    ok(out.status === 200, '200');
    ok(fx.db.pec_appointments[0].customer_id === 'cust1' && fx.db.pec_appointments[0].lead_id == null, 'customer matched by phone, no lead');
    ok(fx.db.leads.length === 1, 'a matched CUSTOMER suppresses lead creation (already in the pipeline)');
    ok(fx.db.customers[0].routemize_contact_id === 'rz-contact-bob', 'contactId stored on the customer');
  }

  console.log('# routemize native: StatusChanged read defensively (landmine 5)');
  {
    const fx = makeDb(baseTables());
    const { deps } = stubDeps(fx);
    await processApptIntake(deps, rzEnvelope());
    const apptId = fx.db.pec_appointments[0].id;

    // Unknown shape: NO status field, NO times. Must never cancel, never 4xx.
    const mystery = rzEnvelope({ eventType: 'AppointmentStatusChanged' }, { startTime: null, endTime: null, contact: {}, contactName: null, assignedUsers: [], customerAnswers: [] });
    const out1 = await processApptIntake(deps, mystery);
    ok(out1.status === 200 && out1.body.updated === true, 'undeterminable status change is a 200 update');
    const row = fx.db.pec_appointments.find(a => a.id === apptId);
    ok(row.status === 'scheduled', 'NEVER treated as a cancellation');
    ok(/no readable status/.test(row.notes || ''), 'ambiguity noted in the internal notes');

    // A cancel-ish status value cancels.
    const out2 = await processApptIntake(deps, rzEnvelope({ eventType: 'AppointmentStatusChanged' }, { status: 'Cancelled By Customer' }));
    ok(out2.status === 200 && fx.db.pec_appointments.find(a => a.id === apptId).status === 'canceled', 'cancel-ish status value cancels the booking');

    // A non-cancel status with full data patches as an update and re-lives it.
    const out3 = await processApptIntake(deps, rzEnvelope({ eventType: 'AppointmentStatusChanged' }, { status: 'Confirmed' }));
    const row3 = fx.db.pec_appointments.find(a => a.id === apptId);
    ok(out3.status === 200 && row3.status === 'scheduled' && /status changed to "Confirmed"/.test(row3.notes || ''), 'non-cancel status is an update with the status noted');
  }

  console.log('# routemize native: pre-migration column tolerance (landmine 8)');
  {
    const fx = makeDb(baseTables());
    // Simulate PROD before Cowork applies 2026-08-01_routemize_contact_id.sql:
    // any write touching the column fails like PostgREST would.
    const rawSb = fx.sb;
    const guardedSb = async (method, path, payload, ret) => {
      if ((payload && 'routemize_contact_id' in payload) || /routemize_contact_id/.test(path)) {
        throw new Error(`Supabase ${method} ${path} failed (400): column "routemize_contact_id" does not exist`);
      }
      return rawSb(method, path, payload, ret);
    };
    const captured = { logs: [] };
    const out = await processApptIntake({
      sb: guardedSb, now: () => NOW,
      logIngest: async (f) => { captured.logs.push(f); },
      runReminders: async () => {},
    }, rzEnvelope());
    ok(out.status === 200 && out.body.created === true, 'intake still succeeds with the column absent');
    ok(fx.db.leads.length === 2 && !('routemize_contact_id' in fx.db.leads[1]), 'lead still created, just without the column');
    ok(fx.db.pec_appointments.length === 1 && fx.db.pec_appointments[0].lead_id === fx.db.leads[1].id, 'appointment linked normally');
  }

  console.log('# routemize native: settings map drives appt_type, unmapped defaults');
  {
    const fx = makeDb(baseTables());
    const { deps } = stubDeps(fx);
    await processApptIntake(deps, rzEnvelope({}, { serviceName: 'Walkthrough', relatedEntityId: 'rz-appt-w' }));
    ok(fx.db.pec_appointments[0].appt_type === 'project_walkthrough', 'mapped service uses its configured type');
    await processApptIntake(deps, rzEnvelope({}, { serviceName: 'Mystery Service', relatedEntityId: 'rz-appt-m', contact: { contactId: 'c9', firstName: 'Al', lastName: 'B', email: 'al@example.com', phoneNumber: '5205551111' }, contactName: 'Al B' }));
    const m = fx.db.pec_appointments.find(a => a.routemize_appt_id === 'rz-appt-m');
    ok(m.appt_type === 'on_site_estimate', 'unmapped service defaults to on_site_estimate');
    ok(m.title === 'On-site estimate for Al B', 'unmapped service: auto-title from the defaulted type');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  if (state.failed) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
