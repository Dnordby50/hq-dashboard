// Routemize -> TopCoat appointment intake (prompt 43 contract + prompt 56
// native adapter). Appointments booked in Routemize land on the TopCoat
// calendar as the system of record, linked to the originating lead so the
// lead -> drip -> appointment pipeline stays connected.
//
// TWO BODY SHAPES, one endpoint, auto-detected (prompt 56 decision 1):
//   1. Routemize NATIVE webhook envelope ({ eventType, data, ... }): posted
//      directly by Routemize's Custom Webhook "TopCoat appointment intake"
//      (no Zapier anywhere in the chain). mapRoutemizeEnvelope() translates
//      it onto the hand-rolled contract below, then the shared flow runs.
//      Native deliveries ALSO get the lead-side behavior the prompt-43
//      contract deliberately does not: see "Routemize-native lead behavior".
//   2. The original hand-rolled contract (everything below): still fully
//      supported, so a manual curl keeps working.
//
// POST /.netlify/functions/pec-appt-intake
// Header: x-webhook-secret: <PEC_WEBHOOK_SECRET>   (same secret every intake
//         webhook uses; already set in Netlify env)
//
// Body:
//   {
//     action: 'created' | 'updated' | 'canceled' | 'deleted'   // default 'created'
//     routemize_appt_id: string      // REQUIRED: idempotency + update/cancel key
//     appt_type: string              // optional; on_site_estimate (default) /
//                                    //   project_walkthrough / site_visit / other
//     title: string                  // optional; default customer name, else type label
//     start_at: string               // REQUIRED for created/updated. ISO 8601;
//                                    //   a BARE datetime is read as America/Phoenix
//                                    //   (fixed -07:00, the project convention)
//     end_at: string                 // optional; default start_at + 60 min
//     all_day: boolean               // optional; default false
//     customer_name, phone, email    // lead/customer match + carry-on-appt
//     address, city, state, zip      // optional -> location_* columns
//     assigned_member_email          // -> pec_sales_team_members.google_email
//     assigned_member_name           // -> pec_sales_team_members.name (fallback)
//     notes: string                  // internal Company notes
//     customer_notes: string         // customer-facing Job notes
//   }
//
// Behavior:
//   - created: insert with source='routemize', status='scheduled'; if a row
//     already exists for that routemize_appt_id, treat as an update (Zapier
//     retries and double-fires are harmless).
//   - updated: patch the matched row; if missing, insert (upsert-safe).
//     google_* columns are never touched (the existing push owns them).
//   - canceled / deleted: set status='canceled' on the matched row (never a
//     hard delete; the Google push kicked below removes the Google event off
//     that status). No-op if not found.
//   - Every write path kicks the Google Calendar push server-side
//     (_pec-appt-push.cjs, prompt 88): the dashboard's client-side kick
//     never runs for webhook-sourced writes, which left every Routemize
//     booking off Google for a month. Best-effort; see kickPush below.
//   - Lead linkage (prompt 43 decision 3): match a LIVE lead by last-10 phone
//     or email and link it (plus its customer); else a customer by the same
//     keys; else leave both null and carry name/phone on the appointment
//     itself. The hand-rolled contract never auto-creates a lead or customer
//     (would collide with the other intake paths).
//
// Routemize-native lead behavior (prompt 56, REVERSING prompt 43 decision 3
// for the native path ONLY, Dylan 2026-07-29): Routemize is now the front
// door, so a direct booker who matches no lead and no customer gets a lead
// CREATED (stage 'new'; apptBookingLeadEffects then advances it exactly like
// an in-app booking). The collision risk prompt 43 worried about is handled
// by sharing pec-lead-intake's own same-human dedupe (_pec-lead-match.cjs):
// the windowless lead match here is strictly broader than lead-intake's
// 90-day window, so if it found nothing, the windowed dedupe cannot hit
// either, and creating is safe. A created lead is NOT nurture-enrolled
// (landmine 3: apptBookingLeadEffects would pause it instantly; enroll-then-
// pause is churn). Prompt 97 REVERSED the "no AI kick" half of that decision:
// the no-kick was right for drips and wrong for scoring, and with Routemize
// as the front door it silenced leads.score for most new leads. A created
// lead now kicks pec-lead-ai (best-effort, fire-and-forget past the request
// leaving; see kickLeadAi), exactly like pec-lead-intake does. Nurture
// enrollment stays OFF, untouched.
// Lead source is attributed to the PERSON, never the appointment (decision
// 10): a new lead takes Routemize's own leadSource (fallback 'routemize');
// an existing lead's source is filled only if blank, never overwritten.
// contact.contactId lands on the matched/created lead (else customer) in the
// nullable routemize_contact_id column, tolerated as absent pre-migration
// (landmine 8, same posture as the name_aliases guard).
//   - Rep mapping (decision 5): assigned_member_email -> google_email, else
//     assigned_member_name -> name, both case-insensitive; no match leaves
//     the appointment unassigned and notes it in the internal notes.
//   - NEW lead-linked appointments get the SAME lead-side state as an in-app
//     booking via apptBookingLeadEffects (stage new->contacted for on-site
//     estimates + stage_change lead_event + nurture-drip pause) and a staff
//     bell row, then a best-effort runApptReminders kick so the consented
//     customer confirmation goes out now (the 15-min runner is the safety
//     net). None of these can turn a good intake into a non-200: Zapier
//     retries non-200s, and a retried side effect is worse than a late one.
//   - Every attempt writes pec_webhook_ingest_log (endpoint 'appt-intake')
//     so the Sync Health view can answer "did the Zap fire?".

const { sb, json, badSecret, logIngest } = require('./_pec-supabase.cjs');
const { pushApptById } = require('./_pec-appt-push.cjs');
const { enrollLead } = require('./_pec-drip.cjs');
const { runApptReminders, apptBookingLeadEffects, apptCancelLeadEffects, apptDateStr, apptTimeStr } = require('./_pec-appt.cjs');
const { sameHumanOr, resolveOrCreateCustomer } = require('./_pec-lead-match.cjs');
const { resolveLeadSourceName } = require('./_pec-lead-source.cjs');

const ENDPOINT = 'appt-intake';
const APPT_TYPES = ['on_site_estimate', 'project_walkthrough', 'site_visit', 'other'];
const TYPE_LABELS = {
  on_site_estimate: 'On-site estimate',
  project_walkthrough: 'Project walkthrough',
  site_visit: 'Site visit',
  other: 'Appointment',
};
// Loose labels Zapier might pass before anyone maps the field properly.
const TYPE_ALIASES = {
  estimate: 'on_site_estimate', onsite_estimate: 'on_site_estimate', on_site: 'on_site_estimate',
  walkthrough: 'project_walkthrough', project_walk_through: 'project_walkthrough',
};
const DEFAULT_DURATION_MS = 60 * 60000;

function cleanStr(s) {
  const out = String(s == null ? '' : s).trim();
  return out || null;
}

// Last 10 digits, so '+1 (928) 555-1212' and '9285551212' match (the same
// normalization pec-lead-intake writes into leads.phone).
function normPhone(s) {
  const d = String(s == null ? '' : s).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : (d || null);
}

