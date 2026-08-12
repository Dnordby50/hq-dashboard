// TopCoat -> Google push CORE (prompt 88, extracted verbatim from
// pec-appt-sync-push.cjs). Two callers: the HTTP endpoint the dashboard
// kicks after every in-app appointment write, and pec-appt-intake, which
// writes appointments server-side (Routemize) and for a month never pushed
// them anywhere — extraction exists so the intake calls this directly
// instead of HTTP-invoking its own sibling function.
//
// `db` is injected everywhere (the _pec-supabase sb, or the fixture
// mini-PostgREST in tests), matching the intake's testability pattern.
//
// Idempotency: an already-synced row PUTs its google_event_id; a 404/410
// from Google (event deleted over there) falls back to a fresh insert.
// Reassignment: when the appointment moved to a different member, the event
// is deleted from the previous member's calendar before inserting on the new
// one. Echo-prevention bookkeeping: the Google response's etag/updated are
// stored on the row, so the pull runner can tell our own echo from a real
// edit. A canceled row deletes its Google event and clears the mapping.

const {
  googleConfigured, getFreshAccessToken, gcalFetch,
  composeGcalDescription, SITE_URL,
} = require('./_pec-google.cjs');

const APPT_TYPE_LABELS = {
  on_site_estimate: 'On-site estimate',
  project_walkthrough: 'Project walkthrough',
  site_visit: 'Site visit',
  other: 'Busy',
};
const PHX_OFFSET_MS = 7 * 60 * 60 * 1000;

// Phoenix wall-clock date (fixed UTC-7, the project convention) for all-day
// events; Google wants an exclusive end date.
function phxDateStr(iso, plusDays = 0) {
  const d = new Date(new Date(iso).getTime() - PHX_OFFSET_MS + plusDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// (760) 576-4073 for 10-digit US numbers; anything else passes through
// (mirror of the dashboard's qoFmtPhone so the two surfaces agree).
function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || '');
}

// The auto-added contact/link block under the description separator: customer
// name + phone (the appointment row stores neither; fetch from the linked
// lead, else customer) and a TopCoat deep link (/?appt=<id>, the same route
// the bell's 'appointments' target opens). Best-effort: a lookup failure just
// means a shorter block. No em dashes (prompt 38 / standing rule 6).
async function contactLinesForAppt(db, appt) {
  const lines = [];
  try {
    let person = null;
    if (appt.lead_id) {
      const rows = await db('GET', `/leads?id=eq.${encodeURIComponent(appt.lead_id)}&select=full_name,phone&limit=1`);
      const l = Array.isArray(rows) && rows[0];
      if (l) person = { name: l.full_name, phone: l.phone };
    }
    if (!person && appt.customer_id) {
      const rows = await db('GET', `/customers?id=eq.${encodeURIComponent(appt.customer_id)}&select=name,phone&limit=1`);
      const c = Array.isArray(rows) && rows[0];
      if (c) person = { name: c.name, phone: c.phone };
    }
    if (person && (person.name || person.phone)) {
      lines.push(['Customer:', person.name, person.phone ? fmtPhone(person.phone) : '']
        .filter(Boolean).join(' '));
    }
  } catch (e) {
    console.warn('_pec-appt-push: contact lookup skipped:', e && e.message || e);
  }
  lines.push(`Open in TopCoat: ${SITE_URL}/?appt=${appt.id}`);
  return lines;
}

function eventBodyFromAppt(appt, contactLines) {
  const summary = appt.title || APPT_TYPE_LABELS[appt.appt_type] || 'Appointment';
  const location = [appt.location_address, appt.location_city, appt.location_state, appt.location_zip]
    .filter(Boolean).join(', ');
  const body = {
    summary,
    // Internal company notes + the auto-added contact/link block. The
    // customer-facing customer_notes is deliberately NOT pushed (the
    // calendar is the salesperson's internal view).
    description: composeGcalDescription(appt.notes, contactLines),
    location: location || undefined,
    extendedProperties: { private: { topcoat_id: appt.id, topcoat_type: appt.appt_type } },
  };
  if (appt.all_day) {
    body.start = { date: phxDateStr(appt.start_at) };
    body.end = { date: phxDateStr(appt.start_at, 1) };
  } else {
    body.start = { dateTime: appt.start_at, timeZone: 'America/Phoenix' };
    body.end = { dateTime: appt.end_at, timeZone: 'America/Phoenix' };
  }
  return body;
}

