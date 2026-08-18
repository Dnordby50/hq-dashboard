// Fixture test for prompt 96 (Google multi-calendar sync): the bounded pull
// window, the imported-event skip filter, the Part C write guardrails, the
// in-place push routing (an imported event must NEVER be re-homed onto the
// TopCoat calendar), and the Part E automation guard proving NOTHING
// customer-facing fires for a source='google' row.
// Run: node production/google-multi-cal.test.cjs
'use strict';

// _pec-google.cjs reads the OAuth env at module load; set it BEFORE any
// require so googleConfigured() is true and the push exercises its real
// branches instead of the not-configured early return. No network is ever
// touched: every path tested here returns before a Google call.
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';

const {
  mapEventToRow, importGuardrailReason, shouldSkipImportedEvent, pullWindow,
} = require('../netlify/functions/pec-google-calendar-pull.cjs');
const {
  pushApptById, importedCalendarRow, importedEventPatch, pushImportedAppt,
} = require('../netlify/functions/_pec-appt-push.cjs');
const { runApptReminders, apptBookingLeadEffects, apptCancelLeadEffects } = require('../netlify/functions/_pec-appt.cjs');
const { deriveSoldOnSite } = require('./sold-on-site.cjs');
const { makeDb, makeChecker } = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

const MEMBER = { id: 'sm1', name: 'Dylan N', google_calendar_id: 'cal_topcoat_1' };
const NOW = new Date('2026-08-18T17:00:00Z');

