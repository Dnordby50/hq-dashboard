// Fixture test for the prompt-73 build: the day-0 instant touch
// (sendInstantTouch), fixed-template rendering with the {booking_link}
// conditional, the booking-URL exactness guard, the per-step auto_send
// bypass (and that it does NOT leak to gated steps), and the consent-value
// allowlist. Drives the REAL engine from netlify/functions/_pec-drip.cjs
// against the shared mini-PostgREST. Run: node production/instant-touch.test.cjs
'use strict';
const {
  runDrips, sendInstantTouch, renderFixedTemplate, bookingUrlViolation,
  scrubCopyKeepUrl, enrollLead, STOP_LINE,
} = require('../netlify/functions/_pec-drip.cjs');
const { parseSmsConsent } = require('../netlify/functions/pec-lead-intake.cjs');
const {
  makeDb, baseTables, stubDeps, makeChecker, NOW_IN_WINDOW, NOW_BEFORE_OPEN,
} = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

const BOOKING = 'https://prescottepoxycompany.routemize.com/book';
const TPL = 'Hi {first_name}, thanks for reaching out to Prescott Epoxy Company. We got your request and someone from our team will call you shortly.{{#booking_link}} If it is easier, you can pick a time for your free on site estimate here: {booking_link}{{/booking_link}}';

// The prompt-73 shape: step 0 = day-0 fixed auto_send, the AI taper shifted
// to indices 1..3 (a compressed stand-in for the real 1..8).
const STEPS73 = [
  { id: 's0', campaign_id: 'camp1', step_index: 0, day_offset: 0, channel: 'both', ai_guidance: null, email_subject: 'Thanks for reaching out to Prescott Epoxy Company', fixed_subject: 'Thanks for reaching out to Prescott Epoxy Company', fixed_template: TPL, auto_send: true, active: true },
  { id: 's1', campaign_id: 'camp1', step_index: 1, day_offset: 1, channel: 'both', ai_guidance: 'first touch', email_subject: 'Your epoxy floor project', fixed_template: null, fixed_subject: null, auto_send: false, active: true },
  { id: 's2', campaign_id: 'camp1', step_index: 2, day_offset: 2, channel: 'sms', ai_guidance: 'nudge', email_subject: null, fixed_template: null, fixed_subject: null, auto_send: false, active: true },
];

function tables73(over = {}) {
  const t = baseTables({
    settings: [
      { id: 'set1', key: 'drip_sending_enabled', value: 'true' },
      { id: 'set2', key: 'drip_approval_required', value: 'true' },
      { id: 'set3', key: 'drip_instant_touch_enabled', value: 'true' },
      { id: 'set4', key: 'drip_kill_switch', value: 'false' },
      { id: 'set5', key: 'routemize_booking_url', value: BOOKING },
    ],
    pec_drip_steps: STEPS73.map(s => ({ ...s })),
    pec_notifications: [],
    ...over,
  });
  t.pec_drip_campaigns[0].mode = 'live';
  t.pec_drip_campaigns[0].max_touches = 9;
  if (t.pec_drip_enrollments[0]) {
    // Fresh enrollment at step 0, due immediately (day_offset 0). The
    // enrolled_at/next_send_at sit before BOTH test clocks (in-window 17:00Z
    // and before-open 10:00Z) so the runner sees it as due either way.
    t.pec_drip_enrollments[0].next_step_index = 0;
    t.pec_drip_enrollments[0].enrolled_at = '2026-07-20T08:59:00Z';
    t.pec_drip_enrollments[0].next_send_at = '2026-07-20T08:59:00Z';
  }
  return t;
}
function instantDeps(fx, opts = {}) {
  const providers = { sms: [], email: [] };
  return {
    providers,
    opts: {
      now: () => opts.now || NOW_IN_WINDOW,
      senders: {
        sendSms: async (p) => { providers.sms.push(p); return { ok: true, id: 'quo-it-' + providers.sms.length, error: null }; },
        sendEmail: async (p) => { providers.email.push(p); return { ok: true, id: 'resend-it-' + providers.email.length, error: null }; },
      },
    },
  };
}