// Token for whichever member OWNS a calendar id (used to clean up after a
// reassignment or a hard delete). Null when nobody on the roster owns it.
async function tokenForCalendar(db, calendarId) {
  if (!calendarId) return null;
  const rows = await db('GET', `/pec_sales_team_members?google_calendar_id=eq.${encodeURIComponent(calendarId)}&google_connected=eq.true&select=id&limit=1`);
  const m = Array.isArray(rows) && rows[0];
  return m ? await getFreshAccessToken(db, m.id) : null;
}

async function deleteEvent(db, calendarId, eventId) {
  const token = await tokenForCalendar(db, calendarId);
  if (!token) return { ok: false, skipped: 'owner_not_connected' };
  const res = await gcalFetch(token, 'DELETE',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  // 404/410 = already gone on Google's side; that IS the desired end state.
  return { ok: res.ok || res.status === 404 || res.status === 410, status: res.status };
}

// Push ONE appointment row (by id) to its member's TopCoat calendar:
// create/update/cancel resolved from the row's current state. Returns the
// same result shapes the HTTP endpoint has always answered with; throws only
// on unexpected errors (callers that must never fail wrap it).
async function pushApptById(db, appointmentId) {
  if (!googleConfigured()) return { ok: true, skipped: 'google_not_configured' };
  const rows = await db('GET', `/pec_appointments?id=eq.${encodeURIComponent(appointmentId)}&select=*&limit=1`);
  const appt = Array.isArray(rows) && rows[0];
  if (!appt) return { ok: true, skipped: 'row_gone' };

  // Cancellation: remove the Google event and clear the mapping, so a later
  // restore pushes as a brand-new event.
  if (appt.status === 'canceled') {
    if (!appt.google_event_id || !appt.google_calendar_id) return { ok: true, skipped: 'never_synced' };
    const out = await deleteEvent(db, appt.google_calendar_id, appt.google_event_id);
    if (out.ok) {
      await db('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(appt.id)}`,
        { google_event_id: null, google_calendar_id: null, google_etag: null, google_updated: null });
    }
    return { ok: out.ok, canceled: true, ...out };
  }

  if (!appt.sales_member_id) return { ok: true, skipped: 'unassigned' };
  const mRows = await db('GET', `/pec_sales_team_members?id=eq.${encodeURIComponent(appt.sales_member_id)}&select=id,google_connected,google_calendar_id&limit=1`);
  const member = Array.isArray(mRows) && mRows[0];
  if (!member || !member.google_connected || !member.google_calendar_id) {
    return { ok: true, skipped: 'member_not_connected' };
  }
  const accessToken = await getFreshAccessToken(db, member.id);
  if (!accessToken) return { ok: true, skipped: 'token_refresh_failed' };

  // Reassignment: the stored mapping points at a DIFFERENT member's
  // calendar; clean up over there first, then insert fresh below.
  let eventId = appt.google_event_id;
  if (eventId && appt.google_calendar_id && appt.google_calendar_id !== member.google_calendar_id) {
    await deleteEvent(db, appt.google_calendar_id, eventId).catch(() => {});
    eventId = null;
  }

  const body = eventBodyFromAppt(appt, await contactLinesForAppt(db, appt));
  let res;
  if (eventId) {
    res = await gcalFetch(accessToken, 'PUT',
      `/calendars/${encodeURIComponent(member.google_calendar_id)}/events/${encodeURIComponent(eventId)}`, body);
    // Deleted on Google's side since we last synced: re-create.
    if (res.status === 404 || res.status === 410) eventId = null;
  }
  if (!eventId) {
    res = await gcalFetch(accessToken, 'POST',
      `/calendars/${encodeURIComponent(member.google_calendar_id)}/events`, body);
  }
  if (!res.ok || !res.body || !res.body.id) {
    console.error(`_pec-appt-push: push failed for ${appt.id} (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
    return { ok: false, error: `Google rejected the event (${res.status})` };
  }

  await db('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(appt.id)}`, {
    google_event_id: res.body.id,
    google_calendar_id: member.google_calendar_id,
    google_etag: res.body.etag || null,
    google_updated: res.body.updated || null,
  });
  console.log(`_pec-appt-push: appt ${appt.id} -> event ${res.body.id}`);
  return { ok: true, google_event_id: res.body.id };
}

module.exports = { pushApptById, deleteEvent, eventBodyFromAppt, contactLinesForAppt, APPT_TYPE_LABELS };
