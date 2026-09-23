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
// the window returns a generic notice instead of double-booking or revealing
// private appointment details). Rejections still write status='rejected' rows so a real
// customer being blocked is visible, never invisible. No CAPTCHA.
//
// FAIL-OPEN COPY, FAIL-CLOSED WRITES: any render/slots failure shows the
// call-us fallback with the brand phone; nothing customer-facing ever shows
// a stack trace. An EMPTY service area renders "online booking is almost
// ready" and never the out-of-area path (an unseeded allowlist must not
// classify the whole world as out of area).

'use strict';
const { recordInquiry } = require('./_pec-sales-inquiry.cjs');

const crypto = require('crypto');
const { sb, withActor, json: rawJson, randomToken, logIngest, writeHeartbeat } = require('./_pec-supabase.cjs');
const { pushApptById } = require('./_pec-appt-push.cjs');
const {
  runApptReminders, apptBookingLeadEffects, apptCancelLeadEffects,
  resolveApptRecipient, scrubDashes, apptDateStr, apptTimeStr,
} = require('./_pec-appt.cjs');
const { sameHumanOr, normPhone, resolveOrCreateCustomer } = require('./_pec-lead-match.cjs');
const { resolveLeadSourceName } = require('./_pec-lead-source.cjs');
const {
  quietHours, sendQuoSmsReal, sendResendEmailReal,
  getSmsSender, getEmailSender, dripEmailHtml, getBrandAccent,
} = require('./_pec-drip.cjs');
const { driveMinutesFor, takeBookingRateLimit } = require('./_pec-booking-drive.cjs');
const { computeSlots, addrKey, HOME_KEY } = require('../../production/booking-availability.cjs');
const { repsWithVerifiedGoogleCalendars } = require('./_pec-booking-google-health.cjs');
// Prompt 105: THE eligibility rule (active + bookable_online + Google rule)
// and the primary-rep / assignment-mode resolution. Slots, the booking
// insert re-check, and the manage reschedule all go through it.
const { loadEligibleReps } = require('./_pec-booking-reps.cjs');

const ENDPOINT = 'booking';
const { bookingDiscovery } = require('../../production/booking-discovery.cjs');
const SITE_URL = process.env.URL || 'https://prescottepoxy.netlify.app';
const PHX_TZ = 'America/Phoenix';
const TYPE_LABELS = {
  on_site_estimate: 'On-site estimate',
  project_walkthrough: 'Project walkthrough',
  site_visit: 'Site visit',
  other: 'Appointment',
};
const STOP_LINE = ' Reply STOP to opt out.';
const DUPLICATE_BOOKING_MESSAGE = 'We already received a booking for this phone number. Check your original confirmation for the appointment details and private link, or call us for help. No new appointment was created.';
const CALENDAR_UNAVAILABLE_COPY = 'We cannot confirm open times right now. Please call us and we will get you scheduled.';
const calendarUnavailable = () => ({ status: 503, body: { ok: false, calendar_unavailable: true, error: CALENDAR_UNAVAILABLE_COPY, days: [] } });
const PUBLIC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // Keep Maps' referrer-restricted browser key working while excluding path
  // tokens from cross-origin referrers. Embedded forms remain permitted.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cache-Control': 'no-store',
};
const json = (status, body, headers = {}) => {
  const out = rawJson(status, body);
  out.headers = { ...out.headers, ...PUBLIC_HEADERS, ...headers };
  return out;
};

function validPublicBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const limits = { form: 80, name: 200, phone: 80, email: 254, address1: 512, city: 120,
    state: 80, zip: 32, place_id: 512, start: 80, token: 256, project: 4000, website: 1024, reason: 32 };
  for (const [key, max] of Object.entries(limits)) {
    if (body[key] == null) continue;
    if (typeof body[key] !== 'string' || body[key].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body[key])) return false;
  }
  return body.answers == null || (typeof body.answers === 'object' && !Array.isArray(body.answers));
}

const cleanStr = (s) => { const v = String(s == null ? '' : s).trim(); return v || null; };
function inquiryConflict(err) { return /several|choose the inquiry|request identifier conflicts/i.test(String(err && err.message)); }
function inquiryConflictResponse() { return { status: 409, body: { ok: false, inquiry_selection_required: true, error: 'We found more than one open quote request. If this is a separate new project, select that option below. For an existing project, please call us so we can link your visit correctly.' } }; }

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
  'booking_block_crew_holidays', 'google_booking_max_sync_age_minutes',
  'booking_slots_rate_limit_per_hour', 'booking_routes_rate_limit_per_day',
  // Prompt 105: rep eligibility + primary rep + assignment mode.
  'booking_primary_member_id', 'booking_assignment_mode', 'booking_require_google_connected',
];

// Copy for the "nobody is bookable online" state (locked decision 5: no
// slots, capture the lead, never fall back to every active rep).
const NO_REPS_COPY = 'Online scheduling is not open right now. Leave your details and we will call you to set up your visit.';

// Audit-trail actor labels (2026-09-21). The customer never has a staff
// session, so these ride the write (book_appointment_slot's p_actor, or the
// x-topcoat-actor header on a plain PATCH) and land in audit_log.admin_email.
const ACTOR_BOOK = 'Customer (online booking)';
const ACTOR_MANAGE = 'Customer via manage link';

// book_appointment_slot with the p_actor argument (2026-09-21 migration). If
// the migration has not landed yet PostgREST answers PGRST202 (no function
// matches these arguments), so fall back to the 4-argument call once: the
// booking must never fail because the audit label could not be attached.
function makeBookSlot(db) {
  return async (row, bb, ba, resched, actor) => {
    const base = { p_row: row, p_buffer_before_minutes: bb, p_buffer_after_minutes: ba, p_reschedule_id: resched || null };
    try {
      return await db('POST', '/rpc/book_appointment_slot', { ...base, p_actor: actor || ACTOR_BOOK });
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/PGRST202|Could not find the function|p_actor/i.test(msg)) {
        console.warn('pec-booking: book_appointment_slot has no p_actor yet (migration pending); retrying without it');
        return db('POST', '/rpc/book_appointment_slot', base);
      }
      throw e;
    }
  };
}

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

async function guardSlotRequest(deps, settings, meta = {}) {
  const limit = Math.min(1000000, Math.max(1, Math.floor(numSetting(settings, 'booking_slots_rate_limit_per_hour', 60))));
  const key = meta.ipHash || crypto.createHash('sha256').update('booking:unknown-connection').digest('hex');
  try {
    const result = await takeBookingRateLimit(deps.sb, 'booking_slots', key, limit, 3600);
    if (result.allowed) return null;
    return { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil(result.retry_after))) },
      body: { ok: false, error: 'We have received several requests from this connection. Please wait a little or call us to schedule.' } };
  } catch (_) {
    return { status: 503, body: { ok: false, error: 'Could not load open times. Please call us.' } };
  }
}

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

