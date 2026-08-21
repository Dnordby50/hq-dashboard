// TopCoat online booking: the public page and the write path (prompt 101
// Parts D, E5, F). This is the FRONT Routemize used to own: a hosted form at
// /book (plus ?embed=1 for the website iframe), a real slot list from the
// availability engine, a zip/city service-area gate, the locked booking
// write, and the customer's self-serve manage link at /book/manage/<token>.
//
// Routes (netlify.toml):
//   GET  /book, /book/<slug>          the hosted booking page
//   GET  /book/manage/<token>         the customer's reschedule/cancel page
//   POST /api/booking/slots           open slots for an in-area address
//   POST /api/booking/book            THE only booking write
//   POST /api/booking/lead            out-of-area lead capture
//   POST /api/booking/manage          reschedule / cancel via manage token
//
// WRITE-PATH CONTRACT (D7): after the locked insert, this endpoint mirrors
// pec-appt-intake's processApptIntake exactly rather than reinventing it:
// resolveOrCreateCustomer + the shared same-human lead match (windowless,
// _pec-lead-match.cjs), a created lead is NEVER nurture-enrolled (the
// booking effects would pause it instantly) but DOES get the pec-lead-ai
// kick, title is the one auto-format '{Type label} for {Name}', answers
// route into customer_notes/notes by the form's per-question routing,
// apptBookingLeadEffects advances the stage, the bell is the service-role
// pec_notifications row, pushApptById lands the Google event, and the
// customer confirmation is kicked THE SAME WAY the intake kicks it: an
// awaited best-effort runApptReminders({ sb }, { appointmentId }) whose
// 15-minute scheduled runner is the safety net. Every attempt logs to
// pec_webhook_ingest_log with endpoint 'booking' so Sync Health shows these
// rows next to the Routemize ones.
//
// CONCURRENCY (D6): the insert happens inside the SECURITY DEFINER
// book_appointment_slot function, which takes pg_advisory_xact_lock on
// (rep, Phoenix date), re-checks overlap INCLUDING buffers under the lock,
// and returns {taken:true} for a lost race. The endpoint additionally
// re-runs computeSlots on fresh busy rows before calling it (rule B6: the
// engine and the re-check are the same function), so the RPC's conservative
// re-check is the last fence, not the first.
//
// ABUSE (Part F): offscreen honeypot field (bots fill it; the response fakes
// success so the bot learns nothing, the request row records the truth),
// minimum fill time, a per-ip_hash bookings-per-hour limit read from
// pec_booking_requests, and a duplicate guard (same phone + appt type inside
// the window returns the EXISTING appointment's manage link instead of
// double-booking). Rejections still write status='rejected' rows so a real
// customer being blocked is visible, never invisible. No CAPTCHA.
//
// FAIL-OPEN COPY, FAIL-CLOSED WRITES: any render/slots failure shows the
// call-us fallback with the brand phone; nothing customer-facing ever shows
// a stack trace. An EMPTY service area renders "online booking is almost
// ready" and never the out-of-area path (an unseeded allowlist must not
// classify the whole world as out of area).

'use strict';

const crypto = require('crypto');
const { sb, json, randomToken, logIngest, writeHeartbeat } = require('./_pec-supabase.cjs');
const { pushApptById } = require('./_pec-appt-push.cjs');
const {
  runApptReminders, apptBookingLeadEffects, apptCancelLeadEffects,
  resolveApptRecipient, scrubDashes, apptDateStr, apptTimeStr,
} = require('./_pec-appt.cjs');
const { sameHumanOr, normPhone, resolveOrCreateCustomer } = require('./_pec-lead-match.cjs');
const { resolveLeadSourceName } = require('./_pec-lead-source.cjs');
const { parseSmsConsent } = require('./pec-lead-intake.cjs');
const {
  quietHours, sendQuoSmsReal, sendResendEmailReal,
  getSmsSender, getEmailSender, dripEmailHtml, getBrandAccent,
} = require('./_pec-drip.cjs');
const { driveMinutesFor } = require('./_pec-booking-drive.cjs');
const { computeSlots, addrKey, HOME_KEY } = require('../../production/booking-availability.cjs');

const ENDPOINT = 'booking';
const SITE_URL = process.env.URL || 'https://prescottepoxy.netlify.app';
const PHX_TZ = 'America/Phoenix';
const TYPE_LABELS = {
  on_site_estimate: 'On-site estimate',
  project_walkthrough: 'Project walkthrough',
  site_visit: 'Site visit',
  other: 'Appointment',
};
const STOP_LINE = ' Reply STOP to opt out.';

const cleanStr = (s) => { const v = String(s == null ? '' : s).trim(); return v || null; };
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---------------------------------------------------------------------------
// Settings / form / service area loaders
// ---------------------------------------------------------------------------

const SETTING_KEYS = [
  'booking_enabled', 'booking_url', 'booking_working_hours',
  'booking_slot_granularity_minutes', 'booking_min_notice_minutes',
  'booking_horizon_days', 'booking_buffer_min_minutes',
  'booking_buffer_max_minutes', 'booking_buffer_default_minutes',
  'booking_drive_time_enabled', 'booking_routes_max_origins_per_request',
  'booking_routes_timeout_ms', 'booking_drive_cache_ttl_days',
  'booking_home_base_address', 'booking_rate_limit_per_hour',
  'booking_min_fill_seconds', 'booking_duplicate_window_hours',
  'booking_sms_disclosure', 'booking_manage_link_text',
];

async function getBookingSettings(db) {
  const out = {};
  try {
    const rows = await db('GET', `/settings?key=in.(${SETTING_KEYS.join(',')})&select=key,value`);
    for (const r of (Array.isArray(rows) ? rows : [])) out[r.key] = r.value;
  } catch (e) {
    console.warn('pec-booking: settings read failed, defaults apply:', e && e.message);
  }
  return out;
}

const numSetting = (s, key, dflt) => {
  const n = Number(s[key]);
  return isFinite(n) && s[key] != null && String(s[key]).trim() !== '' ? n : dflt;
};

function workingHoursFrom(s) {
  try {
    const parsed = JSON.parse(s.booking_working_hours || '');
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) { /* default below */ }
  return {
    mon: ['08:00', '17:00'], tue: ['08:00', '17:00'], wed: ['08:00', '17:00'],
    thu: ['08:00', '17:00'], fri: ['08:00', '17:00'], sat: null, sun: null,
  };
}

function engineConfig(s, durationMinutes, excludeApptId) {
  return {
    slotGranularityMinutes: numSetting(s, 'booking_slot_granularity_minutes', 30),
    durationMinutes: durationMinutes || 60,
    minNoticeMinutes: numSetting(s, 'booking_min_notice_minutes', 120),
    horizonDays: numSetting(s, 'booking_horizon_days', 30),
    bufferMinMinutes: numSetting(s, 'booking_buffer_min_minutes', 20),
    bufferMaxMinutes: numSetting(s, 'booking_buffer_max_minutes', 90),
    bufferDefaultMinutes: numSetting(s, 'booking_buffer_default_minutes', 30),
    excludeApptId: excludeApptId || null,
  };
}

async function loadForm(db, slug) {
  const rows = await db('GET', `/pec_booking_forms?slug=eq.${encodeURIComponent(slug || 'pec')}&select=*&limit=1`);
  return (Array.isArray(rows) && rows[0]) || null;
}

async function loadServiceArea(db, formId) {
  const rows = await db('GET', `/pec_booking_service_areas?form_id=eq.${encodeURIComponent(formId)}&active=eq.true&select=zip,city`);
  return Array.isArray(rows) ? rows : [];
}

// Zip match first, then case-insensitive city (locked decision 2 semantics).
function checkArea(area, zip, city) {
  const z5 = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (z5 && area.some(a => String(a.zip || '').trim() === z5)) return { inArea: true, matched: 'zip' };
  const c = String(city || '').trim().toLowerCase();
  if (c && area.some(a => String(a.city || '').trim().toLowerCase() === c)) return { inArea: true, matched: 'city' };
  return { inArea: false, matched: null };
}

async function loadActiveReps(db) {
  const rows = await db('GET', '/pec_sales_team_members?active=eq.true&select=id,name&order=name');
  return Array.isArray(rows) ? rows : [];
}

// Busy rows for the horizon, one bounded query. The engine does the precise
// filtering; this only needs to be a superset of what can block.
async function loadBusy(db, now, horizonDays) {
  const from = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const to = new Date(now.getTime() + (horizonDays + 2) * 24 * 3600 * 1000).toISOString();
  const rows = await db('GET',
    '/pec_appointments?status=eq.scheduled'
    + `&start_at=lt.${encodeURIComponent(to)}&end_at=gt.${encodeURIComponent(from)}`
    + '&select=id,sales_member_id,start_at,end_at,all_day,status,source,location_address,location_city,location_zip'
    + '&order=start_at.asc&limit=3000');
  return Array.isArray(rows) ? rows : [];
}

function formApptType(form) {
  const list = Array.isArray(form && form.appt_types) ? form.appt_types : [];
  const first = list[0] || {};
  return {
    key: first.key || 'on_site_estimate',
    label: first.label || TYPE_LABELS[first.key] || 'On-site estimate',
    duration: Number(first.duration_minutes) > 0 ? Number(first.duration_minutes) : 60,
  };
}

