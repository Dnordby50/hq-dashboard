// TopCoat Instant Pricing: the public ballpark-price funnel that replaces the
// Price Guide AI subscription on the marketing website.
//
// Routes (netlify.toml):
//   GET  /pricing                    the hosted pricing page (?embed=1 iframe,
//                                    ?preview=1 Settings live preview)
//   POST /api/pricing/quote          contact capture + the price range write
//   POST /api/pricing/booked         links a same-visit booking back to the
//                                    quote row (server-verified)
//   GET  /api/pricing/config         machine-readable price book (the
//                                    Google-instant-pricing future hook)
//
// FLOW: project type (photo grid) -> sqft + address -> name/phone/email ->
// price range reveal -> straight into the REAL booking engine. The lead is
// created AT CONTACT CAPTURE, before any price renders, so a visitor who
// abandons at the reveal is still captured. The booking continuation is
// CLIENT-SIDE reuse of the live /api/booking/* endpoints (same payloads the
// /book page sends): booking's abuse checks, advisory-locked write, audit
// rows, and funnel card all apply unchanged, and processBook's resolveContact
// finds the just-created pricing lead by phone/email, links the appointment,
// advances the stage, and pauses nurture. Zero server-side coupling.
//
// PRICE MATH (Dylan's locked decision): manual $/sqft low/high ranges per
// project type from pec_pricing_project_types, NOT the estimator engine. The
// range math lives in production/pricing-range.cjs (pure, tested). Rates are
// never embedded in the page; the price only comes back from the quote POST,
// after contact capture.
//
// LEAD TREATMENT (Dylan's locked decision): the full pec-lead-intake webform
// treatment: same-human dedupe, customer-first create, lead AI kick, drip
// enroll + day-0 instant touch, Slack + bell. If they book minutes later,
// apptBookingLeadEffects pauses the nurture sequence, matching how booked
// leads already behave.
//
// ABUSE (the pec-booking Part F kit): offscreen honeypot (fake success
// computed from REAL rates so the bot learns nothing; the request row records
// the truth), minimum fill time, per-ip_hash quotes-per-hour limit read from
// pec_pricing_requests, and a duplicate window that answers a repeat
// phone/email with the SAME stored range instead of a second lead.
// Rejections still write rows so a blocked real customer is visible.
//
// FAIL-OPEN COPY, FAIL-CLOSED WRITES: any render failure shows the call-us
// card; nothing customer-facing ever shows a stack trace. An empty price book
// or pricing_enabled=false renders "almost ready", never an error.

'use strict';

const crypto = require('crypto');
const { sb, json, logIngest, writeHeartbeat } = require('./_pec-supabase.cjs');
const { normPhone, findRecentLiveLead, resolveOrCreateCustomer } = require('./_pec-lead-match.cjs');
const { resolveLeadSourceName } = require('./_pec-lead-source.cjs');
const { enrollLead, sendInstantTouch } = require('./_pec-drip.cjs');
const { notifyLeadSlack, notifyLeadBell } = require('./_pec-lead-notify.cjs');
// checkArea is booking's zip-first/city-second allowlist test; importing it
// keeps the pricing page's in-area verdict identical to /book's by
// construction. (If pec-booking ever grows require-time side effects, extract
// checkArea to production/ instead.)
const { checkArea } = require('./pec-booking.cjs');
const { computePriceRange, fmtMoney, renderRevealCopy } = require('../../production/pricing-range.cjs');

const ENDPOINT = 'pricing';
const SITE_URL = process.env.URL || 'https://prescottepoxy.netlify.app';
const SUPABASE_URL = process.env.SUPABASE_URL;

const cleanStr = (s) => { const v = String(s == null ? '' : s).trim(); return v || null; };
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---------------------------------------------------------------------------
// Settings / data loaders
// ---------------------------------------------------------------------------

const SETTING_KEYS = [
  'pricing_enabled', 'pricing_url', 'pricing_headline', 'pricing_intro_text',
  'pricing_reveal_copy', 'pricing_round_to', 'pricing_min_sqft',
  'pricing_max_sqft', 'pricing_rate_limit_per_hour',
  'pricing_min_fill_seconds', 'pricing_duplicate_window_hours',
  'pricing_out_of_area_copy', 'pricing_call_us_copy',
  'booking_enabled', 'booking_sms_disclosure',
];

async function getPricingSettings(db) {
  const out = {};
  try {
    const rows = await db('GET', `/settings?key=in.(${SETTING_KEYS.join(',')})&select=key,value`);
    for (const r of (Array.isArray(rows) ? rows : [])) out[r.key] = r.value;
  } catch (e) {
    console.warn('pec-pricing: settings read failed, defaults apply:', e && e.message);
  }
  return out;
}

const numSetting = (s, key, dflt) => {
  const n = Number(s[key]);
  return isFinite(n) && s[key] != null && String(s[key]).trim() !== '' ? n : dflt;
};

const DEFAULT_REVEAL = 'Most projects like yours land between {low} and {high}. Your exact price depends on the condition of the concrete, which we confirm with a free on-site visit.';
const DEFAULT_OUT_OF_AREA = 'You are a little outside our normal service area. We saved your info and we will reach out to see what we can do.';
const DEFAULT_CALL_US = 'This one deserves a custom price. Book your free on-site visit and we will price it in person.';

async function loadProjectTypes(db, brand) {
  const rows = await db('GET',
    `/pec_pricing_project_types?brand=eq.${encodeURIComponent(brand || 'PEC')}&active=eq.true&select=id,name,description,image_path,rate_low,rate_high,min_price,priceable,sort_order&order=sort_order.asc.nullslast,name.asc`);
  return Array.isArray(rows) ? rows : [];
}

function typeImageUrl(p) {
  if (!p || !SUPABASE_URL) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/pec-pricing/${String(p).split('/').map(encodeURIComponent).join('/')}`;
}

// The booking context drives the same-visit continuation: is booking open,
// which questions does /api/booking/book require, and which service area
// decides in/out. Read-only; the booking write path stays booking's.
async function loadBookingContext(db, settings) {
  const out = { open: false, slug: 'pec', questions: [], area: [] };
  try {
    const rows = await db('GET', "/pec_booking_forms?slug=eq.pec&select=id,slug,active,questions&limit=1");
    const form = Array.isArray(rows) && rows[0];
    if (!form) return out;
    out.slug = form.slug;
    out.questions = Array.isArray(form.questions) ? form.questions : [];
    const area = await db('GET',
      `/pec_booking_service_areas?form_id=eq.${encodeURIComponent(form.id)}&active=eq.true&select=zip,city`);
    out.area = Array.isArray(area) ? area : [];
    out.open = form.active !== false
      && String(settings.booking_enabled || 'false') === 'true'
      && out.area.length > 0;
  } catch (e) {
    console.warn('pec-pricing: booking context read failed (continuation off):', e && e.message);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lead creation: the full pec-lead-intake webform treatment (Dylan's locked
// decision 3), sharing the same modules so behavior cannot drift.
// ---------------------------------------------------------------------------

const AI_TRIGGER_WAIT_MS = 2500;
async function kickLeadAi(leadId) {
  try {
    const req = fetch(`${SITE_URL}/.netlify/functions/pec-lead-ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': process.env.PEC_WEBHOOK_SECRET || '' },
      body: JSON.stringify({ lead_id: leadId }),
    }).then(
      (res) => { if (!res.ok) console.warn(`pec-pricing: AI trigger returned ${res.status} for lead ${leadId}`); },
      (err) => { console.warn('pec-pricing: AI trigger failed:', err && err.message); }
    );
    await Promise.race([req, new Promise(r => setTimeout(r, AI_TRIGGER_WAIT_MS))]);
  } catch (e) { console.warn('pec-pricing: AI trigger threw:', e && e.message); }
}

