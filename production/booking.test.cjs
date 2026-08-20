'use strict';
// Prompt 101 Parts D/E5/F: the booking endpoint's write path, service-area
// matcher, question routing, consent, abuse control, the manage actions, and
// the concurrent double-book proof. Drives the REAL processBook /
// processManage / processOutOfAreaLead from netlify/functions/pec-booking.cjs
// against the shared mini-PostgREST (production/_drip-test-kit.cjs), with the
// Postgres advisory-lock function replaced by a stub that enforces the SAME
// semantics synchronously (check-then-insert over the shared table is atomic
// in single-threaded JS, which is exactly the property the real function
// gets from pg_advisory_xact_lock).
// Run: node production/booking.test.cjs

const {
  processBook, processSlots, processOutOfAreaLead, processManage,
  checkArea, routeAnswers,
} = require('../netlify/functions/pec-booking.cjs');
const { makeDb } = require('./_drip-test-kit.cjs');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${label}`); }
}

// Monday 2026-08-24 07:00 Phoenix. The booked slot: Tuesday 10:00 Phoenix.
const NOW = new Date('2026-08-24T14:00:00Z');
const SLOT_TUE_10 = '2026-08-25T17:00:00.000Z';
const REP = 'aaaaaaaa-0000-0000-0000-000000000001';

const QUESTIONS = [
  { id: 'quote_type', label: 'What are we quoting?', type: 'choice', required: false, routing: 'internal', options: ['Garage floor', 'Other'] },
  { id: 'sqft', label: 'Roughly how many square feet?', type: 'short_text', required: true, routing: 'internal' },
  { id: 'project', label: 'Tell us about the project', type: 'long_text', required: false, routing: 'customer' },
  { id: 'how_heard', label: 'How did you hear about us?', type: 'choice', required: false, routing: 'drop', maps_to: 'lead_source', options: ['Google', 'Referral'] },
];

function baseTables(over = {}) {
  return {
    settings: [
      { key: 'booking_enabled', value: 'true' },
      { key: 'booking_min_notice_minutes', value: '120' },
      { key: 'booking_horizon_days', value: '14' },
      { key: 'booking_rate_limit_per_hour', value: '5' },
      { key: 'booking_min_fill_seconds', value: '2' },
      { key: 'booking_duplicate_window_hours', value: '24' },
      { key: 'booking_sms_disclosure', value: 'TEST DISCLOSURE: texts from PEC, STOP to opt out.' },
      { key: 'booking_manage_link_text', value: 'Change it: {link}' },
      { key: 'booking_drive_time_enabled', value: 'false' },
    ],
    pec_booking_forms: [{
      id: 'form1', slug: 'pec', brand: 'PEC', name: 'PEC', active: true,
      success_message: 'You are booked!',
      appt_types: [{ key: 'on_site_estimate', label: 'On-site estimate', duration_minutes: 60 }],
      questions: QUESTIONS,
    }],
    pec_booking_service_areas: [
      { id: 'sa1', form_id: 'form1', zip: '86301', city: 'Prescott', active: true },
      { id: 'sa2', form_id: 'form1', zip: null, city: 'Chino Valley', active: true },
    ],
    pec_booking_requests: [],
    pec_sales_team_members: [{ id: REP, name: 'Dylan', active: true }],
    pec_appointments: [],
    leads: [],
    customers: [],
    lead_events: [],
    pec_lead_sources: [{ name: 'Google', aliases: ['google'] }],
    pec_notifications: [],
    pec_drip_enrollments: [],
    pec_drip_campaigns: [],
    pec_email_senders: [],
    ...over,
  };
}

// The advisory-lock function's semantics over the fixture table: overlap
// re-check with buffers, insert-if-clear, reschedule updates times only.
// Synchronous check+insert = atomic under interleaved async callers.
function makeBookSlotStub(db) {
  return (row, bufBefore, bufAfter, reschedId) => {
    const s = new Date(row.start_at).getTime();
    const e = new Date(row.end_at).getTime();
    const member = row.sales_member_id || null;
    const conflict = db.pec_appointments.some(a => a.status === 'scheduled'
      && (!member || a.sales_member_id === member)
      && (!reschedId || a.id !== reschedId)
      && new Date(a.start_at).getTime() < e + (bufAfter || 0) * 60000
      && new Date(a.end_at).getTime() > s - (bufBefore || 0) * 60000);
    if (conflict) return Promise.resolve({ ok: false, taken: true });
    if (reschedId) {
      const a = db.pec_appointments.find(x => x.id === reschedId && x.status === 'scheduled');
      if (!a) return Promise.resolve({ ok: false, error: 'not_found' });
      a.start_at = row.start_at; a.end_at = row.end_at;
      return Promise.resolve({ ok: true, appointment_id: a.id });
    }
    const id = 'appt-' + (db.pec_appointments.length + 1);
    db.pec_appointments.push({
      id, appt_type: row.appt_type || 'on_site_estimate', title: row.title || null,
      lead_id: row.lead_id || null, customer_id: row.customer_id || null,
      sales_member_id: member, start_at: row.start_at, end_at: row.end_at,
      all_day: false, status: 'scheduled', source: 'booking',
      location_address: row.location_address || null, location_city: row.location_city || null,
      location_state: row.location_state || null, location_zip: row.location_zip || null,
      notes: row.notes || null, customer_notes: row.customer_notes || null,
      booking_manage_token: row.booking_manage_token || null,
      booking_request_id: row.booking_request_id || null,
    });
    return Promise.resolve({ ok: true, appointment_id: id });
  };
}

function makeDeps(fx, over = {}) {
  const pushed = [], reminded = [], logged = [], scored = [];
  return {
    deps: {
      sb: fx.sb,
      logIngest: async (f) => { logged.push(f); },
      now: () => NOW,
      drive: async () => ({}),
      bookSlot: makeBookSlotStub(fx.db),
      kickPush: async (id) => { pushed.push(id); },
      runReminders: async (d, o) => { reminded.push(o.appointmentId); },
      kickLeadAi: async (id) => { scored.push(id); },
      sendSms: async () => ({ ok: true, id: 'sms1' }),
      sendEmail: async () => ({ ok: true, id: 'em1' }),
      ...over,
    },
    spies: { pushed, reminded, logged, scored },
  };
}

const goodBody = (over = {}) => ({
  form: 'pec', start: SLOT_TUE_10,
  name: 'Jane Doe', phone: '(928) 555-1212', email: 'jane@example.com',
  address1: '123 N Test St', city: 'Prescott', zip: '86301',
  answers: { quote_type: 'Garage floor', sqft: '450', project: 'Two car garage', how_heard: 'Google' },
  sms_consent: 'true', website: '', fill_ms: 45000,
  ...over,
});

(async () => {
  // ---- checkArea: zip first, city case-insensitive, else out ---------------
  {
    const area = [{ zip: '86301', city: 'Prescott' }, { zip: null, city: 'Chino Valley' }];
    ok(checkArea(area, '86301', null).inArea === true, 'area: zip match');
    ok(checkArea(area, '86301-4321', null).inArea === true, 'area: zip+4 matches on the 5');
    ok(checkArea(area, null, 'chino valley').inArea === true, 'area: city match is case-insensitive');
    ok(checkArea(area, '99999', 'Phoenix').inArea === false, 'area: miss is out of area');
  }

  // ---- routeAnswers: internal never reaches customer, drop drops -----------
  {
    const r = routeAnswers(QUESTIONS, { quote_type: 'Garage floor', sqft: '450', project: 'Big garage', how_heard: 'Google' });
    ok(r.internal.join('\n').includes('450') && !r.customer.join('\n').includes('450'),
      'routing: internal-routed answer never reaches the customer stream');
    ok(r.customer.join('\n').includes('Big garage'), 'routing: customer-routed answer lands customer-side');
    ok(!r.customer.join('\n').includes('Google') && !r.internal.join('\n').includes('How did you hear'),
      'routing: dropped answer reaches neither note');
    ok(r.leadSourceAnswer === 'Google', 'routing: maps_to lead_source captured');
    const miss = routeAnswers(QUESTIONS, { project: 'x' });
    ok(miss.missingRequired.length === 1 && /square feet/i.test(miss.missingRequired[0]),
      'routing: missing required question reported');
  }

  // ---- Happy path: the full write mirror -----------------------------------
  {
    const fx = makeDb(baseTables());
    const { deps, spies } = makeDeps(fx);
    const out = await processBook(deps, goodBody(), { ipHash: 'ip1', userAgent: 'test' });
    ok(out.status === 200 && out.body.ok === true, `book: 200 ok (got ${out.status} ${JSON.stringify(out.body).slice(0, 120)})`);
    ok(fx.db.pec_appointments.length === 1, 'book: exactly one appointment row');
    const appt = fx.db.pec_appointments[0];
    ok(appt.source === 'booking' && appt.status === 'scheduled', 'book: source booking, scheduled');
    ok(appt.title === 'On-site estimate for Jane Doe', 'book: the one auto-title format');
    ok(/450/.test(appt.notes || '') && !/450/.test(appt.customer_notes || ''),
      'book: internal answer in notes, NEVER in customer_notes');
    ok(/Big|Two car garage/.test(appt.customer_notes || ''), 'book: customer answer rides customer_notes');
    const lead = fx.db.leads[0];
    ok(!!lead && lead.sms_consent === true && lead.sms_consent_source === 'online booking form',
      'book: created lead carries explicit consent');
    ok(lead.source === 'Google', 'book: how-did-you-hear maps to the managed lead source');
    ok(lead.stage === 'estimate_scheduled', 'book: stage advanced to estimate_scheduled');
    ok(fx.db.customers.length === 1 && lead.customer_id === fx.db.customers[0].id, 'book: lead born linked to its customer');
    const req = fx.db.pec_booking_requests.find(r => r.status === 'booked');
    ok(!!req && req.appointment_id === appt.id && req.sms_consent === true
      && /TEST DISCLOSURE/.test(req.sms_consent_disclosure || ''),
      'book: booked request row with the exact disclosure stored');
    ok(fx.db.lead_events.some(e => e.event_type === 'created'
      && e.payload && /TEST DISCLOSURE/.test(e.payload.sms_consent_disclosure || '')),
      'book: disclosure stored on the lead event too');
    ok(fx.db.pec_notifications.some(n => n.type === 'appointment_booked' && /Online booking/.test(n.body)), 'book: bell rang');
    ok(spies.reminded.length === 1 && spies.reminded[0] === appt.id, 'book: confirmation kicked the intake way');
    ok(spies.pushed.includes(appt.id), 'book: Google push kicked');
    ok(spies.scored.length === 1, 'book: new lead scored');
    ok(out.body.manage_url && out.body.manage_url.includes(appt.booking_manage_token), 'book: manage link returned');
    ok(spies.logged.some(l => l.endpoint === 'booking' && l.outcome === 'ok'), 'book: ingest-logged as booking/ok');

    // Duplicate guard: same phone, same type, inside the window.
    const dup = await processBook(deps, goodBody(), { ipHash: 'ip1' });
    ok(dup.status === 200 && dup.body.duplicate === true && dup.body.manage_url === out.body.manage_url,
      'duplicate: returns the EXISTING appointment and manage link');
    ok(fx.db.pec_appointments.length === 1, 'duplicate: no second appointment row');
    ok(fx.db.pec_booking_requests.some(r => r.status === 'rejected' && r.error_text === 'duplicate'),
      'duplicate: rejected row recorded');
  }

  // ---- Consent unchecked is a valid booking --------------------------------
  {
    const fx = makeDb(baseTables());
    const { deps } = makeDeps(fx);
    const out = await processBook(deps, goodBody({ sms_consent: '' }), { ipHash: 'ip2' });
    ok(out.status === 200 && fx.db.leads[0] && fx.db.leads[0].sms_consent === false
      && fx.db.leads[0].sms_consent_at == null,
      'consent: unchecked books fine and stays email-only');
  }

  // ---- Existing lead: consent upgrade, source fill-if-blank, no new lead ---
  {
    const fx = makeDb(baseTables({
      leads: [{ id: 'lead1', full_name: 'Jane Doe', phone: '9285551212', email: 'jane@example.com', stage: 'contacted', source: null, customer_id: 'cust1', sms_consent: false, opted_out: false, deleted_at: null, created_at: '2026-08-01T00:00:00Z' }],
      customers: [{ id: 'cust1', name: 'Jane Doe', phone: '9285551212', created_at: '2026-08-01T00:00:00Z' }],
    }));
    const { deps, spies } = makeDeps(fx);
    const out = await processBook(deps, goodBody(), { ipHash: 'ip3' });
    ok(out.status === 200 && fx.db.leads.length === 1, 'existing lead: matched, not duplicated');
    ok(fx.db.leads[0].sms_consent === true, 'existing lead: consent upgraded from the checkbox');
    ok(fx.db.leads[0].source === 'Google', 'existing lead: blank source filled, never overwritten');
    ok(fx.db.leads[0].stage === 'estimate_scheduled', 'existing lead: stage advanced');
    ok(spies.scored.length === 0, 'existing lead: no AI kick (creation-only, the intake rule)');
    ok(fx.db.lead_events.some(e => e.event_type === 'note' && /Booked online/.test((e.payload || {}).text || '')),
      'existing lead: booked-again timeline note');
  }

  // ---- Abuse: honeypot, fill time, rate limit ------------------------------
  {
    const fx = makeDb(baseTables());
    const { deps } = makeDeps(fx);
    const hp = await processBook(deps, goodBody({ website: 'http://spam.example' }), { ipHash: 'ip4' });
    ok(hp.status === 200 && hp.body.ok === true && fx.db.pec_appointments.length === 0,
      'honeypot: bot sees success, nothing booked');
    ok(fx.db.pec_booking_requests.some(r => r.status === 'rejected' && r.error_text === 'honeypot'),
      'honeypot: rejected row recorded');

    const fast = await processBook(deps, goodBody({ fill_ms: 900 }), { ipHash: 'ip4' });
    ok(fast.status === 400 && fx.db.pec_booking_requests.some(r => r.error_text === 'too_fast'),
      'fill time: sub-2s submit rejected and recorded');
  }
  {
    const hourAgoPlus = new Date(NOW.getTime() - 30 * 60000).toISOString();
    const fx = makeDb(baseTables({
      pec_booking_requests: Array.from({ length: 5 }, (_, i) => ({
        id: 'r' + i, status: 'booked', ip_hash: 'hot-ip', created_at: hourAgoPlus, phone: '111000111' + i,
      })),
    }));
    const { deps } = makeDeps(fx);
    const out = await processBook(deps, goodBody(), { ipHash: 'hot-ip' });
    ok(out.status === 429 && fx.db.pec_appointments.length === 0
      && fx.db.pec_booking_requests.some(r => r.error_text === 'rate_limit'),
      'rate limit: sixth booking in the hour is refused and recorded');
  }

  // ---- Out of area: no slots path, lead captured ---------------------------
  {
    const fx = makeDb(baseTables());
    const { deps } = makeDeps(fx);
    const slots = await processSlots(deps, { form: 'pec', address1: '9 Far Away Rd', city: 'Phoenix', zip: '85001' });
    ok(slots.status === 200 && slots.body.in_area === false && !slots.body.days,
      'out of area: slots endpoint shows NO slots');
    const book = await processBook(deps, goodBody({ zip: '85001', city: 'Phoenix' }), { ipHash: 'ip5' });
    ok(book.status === 400 && book.body.out_of_area === true && fx.db.pec_appointments.length === 0,
      'out of area: server-side re-check refuses the write even if the client lied');
    const lead = await processOutOfAreaLead(deps, {
      form: 'pec', name: 'Far Guy', phone: '928 555 0000', email: 'far@example.com',
      address1: '9 Far Away Rd', city: 'Phoenix', zip: '85001', project: 'Warehouse floor',
      answers: { how_heard: 'Referral' }, sms_consent: 'true',
    }, { ipHash: 'ip5' });
    ok(lead.status === 200 && lead.body.ok === true, 'out of area: lead capture answers honestly');
    ok(fx.db.leads.length === 1 && fx.db.pec_booking_requests.some(r => r.status === 'out_of_area' && r.lead_id === fx.db.leads[0].id),
      'out of area: lead + out_of_area request row');
    ok(fx.db.lead_events.some(e => /OUTSIDE the service area/.test((e.payload || {}).text || '')),
      'out of area: timeline note names the address and why');
    ok(fx.db.pec_notifications.some(n => n.type === 'booking_out_of_area'), 'out of area: bell rang');
  }

  // ---- Empty allowlist NEVER means everyone is out of area -----------------
  {
    const fx = makeDb(baseTables({ pec_booking_service_areas: [] }));
    const { deps } = makeDeps(fx);
    const slots = await processSlots(deps, { form: 'pec', address1: '123 N Test St', city: 'Prescott', zip: '86301' });
    ok(slots.status === 200 && slots.body.open === false, 'empty allowlist: booking reads closed, not out-of-area');
    const book = await processBook(deps, goodBody(), { ipHash: 'ip6' });
    ok(book.status === 503 && book.body.closed === true, 'empty allowlist: the write path refuses as closed');
  }

  // ---- Concurrency: two callers, one slot, ONE row (acceptance criterion) --
  {
    const fx = makeDb(baseTables());
    const a = makeDeps(fx), b = makeDeps(fx);
    const [r1, r2] = await Promise.all([
      processBook(a.deps, goodBody({ phone: '928 111 2222', email: 'a@example.com', name: 'Racer A' }), { ipHash: 'ipA' }),
      processBook(b.deps, goodBody({ phone: '928 333 4444', email: 'b@example.com', name: 'Racer B' }), { ipHash: 'ipB' }),
    ]);
    const oks = [r1, r2].filter(r => r.status === 200 && r.body.ok === true);
    const takens = [r1, r2].filter(r => r.status === 409 && r.body.taken === true);
    ok(oks.length === 1 && takens.length === 1,
      `concurrent: exactly one booked, one honest taken (got ${r1.status}/${r2.status})`);
    ok(fx.db.pec_appointments.length === 1, 'concurrent: exactly ONE appointment row exists');
    ok(Array.isArray(takens[0] && takens[0].body.days), 'concurrent: the loser gets the next open times');
  }

  // ---- Manage: reschedule honors the rules, cancel walks the lead back -----
  {
    const fx = makeDb(baseTables());
    const { deps, spies } = makeDeps(fx);
    const booked = await processBook(deps, goodBody(), { ipHash: 'ip7' });
    const appt = fx.db.pec_appointments[0];
    const token = appt.booking_manage_token;
    ok(booked.status === 200 && /^[0-9a-f]{64}$/.test(token || ''), 'manage: a 64-hex manage token was minted');

    const slotsOut = await processManage(deps, { token, action: 'slots' });
    ok(slotsOut.status === 200 && slotsOut.body.days.length > 0, 'manage: reschedule slot list loads');
    const newStart = slotsOut.body.days[0].slots.find(s => s.start !== appt.start_at);
    const moved = await processManage(deps, { token, action: 'reschedule', start: newStart.start });
    ok(moved.status === 200 && moved.body.ok === true && appt.start_at === newStart.start,
      'manage: reschedule moved the SAME row (id kept)');
    ok(fx.db.pec_notifications.some(n => n.type === 'appointment_rescheduled' && /Customer moved/.test(n.body)),
      'manage: prompt-95-shaped reschedule bell');
    ok(spies.pushed.filter(id => id === appt.id).length >= 2, 'manage: Google push kicked again on reschedule');

    const canceled = await processManage(deps, { token, action: 'cancel' });
    ok(canceled.status === 200 && appt.status === 'canceled', 'manage: cancel sets status, never deletes');
    ok(fx.db.leads[0].stage === 'contacted', 'manage: cancel walked the lead back to contacted');

    // The token dies after the appointment ends.
    const fx2 = makeDb(baseTables({
      pec_appointments: [{
        id: 'old1', appt_type: 'on_site_estimate', status: 'scheduled', source: 'booking',
        start_at: '2026-08-20T17:00:00Z', end_at: '2026-08-20T18:00:00Z',
        booking_manage_token: 'a'.repeat(64), sales_member_id: REP,
      }],
    }));
    const d2 = makeDeps(fx2);
    const expired = await processManage(d2.deps, { token: 'a'.repeat(64), action: 'cancel' });
    ok(expired.status === 410, 'manage: token stops working after the appointment ends');
  }

  console.log(`booking: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
