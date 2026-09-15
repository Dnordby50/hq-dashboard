'use strict';

// Synthetic fixtures only. No production appointments, provider requests,
// customer communications, or persistent database records are created.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sameHumanOr, findRecentLiveLead, resolveOrCreateCustomer } = require('../netlify/functions/_pec-lead-match.cjs');
const { driveMinutesFor } = require('../netlify/functions/_pec-booking-drive.cjs');
const booking = require('../netlify/functions/pec-booking.cjs');
const pricing = require('../netlify/functions/pec-pricing.cjs');
const { makeDb } = require('./_drip-test-kit.cjs');

const NOW = new Date('2026-09-14T15:00:00Z');
const IP_HASH = crypto.createHash('sha256').update('fixture-connection').digest('hex');
const SLOT_BODY = { form: 'pec', address1: '123 Fixture Lane', city: 'Prescott', zip: '86301' };

function slotsDb({ allowed = true, malformed = false, unavailable = false, limit = '60' } = {}) {
  const calls = [];
  return {
    calls,
    sb: async (method, path, payload) => {
      calls.push({ method, path, payload });
      if (path.startsWith('/settings?')) return [
        { key: 'booking_enabled', value: 'true' },
        { key: 'booking_drive_time_enabled', value: 'false' },
        { key: 'booking_slots_rate_limit_per_hour', value: limit },
      ];
      if (path === '/rpc/pec_take_rate_limit') {
        if (unavailable) throw new Error('fixture database unavailable');
        return malformed ? {} : { allowed, remaining: allowed ? 59 : 0, retry_after: allowed ? 0 : 47 };
      }
      if (path.startsWith('/pec_booking_forms?')) return [{ id: 'fixture-form', active: true, appt_types: [] }];
      if (path.startsWith('/pec_booking_service_areas?')) return [{ zip: '86301', city: 'Prescott' }];
      if (method === 'GET') return [];
      throw new Error(`unexpected fixture write ${path}`);
    },
  };
}

function driveDb({ allowed = true, unavailable = false, cached = [] } = {}) {
  const calls = [];
  return {
    calls,
    sb: async (method, path, payload) => {
      calls.push({ method, path, payload });
      if (method === 'GET' && path.startsWith('/pec_drive_time_cache?')) return cached;
      if (path === '/rpc/pec_take_rate_limit') {
        if (unavailable) throw new Error('fixture budget database unavailable');
        return { allowed, remaining: allowed ? 199 : 0, retry_after: allowed ? 0 : 300 };
      }
      if (method === 'POST' && path === '/pec_drive_time_cache') return [];
      throw new Error(`unexpected drive fixture operation ${method} ${path}`);
    },
  };
}

test('shared matching treats punctuation and filter-looking email text as one literal value', async () => {
  const email = 'fixture@invalid.test,phone.eq.9285559999';
  const fx = makeDb({
    leads: [{ id: 'other-lead', phone: '9285559999', email: 'other@invalid.test', created_at: NOW.toISOString(), deleted_at: null }],
    customers: [{ id: 'other-customer', phone: '9285559999', email: 'other@invalid.test', archived_at: null }],
  });
  const found = await findRecentLiveLead(fx.sb, { email, now: NOW });
  assert.equal(found, null);
  const created = await resolveOrCreateCustomer(fx.sb, { name: 'Fixture New', email });
  assert.equal(created.created, true);
  assert.notEqual(created.customer_id, 'other-customer');
  assert.equal(fx.db.customers[1].email, email);
});

test('quoted emails, backslashes, plus aliases, and commas still match only the intended email', async () => {
  for (const email of ['fixture+alias@invalid.test', 'fixture,comma@invalid.test', 'fixture"quote\\name@invalid.test']) {
    const fx = makeDb({ leads: [{ id: 'literal-match', email, phone: '9285550000', created_at: NOW.toISOString(), deleted_at: null }] });
    const found = await findRecentLiveLead(fx.sb, { email, now: NOW });
    assert.equal(found && found.id, 'literal-match', email);
  }
});

test('phone matching normalizes real numbers and never matches a partial or wildcard phone', () => {
  assert.equal(decodeURIComponent(sameHumanOr('+1 (928) 555-1212', null)), 'phone.ilike.*9285551212');
  assert.equal(sameHumanOr('*', null), null);
  assert.equal(sameHumanOr('1212', null), null);
});

test('allowed slots spend a persistent per-connection quota before reading schedules', async () => {
  const fx = slotsDb({ limit: '37' });
  const out = await booking.processSlots({ sb: fx.sb, now: () => NOW }, SLOT_BODY, { ipHash: IP_HASH });
  assert.equal(out.status, 200);
  const index = fx.calls.findIndex(c => c.path === '/rpc/pec_take_rate_limit');
  const request = fx.calls[index];
  assert.deepEqual(request.payload, { p_scope: 'booking_slots', p_key: IP_HASH, p_limit: 37, p_window_seconds: 3600 });
  assert.ok(index < fx.calls.findIndex(c => c.path.startsWith('/pec_appointments?')));
});