// The one slot computation both /slots and /book run (rule B6).
async function openSlotsFor(deps, { settings, form, customerAddr, excludeApptId, onlyRepId }) {
  const db = deps.sb;
  const now = deps.now ? deps.now() : new Date();
  const t = formApptType(form);
  const cfg = engineConfig(settings, t.duration, excludeApptId);
  let reps = await loadActiveReps(db);
  if (onlyRepId) reps = reps.filter(r => r.id === onlyRepId);
  const busy = await loadBusy(db, now, cfg.horizonDays);

  // Drive times: distinct neighbor addresses across the horizon + home base,
  // one batch call, cache-first (Part C).
  let driveTimes = {};
  const driveEnabled = String(settings.booking_drive_time_enabled || 'true') !== 'false';
  if (driveEnabled && customerAddr && customerAddr.address) {
    const originMap = new Map();
    for (const b of busy) {
      const key = addrKey(b.location_address, b.location_city, b.location_zip);
      if (key && !originMap.has(key)) {
        originMap.set(key, [b.location_address, b.location_city, b.location_zip].filter(Boolean).join(', '));
      }
    }
    const home = cleanStr(settings.booking_home_base_address);
    if (home) originMap.set(HOME_KEY, home);
    const origins = [...originMap.entries()].map(([key, address]) => ({ key, address }));
    driveTimes = await (deps.drive || driveMinutesFor)(db, origins, {
      key: addrKey(customerAddr.address, customerAddr.city, customerAddr.zip) || 'customer',
      address: [customerAddr.address, customerAddr.city, customerAddr.state, customerAddr.zip].filter(Boolean).join(', '),
    }, {
      enabled: true,
      maxOrigins: numSetting(settings, 'booking_routes_max_origins_per_request', 25),
      timeoutMs: numSetting(settings, 'booking_routes_timeout_ms', 4000),
      cacheTtlDays: numSetting(settings, 'booking_drive_cache_ttl_days', 30),
    });
  }

  const slots = computeSlots({
    now, reps, busy, workingHours: workingHoursFrom(settings), config: cfg, driveTimes,
  });
  return { slots, cfg, apptType: t, reps };
}

// Group engine slots by Phoenix day for the picker.
function groupSlotsByDay(slots) {
  const fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: PHX_TZ, weekday: 'long', month: 'long', day: 'numeric' });
  const fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: PHX_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: PHX_TZ, hour: 'numeric', minute: '2-digit' });
  const days = new Map();
  for (const s of slots) {
    const d = new Date(s.start);
    const key = fmtKey.format(d);
    if (!days.has(key)) days.set(key, { date: key, label: fmtDay.format(d), slots: [] });
    days.get(key).slots.push({ start: s.start, label: fmtTime.format(d) });
  }
  return [...days.values()];
}

// ---------------------------------------------------------------------------
// Contact resolution + question routing (the processApptIntake mirror)
// ---------------------------------------------------------------------------

async function resolveContact(db, phone10, email) {
  const out = { lead_id: null, customer_id: null };
  const or = sameHumanOr(phone10, email);
  if (!or) return out;
  const leads = await db('GET',
    `/leads?or=(${or})&deleted_at=is.null&select=id,customer_id,source&order=created_at.desc&limit=1`);
  if (Array.isArray(leads) && leads.length) {
    out.lead_id = leads[0].id;
    out.customer_id = leads[0].customer_id || null;
    out.lead_source = leads[0].source || null;
    return out;
  }
  const customers = await db('GET',
    `/customers?or=(${or})&archived_at=is.null&select=id&order=created_at.desc&limit=1`);
  if (Array.isArray(customers) && customers.length) out.customer_id = customers[0].id;
  return out;
}

// answers: { [questionId]: value }. Routes each answered question by the
// form's per-question routing (customer / internal / drop), exactly the
// three routemize_answer_routing values, and pulls the maps_to='lead_source'
// answer out for attribution. An internal-routed answer NEVER reaches
// customer_notes (the whole point of routing: customer_notes rides every
// confirmation and reminder on both channels).
function routeAnswers(questions, answers) {
  const out = { customer: [], internal: [], leadSourceAnswer: null, missingRequired: [] };
  const a = answers && typeof answers === 'object' ? answers : {};
  for (const q of (Array.isArray(questions) ? questions : [])) {
    if (!q || !q.id) continue;
    const raw = a[q.id];
    const val = cleanStr(Array.isArray(raw) ? raw.join(', ') : raw);
    if (q.required && !val) out.missingRequired.push(q.label || q.id);
    if (!val) continue;
    if (q.maps_to === 'lead_source') out.leadSourceAnswer = val;
    const route = ['customer', 'internal', 'drop'].includes(q.routing) ? q.routing : 'customer';
    if (route === 'drop') continue;
    const line = `${q.label || q.id}: ${val}`;
    if (route === 'internal') out.internal.push(line);
    else out.customer.push(line);
  }
  return out;
}

// Create the lead a direct booker never became (the createRoutemizeLead
// mirror, source 'booking'). Customer first so the lead is born linked
// (prompt 89); never nurture-enrolled; scored via the pec-lead-ai kick at
// the call site. Consent is explicit-only through parseSmsConsent, with the
// exact disclosure stored on the lead event AND the booking request row.
async function createBookingLead(db, f) {
  let customerId = null;
  try {
    const c = await resolveOrCreateCustomer(db, {
      name: f.name, firstName: f.firstName, lastName: f.lastName,
      phone10: f.phone10, email: f.email,
      address: f.address, city: f.city, state: f.state, zip: f.zip,
      source: f.source, brand: 'PEC',
    });
    customerId = c.customer_id;
  } catch (e) {
    console.warn('pec-booking: customer resolve failed (non-fatal):', e && e.message);
  }
  const consent = f.smsConsent === true;
  const rows = await db('POST', '/leads', {
    brand: 'PEC',
    customer_id: customerId,
    source: f.source,
    first_name: f.firstName,
    last_name: f.lastName,
    full_name: f.name,
    email: f.email,
    phone: f.phone10 || null,
    address: f.address, city: f.city, state: f.state, zip: f.zip,
    stage: 'new',
    sms_consent: consent,
    sms_consent_source: consent ? 'online booking form' : null,
    sms_consent_at: consent ? new Date().toISOString() : null,
  }, true);
  const lead = Array.isArray(rows) && rows[0];
  if (!lead) throw new Error('lead insert returned no row');
  await db('POST', '/lead_events', {
    lead_id: lead.id,
    event_type: 'created',
    to_stage: 'new',
    payload: {
      source: f.source, via: 'topcoat_booking',
      ...(consent && f.disclosure ? { sms_consent_disclosure: f.disclosure } : {}),
    },
  }).catch(e => console.warn('pec-booking: created lead_event failed (non-fatal):', e && e.message));
  return lead;
}

