// Google -> TopCoat pull (prompt 37, Phase B). Scheduled every 15 minutes
// (netlify.toml). For each connected roster member: incremental
// events.list on their dedicated "TopCoat" calendar with the stored
// syncToken (full list when none, e.g. right after connect), upsert into
// pec_appointments by google_event_id, persist the new syncToken. On 410
// GONE the token is dropped and the member full-resyncs the same tick.
// Watch channels were deliberately NOT used: they need a public webhook plus
// renewal every few weeks; polling with syncToken self-heals and matches
// the pec-drip-runner posture (an outside call is just an ordinary
// idempotent tick).
//
// ECHO / CONFLICT RULE: every push stores the event's etag/updated on the
// row. A pulled event whose `updated` is not newer than the stored
// google_updated is our own push echoing back and is skipped; a genuinely
// newer `updated` wins (last-writer-wins on Google's clock). status
// 'cancelled' from Google cancels the TopCoat row. Events created directly
// in the TopCoat calendar arrive as new rows: source 'google', type from
// the private extendedProperty when it is one of ours, else 'other',
// assigned to the calendar's member.

const { sb, json } = require('./_pec-supabase.cjs');
const {
  googleConfigured, getFreshAccessToken, getTokenRow, saveTokenRow, gcalFetch,
  stripGcalDescription,
} = require('./_pec-google.cjs');

const PHX_OFFSET = '-07:00'; // fixed, no DST (project convention)
const APPT_TYPES = ['on_site_estimate', 'project_walkthrough', 'site_visit', 'other'];

// Map a Google event onto pec_appointments columns. All-day events carry
// date-only bounds; anchor them to Phoenix midnight so they render on the
// right day in the fixed-offset convention.
function mapEventToRow(ev, member) {
  const allDay = !!(ev.start && ev.start.date);
  const startAt = allDay
    ? new Date(`${ev.start.date}T00:00:00${PHX_OFFSET}`).toISOString()
    : (ev.start && ev.start.dateTime ? new Date(ev.start.dateTime).toISOString() : null);
  const endAt = allDay
    ? new Date(`${(ev.end && ev.end.date) || ev.start.date}T00:00:00${PHX_OFFSET}`).toISOString()
    : (ev.end && ev.end.dateTime ? new Date(ev.end.dateTime).toISOString() : startAt);
  const privProps = (ev.extendedProperties && ev.extendedProperties.private) || {};
  return {
    row: {
      title: ev.summary || null,
      // The pushed description = internal notes + a separator + an auto-added
      // contact/link block (prompt 38). Ingest only the human-typed part
      // above the separator so the auto block can never clobber `notes`.
      // customer_notes is NEVER written from Google.
      notes: stripGcalDescription(ev.description),
      location_address: ev.location || null,
      start_at: startAt,
      end_at: endAt,
      all_day: allDay,
      google_event_id: ev.id,
      google_calendar_id: member.google_calendar_id,
      google_etag: ev.etag || null,
      google_updated: ev.updated || null,
    },
    apptType: APPT_TYPES.includes(privProps.topcoat_type) ? privProps.topcoat_type : 'other',
    valid: !!startAt,
  };
}

// True when the pulled event is our own push echoing back (or stale relative
// to what we already stored): its updated is not strictly newer.
function shouldSkipEcho(ev, existing) {
  if (!existing || !existing.google_updated || !ev.updated) return false;
  return new Date(ev.updated).getTime() <= new Date(existing.google_updated).getTime();
}