// Returns { lead_id, customer_id, deduped } and never throws: a lead-pipeline
// failure logs and returns nulls so the audit row still lands (the visitor
// still gets their price; the miss is visible in the request row).
async function captureLead(db, f, hooks = {}) {
  const ai = hooks.kickLeadAi || kickLeadAi;
  try {
    const source = await resolveLeadSourceName(db, 'instant_pricing');
    const projectLine = `${f.typeName}${f.sqft ? `, about ${f.sqft} sqft` : ''}${f.priceLow != null ? `, quoted ${fmtMoney(f.priceLow)} to ${fmtMoney(f.priceHigh)}` : ''}`;

    // Same-human dedupe (90-day window, shared rule): the repeat inquiry
    // lands on the existing lead's timeline as a note; no second lead, no
    // re-enroll, no re-bill of the AI read. Same posture as the intake.
    const dupHuman = await findRecentLiveLead(db, { phone10: f.phone10, email: f.email });
    if (dupHuman) {
      await db('POST', '/lead_events', {
        lead_id: dupHuman.id,
        event_type: 'note',
        payload: {
          text: `Requested instant pricing again: ${projectLine}.`,
          via: 'instant_pricing',
          project_type: f.typeName, sqft: f.sqft,
          price_low: f.priceLow, price_high: f.priceHigh, in_area: f.inArea,
        },
      }).catch(e => console.warn('pec-pricing: dedupe note failed (non-fatal):', e && e.message));
      return { lead_id: dupHuman.id, customer_id: dupHuman.customer_id || null, deduped: true };
    }

    let customer = { customer_id: null, created: false };
    try {
      customer = await resolveOrCreateCustomer(db, {
        name: f.name, firstName: f.firstName, lastName: f.lastName,
        phone10: f.phone10, email: f.email,
        address: f.address, city: f.city, state: f.state, zip: f.zip,
        source, brand: 'PEC',
      });
    } catch (e) {
      console.warn('pec-pricing: customer resolve failed (lead lands unlinked):', e && e.message);
    }

    const created = await db('POST', '/leads', {
      brand: 'PEC',
      customer_id: customer.customer_id,
      source,
      first_name: f.firstName,
      last_name: f.lastName,
      full_name: f.name,
      email: f.email,
      phone: f.phone10 || null,
      address: f.address, city: f.city, state: f.state, zip: f.zip,
      stage: 'new',
      notes: `Instant pricing request: ${projectLine}.`,
      sms_consent: true,
      sms_consent_source: 'instant pricing form (implied consent policy 2026-08-21)',
      sms_consent_at: new Date().toISOString(),
    }, true);
    const lead = Array.isArray(created) && created[0];
    if (!lead) throw new Error('lead insert returned no row');

    await db('POST', '/lead_events', {
      lead_id: lead.id,
      event_type: 'created',
      to_stage: 'new',
      payload: {
        source, via: 'instant_pricing',
        project_type: f.typeName, sqft: f.sqft,
        price_low: f.priceLow, price_high: f.priceHigh, in_area: f.inArea,
        ...(f.disclosure ? { sms_consent_disclosure: f.disclosure } : {}),
      },
    }).catch(e => console.warn('pec-pricing: created lead_event failed (non-fatal):', e && e.message));

    await ai(lead.id);

    const enrolled = await enrollLead(db, lead.id);
    if (!enrolled.enrolled && enrolled.reason === 'error') {
      console.warn('pec-pricing: drip enroll failed (non-fatal):', enrolled.error);
    }
    let instant = { sent: [], skipped: [], reason: 'not_enrolled' };
    if (enrolled.enrolled) instant = await sendInstantTouch(db, lead.id);
    else if (enrolled.reason) instant.reason = `not_enrolled_${enrolled.reason}`;

    await notifyLeadSlack(lead, projectLine, instant);
    await notifyLeadBell(db, lead, instant);

    return { lead_id: lead.id, customer_id: customer.customer_id, deduped: false };
  } catch (e) {
    console.warn('pec-pricing: lead capture failed (quote still answered):', e && e.message);
    return { lead_id: null, customer_id: null, deduped: false };
  }
}

// ---------------------------------------------------------------------------
// Abuse control
// ---------------------------------------------------------------------------

function ipHashFrom(event) {
  const h = event.headers || {};
  const ip = cleanStr(h['x-nf-client-connection-ip'])
    || cleanStr(String(h['x-forwarded-for'] || '').split(',')[0])
    || 'unknown';
  return crypto.createHash('sha256').update(ip + '|' + (process.env.PEC_WEBHOOK_SECRET || 'pec')).digest('hex');
}