// Existing lead ticking the box for the first time: consent is an UPGRADE
// only (never revoked from a form; STOP owns revocation), recorded with the
// disclosure shown.
async function upgradeLeadConsent(db, leadId, disclosure) {
  try {
    const rows = await db('PATCH',
      `/leads?id=eq.${encodeURIComponent(leadId)}&sms_consent=eq.false&opted_out=eq.false`,
      {
        sms_consent: true,
        sms_consent_source: 'online booking form',
        sms_consent_at: new Date().toISOString(),
      }, true);
    if (Array.isArray(rows) && rows.length) {
      await db('POST', '/lead_events', {
        lead_id: leadId,
        event_type: 'note',
        payload: {
          text: 'SMS consent given on the online booking form.',
          via: 'topcoat_booking',
          ...(disclosure ? { sms_consent_disclosure: disclosure } : {}),
        },
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('pec-booking: consent upgrade failed (non-fatal):', e && e.message);
  }
}

const AI_TRIGGER_WAIT_MS = 2500;
async function kickLeadAi(leadId) {
  try {
    const req = fetch(`${SITE_URL}/.netlify/functions/pec-lead-ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': process.env.PEC_WEBHOOK_SECRET || '' },
      body: JSON.stringify({ lead_id: leadId }),
    }).then(
      (res) => { if (!res.ok) console.warn(`pec-booking: AI trigger returned ${res.status} for lead ${leadId}`); },
      (err) => { console.warn('pec-booking: AI trigger failed:', err && err.message); }
    );
    await Promise.race([req, new Promise(r => setTimeout(r, AI_TRIGGER_WAIT_MS))]);
  } catch (e) { console.warn('pec-booking: AI trigger threw:', e && e.message); }
}

// ---------------------------------------------------------------------------
// Abuse control (Part F)
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
    const rows = await db('POST', '/pec_booking_requests', row, true);
    return (Array.isArray(rows) && rows[0]) || null;
  } catch (e) {
    console.warn('pec-booking: request row write failed (non-fatal):', e && e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Manage-link confirmations (reschedule / cancel). The on-book confirmation
// rides the reminder engine's on_book rule; these two events are NOT rules
// (the ledger's uniqueness would eat repeats), so they send directly through
// the same consent gate + senders + logs the reminder engine uses.
// ---------------------------------------------------------------------------

async function sendManageConfirmation(deps, appt, kind) {
  const db = deps.sb;
  const senders = {
    sendSms: deps.sendSms || sendQuoSmsReal,
    sendEmail: deps.sendEmail || sendResendEmailReal,
  };
  try {
    const rcpt = await resolveApptRecipient(db, appt);
    if (!rcpt) return;
    const when = `${apptDateStr(appt.start_at)} at ${apptTimeStr(appt.start_at)}`;
    const bodyTxt = kind === 'canceled'
      ? `Hi ${rcpt.first || 'there'}, your ${String(appt.title || 'appointment').toLowerCase().startsWith('on-site') ? 'estimate visit' : 'appointment'} with Prescott Epoxy Company is canceled. If plans change, book a new time any time at ${SITE_URL}/book.`
      : `Hi ${rcpt.first || 'there'}, your appointment with Prescott Epoxy Company has moved to ${when}. ${manageLine(deps.settings, appt)}`.trim();
    const clean = scrubDashes(bodyTxt);
    const now = deps.now ? deps.now() : new Date();
    if (rcpt.phone && rcpt.smsOk && quietHours(now).inWindow) {
      const sender = await getSmsSender(db, {});
      if (sender && sender.from_number) {
        let out;
        try { out = await senders.sendSms({ from: sender.from_number, to: rcpt.phone, content: clean + STOP_LINE }); }
        catch (err) { out = { ok: false, id: null, error: String(err && err.message || err).slice(0, 300) }; }
        await db('POST', '/pec_sms_log', {
          direction: 'out', brand: 'prescott-epoxy',
          from_number: sender.from_number, to_number: rcpt.phone,
          customer_id: rcpt.customer_id, body: clean + STOP_LINE, kind: 'appointment',
          status: out.ok ? 'sent' : 'failed', quo_message_id: out.id, error_message: out.error,
        }).catch(() => {});
      }
    }
    if (rcpt.email && rcpt.emailOk) {
      const sender = await getEmailSender(db, {});
      if (sender && sender.from_email) {
        const subject = kind === 'canceled'
          ? 'Your appointment with Prescott Epoxy Company is canceled'
          : 'Your appointment with Prescott Epoxy Company has been rescheduled';
        const html = dripEmailHtml(clean, { accent: await getBrandAccent(db) });
        let out;
        try {
          out = await senders.sendEmail({
            from: `${sender.from_name} <${sender.from_email}>`, to: rcpt.email,
            subject, html, reply_to: sender.reply_to || undefined,
          });
        } catch (err) { out = { ok: false, id: null, error: String(err && err.message || err).slice(0, 300) }; }
        await db('POST', '/pec_email_log', {
          customer_id: rcpt.customer_id, brand: 'prescott-epoxy', template_key: 'appointment',
          to_email: rcpt.email, from_email: sender.from_email, subject,
          body_html: html, status: out.ok ? 'sent' : 'failed', resend_id: out.id, error_message: out.error,
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('pec-booking: manage confirmation failed (non-fatal):', e && e.message);
  }
}

function manageLine(settings, appt) {
  if (!appt.booking_manage_token) return '';
  const tpl = cleanStr(settings && settings.booking_manage_link_text)
    || 'Need to change it? Reschedule or cancel here: {link}';
  return tpl.replace('{link}', `${SITE_URL}/book/manage/${appt.booking_manage_token}`);
}

// ---------------------------------------------------------------------------
// The write path (POST /api/booking/book)
// ---------------------------------------------------------------------------

async function processBook(deps, body, meta = {}) {
  const db = deps.sb;
  const log = deps.logIngest || logIngest;
  const now = deps.now ? deps.now() : new Date();
  const bookSlot = deps.bookSlot || ((row, bb, ba, resched) =>
    db('POST', '/rpc/book_appointment_slot', {
      p_row: row, p_buffer_before_minutes: bb, p_buffer_after_minutes: ba, p_reschedule_id: resched || null,
    }));
  const kickPush = deps.kickPush || (async (id) => {
    try { await pushApptById(db, id); }
    catch (e) { console.warn('pec-booking: google push kick failed (non-fatal):', e && e.message || e); }
  });
  const runReminders = deps.runReminders || ((d, o) => runApptReminders(d, o));

  const settings = await getBookingSettings(db);
  deps.settings = settings;
  const form = await loadForm(db, cleanStr(body.form) || 'pec');
  const name = cleanStr(body.name);
  const phoneRaw = cleanStr(body.phone);
  const phone10 = normPhone(phoneRaw);
  const email = cleanStr(body.email) ? cleanStr(body.email).toLowerCase() : null;
  const addr = {
    address: cleanStr(body.address1), city: cleanStr(body.city),
    state: cleanStr(body.state) || 'AZ', zip: cleanStr(body.zip),
    placeId: cleanStr(body.place_id),
  };
  const start = cleanStr(body.start);
  const ipHash = meta.ipHash || null;
  const userAgent = meta.userAgent || null;
  const disclosure = cleanStr(settings.booking_sms_disclosure);
  const smsConsent = parseSmsConsent(body.sms_consent);

  const baseRow = {
    form_id: form ? form.id : null, name, phone: phone10 || phoneRaw, email,
    address_line1: addr.address, address_city: addr.city, address_state: addr.state, address_zip: addr.zip,
    place_id: addr.placeId,
    // Only a parseable instant reaches the timestamptz column; junk in the
    // field must not cost us the audit row.
    requested_start: (start && !isNaN(new Date(start))) ? new Date(start).toISOString() : null,
    answers: body.answers && typeof body.answers === 'object' ? body.answers : null,
    sms_consent: smsConsent, sms_consent_disclosure: smsConsent ? disclosure : null,
    ip_hash: ipHash, user_agent: userAgent,
    // Explicit so the row carries the REQUEST's clock (same value the column
    // default would write; the duplicate guard and rate limit read it).
    created_at: now.toISOString(),
  };

  try {
    if (!form || form.active === false || String(settings.booking_enabled || 'false') !== 'true') {
      return { status: 503, body: { ok: false, closed: true, error: 'Online booking is not open yet. Give us a call and we will get you scheduled.' } };
    }

    // -- Part F, cheap checks first ----------------------------------------
    if (cleanStr(body.website)) { // honeypot: real form never fills it
      await writeRequestRow(db, { ...baseRow, status: 'rejected', in_area: null, error_text: 'honeypot' });
      await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'rejected', status_code: 200, message: 'honeypot tripped (bot answered success)', payload: null });
      return { status: 200, body: { ok: true, message: 'Thanks! You are all set.' } }; // teach the bot nothing
    }
    const minFillMs = numSetting(settings, 'booking_min_fill_seconds', 2) * 1000;
    if (body.fill_ms != null && Number(body.fill_ms) >= 0 && Number(body.fill_ms) < minFillMs) {
      await writeRequestRow(db, { ...baseRow, status: 'rejected', in_area: null, error_text: 'too_fast' });
      await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'rejected', status_code: 400, message: `submitted in ${body.fill_ms}ms (< ${minFillMs}ms)`, payload: null });
      return { status: 400, body: { ok: false, error: 'That went through too fast to be right. Please review your details and try again.' } };
    }

    // -- Validation ---------------------------------------------------------
    const routed = routeAnswers(form.questions, body.answers);
    const missing = [];
    if (!name) missing.push('name');
    if (!phone10) missing.push('phone');
    if (!email) missing.push('email');
    if (!addr.address || !addr.city || !addr.zip) missing.push('address');
    if (!start || isNaN(new Date(start))) missing.push('time');
    missing.push(...routed.missingRequired);
    if (missing.length) {
      return { status: 400, body: { ok: false, error: `Please fill in: ${missing.join(', ')}.` } };
    }

    // -- Service area, server-side (never trust the client's verdict) -------
    const area = await loadServiceArea(db, form.id);
    if (!area.length) {
      return { status: 503, body: { ok: false, closed: true, error: 'Online booking is not open yet. Give us a call and we will get you scheduled.' } };
    }
    const verdict = checkArea(area, addr.zip, addr.city);
    if (!verdict.inArea) {
      return { status: 400, body: { ok: false, out_of_area: true, error: 'That address is outside our current service area.' } };
    }

    // -- Rate limit (per ip_hash, booked rows per hour) ----------------------
    const limit = numSetting(settings, 'booking_rate_limit_per_hour', 5);
    if (ipHash && limit > 0) {
      const hourAgo = new Date(now.getTime() - 3600 * 1000).toISOString();
      const recent = await db('GET',
        `/pec_booking_requests?ip_hash=eq.${encodeURIComponent(ipHash)}&status=eq.booked&created_at=gte.${encodeURIComponent(hourAgo)}&select=id&limit=${limit + 1}`);
      if (Array.isArray(recent) && recent.length >= limit) {
        await writeRequestRow(db, { ...baseRow, status: 'rejected', in_area: true, error_text: 'rate_limit' });
        await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'rejected', status_code: 429, message: `rate limit: ${recent.length} bookings this hour`, payload: null });
        return { status: 429, body: { ok: false, error: 'We have received several bookings from this connection. Please call us to schedule.' } };
      }
    }

    // -- Duplicate guard: same phone + type inside the window returns the
    //    existing appointment, never a second row -----------------------------
    const t = formApptType(form);
    const dupWindowH = numSetting(settings, 'booking_duplicate_window_hours', 24);
    if (phone10 && dupWindowH > 0) {
      const since = new Date(now.getTime() - dupWindowH * 3600 * 1000).toISOString();
      const dupReq = await db('GET',
        `/pec_booking_requests?phone=eq.${encodeURIComponent(phone10)}&status=eq.booked&created_at=gte.${encodeURIComponent(since)}&select=appointment_id&order=created_at.desc&limit=1`);
      const dupApptId = Array.isArray(dupReq) && dupReq[0] && dupReq[0].appointment_id;
      if (dupApptId) {
        const rows = await db('GET', `/pec_appointments?id=eq.${encodeURIComponent(dupApptId)}&status=eq.scheduled&appt_type=eq.${encodeURIComponent(t.key)}&select=id,start_at,booking_manage_token&limit=1`);
        const dup = Array.isArray(rows) && rows[0];
        if (dup) {
          await writeRequestRow(db, { ...baseRow, status: 'rejected', in_area: true, appointment_id: dup.id, error_text: 'duplicate' });
          await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'rejected', status_code: 200, message: `duplicate: returned existing appointment ${dup.id}`, payload: null });
          return {
            status: 200,
            body: {
              ok: true, duplicate: true,
              message: `You already have a visit booked for ${apptDateStr(dup.start_at)} at ${apptTimeStr(dup.start_at)}. Use your link to change it.`,
              manage_url: dup.booking_manage_token ? `${SITE_URL}/book/manage/${dup.booking_manage_token}` : null,
            },
          };
        }
      }
    }

    // -- Fresh availability re-check: the SAME engine, fresh busy (B6) ------
    const { slots } = await openSlotsFor(deps, { settings, form, customerAddr: addr });
    const startIso = new Date(start).toISOString();
    const slot = slots.find(s => s.start === startIso);
    if (!slot) {
      await writeRequestRow(db, { ...baseRow, status: 'rejected', in_area: true, error_text: 'slot_taken' });
      await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'rejected', status_code: 409, message: `slot no longer offered: ${startIso}`, payload: null });
      return { status: 409, body: { ok: false, taken: true, error: 'That time was just taken. Here are the next open times.', days: groupSlotsByDay(slots).slice(0, 10) } };
    }

    // -- Contact: the processApptIntake mirror ------------------------------
    const contact = await resolveContact(db, phone10, email);
    const sp = name.indexOf(' ');
    const firstName = sp < 0 ? name : name.slice(0, sp);
    const lastName = sp < 0 ? null : name.slice(sp + 1).trim() || null;
    const source = await resolveLeadSourceName(db, routed.leadSourceAnswer || 'topcoat_booking');
    let leadCreated = false;
    if (!contact.lead_id && !contact.customer_id) {
      try {
        const lead = await createBookingLead(db, {
          name, firstName, lastName, phone10, email,
          address: addr.address, city: addr.city, state: addr.state, zip: addr.zip,
          source, smsConsent, disclosure,
        });
        contact.lead_id = lead.id;
        contact.customer_id = lead.customer_id || null;
        leadCreated = true;
        await (deps.kickLeadAi || kickLeadAi)(lead.id);
      } catch (e) {
        console.warn('pec-booking: lead create failed (non-fatal):', e && e.message);
      }
    } else if (contact.lead_id) {
      if (!contact.lead_source) {
        await db('PATCH', `/leads?id=eq.${encodeURIComponent(contact.lead_id)}&source=is.null`, { source })
          .catch(e => console.warn('pec-booking: lead source fill failed (non-fatal):', e && e.message));
      }
      if (smsConsent) await upgradeLeadConsent(db, contact.lead_id, disclosure);
    }

    // -- The locked write ----------------------------------------------------
    const requestId = crypto.randomUUID();
    const manageToken = randomToken();
    const title = `${t.label} for ${name}`;
    const noteLines = [...routed.internal];
    const res = await bookSlot({
      appt_type: t.key,
      title,
      lead_id: contact.lead_id || '',
      customer_id: contact.customer_id || '',
      sales_member_id: slot.sales_member_id || '',
      start_at: slot.start,
      end_at: slot.end,
      location_address: addr.address, location_city: addr.city,
      location_state: addr.state, location_zip: addr.zip,
      location_place_id: addr.placeId || '',
      notes: noteLines.join('\n'),
      customer_notes: routed.customer.join('\n'),
      booking_manage_token: manageToken,
      booking_request_id: requestId,
    }, slot.buffer_before, slot.buffer_after, null);

    if (!res || res.ok !== true) {
      if (res && res.taken) {
        const fresh = await openSlotsFor(deps, { settings, form, customerAddr: addr });
        await writeRequestRow(db, { ...baseRow, id: requestId, status: 'rejected', in_area: true, lead_id: contact.lead_id, customer_id: contact.customer_id, error_text: 'slot_taken' });
        await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'rejected', status_code: 409, message: `lost the slot race for ${startIso}`, payload: null });
        return { status: 409, body: { ok: false, taken: true, error: 'That time was just taken. Here are the next open times.', days: groupSlotsByDay(fresh.slots).slice(0, 10) } };
      }
      throw new Error(`book_appointment_slot: ${res && res.error ? res.error : 'no result'}`);
    }
    const apptId = res.appointment_id;

    await writeRequestRow(db, {
      ...baseRow, id: requestId, status: 'booked', in_area: true,
      appointment_id: apptId, lead_id: contact.lead_id, customer_id: contact.customer_id,
    });

    // -- Post-insert effects, each best-effort (the intake contract) --------
    const appt = {
      id: apptId, lead_id: contact.lead_id, customer_id: contact.customer_id,
      appt_type: t.key, title, start_at: slot.start, end_at: slot.end,
      sales_member_id: slot.sales_member_id, source: 'booking',
      customer_notes: routed.customer.join('\n') || null,
      booking_manage_token: manageToken,
    };
    let effects = { staged: false, drip_stopped: 0 };
    if (appt.lead_id) {
      try { effects = await apptBookingLeadEffects(db, appt, { advanceStage: true, now: () => now }); }
      catch (e) { console.warn('pec-booking: lead effects failed (non-fatal):', e && e.message); }
    }
    if (appt.lead_id && !leadCreated) {
      await db('POST', '/lead_events', {
        lead_id: appt.lead_id,
        event_type: 'note',
        payload: {
          text: `Booked online: ${title}, ${apptDateStr(appt.start_at)} at ${apptTimeStr(appt.start_at)}`,
          via: 'topcoat_booking', appointment_id: apptId,
        },
      }).catch(e => console.warn('pec-booking: booking note event failed (non-fatal):', e && e.message));
    }
    try {
      await db('POST', '/pec_notifications', {
        type: 'appointment_booked',
        body: `Online booking: ${title} (${apptDateStr(appt.start_at)} at ${apptTimeStr(appt.start_at)})`,
        target_view: 'appointments',
        target_id: apptId,
      });
    } catch (e) { console.warn('pec-booking: bell failed (non-fatal):', e && e.message); }
    try { await runReminders({ sb: db }, { appointmentId: apptId }); }
    catch (e) { console.warn('pec-booking: confirmation kick failed (non-fatal):', e && e.message); }
    await kickPush(apptId);
    await log({ endpoint: ENDPOINT, deal_id: requestId, customer_name: name, outcome: 'ok', status_code: 200, message: `booked: appointment ${apptId}${appt.lead_id ? ` linked to lead ${appt.lead_id}` : ''}${leadCreated ? ' (lead created)' : ''}`, payload: null });
    try { await writeHeartbeat('pec-booking'); } catch (_) { /* observability only */ }

    return {
      status: 200,
      body: {
        ok: true,
        message: form.success_message || 'You are booked!',
        when: `${apptDateStr(appt.start_at)} at ${apptTimeStr(appt.start_at)}`,
        manage_url: `${SITE_URL}/book/manage/${manageToken}`,
        appointment_id: apptId,
        lead_effects: effects,
      },
    };
  } catch (err) {
    console.error('pec-booking book failed:', err);
    await writeRequestRow(db, { ...baseRow, status: 'error', error_text: String(err && err.message || err).slice(0, 500) });
    await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'error', status_code: 500, message: err && err.message, payload: null });
    return { status: 500, body: { ok: false, error: 'Something went wrong on our side. Please call us and we will get you scheduled.' } };
  }
}

// ---------------------------------------------------------------------------
// Out-of-area lead capture (POST /api/booking/lead, locked decision 6)
// ---------------------------------------------------------------------------

async function processOutOfAreaLead(deps, body, meta = {}) {
  const db = deps.sb;
  const log = deps.logIngest || logIngest;
  const settings = deps.settings || await getBookingSettings(db);
  const form = await loadForm(db, cleanStr(body.form) || 'pec');
  const name = cleanStr(body.name);
  const phone10 = normPhone(cleanStr(body.phone));
  const email = cleanStr(body.email) ? cleanStr(body.email).toLowerCase() : null;
  const addr = {
    address: cleanStr(body.address1), city: cleanStr(body.city),
    state: cleanStr(body.state) || 'AZ', zip: cleanStr(body.zip),
  };
  const project = cleanStr(body.project);
  const smsConsent = parseSmsConsent(body.sms_consent);
  const disclosure = cleanStr(settings.booking_sms_disclosure);

  try {
    if (cleanStr(body.website)) {
      await writeRequestRow(db, { form_id: form && form.id, status: 'rejected', name, phone: phone10, email, in_area: false, error_text: 'honeypot', ip_hash: meta.ipHash, user_agent: meta.userAgent });
      return { status: 200, body: { ok: true } };
    }
    if (!name || !phone10) {
      return { status: 400, body: { ok: false, error: 'Please give us your name and phone number so we can call you.' } };
    }
    const routed = routeAnswers(form ? form.questions : [], body.answers);
    const source = await resolveLeadSourceName(db, routed.leadSourceAnswer || 'topcoat_booking');
    const sp = name.indexOf(' ');

    const contact = await resolveContact(db, phone10, email);
    let leadId = contact.lead_id;
    if (!leadId) {
      const lead = await createBookingLead(db, {
        name, firstName: sp < 0 ? name : name.slice(0, sp),
        lastName: sp < 0 ? null : name.slice(sp + 1).trim() || null,
        phone10, email,
        address: addr.address, city: addr.city, state: addr.state, zip: addr.zip,
        source, smsConsent, disclosure,
      });
      leadId = lead.id;
      contact.customer_id = lead.customer_id || null;
      await (deps.kickLeadAi || kickLeadAi)(leadId);
    } else if (smsConsent) {
      await upgradeLeadConsent(db, leadId, disclosure);
    }
    const whereTxt = [addr.address, addr.city, addr.zip].filter(Boolean).join(', ');
    await db('POST', '/lead_events', {
      lead_id: leadId,
      event_type: 'note',
      payload: {
        text: `Tried to book online from OUTSIDE the service area: ${whereTxt || 'no address given'} (zip ${addr.zip || 'unknown'} not on the allowlist).${project ? ` Project: ${project}` : ''}`,
        via: 'topcoat_booking_out_of_area',
      },
    }).catch(() => {});
    const reqRow = await writeRequestRow(db, {
      form_id: form && form.id, status: 'out_of_area', name, phone: phone10, email,
      address_line1: addr.address, address_city: addr.city, address_state: addr.state, address_zip: addr.zip,
      in_area: false, lead_id: leadId, customer_id: contact.customer_id,
      answers: { ...(body.answers && typeof body.answers === 'object' ? body.answers : {}), project },
      sms_consent: smsConsent, sms_consent_disclosure: smsConsent ? disclosure : null,
      ip_hash: meta.ipHash, user_agent: meta.userAgent,
    });
    try {
      await db('POST', '/pec_notifications', {
        type: 'booking_out_of_area',
        body: `Out-of-area booking request from ${name}${addr.city ? ` in ${addr.city}` : ''}${addr.zip ? ` (${addr.zip})` : ''}. They were told we would call about scheduling.`,
        target_view: 'leads',
        target_id: leadId,
      });
    } catch (e) { console.warn('pec-booking: out-of-area bell failed (non-fatal):', e && e.message); }
    await log({ endpoint: ENDPOINT, deal_id: reqRow && reqRow.id, customer_name: name, outcome: 'ok', status_code: 200, message: `out_of_area lead ${leadId} (${addr.zip || addr.city || 'no address'})`, payload: null });
    return {
      status: 200,
      body: { ok: true, message: 'Thanks! That address is a little outside our usual area, but we take projects like this case by case. We will call you about scheduling.' },
    };
  } catch (err) {
    console.error('pec-booking out-of-area failed:', err);
    await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'error', status_code: 500, message: err && err.message, payload: null });
    return { status: 500, body: { ok: false, error: 'Something went wrong on our side. Please call us.' } };
  }
}

// ---------------------------------------------------------------------------
// Manage: load / reschedule / cancel (Part E5)
// ---------------------------------------------------------------------------

async function loadManageable(db, token, now) {
  if (!token || !/^[0-9a-f]{16,}$/i.test(token)) return { error: 'not_found' };
  const rows = await db('GET',
    `/pec_appointments?booking_manage_token=eq.${encodeURIComponent(token)}&select=*&limit=1`);
  const appt = Array.isArray(rows) && rows[0];
  if (!appt) return { error: 'not_found' };
  // The token stops working after the appointment ends: a stale confirmation
  // link must never move next month's calendar.
  if (new Date(appt.end_at) <= now && appt.status !== 'canceled') return { error: 'expired', appt };
  return { appt };
}

async function processManage(deps, body, meta = {}) {
  const db = deps.sb;
  const log = deps.logIngest || logIngest;
  const now = deps.now ? deps.now() : new Date();
  const settings = await getBookingSettings(db);
  deps.settings = settings;
  const kickPush = deps.kickPush || (async (id) => {
    try { await pushApptById(db, id); }
    catch (e) { console.warn('pec-booking: google push kick failed (non-fatal):', e && e.message || e); }
  });
  const action = cleanStr(body.action);
  const { appt, error } = await loadManageable(db, cleanStr(body.token), now);
  if (error === 'not_found') return { status: 404, body: { ok: false, error: 'This link is not valid.' } };
  if (error === 'expired') return { status: 410, body: { ok: false, error: 'This appointment has already happened, so this link no longer works. Book a new time any time.' } };

  try {
    if (action === 'cancel') {
      if (appt.status === 'canceled') return { status: 200, body: { ok: true, message: 'This appointment is already canceled.' } };
      await db('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(appt.id)}`, { status: 'canceled' });
      await kickPush(appt.id);
      await apptCancelLeadEffects(db, appt);
      if (appt.lead_id) {
        await db('POST', '/lead_events', {
          lead_id: appt.lead_id, event_type: 'note',
          payload: { text: `Canceled online: ${appt.title || 'appointment'} (${apptDateStr(appt.start_at)} at ${apptTimeStr(appt.start_at)})`, via: 'topcoat_booking_manage', appointment_id: appt.id },
        }).catch(() => {});
      }
      await db('POST', '/pec_notifications', {
        type: 'appointment_canceled',
        body: `Customer canceled online: ${appt.title || 'an appointment'} (was ${apptDateStr(appt.start_at)} at ${apptTimeStr(appt.start_at)})`,
        target_view: 'appointments', target_id: appt.id,
      }).catch(() => {});
      await sendManageConfirmation(deps, { ...appt, status: 'canceled' }, 'canceled');
      await log({ endpoint: ENDPOINT, deal_id: null, customer_name: appt.title, outcome: 'ok', status_code: 200, message: `manage: appointment ${appt.id} canceled by customer`, payload: null });
      return { status: 200, body: { ok: true, canceled: true, message: 'Your appointment is canceled. If plans change, you can book a new time any time.' } };
    }

    if (action === 'slots') {
      if (appt.status === 'canceled') return { status: 400, body: { ok: false, error: 'This appointment is canceled. Book a new time from the booking page.' } };
      const form = await loadForm(db, 'pec');
      const { slots } = await openSlotsFor(deps, {
        settings, form,
        customerAddr: { address: appt.location_address, city: appt.location_city, state: appt.location_state, zip: appt.location_zip },
        excludeApptId: appt.id,
        // Reschedule keeps the same rep: the locked update only moves times,
        // and swapping reps mid-manage would need a different write shape.
        onlyRepId: appt.sales_member_id || null,
      });
      return { status: 200, body: { ok: true, days: groupSlotsByDay(slots).slice(0, 14) } };
    }

    if (action === 'reschedule') {
      if (appt.status === 'canceled') return { status: 400, body: { ok: false, error: 'This appointment is canceled and cannot be moved. Book a new time from the booking page.' } };
      const start = cleanStr(body.start);
      if (!start || isNaN(new Date(start))) return { status: 400, body: { ok: false, error: 'Pick one of the offered times.' } };
      const form = await loadForm(db, 'pec');
      const { slots } = await openSlotsFor(deps, {
        settings, form,
        customerAddr: { address: appt.location_address, city: appt.location_city, state: appt.location_state, zip: appt.location_zip },
        excludeApptId: appt.id,
        onlyRepId: appt.sales_member_id || null,
      });
      const startIso = new Date(start).toISOString();
      const slot = slots.find(s => s.start === startIso);
      if (!slot) return { status: 409, body: { ok: false, taken: true, error: 'That time is no longer open. Here are the current options.', days: groupSlotsByDay(slots).slice(0, 14) } };

      const bookSlot = deps.bookSlot || ((row, bb, ba, resched) =>
        db('POST', '/rpc/book_appointment_slot', {
          p_row: row, p_buffer_before_minutes: bb, p_buffer_after_minutes: ba, p_reschedule_id: resched || null,
        }));
      const res = await bookSlot({
        sales_member_id: appt.sales_member_id || '',
        start_at: slot.start, end_at: slot.end,
      }, slot.buffer_before, slot.buffer_after, appt.id);
      if (!res || res.ok !== true) {
        if (res && res.taken) return { status: 409, body: { ok: false, taken: true, error: 'That time was just taken. Pick another.', days: groupSlotsByDay(slots).slice(0, 14) } };
        throw new Error(`book_appointment_slot reschedule: ${res && res.error ? res.error : 'no result'}`);
      }
      const fromTxt = `${apptDateStr(appt.start_at)}, ${apptTimeStr(appt.start_at)}`;
      const toTxt = `${apptDateStr(slot.start)}, ${apptTimeStr(slot.start)}`;
      if (appt.lead_id) {
        await db('POST', '/lead_events', {
          lead_id: appt.lead_id, event_type: 'note',
          payload: { text: `Rescheduled online: ${fromTxt} to ${toTxt}`, via: 'topcoat_booking_manage', appointment_id: appt.id },
        }).catch(() => {});
      }
      // The prompt-95 reschedule bell shape, so the Appointments bell reads
      // the same whatever moved the row.
      await db('POST', '/pec_notifications', {
        type: 'appointment_rescheduled',
        body: `Customer moved ${appt.title || 'an appointment'} to ${toTxt} (was ${fromTxt})`,
        target_view: 'appointments', target_id: appt.id,
      }).catch(() => {});
      await kickPush(appt.id);
      await sendManageConfirmation(deps, { ...appt, start_at: slot.start, end_at: slot.end }, 'rescheduled');
      await log({ endpoint: ENDPOINT, deal_id: null, customer_name: appt.title, outcome: 'ok', status_code: 200, message: `manage: appointment ${appt.id} rescheduled ${fromTxt} -> ${toTxt}`, payload: null });
      return { status: 200, body: { ok: true, message: `You are moved to ${toTxt}.`, when: toTxt } };
    }

    return { status: 400, body: { ok: false, error: 'Unknown action.' } };
  } catch (err) {
    console.error('pec-booking manage failed:', err);
    await log({ endpoint: ENDPOINT, deal_id: null, customer_name: appt && appt.title, outcome: 'error', status_code: 500, message: err && err.message, payload: null });
    return { status: 500, body: { ok: false, error: 'Something went wrong on our side. Please call us.' } };
  }
}

// ---------------------------------------------------------------------------
// Slots API (POST /api/booking/slots)
// ---------------------------------------------------------------------------

async function processSlots(deps, body) {
  const db = deps.sb;
  const settings = await getBookingSettings(db);
  deps.settings = settings;
  try {
    const form = await loadForm(db, cleanStr(body.form) || 'pec');
    if (!form || form.active === false || String(settings.booking_enabled || 'false') !== 'true') {
      return { status: 200, body: { ok: true, open: false } };
    }
    const area = await loadServiceArea(db, form.id);
    if (!area.length) return { status: 200, body: { ok: true, open: false } };
    const addr = {
      address: cleanStr(body.address1), city: cleanStr(body.city),
      state: cleanStr(body.state), zip: cleanStr(body.zip),
    };
    if (!addr.address || (!addr.zip && !addr.city)) {
      return { status: 400, body: { ok: false, error: 'Enter the project address first.' } };
    }
    const verdict = checkArea(area, addr.zip, addr.city);
    if (!verdict.inArea) return { status: 200, body: { ok: true, open: true, in_area: false } };
    const { slots } = await openSlotsFor(deps, { settings, form, customerAddr: addr });
    return { status: 200, body: { ok: true, open: true, in_area: true, days: groupSlotsByDay(slots) } };
  } catch (err) {
    console.error('pec-booking slots failed:', err);
    return { status: 500, body: { ok: false, error: 'Could not load open times. Please call us.' } };
  }
}

// ---------------------------------------------------------------------------
// HTML pages
// ---------------------------------------------------------------------------

async function loadBookingBrand(db) {
  const dflt = {
    business_name: 'Prescott Epoxy Company', logo_url: null,
    primary_color: '#14181C', accent_color: '#D8531C', phone: '', license_number: '',
  };
  try {
    const rows = await db('GET', '/pec_brand_identity?brand=eq.prescott-epoxy&select=business_name,logo_url,primary_color,accent_color,phone,license_number&limit=1');
    if (Array.isArray(rows) && rows[0]) {
      const b = { ...dflt, ...rows[0] };
      // Same fallback the estimate page uses: the identity row's logo_url is
      // null today, but the committed asset is the real panther logo.
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

// bare: true suppresses the default left-aligned header even on the hosted
// page; the booking page renders its own centered logo inside its card
// (the 2026-08-21 Routemize-style redesign Dylan asked for).
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
  <h1>Online booking is <span class="accentword">almost ready</span></h1>
<p class="qsub">We are putting the finishing touches on online scheduling.${brand.phone ? ` In the meantime, call <a href="tel:${esc(brand.phone)}"><strong>${esc(brand.phone)}</strong></a> and we will get you on the calendar right away.` : ' Please call us and we will get you on the calendar right away.'}</p></div></div>
${brand.license_number ? `<div class="underline-note">Licensed, Bonded &amp; Insured &middot; ${esc(brand.license_number)}</div>` : ''}`;
}

// The booking page: a 3-step client flow (address -> time -> details) that
// talks to /api/booking/*. Server renders the shell + config; the browser
// does the stepping. Mobile first: most of these arrive from a phone.
function bookingPageInner(form, mapsKey, opts = {}) {
  const t = formApptType(form);
  // Preview (prompt 102): the builder's live preview IS this page in an
  // iframe (?embed=1&preview=1), so preview and reality cannot drift: same
  // template, same client renderer. Preview renders even while booking is
  // dark, shows every step stacked, disables every submit, and re-renders
  // from postMessage drafts the builder sends on each edit.
  const preview = opts.preview === true;
  const cfgJson = JSON.stringify({
    slug: form.slug,
    questions: Array.isArray(form.questions) ? form.questions : [],
    typeLabel: t.label,
    duration: t.duration,
    mapsKey: preview ? '' : (mapsKey || ''),
    preview,
    successMessage: form.success_message || 'You are booked!',
  }).replace(/</g, '\\u003c');
  // Headline treatment (2026-08-21 redesign): the LAST word renders in the
  // accent color, the same trick the old Routemize page used. The client's
  // setHeadline() applies the identical split on preview updates.
  const headline = form.headline || 'Book your free on-site estimate';
  const hWords = headline.trim().split(/\s+/);
  const hLast = hWords.length > 1 ? hWords.pop() : '';
  const brand = opts.brand || {};
  return `
${preview ? '<div class="card" style="border-style:dashed;padding:10px 14px;margin-bottom:12px"><span class="muted" style="font-size:.78rem">Preview. Nothing here submits; edits in the builder appear live.</span></div>' : ''}
<div class="bigcard">
  <div class="inner">
  ${brand.logo_url ? `<img class="bklogo" src="${esc(brand.logo_url)}" alt="${esc(brand.business_name || '')}">` : ''}
  <h1 id="bkHeadline">${esc(hWords.join(' '))}${hLast ? ` <span class="accentword">${esc(hLast)}</span>` : ''}</h1>
  <p class="qsub" id="bkIntro"${form.intro_text ? '' : ' style="display:none"'}>${esc(form.intro_text || '')}</p>

<div id="stepAddr">
  <div class="q">Where is the project?</div>
  <div class="qsub">We'll find the best available times <strong>based on your area</strong></div>
  <div style="position:relative">
    <label for="bkAddr">Street address</label>
    <input id="bkAddr" autocomplete="street-address" placeholder="123 N Example St" inputmode="text">
    <div class="sug" id="bkSug"></div>
  </div>
  <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
    <div><label for="bkCity">City</label><input id="bkCity" autocomplete="address-level2"></div>
    <div><label for="bkZip">Zip</label><input id="bkZip" autocomplete="postal-code" inputmode="numeric" maxlength="10"></div>
  </div>
  <div class="err" id="bkAddrErr"></div>
  <button class="btn" id="bkAddrNext" style="margin-top:10px">See open times</button>
</div>

<div id="stepOut" style="display:none">
  <div class="q">We may still be able to help</div>
  <p class="qsub">That address is outside the area we book online. Leave your details and we will call you about scheduling, because we take projects like this case by case.</p>
  <label for="ooName">Name</label><input id="ooName" autocomplete="name">
  <label for="ooPhone">Phone</label><input id="ooPhone" autocomplete="tel" inputmode="tel">
  <label for="ooEmail">Email</label><input id="ooEmail" autocomplete="email" inputmode="email">
  <label for="ooProject">Tell us about the project</label><textarea id="ooProject" rows="3"></textarea>
  <div class="consent"><input type="checkbox" id="ooConsent"><span id="ooConsentText"></span></div>
  <div class="err" id="ooErr"></div>
  <button class="btn" id="ooSend" style="margin-top:10px">Request a call</button>
</div>

<div id="stepTime" style="display:none">
  <div class="q">What's your preferred day?</div>
  <div class="qsub">Visits take about ${t.duration} minutes. Times shown are <strong>Arizona time</strong></div>
  <div id="bkDays"></div>
  <div id="bkTimes" style="display:none">
    <div class="q">What time works best?</div>
    <div class="qsub" id="bkTimeDay"></div>
    <div id="bkTimeBtns" style="text-align:center"></div>
    <button class="dashedbtn" id="bkBackDays" style="margin-top:14px">&larr; Choose a different date</button>
  </div>
  <div class="err" id="bkTimeErr" style="text-align:center"></div>
</div>

<div id="stepDetails" style="display:none">
  <div class="q">Your details</div>
  <div class="qsub" id="bkChosen"></div>
  <label for="bkName">Name</label><input id="bkName" autocomplete="name">
  <label for="bkPhone">Mobile phone</label><input id="bkPhone" autocomplete="tel" inputmode="tel">
  <label for="bkEmail">Email</label><input id="bkEmail" autocomplete="email" inputmode="email">
  <div id="bkQuestions"></div>
  <div class="hpwrap" aria-hidden="true"><label>Website</label><input id="bkWebsite" tabindex="-1" autocomplete="off"></div>
  <div class="consent"><input type="checkbox" id="bkConsent"><span id="bkConsentText"></span></div>
  <div class="err" id="bkErr"></div>
  <button class="btn" id="bkBook" style="margin-top:10px">Book it</button>
</div>

<div id="stepDone" style="display:none">
  <div class="ok-badge">&#10004;</div>
  <div class="q" id="doneTitle">You are booked!</div>
  <p id="doneMsg" style="text-align:center"></p>
  <p class="muted" id="doneManage" style="text-align:center"></p>
</div>

  </div>
  <div class="trust">
    <span class="tchip"><span class="tico">&#9201;</span>2 min</span>
    <span class="tsep">|</span>
    <span class="tchip"><span class="tico">&#128737;&#65039;</span>Secure</span>
    <span class="tsep">|</span>
    <span class="tchip"><span class="tico">&#10003;</span>Instant</span>
  </div>
</div>
${!preview && (brand.phone || brand.license_number) ? `<div class="underline-note">${brand.phone ? `Questions? Call <a href="tel:${esc(brand.phone)}"><strong>${esc(brand.phone)}</strong></a>` : ''}${brand.phone && brand.license_number ? ' &middot; ' : ''}${brand.license_number ? `Licensed, Bonded &amp; Insured &middot; ${esc(brand.license_number)}` : ''}</div>` : ''}

<script>window.__BK=${cfgJson};</script>
<script>
(function(){
'use strict';
var CFG=window.__BK, S={addr:null, start:null, days:[], showAllDays:false, t0:Date.now()};
var $=function(id){return document.getElementById(id)};
function show(id,on){$(id).style.display=on?'':'none'}
// The step bar left with the 2026-08-21 redesign; kept as a guarded no-op so
// every existing call site stays harmless.
function step(n){['st1','st2','st3'].forEach(function(s,i){var el=$(s);if(el)el.className=i<n?'on':''})}
// Headline with the LAST word in the accent color (the server renders the
// same split; this keeps preview updates identical).
function setHeadline(t){
  var h=$('bkHeadline');if(!h)return;
  var words=String(t||'Book your free on-site estimate').trim().split(/\s+/);
  var last=words.length>1?words.pop():'';
  h.textContent=words.join(' ')+(last?' ':'');
  if(last){var sp=document.createElement('span');sp.className='accentword';sp.textContent=last;h.appendChild(sp)}
}
function api(path,body){return fetch('/api/booking/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){j.__status=r.status;return j})})}

// Disclosure text arrives with the slots payload settings; fallback fetched lazily.
fetch('/api/booking/config?form='+encodeURIComponent(CFG.slug)).then(function(r){return r.json()}).then(function(j){
  if(j&&j.disclosure){var t=document.createTextNode(j.disclosure);$('bkConsentText').appendChild(t.cloneNode());$('ooConsentText').appendChild(t)}
}).catch(function(){});

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
$('bkAddr').addEventListener('input',function(){
  var q=this.value.trim(),mine=++sugSeq,box=$('bkSug');
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
            $('bkAddr').value=[get('street_number'),get('route')].filter(Boolean).join(' ')||$('bkAddr').value;
            $('bkCity').value=get('locality')||get('sublocality')||$('bkCity').value;
            $('bkZip').value=get('postal_code')||$('bkZip').value;
            $('bkAddr').dataset.placeId=s.placePrediction.placeId||'';
            box.style.display='none';
          }).catch(function(){box.style.display='none'});
        });
        box.appendChild(d);
      });
      box.style.display='';
    });
  }).catch(function(){});
});
document.addEventListener('click',function(e){if(!$('bkSug').contains(e.target))$('bkSug').style.display='none'});

