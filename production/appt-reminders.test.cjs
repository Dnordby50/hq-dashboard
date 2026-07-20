// Fixture test for the appointment confirmation/reminder engine (prompt 37).
// Drives the REAL runApptReminders from netlify/functions/_pec-appt.cjs
// against the shared mini-PostgREST (production/_drip-test-kit.cjs) with
// stubbed Quo/Resend, same rigor as the drip suites.
// Run: node production/appt-reminders.test.cjs
'use strict';
const assert = require('assert');
const { runApptReminders, renderTemplate } = require('../netlify/functions/_pec-appt.cjs');
const { makeDb, makeChecker } = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

// Fixed clock: 2026-07-20 17:00 UTC = 10:00 Phoenix (inside quiet window).
const NOW = new Date('2026-07-20T17:00:00Z');
// 10:00 UTC = 03:00 Phoenix: outside the SMS window.
const NOW_QUIET = new Date('2026-07-20T10:00:00Z');
// Appointment tomorrow, 10:00 Phoenix. The 1440-minute reminder comes due
// exactly at NOW.
const START = '2026-07-21T17:00:00.000Z';

const RULE_BOOK = {
  id: 'rule_book', enabled: true, audience: 'customer', channel: 'both',
  on_book: true, offset_minutes: 0, appt_type: null,
  message_template: 'Hi {customer_first}, you are booked. {sales_name} will see you on {appt_date} at {appt_time}.',
};
const RULE_DAY = {
  id: 'rule_day', enabled: true, audience: 'customer', channel: 'both',
  on_book: false, offset_minutes: 1440, appt_type: null,
  message_template: 'Reminder for {customer_first}: {appt_date} at {appt_time} with {sales_name}.',
};

function baseTables(over = {}) {
  return {
    pec_appointment_reminder_rules: [{ ...RULE_BOOK }, { ...RULE_DAY }],
    pec_appointments: [{
      id: 'appt1', appt_type: 'on_site_estimate', title: 'Sam Jones',
      lead_id: 'lead1', customer_id: null, sales_member_id: 'sm1',
      start_at: START, end_at: '2026-07-21T18:00:00.000Z', all_day: false,
      status: 'scheduled', source: 'topcoat',
      created_at: '2026-07-20T16:55:00.000Z',
    }],
    leads: [{
      id: 'lead1', first_name: 'Sam', full_name: 'Sam Jones',
      phone: '9285551234', email: 'sam@example.com',
      sms_consent: true, email_consent: true, opted_out: false,
    }],
    customers: [],
    pec_sales_team_members: [{ id: 'sm1', name: 'Dylan N', active: true }],
    pec_sms_senders: [{ id: 'ss1', brand: 'prescott-epoxy', active: true, from_number: '+15551112222' }],
    pec_email_senders: [{ id: 'es1', brand: 'prescott-epoxy', from_email: 'hello@prescottepoxy.com', from_name: 'Prescott Epoxy', reply_to: null }],
    pec_appointment_reminder_sends: [],
    pec_sms_log: [],
    pec_email_log: [],
    pec_notifications: [],
    ...over,
  };
}

function stubApptDeps(fx, now = NOW) {
  const providers = { sms: [], email: [] };
  return {
    providers,
    deps: {
      sb: fx.sb,
      now: () => now,
      sendSms: async (p) => { providers.sms.push(p); return { ok: true, id: 'quo_' + providers.sms.length, error: null }; },
      sendEmail: async (p) => { providers.email.push(p); return { ok: true, id: 're_' + providers.email.length, error: null }; },
    },
  };
}