async function writeRequestRow(db, row) {
  try {
    const rows = await db('POST', '/pec_pricing_requests', row, true);
    return (Array.isArray(rows) && rows[0]) || null;
  } catch (e) {
    console.warn('pec-pricing: request row write failed (non-fatal):', e && e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /api/pricing/quote
// ---------------------------------------------------------------------------

async function processQuote(deps, body, meta) {
  const db = deps.sb;
  const log = deps.logIngest || logIngest;
  const settings = await getPricingSettings(db);

  if (String(settings.pricing_enabled || 'false') !== 'true') {
    return { status: 503, body: { ok: false, error: 'Instant pricing is not open right now. Please call us.' } };
  }

  const typeId = cleanStr(body.project_type_id);
  const name = cleanStr(body.name);
  const phoneRaw = cleanStr(body.phone);
  const phone10 = normPhone(phoneRaw);
  const email = cleanStr(body.email) ? cleanStr(body.email).toLowerCase() : null;
  const address1 = cleanStr(body.address1);
  const city = cleanStr(body.city);
  const state = cleanStr(body.state);
  const zip = cleanStr(body.zip);
  const placeId = cleanStr(body.place_id);
  const sqftRaw = cleanStr(body.sqft);
  const disclosure = cleanStr(settings.booking_sms_disclosure);

  const nameParts = String(name || '').split(/\s+/);
  const firstName = nameParts[0] || null;
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null;

  let types = [];
  try { types = await loadProjectTypes(db, 'PEC'); }
  catch (e) { console.warn('pec-pricing: types read failed:', e && e.message); }
  const type = types.find(t => t.id === typeId) || null;
  if (!type) {
    return { status: 400, body: { ok: false, error: 'Pick a project type.' } };
  }

  const booking = await loadBookingContext(db, settings);
  // An empty allowlist must never classify the whole world as out of area
  // (the pec-booking posture): the price still shows, booking just stays off.
  const areaCheck = booking.area.length ? checkArea(booking.area, zip, city) : { inArea: true };
  const inArea = areaCheck.inArea;

  // The range: computed for priceable types, absent for call-us types.
  const roundTo = numSetting(settings, 'pricing_round_to', 50);
  let range = null;
  if (type.priceable !== false) {
    range = computePriceRange({
      sqft: sqftRaw, rateLow: type.rate_low, rateHigh: type.rate_high,
      minPrice: type.min_price, roundTo,
      minSqft: numSetting(settings, 'pricing_min_sqft', 50),
      maxSqft: numSetting(settings, 'pricing_max_sqft', 20000),
    });
    if (!range.ok) {
      const msg = range.error === 'SQFT_TOO_SMALL' || range.error === 'SQFT_TOO_LARGE'
        ? 'That square footage is outside what we can price online. Give us a call and we will price it for you.'
        : (range.error === 'BAD_SQFT'
          ? 'Enter the approximate square footage as a number.'
          : 'We cannot price this project type online right now. Please call us.');
      return { status: 400, body: { ok: false, error: msg } };
    }
  }
  const sqftNum = sqftRaw != null && isFinite(Number(sqftRaw)) ? Number(sqftRaw) : null;

  const baseRow = {
    brand: 'PEC',
    project_type_id: type.id,
    project_type_name: type.name,
    sqft: sqftNum,
    rate_low: type.priceable !== false ? type.rate_low : null,
    rate_high: type.priceable !== false ? type.rate_high : null,
    price_low: range ? range.low : null,
    price_high: range ? range.high : null,
    name, phone: phone10 || phoneRaw, email,
    address_line1: address1, address_city: city, address_state: state, address_zip: zip,
    place_id: placeId, in_area: inArea,
    sms_consent: true, sms_consent_disclosure: disclosure,
    ip_hash: meta.ipHash, user_agent: meta.userAgent,
  };

  const revealCopy = renderRevealCopy(
    cleanStr(settings.pricing_reveal_copy) || DEFAULT_REVEAL,
    range ? range.low : 0, range ? range.high : 0);
  const callUsCopy = cleanStr(settings.pricing_call_us_copy) || DEFAULT_CALL_US;
  const outOfAreaCopy = cleanStr(settings.pricing_out_of_area_copy) || DEFAULT_OUT_OF_AREA;

  const okBody = (requestId, deduped) => ({
    ok: true,
    request_id: requestId || null,
    priceable: type.priceable !== false,
    price_low: range ? range.low : null,
    price_high: range ? range.high : null,
    price_low_label: range ? fmtMoney(range.low) : null,
    price_high_label: range ? fmtMoney(range.high) : null,
    copy: type.priceable !== false ? revealCopy : callUsCopy,
    in_area: inArea,
    out_of_area_copy: outOfAreaCopy,
    booking: { open: booking.open && inArea },
    ...(deduped ? { duplicate: true } : {}),
  });

  // Honeypot: the bot gets a REAL-looking success (computed from real rates
  // above) and learns nothing; the request row records the truth. No lead.
  if (cleanStr(body.website)) {
    await writeRequestRow(db, { ...baseRow, status: 'rejected', error_text: 'honeypot' });
    await log({ endpoint: ENDPOINT, customer_name: name, outcome: 'rejected', status_code: 200, message: 'honeypot', payload: body });
    return { status: 200, body: okBody(null, false) };
  }

  const minFillMs = numSetting(settings, 'pricing_min_fill_seconds', 2) * 1000;
  const fillMs = Number(body.fill_ms);
  if (isFinite(fillMs) && fillMs >= 0 && fillMs < minFillMs) {
    await writeRequestRow(db, { ...baseRow, status: 'rejected', error_text: 'too_fast' });
    await log({ endpoint: ENDPOINT, customer_name: name, outcome: 'rejected', status_code: 400, message: 'too fast', payload: body });
    return { status: 400, body: { ok: false, error: 'That was too fast. Please try again.' } };
  }

  // Contact + address validation. All three contact fields: the booking
  // continuation needs them anyway, and the whole point is a real lead.
  const missing = [];
  if (!name) missing.push('name');
  if (!phone10) missing.push('mobile phone');
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) missing.push('email');
  if (!address1 || (!zip && !city)) missing.push('project address');
  if (type.priceable !== false && sqftNum == null) missing.push('square footage');
  if (missing.length) {
    return { status: 400, body: { ok: false, error: `Please fill in: ${missing.join(', ')}.` } };
  }

  // Per-ip rate limit over the last hour, counting answered quotes.
  const rateLimit = numSetting(settings, 'pricing_rate_limit_per_hour', 10);
  try {
    const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const recent = await db('GET',
      `/pec_pricing_requests?ip_hash=eq.${encodeURIComponent(meta.ipHash)}&status=in.(priced,out_of_area,call_us)&created_at=gte.${encodeURIComponent(hourAgo)}&select=id&limit=${rateLimit + 1}`);
    if (Array.isArray(recent) && recent.length >= rateLimit) {
      await writeRequestRow(db, { ...baseRow, status: 'rejected', error_text: 'rate_limit' });
      await log({ endpoint: ENDPOINT, customer_name: name, outcome: 'rejected', status_code: 429, message: 'rate limit', payload: body });
      return { status: 429, body: { ok: false, error: 'Too many pricing requests from this connection. Please call us instead.' } };
    }
  } catch (e) {
    console.warn('pec-pricing: rate-limit read failed (allowing):', e && e.message);
  }

  // Duplicate window: the same person re-asking inside the window gets the
  // SAME stored answer (idempotency beats rate freshness inside 24h): no
  // second lead, no second drip enrollment, and the funnel is not inflated.
  const dupWindowH = numSetting(settings, 'pricing_duplicate_window_hours', 24);
  try {
    const ors = [];
    if (phone10) ors.push(`phone.eq.${phone10}`);
    if (email) ors.push(`email.eq.${email}`);
    if (ors.length && dupWindowH > 0) {
      const since = new Date(Date.now() - dupWindowH * 3600 * 1000).toISOString();
      // The whole or-expression is percent-encoded as one unit, the
      // sameHumanOr convention (PostgREST parses it after decoding).
      const prior = await db('GET',
        `/pec_pricing_requests?or=(${encodeURIComponent(ors.join(','))})&status=in.(priced,out_of_area,call_us)&project_type_id=eq.${encodeURIComponent(type.id)}&created_at=gte.${encodeURIComponent(since)}&select=id,price_low,price_high,lead_id,in_area&order=created_at.desc&limit=1`);
      const p = Array.isArray(prior) && prior[0];
      if (p) {
        await writeRequestRow(db, { ...baseRow, status: 'rejected', error_text: 'duplicate', lead_id: p.lead_id });
        await log({ endpoint: ENDPOINT, customer_name: name, outcome: 'ok', status_code: 200, message: `duplicate window; answered with request ${p.id}`, payload: body });
        const stored = { ...okBody(p.id, true) };
        if (p.price_low != null) {
          stored.price_low = Number(p.price_low); stored.price_high = Number(p.price_high);
          stored.price_low_label = fmtMoney(p.price_low); stored.price_high_label = fmtMoney(p.price_high);
          stored.copy = renderRevealCopy(cleanStr(settings.pricing_reveal_copy) || DEFAULT_REVEAL, p.price_low, p.price_high);
        }
        return { status: 200, body: stored };
      }
    }
  } catch (e) {
    console.warn('pec-pricing: duplicate-window read failed (continuing):', e && e.message);
  }

  // THE capture: lead first (never lost to a later failure), then the audit
  // row carrying the lead link and the exact numbers shown.
  const lead = await captureLead(db, {
    name, firstName, lastName, phone10, email,
    address: address1, city, state, zip,
    typeName: type.name, sqft: sqftNum,
    priceLow: range ? range.low : null, priceHigh: range ? range.high : null,
    inArea, disclosure,
  }, { kickLeadAi: deps.kickLeadAi });

  const status = type.priceable === false ? 'call_us' : (inArea ? 'priced' : 'out_of_area');
  const row = await writeRequestRow(db, {
    ...baseRow, status, lead_id: lead.lead_id, customer_id: lead.customer_id,
  });

  await log({
    endpoint: ENDPOINT, customer_name: name, outcome: 'ok', status_code: 200,
    message: `${status}${range ? ` ${fmtMoney(range.low)}-${fmtMoney(range.high)}` : ''} (${type.name}${sqftNum ? `, ${sqftNum} sqft` : ''}); lead ${lead.lead_id ? (lead.deduped ? 'matched' : 'created') : 'FAILED'}`,
    payload: body,
  });
  await writeHeartbeat('pec-pricing').catch(() => {});

  return { status: 200, body: okBody(row && row.id, false) };
}

// ---------------------------------------------------------------------------
// POST /api/pricing/booked: after the same-visit booking succeeds, the client
// reports the appointment id; we verify server-side that the appointment is a
// real booking belonging to the SAME lead before linking it (never
// client-trusted).
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function processBookedCallback(deps, body) {
  const db = deps.sb;
  const requestId = cleanStr(body.request_id);
  const apptId = cleanStr(body.appointment_id);
  if (!requestId || !apptId || !UUID_RE.test(requestId) || !UUID_RE.test(apptId)) {
    return { status: 400, body: { ok: false } };
  }
  try {
    const reqRows = await db('GET',
      `/pec_pricing_requests?id=eq.${encodeURIComponent(requestId)}&select=id,lead_id,booked_appointment_id&limit=1`);
    const req = Array.isArray(reqRows) && reqRows[0];
    if (!req || !req.lead_id) return { status: 404, body: { ok: false } };
    if (req.booked_appointment_id) return { status: 200, body: { ok: true } };
    const apptRows = await db('GET',
      `/pec_appointments?id=eq.${encodeURIComponent(apptId)}&select=id,lead_id,source&limit=1`);
    const appt = Array.isArray(apptRows) && apptRows[0];
    if (!appt || appt.source !== 'booking' || !appt.lead_id || appt.lead_id !== req.lead_id) {
      return { status: 400, body: { ok: false } };
    }
    await db('PATCH', `/pec_pricing_requests?id=eq.${encodeURIComponent(requestId)}`,
      { booked_appointment_id: appt.id });
    return { status: 200, body: { ok: true } };
  } catch (e) {
    console.warn('pec-pricing: booked callback failed:', e && e.message);
    return { status: 500, body: { ok: false } };
  }
}

// ---------------------------------------------------------------------------
// GET /api/pricing/config: the machine-readable price book. This is the
// future hook for Google instant-pricing integrations: everything a
// third-party surface needs to render our ranges, in one JSON read.
// ---------------------------------------------------------------------------

async function processConfig(deps) {
  const db = deps.sb;
  const settings = await getPricingSettings(db);
  const enabled = String(settings.pricing_enabled || 'false') === 'true';
  let types = [];
  if (enabled) {
    try { types = await loadProjectTypes(db, 'PEC'); }
    catch (e) { console.warn('pec-pricing: config types read failed:', e && e.message); }
  }
  return {
    status: 200,
    body: {
      ok: true,
      enabled,
      currency: 'USD',
      unit: 'sqft',
      round_to: numSetting(settings, 'pricing_round_to', 50),
      min_sqft: numSetting(settings, 'pricing_min_sqft', 50),
      max_sqft: numSetting(settings, 'pricing_max_sqft', 20000),
      types: types.map(t => ({
        id: t.id, name: t.name, description: t.description || null,
        image_url: typeImageUrl(t.image_path),
        priceable: t.priceable !== false,
        rate_low: t.priceable !== false ? Number(t.rate_low) : null,
        rate_high: t.priceable !== false ? Number(t.rate_high) : null,
        min_price: t.min_price != null ? Number(t.min_price) : null,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// HTML page (the /book design system, copied verbatim so the two public
// funnels are visually one product)
// ---------------------------------------------------------------------------

async function loadPricingBrand(db) {
  const dflt = {
    business_name: 'Prescott Epoxy Company', logo_url: null,
    primary_color: '#14181C', accent_color: '#D8531C', phone: '', license_number: '',
  };
  try {
    const rows = await db('GET', '/pec_brand_identity?brand=eq.prescott-epoxy&select=business_name,logo_url,primary_color,accent_color,phone,license_number&limit=1');
    if (Array.isArray(rows) && rows[0]) {
      const b = { ...dflt, ...rows[0] };
      if (!b.logo_url) b.logo_url = '/assets/pec-logo.png';
      return b;
    }
  } catch (_) { /* defaults */ }
  return { ...dflt, logo_url: '/assets/pec-logo.png' };
}

function htmlResponse(statusCode, html) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': statusCode === 200 ? 'index, follow' : 'noindex, nofollow',
      'Cache-Control': 'no-store',
    },
    body: html,
  };
}

function pageShell(brand, title, inner, { embed = false, bare = false } = {}) {
  const accent = brand.accent_color || '#D8531C';
  const primary = brand.primary_color || '#14181C';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--accent:${esc(accent)};--ink:${esc(primary)};--muted:#8a919c;--line:#ececef;--bg:#f5f5f7}
*{box-sizing:border-box}body{margin:0;font-family:'Poppins',-apple-system,'Segoe UI',Arial,sans-serif;background:${embed ? 'transparent' : 'var(--bg)'};color:var(--ink)}
.wrap{max-width:540px;margin:0 auto;padding:${embed ? '4px' : '26px 14px 50px'}}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:22px;margin-top:14px;box-shadow:0 6px 24px rgba(20,24,31,.06)}
.bigcard{background:#fff;border:1px solid var(--line);border-radius:26px;box-shadow:0 12px 44px rgba(20,24,31,.09);overflow:hidden}
.bigcard .inner{padding:30px 24px 26px}
.bklogo{display:block;max-height:80px;max-width:230px;margin:0 auto 16px}
h1{text-align:center;font-size:1.85rem;font-weight:700;margin:.1em 0 .35em;letter-spacing:-.5px}
h1 .accentword{color:var(--accent);opacity:.85}
h2{font-size:1.02rem;margin:0 0 10px}
.q{text-align:center;font-size:1.22rem;font-weight:600;margin:6px 0 4px}
.qsub{text-align:center;color:var(--muted);font-size:.92rem;margin:0 0 18px}.qsub strong{color:var(--ink)}
p{line-height:1.5}.muted{color:var(--muted);font-size:.86rem}
label{display:block;font-size:.74rem;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--muted);margin:12px 0 4px}
input,textarea,select{width:100%;padding:12px 13px;border:1.5px solid var(--line);border-radius:12px;font:inherit;font-size:1rem;background:#fff}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
.btn{display:inline-block;width:100%;padding:14px 16px;border:0;border-radius:14px;background:var(--accent);color:#fff;font-weight:600;font-size:1rem;cursor:pointer;text-align:center;text-decoration:none;font-family:inherit}
.btn[disabled]{opacity:.55;cursor:default}
.btn.ghost{background:#fff;color:var(--ink);border:1.5px solid var(--line)}
.typegrid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;padding-top:12px}
.typecard{position:relative;background:#fff;border:1.5px solid var(--line);border-radius:18px;padding:0 0 12px;text-align:center;cursor:pointer;box-shadow:0 2px 10px rgba(20,24,31,.04);font-family:inherit;overflow:hidden;transition:border-color .12s}
.typecard:hover{border-color:var(--accent)}
.typecard img{display:block;width:100%;height:110px;object-fit:cover;background:#f0f0f2}
.typecard .tph{display:flex;align-items:center;justify-content:center;width:100%;height:110px;background:color-mix(in srgb,var(--accent) 9%,#fff);color:var(--accent);font-size:2rem;font-weight:700}
.typecard .tn{display:block;font-weight:600;font-size:.98rem;margin:10px 8px 2px}
.typecard .td{display:block;color:var(--muted);font-size:.78rem;margin:0 10px;line-height:1.35}
.pricebox{text-align:center;margin:14px 0 6px}
.pricebox .pr{font-size:2.1rem;font-weight:700;letter-spacing:-.5px}
.pricebox .pr .to{color:var(--muted);font-weight:400;font-size:1.4rem;padding:0 6px}
.pricebox .plabel{color:var(--muted);font-size:.82rem;text-transform:uppercase;letter-spacing:.8px;font-weight:600}
.daygrid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding-top:12px}
.daycard{position:relative;background:#fff;border:1.5px solid var(--line);border-radius:18px;padding:24px 6px 16px;text-align:center;cursor:pointer;box-shadow:0 2px 10px rgba(20,24,31,.04);font-family:inherit;transition:border-color .12s}
.daycard:hover{border-color:var(--accent)}
.daypill{position:absolute;top:-11px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;font-size:.6rem;font-weight:700;letter-spacing:.8px;border-radius:999px;padding:3px 11px;white-space:nowrap}
.dw{display:block;color:var(--muted);font-weight:600;letter-spacing:2.5px;font-size:.76rem;text-transform:uppercase}
.dn{display:block;font-size:2.25rem;font-weight:700;line-height:1.2;color:var(--ink)}
.dm{display:block;color:var(--muted);font-size:.92rem}
.dashedbtn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin-top:18px;padding:17px 14px;border:2px dashed #d8dade;border-radius:16px;background:#fbfbfc;font-weight:600;font-size:1rem;color:var(--ink);cursor:pointer;font-family:inherit}
.dashedbtn:hover{border-color:var(--accent)}
.slot{display:inline-block;padding:11px 15px;margin:5px 6px 5px 0;border:1.5px solid var(--line);border-radius:12px;background:#fff;font-weight:600;cursor:pointer;font-size:.94rem;font-family:inherit}
.slot:hover{border-color:var(--accent)}
.slot.sel{background:var(--accent);border-color:var(--accent);color:#fff}
.trust{display:flex;justify-content:center;align-items:center;gap:14px;background:#f7f7f8;border-top:1px solid var(--line);padding:16px 10px;color:var(--muted);font-size:.92rem;flex-wrap:wrap}
.trust .tchip{display:flex;align-items:center;gap:8px}
.trust .tico{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;border:1.5px solid var(--line);background:#fff;font-size:.85rem}
.trust .tsep{color:#d8dade}
.underline-note{text-align:center;color:var(--muted);font-size:.82rem;margin-top:14px}
.err{color:#b42318;font-size:.88rem;min-height:18px;margin-top:8px}
.ok-badge{font-size:2.2rem;text-align:center}
.sug{position:absolute;left:0;right:0;top:100%;z-index:50;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 24px rgba(15,20,32,.14);max-height:240px;overflow-y:auto;display:none;margin-top:2px}
.sug div{padding:9px 11px;cursor:pointer;font-size:.9rem;border-top:1px solid var(--line)}
.sug div:first-child{border-top:0}.sug div:hover{background:rgba(15,20,32,.05)}
.consent{display:flex;gap:9px;align-items:flex-start;margin-top:14px;font-size:.8rem;color:var(--muted)}
.consent input{width:auto;margin-top:2px}
.hpwrap{position:absolute;left:-9999px;top:-9999px;height:1px;overflow:hidden}
header.bk{display:flex;align-items:center;gap:12px;padding-top:18px}
header.bk img{height:44px}header.bk .bn{font-weight:700;font-size:1.05rem}
a{color:var(--accent)}
</style></head><body><div class="wrap">${(embed || bare) ? '' : `
<header class="bk">${brand.logo_url ? `<img src="${esc(brand.logo_url)}" alt="${esc(brand.business_name)}">` : ''}<div><div class="bn">${esc(brand.business_name)}</div>${brand.phone ? `<div class="muted">Questions? Call <a href="tel:${esc(brand.phone)}">${esc(brand.phone)}</a></div>` : ''}</div></header>`}
${inner}
</div>${embed ? `<script>
(function(){var last=0;function post(){var h=document.documentElement.scrollHeight;if(h!==last){last=h;parent.postMessage({pecBookingHeight:h},'*');}}
new MutationObserver(post).observe(document.documentElement,{subtree:true,childList:true,attributes:true});
window.addEventListener('load',post);setInterval(post,800);})();
</script>` : ''}</body></html>`;
}

function closedInner(brand) {
  return `<div class="bigcard"><div class="inner">
  ${brand.logo_url ? `<img class="bklogo" src="${esc(brand.logo_url)}" alt="${esc(brand.business_name || '')}">` : ''}
  <h1>Instant pricing is <span class="accentword">almost ready</span></h1>
<p class="qsub">We are putting the finishing touches on online pricing.${brand.phone ? ` In the meantime, call <a href="tel:${esc(brand.phone)}"><strong>${esc(brand.phone)}</strong></a> and we will price your project right away.` : ' Please call us and we will price your project right away.'}</p></div></div>
${brand.license_number ? `<div class="underline-note">Licensed, Bonded &amp; Insured &middot; ${esc(brand.license_number)}</div>` : ''}`;
}

// The pricing page: a 4-step client flow (type -> size+address -> contact ->
// price + booking continuation) that talks to /api/pricing/* and, for the
// continuation, the SAME /api/booking/* endpoints the /book page uses.
function pricingPageInner(cfg) {
  const { brand, settings, types, booking, mapsKey, preview } = cfg;
  const headline = cleanStr(settings.pricing_headline) || 'Get your instant price';
  const intro = cleanStr(settings.pricing_intro_text) || '';
  const hWords = headline.trim().split(/\s+/);
  const hLast = hWords.length > 1 ? hWords.pop() : '';
  const cfgJson = JSON.stringify({
    types: types.map(t => ({
      id: t.id, name: t.name, description: t.description || '',
      image_url: typeImageUrl(t.image_path), priceable: t.priceable !== false,
    })),
    minSqft: numSetting(settings, 'pricing_min_sqft', 50),
    maxSqft: numSetting(settings, 'pricing_max_sqft', 20000),
    bookingSlug: booking.slug,
    bookingQuestions: booking.questions,
    mapsKey: preview ? '' : (mapsKey || ''),
    preview: preview === true,
    disclosure: cleanStr(settings.booking_sms_disclosure) || '',
  }).replace(/</g, '\\u003c');
  return `
${preview ? '<div class="card" style="border-style:dashed;padding:10px 14px;margin-bottom:12px"><span class="muted" style="font-size:.78rem">Preview. Nothing here submits; save changes in Settings and this refreshes.</span></div>' : ''}
<div class="bigcard">
  <div class="inner">
  ${brand.logo_url ? `<img class="bklogo" src="${esc(brand.logo_url)}" alt="${esc(brand.business_name || '')}">` : ''}
  <h1 id="prHeadline">${esc(hWords.join(' '))}${hLast ? ` <span class="accentword">${esc(hLast)}</span>` : ''}</h1>
  <p class="qsub" id="prIntro"${intro ? '' : ' style="display:none"'}>${esc(intro)}</p>

<div id="stepType">
  <div class="q">What kind of project is it?</div>
  <div class="qsub">Pick the closest match</div>
  <div class="typegrid" id="prTypes"></div>
</div>

<div id="stepSize" style="display:none">
  <div class="q">How big is the area?</div>
  <div class="qsub" id="prSizeSub">A rough guess is fine. A standard 2-car garage is <strong>about 400 to 450 sqft</strong></div>
  <div id="prSqftWrap">
    <label for="prSqft">Approximate square feet</label>
    <input id="prSqft" inputmode="numeric" placeholder="e.g. 450">
  </div>
  <div style="position:relative">
    <label for="prAddr">Street address</label>
    <input id="prAddr" autocomplete="street-address" placeholder="123 N Example St" inputmode="text">
    <div class="sug" id="prSug"></div>
  </div>
  <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
    <div><label for="prCity">City</label><input id="prCity" autocomplete="address-level2"></div>
    <div><label for="prZip">Zip</label><input id="prZip" autocomplete="postal-code" inputmode="numeric" maxlength="10"></div>
  </div>
  <div class="err" id="prSizeErr"></div>
  <button class="btn" id="prSizeNext" style="margin-top:10px">Next</button>
  <button class="btn ghost" id="prSizeBack" style="margin-top:8px">&larr; Different project type</button>
</div>

<div id="stepContact" style="display:none">
  <div class="q">Where should we send your price?</div>
  <div class="qsub">Your ballpark shows right here, instantly</div>
  <label for="prName">Name</label><input id="prName" autocomplete="name">
  <label for="prPhone">Mobile phone</label><input id="prPhone" autocomplete="tel" inputmode="tel">
  <label for="prEmail">Email</label><input id="prEmail" autocomplete="email" inputmode="email">
  <div class="hpwrap" aria-hidden="true"><label>Website</label><input id="prWebsite" tabindex="-1" autocomplete="off"></div>
  <div class="consent"><span id="prConsentText"></span></div>
  <div class="err" id="prContactErr"></div>
  <button class="btn" id="prSeePrice" style="margin-top:10px">See my price</button>
</div>

<div id="stepPrice" style="display:none">
  <div class="q" id="prPriceTitle">Your ballpark price</div>
  <div class="pricebox" id="prPriceBox" style="display:none">
    <span class="plabel" id="prPriceType"></span>
    <div class="pr"><span id="prLow"></span><span class="to">to</span><span id="prHigh"></span></div>
  </div>
  <p class="qsub" id="prPriceCopy" style="margin-top:10px"></p>
  <div id="prBookArea" style="display:none">
    <div class="q" style="margin-top:18px">Want it exact? Book your <span class="accentword" style="color:var(--accent)">free on-site visit</span></div>
    <div class="qsub">We measure, check the concrete, and give you a firm price on the spot</div>
    <div id="prDays"></div>
    <div id="prTimes" style="display:none">
      <div class="q">What time works best?</div>
      <div class="qsub" id="prTimeDay"></div>
      <div id="prTimeBtns" style="text-align:center"></div>
      <button class="dashedbtn" id="prBackDays" style="margin-top:14px">&larr; Choose a different date</button>
    </div>
    <div class="err" id="prBookErr" style="text-align:center"></div>
  </div>
  <p class="qsub" id="prNoBook" style="display:none;margin-top:14px"></p>
</div>

<div id="stepConfirm" style="display:none">
  <div class="q">Confirm your visit</div>
  <div class="qsub" id="prChosen"></div>
  <div id="prQuestions"></div>
  <div class="err" id="prConfirmErr"></div>
  <button class="btn" id="prBookIt" style="margin-top:10px">Book it</button>
  <button class="btn ghost" id="prConfirmBack" style="margin-top:8px">&larr; Different time</button>
</div>

<div id="stepDone" style="display:none">
  <div class="ok-badge">&#10004;</div>
  <div class="q" id="prDoneTitle">You are booked!</div>
  <p id="prDoneMsg" style="text-align:center"></p>
  <p class="muted" id="prDoneManage" style="text-align:center"></p>
</div>

  </div>
  <div class="trust">
    <span class="tchip"><span class="tico">&#9201;</span>1 min</span>
    <span class="tsep">|</span>
    <span class="tchip"><span class="tico">&#128737;&#65039;</span>Secure</span>
    <span class="tsep">|</span>
    <span class="tchip"><span class="tico">&#10003;</span>Instant</span>
  </div>
</div>
${!preview && (brand.phone || brand.license_number) ? `<div class="underline-note">${brand.phone ? `Questions? Call <a href="tel:${esc(brand.phone)}"><strong>${esc(brand.phone)}</strong></a>` : ''}${brand.phone && brand.license_number ? ' &middot; ' : ''}${brand.license_number ? `Licensed, Bonded &amp; Insured &middot; ${esc(brand.license_number)}` : ''}</div>` : ''}

<script>window.__PR=${cfgJson};</script>
<script>
(function(){
'use strict';
var CFG=window.__PR, S={type:null, sqft:null, addr:null, contact:null, quote:null, start:null, days:[], showAllDays:false, dayLabel:'', slotLabel:'', t0:Date.now()};
var $=function(id){return document.getElementById(id)};
function show(id,on){$(id).style.display=on?'':'none'}
function apiP(path,body){return fetch('/api/pricing/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){j.__status=r.status;return j})})}
function apiB(path,body){return fetch('/api/booking/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){j.__status=r.status;return j})})}

if(CFG.disclosure){$('prConsentText').textContent=CFG.disclosure}

// ---- Step 1: project type cards ----
(function(){
  var grid=$('prTypes');
  CFG.types.forEach(function(t){
    var b=document.createElement('button');b.className='typecard';b.type='button';
    if(t.image_url){var im=document.createElement('img');im.src=t.image_url;im.alt=t.name;im.loading='lazy';b.appendChild(im)}
    else{var ph=document.createElement('span');ph.className='tph';ph.textContent=t.name.charAt(0);b.appendChild(ph)}
    var tn=document.createElement('span');tn.className='tn';tn.textContent=t.name;b.appendChild(tn);
    if(t.description){var td=document.createElement('span');td.className='td';td.textContent=t.description;b.appendChild(td)}
    b.addEventListener('click',function(){
      S.type=t;
      show('prSqftWrap',t.priceable);
      $('prSizeSub').style.display=t.priceable?'':'none';
      show('stepType',false);show('stepSize',true);
    });
    grid.appendChild(b);
  });
})();
$('prSizeBack').addEventListener('click',function(){show('stepSize',false);show('stepType',true)});

// ---- Places autocomplete (progressive: typing raw always works) ----
var sessionToken=null,sugSeq=0;
function loadMaps(){
  if(!CFG.mapsKey)return Promise.resolve(false);
  if(window.google&&window.google.maps&&window.google.maps.importLibrary)return Promise.resolve(true);
  if(window.__mapsP)return window.__mapsP;
  window.__mapsP=new Promise(function(res){
    window.__mapsReady=function(){res(true)};
    var s=document.createElement('script');
    s.src='https://maps.googleapis.com/maps/api/js?key='+encodeURIComponent(CFG.mapsKey)+'&v=weekly&loading=async&callback=__mapsReady';
    s.async=true;s.onerror=function(){res(false)};document.head.appendChild(s);
  });
  return window.__mapsP;
}
$('prAddr').addEventListener('input',function(){
  var q=this.value.trim(),mine=++sugSeq,box=$('prSug');
  if(q.length<4){box.style.display='none';return}
  loadMaps().then(function(ok){
    if(!ok)return;
    return window.google.maps.importLibrary('places').then(function(places){
      if(!sessionToken)sessionToken=new places.AutocompleteSessionToken();
      return places.AutocompleteSuggestion.fetchAutocompleteSuggestions({input:q,sessionToken:sessionToken,includedRegionCodes:['us']});
    }).then(function(r){
      if(mine!==sugSeq)return;
      var list=(r&&r.suggestions||[]).filter(function(s){return s.placePrediction});
      if(!list.length){box.style.display='none';return}
      box.innerHTML='';
      list.slice(0,5).forEach(function(s){
        var d=document.createElement('div');
        d.textContent=String(s.placePrediction.text||'');
        d.addEventListener('mousedown',function(e){
          e.preventDefault();
          var place=s.placePrediction.toPlace();
          place.fetchFields({fields:['addressComponents']}).then(function(){
            sessionToken=null;
            var comps=place.addressComponents||[];
            function get(t,sh){var c=comps.find(function(x){return (x.types||[]).indexOf(t)>=0});return c?String((sh?c.shortText:c.longText)||''):''}
            $('prAddr').value=[get('street_number'),get('route')].filter(Boolean).join(' ')||$('prAddr').value;
            $('prCity').value=get('locality')||get('sublocality')||$('prCity').value;
            $('prZip').value=get('postal_code')||$('prZip').value;
            $('prAddr').dataset.placeId=s.placePrediction.placeId||'';
            box.style.display='none';
          }).catch(function(){box.style.display='none'});
        });
        box.appendChild(d);
      });
      box.style.display='';
    });
  }).catch(function(){});
});
document.addEventListener('click',function(e){if(!$('prSug').contains(e.target))$('prSug').style.display='none'});

// ---- Step 2: size + address ----
$('prSizeNext').addEventListener('click',function(){
  $('prSizeErr').textContent='';
  var sqft=$('prSqft').value.replace(/[^0-9.]/g,'');
  var a={address1:$('prAddr').value.trim(),city:$('prCity').value.trim(),zip:$('prZip').value.trim(),place_id:$('prAddr').dataset.placeId||''};
  if(S.type.priceable){
    var n=Number(sqft);
    if(!sqft||!isFinite(n)||n<=0){$('prSizeErr').textContent='Enter the approximate square footage.';return}
    if(n<CFG.minSqft||n>CFG.maxSqft){$('prSizeErr').textContent='We price '+CFG.minSqft+' to '+CFG.maxSqft+' sqft online. For anything else, give us a call.';return}
    S.sqft=n;
  } else {S.sqft=Number(sqft)>0?Number(sqft):null}
  if(!a.address1||(!a.zip&&!a.city)){$('prSizeErr').textContent='Enter the street address, city, and zip.';return}
  S.addr=a;
  show('stepSize',false);show('stepContact',true);
});

// ---- Step 3: contact -> quote ----
$('prSeePrice').addEventListener('click',function(){
  $('prContactErr').textContent='';
  var c={name:$('prName').value.trim(),phone:$('prPhone').value.trim(),email:$('prEmail').value.trim()};
  if(!c.name||!c.phone||!c.email){$('prContactErr').textContent='Enter your name, mobile phone, and email.';return}
  var btn=$('prSeePrice');btn.disabled=true;btn.textContent='Calculating...';
  apiP('quote',{
    project_type_id:S.type.id,sqft:S.sqft,
    name:c.name,phone:c.phone,email:c.email,
    address1:S.addr.address1,city:S.addr.city,zip:S.addr.zip,place_id:S.addr.place_id,
    website:$('prWebsite').value,fill_ms:Date.now()-S.t0
  }).then(function(j){
    btn.disabled=false;btn.textContent='See my price';
    if(!j.ok){$('prContactErr').textContent=j.error||'Something went wrong.';return}
    S.contact=c;S.quote=j;
    renderPrice(j);
    show('stepContact',false);show('stepPrice',true);
  }).catch(function(){btn.disabled=false;btn.textContent='See my price';$('prContactErr').textContent='Could not reach us. Check your connection and try again.'});
});

function renderPrice(j){
  if(j.priceable&&j.price_low_label){
    $('prPriceTitle').textContent='Your ballpark price';
    $('prPriceType').textContent=S.type.name+(S.sqft?(' · '+S.sqft+' sqft'):'');
    $('prLow').textContent=j.price_low_label;$('prHigh').textContent=j.price_high_label;
    show('prPriceBox',true);
  } else {
    $('prPriceTitle').textContent='Let us price this one in person';
    show('prPriceBox',false);
  }
  $('prPriceCopy').textContent=j.copy||'';
  if(j.booking&&j.booking.open){
    show('prBookArea',true);
    loadSlots();
  } else {
    show('prNoBook',true);
    $('prNoBook').textContent=(j.in_area===false)?(j.out_of_area_copy||''):'We will reach out shortly to schedule your free on-site visit.';
  }
}

// ---- Booking continuation: the live /api/booking/* endpoints ----
function loadSlots(){
  $('prBookErr').textContent='';
  $('prDays').innerHTML='<p class="muted" style="text-align:center">Finding open times...</p>';
  apiB('slots',{form:CFG.bookingSlug,address1:S.addr.address1,city:S.addr.city,zip:S.addr.zip}).then(function(j){
    if(j.open===false||j.in_area===false||!j.ok){show('prBookArea',false);show('prNoBook',true);$('prNoBook').textContent='We will reach out shortly to schedule your free on-site visit.';return}
    S.days=j.days||[];
    if(!S.days.length){$('prDays').innerHTML='<p class="muted" style="text-align:center">No open times in the next few weeks. We will reach out to find you a spot.</p>';return}
    renderDays();
  }).catch(function(){$('prDays').innerHTML='';$('prBookErr').textContent='Could not load times. We will reach out to schedule.'});
}
function dayParts(iso){
  var dt=new Date(iso+'T12:00:00');
  return { w: dt.toLocaleDateString('en-US',{weekday:'short'}).toUpperCase(),
           n: String(dt.getDate()),
           m: dt.toLocaleDateString('en-US',{month:'short'}) };
}
function dayCard(d,i){
  var b=document.createElement('button');b.className='daycard';b.type='button';
  var p=dayParts(d.date);
  b.innerHTML='<span class="daypill">&#10022; INSTANT</span><span class="dw"></span><span class="dn"></span><span class="dm"></span>';
  b.querySelector('.dw').textContent=p.w;
  b.querySelector('.dn').textContent=p.n;
  b.querySelector('.dm').textContent=p.m;
  b.title=d.slots.length+' open time'+(d.slots.length===1?'':'s');
  b.addEventListener('click',function(){renderTimes(i)});
  return b;
}
function renderDays(){
  var el=$('prDays');el.innerHTML='';el.style.display='';$('prTimes').style.display='none';
  var list=S.showAllDays?S.days:S.days.slice(0,3);
  var grid=document.createElement('div');grid.className='daygrid';
  list.forEach(function(d){grid.appendChild(dayCard(d,S.days.indexOf(d)))});
  el.appendChild(grid);
  if(!S.showAllDays&&S.days.length>3){
    var more=document.createElement('button');more.className='dashedbtn';more.type='button';
    more.innerHTML='&#128197;&nbsp;&nbsp;Choose a different date&nbsp;&nbsp;&#8594;';
    more.addEventListener('click',function(){S.showAllDays=true;renderDays()});
    el.appendChild(more);
  }
}
function renderTimes(i){
  var d=S.days[i];$('prDays').style.display='none';$('prTimes').style.display='';
  $('prTimeDay').textContent=d.label;
  var el=$('prTimeBtns');el.innerHTML='';
  d.slots.forEach(function(s){
    var b=document.createElement('button');b.className='slot';b.type='button';b.textContent=s.label;
    b.addEventListener('click',function(){
      S.start=s.start;S.dayLabel=d.label;S.slotLabel=s.label;
      $('prChosen').textContent=d.label+' at '+s.label;
      show('stepPrice',false);show('stepConfirm',true);
      renderQuestions();
    });
    el.appendChild(b);
  });
}
$('prBackDays').addEventListener('click',function(){renderDays()});
$('prConfirmBack').addEventListener('click',function(){show('stepConfirm',false);show('stepPrice',true)});

// The booking form's own questions render here so /api/booking/book's
// required check can never 400. Funnel data prefills what it can (sqft, the
// project type); prefilled fields stay visible and editable.
function prefillFor(q){
  var id=String(q.id||'').toLowerCase(), label=String(q.label||'').toLowerCase();
  if(S.sqft&&(id.indexOf('sqft')>=0||label.indexOf('square')>=0))return String(S.sqft);
  if(id.indexOf('quote_type')>=0||id.indexOf('project_type')>=0){
    var opts=q.options||[];
    var hit=opts.find(function(o){return String(o).toLowerCase().indexOf(S.type.name.toLowerCase())>=0||S.type.name.toLowerCase().indexOf(String(o).toLowerCase())>=0});
    return hit||'';
  }
  if(id==='project'&&!S.type.priceable)return '';
  return '';
}
function renderQuestions(){
  var host=$('prQuestions');if(host.dataset.done)return;host.dataset.done='1';
  (CFG.bookingQuestions||[]).forEach(function(q){
    var pre=prefillFor(q);
    if(!q.required&&!pre)return;
    var lab=document.createElement('label');lab.textContent=q.label+(q.required?'':' (optional)');lab.htmlFor='pq_'+q.id;host.appendChild(lab);
    var input;
    if(q.type==='choice'){
      input=document.createElement('select');
      var o0=document.createElement('option');o0.value='';o0.textContent='Choose...';input.appendChild(o0);
      (q.options||[]).forEach(function(o){var op=document.createElement('option');op.value=o;op.textContent=o;input.appendChild(op)});
      if(pre)input.value=pre;
    } else if(q.type==='long_text'){input=document.createElement('textarea');input.rows=3;input.value=pre}
    else if(q.type==='yes_no'){
      input=document.createElement('select');
      ['','Yes','No'].forEach(function(o){var op=document.createElement('option');op.value=o;op.textContent=o||'Choose...';input.appendChild(op)});
    } else {input=document.createElement('input');input.value=pre}
    input.id='pq_'+q.id;host.appendChild(input);
    if(q.help){var h=document.createElement('div');h.className='muted';h.style.marginTop='3px';h.textContent=q.help;host.appendChild(h)}
  });
}

$('prBookIt').addEventListener('click',function(){
  var answers={};
  (CFG.bookingQuestions||[]).forEach(function(q){
    var el=$('pq_'+q.id);
    var v=el?el.value.trim():prefillFor(q);
    if(v)answers[q.id]=v;
  });
  $('prConfirmErr').textContent='';
  var btn=$('prBookIt');btn.disabled=true;btn.textContent='Booking...';
  apiB('book',{
    form:CFG.bookingSlug,start:S.start,
    name:S.contact.name,phone:S.contact.phone,email:S.contact.email,
    address1:S.addr.address1,city:S.addr.city,zip:S.addr.zip,place_id:S.addr.place_id,
    answers:answers,sms_consent:'true',
    website:$('prWebsite').value,fill_ms:Date.now()-S.t0
  }).then(function(j){
    btn.disabled=false;btn.textContent='Book it';
    if(j.taken){S.days=j.days||S.days;show('stepConfirm',false);show('stepPrice',true);renderDays();$('prBookErr').textContent=j.error||'That time was just taken. Pick another.';return}
    if(!j.ok){$('prConfirmErr').textContent=j.error||'Something went wrong.';return}
    show('stepConfirm',false);show('stepDone',true);
    if(j.duplicate){$('prDoneTitle').textContent='You are already booked'}
    $('prDoneMsg').textContent=(j.message||'')+(j.when?(' Your visit: '+j.when+'.'):'');
    if(j.manage_url){$('prDoneManage').innerHTML='Need to change it later? Use your private link: <a href="'+j.manage_url+'">reschedule or cancel</a>. We also include it in your confirmation.'}
    if(S.quote&&S.quote.request_id&&j.appointment_id){apiP('booked',{request_id:S.quote.request_id,appointment_id:j.appointment_id}).catch(function(){})}
  }).catch(function(){btn.disabled=false;btn.textContent='Book it';$('prConfirmErr').textContent='Could not reach us. Check your connection and try again.'});
});

// ---- Preview mode: every step stacked, every submit dead ----
if(CFG.preview){
  show('stepType',true);show('stepSize',true);show('stepContact',true);show('stepPrice',true);show('stepConfirm',true);show('stepDone',true);
  S.type=CFG.types[0]||{name:'Project',priceable:true};S.sqft=450;
  $('prPriceTitle').textContent='Your ballpark price';
  $('prPriceType').textContent=(S.type.name||'')+' · 450 sqft';
  $('prLow').textContent='$2,350';$('prHigh').textContent='$3,150';
  show('prPriceBox',true);
  $('prPriceCopy').textContent='Most projects like yours land between $2,350 and $3,150. (Sample numbers; the live page computes from your saved rates.)';
  show('prBookArea',true);
  $('prDays').innerHTML='<p class="muted" style="text-align:center">Open times render here from the real calendar.</p>';
  $('prChosen').textContent='Your chosen day and time show here.';
  ['prSizeNext','prSeePrice','prBookIt'].forEach(function(id){var b=$(id);if(b)b.disabled=true});
}
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Handler / routing
// ---------------------------------------------------------------------------

function pathOf(event) {
  try { if (event.rawUrl) return new URL(event.rawUrl).pathname; } catch (_) { /* fall through */ }
  return event.path || '/';
}

// The client-side maps key: the SAME domain-restricted browser key index.html
// commits by design (standing rule 7 exception); /pricing serves from that
// domain so the referrer restriction covers it.
const PEC_MAPS_KEY = 'AIzaSyBUqdRk4eIiEoc0vXK7XZz-4TiGdxnoGlY';

exports.handler = async (event) => {
  const path = pathOf(event);
  const deps = { sb, logIngest };

  if (path.startsWith('/api/pricing/')) {
    const action = (path.match(/\/api\/pricing\/([a-z-]+)/) || [])[1];
    if (action === 'config') {
      const out = await processConfig(deps);
      return json(out.status, out.body);
    }
    if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { ok: false, error: 'Invalid request' }); }
    const meta = { ipHash: ipHashFrom(event), userAgent: cleanStr(event.headers && event.headers['user-agent']) };

    let out;
    if (action === 'quote') out = await processQuote(deps, body, meta);
    else if (action === 'booked') out = await processBookedCallback(deps, body);
    else out = { status: 404, body: { ok: false, error: 'Unknown action' } };
    return json(out.status, out.body);
  }

  // HTML page.
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });
  const embed = !!(event.queryStringParameters && event.queryStringParameters.embed);
  const brand = await loadPricingBrand(sb);
  try {
    const settings = await getPricingSettings(sb);
    let types = [];
    try { types = await loadProjectTypes(sb, 'PEC'); } catch (_) { /* closed below */ }
    const open = String(settings.pricing_enabled || 'false') === 'true' && types.length > 0;
    // Preview: the Settings page's iframe renders the funnel even while
    // pricing is dark (that is exactly when it is being set up). Harmless
    // public: submits are disabled client-side and the quote write stays
    // gated server-side regardless.
    const preview = !!(event.queryStringParameters && event.queryStringParameters.preview) && types.length > 0;
    if (!open && !preview) {
      return htmlResponse(200, pageShell(brand, `Instant pricing from ${brand.business_name}`, closedInner(brand), { embed, bare: true }));
    }
    const booking = await loadBookingContext(sb, settings);
    const title = cleanStr(settings.pricing_headline) || `Instant pricing from ${brand.business_name}`;
    return htmlResponse(200, pageShell(brand, title,
      pricingPageInner({ brand, settings, types, booking, mapsKey: PEC_MAPS_KEY, preview }),
      { embed, bare: true }));
  } catch (err) {
    console.error('pec-pricing page failed:', err);
    return htmlResponse(200, pageShell(brand, `Instant pricing from ${brand.business_name}`, closedInner(brand), { embed }));
  }
};

// Exported for the fixture tests (production/pricing.test.cjs).
exports.processQuote = processQuote;
exports.processBookedCallback = processBookedCallback;
exports.processConfig = processConfig;
exports.captureLead = captureLead;
exports._internals = { getPricingSettings, loadProjectTypes, loadBookingContext, typeImageUrl };
