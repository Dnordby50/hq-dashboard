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
    pec_sales_member_google_calendars: [],
    pec_appointments: [],
    leads: [],
    customers: [],
    lead_events: [],
    pec_lead_sources: [{ name: 'Google', aliases: ['google'] }],
    pec_notifications: [],
    pec_drip_enrollments: [],
    pec_drip_campaigns: [],
    pec_email_senders: [],
    // 2026-09-21: days off for the appointment calendar + crew holidays.
    pec_appointment_blocked_days: [],
    pec_prod_holidays: [],
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
    ok(!!lead && lead.sms_consent === true && /online booking form/.test(lead.sms_consent_source || ''),
      'book: created lead carries consent (implied-by-inquiry policy 2026-08-21)');
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

  // ---- Implied consent (policy 2026-08-21): every booking consents ---------
  {
    const fx = makeDb(baseTables());
    const { deps } = makeDeps(fx);
    const out = await processBook(deps, goodBody({ sms_consent: '' }), { ipHash: 'ip2' });
    ok(out.status === 200 && fx.db.leads[0] && fx.db.leads[0].sms_consent === true
      && !!fx.db.leads[0].sms_consent_at,
      'consent: implied by the booking itself, whatever the client sent (STOP is the opt-out)');
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

  // ---- Days off (2026-09-21): a blocked day or a crew holiday never offers,
  // and the write path refuses the slot even when a client posts it directly.
  {
    const fx = makeDb(baseTables({ pec_appointment_blocked_days: [
      { id: 'bd1', start_date: '2026-08-25', end_date: '2026-08-25', sales_member_id: null, reason: 'Off' },
    ] }));
    const { deps } = makeDeps(fx);
    const slots = await processSlots(deps, { form: 'pec', address1: '123 N Test St', city: 'Prescott', zip: '86301' });
    ok(slots.status === 200 && !slots.body.days.some(d => d.date === '2026-08-25'), 'blocked day: Tuesday is not offered');
    ok(slots.body.days.some(d => d.date === '2026-08-26'), 'blocked day: Wednesday still offers');
    const book = await processBook(deps, goodBody(), { ipHash: 'ipBD' });
    ok(book.status === 409 && book.body.taken === true, 'blocked day: a direct post for that slot is refused with fresh slots');
    ok(fx.db.pec_appointments.length === 0, 'blocked day: nothing was written');
  }
  {
    const fx = makeDb(baseTables({ pec_prod_holidays: [{ id: 'h1', holiday_date: '2026-08-25', name: 'Test holiday' }] }));
    const { deps } = makeDeps(fx);
    const slots = await processSlots(deps, { form: 'pec', address1: '123 N Test St', city: 'Prescott', zip: '86301' });
    ok(slots.status === 200 && !slots.body.days.some(d => d.date === '2026-08-25'), 'crew holiday: the day is closed for online booking by default');
    // The switch off: holidays stop mattering, the blocked-days table still does.
    const fx2 = makeDb(baseTables({
      pec_prod_holidays: [{ id: 'h1', holiday_date: '2026-08-25', name: 'Test holiday' }],
      settings: baseTables().settings.concat([{ key: 'booking_block_crew_holidays', value: 'false' }]),
    }));
    const slots2 = await processSlots(makeDeps(fx2).deps, { form: 'pec', address1: '123 N Test St', city: 'Prescott', zip: '86301' });
    ok(slots2.body.days.some(d => d.date === '2026-08-25'), 'crew holiday: booking_block_crew_holidays=false reopens the day');
  }
  {
    // A rep-specific day off with a single active rep closes the day; the
    // table missing entirely (migration pending) degrades to "no blocks".
    const fx = makeDb(baseTables({ pec_appointment_blocked_days: [
      { id: 'bd2', start_date: '2026-08-25', end_date: '2026-08-26', sales_member_id: REP, reason: 'PTO' },
    ] }));
    const slots = await processSlots(makeDeps(fx).deps, { form: 'pec', address1: '123 N Test St', city: 'Prescott', zip: '86301' });
    ok(!slots.body.days.some(d => d.date === '2026-08-25' || d.date === '2026-08-26'), 'rep day off: both days in the range are closed');
    const t = baseTables(); delete t.pec_appointment_blocked_days; delete t.pec_prod_holidays;
    const slotsNoTable = await processSlots(makeDeps(makeDb(t)).deps, { form: 'pec', address1: '123 N Test St', city: 'Prescott', zip: '86301' });
    ok(slotsNoTable.status === 200 && slotsNoTable.body.days.some(d => d.date === '2026-08-25'), 'missing tables (pre-migration): slots still compute');
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

  // ---- Google availability is only as current as its oldest required source.
  // These are real endpoint runs: stale state must hide slots AND refuse a
  // direct post before it creates a contact, appointment, or confirmation.
  const connectedRep = () => ({ id: REP, name: 'Dylan', active: true,
    google_connected: true, google_needs_reconnect: false,
    google_calendar_id: 'dedicated', google_connected_at: '2026-08-01T00:00:00Z' });
  const googleRows = () => ['dedicated', 'private-calendar'].map(calendar_id => ({
    member_id: REP, calendar_id, sync_enabled: true, pull_version: 2,
    last_synced_at: new Date(NOW.getTime() - 5 * 60000).toISOString(), last_error: null,
  }));
  const unhealthyCases = [
    ['never completed', (r, c) => { c[1].last_synced_at = null; }],
    ['stale source', (r, c) => { c[1].last_synced_at = new Date(NOW.getTime() - 46 * 60000).toISOString(); }],
    ['failed source', (r, c) => { c[1].last_error = 'Sensitive private calendar API failure'; }],
    ['pre-repair partial source', (r, c) => { c[1].pull_version = 0; }],
    ['disconnected with enabled sources', (r) => { r.google_connected = false; }],
    ['reconnect required', (r) => { r.google_needs_reconnect = true; }],
    ['reconnected since completion', (r) => { r.google_connected_at = NOW.toISOString(); }],
    ['missing dedicated source', (r, c) => { c.splice(0, 1); }],
    ['connected without source ledger', (r, c) => { r.google_calendar_id = null; c.length = 0; }],
    ['far-future completion', (r, c) => { c[1].last_synced_at = new Date(NOW.getTime() + 120000).toISOString(); }],
  ];
  for (const [label, breakHealth] of unhealthyCases) {
    const rep = connectedRep(), calendars = googleRows();
    breakHealth(rep, calendars);
    const fx = makeDb(baseTables({ pec_sales_team_members: [rep], pec_sales_member_google_calendars: calendars }));
    let lockCalls = 0;
    const { deps, spies } = makeDeps(fx, { bookSlot: async () => { lockCalls++; throw new Error('unhealthy rep reached write'); } });
    const slots = await processSlots(deps, goodBody());
    const book = await processBook(deps, goodBody());
    ok(slots.status === 503 && slots.body.calendar_unavailable && slots.body.days.length === 0,
      `Google ${label}: unavailable source cannot offer slots`);
    ok(book.status === 503 && book.body.calendar_unavailable && lockCalls === 0
      && fx.db.leads.length === 0 && fx.db.pec_appointments.length === 0 && spies.pushed.length === 0 && spies.reminded.length === 0,
      `Google ${label}: direct submission is refused without booking effects`);
    ok(fx.db.pec_booking_requests.some(r => r.error_text === 'calendar_unavailable')
      && !/private-calendar|Sensitive|Dylan/.test(JSON.stringify([slots.body, book.body])),
      `Google ${label}: recorded internally, public response reveals no calendar information`);
  }
  {
    // A failed read cannot masquerade as an empty calendar list.
    const fx = makeDb(baseTables({ pec_sales_team_members: [connectedRep()], pec_sales_member_google_calendars: googleRows() }));
    const { deps } = makeDeps(fx, { sb: async (method, path, ...rest) => {
      if (path.startsWith('/pec_sales_member_google_calendars?')) throw new Error('calendar health unavailable');
      return fx.sb(method, path, ...rest);
    } });
    const result = await processBook(deps, goodBody());
    ok(result.status === 503 && result.body.calendar_unavailable && fx.db.pec_appointments.length === 0,
      'Google: a failed health read refuses the write');
  }
  {
    const calendars = googleRows();
    // Disabled foreign sources and a partial ordinary refresh do not veto
    // a completed, healthy source. A completion during the request's read
    // is allowed within the one-minute clock tolerance.
    calendars.push({ member_id: REP, calendar_id: 'disabled', sync_enabled: false, last_error: 'disabled calendar failed' });
    calendars[1].pull_state = { pageToken: 'still-refreshing' };
    calendars[1].last_synced_at = new Date(NOW.getTime() + 1000).toISOString();
    const fx = makeDb(baseTables({ pec_sales_team_members: [connectedRep()], pec_sales_member_google_calendars: calendars }));
    const { deps } = makeDeps(fx);
    const result = await processBook(deps, goodBody());
    ok(result.status === 200 && result.body.ok && fx.db.pec_appointments.length === 1,
      'Google: healthy completed source remains bookable during ordinary refresh; disabled sources ignored');
  }
  {
    const rep2 = 'aaaaaaaa-0000-0000-0000-000000000002';
    const calendars = googleRows();
    calendars[1].last_error = 'failed';
    const healthy = { ...connectedRep(), id: rep2, name: 'Other rep' };
    const fx = makeDb(baseTables({ pec_sales_team_members: [connectedRep(), healthy],
      pec_sales_member_google_calendars: calendars.concat(googleRows().map(c => ({ ...c, member_id: rep2 }))) }));
    const { deps } = makeDeps(fx);
    const slots = await processSlots(deps, goodBody());
    const result = await processBook(deps, goodBody());
    ok(slots.status === 200 && slots.body.days.length > 0 && result.status === 200
      && fx.db.pec_appointments[0].sales_member_id === rep2,
      'Google: another healthy representative remains available and gets the booking');
  }
  {
    const rows = googleRows();
    rows.forEach(c => { c.last_synced_at = new Date(NOW.getTime() - 60 * 60000).toISOString(); });
    const fx = makeDb(baseTables({ pec_sales_team_members: [connectedRep()], pec_sales_member_google_calendars: rows,
      settings: baseTables().settings.concat([{ key: 'google_booking_max_sync_age_minutes', value: '90' }]) }));
    const result = await processSlots(makeDeps(fx).deps, goodBody());
    ok(result.status === 200 && result.body.days.length > 0,
      'Google: configured maximum sync age is honored');
  }
  {
    const fx = makeDb(baseTables({ pec_sales_team_members: [connectedRep()], pec_sales_member_google_calendars: googleRows() }));
    const { deps } = makeDeps(fx);
    const offered = await processSlots(deps, goodBody());
    fx.db.pec_sales_member_google_calendars[1].last_error = 'failed after times were offered';
    const booked = await processBook(deps, goodBody());
    ok(offered.status === 200 && offered.body.days.length > 0 && booked.status === 503
      && booked.body.calendar_unavailable && fx.db.pec_appointments.length === 0,
      'Google: calendar health is loaded again on submission, not trusted from earlier slot list');
  }
  {
    // The real RPC has the final check under the booking lock. Simulate its
    // rejection after an initially healthy availability read and prove the
    // endpoint refreshes alternatives and emits no appointment effects.
    const fx = makeDb(baseTables({ pec_sales_team_members: [connectedRep()], pec_sales_member_google_calendars: googleRows() }));
    const { deps, spies } = makeDeps(fx, { bookSlot: async () => {
      fx.db.pec_sales_member_google_calendars[1].last_error = 'became unhealthy before locked insert';
      return { ok: false, taken: true, calendar_unavailable: true };
    } });
    const result = await processBook(deps, goodBody());
    ok(result.status === 409 && result.body.taken && result.body.calendar_unavailable && result.body.days.length === 0
      && fx.db.pec_appointments.length === 0 && spies.pushed.length === 0 && spies.reminded.length === 0,
      'Google: health lost before the locked write returns fresh options and no confirmation');
  }
  {
    const fx = makeDb(baseTables({ pec_sales_team_members: [connectedRep()], pec_sales_member_google_calendars: googleRows() }));
    const { deps, spies } = makeDeps(fx);
    await processBook(deps, goodBody());
    const appt = fx.db.pec_appointments[0], token = appt.booking_manage_token;
    const originalStart = appt.start_at;
    const offered = await processManage(deps, { token, action: 'slots' });
    const newStart = offered.body.days[0].slots.find(s => s.start !== originalStart).start;
    deps.bookSlot = async () => {
      fx.db.pec_sales_member_google_calendars[1].last_error = 'became unhealthy before locked reschedule';
      return { ok: false, taken: true, calendar_unavailable: true };
    };
    const race = await processManage(deps, { token, action: 'reschedule', start: newStart });
    ok(race.status === 409 && race.body.calendar_unavailable && race.body.days.length === 0
      && appt.start_at === originalStart && spies.pushed.length === 1,
      'Google: locked reschedule health race keeps original appointment and refreshes alternatives');
    const staleSlots = await processManage(deps, { token, action: 'slots' });
    const staleMove = await processManage(deps, { token, action: 'reschedule', start: newStart });
    ok(staleSlots.status === 503 && staleMove.status === 503 && appt.start_at === originalStart,
      'Google: manage slot list and direct reschedule both enforce source health');
    const cancel = await processManage(deps, { token, action: 'cancel' });
    ok(cancel.status === 200 && appt.status === 'canceled',
      'Google: a stale source never prevents a customer canceling an existing appointment');
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
