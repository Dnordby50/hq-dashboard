// TopCoat -> Google push (prompt 37, Phase B). The dashboard kicks this
// (staff JWT, best-effort, fire-and-forget) after every appointment write:
// create/update/cancel push into the assigned member's dedicated "TopCoat"
// calendar; a hard delete arrives as { action:'delete', google_event_id,
// google_calendar_id } captured before the row vanished. A push failure
// never blocks the local save; the row simply keeps google_event_id null
// ("not synced yet") and the next write re-kicks.
//
// Idempotency: an already-synced row PATCHes its google_event_id; a 404/410
// from Google (event deleted over there) falls back to a fresh insert.
// Reassignment: when the appointment moved to a different member, the event
// is deleted from the previous member's calendar (found by matching
// google_calendar_id on the roster) before inserting on the new one.
// Echo-prevention bookkeeping: the Google response's etag/updated are stored
// on the row, so the pull runner can tell our own echo from a real edit.

const { sb } = require('./_pec-supabase.cjs');
const {
  googleConfigured, getFreshAccessToken, gcalFetch, getStaffUser,
  composeGcalDescription, SITE_URL,
} = require('./_pec-google.cjs');

const APPT_TYPE_LABELS = {
  on_site_estimate: 'On-site estimate',
  project_walkthrough: 'Project walkthrough',
  site_visit: 'Site visit',
  other: 'Busy',
};
const PHX_OFFSET_MS = 7 * 60 * 60 * 1000;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
const jc = (statusCode, body) => ({ statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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
async function contactLinesForAppt(appt) {
  const lines = [];
  try {
    let person = null;
    if (appt.lead_id) {
      const rows = await sb('GET', `/leads?id=eq.${encodeURIComponent(appt.lead_id)}&select=full_name,phone&limit=1`);
      const l = Array.isArray(rows) && rows[0];
      if (l) person = { name: l.full_name, phone: l.phone };
    }
    if (!person && appt.customer_id) {
      const rows = await sb('GET', `/customers?id=eq.${encodeURIComponent(appt.customer_id)}&select=name,phone&limit=1`);
      const c = Array.isArray(rows) && rows[0];
      if (c) person = { name: c.name, phone: c.phone };
    }
    if (person && (person.name || person.phone)) {
      lines.push(['Customer:', person.name, person.phone ? fmtPhone(person.phone) : '']
        .filter(Boolean).join(' '));
    }
  } catch (e) {
    console.warn('pec-appt-sync-push: contact lookup skipped:', e && e.message || e);
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
async function tokenForCalendar(calendarId) {
  if (!calendarId) return null;
  const rows = await sb('GET', `/pec_sales_team_members?google_calendar_id=eq.${encodeURIComponent(calendarId)}&google_connected=eq.true&select=id&limit=1`);
  const m = Array.isArray(rows) && rows[0];
  return m ? await getFreshAccessToken(sb, m.id) : null;
}

async function deleteEvent(calendarId, eventId) {
  const token = await tokenForCalendar(calendarId);
  if (!token) return { ok: false, skipped: 'owner_not_connected' };
  const res = await gcalFetch(token, 'DELETE',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  // 404/410 = already gone on Google's side; that IS the desired end state.
  return { ok: res.ok || res.status === 404 || res.status === 410, status: res.status };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { ok: false, error: 'Method not allowed' });

  const user = await getStaffUser(event);
  if (!user) return jc(401, { ok: false, error: 'Not authenticated' });
  if (!googleConfigured()) return jc(200, { ok: true, skipped: 'google_not_configured' });

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { ok: false, error: 'Invalid JSON' }); }

  try {
    // Hard delete: the row is gone; the client passed the Google identifiers.
    if (input.action === 'delete') {
      if (!input.google_event_id || !input.google_calendar_id) return jc(200, { ok: true, skipped: 'never_synced' });
      const out = await deleteEvent(input.google_calendar_id, input.google_event_id);
      return jc(200, { ok: out.ok, ...out });
    }

    if (!input.appointment_id) return jc(400, { ok: false, error: 'appointment_id is required' });
    const rows = await sb('GET', `/pec_appointments?id=eq.${encodeURIComponent(input.appointment_id)}&select=*&limit=1`);
    const appt = Array.isArray(rows) && rows[0];
    if (!appt) return jc(200, { ok: true, skipped: 'row_gone' });

    // Cancellation: remove the Google event and clear the mapping, so a later
    // restore pushes as a brand-new event.
    if (appt.status === 'canceled') {
      if (!appt.google_event_id || !appt.google_calendar_id) return jc(200, { ok: true, skipped: 'never_synced' });
      const out = await deleteEvent(appt.google_calendar_id, appt.google_event_id);
      if (out.ok) {
        await sb('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(appt.id)}`,
          { google_event_id: null, google_calendar_id: null, google_etag: null, google_updated: null });
      }
      return jc(200, { ok: out.ok, canceled: true, ...out });
    }

    if (!appt.sales_member_id) return jc(200, { ok: true, skipped: 'unassigned' });
    const mRows = await sb('GET', `/pec_sales_team_members?id=eq.${encodeURIComponent(appt.sales_member_id)}&select=id,google_connected,google_calendar_id&limit=1`);
    const member = Array.isArray(mRows) && mRows[0];
    if (!member || !member.google_connected || !member.google_calendar_id) {
      return jc(200, { ok: true, skipped: 'member_not_connected' });
    }
    const accessToken = await getFreshAccessToken(sb, member.id);
    if (!accessToken) return jc(200, { ok: true, skipped: 'token_refresh_failed' });

    // Reassignment: the stored mapping points at a DIFFERENT member's
    // calendar; clean up over there first, then insert fresh below.
    let eventId = appt.google_event_id;
    if (eventId && appt.google_calendar_id && appt.google_calendar_id !== member.google_calendar_id) {
      await deleteEvent(appt.google_calendar_id, eventId).catch(() => {});
      eventId = null;
    }

    const body = eventBodyFromAppt(appt, await contactLinesForAppt(appt));
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
      console.error(`pec-appt-sync-push: push failed for ${appt.id} (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
      return jc(200, { ok: false, error: `Google rejected the event (${res.status})` });
    }

    await sb('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(appt.id)}`, {
      google_event_id: res.body.id,
      google_calendar_id: member.google_calendar_id,
      google_etag: res.body.etag || null,
      google_updated: res.body.updated || null,
    });
    console.log(`pec-appt-sync-push: appt ${appt.id} -> event ${res.body.id}`);
    return jc(200, { ok: true, google_event_id: res.body.id });
  } catch (err) {
    console.error('pec-appt-sync-push failed:', err && err.message || err);
    return jc(500, { ok: false, error: String(err && err.message || err) });
  }
};