function normApptType(s) {
  const k = String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (APPT_TYPES.includes(k)) return k;
  if (TYPE_ALIASES[k]) return TYPE_ALIASES[k];
  return 'on_site_estimate'; // decision 6: these are booked estimate visits
}

// Datetime contract: an explicit offset (or Z) is trusted; a BARE datetime or
// date is Phoenix wall clock at the project's fixed -07:00 (same convention as
// pec-appt-sync-push). Returns a UTC ISO string or null if unparseable.
function parseApptDate(s) {
  const str = cleanStr(s);
  if (!str) return null;
  if (/(z|[+-]\d{2}:?\d{2})$/i.test(str)) {
    const d = new Date(str);
    return isNaN(d) ? null : d.toISOString();
  }
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, '0')}:${m[5]}:${m[6] || '00'}-07:00`);
    return isNaN(d) ? null : d.toISOString();
  }
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00-07:00`).toISOString();
  const d = new Date(str); // last resort for oddball Zapier formats
  return isNaN(d) ? null : d.toISOString();
}

// Email candidates (in order, all case-insensitive against google_email),
// else exact name (case-insensitive); no match -> null (lands unassigned,
// noted in notes). Accepts a single email or an ordered array: the Routemize
// adapter tries assignedUsers[0].userName BEFORE .email (prompt 56 decision
// 2: on the real sample userName held the work address).
async function resolveSalesMember(db, memberEmails, memberName) {
  const emails = (Array.isArray(memberEmails) ? memberEmails : [memberEmails])
    .map(cleanStr).filter(Boolean);
  if (!emails.length && !memberName) return null;
  const rows = await db('GET', '/pec_sales_team_members?select=id,name,google_email');
  const members = Array.isArray(rows) ? rows : [];
  for (const e of emails) {
    const hit = members.find(m => String(m.google_email || '').toLowerCase() === e.toLowerCase());
    if (hit) return hit;
  }
  const lcName = memberName ? memberName.toLowerCase() : null;
  if (lcName) {
    const hit = members.find(m => String(m.name || '').trim().toLowerCase() === lcName);
    if (hit) return hit;
  }
  return null;
}

// Decision 3: link, never create. Live lead by last-10 phone / email first
// (the pec-lead-intake dedupe query without its recency window: an old lead
// booking an estimate is exactly the linkage we want); else a customer by the
// same keys; else nothing.
async function resolveContact(db, phone10, email) {
  const out = { lead_id: null, customer_id: null };
  const or = sameHumanOr(phone10, email); // ONE matching rule, shared with pec-lead-intake
  if (!or) return out;
  const leads = await db('GET',
    `/leads?or=(${or})&deleted_at=is.null&select=id,customer_id&order=created_at.desc&limit=1`);
  if (Array.isArray(leads) && leads.length) {
    out.lead_id = leads[0].id;
    out.customer_id = leads[0].customer_id || null;
    return out;
  }
  const customers = await db('GET',
    `/customers?or=(${or})&archived_at=is.null&select=id&order=created_at.desc&limit=1`);
  if (Array.isArray(customers) && customers.length) out.customer_id = customers[0].id;
  return out;
}

// ---------------------------------------------------------------------------
// Routemize native-webhook adapter (prompt 56). Routemize's Custom Webhook
// posts its own envelope; everything below translates it onto the hand-rolled
// contract so ONE flow handles both shapes.
// ---------------------------------------------------------------------------

// eventType casing is NOT consistent (landmine 4: real events are PascalCase
// 'AppointmentCreated', the synthetic test event was dotted 'test.webhook'),
// so strip non-alphanumerics and lowercase before matching.
function normalizeEventType(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
const NATIVE_EVENT_ACTIONS = {
  appointmentcreated: 'created',
  appointmentupdated: 'updated',
  appointmentcancelled: 'canceled', // Routemize's spelling
  appointmentcanceled: 'canceled',
  appointmentdeleted: 'deleted',
  appointmentstatuschanged: 'status_changed', // resolved from the payload below
};

// Lead-source slug in the house vocabulary ('meta', 'google_lsa', ...).
function slugSource(s) {
  const k = String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return k || null;
}

// Some fields ('AppointmentId', 'AppointmentNotes') live in a nested
// PascalCase template block whose exact key is not pinned down; check the top
// level, then one level of nested objects. Never deeper: a bounded search
// cannot be fooled into scanning a pathological payload.
function findNestedKey(data, key) {
  if (data == null || typeof data !== 'object') return null;
  if (data[key] != null) return data[key];
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v[key] != null) return v[key];
  }
  return null;
}

// AppointmentStatusChanged's payload shape is UNVERIFIED (landmine 5): read
// the status from the likely candidates, never depend on one silently.
// Prompt 95: live AppointmentUpdated events carry newStatus as a JSON NUMBER
// (1 = scheduled, 3 = cancelled), so numbers are stringified, not skipped.
const STATUS_FIELD_CANDIDATES = [
  'status', 'newStatus', 'appointmentStatus', 'statusName', 'statusText',
  'Status', 'NewStatus', 'AppointmentStatus', 'StatusName',
];
function readRoutemizeStatus(data) {
  for (const k of STATUS_FIELD_CANDIDATES) {
    const v = findNestedKey(data, k);
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && isFinite(v)) return String(v);
  }
  return null;
}

// Prompt 95 Part A: AppointmentUpdated carries newStartTime/newEndTime where
// Created carries startTime/endTime. new* wins; old* is NEVER read (those are
// the pre-change values and would rewrite the appointment backwards).
const START_FIELD_CANDIDATES = ['newStartTime', 'startTime'];
const END_FIELD_CANDIDATES = ['newEndTime', 'endTime'];
function readRoutemizeTime(data, candidates) {
  for (const k of candidates) {
    const v = data[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

// A BARE Routemize datetime is UTC with the Z dropped, NOT Phoenix wall clock
// (proven live: Jay McCoy's update carried newStartTime 2026-07-31T16:15:00
// while Routemize's own notificationVariables read 9:15 AM Phoenix = 16:15Z).
// parseApptDate's bare-datetime branch is the Phoenix convention for the
// hand-rolled contract and must not change, so the Z is appended HERE, on the
// native path only. Only strings with a time component are touched; a bare
// date (never observed from Routemize) falls through to parseApptDate as-is.
function normalizeRoutemizeUtc(s) {
  const str = cleanStr(s);
  if (!str) return null;
  if (/(z|[+-]\d{2}:?\d{2})$/i.test(str)) return str;
  return /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(str) ? str + 'Z' : str;
}

// Routemize's own Phoenix wall-clock rendering of the appointment time
// (notificationVariables.AppointmentDate "Aug 14, 2026" + .AppointmentTime
// "9:15 AM"), parsed to a UTC instant at the fixed -07:00 so Part A's
// cross-check can compare it against what we parsed from newStartTime.
// Null when either piece is missing or unreadable.
const RZ_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseNotificationWallClock(dateStr, timeStr) {
  const dm = String(dateStr || '').trim().match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})$/);
  const tm = String(timeStr || '').trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!dm || !tm) return null;
  const mon = RZ_MONTHS[dm[1].slice(0, 3).toLowerCase()];
  if (mon == null) return null;
  let h = Number(tm[1]) % 12;
  if (/^pm$/i.test(tm[3])) h += 12;
  const d = new Date(Date.UTC(Number(dm[3]), mon, Number(dm[2]), h + 7, Number(tm[2])));
  return isNaN(d) ? null : d.toISOString();
}