test('slots quota exhaustion returns 429 and reads no schedules or drive times', async () => {
  const fx = slotsDb({ allowed: false });
  let driveCalls = 0;
  const out = await booking.processSlots({ sb: fx.sb, drive: async () => { driveCalls++; } }, SLOT_BODY, { ipHash: IP_HASH });
  assert.equal(out.status, 429);
  assert.equal(out.headers['Retry-After'], '47');
  assert.equal(driveCalls, 0);
  assert.equal(fx.calls.some(c => /pec_appointments|pec_drive_time_cache|pec_sales_team_members/.test(c.path)), false);
});

test('slots fail closed when the persistent limiter errors or returns malformed data', async () => {
  for (const config of [{ unavailable: true }, { malformed: true }]) {
    const fx = slotsDb(config);
    const out = await booking.processSlots({ sb: fx.sb }, SLOT_BODY, { ipHash: IP_HASH });
    assert.equal(out.status, 503);
    assert.equal(fx.calls.some(c => c.path.startsWith('/pec_appointments?')), false);
  }
});

test('slots without an IP still consume a stable shared anonymous quota', async () => {
  const one = slotsDb();
  const two = slotsDb();
  await booking.processSlots({ sb: one.sb, now: () => NOW }, SLOT_BODY);
  await booking.processSlots({ sb: two.sb, now: () => NOW }, SLOT_BODY);
  const key = one.calls.find(c => c.path === '/rpc/pec_take_rate_limit').payload.p_key;
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, two.calls.find(c => c.path === '/rpc/pec_take_rate_limit').payload.p_key);
});

test('booking requests consume quota before duplicate-contact lookup', async () => {
  const fx = slotsDb({ allowed: false });
  const out = await booking.processBook({ sb: fx.sb, now: () => NOW, logIngest: async () => {} },
    { ...SLOT_BODY, name: 'Fixture Person', phone: '9285551111', email: 'fixture@invalid.test',
      start: '2026-09-15T17:00:00Z', fill_ms: 5000 }, { ipHash: IP_HASH });
  assert.equal(out.status, 429);
  assert.equal(fx.calls.some(c => c.path.includes('phone=eq.')), false);
  assert.equal(fx.calls.some(c => c.path.startsWith('/leads?')), false);
});

test('callback capture is closed when booking is disabled or its persistent quota is exhausted', async () => {
  for (const disabled of [false, true]) {
    const fx = slotsDb({ allowed: false });
    const sb = async (method, path, payload) => {
      const out = await fx.sb(method, path, payload);
      if (disabled && path.startsWith('/settings?')) return out.map(r => r.key === 'booking_enabled' ? { ...r, value: 'false' } : r);
      return out;
    };
    const out = await booking.processOutOfAreaLead({ sb, logIngest: async () => {} },
      { ...SLOT_BODY, name: 'Fixture Person', phone: '9285551111' }, { ipHash: IP_HASH });
    assert.equal(out.status, disabled ? 503 : 429);
    assert.equal(fx.calls.some(c => /\/(leads|customers|lead_events)/.test(c.path)), false);
  }
});

test('Routes budget denial or outage preserves cached results without making a provider request', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; throw new Error('provider must not be called'); });
  for (const config of [{ allowed: false }, { unavailable: true }]) {
    const fx = driveDb({ ...config, cached: [{ origin_key: 'cached', minutes: 12 }] });
    const out = await driveMinutesFor(fx.sb,
      [{ key: 'cached', address: 'Fixture Cache' }, { key: 'new', address: 'Fixture New' }],
      { key: 'destination', address: 'Fixture Destination' }, { apiKey: 'fixture-only-key' });
    assert.deepEqual(out, { cached: 12 });
  }
  assert.equal(calls, 0);
});

test('Routes cache-only and missing-key requests do not consume the paid-call budget', async (t) => {
  t.mock.method(global, 'fetch', async () => { throw new Error('provider must not be called'); });
  const fx = driveDb({ cached: [{ origin_key: 'cached', minutes: 12 }] });
  assert.deepEqual(await driveMinutesFor(fx.sb, [{ key: 'cached', address: 'Fixture Cache' }],
    { key: 'destination', address: 'Fixture Destination' }, { apiKey: 'fixture-only-key' }), { cached: 12 });
  assert.equal(fx.calls.some(c => c.path === '/rpc/pec_take_rate_limit'), false);
  const priorKey = process.env.GOOGLE_ROUTES_API_KEY;
  delete process.env.GOOGLE_ROUTES_API_KEY;
  try {
    await driveMinutesFor(fx.sb, [{ key: 'missing', address: 'Fixture Missing' }], { key: 'destination', address: 'Fixture Destination' });
    assert.equal(fx.calls.some(c => c.path === '/rpc/pec_take_rate_limit'), false);
  } finally {
    if (priorKey !== undefined) process.env.GOOGLE_ROUTES_API_KEY = priorKey;
  }
});