// ---- Step 1 -> slots ----
$('bkAddrNext').addEventListener('click',function(){
  var a={address1:$('bkAddr').value.trim(),city:$('bkCity').value.trim(),zip:$('bkZip').value.trim(),place_id:$('bkAddr').dataset.placeId||''};
  $('bkAddrErr').textContent='';
  if(!a.address1||(!a.zip&&!a.city)){$('bkAddrErr').textContent='Enter the street address, city, and zip.';return}
  var btn=$('bkAddrNext');btn.disabled=true;btn.textContent='Checking...';
  api('slots',{form:CFG.slug,address1:a.address1,city:a.city,zip:a.zip}).then(function(j){
    btn.disabled=false;btn.textContent='See open times';
    if(j.open===false){$('bkAddrErr').textContent='Online booking is not open right now. Please call us.';return}
    if(j.in_area===false){S.addr=a;show('stepAddr',false);show('stepOut',true);step(2);return}
    if(!j.ok){$('bkAddrErr').textContent=j.error||'Something went wrong.';return}
    S.addr=a;S.days=j.days||[];
    if(!S.days.length){$('bkAddrErr').textContent='No open times in the next few weeks. Please call us and we will find you a spot.';return}
    renderDays();show('stepAddr',false);show('stepTime',true);step(2);
  }).catch(function(){btn.disabled=false;btn.textContent='See open times';$('bkAddrErr').textContent='Could not reach us. Check your connection and try again.'});
});