// Prompt 95 Part B: numeric status code -> appointment status, tunable from
// Settings (rule 12: a new Routemize status code is a Settings edit, not a
// deploy; the control sits behind Advanced on the Appointments card). A
// missing or broken setting falls back to the shipped default rather than an
// empty map: an empty map would silently turn every coded cancel back into
// an update.
const ROUTEMIZE_STATUS_MAP_KEY = 'routemize_status_map';
const DEFAULT_ROUTEMIZE_STATUS_MAP = { '1': 'scheduled', '2': 'scheduled', '3': 'canceled' };
const APPT_STATUSES = ['scheduled', 'completed', 'canceled'];
async function getRoutemizeStatusMap(db) {
  try {
    const rows = await db('GET', `/settings?key=eq.${ROUTEMIZE_STATUS_MAP_KEY}&select=value&limit=1`);
    const raw = Array.isArray(rows) && rows[0] ? rows[0].value : null;
    const parsed = raw ? JSON.parse(raw) : null;
    const out = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (APPT_STATUSES.includes(v)) out[String(k).trim().toLowerCase()] = v;
      }
    }
    if (Object.keys(out).length) return out;
  } catch (_) { /* fall through to the default */ }
  return DEFAULT_ROUTEMIZE_STATUS_MAP;
}

// serviceName/eventTypeId -> appt_type map, tunable from Settings (standing
// rule 12: adding a Routemize service is a Settings edit, not a deploy).
// Value is JSON text like {"estimate":"on_site_estimate"}; keys are matched
// lowercased against serviceName first, then eventTypeId. Anything unmapped
// (or a missing/broken setting) defaults to on_site_estimate (decision 5).
const ROUTEMIZE_TYPE_MAP_KEY = 'routemize_service_type_map';
async function getRoutemizeTypeMap(db) {
  try {
    const rows = await db('GET', `/settings?key=eq.${ROUTEMIZE_TYPE_MAP_KEY}&select=value&limit=1`);
    const raw = Array.isArray(rows) && rows[0] ? rows[0].value : null;
    const parsed = raw ? JSON.parse(raw) : null;
    const out = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (APPT_TYPES.includes(v)) out[String(k).trim().toLowerCase()] = v;
      }
    }
    return out;
  } catch (_) {
    return {}; // bad JSON / missing setting or table: everything defaults
  }
}

// questionId -> route map (prompt 73 Part A), tunable from Settings >
// Appointments (rule 12: a new Routemize question is a settings edit, never a
// deploy). Value is JSON text like {"<questionId>":"internal"}; routes are
// 'customer' (customer-facing note), 'internal' (rep-only notes), 'drop'.
// Anything unmapped (or a missing/broken setting) routes 'customer',
// preserving pre-73 behavior rather than silently discarding something a
// customer wrote.
const ROUTEMIZE_ANSWER_ROUTING_KEY = 'routemize_answer_routing';
const ANSWER_ROUTES = ['customer', 'internal', 'drop'];
async function getRoutemizeAnswerRouting(db) {
  try {
    const rows = await db('GET', `/settings?key=eq.${ROUTEMIZE_ANSWER_ROUTING_KEY}&select=value&limit=1`);
    const raw = Array.isArray(rows) && rows[0] ? rows[0].value : null;
    const parsed = raw ? JSON.parse(raw) : null;
    const out = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (ANSWER_ROUTES.includes(v)) out[String(k).trim().toLowerCase()] = v;
      }
    }
    return out;
  } catch (_) {
    return {}; // bad JSON / missing setting or table: everything routes customer
  }
}

// Routemize sends a question UUID where question text belongs (observed live
// 2026-08-03), and customer_notes ends up in every customer-facing
// confirmation/reminder on both channels, so an ID-shaped question key must
// never survive into the note. Conservative on purpose: only a key that is
// clearly not human text is dropped; a real question like "What's the
// project?" keeps the "Question: answer" shape.
function isIdLikeQuestionKey(q) {
  const s = String(q || '').trim();
  if (!s) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  // Opaque token: one long space-free run of id-ish characters with at least
  // one digit. A long plain word ("Approximately…") has no digit and stays.
  return !/\s/.test(s) && s.length >= 16 && /^[0-9a-z_-]+$/i.test(s) && /\d/.test(s);
}

// customerAnswers -> TWO streams (prompt 73 Part A): customer-facing note
// lines and internal (rep-only) lines. Routing matches questionId first,
// falling back to the question field when questionId is absent (identical on
// every envelope observed, but never assumed). Per stream:
//   customer: when the question key is an ID, the line is just the answer (no
//     prefix, no placeholder); a real question keeps "Question: answer"; a
//     missing question keeps the bare answer; an empty answer drops the line.
//   internal: "Service requested: <answer>" (the picker value still reaches
//     the rep; it just stops riding customer-facing reminders).
//   drop: discarded.
function mapCustomerAnswers(list, routing = {}) {
  const out = { customer: [], internal: [] };
  for (const a of (Array.isArray(list) ? list : [])) {
    if (!a || typeof a !== 'object') continue;
    const q = cleanStr(a.question);
    const qid = cleanStr(a.questionId);
    const ans = cleanStr(a.answer);
    if (!ans) continue;
    const route = (qid && routing[qid.toLowerCase()]) || (q && routing[q.toLowerCase()]) || 'customer';
    if (route === 'drop') continue;
    if (route === 'internal') { out.internal.push(`Service requested: ${ans}`); continue; }
    out.customer.push((q && !isIdLikeQuestionKey(q)) ? `${q}: ${ans}` : ans);
  }
  return out;
}

