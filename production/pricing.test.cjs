'use strict';
// Instant Pricing endpoint tests: the quote write path, contact capture with
// the full lead treatment, abuse control, the duplicate window, and the
// booked-callback verification. Drives the REAL processQuote /
// processBookedCallback from netlify/functions/pec-pricing.cjs against the
// shared mini-PostgREST (production/_drip-test-kit.cjs).
// Run: node production/pricing.test.cjs

const { processQuote, processBookedCallback } = require('../netlify/functions/pec-pricing.cjs');
const { makeDb } = require('./_drip-test-kit.cjs');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${label}`); }
}

const TYPE_FLAKE = '11111111-1111-1111-1111-111111111111';
const TYPE_CALLUS = '22222222-2222-2222-2222-222222222222';

function baseTables(over = {}) {
  return {
    settings: [
      { key: 'pricing_enabled', value: 'true' },
      { key: 'pricing_round_to', value: '50' },
      { key: 'pricing_min_sqft', value: '50' },
      { key: 'pricing_max_sqft', value: '20000' },
      { key: 'pricing_rate_limit_per_hour', value: '3' },
      { key: 'pricing_min_fill_seconds', value: '2' },
      { key: 'pricing_duplicate_window_hours', value: '24' },
      { key: 'pricing_reveal_copy', value: 'Between {low} and {high}.' },
      { key: 'pricing_out_of_area_copy', value: 'OUT OF AREA COPY' },
      { key: 'pricing_call_us_copy', value: 'CALL US COPY' },
      { key: 'booking_enabled', value: 'true' },
      { key: 'booking_sms_disclosure', value: 'TEST DISCLOSURE' },
      { key: 'pricing_instant_touch_delay_minutes', value: '10' },
    ],
    pec_pricing_project_types: [
      { id: TYPE_FLAKE, brand: 'PEC', name: 'Standard Flake', description: 'Flake floor', image_path: null, rate_low: 5.25, rate_high: 7.00, min_price: null, priceable: true, sort_order: 1, active: true },
      { id: TYPE_CALLUS, brand: 'PEC', name: 'Something else', description: null, image_path: null, rate_low: null, rate_high: null, min_price: null, priceable: false, sort_order: 2, active: true },
    ],
    pec_pricing_requests: [],
    pec_booking_forms: [{ id: 'form1', slug: 'pec', brand: 'PEC', active: true, questions: [] }],
    pec_booking_service_areas: [{ id: 'sa1', form_id: 'form1', zip: '86301', city: 'Prescott', active: true }],
    pec_appointments: [],
    leads: [],
    customers: [],
    lead_events: [],
    pec_lead_sources: [{ name: 'Instant Pricing', aliases: ['instant_pricing'], active: true }],
    pec_notifications: [],
    pec_drip_campaigns: [],
    pec_drip_steps: [],
    pec_drip_enrollments: [],
    pec_drip_sends: [],
    pec_email_senders: [],
    ...over,
  };
}

function makeDeps(fx) {
  const logged = [], scored = [];
  return {
    deps: {
      sb: fx.sb,
      logIngest: async (f) => { logged.push(f); },
      kickLeadAi: async (id) => { scored.push(id); },
    },
    spies: { logged, scored },
  };
}

const goodBody = (over = {}) => ({
  project_type_id: TYPE_FLAKE, sqft: '1000',
  name: 'Jane Doe', phone: '(928) 555-1212', email: 'jane@example.com',
  address1: '123 N Test St', city: 'Prescott', zip: '86301',
  website: '', fill_ms: 45000,
  ...over,
});

const META = { ipHash: 'hash1', userAgent: 'test-ua' };

(async () => {
  // ---- Happy path: priced, lead created with the full treatment ------------
  {
    const fx = makeDb(baseTables());
    const { deps, spies } = makeDeps(fx);
    const out = await processQuote(deps, goodBody(), META);
    ok(out.status === 200 && out.body.ok === true, 'happy: 200 ok');
    ok(out.body.price_low === 5250 && out.body.price_high === 7000, 'happy: 1000 sqft prices 5250-7000');
    ok(out.body.price_low_label === '$5,250' && out.body.price_high_label === '$7,000', 'happy: labels formatted');
    ok(out.body.copy === 'Between $5,250 and $7,000.', 'happy: reveal copy substituted');
    ok(out.body.in_area === true && out.body.booking.open === true, 'happy: in area, booking open');
    ok(fx.db.leads.length === 1, 'happy: one lead created');
    const lead = fx.db.leads[0];
    ok(lead.source === 'Instant Pricing' && lead.stage === 'new' && lead.sms_consent === true, 'happy: lead source/stage/consent');
    ok(String(lead.sms_consent_source || '').includes('implied consent'), 'happy: consent source recorded');
    ok(fx.db.lead_events.some(e => e.event_type === 'created' && e.payload && e.payload.via === 'instant_pricing' && e.payload.price_low === 5250), 'happy: created event carries the shown price');
    ok(spies.scored.length === 1 && spies.scored[0] === lead.id, 'happy: lead AI kicked');
    ok(fx.db.pec_notifications.some(n => n.type === 'lead_created'), 'happy: bell row written');
    const row = fx.db.pec_pricing_requests[0];
    ok(row && row.status === 'priced' && row.price_low === 5250 && row.price_high === 7000, 'happy: audit row snapshots the price');
    ok(row.lead_id === lead.id && row.ip_hash === 'hash1', 'happy: audit row linked to lead + hashed ip');
    ok(out.body.request_id === row.id, 'happy: request_id returned');
  }

  // ---- Honeypot: fake success, no lead, truthful audit row -----------------
  {
    const fx = makeDb(baseTables());
    const { deps } = makeDeps(fx);
    const out = await processQuote(deps, goodBody({ website: 'http://spam.example' }), META);
    ok(out.status === 200 && out.body.ok === true && out.body.price_low === 5250, 'honeypot: plausible success from real rates');
    ok(fx.db.leads.length === 0, 'honeypot: no lead');
    ok(fx.db.pec_pricing_requests.some(r => r.status === 'rejected' && r.error_text === 'honeypot'), 'honeypot: rejected row records truth');
  }

  // ---- Min fill time -------------------------------------------------------
  {
    const fx = makeDb(baseTables());
    const { deps } = makeDeps(fx);
    const out = await processQuote(deps, goodBody({ fill_ms: 500 }), META);
    ok(out.status === 400 && fx.db.pec_pricing_requests.some(r => r.error_text === 'too_fast'), 'too fast: 400 + rejected row');
    ok(fx.db.leads.length === 0, 'too fast: no lead');
  }

  // ---- Rate limit ----------------------------------------------------------
  {
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    const fx = makeDb(baseTables({
      pec_pricing_requests: [1, 2, 3].map(i => ({
        id: `prior-${i}`, status: 'priced', ip_hash: 'hash1', created_at: recent,
        phone: `100000000${i}`, email: `x${i}@example.com`, project_type_id: TYPE_FLAKE,
      })),
    }));
    const { deps } = makeDeps(fx);
    const out = await processQuote(deps, goodBody(), META);
    ok(out.status === 429, 'rate limit: 429 at the cap');
    ok(fx.db.pec_pricing_requests.some(r => r.error_text === 'rate_limit'), 'rate limit: rejected row written');
    ok(fx.db.leads.length === 0, 'rate limit: no lead');
  }

  // ---- Duplicate window: same person re-asks, gets the SAME stored range ---
  {
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    const fx = makeDb(baseTables({
      pec_pricing_requests: [{
        id: 'prior-1', status: 'priced', ip_hash: 'otherhash', created_at: recent,
        phone: '9285551212', email: 'jane@example.com', project_type_id: TYPE_FLAKE,
        price_low: 4000, price_high: 5000, lead_id: 'lead-1', in_area: true,
      }],
    }));
    const { deps } = makeDeps(fx);
    const out = await processQuote(deps, goodBody(), META);
    ok(out.status === 200 && out.body.duplicate === true, 'duplicate: answered as duplicate');
    ok(out.body.price_low === 4000 && out.body.price_high === 5000, 'duplicate: STORED prices, not recomputed');
    ok(fx.db.leads.length === 0, 'duplicate: no second lead');
    ok(fx.db.pec_pricing_requests.some(r => r.error_text === 'duplicate'), 'duplicate: audit row written');
  }

  // ---- Out of area: price still shows, lead still lands, no booking --------
  {
    const fx = makeDb(baseTables());
    const { deps } = makeDeps(fx);
    const out = await processQuote(deps, goodBody({ city: 'Phoenix', zip: '85001' }), META);
    ok(out.status === 200 && out.body.ok === true && out.body.price_low === 5250, 'out of area: still priced');
    ok(out.body.in_area === false && out.body.booking.open === false, 'out of area: booking closed');
    ok(out.body.out_of_area_copy === 'OUT OF AREA COPY', 'out of area: copy from settings');
    ok(fx.db.leads.length === 1, 'out of area: lead still created');
    ok(fx.db.pec_pricing_requests.some(r => r.status === 'out_of_area'), 'out of area: audit status');
  }

  // ---- Call-us type: no range, straight to booking -------------------------
  {
    const fx = makeDb(baseTables());
    const { deps } = makeDeps(fx);
    const out = await processQuote(deps, goodBody({ project_type_id: TYPE_CALLUS, sqft: '' }), META);
    ok(out.status === 200 && out.body.priceable === false && out.body.price_low === null, 'call us: no range');
    ok(out.body.copy === 'CALL US COPY', 'call us: copy from settings');
    ok(out.body.booking.open === true, 'call us: booking continuation offered');
    ok(fx.db.pec_pricing_requests.some(r => r.status === 'call_us'), 'call us: audit status');
    ok(fx.db.leads.length === 1, 'call us: lead created');
  }

  // ---- Same-human dedupe: repeat inquirer lands on the existing lead -------
  {
    const recent = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const fx = makeDb(baseTables({
      leads: [{ id: 'lead-9', phone: '9285551212', email: 'jane@example.com', stage: 'contacted', customer_id: 'cust-9', created_at: recent, deleted_at: null, full_name: 'Jane Doe' }],
    }));
    const { deps, spies } = makeDeps(fx);
    const out = await processQuote(deps, goodBody(), META);
    ok(out.status === 200 && out.body.ok === true, 'dedupe: still answered');
    ok(fx.db.leads.length === 1, 'dedupe: no second lead');
    ok(fx.db.lead_events.some(e => e.lead_id === 'lead-9' && e.event_type === 'note' && String(e.payload.text || '').includes('instant pricing')), 'dedupe: note on the existing lead');
    ok(spies.scored.length === 0, 'dedupe: AI not re-billed');
    ok(fx.db.pec_pricing_requests[0].lead_id === 'lead-9', 'dedupe: audit row links the existing lead');
  }

  // ---- Instant-reply delay: enrollment scheduled out, no inline send -------
  {
    const CAMPAIGN = [{ id: 'camp1', kind: 'lead', status: 'active', created_at: '2026-08-01T00:00:00Z' }];
    const STEP0 = [{ id: 'step0', campaign_id: 'camp1', active: true, step_index: 0, day_offset: 0, auto_send: true }];
    const fx = makeDb(baseTables({ pec_drip_campaigns: CAMPAIGN, pec_drip_steps: STEP0 }));
    const { deps } = makeDeps(fx);
    const before = Date.now();
    const out = await processQuote(deps, goodBody(), META);
    ok(out.status === 200 && out.body.ok === true, 'delay: quote still answered');
    const enr = fx.db.pec_drip_enrollments[0];
    ok(!!enr && enr.status === 'active', 'delay: lead enrolled');
    const sendAt = enr ? new Date(enr.next_send_at).getTime() : 0;
    ok(sendAt >= before + 9.5 * 60000 && sendAt <= Date.now() + 10.5 * 60000, 'delay: day-0 send scheduled ~10 minutes out');
    ok(fx.db.pec_drip_sends.length === 0, 'delay: nothing sent inline');
  }
  {
    // Delay 0 restores the inline-immediate path: the enrollment is due NOW
    // and sendInstantTouch runs (it bails on the missing instant-touch
    // settings here, which is fine; due-now scheduling is the claim).
    const t = baseTables({
      pec_drip_campaigns: [{ id: 'camp1', kind: 'lead', status: 'active', created_at: '2026-08-01T00:00:00Z' }],
      pec_drip_steps: [{ id: 'step0', campaign_id: 'camp1', active: true, step_index: 0, day_offset: 0, auto_send: true }],
    });
    t.settings.find(s => s.key === 'pricing_instant_touch_delay_minutes').value = '0';
    const fx = makeDb(t);
    const { deps } = makeDeps(fx);
    const before = Date.now();
    const out = await processQuote(deps, goodBody(), META);
    ok(out.status === 200, 'delay 0: quote answered');
    const enr = fx.db.pec_drip_enrollments[0];
    const sendAt = enr ? new Date(enr.next_send_at).getTime() : 0;
    ok(!!enr && sendAt <= before + 60000, 'delay 0: day-0 send due immediately');
  }

  // ---- Validation ----------------------------------------------------------
  {
    const fx = makeDb(baseTables());
    const { deps } = makeDeps(fx);
    const out = await processQuote(deps, goodBody({ email: 'not-an-email', name: '' }), META);
    ok(out.status === 400 && /name/.test(out.body.error) && /email/.test(out.body.error), 'validation: missing fields listed');
    const out2 = await processQuote(deps, goodBody({ sqft: '10' }), META);
    ok(out2.status === 400 && /square footage/i.test(out2.body.error), 'validation: sqft below minimum');
    ok(fx.db.leads.length === 0, 'validation: no lead on rejects');
  }

  // ---- Gate ----------------------------------------------------------------
  {
    const t = baseTables();
    t.settings.find(s => s.key === 'pricing_enabled').value = 'false';
    const fx = makeDb(t);
    const { deps } = makeDeps(fx);
    const out = await processQuote(deps, goodBody(), META);
    ok(out.status === 503, 'gate: 503 while dark');
  }

  // ---- Booking dark: priced but no continuation ----------------------------
  {
    const t = baseTables();
    t.settings.find(s => s.key === 'booking_enabled').value = 'false';
    const fx = makeDb(t);
    const { deps } = makeDeps(fx);
    const out = await processQuote(deps, goodBody(), META);
    ok(out.status === 200 && out.body.booking.open === false, 'booking dark: priced, continuation off');
  }

  // ---- Booked callback: server-verified link -------------------------------
  {
    const REQ = '33333333-3333-3333-3333-333333333333';
    const APPT = '44444444-4444-4444-4444-444444444444';
    const fx = makeDb(baseTables({
      pec_pricing_requests: [{ id: REQ, status: 'priced', lead_id: 'lead-1', booked_appointment_id: null }],
      pec_appointments: [{ id: APPT, source: 'booking', lead_id: 'lead-1' }],
    }));
    const { deps } = makeDeps(fx);
    const out = await processBookedCallback(deps, { request_id: REQ, appointment_id: APPT });
    ok(out.status === 200 && out.body.ok === true, 'booked: ok on matching lead');
    ok(fx.db.pec_pricing_requests[0].booked_appointment_id === APPT, 'booked: appointment linked');
  }
  {
    const REQ = '33333333-3333-3333-3333-333333333333';
    const APPT = '44444444-4444-4444-4444-444444444444';
    const fx = makeDb(baseTables({
      pec_pricing_requests: [{ id: REQ, status: 'priced', lead_id: 'lead-1', booked_appointment_id: null }],
      pec_appointments: [{ id: APPT, source: 'booking', lead_id: 'DIFFERENT-lead' }],
    }));
    const { deps } = makeDeps(fx);
    const out = await processBookedCallback(deps, { request_id: REQ, appointment_id: APPT });
    ok(out.status === 400 && !fx.db.pec_pricing_requests[0].booked_appointment_id, 'booked: mismatched lead rejected');
    const out2 = await processBookedCallback(deps, { request_id: 'nope', appointment_id: APPT });
    ok(out2.status === 400, 'booked: malformed ids rejected');
  }

  console.log(`pricing: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