async function processEvent(member, ev, summary) {
  if (!ev || !ev.id) return;
  if (ev.status === 'cancelled') {
    // Cancel the mapped row if we still have one (a TopCoat-side cancel
    // already cleared the mapping, so this finds nothing and no-ops).
    await sb('PATCH',
      `/pec_appointments?google_event_id=eq.${encodeURIComponent(ev.id)}&status=neq.canceled`,
      { status: 'canceled' });
    summary.canceled++;
    return;
  }
  const { row, apptType, valid } = mapEventToRow(ev, member);
  if (!valid) { summary.skipped++; return; }
  const existingRows = await sb('GET', `/pec_appointments?google_event_id=eq.${encodeURIComponent(ev.id)}&select=id,google_updated,status&limit=1`);
  const existing = Array.isArray(existingRows) && existingRows[0];
  if (existing) {
    if (shouldSkipEcho(ev, existing)) { summary.echoes++; return; }
    // Google is newer: last-writer-wins. A row canceled in TopCoat but
    // still live on Google was already unmapped by the push, so this only
    // ever touches live mappings; un-cancel is intentional if Google edited
    // a still-mapped canceled row.
    await sb('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(existing.id)}`, { ...row, status: 'scheduled' });
    summary.updated++;
  } else {
    try {
      await sb('POST', '/pec_appointments', {
        ...row,
        appt_type: apptType,
        sales_member_id: member.id,
        status: 'scheduled',
        source: 'google',
      });
      summary.created++;
    } catch (e) {
      // Unique-index race with a concurrent tick: the other pass won; fine.
      if (/409|duplicate|unique/i.test(String(e && e.message))) summary.echoes++;
      else throw e;
    }
  }
}

async function pullMember(member, summary) {
  const token = await getFreshAccessToken(sb, member.id);
  if (!token || !member.google_calendar_id) { summary.members_skipped++; return; }
  const tokRow = await getTokenRow(sb, member.id);
  let syncToken = tokRow && tokRow.sync_token;
  let pageToken = null;
  let fullResyncDone = false;

  for (let page = 0; page < 6; page++) { // hard page cap per member per tick
    const p = new URLSearchParams({ maxResults: '250', singleEvents: 'true' });
    if (pageToken) p.set('pageToken', pageToken);
    else if (syncToken) p.set('syncToken', syncToken);
    const res = await gcalFetch(token, 'GET',
      `/calendars/${encodeURIComponent(member.google_calendar_id)}/events?${p.toString()}`, null, 12000);

    if (res.status === 410 && !fullResyncDone) {
      // Sync token expired: drop it and full-resync this same tick.
      syncToken = null; pageToken = null; fullResyncDone = true;
      await saveTokenRow(sb, member.id, { sync_token: null });
      page = -1; // restart the loop budget for the full pass
      continue;
    }
    if (!res.ok || !res.body) {
      console.error(`pec-google-calendar-pull: list failed for member ${member.id} (${res.status})`);
      summary.errors++;
      return;
    }
    for (const ev of res.body.items || []) {
      try { await processEvent(member, ev, summary); }
      catch (err) {
        console.error(`pec-google-calendar-pull: event ${ev && ev.id} failed:`, err && err.message || err);
        summary.errors++;
      }
    }
    if (res.body.nextPageToken) { pageToken = res.body.nextPageToken; continue; }
    if (res.body.nextSyncToken) await saveTokenRow(sb, member.id, { sync_token: res.body.nextSyncToken });
    return;
  }
  console.warn(`pec-google-calendar-pull: page cap hit for member ${member.id}; the rest lands next tick`);
}

exports.handler = async () => {
  const summary = { members: 0, members_skipped: 0, created: 0, updated: 0, canceled: 0, echoes: 0, skipped: 0, errors: 0, not_configured: false, not_migrated: false };
  try {
    if (!googleConfigured()) { summary.not_configured = true; return json(200, { ok: true, ...summary }); }
    let members;
    try {
      members = await sb('GET', '/pec_sales_team_members?google_connected=eq.true&select=id,name,google_calendar_id');
    } catch (e) { summary.not_migrated = true; return json(200, { ok: true, ...summary }); }
    members = Array.isArray(members) ? members : [];
    summary.members = members.length;
    for (const m of members) {
      try { await pullMember(m, summary); }
      catch (err) {
        console.error(`pec-google-calendar-pull: member ${m.id} failed:`, err && err.message || err);
        summary.errors++;
      }
    }
    console.log('pec-google-calendar-pull:', JSON.stringify(summary));
    return json(200, { ok: true, ...summary });
  } catch (err) {
    console.error('pec-google-calendar-pull failed:', err && err.message || err);
    return json(500, { ok: false, error: String(err && err.message || err) });
  }
};

// Exported for the fixture test (mapping + echo rule are the fiddly parts).
module.exports.mapEventToRow = mapEventToRow;
module.exports.shouldSkipEcho = shouldSkipEcho;

// Heartbeat (prompt 90 Task A): stamp AFTER a successful run by wrapping the
// handler, so every ok exit path stamps (including gated no-ops: the
// SCHEDULE firing is what the monitor watches, not the feature toggle)
// without touching each return site. Best-effort by contract; a heartbeat
// failure never fails the job.
{
  const { writeHeartbeat } = require('./_pec-supabase.cjs');
  const _handler = exports.handler;
  exports.handler = async (event, context) => {
    const res = await _handler(event, context);
    try {
      if (res && res.statusCode === 200 && JSON.parse(res.body || '{}').ok === true) await writeHeartbeat('pec-google-calendar-pull');
    } catch (_) { /* best-effort */ }
    return res;
  };
}