// Envelope -> hand-rolled contract. Returns { recognized: false } for any
// eventType we do not handle (the caller answers 200 no-op: Routemize retries
// non-2xx and tracks webhook health, so an unknown event must never 4xx), or
// { recognized: true, body, rz } where body is the mapped contract and rz
// carries the native-only extras (contact id, lead source, rep candidates).
async function mapRoutemizeEnvelope(db, env) {
  let action = NATIVE_EVENT_ACTIONS[normalizeEventType(env.eventType)];
  if (!action) return { recognized: false };

  const data = (env.data && typeof env.data === 'object') ? env.data : {};
  const contact = (data.contact && typeof data.contact === 'object') ? data.contact : {};
  const address = (data.address && typeof data.address === 'object') ? data.address : {};
  const nv = (data.notificationVariables && typeof data.notificationVariables === 'object')
    ? data.notificationVariables : {};
  const assigned = (Array.isArray(data.assignedUsers) && data.assignedUsers[0] && typeof data.assignedUsers[0] === 'object')
    ? data.assignedUsers[0] : {};

  // Cancel detection is the union of three signals (prompt 95, locked
  // decision 3): the settings-mapped numeric status says canceled, OR the
  // status text matches /cancel/i, OR data.reason does. Any one is enough.
  // Applied to AppointmentUpdated too, not just StatusChanged: a live
  // cancellation arrives as an Updated with newStatus 3 (Rob Rudman,
  // 2026-08-10), and before this it only landed because a separate
  // AppointmentCancelled happened to follow three seconds later. An unknown
  // or unmapped status stays an update and NEVER cancels (prompt 56
  // decision 3 stands). The separate Cancelled/Deleted events keep working
  // unchanged (belt and braces).
  let statusNote = null;
  let mappedStatus = null;
  if (action === 'status_changed' || action === 'updated') {
    const status = readRoutemizeStatus(data);
    const reason = cleanStr(data.reason);
    if (status) {
      const statusMap = await getRoutemizeStatusMap(db);
      mappedStatus = statusMap[status.toLowerCase()] || null;
    }
    const cancelish = mappedStatus === 'canceled'
      || (status && /cancel/i.test(status))
      || (reason && /cancel/i.test(reason));
    if (cancelish) {
      action = 'canceled';
    } else if (action === 'status_changed') {
      action = 'updated';
      statusNote = status
        ? `Routemize status changed to "${status}".`
        : 'Routemize sent a status change with no readable status; treated as an update.';
    }
  }

  // relatedEntityId is the appointment id (mirrored as AppointmentId in the
  // nested block). A relatedEntityId typed as some OTHER entity is not our key.
  let rmId = cleanStr(data.relatedEntityId);
  const ret = cleanStr(data.relatedEntityType);
  if (rmId && ret && ret.toLowerCase() !== 'appointment') rmId = null;
  if (!rmId) rmId = cleanStr(findNestedKey(data, 'AppointmentId'));

  const firstName = cleanStr(contact.firstName);
  const lastName = cleanStr(contact.lastName);
  // Prompt 62 Part B: an incoming company / business / organization field
  // maps onto leads.business_name (created leads only; matching is untouched).
  const businessName = cleanStr(contact.companyName) || cleanStr(contact.company)
    || cleanStr(contact.businessName) || cleanStr(contact.organization);
  const customerName = cleanStr(data.contactName)
    || (firstName ? `${firstName}${lastName ? ' ' + lastName : ''}` : null)
    || businessName;

  // appt_type via the settings map; serviceName wins, eventTypeId is the
  // secondary key (decision 5).
  const serviceName = cleanStr(data.serviceName);
  const typeMap = await getRoutemizeTypeMap(db);
  const apptType = (serviceName && typeMap[serviceName.toLowerCase()])
    || (cleanStr(data.eventTypeId) && typeMap[cleanStr(data.eventTypeId).toLowerCase()])
    || 'on_site_estimate';

  // Our own title, in the ONE unified auto-title format (prompt 89):
  // "{Type label} for {Name}", e.g. "On-site estimate for John Courtis".
  // Routemize's appointmentTitle ("Meeting with - John") stays ignored, and
  // serviceName no longer rides the title (it maps appt_type via the
  // settings map above, and the raw picker value still reaches the rep
  // through the internal notes). Shows on the TopCoat calendar, the Google
  // event, and the modal. Customer-facing-safe wording: no em dashes.
  const title = customerName ? `${TYPE_LABELS[apptType]} for ${customerName}` : null;

  // customerAnswers routed by questionId (prompt 73 Part A): 'customer'
  // answers become the customer-facing Job notes (decision 4: the customer
  // wrote them; the send path scrubs em dashes), 'internal' answers ride the
  // rep-only notes below, 'drop' vanishes. Unmapped routes 'customer'.
  const answers = mapCustomerAnswers(data.customerAnswers, await getRoutemizeAnswerRouting(db));

  const addr = [cleanStr(address.addressLine1), cleanStr(address.addressLine2)].filter(Boolean).join(', ');

  // Internal-note candidates: the nested AppointmentNotes plus the
  // update-path names projectDetail and notes (prompt 95 Part C). Deduped:
  // Routemize mirrors the same text across fields on some events, and the
  // rep does not need it twice.
  const noteCandidates = [
    cleanStr(findNestedKey(data, 'AppointmentNotes')),
    cleanStr(data.projectDetail),
    cleanStr(data.notes),
  ].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);

  const body = {
    action,
    routemize_appt_id: rmId,
    appt_type: apptType,
    title,
    // Candidate order newStartTime -> startTime (never old*), normalized so a
    // bare Routemize datetime reads as the UTC it actually is; parseApptDate
    // then takes its trusted-offset path, and the Phoenix bare-datetime
    // branch never runs on the native path.
    start_at: normalizeRoutemizeUtc(readRoutemizeTime(data, START_FIELD_CANDIDATES)),
    end_at: normalizeRoutemizeUtc(readRoutemizeTime(data, END_FIELD_CANDIDATES)),
    customer_name: customerName,
    phone: contact.phoneNumber,
    email: contact.email,
    address: addr || null,
    city: address.city,
    state: address.state,
    zip: address.zipCode,
    // First non-empty candidate doubles as the contract field so the
    // unmatched-rep note names something useful.
    assigned_member_email: cleanStr(assigned.userName) || cleanStr(assigned.email),
    assigned_member_name: cleanStr(assigned.firstName)
      ? `${cleanStr(assigned.firstName)}${cleanStr(assigned.lastName) ? ' ' + cleanStr(assigned.lastName) : ''}`
      : null,
    // Internal answers (the service picker) append after the note fields so
    // the rep still sees them; they just never reach a customer message.
    notes: [...noteCandidates, ...answers.internal].filter(Boolean).join('\n') || null,
    // Null, never '' when nothing routes to the customer: _pec-appt.cjs trims
    // and skips falsy, but the column is nullable and null is the honest value.
    customer_notes: answers.customer.length ? answers.customer.join('\n') : null,
  };

  const rz = {
    native: true,
    contactId: cleanStr(contact.contactId),
    firstName,
    lastName,
    businessName,
    // leadSourceText is the meaningful value when leadSource is a bucket
    // ("Other"/"Google" on the real sample); fall back to 'routemize' when
    // Routemize sends nothing (decision 10).
    leadSource: slugSource(cleanStr(contact.leadSourceText) || cleanStr(contact.leadSource)) || 'routemize',
    memberEmails: [cleanStr(assigned.userName), cleanStr(assigned.email)].filter(Boolean),
    statusNote,
    mappedStatus,
    // Part A cross-check inputs: Routemize's own Phoenix rendering of the
    // appointment time, both as a comparable instant and as display text.
    wallClockIso: parseNotificationWallClock(nv.AppointmentDate, nv.AppointmentTime),
    wallClockText: (cleanStr(nv.AppointmentDate) && cleanStr(nv.AppointmentTime))
      ? `${cleanStr(nv.AppointmentDate)} ${cleanStr(nv.AppointmentTime)}` : null,
  };
  return { recognized: true, body, rz };
}