// Day cards (2026-08-21 redesign): weekday / big date / month with an
// INSTANT pill, three up front, the rest behind the dashed
// choose-a-different-date button. d.date is the Phoenix YYYY-MM-DD the
// server grouped by; noon anchors the parse so no viewer timezone can shift
// the calendar day.
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
  var el=$('bkDays');el.innerHTML='';el.style.display='';$('bkTimes').style.display='none';
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
  var d=S.days[i];$('bkDays').style.display='none';$('bkTimes').style.display='';
  $('bkTimeDay').textContent=d.label;
  var el=$('bkTimeBtns');el.innerHTML='';
  d.slots.forEach(function(s){
    var b=document.createElement('button');b.className='slot';b.type='button';b.textContent=s.label;
    b.addEventListener('click',function(){
      S.start=s.start;
      $('bkChosen').textContent=d.label+' at '+s.label+' ('+CFG.typeLabel+', about '+CFG.duration+' minutes)';
      show('stepTime',false);show('stepDetails',true);step(3);
      renderQuestions();
    });
    el.appendChild(b);
  });
}
$('bkBackDays').addEventListener('click',function(){renderDays()});

function renderQuestions(){
  var host=$('bkQuestions');if(host.dataset.done)return;host.dataset.done='1';
  (CFG.questions||[]).forEach(function(q){
    var lab=document.createElement('label');lab.textContent=q.label+(q.required?'':' (optional)');lab.htmlFor='q_'+q.id;host.appendChild(lab);
    var input;
    if(q.type==='choice'){
      input=document.createElement('select');
      var o0=document.createElement('option');o0.value='';o0.textContent='Choose...';input.appendChild(o0);
      (q.options||[]).forEach(function(o){var op=document.createElement('option');op.value=o;op.textContent=o;input.appendChild(op)});
    } else if(q.type==='long_text'){input=document.createElement('textarea');input.rows=3}
    else if(q.type==='yes_no'){
      input=document.createElement('select');
      ['','Yes','No'].forEach(function(o){var op=document.createElement('option');op.value=o;op.textContent=o||'Choose...';input.appendChild(op)});
    } else {input=document.createElement('input')}
    input.id='q_'+q.id;host.appendChild(input);
    if(q.help){var h=document.createElement('div');h.className='muted';h.style.marginTop='3px';h.textContent=q.help;host.appendChild(h)}
  });
}