test('Routes consumes one global daily call and bounds origin count before the request', async (t) => {
  const fx = driveDb();
  const sent = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(fx.calls.some(c => c.path === '/rpc/pec_take_rate_limit'));
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => [{ originIndex: 0, duration: '900s', distanceMeters: 1000 }] };
  });
  const origins = Array.from({ length: 110 }, (_, i) => ({ key: `origin-${i}`, address: `Fixture ${i}` }));
  const result = await driveMinutesFor(fx.sb, origins, { key: 'destination', address: 'Fixture Destination' },
    { apiKey: 'fixture-only-key', maxOrigins: 50000, rateLimitPerDay: 19 });
  const budget = fx.calls.find(c => c.path === '/rpc/pec_take_rate_limit').payload;
  assert.equal(budget.p_scope, 'booking_routes');
  assert.equal(budget.p_limit, 19);
  assert.equal(budget.p_window_seconds, 86400);
  assert.match(budget.p_key, /^[a-f0-9]{64}$/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].origins.length, 100);
  assert.deepEqual(result, { 'origin-0': 15 });
});

test('public APIs reject null, arrays, oversized bodies, and oversized fields without database calls', async (t) => {
  t.mock.method(global, 'fetch', async () => { throw new Error('no external calls for invalid input'); });
  for (const [handler, path] of [[booking.handler, '/api/booking/book'], [pricing.handler, '/api/pricing/quote']]) {
    for (const body of ['null', '[]', JSON.stringify({ email: 'a'.repeat(255) })]) {
      const result = await handler({ path, httpMethod: 'POST', body, headers: {} });
      assert.equal(result.statusCode, 400);
      assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(result.headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
      assert.equal(result.headers['Cache-Control'], 'no-store');
    }
    const result = await handler({ path, httpMethod: 'POST', body: ' '.repeat(65537), headers: {} });
    assert.equal(result.statusCode, 413);
  }
});

test('HTML responses retain embed support and Maps-compatible referrers', () => {
  for (const render of [booking.htmlResponse, pricing._internals.htmlResponse]) {
    const result = render(200, '<p>fixture</p>');
    assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(result.headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.equal(result.headers['X-Frame-Options'], undefined);
    assert.equal(result.headers['Content-Security-Policy'], undefined);
    assert.equal(result.body, '<p>fixture</p>');
  }
});

test('Instant Pricing duplicate lookup treats the email as a literal and retains the correct person', async (t) => {
  t.mock.method(global, 'fetch', async () => { throw new Error('no provider calls from synthetic quote'); });
  const email = 'fixture@invalid.test,phone.eq.9285559999';
  const fx = makeDb({
    settings: [{ key: 'pricing_enabled', value: 'true' }, { key: 'pricing_instant_touch_delay_minutes', value: '10' }],
    pec_pricing_project_types: [{ id: 'fixture-type', name: 'Fixture', brand: 'PEC', active: true, priceable: false }],
    pec_pricing_requests: [{ id: 'other-request', phone: '9285559999', email: 'other@invalid.test',
      project_type_id: 'fixture-type', status: 'call_us', created_at: new Date().toISOString(), lead_id: 'other-lead' }],
    pec_booking_forms: [], pec_booking_service_areas: [],
    leads: [], customers: [], lead_events: [], pec_lead_sources: [], pec_notifications: [],
    pec_drip_campaigns: [], pec_drip_enrollments: [], pec_drip_steps: [], pec_email_senders: [],
  });
  const result = await pricing.processQuote({ sb: fx.sb, logIngest: async () => {}, kickLeadAi: async () => {} },
    { project_type_id: 'fixture-type', name: 'Fixture Person', phone: '9285551111', email,
      address1: 'Fixture Address', city: 'Prescott', fill_ms: 5000 }, { ipHash: IP_HASH, userAgent: 'fixture' });
  assert.equal(result.status, 200);
  assert.equal(result.body.duplicate, undefined);
  assert.notEqual(result.body.request_id, 'other-request');
  assert.equal(fx.db.leads.length, 1);
  assert.equal(fx.db.leads[0].email, email);
});

test('Instant Pricing fails closed on rate-limit errors or exhaustion before any contact write', async (t) => {
  t.mock.method(global, 'fetch', async () => { throw new Error('no provider calls from synthetic quote'); });
  for (const unavailable of [true, false]) {
    const writes = [];
    const sb = async (method, path, payload) => {
      if (path.startsWith('/settings?')) return [{ key: 'pricing_enabled', value: 'true' }];
      if (path.startsWith('/pec_pricing_project_types?')) return [{ id: 'fixture-type', name: 'Fixture', priceable: false }];
      if (path === '/rpc/pec_take_rate_limit') {
        if (unavailable) throw new Error('fixture limiter unavailable');
        return { allowed: false, remaining: 0, retry_after: 30 };
      }
      if (method === 'GET') return [];
      writes.push({ path, payload });
      return [];
    };
    const result = await pricing.processQuote({ sb, logIngest: async () => {}, kickLeadAi: async () => {} },
      { project_type_id: 'fixture-type', name: 'Fixture Person', phone: '9285551111', email: 'fixture@invalid.test',
        address1: 'Fixture Address', city: 'Prescott', fill_ms: 5000 }, { ipHash: IP_HASH });
    assert.equal(result.status, unavailable ? 503 : 429);
    assert.deepEqual(writes, []);
  }
});