// Prompt 97: kick the per-lead AI score for a lead this intake just created.
// Same contract as pec-lead-intake's triggerLeadAi: its own Netlify
// invocation, server-to-server with x-webhook-secret, awaited only until the
// request has LEFT this lambda (a truly-detached promise can be frozen when
// the lambda returns), and every failure path is a console.warn. A slow or
// failed score must NEVER turn a good appointment intake into a non-200:
// Routemize retries non-2xx, and a retried intake is worse than an unscored
// lead (the nightly pec-lead-score-runner catches those anyway).
const AI_TRIGGER_WAIT_MS = 2500;
async function kickLeadAi(leadId) {
  try {
    const base = process.env.URL || 'https://prescottepoxy.netlify.app';
    const req = fetch(`${base}/.netlify/functions/pec-lead-ai`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': process.env.PEC_WEBHOOK_SECRET || '',
      },
      body: JSON.stringify({ lead_id: leadId }),
    }).then(
      (res) => { if (!res.ok) console.warn(`pec-appt-intake: AI trigger returned ${res.status} for lead ${leadId}`); },
      (err) => { console.warn('pec-appt-intake: AI trigger failed:', err && err.message); }
    );
    const timeout = new Promise((resolve) => setTimeout(resolve, AI_TRIGGER_WAIT_MS));
    await Promise.race([req, timeout]);
  } catch (err) {
    console.warn('pec-appt-intake: AI trigger threw:', err && err.message);
  }
}

// Decision 9 (native path only): create the lead a direct Routemize booker
// never became. Stage 'new' + a 'created' lead_event; apptBookingLeadEffects
// does the stage advance afterwards, exactly like an in-app booking.
// DELIBERATELY NOT nurture-enrolled (landmine 3); the AI score kick happens
// at the call site (prompt 97, injectable for tests). Best-effort:
// a failed create lands the appointment unlinked with the contact noted, it
// never turns a good intake into a non-200.
async function createRoutemizeLead(db, args) {
  // Customers are the source of truth (prompt 89): resolve-or-create the
  // customer row FIRST so the lead is born linked. The caller only reaches
  // here when resolveContact matched neither lead nor customer, so this is
  // nearly always a create; the helper still re-matches for safety. A
  // failure leaves customer_id null rather than losing the lead.
  let customerId = null;
  try {
    const c = await resolveOrCreateCustomer(db, {
      name: args.customerName, firstName: args.firstName, lastName: args.lastName,
      businessName: args.businessName, phone10: args.phone10, email: args.email,
      address: args.address, city: args.city, state: args.state, zip: args.zip,
      source: args.source, brand: 'PEC',
    });
    customerId = c.customer_id;
  } catch (e) {
    console.warn('pec-appt-intake: customer resolve for new lead failed (non-fatal):', e && e.message);
  }
  const base = {
    brand: 'PEC', // decision 7: FTP does not use Routemize
    customer_id: customerId,
    source: args.source,
    source_ref: args.contactId || null,
    first_name: args.firstName || (args.customerName ? args.customerName.split(' ')[0] : null),
    last_name: args.lastName || (args.customerName && args.customerName.includes(' ')
      ? args.customerName.split(' ').slice(1).join(' ') : null),
    business_name: args.businessName || null,
    full_name: args.customerName,
    email: args.email,
    phone: args.phone10 || null,
    address: args.address, city: args.city, state: args.state, zip: args.zip,
    stage: 'new',
    sms_consent: false, // TCPA: consent is never inferred from a booking
  };
  let rows;
  try {
    rows = await db('POST', '/leads', { ...base, routemize_contact_id: args.contactId || null }, true);
  } catch (err) {
    // Pre-migration (landmine 8): the column is not there yet; the lead
    // still gets created without it.
    if (/routemize_contact_id/i.test(String(err && err.message))) {
      rows = await db('POST', '/leads', base, true);
    } else throw err;
  }
  const lead = Array.isArray(rows) && rows[0];
  if (!lead) throw new Error('lead insert returned no row');
  await db('POST', '/lead_events', {
    lead_id: lead.id,
    event_type: 'created',
    to_stage: 'new',
    payload: { source: args.source, via: 'routemize_booking', routemize_appt_id: args.rmId },
  }).catch(e => console.warn('pec-appt-intake: created lead_event failed (non-fatal):', e && e.message));
  return lead;
}

// Store contact.contactId on the matched/created lead or customer (decision
// 12). Fill-if-blank (the guard doubles as idempotency) and tolerant of the
// column not existing yet (landmine 8): the PATCH just fails quietly until
// Cowork applies the migration.
async function storeRoutemizeContactId(db, table, id, contactId) {
  if (!id || !contactId) return;
  try {
    await db('PATCH',
      `/${table}?id=eq.${encodeURIComponent(id)}&routemize_contact_id=is.null`,
      { routemize_contact_id: contactId });
  } catch (e) {
    console.warn(`pec-appt-intake: routemize_contact_id store on ${table} skipped (pre-migration?):`, e && e.message);
  }
}

// Staff bell for a Routemize booking: the in-app path goes through the
// log_appointment_booked RPC (client JS cannot insert pec_notifications under
// RLS); the service role writes the same row shape directly.
async function notifyBell(db, appt, salesName) {
  const when = `${apptDateStr(appt.start_at)} at ${apptTimeStr(appt.start_at)}`;
  await db('POST', '/pec_notifications', {
    type: 'appointment_booked',
    // Auto-titles already read "On-site estimate for Jane Doe" (prompt 89),
    // so the rep rides an "assigned to" clause, not a second "for".
    body: `Routemize booked ${appt.title || TYPE_LABELS[appt.appt_type] || 'an appointment'}`
      + (salesName ? `, assigned to ${salesName}` : '') + ` (${when})`,
    target_view: 'appointments',
    target_id: appt.id,
  });
}

// Prompt 95 Part D: the "this event landed but was not applied" bell. Fires
// beside the ingest-log write for the three not-applied families (no readable
// start time, time cross-check mismatch, blocked resurrection), so each
// qualifying log row bells exactly once. target_view 'ops' lands the click on
// the Ops Queue, whose appt_intake_not_applied derived check shows the
// detail. Best-effort like every side effect here.
async function notifyIntakeStalled(db, text) {
  try {
    await db('POST', '/pec_notifications', {
      type: 'appt_intake_stalled',
      body: text,
      target_view: 'ops',
    });
  } catch (e) {
    console.warn('pec-appt-intake: stalled bell failed (non-fatal):', e && e.message);
  }
}