$('bkBook').addEventListener('click',function(){
  var answers={};(CFG.questions||[]).forEach(function(q){var el=$('q_'+q.id);if(el&&el.value.trim())answers[q.id]=el.value.trim()});
  $('bkErr').textContent='';
  var btn=$('bkBook');btn.disabled=true;btn.textContent='Booking...';
  api('book',{
    form:CFG.slug,start:S.start,
    name:$('bkName').value.trim(),phone:$('bkPhone').value.trim(),email:$('bkEmail').value.trim(),
    address1:S.addr.address1,city:S.addr.city,zip:S.addr.zip,place_id:S.addr.place_id,
    answers:answers,sms_consent:$('bkConsent').checked?'true':'',
    website:$('bkWebsite').value,fill_ms:Date.now()-S.t0
  }).then(function(j){
    btn.disabled=false;btn.textContent='Book it';
    if(j.taken){S.days=j.days||S.days;show('stepDetails',false);show('stepTime',true);renderDays();$('bkTimeErr').textContent=j.error||'That time was just taken. Pick another.';step(2);return}
    if(!j.ok){$('bkErr').textContent=j.error||'Something went wrong.';return}
    show('stepDetails',false);show('stepDone',true);
    if(j.duplicate){$('doneTitle').textContent='You are already booked'}
    $('doneMsg').textContent=(j.message||'')+(j.when?(' Your visit: '+j.when+'.'):'');
    if(j.manage_url){$('doneManage').innerHTML='Need to change it later? Use your private link: <a href="'+j.manage_url+'">reschedule or cancel</a>. We also include it in your confirmation.'}
  }).catch(function(){btn.disabled=false;btn.textContent='Book it';$('bkErr').textContent='Could not reach us. Check your connection and try again.'});
});