(async () => {
  console.log('# pull window math (bounded full sync)');
  {
    const w = pullWindow({ windowDaysPast: 30, windowDaysFuture: 180 }, NOW);
    ok(w.timeMin === '2026-07-19T17:00:00.000Z', 'timeMin = now minus 30 days');
    ok(w.timeMax === '2027-02-14T17:00:00.000Z', 'timeMax = now plus 180 days');
    const d = pullWindow({}, NOW);
    ok(d.timeMin === '2026-07-19T17:00:00.000Z' && d.timeMax === '2027-02-14T17:00:00.000Z', 'missing config falls back to the 30/180 defaults');
  }

  console.log('# imported-event skip filter');
  {
    const cfg = { includeAllDay: true, includeDeclined: false };
    ok(shouldSkipImportedEvent({ eventType: 'birthday' }, cfg) === true, 'birthday pseudo-events always skip');
    ok(shouldSkipImportedEvent({ eventType: 'workingLocation' }, cfg) === true, 'workingLocation always skips');
    ok(shouldSkipImportedEvent({ eventType: 'outOfOffice', start: { dateTime: 'x' } }, cfg) === false, 'outOfOffice imports (a real block on the day)');
    ok(shouldSkipImportedEvent({ eventType: 'focusTime', start: { dateTime: 'x' } }, cfg) === false, 'focusTime imports');
    ok(shouldSkipImportedEvent({ start: { date: '2026-08-19' } }, cfg) === false, 'all-day imports while the setting is on');
    ok(shouldSkipImportedEvent({ start: { date: '2026-08-19' } }, { ...cfg, includeAllDay: false }) === true, 'all-day skips when the setting is off');
    const declined = { start: { dateTime: 'x' }, attendees: [{ self: true, responseStatus: 'declined' }, { responseStatus: 'accepted' }] };
    ok(shouldSkipImportedEvent(declined, cfg) === true, 'a self-declined invite skips by default');
    ok(shouldSkipImportedEvent(declined, { ...cfg, includeDeclined: true }) === false, 'declined imports when the setting says so');
    ok(shouldSkipImportedEvent({ start: { dateTime: 'x' }, attendees: [{ responseStatus: 'declined' }] }, cfg) === false, 'someone ELSE declining never skips the event');
  }

  console.log('# Part C guardrails 1-2 (computed at pull, stored on the row)');
  {
    const writer = { access_role: 'writer' };
    ok(importGuardrailReason({}, { access_role: 'reader' }) === 'calendar_read_only', 'reader calendar (Packers, Holidays) = calendar_read_only');
    ok(importGuardrailReason({}, null) === 'calendar_read_only', 'no calendar row = read-only, never a guess');
    ok(importGuardrailReason({ organizer: { email: 'boss@x.com' } }, writer) === 'not_organizer', 'someone else organizes = not_organizer');
    ok(importGuardrailReason({ organizer: { self: true } }, writer) === null, 'own event on a writable calendar = writable');
    ok(importGuardrailReason({ organizer: { self: true } }, { access_role: 'owner' }) === null, 'owner role passes too');
    ok(importGuardrailReason({}, writer) === null, 'missing organizer does not block (access already gates)');
  }

  console.log('# mapEventToRow multi-calendar opts');
  {
    const ev = {
      id: 'inst_1', summary: 'Focus: Top-Client Relationships', recurringEventId: 'series_1',
      start: { dateTime: '2026-08-19T09:00:00-07:00' }, end: { dateTime: '2026-08-19T10:00:00-07:00' },
    };
    const { row, apptType } = mapEventToRow(ev, MEMBER, { calendarId: 'dnordby50@gmail.com', defaultType: 'other' });
    ok(row.google_calendar_id === 'dnordby50@gmail.com', 'the SOURCE calendar id lands on the row, not the TopCoat calendar');
    ok(row.google_recurring_event_id === 'series_1', 'recurringEventId stored (Part C patches the instance only)');
    ok(apptType === 'other', 'imported default type applies');
    const legacy = mapEventToRow(ev, MEMBER);
    ok(legacy.row.google_calendar_id === 'cal_topcoat_1', 'no opts = original TopCoat behavior');
    const typed = mapEventToRow({ ...ev, extendedProperties: { private: { topcoat_type: 'site_visit' } } }, MEMBER, { calendarId: 'c2', defaultType: 'other' });
    ok(typed.apptType === 'site_visit', 'our private property still wins over the default');
  }

  console.log('# importedEventPatch (minimal in-place body)');
  {
    const p = importedEventPatch({
      title: 'Doug GSR', notes: 'agenda', location_address: '123 Main St', location_city: 'Prescott',
      start_at: '2026-08-19T16:00:00.000Z', end_at: '2026-08-19T17:00:00.000Z', all_day: false,
    });
    ok(p.summary === 'Doug GSR' && p.description === 'agenda' && p.location === '123 Main St, Prescott', 'summary/description/location mapped plain, no contact block');
    ok(p.start.dateTime === '2026-08-19T16:00:00.000Z' && p.start.date === null && p.end.date === null, 'timed patch nulls the all-day bound (PATCH merges nested objects)');
    ok(!('extendedProperties' in p) && !('attendees' in p), 'no TopCoat tagging, no attendee fields on someone\'s personal event');
    const blank = importedEventPatch({ title: null, notes: null, start_at: '2026-08-19T07:00:00.000Z', all_day: true });
    ok(!('summary' in JSON.parse(JSON.stringify(blank))) && !('description' in JSON.parse(JSON.stringify(blank))), 'empty title/notes drop out of the JSON instead of blanking Google');
    ok(blank.start.date === '2026-08-19' && blank.start.dateTime === null, 'all-day patch nulls the timed bound');
  }

  console.log('# push routing: imported rows are patched in place, never re-homed');
  {
    // Plain-token calendar ids: the mini-PostgREST's eq matcher does not
    // URL-decode, so an @ in a fixture id would silently miss.
    const fx = makeDb({
      pec_sales_team_members: [{ ...MEMBER, google_connected: true }],
      pec_sales_member_google_calendars: [
        { id: 'c1', member_id: 'sm1', calendar_id: 'cal_topcoat_1', summary: 'TopCoat', access_role: 'owner', sync_enabled: true },
        { id: 'c2', member_id: 'sm1', calendar_id: 'cal_personal_1', summary: 'Dylan primary', access_role: 'owner', sync_enabled: true },
        { id: 'c3', member_id: 'sm1', calendar_id: 'cal_packers_1', summary: 'Green Bay Packers', access_role: 'reader', sync_enabled: true },
      ],
      pec_sales_member_google_tokens: [],
      pec_appointments: [
        { id: 'a_ro', source: 'google', status: 'scheduled', sales_member_id: 'sm1',
          google_calendar_id: 'cal_packers_1', google_event_id: 'gev_pack',
          google_readonly_reason: 'calendar_read_only', start_at: '2026-08-19T16:00:00.000Z', end_at: '2026-08-19T17:00:00.000Z' },
        { id: 'a_rw', source: 'google', status: 'scheduled', sales_member_id: 'sm1',
          google_calendar_id: 'cal_personal_1', google_event_id: 'gev_own',
          google_readonly_reason: null, start_at: '2026-08-19T16:00:00.000Z', end_at: '2026-08-19T17:00:00.000Z' },
      ],
    });
    const tc = await importedCalendarRow(fx.sb, 'cal_topcoat_1');
    ok(tc === null, 'the dedicated TopCoat calendar never routes through the imported path (seeded row and all)');
    const imp = await importedCalendarRow(fx.sb, 'cal_personal_1');
    ok(!!imp && imp.id === 'c2', 'an imported calendar resolves its sync row');

    const ro = await pushApptById(fx.sb, 'a_ro');
    ok(ro.ok === true && ro.skipped === 'imported_read_only' && ro.reason === 'calendar_read_only', 'guardrail-failed import: push refuses cleanly');
    const roRow = fx.db.pec_appointments.find(r => r.id === 'a_ro');
    ok(roRow.google_event_id === 'gev_pack' && roRow.google_calendar_id === 'cal_packers_1', 'the read-only row keeps its mapping: nothing deleted, nothing re-homed');

    const denied = await pushImportedAppt(fx.sb, fx.db.pec_appointments[1], { id: 'c3', member_id: 'sm1', calendar_id: 'x', access_role: 'reader' });
    ok(denied.ok === true && denied.skipped === 'imported_read_only', 'access re-check at push time: a role downgrade cannot slip a write through');

    const rw = await pushApptById(fx.sb, 'a_rw');
    ok(rw.ok === true && rw.skipped === 'token_refresh_failed', 'writable import with no token stops before any Google call (and never falls into the TopCoat re-home flow)');
  }

  console.log('# Part E: the automation guard, proven against the real engines');
  {
    const RULE_BOOK = { id: 'rule_book', enabled: true, audience: 'customer', channel: 'both', on_book: true, offset_minutes: 0, appt_type: null, message_template: 'Hi {customer_first}, booked for {appt_date} {appt_time}.' };
    const RULE_DAY = { id: 'rule_day', enabled: true, audience: 'customer', channel: 'both', on_book: false, offset_minutes: 1440, appt_type: null, message_template: 'Reminder {customer_first}: {appt_date} {appt_time}.' };
    const RULE_BELL = { id: 'rule_bell', enabled: true, audience: 'salesperson', channel: 'in_app', on_book: false, offset_minutes: 1440, appt_type: null, message_template: 'Up next: {appt_date} {appt_time}.' };
    const START = '2026-08-19T17:00:00.000Z'; // due for the 1440-min rules at NOW
    const mkAppt = (over) => ({
      id: 'appt1', appt_type: 'on_site_estimate', title: 'Sam Jones',
      lead_id: 'lead1', customer_id: null, sales_member_id: 'sm1',
      start_at: START, end_at: '2026-08-19T18:00:00.000Z', all_day: false,
      status: 'scheduled', source: 'topcoat', created_at: '2026-08-18T16:55:00.000Z', ...over,
    });
    const mkTables = (apptOver) => ({
      pec_appointment_reminder_rules: [{ ...RULE_BOOK }, { ...RULE_DAY }, { ...RULE_BELL }],
      pec_appointments: [mkAppt(apptOver)],
      leads: [{ id: 'lead1', first_name: 'Sam', full_name: 'Sam Jones', phone: '9285551234', email: 'sam@example.com', sms_consent: true, email_consent: true, opted_out: false, stage: 'estimate_scheduled', deleted_at: null }],
      customers: [],
      pec_sales_team_members: [{ id: 'sm1', name: 'Dylan N', active: true }],
      pec_sms_senders: [{ id: 'ss1', brand: 'prescott-epoxy', active: true, from_number: '+15551112222' }],
      pec_email_senders: [{ id: 'es1', brand: 'prescott-epoxy', from_email: 'hello@prescottepoxy.com', from_name: 'Prescott Epoxy', reply_to: null }],
      pec_appointment_reminder_sends: [], pec_sms_log: [], pec_email_log: [], pec_notifications: [],
      pec_drip_enrollments: [{ id: 'enr1', subject_type: 'lead', subject_id: 'lead1', lead_id: 'lead1', campaign_id: 'camp1', status: 'active' }],
      lead_events: [],
    });
    const drive = async (apptOver) => {
      const fx = makeDb(mkTables(apptOver));
      const sent = { sms: 0, email: 0 };
      await runApptReminders({
        sb: fx.sb, now: () => NOW,
        sendSms: async () => { sent.sms++; return { ok: true, id: 'q1', error: null }; },
        sendEmail: async () => { sent.email++; return { ok: true, id: 'r1', error: null }; },
      });
      return { tables: fx.db, sent };
    };

    const control = await drive({});
    ok(control.sent.sms + control.sent.email > 0, 'control: a topcoat booking DOES send (the guard is not a blanket off-switch)');
    ok(control.tables.pec_notifications.length > 0, 'control: the salesperson bell reminder fires for a topcoat booking');

    const imported = await drive({ source: 'google', appt_type: 'other', lead_id: null, google_calendar_id: 'dnordby50@gmail.com', google_event_id: 'gev1' });
    ok(imported.sent.sms === 0 && imported.sent.email === 0, 'imported focus block: zero texts, zero emails');
    ok(imported.tables.pec_notifications.length === 0 && imported.tables.pec_appointment_reminder_sends.length === 0, 'imported: no bell, no ledger rows');

    // Worst case: a google row that somehow LOOKS like a booking (linked
    // lead, estimate type). The guard must still hold on source alone.
    const dressed = await drive({ source: 'google' });
    ok(dressed.sent.sms === 0 && dressed.sent.email === 0 && dressed.tables.pec_notifications.length === 0, 'even a lead-linked on_site_estimate google row sends NOTHING');

    // Stage advance / drip pause / cancel walk-back.
    const fx2 = makeDb(mkTables({ source: 'google' }));
    const eff = await apptBookingLeadEffects(fx2.sb, mkAppt({ source: 'google' }), { advanceStage: true, now: () => NOW });
    ok(eff.staged === false && eff.drip_stopped === 0, 'apptBookingLeadEffects: no stage advance, no drip pause for a google row');
    const cx = await apptCancelLeadEffects(fx2.sb, mkAppt({ source: 'google', status: 'canceled' }));
    ok(cx.reverted === false, 'apptCancelLeadEffects: a google cancel never walks a lead back');

    // Sold-on-site: an imported event inside the accept window must not match.
    const apptRow = { id: 'a1', appt_type: 'on_site_estimate', status: 'scheduled', start_at: '2026-08-19T17:00:00.000Z', end_at: '2026-08-19T18:00:00.000Z' };
    const accepted = '2026-08-19T17:30:00.000Z';
    const hit = deriveSoldOnSite({ acceptedAt: accepted, appointments: [{ ...apptRow, source: 'topcoat' }], graceMinutes: 120 });
    ok(hit.sold === true, 'control: a topcoat visit in-window matches sold-on-site');
    const miss = deriveSoldOnSite({ acceptedAt: accepted, appointments: [{ ...apptRow, source: 'google' }], graceMinutes: 120 });
    ok(miss.sold === false && miss.reason === 'no_appointment', 'an imported google event never anchors a sold-on-site verdict');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  if (state.failed) process.exit(1);
})();