// The whole behavior with injectable deps ({ sb, logIngest, runReminders,
// now }) so the fixture test drives the REAL flow against the mini-PostgREST.
// Returns { status, body }; the handler wraps it in json().
async function processApptIntake(deps, body) {
  const db = deps.sb;
  const log = deps.logIngest || logIngest;
  const runReminders = deps.runReminders || ((d, o) => runApptReminders(d, o));
  const now = deps.now ? deps.now() : new Date();
  // Google push kick (prompt 88): for A MONTH this intake wrote appointments
  // that never reached Google, because the push only ever ran off the
  // dashboard's client-side apptPostWrite kick and nothing here called it.
  // Same contract as that client kick: best-effort, a push failure never
  // fails the intake response (Routemize retries non-2xx, and a retried
  // intake is worse than an unsynced row; the row keeps google_event_id null
  // and the next write or the backfill re-pushes). Awaited, not detached: a
  // lambda may freeze the instant the response returns, so truly-detached
  // work can silently never run. Injectable so the fixture test can observe
  // it; the default is also test-safe (pushApptById no-ops while
  // GOOGLE_OAUTH_CLIENT_ID/SECRET are unset, which they are under node).
  const kickPush = deps.kickPush || (async (id) => {
    try { await pushApptById(db, id); }
    catch (e) { console.warn('pec-appt-intake: google push kick failed (non-fatal):', e && e.message || e); }
  });

  // The ingest log must show what Routemize ACTUALLY sent, not our mapping.
  const rawPayload = body;

  // Auto-detect the Routemize native envelope (decision 1): eventType AND a
  // data object mean native; anything else falls through to the hand-rolled
  // contract untouched. An unrecognized eventType (including the synthetic
  // 'test.webhook') is a 200 no-op, never a 4xx (landmines 4 and 6).
  let rz = null;
  if (body && typeof body.eventType === 'string' && body.data && typeof body.data === 'object') {
    const mapped = await mapRoutemizeEnvelope(db, body);
    if (!mapped.recognized) {
      await log({ endpoint: ENDPOINT, deal_id: null, customer_name: null, outcome: 'ok', status_code: 200, message: `routemize: ignored eventType '${body.eventType}' (no-op)`, payload: rawPayload });
      return { status: 200, body: { success: true, ignored: true, event_type: body.eventType } };
    }
    rz = mapped.rz;
    body = mapped.body;
  }

  const action = cleanStr(body.action) || 'created';
  const rmId = cleanStr(body.routemize_appt_id);
  const customerName = cleanStr(body.customer_name);

  if (!['created', 'updated', 'canceled', 'deleted'].includes(action)) {
    await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'rejected', status_code: 400, message: `unknown action '${action}'`, payload: rawPayload });
    return { status: 400, body: { success: false, error: `unknown action '${action}'` } };
  }
  if (!rmId) {
    await log({ endpoint: ENDPOINT, deal_id: null, customer_name: customerName, outcome: 'rejected', status_code: 400, message: 'routemize_appt_id is required', payload: rawPayload });
    return { status: 400, body: { success: false, error: 'routemize_appt_id is required' } };
  }

  try {
    // ---- canceled / deleted: same outcome by locked decision 2 -------------
    if (action === 'canceled' || action === 'deleted') {
      const rows = await db('GET', `/pec_appointments?routemize_appt_id=eq.${encodeURIComponent(rmId)}&select=id,status,lead_id,appt_type,source&limit=1`);
      const appt = Array.isArray(rows) && rows[0];
      if (!appt) {
        await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'ok', status_code: 200, message: `${action}: no matching appointment (no-op)`, payload: rawPayload });
        return { status: 200, body: { success: true, matched: false } };
      }
      await db('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(appt.id)}`, { status: 'canceled' });
      // Off the canceled status, the push deletes the Google event and
      // clears the row's mapping (no-op if it never synced).
      await kickPush(appt.id);
      // Walk an estimate_scheduled lead back to contacted (unless another
      // scheduled on-site estimate remains). Best-effort; never throws.
      await apptCancelLeadEffects(db, appt);
      // Prompt 73 Part F2: a canceled/no-showed booking is the ONE case a
      // previously-booked lead belongs in nurture (decision 2's other half).
      // A normal enrollment starting at step 1, never the day-0 instant
      // touch: a cancellation is not a fresh inquiry, and a "thanks for
      // reaching out" auto-reply here would read as broken. Guards: skip on a
      // remaining live appointment (a reschedule is not a fall-through), and
      // only nurture-able stages (new/contacted, which is where
      // apptCancelLeadEffects just put a fallen-through lead); enrollSubject
      // itself refuses archived leads and the runner's kill-switches re-check
      // opt-out at send time. Best-effort like every side effect here.
      let reEnrolled = false;
      if (appt.lead_id) {
        try {
          const others = await db('GET',
            `/pec_appointments?lead_id=eq.${encodeURIComponent(appt.lead_id)}&status=eq.scheduled&id=neq.${encodeURIComponent(appt.id)}&select=id&limit=1`);
          if (!Array.isArray(others) || !others.length) {
            const lrows = await db('GET', `/leads?id=eq.${encodeURIComponent(appt.lead_id)}&select=stage,opted_out,archived_at,deleted_at&limit=1`);
            const lead = Array.isArray(lrows) ? lrows[0] : null;
            if (lead && !lead.deleted_at && !lead.archived_at && !lead.opted_out
              && ['new', 'contacted'].includes(lead.stage)) {
              const enr = await enrollLead(db, appt.lead_id, new Date(), { minStepIndex: 1 });
              reEnrolled = !!enr.enrolled;
              if (!enr.enrolled && enr.reason && enr.reason !== 'already_active') {
                console.warn('pec-appt-intake: cancel re-enroll skipped:', enr.reason);
              }
            }
          }
        } catch (e) {
          console.warn('pec-appt-intake: cancel re-enroll failed (non-fatal):', e && e.message);
        }
      }
      await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'ok', status_code: 200, message: `${action}: appointment ${appt.id} canceled${reEnrolled ? '; lead re-enrolled in nurture (from step 1)' : ''}`, payload: rawPayload });
      return { status: 200, body: { success: true, canceled: true, appointment_id: appt.id, lead_re_enrolled: reEnrolled } };
    }

    // ---- created / updated -------------------------------------------------
    const startAt = parseApptDate(body.start_at);
    if (!startAt) {
      // Native events with no readable times: never a 4xx and NEVER a
      // cancellation. Append the status note to the matched row's internal
      // notes and answer 200; no row is a clean no-op. Since prompt 95 reads
      // newStartTime, this stopped being the normal AppointmentUpdated path
      // and is the floor for genuinely time-less events; each hit now raises
      // the Part D alarm so it can never be silent again.
      if (rz) {
        const rows = await db('GET', `/pec_appointments?routemize_appt_id=eq.${encodeURIComponent(rmId)}&select=id,notes&limit=1`);
        const appt = Array.isArray(rows) && rows[0];
        if (!appt) {
          await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'ok', status_code: 200, message: `${action}: no readable start time and no matching appointment (no-op)`, payload: rawPayload });
          return { status: 200, body: { success: true, matched: false } };
        }
        const noteAdd = rz.statusNote || `Routemize sent an ${action} event with no readable start time; appointment left as-is.`;
        await db('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(appt.id)}`,
          { notes: [cleanStr(appt.notes), noteAdd].filter(Boolean).join('\n') });
        await kickPush(appt.id); // notes ride the Google event description
        await notifyIntakeStalled(db, `Routemize sent an ${action}${customerName ? ` for ${customerName}` : ''} with no readable start time; the appointment was not changed.`);
        await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'ok', status_code: 200, message: `${action}: no readable start time; noted on appointment ${appt.id}`, payload: rawPayload });
        return { status: 200, body: { success: true, updated: true, appointment_id: appt.id } };
      }
      await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'rejected', status_code: 400, message: 'start_at is required (ISO 8601)', payload: rawPayload });
      return { status: 400, body: { success: false, error: 'start_at is required and must be a parseable datetime' } };
    }
    const endAt = parseApptDate(body.end_at) || new Date(new Date(startAt).getTime() + DEFAULT_DURATION_MS).toISOString();
    const apptType = normApptType(body.appt_type);
    const phone10 = normPhone(cleanStr(body.phone));
    const email = cleanStr(body.email) ? cleanStr(body.email).toLowerCase() : null;
    const memberEmail = cleanStr(body.assigned_member_email);
    const memberName = cleanStr(body.assigned_member_name);

    const [contact, member] = [
      await resolveContact(db, phone10, email),
      await resolveSalesMember(db, rz ? rz.memberEmails : memberEmail, memberName),
    ];

    // Routemize-native lead behavior (decisions 9/10/12; see the header
    // block). resolveContact just ran the shared same-human match with NO
    // window, strictly broader than lead-intake's 90-day dedupe, so a miss
    // here proves the windowed dedupe cannot hit either: creating is safe.
    // Prompt 61 Part D: Routemize's leadSource token maps to the managed
    // pec_lead_sources name here (both the create and the fill-when-null
    // paths). Mapping the value does NOT license overwriting an existing
    // source (prompt 56 decision 10 stands: fill only when null).
    const rzSource = rz ? await resolveLeadSourceName(db, rz.leadSource) : null;
    let leadCreated = false;
    if (rz && !contact.lead_id && !contact.customer_id && customerName && (phone10 || email)) {
      try {
        const lead = await createRoutemizeLead(db, {
          customerName, firstName: rz.firstName, lastName: rz.lastName,
          businessName: rz.businessName || null,
          phone10, email, source: rzSource, contactId: rz.contactId, rmId,
          address: cleanStr(body.address), city: cleanStr(body.city),
          state: cleanStr(body.state), zip: cleanStr(body.zip),
        });
        contact.lead_id = lead.id;
        contact.customer_id = lead.customer_id || null; // born linked (prompt 89)
        leadCreated = true;
        // Prompt 97: score the lead this booking just created (the door that
        // left 17 of 18 open leads unscored). Best-effort, never a non-200.
        await (deps.kickLeadAi || kickLeadAi)(lead.id);
      } catch (e) {
        // The appointment still lands (unlinked, contact noted below); a
        // non-200 here would just make Routemize retry a working intake.
        console.warn('pec-appt-intake: routemize lead create failed (non-fatal):', e && e.message);
      }
    }
    if (rz && contact.lead_id && !leadCreated) {
      // Existing lead: fill the source only if blank, NEVER overwrite
      // (decision 10: overwriting would rewrite marketing attribution).
      await db('PATCH', `/leads?id=eq.${encodeURIComponent(contact.lead_id)}&source=is.null`, { source: rzSource })
        .catch(e => console.warn('pec-appt-intake: lead source fill failed (non-fatal):', e && e.message));
    }
    if (rz) {
      if (contact.lead_id) await storeRoutemizeContactId(db, 'leads', contact.lead_id, rz.contactId);
      else if (contact.customer_id) await storeRoutemizeContactId(db, 'customers', contact.customer_id, rz.contactId);
    }

    // Internal notes: what the payload carried, plus anything a rep must act on
    // because we could not link it (unmatched contact keeps its phone here so
    // the appointment is still workable; unmatched rep is called out so
    // someone assigns it). Internal-only text, never customer-facing.
    const noteLines = [];
    if (cleanStr(body.notes)) noteLines.push(cleanStr(body.notes));
    if (rz && rz.statusNote) noteLines.push(rz.statusNote);
    if (!contact.lead_id && !contact.customer_id && (customerName || phone10 || email)) {
      noteLines.push('Routemize contact (no matching lead/customer): '
        + [customerName, phone10, email].filter(Boolean).join(' / '));
    }
    if (!member && (memberEmail || memberName)) {
      noteLines.push(`Routemize assigned rep not matched to the roster: ${memberEmail || memberName}`);
    }

    // Part A cross-check: never trust the parsed instant blindly. Every
    // Routemize envelope carries its own Phoenix wall-clock rendering; more
    // than a minute apart means a format was read wrong. Keep the parsed
    // value (the machine field is the system of record), name both readings
    // in the internal notes, and raise the Part D alarm. Never silently pick.
    // Alert lines APPEND to whatever notes the row ends up with, unlike the
    // payload-carried noteLines which replace on an update: losing our own
    // warning in a later rewrite would defeat its purpose.
    const alertLines = [];
    const timeMismatch = !!(rz && rz.wallClockIso
      && Math.abs(new Date(startAt).getTime() - new Date(rz.wallClockIso).getTime()) > 60000);
    if (timeMismatch) {
      alertLines.push(`Time cross-check mismatch: parsed ${startAt} but Routemize's own rendering says ${rz.wallClockText} Phoenix; kept the parsed value.`);
    }

    const existing = await db('GET', `/pec_appointments?routemize_appt_id=eq.${encodeURIComponent(rmId)}&select=*&limit=1`);
    const existingRow = Array.isArray(existing) && existing[0];

    // Part B: never resurrect a cancelled appointment. A cancel goes through
    // its own branch above, so an update never needs to CHANGE status at all;
    // status is stamped 'scheduled' only on a fresh insert. When Routemize
    // sends a live update for a row TopCoat has cancelled (out-of-order
    // delivery, or someone editing a dead booking), the other fields still
    // apply but the status stays canceled, with a note and the Part D alarm:
    // an un-cancel is rare enough to want a human, a silent resurrection on
    // the crew calendar is not acceptable.
    const resurrectionBlocked = !!(existingRow && existingRow.status === 'canceled');
    if (resurrectionBlocked) {
      alertLines.push('Routemize sent a live update for an appointment TopCoat has cancelled; status left canceled. Un-cancel it by hand if the booking is really back on.');
    }

    // Field set common to insert and update. Built only from what the payload
    // carries (an omitted optional field never nulls out a stored value), and
    // google_* is never in here: the existing push owns those columns.
    const fields = {
      appt_type: apptType,
      start_at: startAt,
      end_at: endAt,
      all_day: body.all_day === true,
    };
    // Auto-title (prompt 89): "{Type label} for {Name}". An explicit title
    // in the hand-rolled contract still wins (manual curls stay honest); the
    // Routemize adapter already passes the derived format through body.title.
    const title = cleanStr(body.title)
      || (customerName ? `${TYPE_LABELS[apptType]} for ${customerName}` : TYPE_LABELS[apptType]);
    if (cleanStr(body.title) || customerName || !existingRow) fields.title = title;
    if (cleanStr(body.address)) fields.location_address = cleanStr(body.address);
    if (cleanStr(body.city)) fields.location_city = cleanStr(body.city);
    if (cleanStr(body.state)) fields.location_state = cleanStr(body.state);
    if (cleanStr(body.zip)) fields.location_zip = cleanStr(body.zip);
    if (noteLines.length || !existingRow) fields.notes = noteLines.join('\n') || null;
    if (alertLines.length) {
      const base = ('notes' in fields) ? fields.notes : (existingRow ? cleanStr(existingRow.notes) : null);
      fields.notes = [cleanStr(base), ...alertLines].filter(Boolean).join('\n');
    }
    // Locked decision 2 (prompt 95): customer_notes rides every
    // customer-facing appointment text and email, so a Routemize edit may
    // rewrite it ONLY when the incoming customer-routed answers actually
    // differ from what is stored (the prompt-65 incident is why). Same-value
    // writes are skipped, so a formatting change in our own composition can
    // never re-push old answers at a customer.
    if (cleanStr(body.customer_notes)
      && (!existingRow || cleanStr(body.customer_notes) !== cleanStr(existingRow.customer_notes))) {
      fields.customer_notes = cleanStr(body.customer_notes);
    }
    if (member) fields.sales_member_id = member.id;

    if (existingRow) {
      // Update (or a 'created' retry). Linkage only fills gaps: a link a
      // staff member set by hand in TopCoat is never clobbered.
      if (!existingRow.lead_id && contact.lead_id) fields.lead_id = contact.lead_id;
      if (!existingRow.customer_id && contact.customer_id) fields.customer_id = contact.customer_id;
      const rescheduled = !!(existingRow.start_at
        && new Date(existingRow.start_at).getTime() !== new Date(startAt).getTime());
      await db('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(existingRow.id)}`, fields);
      await kickPush(existingRow.id);
      // Part C3: a reschedule leaves a trail, a lead-timeline note plus a
      // bell row. Deliberately NO customer confirmation re-fire (locked
      // decision 6): Routemize notifies the customer itself, and the
      // reminder runner picks up the new time on its own schedule; this is
      // why the update path never calls runReminders. Both best-effort.
      if (rescheduled) {
        const fromTxt = `${apptDateStr(existingRow.start_at)}, ${apptTimeStr(existingRow.start_at)}`;
        const toTxt = `${apptDateStr(startAt)}, ${apptTimeStr(startAt)}`;
        const leadId = fields.lead_id || existingRow.lead_id;
        if (leadId) {
          await db('POST', '/lead_events', {
            lead_id: leadId,
            event_type: 'note',
            payload: {
              text: `Rescheduled via Routemize: ${fromTxt} to ${toTxt}`,
              via: 'routemize_reschedule',
              appointment_id: existingRow.id,
            },
          }).catch(e => console.warn('pec-appt-intake: reschedule note event failed (non-fatal):', e && e.message));
        }
        await db('POST', '/pec_notifications', {
          type: 'appointment_rescheduled',
          body: `Routemize moved ${existingRow.title || TYPE_LABELS[apptType] || 'an appointment'} to ${toTxt} (was ${fromTxt})`,
          target_view: 'appointments',
          target_id: existingRow.id,
        }).catch(e => console.warn('pec-appt-intake: reschedule bell failed (non-fatal):', e && e.message));
      }
      const flags = [
        timeMismatch ? 'time cross-check mismatch' : null,
        resurrectionBlocked ? 'canceled appointment not resurrected' : null,
      ].filter(Boolean);
      if (flags.length) {
        await notifyIntakeStalled(db, `Routemize update${customerName ? ` for ${customerName}` : ''} needs a look: ${flags.join('; ')}.`);
      }
      await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'ok', status_code: 200, message: `${action}: appointment ${existingRow.id} updated${flags.length ? `; ${flags.join('; ')}` : ''}`, payload: rawPayload });
      return { status: 200, body: { success: true, updated: true, appointment_id: existingRow.id, lead_id: fields.lead_id || existingRow.lead_id || null } };
    }

    // Fresh insert.
    let inserted;
    try {
      inserted = await db('POST', '/pec_appointments', {
        ...fields,
        status: 'scheduled',
        routemize_appt_id: rmId,
        source: 'routemize',
        lead_id: contact.lead_id,
        customer_id: contact.customer_id,
        sales_member_id: member ? member.id : null,
      }, true);
    } catch (err) {
      // The partial unique index on routemize_appt_id: a concurrent Zap retry
      // beat us between the existence check and the insert. Its row is the
      // row; nothing to do.
      if (/409|23505|duplicate/i.test(String(err && err.message))) {
        await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'ok', status_code: 200, message: 'created: deduped on routemize_appt_id (concurrent retry)', payload: rawPayload });
        return { status: 200, body: { success: true, deduped: true } };
      }
      throw err;
    }
    const appt = inserted[0];

    // Landmine 2: a Routemize booking folding onto an EXISTING lead leaves a
    // timeline note (renders via the 'note' branch of leadEventHtml) so the
    // rep sees this person booked again. A CREATED lead already got its
    // 'created' event, and the stage advance below writes its own.
    if (rz && appt.lead_id && !leadCreated) {
      await db('POST', '/lead_events', {
        lead_id: appt.lead_id,
        event_type: 'note',
        payload: {
          text: `Booked via Routemize: ${appt.title || TYPE_LABELS[appt.appt_type] || 'appointment'}, ${apptDateStr(appt.start_at)} at ${apptTimeStr(appt.start_at)}`,
          via: 'routemize_booking',
          appointment_id: appt.id,
        },
      }).catch(e => console.warn('pec-appt-intake: booking note event failed (non-fatal):', e && e.message));
    }

    // Side effects, every one best-effort: the row is saved, and a caller
    // retrying a non-200 would re-run them, which is worse than missing one
    // (the 15-minute runner backstops the confirmation anyway).
    let effects = { staged: false, drip_stopped: 0 };
    if (appt.lead_id) {
      try { effects = await apptBookingLeadEffects(db, appt, { advanceStage: true, now: () => now }); }
      catch (e) { console.warn('pec-appt-intake: lead effects failed (non-fatal):', e && e.message); }
    }
    if (appt.lead_id || appt.customer_id) {
      try { await notifyBell(db, appt, member ? member.name : ''); }
      catch (e) { console.warn('pec-appt-intake: bell failed (non-fatal):', e && e.message); }
    }
    try { await runReminders({ sb: db }, { appointmentId: appt.id }); }
    catch (e) { console.warn('pec-appt-intake: confirmation kick failed (non-fatal):', e && e.message); }
    await kickPush(appt.id);

    if (timeMismatch) {
      await notifyIntakeStalled(db, `Routemize booking${customerName ? ` for ${customerName}` : ''} needs a look: time cross-check mismatch.`);
    }
    await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'ok', status_code: 200, message: `created: appointment ${appt.id}${appt.lead_id ? ` linked to lead ${appt.lead_id}` : ''}${member ? '' : (memberEmail || memberName ? ' (rep unmatched)' : '')}${timeMismatch ? '; time cross-check mismatch' : ''}`, payload: rawPayload });
    return {
      status: 200,
      body: {
        success: true, created: true, appointment_id: appt.id,
        lead_id: appt.lead_id, customer_id: appt.customer_id,
        sales_member_id: appt.sales_member_id,
        lead_effects: effects,
      },
    };
  } catch (err) {
    console.error('pec-appt-intake failed:', err);
    await log({ endpoint: ENDPOINT, deal_id: rmId, customer_name: customerName, outcome: 'error', status_code: 500, message: err && err.message, payload: rawPayload });
    return { status: 500, body: { success: false, error: 'Internal error ingesting appointment' } };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });
  if (badSecret(event)) return json(401, { success: false, error: 'Invalid webhook secret' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { success: false, error: 'Invalid JSON' }); }

  const out = await processApptIntake({ sb, logIngest }, body);
  return json(out.status, out.body);
};

// Exported for the fixture test (production/appt-intake.test.cjs).
exports.processApptIntake = processApptIntake;
exports.parseApptDate = parseApptDate;
exports.normApptType = normApptType;
exports.normalizeEventType = normalizeEventType;
exports.mapRoutemizeEnvelope = mapRoutemizeEnvelope;
exports.mapCustomerAnswers = mapCustomerAnswers;
exports.isIdLikeQuestionKey = isIdLikeQuestionKey;
exports.normalizeRoutemizeUtc = normalizeRoutemizeUtc;
exports.parseNotificationWallClock = parseNotificationWallClock;