// ---- Out of area ----
$('ooSend').addEventListener('click',function(){
  $('ooErr').textContent='';
  var btn=$('ooSend');btn.disabled=true;btn.textContent='Sending...';
  api('lead',{
    form:CFG.slug,name:$('ooName').value.trim(),phone:$('ooPhone').value.trim(),email:$('ooEmail').value.trim(),
    address1:S.addr.address1,city:S.addr.city,zip:S.addr.zip,project:$('ooProject').value.trim(),
    sms_consent:$('ooConsent').checked?'true':'',website:$('bkWebsite')?$('bkWebsite').value:'',fill_ms:Date.now()-S.t0
  }).then(function(j){
    btn.disabled=false;btn.textContent='Request a call';
    if(!j.ok){$('ooErr').textContent=j.error||'Something went wrong.';return}
    show('stepOut',false);show('stepDone',true);step(3);
    $('doneTitle').textContent='Got it, we will call you';
    $('doneMsg').textContent=j.message||'';
  }).catch(function(){btn.disabled=false;btn.textContent='Request a call';$('ooErr').textContent='Could not reach us. Try again.'});
});

// ---- Preview mode (prompt 102): the Settings builder drives this page ----
// Every step renders at once, every submit is dead, and the builder's
// postMessage drafts re-render the SAME question renderer the live page
// uses, which is the whole point: preview equals reality by construction.
if(CFG.preview){
  show('stepAddr',true);show('stepOut',false);show('stepTime',true);show('stepDetails',true);show('stepDone',true);
  $('bkDays').innerHTML='<p class="muted">Open times render here from the real calendar once booking is live.</p>';
  $('bkChosen').textContent=CFG.typeLabel+', about '+CFG.duration+' minutes.';
  renderQuestions();
  $('doneMsg').textContent=CFG.successMessage||'';
  ['bkAddrNext','bkBook','ooSend'].forEach(function(id){var b=$(id);if(b)b.disabled=true});
  window.addEventListener('message',function(e){
    var d=e.data&&e.data.pecBookingPreview;if(!d)return;
    if(Array.isArray(d.questions)){CFG.questions=d.questions;var host=$('bkQuestions');host.innerHTML='';delete host.dataset.done;renderQuestions()}
    if(typeof d.headline==='string'){setHeadline(d.headline)}
    if(typeof d.intro==='string'){var ip=$('bkIntro');ip.textContent=d.intro;ip.style.display=d.intro?'':'none'}
    if(typeof d.success==='string'){$('doneMsg').textContent=d.success}
    if(typeof d.typeLabel==='string'||typeof d.duration==='number'){$('bkChosen').textContent=(d.typeLabel||CFG.typeLabel)+', about '+(d.duration||CFG.duration)+' minutes.'}
  });
}
})();
</script>`;
}

function managePageInner(appt, brand) {
  const canceled = appt.status === 'canceled';
  const when = `${apptDateStr(appt.start_at)} at ${apptTimeStr(appt.start_at)}`;
  const where = [appt.location_address, appt.location_city].filter(Boolean).join(', ');
  return `