(async () => {
  console.log('# template rendering: tokens filled, em dashes scrubbed');
  {
    const out = renderTemplate('See you {appt_date} — at {appt_time}, {customer_first}!', {
      customerFirst: 'Sam', date: 'Tuesday, July 21', time: '10:00 AM', salesName: 'Dylan',
    });
    ok(!out.includes('—') && /Tuesday, July 21, at 10:00 AM, Sam!/.test(out), 'em dash became a comma; tokens replaced');
    ok(renderTemplate('Hi {customer_first}', {}) === 'Hi there', 'missing first name falls back to "there"');
  }

  console.log('# on-book kick: both channels once, mirrors + ledger + STOP line');
  {
    const fx = makeDb(baseTables());
    const { deps, providers } = stubApptDeps(fx);
    const sum = await runApptReminders(deps, { appointmentId: 'appt1' });
    // Both rules fire on the kick: on_book, plus the 1440-min reminder that
    // is due exactly at NOW. 2 rules x 2 channels = 4 sends.
    ok(sum.sent === 4 && sum.failed === 0, `4 legs sent (got ${JSON.stringify(sum)})`);
    ok(providers.sms.length === 2 && providers.email.length === 2, 'two SMS + two emails hit the providers');
    ok(providers.sms[0].to === '+19285551234', 'lead phone normalized to E.164');
    ok(providers.sms.every(p => p.content.endsWith('Reply STOP to opt out.')), 'every SMS carries the STOP line');
    ok(providers.sms[0].content.includes('Sam') && /July 21/.test(providers.sms[0].content) && /10:00/.test(providers.sms[0].content) && providers.sms[0].content.includes('Dylan N'), 'tokens rendered from the live appointment (Phoenix time)');
    ok(fx.db.pec_appointment_reminder_sends.length === 4 && fx.db.pec_appointment_reminder_sends.every(r => r.status === 'sent'), 'ledger: one sent row per leg');
    ok(fx.db.pec_sms_log.length === 2 && fx.db.pec_sms_log.every(r => r.kind === 'appointment' && r.direction === 'out'), 'pec_sms_log mirrors with kind appointment');
    ok(fx.db.pec_email_log.length === 2 && fx.db.pec_email_log.every(r => r.template_key === 'appointment' && r.body_html), 'pec_email_log mirrors with template_key appointment + body_html captured');
    ok(!providers.sms.concat(providers.email.map(e => ({ content: e.html }))).some(p => /—/.test(p.content)), 'no em dash in anything customer-facing');

    console.log('# re-kick: exactly-once via the ledger');
    const sum2 = await runApptReminders(deps, { appointmentId: 'appt1' });
    ok(sum2.sent === 0 && providers.sms.length === 2 && providers.email.length === 2, 'second kick sends nothing new');
    ok(fx.db.pec_appointment_reminder_sends.length === 4, 'no extra ledger rows');
  }

  console.log('# consent: no sms_consent skips the text, email still goes');
  {
    const fx = makeDb(baseTables());
    fx.db.leads[0].sms_consent = false;
    const { deps, providers } = stubApptDeps(fx);
    await runApptReminders(deps, { appointmentId: 'appt1' });
    ok(providers.sms.length === 0 && providers.email.length === 2, 'zero texts, both emails');
    const smsLegs = fx.db.pec_appointment_reminder_sends.filter(r => r.channel === 'sms');
    ok(smsLegs.length === 2 && smsLegs.every(r => r.status === 'skipped_consent'), 'sms legs recorded skipped_consent (never re-evaluated)');
  }
  {
    const fx = makeDb(baseTables());
    fx.db.leads[0].opted_out = true;
    const { deps, providers } = stubApptDeps(fx);
    await runApptReminders(deps, { appointmentId: 'appt1' });
    ok(providers.sms.length === 0 && providers.email.length === 0, 'opted_out silences both channels');
  }

  console.log('# customer fallback: opt-out-only semantics');
  {
    const fx = makeDb(baseTables());
    fx.db.pec_appointments[0].lead_id = null;
    fx.db.pec_appointments[0].customer_id = 'cust1';
    fx.db.customers = [{ id: 'cust1', name: 'Pat Doe', first_name: 'Pat', phone: '9285559999', email: 'pat@example.com', sms_opt_out: false }];
    const { deps, providers } = stubApptDeps(fx);
    await runApptReminders(deps, { appointmentId: 'appt1' });
    ok(providers.sms.length === 2 && providers.email.length === 2, 'customer recipient sends both channels');
    ok(fx.db.pec_sms_log[0].customer_id === 'cust1', 'mirror carries the customer id');
    ok(providers.sms[0].content.includes('Pat'), 'customer first name in the copy');
  }

  console.log('# quiet hours: SMS held with NO ledger row, then released in window');
  {
    // On-book rule only, so the assertion is crisp: at 3am Phoenix the email
    // leg goes, the SMS leg is held without a ledger row, and the next
    // in-window tick sends exactly the held text.
    const fx = makeDb(baseTables({ pec_appointment_reminder_rules: [{ ...RULE_BOOK }] }));
    const held = stubApptDeps(fx, NOW_QUIET);
    const sum = await runApptReminders(held.deps, { appointmentId: 'appt1' });
    ok(held.providers.sms.length === 0 && held.providers.email.length === 1, '3am Phoenix: email goes, text held');
    ok(sum.held_quiet === 1 && fx.db.pec_appointment_reminder_sends.filter(r => r.channel === 'sms').length === 0, 'held SMS leg wrote no ledger row (retryable)');
    const rel = stubApptDeps(fx, NOW);
    await runApptReminders(rel.deps, { appointmentId: 'appt1' });
    ok(rel.providers.sms.length === 1 && rel.providers.email.length === 0, 'in-window tick releases exactly the held text, email not re-sent');
  }

  console.log('# offset due math: a 3-days-out appointment gets no 1-day reminder');
  {
    const fx = makeDb(baseTables());
    fx.db.pec_appointments[0].start_at = '2026-07-23T17:00:00.000Z';
    fx.db.pec_appointments[0].end_at = '2026-07-23T18:00:00.000Z';
    const { deps, providers } = stubApptDeps(fx);
    await runApptReminders(deps, {}); // scheduled scan, no kick
    const ruleDayLegs = fx.db.pec_appointment_reminder_sends.filter(r => r.rule_id === 'rule_day');
    ok(ruleDayLegs.length === 0, '1-day reminder not due yet');
    ok(providers.sms.length === 1 && providers.email.length === 1, 'on-book confirmation still fires from the created_at scan window');
  }

  console.log('# past appointment: never message the customer after start_at');
  {
    const fx = makeDb(baseTables());
    fx.db.pec_appointments[0].start_at = '2026-07-20T15:00:00.000Z'; // 2h ago
    const { deps, providers } = stubApptDeps(fx);
    await runApptReminders(deps, { appointmentId: 'appt1' });
    ok(providers.sms.length === 0 && providers.email.length === 0, 'nothing sends');
    ok(fx.db.pec_appointment_reminder_sends.every(r => r.status === 'skipped_past'), 'legs recorded skipped_past (terminal)');
  }

  console.log('# ad-hoc "other" with nobody linked: silent, zero ledger noise');
  {
    const fx = makeDb(baseTables());
    Object.assign(fx.db.pec_appointments[0], { appt_type: 'other', lead_id: null, customer_id: null, title: 'Home Depot run' });
    const { deps, providers } = stubApptDeps(fx);
    const sum = await runApptReminders(deps, { appointmentId: 'appt1' });
    ok(providers.sms.length === 0 && providers.email.length === 0 && fx.db.pec_appointment_reminder_sends.length === 0, 'no sends, no ledger rows');
    ok(sum.sent === 0 && sum.skipped === 0, 'clean summary');
  }

  console.log('# canceled appointments are invisible to the engine');
  {
    const fx = makeDb(baseTables());
    fx.db.pec_appointments[0].status = 'canceled';
    const { deps, providers } = stubApptDeps(fx);
    await runApptReminders(deps, { appointmentId: 'appt1' });
    ok(providers.sms.length === 0 && providers.email.length === 0, 'a canceled appointment sends nothing');
  }

  console.log('# salesperson rules: offset in_app lands in the bell; on-book belongs to the RPC');
  {
    const fx = makeDb(baseTables({
      pec_appointment_reminder_rules: [
        { id: 'rule_sp_book', enabled: true, audience: 'salesperson', channel: 'in_app', on_book: true, offset_minutes: 0, appt_type: null, message_template: 'Booked: {appt_date}' },
        { id: 'rule_sp_60', enabled: true, audience: 'salesperson', channel: 'in_app', on_book: false, offset_minutes: 1440, appt_type: null, message_template: 'Heads up {sales_name}: {appt_time}' },
      ],
    }));
    const { deps } = stubApptDeps(fx);
    await runApptReminders(deps, { appointmentId: 'appt1' });
    const notifs = fx.db.pec_notifications;
    ok(notifs.length === 1 && notifs[0].type === 'appointment_reminder' && notifs[0].target_view === 'appointments' && notifs[0].target_id === 'appt1', 'exactly one bell row, from the offset rule, routed to the appointment');
    ok(/Dylan N/.test(notifs[0].body) && /10:00/.test(notifs[0].body), 'bell body rendered');
    ok(fx.db.pec_appointment_reminder_sends.length === 1 && fx.db.pec_appointment_reminder_sends[0].rule_id === 'rule_sp_60', 'on-book salesperson rule skipped (the booking RPC covers it), no ledger row for it');
  }

  console.log('# customer job note (prompt 38): appended on both customer channels, never the bell');
  {
    const fx = makeDb(baseTables({
      pec_appointment_reminder_rules: [
        { ...RULE_BOOK },
        { id: 'rule_sp_60', enabled: true, audience: 'salesperson', channel: 'in_app', on_book: false, offset_minutes: 1440, appt_type: null, message_template: 'Heads up {sales_name}: {appt_time}' },
      ],
    }));
    fx.db.pec_appointments[0].customer_notes = 'Please clear the garage — we start at the door.';
    const { deps, providers } = stubApptDeps(fx);
    await runApptReminders(deps, { appointmentId: 'appt1' });
    ok(providers.sms.length === 1 && /Please clear the garage/.test(providers.sms[0].content), 'SMS carries the job note');
    ok(!providers.sms[0].content.includes('—') && /garage, we start/.test(providers.sms[0].content), 'em dash in the note scrubbed to a comma');
    ok(providers.sms[0].content.endsWith('Reply STOP to opt out.'), 'STOP line still last, after the note');
    ok(providers.email.length === 1 && /Please clear the garage/.test(providers.email[0].html), 'email carries the job note too');
    ok(fx.db.pec_notifications.length === 1 && !/garage/.test(fx.db.pec_notifications[0].body), 'salesperson bell never carries the customer note');
  }
  {
    const fx = makeDb(baseTables({ pec_appointment_reminder_rules: [{ ...RULE_BOOK }] }));
    // No customer_notes column at all (pre-migration select shape).
    const { deps, providers } = stubApptDeps(fx);
    await runApptReminders(deps, { appointmentId: 'appt1' });
    ok(providers.sms.length === 1 && !/undefined|null/.test(providers.sms[0].content), 'absent column is a clean no-op (no undefined in the copy)');
  }

  console.log('# per-type rule scoping');
  {
    const fx = makeDb(baseTables());
    fx.db.pec_appointment_reminder_rules = [{ ...RULE_BOOK, appt_type: 'project_walkthrough' }];
    const { deps, providers } = stubApptDeps(fx);
    await runApptReminders(deps, { appointmentId: 'appt1' });
    ok(providers.sms.length === 0 && providers.email.length === 0, 'a walkthrough-only rule ignores an on_site_estimate');
  }

  console.log('# pre-migration: silent no-op');
  {
    const fx = makeDb({ leads: [] }); // no rules table at all
    const { deps } = stubApptDeps(fx);
    const sum = await runApptReminders(deps, {});
    ok(sum.not_migrated === true && sum.sent === 0, 'missing tables mean not_migrated, never a crash');
  }

  console.log('# provider failure: failed ledger row, never auto-retried');
  {
    const fx = makeDb(baseTables({ pec_appointment_reminder_rules: [{ ...RULE_BOOK, channel: 'sms' }] }));
    const providers = { sms: [] };
    const deps = {
      sb: fx.sb, now: () => NOW,
      sendSms: async (p) => { providers.sms.push(p); return { ok: false, id: null, error: 'Quo error 500' }; },
      sendEmail: async () => { throw new Error('unused'); },
    };
    const sum = await runApptReminders(deps, { appointmentId: 'appt1' });
    ok(sum.failed === 1, 'failure counted');
    const leg = fx.db.pec_appointment_reminder_sends[0];
    ok(leg.channel === 'sms' && leg.status === 'failed', 'ledger row settled failed');
    ok(fx.db.pec_sms_log[0].status === 'failed' && /Quo error/.test(fx.db.pec_sms_log[0].error_message), 'mirror records the provider error');
    const again = await runApptReminders(deps, { appointmentId: 'appt1' });
    ok(again.sent === 0 && providers.sms.length === 1, 'the failed leg is never auto-retried (first request may have landed)');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  if (state.failed) process.exit(1);
})().catch(err => { console.error(err); process.exit(1); });