// Days off for the horizon (2026-09-21): company-wide or per-rep blocks from
// pec_appointment_blocked_days, plus crew holidays (pec_prod_holidays) while
// booking_block_crew_holidays is not 'false'. Phoenix dates in, engine rows
// out. Best-effort: a missing table (migration pending) or a read failure
// yields [] with a warning, never a failed slot list.
function phxDateOnly(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PHX_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
async function loadBlockedDays(db, settings, now, horizonDays) {
  const from = phxDateOnly(new Date(now.getTime() - 24 * 3600 * 1000));
  const to = phxDateOnly(new Date(now.getTime() + (horizonDays + 2) * 24 * 3600 * 1000));
  const out = [];
  try {
    const rows = await db('GET',
      `/pec_appointment_blocked_days?end_date=gte.${from}&start_date=lte.${to}`
      + '&select=id,start_date,end_date,sales_member_id&order=start_date.asc&limit=500');
    for (const r of (Array.isArray(rows) ? rows : [])) {
      out.push({ start_date: r.start_date, end_date: r.end_date, sales_member_id: r.sales_member_id || null });
    }
  } catch (e) {
    console.warn('pec-booking: blocked days read failed (none applied):', e && e.message);
  }
  if (String(settings.booking_block_crew_holidays || 'true') !== 'false') {
    try {
      const rows = await db('GET',
        `/pec_prod_holidays?holiday_date=gte.${from}&holiday_date=lte.${to}&select=holiday_date&limit=500`);
      for (const r of (Array.isArray(rows) ? rows : [])) {
        if (r && r.holiday_date) out.push({ start_date: r.holiday_date, end_date: r.holiday_date, sales_member_id: null });
      }
    } catch (e) {
      console.warn('pec-booking: holidays read failed (none applied):', e && e.message);
    }
  }
  return out;
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

// The one slot computation both /slots and /book run (rule B6). Rep order of
// filters: eligibility (prompt 105: active + bookable_online + Google rule,
// via the shared helper) -> the caller's single-rep restriction (manage
// reschedule keeps its rep) -> Google calendar health. An empty list after
// eligibility is `noEligibleReps` (fail closed, capture the lead); an empty
// list only after the health pass is `calendarUnavailable` (call us).
async function openSlotsFor(deps, { settings, form, customerAddr, excludeApptId, onlyRepId }) {
  const db = deps.sb;
  const now = deps.now ? deps.now() : new Date();
  const t = formApptType(form);
  const eligibility = await loadEligibleReps(db, settings);
  const cfg = engineConfig(settings, t.duration, excludeApptId);
  cfg.assignmentMode = eligibility.mode;
  cfg.primaryRepId = eligibility.primaryId;
  let reps = eligibility.reps;
  if (onlyRepId) reps = reps.filter(r => r.id === onlyRepId);
  if (!reps.length) return { slots: [], cfg, apptType: t, reps, calendarUnavailable: false, noEligibleReps: true, eligibility };
  const health = await repsWithVerifiedGoogleCalendars(db, reps, settings, now);
  reps = health.reps;
  const calendarUnavailable = !reps.length && health.unavailableCount > 0;
  if (calendarUnavailable) return { slots: [], cfg, apptType: t, reps, calendarUnavailable, eligibility };
  const busy = await loadBusy(db, now, cfg.horizonDays);
  const blockedDays = await loadBlockedDays(db, settings, now, cfg.horizonDays);

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
      rateLimitPerDay: numSetting(settings, 'booking_routes_rate_limit_per_day', 200),
    });
  }

  const slots = computeSlots({
    now, reps, busy, workingHours: workingHoursFrom(settings), config: cfg, driveTimes, blockedDays,
  });
  return { slots, cfg, apptType: t, reps, calendarUnavailable, eligibility };
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
  const customers = await db('GET', `/customers?or=(${or})&company=eq.prescott-epoxy&archived_at=is.null&select=id&limit=2`);
  if (customers.length > 1) throw new Error('Several customer identities match; office review is required');
  if (customers[0]) out.customer_id = customers[0].id;
  // Matching a person is not matching a request. The inquiry RPC decides
  // whether one active request can be followed, or selection is necessary.
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
// the call site. Consent is implied by the inquiry (policy 2026-08-21), with the
// exact disclosure stored on the lead event AND the booking request row.
async function createBookingLead(db, f) {
  const c = await resolveOrCreateCustomer(db, {
    name: f.name, firstName: f.firstName, lastName: f.lastName,
    phone10: f.phone10, email: f.email,
    address: f.address, city: f.city, state: f.state, zip: f.zip,
    source: f.source, brand: 'PEC',
  });
  const customerId = c.customer_id;
  if (!customerId) throw new Error('Customer creation returned no linked record');
  // Policy 2026-08-21 (Dylan): booking IS consent; the disclosure the page
  // showed is stored as the record. STOP opts out.
  const inquiryId = await recordInquiry(db, { customerId, key: f.requestKey, mode: f.mode || 'auto' });
  // The RPC owns creation and the original profile/date. A replay may return
  // a progressed or opted-out inquiry, so never reset its stage or consent.
  await db('PATCH', `/leads?id=eq.${encodeURIComponent(inquiryId)}&source=is.null`, { source: f.source });
  await upgradeLeadConsent(db, inquiryId, f.disclosure);
  return { id: inquiryId, customer_id: customerId };
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
  const bookSlot = deps.bookSlot || makeBookSlot(db);
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
  // Policy 2026-08-21 (Dylan): submitting a booking or callback request IS
  // consent to be texted; the page shows the disclosure as a notice instead
  // of a checkbox and STOP opts out. parseSmsConsent no longer gates.
  const smsConsent = true;

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
    if (!phone10 || phone10.length !== 10) missing.push('phone');
    if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) missing.push('email');
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

    // Count all valid attempts before contact/duplicate lookup as well as
    // availability work. The prior booked-row limit alone cannot bound
    // repeated rejected submissions or duplicate probes.
    const slotLimit = await guardSlotRequest(deps, settings, meta);
    if (slotLimit) return slotLimit;

    // -- Duplicate guard: a phone match prevents another row, but does not
    //    prove ownership of the original appointment or its private link. ----
    const t = formApptType(form);
    const dupWindowH = numSetting(settings, 'booking_duplicate_window_hours', 24);
    // A person can request separate work inside the abuse-control window.
    // Only their explicit new-project choice bypasses person-level folding;
    // replaying that same request still follows its saved inquiry.
    let newRequestReplay = false;
    if (body.inquiry_mode === 'new' && /^[a-zA-Z0-9_-]{16,100}$/.test(String(body.request_key || ''))) {
      const sameRequest = await db('GET', `/leads?intake_request_key=eq.${encodeURIComponent('booking:' + body.request_key)}&brand=eq.PEC&deleted_at=is.null&select=id&limit=1`);
      newRequestReplay = !!sameRequest[0];
    }
    if (phone10 && dupWindowH > 0 && (body.inquiry_mode !== 'new' || newRequestReplay)) {
      const since = new Date(now.getTime() - dupWindowH * 3600 * 1000).toISOString();
      const dupReq = await db('GET',
        `/pec_booking_requests?phone=eq.${encodeURIComponent(phone10)}&status=eq.booked&created_at=gte.${encodeURIComponent(since)}&select=appointment_id&order=created_at.desc&limit=1`);
      const dupApptId = Array.isArray(dupReq) && dupReq[0] && dupReq[0].appointment_id;
      if (dupApptId) {
        const rows = await db('GET', `/pec_appointments?id=eq.${encodeURIComponent(dupApptId)}&status=eq.scheduled&appt_type=eq.${encodeURIComponent(t.key)}&select=id&limit=1`);
        const dup = Array.isArray(rows) && rows[0];
        if (dup) {
          await writeRequestRow(db, { ...baseRow, status: 'rejected', in_area: true, appointment_id: dup.id, error_text: 'duplicate' });
          await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'rejected', status_code: 200, message: `duplicate: prevented another booking for appointment ${dup.id}`, payload: null });
          return {
            status: 200,
            body: {
              ok: true, duplicate: true,
              message: DUPLICATE_BOOKING_MESSAGE,
            },
          };
        }
      }
    }

    // -- Fresh availability re-check: the SAME engine, fresh busy (B6) ------
    const availability = await openSlotsFor(deps, { settings, form, customerAddr: addr });
    const { slots } = availability;
    if (availability.noEligibleReps) {
      // Nobody is bookable online (prompt 105). The page switches to the
      // leave-your-details step and posts /lead with reason no_reps.
      await writeRequestRow(db, { ...baseRow, status: 'rejected', in_area: true, error_text: 'no_bookable_reps' });
      await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'rejected', status_code: 409, message: 'no rep is bookable online; lead capture offered', payload: null });
      return { status: 409, body: { ok: false, no_reps: true, error: NO_REPS_COPY } };
    }
    if (availability.calendarUnavailable) {
      await writeRequestRow(db, { ...baseRow, status: 'rejected', in_area: true, error_text: 'calendar_unavailable' });
      await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'rejected', status_code: 503, message: 'Calendar availability could not be verified', payload: null });
      return calendarUnavailable();
    }
    const startIso = new Date(start).toISOString();
    const slot = slots.find(s => s.start === startIso);
    if (!slot) {
      await writeRequestRow(db, { ...baseRow, status: 'rejected', in_area: true, error_text: 'slot_taken' });
      await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'rejected', status_code: 409, message: `slot no longer offered: ${startIso}`, payload: null });
      return { status: 409, body: { ok: false, taken: true, error: 'That time was just taken. Here are the next open times.', days: groupSlotsByDay(slots).slice(0, 10) } };
    }

    // -- Contact: the processApptIntake mirror ------------------------------
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(String(body.request_key || ''))) return { status: 400, body: { ok: false, error: 'Please refresh the booking form before submitting.' } };
    const contact = await resolveContact(db, phone10, email);
    const sp = name.indexOf(' ');
    const firstName = sp < 0 ? name : name.slice(0, sp);
    const lastName = sp < 0 ? null : name.slice(sp + 1).trim() || null;
    const source = await resolveLeadSourceName(db, routed.leadSourceAnswer || 'topcoat_booking');
    let leadCreated = false;
    if (!contact.lead_id && contact.customer_id) {
      let pricingLeadId = null;
      if (/^[a-zA-Z0-9_-]{16,100}$/.test(String(body.pricing_request_key || ''))) {
        const pricing = await db('GET', `/leads?intake_request_key=eq.${encodeURIComponent('pricing:' + body.pricing_request_key)}&customer_id=eq.${encodeURIComponent(contact.customer_id)}&brand=eq.PEC&deleted_at=is.null&select=id&limit=1`);
        pricingLeadId = pricing[0] && pricing[0].id;
      }
      const leadId = await recordInquiry(db, { customerId: contact.customer_id, key: 'booking:' + body.request_key,
        leadId: pricingLeadId || null, mode: body.inquiry_mode === 'new' ? 'new' : 'auto' });
      if (typeof leadId !== 'string' || !leadId) throw new Error('Could not link the customer inquiry to the sales pipeline');
      contact.lead_id = leadId;
    }
    if (!contact.lead_id && !contact.customer_id) {
      try {
        const lead = await createBookingLead(db, {
          name, firstName, lastName, phone10, email,
          address: addr.address, city: addr.city, state: addr.state, zip: addr.zip,
          source, smsConsent, disclosure, requestKey: 'booking:' + body.request_key, mode: body.inquiry_mode === 'new' ? 'new' : 'auto',
        });
        contact.lead_id = lead.id;
        contact.customer_id = lead.customer_id || null;
        leadCreated = true;
        await (deps.kickLeadAi || kickLeadAi)(lead.id).catch(e => console.warn('pec-booking: lead scoring skipped:', e && e.message));
      } catch (e) {
        throw new Error('Could not save the customer inquiry: ' + (e && e.message || 'pipeline unavailable'));
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
      // Why this rep (prompt 105): lands in pec_appointment_assignment_log
      // through the function's transaction GUC. Mode is the EFFECTIVE one
      // (a missing primary degrades to round_robin and says so here).
      assignment_reason: `online_booking:${availability.eligibility.mode}`,
    }, slot.buffer_before, slot.buffer_after, null, ACTOR_BOOK);

    if (!res || res.ok !== true) {
      if (res && (res.taken || res.calendar_unavailable)) {
        const fresh = await openSlotsFor(deps, { settings, form, customerAddr: addr });
        if (fresh.noEligibleReps) {
          // The rep was switched off between the slot read and the write.
          await writeRequestRow(db, { ...baseRow, id: requestId, status: 'rejected', in_area: true, lead_id: contact.lead_id, customer_id: contact.customer_id, error_text: 'no_bookable_reps' });
          await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'rejected', status_code: 409, message: `rep no longer bookable at write time for ${startIso}`, payload: null });
          return { status: 409, body: { ok: false, no_reps: true, error: NO_REPS_COPY } };
        }
        const unavailable = !!res.calendar_unavailable || fresh.calendarUnavailable;
        await writeRequestRow(db, { ...baseRow, id: requestId, status: 'rejected', in_area: true, lead_id: contact.lead_id, customer_id: contact.customer_id, error_text: unavailable ? 'calendar_unavailable' : 'slot_taken' });
        await log({ endpoint: ENDPOINT, deal_id: null, customer_name: name, outcome: 'rejected', status_code: 409, message: `lost the slot race for ${startIso}`, payload: null });
        return { status: 409, body: { ok: false, taken: true, ...(unavailable ? { calendar_unavailable: true } : {}), error: unavailable ? CALENDAR_UNAVAILABLE_COPY : 'That time was just taken. Here are the next open times.', days: groupSlotsByDay(fresh.slots).slice(0, 10) } };
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
    if (inquiryConflict(err)) return inquiryConflictResponse();
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
  // Policy 2026-08-21 (Dylan): submitting a booking or callback request IS
  // consent to be texted; the page shows the disclosure as a notice instead
  // of a checkbox and STOP opts out. parseSmsConsent no longer gates.
  const smsConsent = true;
  const disclosure = cleanStr(settings.booking_sms_disclosure);
  // Prompt 105: the same capture path serves an in-area visitor when nobody
  // is bookable online (locked decision 5). The client says which; the
  // server re-derives it from the roster so the note and bell never lie.
  const noRepsClaimed = cleanStr(body.reason) === 'no_reps';

  try {
    if (!form || form.active === false || String(settings.booking_enabled || 'false') !== 'true') {
      return { status: 503, body: { ok: false, closed: true, error: 'Online booking is not open yet. Give us a call and we will get you scheduled.' } };
    }
    if (cleanStr(body.website)) {
      await writeRequestRow(db, { form_id: form && form.id, status: 'rejected', name, phone: phone10, email, in_area: false, error_text: 'honeypot', ip_hash: meta.ipHash, user_agent: meta.userAgent });
      return { status: 200, body: { ok: true } };
    }
    if (!name || !phone10 || phone10.length !== 10) {
      return { status: 400, body: { ok: false, error: 'Please give us your name and phone number so we can call you.' } };
    }
    if (email && (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
      return { status: 400, body: { ok: false, error: 'Please check your email address.' } };
    }
    const requestLimit = await guardSlotRequest(deps, settings, meta);
    if (requestLimit) return requestLimit;
    const routed = routeAnswers(form ? form.questions : [], body.answers);
    const source = await resolveLeadSourceName(db, routed.leadSourceAnswer || 'topcoat_booking');
    const sp = name.indexOf(' ');

    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(String(body.request_key || ''))) return { status: 400, body: { ok: false, error: 'Please refresh the booking form before submitting.' } };
    const contact = await resolveContact(db, phone10, email);
    let leadId = contact.lead_id;
    if (!leadId && contact.customer_id) {
      leadId = await recordInquiry(db, { customerId: contact.customer_id, key: 'booking:' + body.request_key, mode: body.inquiry_mode === 'new' ? 'new' : 'auto' });
      if (typeof leadId !== 'string' || !leadId) throw new Error('Could not link the customer inquiry to the sales pipeline');
    }
    if (!leadId) {
      const lead = await createBookingLead(db, {
        name, firstName: sp < 0 ? name : name.slice(0, sp),
        lastName: sp < 0 ? null : name.slice(sp + 1).trim() || null,
        phone10, email,
        address: addr.address, city: addr.city, state: addr.state, zip: addr.zip,
        source, smsConsent, disclosure, requestKey: 'booking:' + body.request_key, mode: body.inquiry_mode === 'new' ? 'new' : 'auto',
      });
      leadId = lead.id;
      contact.customer_id = lead.customer_id || null;
      await (deps.kickLeadAi || kickLeadAi)(leadId);
    } else if (smsConsent) {
      await upgradeLeadConsent(db, leadId, disclosure);
    }
    const whereTxt = [addr.address, addr.city, addr.zip].filter(Boolean).join(', ');
    const noReps = noRepsClaimed && (await loadEligibleReps(db, settings)).reps.length === 0;
    await db('POST', '/lead_events', {
      lead_id: leadId,
      event_type: 'note',
      payload: {
        text: noReps
          ? `Tried to book online but nobody was open for online booking (Settings > People, Takes online bookings). Address: ${whereTxt || 'no address given'}.${project ? ` Project: ${project}` : ''}`
          : `Tried to book online from OUTSIDE the service area: ${whereTxt || 'no address given'} (zip ${addr.zip || 'unknown'} not on the allowlist).${project ? ` Project: ${project}` : ''}`,
        via: noReps ? 'topcoat_booking_no_reps' : 'topcoat_booking_out_of_area',
      },
    }).catch(() => {});
    const reqRow = await writeRequestRow(db, {
      form_id: form && form.id, status: 'out_of_area', name, phone: phone10, email,
      address_line1: addr.address, address_city: addr.city, address_state: addr.state, address_zip: addr.zip,
      // in_area stays honest; error_text names the no-reps case so the
      // funnel drill can tell "we do not serve there" from "nobody was on".
      in_area: noReps ? true : false, lead_id: leadId, customer_id: contact.customer_id,
      error_text: noReps ? 'no_bookable_reps' : null,
      answers: { ...(body.answers && typeof body.answers === 'object' ? body.answers : {}), project },
      sms_consent: smsConsent, sms_consent_disclosure: smsConsent ? disclosure : null,
      ip_hash: meta.ipHash, user_agent: meta.userAgent,
    });
    try {
      await db('POST', '/pec_notifications', {
        type: 'booking_out_of_area',
        body: noReps
          ? `Booking request from ${name}${addr.city ? ` in ${addr.city}` : ''} while nobody was bookable online. They were told we would call about scheduling.`
          : `Out-of-area booking request from ${name}${addr.city ? ` in ${addr.city}` : ''}${addr.zip ? ` (${addr.zip})` : ''}. They were told we would call about scheduling.`,
        target_view: 'leads',
        target_id: leadId,
      });
    } catch (e) { console.warn('pec-booking: out-of-area bell failed (non-fatal):', e && e.message); }
    await log({ endpoint: ENDPOINT, deal_id: reqRow && reqRow.id, customer_name: name, outcome: 'ok', status_code: 200, message: `${noReps ? 'no_bookable_reps' : 'out_of_area'} lead ${leadId} (${addr.zip || addr.city || 'no address'})`, payload: null });
    return {
      status: 200,
      body: { ok: true, message: noReps
        ? 'Thanks! We will call you to set up your visit.'
        : 'Thanks! That address is a little outside our usual area, but we take projects like this case by case. We will call you about scheduling.' },
    };
  } catch (err) {
    if (inquiryConflict(err)) return inquiryConflictResponse();
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
    if (action === 'slots' || action === 'reschedule') {
      const slotLimit = await guardSlotRequest(deps, settings, meta);
      if (slotLimit) return slotLimit;
    }
    if (action === 'cancel') {
      if (appt.status === 'canceled') return { status: 200, body: { ok: true, message: 'This appointment is already canceled.' } };
      // The customer is the actor here; the header labels the audit row.
      await withActor(db, ACTOR_MANAGE)('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(appt.id)}`, { status: 'canceled' });
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
      const availability = await openSlotsFor(deps, {
        settings, form,
        customerAddr: { address: appt.location_address, city: appt.location_city, state: appt.location_state, zip: appt.location_zip },
        excludeApptId: appt.id,
        // Reschedule keeps the same rep: the locked update only moves times,
        // and swapping reps mid-manage would need a different write shape.
        // The rep must still pass the shared eligibility rule (prompt 105);
        // a rep switched off since the booking makes the move a phone call.
        onlyRepId: appt.sales_member_id || null,
      });
      if (availability.noEligibleReps) return { status: 200, body: { ok: true, no_reps: true, days: [], error: 'This appointment cannot be moved online right now. Please call us and we will find a new time.' } };
      if (availability.calendarUnavailable) return calendarUnavailable();
      const { slots } = availability;
      return { status: 200, body: { ok: true, days: groupSlotsByDay(slots).slice(0, 14) } };
    }

    if (action === 'reschedule') {
      if (appt.status === 'canceled') return { status: 400, body: { ok: false, error: 'This appointment is canceled and cannot be moved. Book a new time from the booking page.' } };
      const start = cleanStr(body.start);
      if (!start || isNaN(new Date(start))) return { status: 400, body: { ok: false, error: 'Pick one of the offered times.' } };
      const form = await loadForm(db, 'pec');
      const availability = await openSlotsFor(deps, {
        settings, form,
        customerAddr: { address: appt.location_address, city: appt.location_city, state: appt.location_state, zip: appt.location_zip },
        excludeApptId: appt.id,
        onlyRepId: appt.sales_member_id || null,
      });
      if (availability.noEligibleReps) return { status: 409, body: { ok: false, no_reps: true, error: 'This appointment cannot be moved online right now. Please call us and we will find a new time.' } };
      if (availability.calendarUnavailable) return calendarUnavailable();
      const { slots } = availability;
      const startIso = new Date(start).toISOString();
      const slot = slots.find(s => s.start === startIso);
      if (!slot) return { status: 409, body: { ok: false, taken: true, error: 'That time is no longer open. Here are the current options.', days: groupSlotsByDay(slots).slice(0, 14) } };

      const bookSlot = deps.bookSlot || makeBookSlot(db);
      const res = await bookSlot({
        sales_member_id: appt.sales_member_id || '',
        start_at: slot.start, end_at: slot.end,
      }, slot.buffer_before, slot.buffer_after, appt.id, ACTOR_MANAGE);
      if (!res || res.ok !== true) {
        if (res && (res.taken || res.calendar_unavailable)) {
          const fresh = await openSlotsFor(deps, {
            settings, form,
            customerAddr: { address: appt.location_address, city: appt.location_city, state: appt.location_state, zip: appt.location_zip },
            excludeApptId: appt.id, onlyRepId: appt.sales_member_id || null,
          });
          const unavailable = !!res.calendar_unavailable || fresh.calendarUnavailable;
          return { status: 409, body: { ok: false, taken: true, ...(unavailable ? { calendar_unavailable: true } : {}), error: unavailable ? CALENDAR_UNAVAILABLE_COPY : 'That time was just taken. Pick another.', days: groupSlotsByDay(fresh.slots).slice(0, 14) } };
        }
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

async function processSlots(deps, body, meta = {}) {
  const db = deps.sb;
  const settings = await getBookingSettings(db);
  deps.settings = settings;
  try {
    const slotLimit = await guardSlotRequest(deps, settings, meta);
    if (slotLimit) return slotLimit;
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
    const availability = await openSlotsFor(deps, { settings, form, customerAddr: addr });
    // Nobody bookable online (prompt 105): no slots, and the page offers the
    // same leave-your-details step the out-of-area path uses.
    if (availability.noEligibleReps) return { status: 200, body: { ok: true, open: true, in_area: true, no_reps: true, days: [] } };
    if (availability.calendarUnavailable) return calendarUnavailable();
    const { slots } = availability;
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

function htmlResponse(statusCode, html, robots = 'noindex, nofollow') {
  return {
    statusCode,
    headers: {
      ...PUBLIC_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': statusCode === 200 ? robots : 'noindex, nofollow',
      'Cache-Control': 'no-store',
    },
    body: html,
  };
}

// Hosted and embedded pages share the same TopCoat controls and layout.
function pageShell(brand, title, inner, { embed = false, bare = false, head = '' } = {}) {
  const accent = brand.accent_color || '#D8531C';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${head}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{color-scheme:light;--accent:${esc(accent)};--button:color-mix(in srgb,var(--accent) 86%,#000);--ink:#0f1420;--muted:#626b79;--line:#e6e8ec;--bg:#eef0f3;--soft:#f5f6f8;--selected:color-mix(in srgb,var(--accent) 12%,#fff)}
*{box-sizing:border-box}body{margin:0;font-family:Inter,-apple-system,'Segoe UI',Arial,sans-serif;background:${embed ? 'transparent' : 'var(--bg)'};color:var(--ink);font-size:14px}
.wrap{max-width:700px;margin:0 auto;padding:${embed ? '4px' : '26px 14px 50px'}}
.card,.bk-window{background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:0 1px 2px rgba(15,20,32,.04)}
.card{padding:24px;margin-top:14px}.bk-window{overflow:hidden}
.bk-brand{padding:20px 26px;display:flex;justify-content:space-between;align-items:center;gap:16px;border-bottom:1px solid var(--line)}
.bk-logo{display:block;width:146px;max-height:70px;object-fit:contain;object-position:left center}.bk-brand-name{font-weight:600}
.bk-tag{font-size:11px;color:var(--button);padding:7px 10px;background:var(--selected);border-radius:8px;text-align:center}
.bk-main{padding:28px}.bk-eyebrow{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.4px;color:var(--button);margin-bottom:10px}
h1{font-size:26px;line-height:1.2;letter-spacing:-.5px;font-weight:600;margin:0 0 10px}h2{font-size:17px;line-height:1.4;font-weight:500;margin:0 0 6px}
p{line-height:1.55;margin:0 0 14px}.muted,.qsub{color:var(--muted);line-height:1.55}.muted{font-size:12px}.qsub{margin:0 0 18px}
.bk-steps{display:flex;gap:4px;padding:4px;margin:24px 0;background:var(--soft);border:1px solid var(--line);border-radius:10px}
button{font:inherit;cursor:pointer}button:disabled{cursor:default;opacity:.55}button:focus-visible,a:focus-visible{outline:2px solid var(--button);outline-offset:3px}
.bk-step{flex:1;border:0;border-radius:7px;background:transparent;color:var(--muted);padding:9px 6px;font-size:12px;line-height:1.4;min-height:44px}
.bk-step[aria-current=step]{color:var(--button);background:#fff;box-shadow:0 1px 3px rgba(15,20,32,.1)}
.bk-step span{display:inline-flex;align-items:center;justify-content:center;width:21px;height:21px;background:var(--soft);border-radius:50%;margin-right:6px;font-size:11px}
.bk-step[aria-current=step] span{background:var(--button);color:#fff}
.bk-location{display:flex;gap:12px;align-items:center;padding:12px 14px;background:var(--soft);border:1px solid var(--line);border-radius:10px;font-size:13px;line-height:1.5;margin-bottom:22px}
.bk-location>span{flex:1;min-width:0;overflow-wrap:anywhere}.bk-link{border:0;background:transparent;color:var(--button);font-size:12px;padding:10px 2px;min-height:44px;text-decoration:underline;text-underline-offset:3px}
.bk-date-label{display:flex;justify-content:space-between;gap:10px;align-items:center;margin:22px 0 10px;font-size:13px}.bk-month-nav{display:flex;gap:6px;flex-shrink:0}
.bk-arrow{width:44px;height:44px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);font-size:22px}
.daygrid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}.daycard{padding:10px 3px;border:1px solid var(--line);background:#fff;color:var(--muted);border-radius:10px;font-size:11px;line-height:1.4}
.dw,.dn,.dm{display:block}.dn{font-size:23px;line-height:1.4;font-weight:500;color:var(--ink)}
.daycard[aria-pressed=true],.slot[aria-pressed=true],.slot.sel{border-color:var(--button);background:var(--selected);color:var(--button)}.daycard[aria-pressed=true] .dn{color:var(--button)}
.daycard:hover,.slot:hover{border-color:var(--button)}.bk-times{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0 24px}
.slot{border:1px solid var(--line);border-radius:10px;padding:12px 8px;font-size:13px;min-height:44px;background:#fff;color:var(--ink)}
#mgDays .slot{margin:4px}.bk-fieldrow{display:grid;grid-template-columns:1fr 1fr;gap:12px}.bk-fieldrow>div{min-width:0}
label{display:block;font-size:12px;color:var(--ink);margin:16px 0 6px}input,select,textarea{font:inherit;font-size:16px;width:100%;border:1px solid #c7ccd4;background:#fff;color:var(--ink);border-radius:8px;padding:12px;min-width:0}
input:focus,select:focus,textarea:focus{outline:2px solid var(--button);outline-offset:1px}
.bk-action{display:flex;justify-content:space-between;align-items:center;gap:14px;border-top:1px solid var(--line);padding-top:20px;margin-top:22px}
.btn{display:inline-flex;justify-content:center;align-items:center;background:var(--button);color:#fff;border:0;border-radius:10px;padding:13px 18px;font-size:14px;font-weight:600;min-height:46px;text-align:center;text-decoration:none}
.card>.btn{width:100%}.btn.ghost{background:#fff;color:var(--ink);border:1px solid #c7ccd4}
.bk-selection{font-size:12px;line-height:1.5;color:var(--muted)}.bk-selection b{font-weight:500;display:block;color:var(--ink);font-size:14px}
.bk-footer{background:var(--soft);border-top:1px solid var(--line);padding:15px 26px;font-size:12px;line-height:1.5;color:var(--muted);display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px}.bk-footer a{color:var(--ink)}
.err{color:#b42318;font-size:13px;min-height:18px;margin-top:8px}.ok-badge{display:inline-flex;width:44px;height:44px;align-items:center;justify-content:center;border-radius:50%;background:var(--selected);color:var(--button);margin-bottom:16px;font-size:20px}
.sug{position:absolute;left:0;right:0;top:100%;z-index:50;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 24px rgba(15,20,32,.14);max-height:240px;overflow-y:auto;display:none;margin-top:2px}
.sug div{padding:12px;cursor:pointer;font-size:14px;border-top:1px solid var(--line)}.sug div:first-child{border-top:0}.sug div:hover{background:var(--soft)}
.consent{margin-top:16px;font-size:11px;line-height:1.6;color:var(--muted)}.hpwrap{position:absolute;left:-9999px;top:-9999px;height:1px;overflow:hidden}
header.bk{display:flex;align-items:center;gap:12px;padding-top:18px}header.bk img{height:44px}header.bk .bn{font-weight:600}
a{color:var(--button)}.bk-preview section{padding:22px 0;border-top:1px solid var(--line)}
@media(max-width:460px){.wrap{padding:${embed ? '4px' : '10px 7px 24px'}}.bk-main{padding:20px 14px}.bk-brand{padding:14px}.bk-logo{width:128px}.bk-tag{max-width:100px}h1{font-size:24px}.bk-steps{gap:2px}.bk-step{font-size:11px;padding:8px 2px}.bk-step span{display:block;margin:0 auto 5px}.daygrid{gap:5px}.bk-times{grid-template-columns:repeat(2,1fr)}.bk-fieldrow{grid-template-columns:1fr}.bk-action{align-items:stretch;flex-direction:column}.bk-footer{padding:14px}}
</style></head><body><main class="wrap">${(embed || bare) ? '' : `
<header class="bk">${brand.logo_url ? `<img src="${esc(brand.logo_url)}" alt="${esc(brand.business_name)}">` : ''}<div><div class="bn">${esc(brand.business_name)}</div>${brand.phone ? `<div class="muted">Call <a href="tel:${esc(brand.phone)}">${esc(brand.phone)}</a></div>` : ''}</div></header>`}
${inner}
</main>${embed ? `<script>
(function(){var last=0;function post(){var h=document.documentElement.scrollHeight;if(h!==last){last=h;parent.postMessage({pecBookingHeight:h},'*');}}
new MutationObserver(post).observe(document.documentElement,{subtree:true,childList:true,attributes:true});
window.addEventListener('load',post);setInterval(post,800);})();
</script>` : ''}</body></html>`;
}

function closedInner(brand) {
  return `<div class="card">
  ${brand.logo_url ? `<img class="bk-logo" src="${esc(brand.logo_url)}" alt="${esc(brand.business_name || '')}" style="margin-bottom:20px">` : ''}
  <h1>Online booking is unavailable</h1>
<p class="qsub">${brand.phone ? `Call <a href="tel:${esc(brand.phone)}">${esc(brand.phone)}</a> to schedule an appointment.` : 'Please call us to schedule an appointment.'}</p></div>`;
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
    duplicateMessage: DUPLICATE_BOOKING_MESSAGE,
  }).replace(/</g, '\\u003c');
  const headline = form.headline || 'Book your free estimate';
  const brand = opts.brand || {};
  return `
${preview ? '<div class="card" style="padding:10px 14px;margin-bottom:12px"><span class="muted">Form preview. Nothing will be booked.</span></div>' : ''}
<div class="bk-window${preview ? ' bk-preview' : ''}">
  <header class="bk-brand">
    ${brand.logo_url ? `<img class="bk-logo" src="${esc(brand.logo_url)}" alt="${esc(brand.business_name || '')}">` : `<span class="bk-brand-name">${esc(brand.business_name || '')}</span>`}
    <span class="bk-tag" id="bkTypeLabel">${esc(t.label)}</span>
  </header>
  <div class="bk-main">
  <div class="bk-eyebrow">Schedule a visit</div>
  <h1 id="bkHeadline">${esc(headline)}</h1>
  <p class="qsub" id="bkIntro"${form.intro_text ? '' : ' style="display:none"'}>${esc(form.intro_text || '')}</p>
  <nav class="bk-steps" id="bkSteps" aria-label="Booking steps">
    <button class="bk-step" id="st1" type="button" aria-current="step"><span>1</span>Location</button>
    <button class="bk-step" id="st2" type="button" disabled><span>2</span>Date &amp; time</button>
    <button class="bk-step" id="st3" type="button" disabled><span>3</span>Your details</button>
  </nav>

<section id="stepAddr" aria-labelledby="bkAddressHeading">
  <h2 id="bkAddressHeading">Project address</h2>
  <p class="qsub">Enter the address to see available appointments.</p>
  <div style="position:relative">
    <label for="bkAddr">Street address</label>
    <input id="bkAddr" autocomplete="street-address" placeholder="123 N Example St" inputmode="text" aria-required="true">
    <div class="sug" id="bkSug"></div>
  </div>
  <div class="bk-fieldrow">
    <div><label for="bkCity">City</label><input id="bkCity" autocomplete="address-level2"></div>
    <div><label for="bkZip">ZIP code</label><input id="bkZip" autocomplete="postal-code" inputmode="numeric" maxlength="10"></div>
  </div>
  <div class="err" id="bkAddrErr" role="alert"></div>
  <div class="bk-action"><span class="bk-selection" id="bkDuration">About ${t.duration} minutes</span><button class="btn" id="bkAddrNext" type="button">See open times</button></div>
</section>

<section id="stepOut" aria-labelledby="bkOutHeading" style="display:none">
  <h2 id="bkOutHeading">Outside our online booking area</h2>
  <p class="qsub" id="bkOutSub">Leave your details and we'll call to discuss your project.</p>
  <button class="bk-link" id="ooChangeAddress" type="button">Change address</button>
  <label for="ooName">Name</label><input id="ooName" autocomplete="name" aria-required="true">
  <label for="ooPhone">Phone</label><input id="ooPhone" autocomplete="tel" type="tel" aria-required="true">
  <label for="ooEmail">Email (optional)</label><input id="ooEmail" autocomplete="email" type="email">
  <label for="ooProject">Tell us about the project</label><textarea id="ooProject" rows="3"></textarea>
  <label><input id="ooNewRequest" type="checkbox" style="width:auto"> This is a separate new project from another quote I already requested.</label>
  <div class="consent"><span id="ooConsentText"></span></div>
  <div class="err" id="ooErr" role="alert"></div>
  <div class="bk-action"><span></span><button class="btn" id="ooSend" type="button">Request a call</button></div>
</section>

<section id="stepTime" aria-labelledby="bkTimeHeading" style="display:none">
  <div class="bk-location"><span id="bkAddressSummary"></span><button class="bk-link" id="bkChangeAddress" type="button">Change address</button></div>
  <h2 id="bkTimeHeading">Choose a date and time</h2>
  <p class="qsub" id="bkTimeDuration">${t.duration}-minute visit · Arizona time</p>
  <div class="bk-date-label"><span id="bkDateRange" aria-live="polite">Available dates</span><div class="bk-month-nav"><button class="bk-arrow" id="bkDatePrev" type="button" aria-label="Previous dates">‹</button><button class="bk-arrow" id="bkDateNext" type="button" aria-label="More dates">›</button></div></div>
  <div id="bkDays" aria-label="Available dates"></div>
  <div id="bkTimes" style="display:none">
    <div class="bk-date-label"><span id="bkTimeDay"></span></div>
    <div id="bkTimeBtns" class="bk-times" aria-label="Available times"></div>
  </div>
  <div class="err" id="bkTimeErr" role="alert"></div>
  <div class="bk-action"><div class="bk-selection" aria-live="polite"><b id="bkSelectedDay">Select a time</b><span id="bkSelectedTime"></span></div><button class="btn" id="bkContinue" type="button" disabled>Continue</button></div>
</section>

<section id="stepDetails" aria-labelledby="bkDetailsHeading" style="display:none">
  <div class="bk-location"><span id="bkChosen"></span><button class="bk-link" id="bkChangeTime" type="button">Change time</button></div>
  <h2 id="bkDetailsHeading">Contact details</h2>
  <label for="bkName">Name</label><input id="bkName" autocomplete="name" aria-required="true">
  <div class="bk-fieldrow">
    <div><label for="bkPhone">Mobile phone</label><input id="bkPhone" autocomplete="tel" type="tel" aria-required="true"></div>
    <div><label for="bkEmail">Email</label><input id="bkEmail" autocomplete="email" type="email" aria-required="true"></div>
  </div>
  <div id="bkQuestions"></div>
  <label><input id="bkNewRequest" type="checkbox" style="width:auto"> This is a separate new project from another quote I already requested.</label>
  <div class="hpwrap" aria-hidden="true"><label for="bkWebsite">Website</label><input id="bkWebsite" tabindex="-1" autocomplete="off"></div>
  <div class="consent"><span id="bkConsentText"></span></div>
  <div class="err" id="bkErr" role="alert"></div>
  <div class="bk-action"><span class="bk-selection">${esc(t.label)}</span><button class="btn" id="bkBook" type="button">Book appointment</button></div>
</section>

<section id="stepDone" aria-labelledby="doneTitle" style="display:none">
  <div class="ok-badge" aria-hidden="true">&#10003;</div>
  <h2 id="doneTitle">Appointment booked</h2>
  <p id="doneMsg"></p>
  <p class="muted" id="doneManage"></p>
</section>

  </div>
  ${brand.phone || brand.license_number ? `<footer class="bk-footer">${brand.phone ? `<span>Questions? <a href="tel:${esc(brand.phone)}">${esc(brand.phone)}</a></span>` : ''}${brand.license_number ? `<span>Licensed, bonded &amp; insured · ${esc(brand.license_number)}</span>` : ''}</footer>` : ''}
</div>

<script>window.__BK=${cfgJson};</script>
<script>
(function(){
'use strict';
var CFG=window.__BK, S={addr:null, start:null, days:[], dayIndex:0, dayOffset:0, busy:false, complete:false, t0:Date.now()};
var $=function(id){return document.getElementById(id)};
function show(id,on){$(id).style.display=on?'':'none'}
function step(n){
  ['st1','st2','st3'].forEach(function(id,i){
    var el=$(id);if(i+1===n)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');
    el.disabled=CFG.preview||S.busy||S.complete||(i===1&&(!S.addr||!S.days.length))||(i===2&&!S.start);
  });
}
function go(n){
  if(CFG.preview||S.busy||S.complete)return;
  if(n===2&&(!S.addr||!S.days.length))return;
  if(n===3&&!S.start)return;
  if(n===3)renderQuestions();
  ['stepAddr','stepTime','stepDetails','stepOut','stepDone'].forEach(function(id,i){show(id,i===n-1)});
  step(n);
  var heading=$(['bkAddressHeading','bkTimeHeading','bkDetailsHeading'][n-1]);
  heading.setAttribute('tabindex','-1');heading.focus();
}
function resetSelection(){S.start=null;$('bkContinue').disabled=true;$('bkSelectedDay').textContent='Select a time';$('bkSelectedTime').textContent='';$('bkChosen').textContent='';}
function changeAddress(){if(CFG.preview||S.busy||S.complete)return;S.addr=null;S.days=[];S.dayOffset=0;resetSelection();go(1)}
// The leave-your-details step serves two cases: the address is outside the
// service area, or (prompt 105) nobody is bookable online right now. Same
// form, same /lead call; only the copy and the reason flag differ.
function outStep(noReps){
  S.noReps=!!noReps;
  $('bkOutHeading').textContent=noReps?'Online scheduling is not open right now':'Outside our online booking area';
  $('bkOutSub').textContent=noReps?'Leave your details and we will call you to set up your visit.':'Leave your details and we will call to discuss your project.';
  show('stepAddr',false);show('stepTime',false);show('stepDetails',false);show('stepOut',true);step(1);
}
$('st1').addEventListener('click',changeAddress);
$('st2').addEventListener('click',function(){go(2)});
$('st3').addEventListener('click',function(){go(3)});
$('bkChangeAddress').addEventListener('click',changeAddress);
$('ooChangeAddress').addEventListener('click',changeAddress);
$('bkChangeTime').addEventListener('click',function(){go(2)});
function setHeadline(t){$('bkHeadline').textContent=t||'Book your free estimate'}
var inquiryRequestKey=crypto.randomUUID();
function api(path,body){if(path==='book'||path==='lead'){body.request_key=inquiryRequestKey;body.inquiry_mode=$(path==='book'?'bkNewRequest':'ooNewRequest').checked?'new':'auto';}return fetch('/api/booking/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){j.__status=r.status;return j})})}

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
  delete this.dataset.placeId;
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

// ---- Location and live availability ----
$('bkAddrNext').addEventListener('click',function(){
  if(CFG.preview||S.busy||S.complete)return;
  var a={address1:$('bkAddr').value.trim(),city:$('bkCity').value.trim(),zip:$('bkZip').value.trim(),place_id:$('bkAddr').dataset.placeId||''};
  $('bkAddrErr').textContent='';
  if(!a.address1||(!a.zip&&!a.city)){$('bkAddrErr').textContent='Enter the street address and a city or ZIP code.';return}
  var btn=$('bkAddrNext');S.busy=true;step(1);btn.disabled=true;btn.textContent='Checking...';
  api('slots',{form:CFG.slug,address1:a.address1,city:a.city,zip:a.zip}).then(function(j){
    S.busy=false;btn.disabled=false;btn.textContent='See open times';step(1);
    if(j.open===false){$('bkAddrErr').textContent='Online booking is unavailable. Please call us to schedule.';return}
    if(j.in_area===false){S.addr=a;outStep(false);return}
    if(j.no_reps){S.addr=a;outStep(true);return}
    if(!j.ok){$('bkAddrErr').textContent=j.error||'Could not load appointments. Please try again.';return}
    S.addr=a;S.days=j.days||[];S.dayOffset=0;S.dayIndex=0;resetSelection();
    if(!S.days.length){$('bkAddrErr').textContent='No appointments are available online. Please call us to schedule.';return}
    $('bkAddressSummary').textContent=[a.address1,a.city,a.zip].filter(Boolean).join(', ');
    $('bkTimeErr').textContent='';renderDays();go(2);
  }).catch(function(){S.busy=false;step(1);btn.disabled=false;btn.textContent='See open times';$('bkAddrErr').textContent='Could not load appointments. Check your connection and try again.'});
});

// Calendar dates come from the server in Arizona time. Paging keeps every
// returned date reachable, including gaps and dates spanning month boundaries.
function dayParts(iso){
  var dt=new Date(iso+'T12:00:00');
  return {w:dt.toLocaleDateString('en-US',{weekday:'short'}),n:String(dt.getDate()),m:dt.toLocaleDateString('en-US',{month:'short'}),y:dt.getFullYear()};
}
function dayCard(d,i){
  var b=document.createElement('button');b.className='daycard';b.type='button';
  var p=dayParts(d.date);
  b.innerHTML='<span class="dw"></span><span class="dn"></span><span class="dm"></span>';
  b.querySelector('.dw').textContent=p.w;b.querySelector('.dn').textContent=p.n;b.querySelector('.dm').textContent=p.m;
  b.setAttribute('aria-label',d.label);b.setAttribute('aria-pressed',String(i===S.dayIndex));
  b.addEventListener('click',function(){if(i!==S.dayIndex){S.dayIndex=i;resetSelection();renderDays();$('bkDays').querySelector('[aria-pressed="true"]').focus()}});
  return b;
}
function renderDays(){
  var el=$('bkDays');el.innerHTML='';
  var list=S.days.slice(S.dayOffset,S.dayOffset+5);
  var grid=document.createElement('div');grid.className='daygrid';
  list.forEach(function(d,i){grid.appendChild(dayCard(d,S.dayOffset+i))});el.appendChild(grid);
  $('bkDatePrev').disabled=S.dayOffset===0;
  $('bkDateNext').disabled=S.dayOffset+5>=S.days.length;
  var first=list.length?dayParts(list[0].date):null,last=list.length?dayParts(list[list.length-1].date):null;
  $('bkDateRange').textContent=first?first.m+' '+first.n+(first.y!==last.y?', '+first.y:'')+(list.length>1?' – '+last.m+' '+last.n:'')+', '+last.y:'No available dates';
  show('bkTimes',!!S.days[S.dayIndex]);
  if(S.days[S.dayIndex])renderTimes(S.dayIndex);else{$('bkTimeBtns').innerHTML='';resetSelection()}
  step(2);
}
function renderTimes(i){
  var d=S.days[i];$('bkTimeDay').textContent='Times for '+d.label;
  var el=$('bkTimeBtns');el.innerHTML='';
  d.slots.forEach(function(s){
    var b=document.createElement('button');b.className='slot';b.type='button';b.textContent=s.label;
    b.setAttribute('aria-pressed',String(s.start===S.start));
    b.addEventListener('click',function(){
      S.start=s.start;
      $('bkChosen').textContent=d.label+' at '+s.label+' · '+CFG.duration+' minutes · Arizona time';
      $('bkSelectedDay').textContent=d.label;$('bkSelectedTime').textContent=s.label+' · Arizona time';
      $('bkContinue').disabled=false;$('bkTimeErr').textContent='';
      Array.from(el.children).forEach(function(button){button.setAttribute('aria-pressed',String(button===b))});step(2);
    });
    el.appendChild(b);
  });
}
function pageDays(direction){
  if(CFG.preview||S.busy)return;
  var next=S.dayOffset+direction*5;if(next<0||next>=S.days.length)return;
  S.dayOffset=next;S.dayIndex=next;resetSelection();renderDays();
}
$('bkDatePrev').addEventListener('click',function(){pageDays(-1)});
$('bkDateNext').addEventListener('click',function(){pageDays(1)});
$('bkContinue').addEventListener('click',function(){if(CFG.preview||!S.start||S.busy)return;renderQuestions();go(3)});

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
    input.id='q_'+q.id;if(q.required)input.setAttribute('aria-required','true');host.appendChild(input);
    if(q.help){var h=document.createElement('div');h.className='muted';h.style.marginTop='3px';h.textContent=q.help;host.appendChild(h)}
  });
}

$('bkBook').addEventListener('click',function(){
  if(CFG.preview||S.busy||S.complete||!S.addr||!S.start)return;
  var answers={};(CFG.questions||[]).forEach(function(q){var el=$('q_'+q.id);if(el&&el.value.trim())answers[q.id]=el.value.trim()});
  $('bkErr').textContent='';
  var btn=$('bkBook');S.busy=true;step(3);$('bkChangeTime').disabled=true;btn.disabled=true;btn.textContent='Booking...';
  api('book',{
    form:CFG.slug,start:S.start,
    name:$('bkName').value.trim(),phone:$('bkPhone').value.trim(),email:$('bkEmail').value.trim(),
    address1:S.addr.address1,city:S.addr.city,zip:S.addr.zip,place_id:S.addr.place_id,
    answers:answers,sms_consent:'true',
    website:$('bkWebsite').value,fill_ms:Date.now()-S.t0
  }).then(function(j){
    S.busy=false;step(3);$('bkChangeTime').disabled=false;btn.disabled=false;btn.textContent='Book appointment';
    if(j.no_reps){outStep(true);return}
    if(j.taken){S.days=Array.isArray(j.days)?j.days:[];S.dayOffset=0;S.dayIndex=0;resetSelection();show('stepDetails',false);show('stepTime',true);renderDays();$('bkTimeErr').textContent=S.days.length?(j.error||'That time is no longer available. Choose another time.'):'No appointments are available online. Please call us to schedule.';step(2);return}
    if(!j.ok){$('bkErr').textContent=j.error||'Something went wrong.';return}
    if(j.duplicate){$('doneMsg').textContent='';$('doneManage').replaceChildren();$('bkErr').textContent=CFG.duplicateMessage;return}
    S.complete=true;step(3);show('bkSteps',false);show('stepDetails',false);show('stepDone',true);
    $('doneTitle').textContent='Appointment booked';$('doneManage').replaceChildren();
    $('doneMsg').textContent=(j.message||'')+(j.when?(' Your visit: '+j.when+'.'):'');
    if(j.manage_url){var link=document.createElement('a');link.href=j.manage_url;link.textContent='Reschedule or cancel';$('doneManage').replaceChildren(link,document.createTextNode('. This link is also in your confirmation.'))}
  }).catch(function(){S.busy=false;step(3);$('bkChangeTime').disabled=false;btn.disabled=false;btn.textContent='Book appointment';$('bkErr').textContent='Could not reach us. Check your connection and try again.'});
});

// ---- Out of area ----
$('ooSend').addEventListener('click',function(){
  if(CFG.preview||S.busy||S.complete||!S.addr)return;
  $('ooErr').textContent='';
  var btn=$('ooSend');S.busy=true;step(1);$('ooChangeAddress').disabled=true;btn.disabled=true;btn.textContent='Sending...';
  api('lead',{
    form:CFG.slug,name:$('ooName').value.trim(),phone:$('ooPhone').value.trim(),email:$('ooEmail').value.trim(),
    address1:S.addr.address1,city:S.addr.city,zip:S.addr.zip,project:$('ooProject').value.trim(),
    reason:S.noReps?'no_reps':'',
    sms_consent:'true',website:$('bkWebsite')?$('bkWebsite').value:'',fill_ms:Date.now()-S.t0
  }).then(function(j){
    S.busy=false;step(1);$('ooChangeAddress').disabled=false;btn.disabled=false;btn.textContent='Request a call';
    if(!j.ok){$('ooErr').textContent=j.error||'Something went wrong.';return}
    S.complete=true;show('bkSteps',false);show('stepOut',false);show('stepDone',true);step(3);
    $('doneTitle').textContent='We’ll call you';
    $('doneMsg').textContent=j.message||'';
  }).catch(function(){S.busy=false;step(1);$('ooChangeAddress').disabled=false;btn.disabled=false;btn.textContent='Request a call';$('ooErr').textContent='Could not reach us. Try again.'});
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
  ['st1','st2','st3','bkAddrNext','bkBook','ooSend','bkContinue','bkChangeAddress','bkChangeTime','ooChangeAddress','bkDatePrev','bkDateNext'].forEach(function(id){var b=$(id);if(b)b.disabled=true});
  window.addEventListener('message',function(e){
    var d=e.data&&e.data.pecBookingPreview;if(!d)return;
    if(Array.isArray(d.questions)){CFG.questions=d.questions;var host=$('bkQuestions');host.innerHTML='';delete host.dataset.done;renderQuestions()}
    if(typeof d.headline==='string'){setHeadline(d.headline)}
    if(typeof d.intro==='string'){var ip=$('bkIntro');ip.textContent=d.intro;ip.style.display=d.intro?'':'none'}
    if(typeof d.success==='string'){$('doneMsg').textContent=d.success}
    if(typeof d.typeLabel==='string')CFG.typeLabel=d.typeLabel;
    if(typeof d.duration==='number')CFG.duration=d.duration;
    $('bkTypeLabel').textContent=CFG.typeLabel;$('bkDuration').textContent='About '+CFG.duration+' minutes';$('bkTimeDuration').textContent=CFG.duration+'-minute visit · Arizona time';$('bkChosen').textContent=CFG.typeLabel+', about '+CFG.duration+' minutes.';
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
    if(j.no_reps){$('mgErr').textContent=j.error||'This appointment cannot be moved online right now. Please call us.';return}
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

    if (Buffer.byteLength(event.body || '', 'utf8') > 65536) return json(413, { ok: false, error: 'Request is too large' });
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { ok: false, error: 'Invalid request' }); }
    if (!validPublicBody(body)) return json(400, { ok: false, error: 'Invalid request' });
    const meta = { ipHash: ipHashFrom(event), userAgent: cleanStr(event.headers && event.headers['user-agent']) };

    let out;
    if (action === 'slots') out = await processSlots(deps, body, meta);
    else if (action === 'book') out = await processBook(deps, body, meta);
    else if (action === 'lead') out = await processOutOfAreaLead(deps, body, meta);
    else if (action === 'manage') out = await processManage(deps, body, meta);
    else out = { status: 404, body: { ok: false, error: 'Unknown action' } };
    return json(out.status, out.body, out.headers);
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
    const discovery = bookingDiscovery({ brand, form, siteUrl: SITE_URL, publicBooking: !!open, preview, embed });
    return htmlResponse(200, pageShell(brand, form.headline || `Book with ${brand.business_name}`, bookingPageInner(form, PEC_MAPS_KEY, { preview, brand }), { embed, bare: true, head: discovery.head }), discovery.robots);
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
exports.validPublicBody = validPublicBody;
exports.DUPLICATE_BOOKING_MESSAGE = DUPLICATE_BOOKING_MESSAGE;
exports.htmlResponse = htmlResponse;

exports.pageShell = pageShell;
exports.bookingPageInner = bookingPageInner;