(async () => {
  console.log('# renderFixedTemplate: tokens and the booking-link conditional');
  {
    const withLink = renderFixedTemplate(TPL, { first_name: 'Jane', booking_link: BOOKING });
    ok(withLink.startsWith('Hi Jane, thanks for reaching out'), 'first_name token substituted');
    ok(withLink.includes(`here: ${BOOKING}`), 'booking sentence present with the URL when configured');
    const noLink = renderFixedTemplate(TPL, { first_name: 'Jane', booking_link: '' });
    ok(!noLink.includes('pick a time') && !/:\s*$/.test(noLink) && !noLink.includes('here:'), 'unset link drops the WHOLE sentence: no dangling colon, no orphan text');
    ok(noLink.endsWith('call you shortly.'), 'remaining copy reads clean without the conditional block');
    ok(renderFixedTemplate(TPL, {}).startsWith('Hi there,'), 'missing first_name falls back to "there"');
    ok(renderFixedTemplate('a — b – c', {}) === 'a, b, c', 'em/en dashes scrubbed at the template level (standing rule 6)');
    ok(renderFixedTemplate(null, {}) === null && renderFixedTemplate('   ', {}) === null, 'null/blank templates render null');
  }

  console.log('# bookingUrlViolation: exactness guard');
  {
    ok(bookingUrlViolation(`Book here: ${BOOKING}`, BOOKING) === false, 'the configured URL verbatim passes');
    ok(bookingUrlViolation(`Book here: ${BOOKING}.`, BOOKING) === false, 'trailing sentence punctuation tolerated');
    ok(bookingUrlViolation(`Book at https://prescottepoxycompany.routemize.com/booknow`, BOOKING) === true, 'a mutated path is a violation');
    ok(bookingUrlViolation('Visit https://evil.routemize.com/x', BOOKING) === true, 'a different routemize host is a violation');
    ok(bookingUrlViolation(`Book: ${BOOKING}`, null) === true, 'ANY routemize URL with no link configured is a violation');
    ok(bookingUrlViolation('No links here at all', BOOKING) === false, 'no URL, no violation');
    ok(bookingUrlViolation('See https://prescottepoxy.netlify.app/e/x', null) === false, 'non-routemize URLs are scrubCopy business, not this guard');
  }

  console.log('# scrubCopyKeepUrl: the one-URL exception to the scrubber');
  {
    ok(scrubCopyKeepUrl(`Pick a time — here: ${BOOKING} or call`, BOOKING) === `Pick a time, here: ${BOOKING} or call`, 'configured URL survives, em dash still dies');
    ok(scrubCopyKeepUrl(`Go to ${BOOKING} not https://other.com/x`, BOOKING) === `Go to ${BOOKING} not`, 'other URLs still stripped');
    ok(scrubCopyKeepUrl('plain — text', null) === 'plain, text', 'no keep URL behaves exactly like scrubCopy');
  }

  console.log('# parseSmsConsent: the exact allowlist, nothing else');
  {
    for (const v of [true, 1, 'true', 'TRUE', ' yes ', 'on', '1', 'checked', 'agree', 'agreed', 'y']) {
      ok(parseSmsConsent(v) === true, `consent truthy spelling accepted: ${JSON.stringify(v)}`);
    }
    for (const v of [false, 0, null, undefined, '', 'no', 'false', 'maybe', 'I agree to everything', 'x', {}, []]) {
      ok(parseSmsConsent(v) === false, `non-allowlisted value reads as NO consent: ${JSON.stringify(v)}`);
    }
  }

  console.log('# instant touch happy path: both channels, gate on, claim-first advance');
  {
    const fx = makeDb(tables73());
    const { providers, opts } = instantDeps(fx);
    const out = await sendInstantTouch(fx.sb, 'lead1', opts);
    ok(out.sent.length === 2 && out.sent.includes('sms') && out.sent.includes('email'), 'sms + email both sent (consent true, email present)');
    ok(providers.sms.length === 1 && providers.email.length === 1, 'providers called once each');
    ok(providers.sms[0].content.includes(BOOKING) && providers.sms[0].content.endsWith(STOP_LINE.trim()), 'SMS carries the booking link and the STOP line');
    ok(providers.email[0].subject === 'Thanks for reaching out to Prescott Epoxy Company', 'email uses fixed_subject');
    ok(/Hi Jane/.test(providers.sms[0].content), 'first name rendered');
    ok(!/[—–]/.test(providers.sms[0].content) && !/[—–]/.test(providers.email[0].html), 'no em/en dashes anywhere customer-facing');
    const rows = fx.db.pec_drip_sends.filter(r => r.step_index === 0);
    ok(rows.length === 2 && rows.every(r => r.status === 'sent' && r.enrollment_id === 'enr1'), 'two step-0 ledger rows, both sent');
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.status === 'active' && enr.next_step_index === 1 && enr.next_send_at === '2026-07-21T08:59:00.000Z', 'enrollment advanced to step 1, next_send_at = enrolled_at + day 1 (taper intact)');
    ok(fx.db.leads[0].contacted_at != null, 'contacted_at stamped (speed-to-lead)');
    ok(fx.db.settings.find(s => s.key === 'drip_approval_required').value === 'true', 'and the approval gate never moved: the bypass is the step, not the setting');

    // Idempotency: the Zapier retry.
    const again = await sendInstantTouch(fx.sb, 'lead1', opts);
    ok(again.reason === 'already_recorded' && providers.sms.length === 1 && providers.email.length === 1, 'second call is a no-op with a logged reason (Zapier retry safe)');
  }

  console.log('# instant touch without consent: email only, honest skipped row');
  {
    const fx = makeDb(tables73());
    fx.db.leads[0].sms_consent = false;
    const { providers, opts } = instantDeps(fx);
    const out = await sendInstantTouch(fx.sb, 'lead1', opts);
    ok(out.sent.length === 1 && out.sent[0] === 'email' && providers.sms.length === 0, 'email sent, SMS never attempted');
    const skip = fx.db.pec_drip_sends.find(r => r.channel === 'sms' && r.step_index === 0);
    ok(skip && skip.status === 'skipped' && skip.error_message === 'no_sms_consent', 'skipped ledger row says WHY (no_sms_consent), not silence');
  }

  console.log('# instant touch ignores quiet hours (and ONLY the touch does)');
  {
    const fx = makeDb(tables73());
    const { providers, opts } = instantDeps(fx, { now: NOW_BEFORE_OPEN });
    const out = await sendInstantTouch(fx.sb, 'lead1', opts);
    ok(out.sent.includes('sms') && providers.sms.length === 1, '3am Phoenix: the day-0 SMS still goes out (immediate reply to a message they just sent)');
  }

  console.log('# instant touch preconditions: each master still outranks it');
  {
    for (const [key, value, reason] of [
      ['drip_instant_touch_enabled', 'false', 'instant_touch_disabled'],
      ['drip_sending_enabled', 'false', 'master_off'],
      ['drip_kill_switch', 'true', 'kill_switch'],
    ]) {
      const fx = makeDb(tables73());
      fx.db.settings.find(s => s.key === key).value = value;
      const { providers, opts } = instantDeps(fx);
      const out = await sendInstantTouch(fx.sb, 'lead1', opts);
      ok(out.reason === reason && providers.sms.length === 0 && providers.email.length === 0 && fx.db.pec_drip_sends.length === 0,
        `${key}=${value} -> zero sends, reason ${reason}`);
    }
    // Archived and opted-out leads never get the touch.
    for (const [field, value, reason] of [['archived_at', '2026-07-01T00:00:00Z', 'archived'], ['opted_out', true, 'opted_out']]) {
      const fx = makeDb(tables73());
      fx.db.leads[0][field] = value;
      const { providers, opts } = instantDeps(fx);
      const out = await sendInstantTouch(fx.sb, 'lead1', opts);
      ok(out.reason === reason && providers.sms.length === 0 && providers.email.length === 0, `${field} lead -> ${reason}, nothing sent`);
    }
    // No auto step 0 (pre-migration shape): clean skip.
    {
      const fx = makeDb(tables73());
      fx.db.pec_drip_steps.find(s => s.step_index === 0).auto_send = false;
      const { providers, opts } = instantDeps(fx);
      const out = await sendInstantTouch(fx.sb, 'lead1', opts);
      ok(out.reason === 'no_auto_step0' && providers.sms.length === 0, 'step 0 without auto_send+fixed_template -> clean skip');
    }
  }

  console.log('# empty booking URL: no dangling colon in what actually sends');
  {
    const fx = makeDb(tables73());
    fx.db.settings.find(s => s.key === 'routemize_booking_url').value = '';
    const { providers, opts } = instantDeps(fx);
    await sendInstantTouch(fx.sb, 'lead1', opts);
    ok(!providers.sms[0].content.includes('here:') && !providers.sms[0].content.includes('pick a time'), 'sent SMS has no booking sentence and no dangling colon');
    ok(!providers.email[0].html.includes('here:'), 'sent email body clean too');
  }

  console.log('# the runner as crash safety net: auto_send step 0 sends, gated steps still hold');
  {
    // The instant touch crashed (no step-0 rows, enrollment still at 0). The
    // next runner tick must send step 0 (fixed copy, zero AI calls, quiet
    // hours ignored) and then hold step 1 in the approval queue.
    const fx = makeDb(tables73());
    const { deps, providers } = stubDeps(fx, { now: NOW_BEFORE_OPEN });   // 3am Phoenix
    const sum = await runDrips(deps);
    ok(sum.sent === 2 && providers.ai.length === 0, 'runner sent step 0 on both channels with ZERO model calls');
    ok(providers.sms.length === 1 && providers.sms[0].content.includes(BOOKING), 'runner-sent step 0 carries the booking link (outside quiet hours: auto_send ignores the window)');
    ok(sum.pending === 0, 'nothing went to the approval queue for the auto step');
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.next_step_index === 1, 'runner advanced to step 1');

    // Now step 1 comes due: the gate must hold it. THE non-leak regression.
    enr.next_send_at = '2026-07-20T10:00:00Z';
    const { deps: deps2, providers: p2 } = stubDeps(fx, { now: NOW_IN_WINDOW });
    const sum2 = await runDrips(deps2);
    ok(sum2.pending === 2 && sum2.sent === 0, 'step 1 landed in the approval queue as pending, NOT auto-sent (auto_send did not leak)');
    ok(p2.sms.length === 0 && p2.email.length === 0, 'no provider calls for the gated step');
    ok(p2.ai.length === 1 && p2.ai[0].step === 1, 'step 1 rendered via the model as always');
    const pend = fx.db.pec_drip_sends.filter(r => r.status === 'pending');
    ok(pend.length === 2 && pend.every(r => r.step_index === 1), 'pending rows are step 1 only');
  }

  console.log('# booking link flows into gated AI copy and survives the scrubber');
  {
    const fx = makeDb(tables73());
    // Skip step 0 (already sent) and gate OFF so step 1 sends live.
    fx.db.settings.find(s => s.key === 'drip_approval_required').value = 'false';
    fx.db.pec_drip_enrollments[0].next_step_index = 1;
    fx.db.pec_drip_enrollments[0].next_send_at = '2026-07-20T10:00:00Z';
    const { deps, providers } = stubDeps(fx);
    let sawBookingCtx = null;
    const inner = deps.renderCopy;
    deps.renderCopy = async (ctx, step, campaign, needs) => {
      sawBookingCtx = ctx.bookingUrl;
      const copy = await inner(ctx, step, campaign, needs);
      if (copy.sms) copy.sms += ` Pick a time: ${BOOKING}`;
      return copy;
    };
    const sum = await runDrips(deps);
    ok(sawBookingCtx === BOOKING, 'runner attached the configured booking URL to the render context (lead campaign only)');
    ok(sum.sent === 2 && providers.sms[0].content.includes(BOOKING), 'model-included booking link survives scrubbing into the sent SMS');
  }

  console.log('# enrollLead minStepIndex: cancel/backlog enrollments start at step 1');
  {
    const fx = makeDb(tables73({ pec_drip_enrollments: [] }));
    const r = await enrollLead(fx.sb, 'lead1', new Date('2026-07-20T17:00:00Z'), { minStepIndex: 1 });
    ok(r.enrolled === true, 'enrolls fine');
    const enr = fx.db.pec_drip_enrollments[0];
    ok(enr.next_step_index === 1 && enr.next_send_at === '2026-07-21T17:00:00.000Z', 'starts at step 1, day 1 from NOW: no day-0 auto-reply for a stale or fallen-through lead');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
