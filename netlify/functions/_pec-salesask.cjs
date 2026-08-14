// Shared helpers for the SalesAsk integration (pec-webhook-salesask.cjs +
// pec-salesask-sync.cjs). SalesAsk is the in-home sales recording/coaching
// app: we push upcoming appointments to it as "scheduled tasks" (event_id =
// our pec_appointments.id) and it sends recordings back, matched to that id.
// Partner API docs: https://docs.salesask.com — base integrations.salesask.com,
// org-scoped key in the x-api-key header (env SALESASK_API_KEY).
//
// Everything here is tolerant of payload-shape drift on purpose (same
// philosophy as pec-webhook-quo.cjs): SalesAsk's recording document differs
// slightly between the webhook payload and the REST GET, so extractors accept
// both shapes and unknown fields land in the `raw` jsonb column instead of
// being dropped.

const { sb } = require('./_pec-supabase.cjs');

const SALESASK_API_KEY = process.env.SALESASK_API_KEY;
const BASE = 'https://integrations.salesask.com';

async function saFetch(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'x-api-key': SALESASK_API_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`SalesAsk ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

// Rep resolution. The live recording document identifies its rep ONLY by
// `uid`, a Firebase UID (2026-08-08 Cowork audit, mismatch 2): no email field
// exists on it at all. So the primary key is pec_sales_team_members.salesask_uid
// (filled per rep), and email stays as the fallback chain for the PUSH
// direction and any payload that does carry one: salesask_email (explicit
// override, set in Settings) -> people.email (the unified person record) ->
// google_email (calendar-sync identity). Returns { byMemberId: {id -> email},
// byEmail: {lowercased email -> id}, byUid: {salesask uid -> id} } so the
// push (id -> email) and the match fallbacks share one load. Inactive members
// stay in the maps on purpose: old recordings still need to resolve.
async function loadRepEmailMap() {
  const [members, people] = await Promise.all([
    sb('GET', '/pec_sales_team_members?select=id,name,active,salesask_email,salesask_uid,google_email'),
    sb('GET', '/people?sales_team_member_id=not.is.null&select=sales_team_member_id,email'),
  ]);
  const personEmail = {};
  for (const p of (people || [])) {
    if (p.email) personEmail[p.sales_team_member_id] = p.email;
  }
  const byMemberId = {}, byEmail = {}, byUid = {};
  for (const m of (members || [])) {
    if (m.salesask_uid) byUid[String(m.salesask_uid)] = m.id;
    const email = m.salesask_email || personEmail[m.id] || m.google_email || null;
    if (!email) continue;
    byMemberId[m.id] = email;
    byEmail[email.toLowerCase()] = m.id;
  }
  return { byMemberId, byEmail, byUid };
}

// SalesAsk timestamps arrive in three shapes depending on source: ISO strings,
// epoch numbers, or Firestore {_seconds,_nanoseconds} objects on REST GET
// documents. new Date() on the Firestore shape is Invalid Date, which is how
// occurred_at stayed null on every REST-fetched doc and broke two of the three
// appointment matchers (2026-08-08 Cowork audit, mismatch 1).
function tsToIso(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && !(v instanceof Date)) {
    const secs = v._seconds != null ? v._seconds : v.seconds;
    if (secs != null && isFinite(Number(secs))) return new Date(Number(secs) * 1000).toISOString();
    return null;
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

// Upsert a pec_salesask_recordings row keyed on the SalesAsk recording id:
// PATCH what this event knows onto the existing row, else INSERT. The webhook
// and the reconcile cron can both deliver the same recording (webhooks have no
// retries, so the cron re-lists recent ones); each fills only its own fields.
// The unique index is the backstop if the two race their inserts; the loser
// re-PATCHes. Mirrors upsertCall in pec-webhook-quo.cjs.
async function upsertRecording(salesaskId, fields) {
  if (!salesaskId) return null;
  const q = `/pec_salesask_recordings?salesask_recording_id=eq.${encodeURIComponent(salesaskId)}`;
  const patched = await sb('PATCH', q, fields, true);
  if (Array.isArray(patched) && patched.length) return patched[0];
  try {
    const inserted = await sb('POST', '/pec_salesask_recordings',
      { salesask_recording_id: salesaskId, ...fields }, true);
    return Array.isArray(inserted) ? inserted[0] : inserted;
  } catch (e) {
    if (/duplicate|23505|409/.test(String(e.message || ''))) {
      const re = await sb('PATCH', q, fields, true);
      return Array.isArray(re) && re.length ? re[0] : null;
    }
    throw e;
  }
}

// Normalize a SalesAsk recording document (webhook `data` or REST GET body)
// into our column shape. Field names differ between the two sources, so every
// extraction is a coalesce over the known aliases; the verbatim document goes
// into `raw` regardless.
function extractRecordingFields(doc) {
  const fields = { raw: doc };
  const pick = (...keys) => { for (const k of keys) { if (doc[k] != null && doc[k] !== '') return doc[k]; } return null; };

  const title = pick('name', 'title');
  if (title) fields.title = String(title);
  const status = pick('status');
  if (status) fields.status = String(status);
  const summary = pick('summary');
  if (summary) fields.summary = Array.isArray(summary) ? summary.join('\n') : String(summary);
  const notes = pick('notes');
  if (notes) fields.notes = Array.isArray(notes) ? notes.join('\n') : String(notes);
  if (doc.actionItems != null) fields.action_items = doc.actionItems;
  if (doc.coaching != null) fields.coaching = doc.coaching;
  // doc.tags carries tag UUIDs on the live document; the human-readable labels
  // live in salesInsights.tags (2026-08-08 Cowork audit, mismatch 3). Prefer
  // labels, keep the UUIDs only when no labels exist.
  const tagLabels = doc.salesInsights && Array.isArray(doc.salesInsights.tags) && doc.salesInsights.tags.length
    ? doc.salesInsights.tags : null;
  if (tagLabels) fields.tags = tagLabels;
  else if (doc.tags != null) fields.tags = doc.tags;
  const url = pick('recording', 'meetingUrl', 'recordingUrl', 'url')
    || (doc.urls && (doc.urls.mp3 || doc.urls.original)) || null;
  if (url && typeof url === 'string') fields.recording_url = url;
  // SalesAsk durations are milliseconds (per docs); tolerate seconds if the
  // value is implausibly small for ms (< 1000 would be a sub-second call).
  const dur = Number(pick('duration', 'durationMs'));
  if (dur > 0) fields.duration_seconds = dur >= 1000 ? Math.round(dur / 100) / 10 : dur;
  const when = tsToIso(pick('createdAt', 'startedAt', 'occurredAt', 'date'));
  if (when) fields.occurred_at = when;
  const repEmail = pick('userEmail', 'user_email', 'repEmail')
    || (doc.user && (doc.user.email || doc.user.userEmail)) || (doc.owner && doc.owner.email) || null;
  if (repEmail) fields.rep_email = String(repEmail);
  if (doc.processFollowed != null) fields.process_followed = Number(doc.processFollowed);
  if (doc.processMissed != null) fields.process_missed = Number(doc.processMissed);
  if (doc.processTotal != null) fields.process_total = Number(doc.processTotal);
  // The live document has no flat process counts; the rubric lives in
  // process.answers[] as {question, answer: "yes"|"no", coaching} entries
  // (2026-08-08 Cowork audit, mismatch 4). Score = yes count over total.
  const answers = doc.process && Array.isArray(doc.process.answers) ? doc.process.answers : null;
  if (fields.process_total == null && answers && answers.length) {
    const yes = answers.filter(a => a && String(a.answer).toLowerCase() === 'yes').length;
    fields.process_followed = yes;
    fields.process_missed = answers.length - yes;
    fields.process_total = answers.length;
  }
  return fields;
}

// The event_id we pushed (= pec_appointments.id) comes back in the webhook
// payload when SalesAsk matched the recording to a scheduled task. Alias-
// tolerant, and nested shapes (scheduledTask / task objects) are checked too.
function extractEventId(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const direct = doc.event_id || doc.eventId || null;
  if (direct) return String(direct);
  for (const k of ['scheduledTask', 'scheduled_task', 'task', 'appointment']) {
    const nested = doc[k];
    if (nested && typeof nested === 'object') {
      const id = nested.event_id || nested.eventId || nested.id || null;
      if (id) return String(id);
    }
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Match a recording row to its appointment, best method first:
//   1. event_id — the id we pushed as the scheduled task, a direct lookup.
//   2. rep + time window — same rep (resolved email -> member id) whose
//      appointment surrounds occurred_at ([start_at - 1h, end_at + 2h]).
//   3. name fuzzy — the recording title contains the appointment's customer/
//      lead name (±12h window). Weakest, only used when 1 and 2 fail.
// On a match, the appointment's lead/customer/sales_member ids are copied onto
// the recording row (PATCH) so every downstream surface joins locally.
// Unmatched rows are kept with match_method 'unmatched', never dropped.
async function matchRecordingToAppointment(rec, eventId, emailMap) {
  const APPT_SELECT = 'id,lead_id,customer_id,sales_member_id,start_at,end_at,title,status';

  let appt = null, method = 'unmatched';

  // Rep resolution, uid first (the only identity the live document carries;
  // it rides in the row's raw jsonb), then the email fallback for payloads
  // that do have one.
  const rawUid = rec.raw && rec.raw.uid ? String(rec.raw.uid) : null;
  const repMemberId = (emailMap && (
    (rawUid && emailMap.byUid && emailMap.byUid[rawUid]) ||
    (rec.rep_email && emailMap.byEmail[String(rec.rep_email).toLowerCase()])
  )) || null;

  if (eventId && UUID_RE.test(eventId)) {
    const rows = await sb('GET', `/pec_appointments?id=eq.${encodeURIComponent(eventId)}&select=${APPT_SELECT}&limit=1`);
    if (Array.isArray(rows) && rows[0]) { appt = rows[0]; method = 'event_id'; }
  }

  if (!appt && rec.occurred_at && repMemberId) {
    const memberId = repMemberId;
    if (memberId) {
      const occ = new Date(rec.occurred_at).getTime();
      const startLte = new Date(occ + 3600 * 1000).toISOString();      // start_at <= occurred + 1h
      const endGte = new Date(occ - 2 * 3600 * 1000).toISOString();    // end_at >= occurred - 2h
      const rows = await sb('GET',
        `/pec_appointments?sales_member_id=eq.${encodeURIComponent(memberId)}&status=in.(scheduled,completed)` +
        `&start_at=lte.${encodeURIComponent(startLte)}&end_at=gte.${encodeURIComponent(endGte)}` +
        `&select=${APPT_SELECT}&order=start_at.desc&limit=1`);
      if (Array.isArray(rows) && rows[0]) { appt = rows[0]; method = 'rep_time_window'; }
    }
  }

  if (!appt && rec.occurred_at && rec.title) {
    const occ = new Date(rec.occurred_at).getTime();
    const from = new Date(occ - 12 * 3600 * 1000).toISOString();
    const to = new Date(occ + 12 * 3600 * 1000).toISOString();
    const rows = await sb('GET',
      `/pec_appointments?status=in.(scheduled,completed)&start_at=gte.${encodeURIComponent(from)}&start_at=lte.${encodeURIComponent(to)}` +
      `&select=${APPT_SELECT},customers(name)&order=start_at.desc&limit=50`);
    const titleLc = String(rec.title).toLowerCase();
    for (const a of (Array.isArray(rows) ? rows : [])) {
      const custName = a.customers && a.customers.name ? String(a.customers.name).toLowerCase() : null;
      const apptTitle = a.title ? String(a.title).toLowerCase() : null;
      if ((custName && custName.length >= 4 && titleLc.includes(custName)) ||
          (apptTitle && apptTitle.length >= 4 && titleLc.includes(apptTitle))) {
        appt = a; method = 'name_fuzzy'; break;
      }
    }
  }

  const patch = { match_method: method };
  if (appt) {
    patch.appointment_id = appt.id;
    if (appt.lead_id) patch.lead_id = appt.lead_id;
    if (appt.customer_id) patch.customer_id = appt.customer_id;
    if (appt.sales_member_id) patch.sales_member_id = appt.sales_member_id;
  }
  // Even unmatched, stamp the rep when the uid/email resolved one: the row
  // then filters by rep on every surface without an appointment bridge.
  if (!patch.sales_member_id && repMemberId) patch.sales_member_id = repMemberId;
  await sb('PATCH', `/pec_salesask_recordings?id=eq.${encodeURIComponent(rec.id)}`, patch);
  return { ...rec, ...patch };
}

// Flatten SalesAsk transcript utterances ({speaker,text,...}) to plain lines,
// the same shape pec-openphone-sync stores for Quo calls, so pec-lead-ai's
// prompt reads both identically.
function transcriptToText(utterances) {
  if (!Array.isArray(utterances)) return null;
  return utterances.map(u => `${u.speaker || 'Speaker'}: ${u.text || ''}`).join('\n') || null;
}

// Insert the lead-timeline event for a processed recording. This one row is
// BOTH the timeline surface (leadEventHtml renders event_type
// 'salesask_recording') and the AI feed (pec-lead-ai gathers lead_events
// payloads, sliced to 4000 chars — summary and score go first so the slice
// keeps the signal even when the transcript excerpt is truncated).
// Deduped on payload->>salesask_recording_id, mirroring pec-openphone-sync.
async function insertRecordingLeadEvent(rec) {
  if (!rec.lead_id || !rec.id) return false;
  const dup = await sb('GET',
    `/lead_events?lead_id=eq.${encodeURIComponent(rec.lead_id)}&event_type=eq.salesask_recording` +
    `&payload-%3E%3Esalesask_recording_id=eq.${encodeURIComponent(rec.salesask_recording_id)}&select=id&limit=1`);
  if (Array.isArray(dup) && dup.length) return false;
  const transcriptText = transcriptToText(rec.transcript);
  await sb('POST', '/lead_events', {
    lead_id: rec.lead_id,
    event_type: 'salesask_recording',
    payload: {
      salesask_recording_id: rec.salesask_recording_id,
      summary: rec.summary ? String(rec.summary).slice(0, 1200) : null,
      action_items: rec.action_items || null,
      process_followed: rec.process_followed,
      process_total: rec.process_total,
      duration_seconds: rec.duration_seconds || null,
      recording_url: rec.recording_url || null,
      occurred_at: rec.occurred_at || null,
      transcript_excerpt: transcriptText ? transcriptText.slice(0, 2000) : null,
    },
  });
  return true;
}

async function getSetting(key, fallback) {
  const rows = await sb('GET', `/settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return (Array.isArray(rows) && rows[0] && rows[0].value != null) ? rows[0].value : fallback;
}

module.exports = {
  SALESASK_API_KEY,
  saFetch,
  tsToIso,
  loadRepEmailMap,
  upsertRecording,
  extractRecordingFields,
  extractEventId,
  matchRecordingToAppointment,
  transcriptToText,
  insertRecordingLeadEvent,
  getSetting,
};