<div class="card">
  <h1>Your appointment</h1>
  <p><strong>${esc(appt.title || 'Appointment')}</strong><br>
  ${esc(when)}${where ? `<br><span class="muted">${esc(where)}</span>` : ''}</p>
  ${canceled ? `<p class="err">This appointment is canceled.</p><a class="btn" href="/book">Book a new time</a>` : `
  <button class="btn" id="mgResched">Pick a new time</button>
  <button class="btn ghost" id="mgCancel" style="margin-top:8px">Cancel this appointment</button>`}
  <div class="err" id="mgErr"></div>
</div>
<div class="card" id="mgTimes" style="display:none">
  <h2>Open times</h2>
  <div id="mgDays"></div>
</div>
<div class="card" id="mgDone" style="display:none"><div class="ok-badge">&#10004;</div><p id="mgDoneMsg"></p></div>
${canceled ? '' : `<script>
(function(){
'use strict';
var TOKEN=${JSON.stringify(appt.booking_manage_token)};
var $=function(id){return document.getElementById(id)};
function api(body){return fetch('/api/booking/manage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({token:TOKEN},body))}).then(function(r){return r.json()})}
$('mgCancel').addEventListener('click',function(){
  if(!confirm('Cancel this appointment?'))return;
  $('mgErr').textContent='';this.disabled=true;
  api({action:'cancel'}).then(function(j){
    if(!j.ok){$('mgErr').textContent=j.error||'Could not cancel.';$('mgCancel').disabled=false;return}
    $('mgTimes').style.display='none';$('mgDone').style.display='';$('mgDoneMsg').textContent=j.message||'Canceled.';
    $('mgResched').style.display='none';$('mgCancel').style.display='none';
  }).catch(function(){$('mgErr').textContent='Could not reach us.';$('mgCancel').disabled=false});
});
$('mgResched').addEventListener('click',function(){
  $('mgErr').textContent='';var btn=this;btn.disabled=true;btn.textContent='Loading times...';
  api({action:'slots'}).then(function(j){
    btn.disabled=false;btn.textContent='Pick a new time';
    if(!j.ok){$('mgErr').textContent=j.error||'Could not load times.';return}
    renderDays(j.days||[]);
  }).catch(function(){btn.disabled=false;btn.textContent='Pick a new time';$('mgErr').textContent='Could not reach us.'});
});
function renderDays(days){
  var host=$('mgDays');host.innerHTML='';$('mgTimes').style.display='';
  if(!days.length){host.innerHTML='<p class="muted">No open times right now. Please call us.</p>';return}
  days.forEach(function(d){
    var h=document.createElement('div');h.className='muted';h.style.marginTop='10px';h.textContent=d.label;host.appendChild(h);
    d.slots.forEach(function(s){
      var b=document.createElement('button');b.className='slot';b.textContent=s.label;
      b.addEventListener('click',function(){
        if(!confirm('Move your appointment to '+d.label+' at '+s.label+'?'))return;
        api({action:'reschedule',start:s.start}).then(function(j){
          if(j.taken){renderDays(j.days||[]);$('mgErr').textContent=j.error||'Just taken, pick another.';return}
          if(!j.ok){$('mgErr').textContent=j.error||'Could not move it.';return}
          $('mgTimes').style.display='none';$('mgDone').style.display='';$('mgDoneMsg').textContent=j.message||'Moved.';
        }).catch(function(){$('mgErr').textContent='Could not reach us.'});
      });
      host.appendChild(b);
    });
  });
}
})();
</script>`}`;
}

// ---------------------------------------------------------------------------
// Handler / routing
// ---------------------------------------------------------------------------

function pathOf(event) {
  try { if (event.rawUrl) return new URL(event.rawUrl).pathname; } catch (_) { /* fall through */ }
  return event.path || '/';
}

// The client-side maps key: the SAME domain-restricted browser key index.html
// commits by design (standing rule 7 exception); /book serves from that
// domain so the referrer restriction covers it.
const PEC_MAPS_KEY = 'AIzaSyBUqdRk4eIiEoc0vXK7XZz-4TiGdxnoGlY';

exports.handler = async (event) => {
  const path = pathOf(event);
  const deps = { sb, logIngest };

  // JSON API actions.
  if (path.startsWith('/api/booking/') || /pec-booking/.test(path) && event.httpMethod === 'POST') {
    if (event.httpMethod !== 'POST' && !/config/.test(path)) return json(405, { ok: false, error: 'Method not allowed' });
    const action = (path.match(/\/api\/booking\/([a-z-]+)/) || [])[1]
      || cleanStr(event.queryStringParameters && event.queryStringParameters.api);

    if (action === 'config') {
      const settings = await getBookingSettings(sb);
      return json(200, { ok: true, disclosure: cleanStr(settings.booking_sms_disclosure) || '' });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { ok: false, error: 'Invalid request' }); }
    const meta = { ipHash: ipHashFrom(event), userAgent: cleanStr(event.headers && event.headers['user-agent']) };

    let out;
    if (action === 'slots') out = await processSlots(deps, body);
    else if (action === 'book') out = await processBook(deps, body, meta);
    else if (action === 'lead') out = await processOutOfAreaLead(deps, body, meta);
    else if (action === 'manage') out = await processManage(deps, body, meta);
    else out = { status: 404, body: { ok: false, error: 'Unknown action' } };
    return json(out.status, out.body);
  }

  // HTML pages.
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });
  const embed = !!(event.queryStringParameters && event.queryStringParameters.embed);
  const brand = await loadBookingBrand(sb);

  const manageMatch = path.match(/\/book\/manage\/([0-9a-fA-F]{16,})/);
  if (manageMatch) {
    const now = new Date();
    const { appt, error } = await loadManageable(sb, manageMatch[1], now);
    if (error === 'not_found') {
      return htmlResponse(404, pageShell(brand, 'Not found', '<div class="card"><h1>This link is not valid</h1><p class="muted">Check the link in your confirmation message, or call us.</p></div>'));
    }
    if (error === 'expired') {
      return htmlResponse(410, pageShell(brand, 'Link expired', `<div class="card"><h1>This appointment has already happened</h1><p class="muted">This link no longer works. Need anything else?${brand.phone ? ` Call <a href="tel:${esc(brand.phone)}">${esc(brand.phone)}</a> or ` : ' '}<a href="/book">book a new visit</a>.</p></div>`));
    }
    return htmlResponse(200, pageShell(brand, 'Manage your appointment', managePageInner(appt, brand)));
  }

  const slugMatch = path.match(/\/book\/?([a-z0-9-]*)/i);
  const slug = (slugMatch && cleanStr(slugMatch[1])) || 'pec';
  try {
    const settings = await getBookingSettings(sb);
    const form = await loadForm(sb, slug);
    const area = form ? await loadServiceArea(sb, form.id) : [];
    const open = form && form.active !== false
      && String(settings.booking_enabled || 'false') === 'true' && area.length > 0;
    // Preview (prompt 102): the Settings builder's iframe renders the form
    // even while booking is dark (that is exactly when the builder is being
    // set up). Harmless public: every submit is disabled client-side and the
    // write path stays gated server-side regardless.
    const preview = !!(event.queryStringParameters && event.queryStringParameters.preview) && !!form;
    if (!open && !preview) return htmlResponse(200, pageShell(brand, `Book with ${brand.business_name}`, closedInner(brand), { embed, bare: true }));
    return htmlResponse(200, pageShell(brand, form.headline || `Book with ${brand.business_name}`, bookingPageInner(form, PEC_MAPS_KEY, { preview, brand }), { embed, bare: true }));
  } catch (err) {
    console.error('pec-booking page failed:', err);
    return htmlResponse(200, pageShell(brand, `Book with ${brand.business_name}`, closedInner(brand), { embed }));
  }
};

// Exported for the fixture tests (production/booking.test.cjs).
exports.processBook = processBook;
exports.processSlots = processSlots;
exports.processOutOfAreaLead = processOutOfAreaLead;
exports.processManage = processManage;
exports.checkArea = checkArea;
exports.routeAnswers = routeAnswers;
exports.groupSlotsByDay = groupSlotsByDay;
exports.engineConfig = engineConfig;
