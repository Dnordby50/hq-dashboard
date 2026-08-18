// Google -> TopCoat pull (prompt 37, Phase B; multi-calendar in prompt 96).
// Scheduled every 15 minutes (netlify.toml). For each connected roster
// member: incremental events.list on their dedicated "TopCoat" calendar with
// the stored syncToken (full list when none, e.g. right after connect),
// upsert into pec_appointments by google_event_id, persist the new
// syncToken. On 410 GONE the token is dropped and the member full-resyncs
// the same tick. Watch channels were deliberately NOT used: they need a
// public webhook plus renewal every few weeks; polling with syncToken
// self-heals and matches the pec-drip-runner posture (an outside call is
// just an ordinary idempotent tick).
//
// MULTI-CALENDAR (prompt 96): after the TopCoat-calendar pass (unchanged),
// each member's sync_enabled rows in pec_sales_member_google_calendars are
// pulled the same way, each with ITS OWN sync token on its own row, so one
// calendar's 410 or error never poisons the others. The member's TopCoat
// calendar is always skipped in this loop (it is the push target; pulling it
// here would round-trip TopCoat's own writes through two token streams).
// Imported rows are time blocks, not bookings: source 'google', no lead or
// customer link, and the automation guard in _pec-appt.cjs keeps every
// customer-facing effect away from them (locked decision 5).
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
// right day in the fixed-offset convention. opts (prompt 96):
// { calendarId, defaultType } for the multi-calendar loop; omitted, the
// original TopCoat-calendar behavior is byte-for-byte unchanged.
function mapEventToRow(ev, member, opts = {}) {
  const allDay = !!(ev.start && ev.start.date);
  const startAt = allDay
    ? new Date(`${ev.start.date}T00:00:00${PHX_OFFSET}`).toISOString()
    : (ev.start && ev.start.dateTime ? new Date(ev.start.dateTime).toISOString() : null);
  const endAt = allDay
    ? new Date(`${(ev.end && ev.end.date) || ev.start.date}T00:00:00${PHX_OFFSET}`).toISOString()
    : (ev.end && ev.end.dateTime ? new Date(ev.end.dateTime).toISOString() : startAt);
  const privProps = (ev.extendedProperties && ev.extendedProperties.private) || {};
  const defaultType = APPT_TYPES.includes(opts.defaultType) ? opts.defaultType : 'other';
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
      google_calendar_id: opts.calendarId || member.google_calendar_id,
      google_etag: ev.etag || null,
      google_updated: ev.updated || null,
      // Part C needs the parent series id: the push may PATCH this expanded
      // instance's own id only, never the series.
      google_recurring_event_id: ev.recurringEventId || null,
    },
    apptType: APPT_TYPES.includes(privProps.topcoat_type) ? privProps.topcoat_type : defaultType,
    valid: !!startAt,
  };
}

// Part C guardrails 1-2, computed at pull time and STORED on the row so the
// UI renders read-only straight off it (never re-derived client-side).
// Null = TopCoat may write this event back. Guardrail 3 (instance, never
// series) is structural in the push: google_event_id IS the expanded
// instance id under singleEvents:true.
function importGuardrailReason(ev, cal) {
  if (!cal || !['owner', 'writer'].includes(String(cal.access_role || ''))) return 'calendar_read_only';
  // organizer.self: this copy of the event belongs to the organizer. An
  // event the rep was merely invited to must never be edited from TopCoat.
  // A missing organizer (rare: free/busy-only reads) is not treated as
  // someone else's event; the access check above already gates those.
  if (ev && ev.organizer && ev.organizer.self !== true) return 'not_organizer';
  return null;
}

// Which pulled events never become rows (prompt 96, multi-calendar loop
// only): birthday and workingLocation pseudo-events always (not real time
// commitments); all-day and self-declined per settings. outOfOffice and
// focusTime DO import; they are real blocks on the rep's day.
function shouldSkipImportedEvent(ev, cfg) {
  const t = ev && ev.eventType;
  if (t === 'birthday' || t === 'workingLocation') return true;
  if (!cfg.includeAllDay && ev && ev.start && ev.start.date) return true;
  if (!cfg.includeDeclined && ev && Array.isArray(ev.attendees)
      && ev.attendees.some(a => a && a.self && a.responseStatus === 'declined')) return true;
  return false;
}

// The bounded pull window for a FULL sync of an imported calendar. A bounded
// window and a sync token do not compose the way an unbounded one does:
// Google rejects syncToken combined with timeMin/timeMax, so the window is
// asserted only on full syncs (first enable, and every 410 resync), and the
// token minted by that bounded list keeps delivering changes within it.
// Re-assert the window on every full resync; never widen an incremental.
function pullWindow(cfg, now = new Date()) {
  const past = Number.isFinite(Number(cfg.windowDaysPast)) ? Number(cfg.windowDaysPast) : 30;
  const future = Number.isFinite(Number(cfg.windowDaysFuture)) ? Number(cfg.windowDaysFuture) : 180;
  return {
    timeMin: new Date(now.getTime() - past * 86400000).toISOString(),
    timeMax: new Date(now.getTime() + future * 86400000).toISOString(),
  };
}

// True when the pulled event is our own push echoing back (or stale relative
// to what we already stored): its updated is not strictly newer.
function shouldSkipEcho(ev, existing) {
  if (!existing || !existing.google_updated || !ev.updated) return false;
  return new Date(ev.updated).getTime() <= new Date(existing.google_updated).getTime();
}

// ctx (prompt 96): { calendarId, defaultType, readonlyReason } for the
// multi-calendar loop; omitted, the TopCoat-calendar behavior is unchanged.
async function processEvent(member, ev, summary, ctx = null) {
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
  const { row, apptType, valid } = mapEventToRow(ev, member,
    ctx ? { calendarId: ctx.calendarId, defaultType: ctx.defaultType } : {});
  if (!valid) { summary.skipped++; return; }
  // Imported rows carry the pull-time guardrail verdict (null = writable).
  // A push-set reason (recurring_patch_failed / google_rejected_edit) stays
  // until a GENUINE remote edit lands (echoes never reach this write), at
  // which point re-deriving from the fresh event is the honest answer.
  if (ctx) row.google_readonly_reason = ctx.readonlyReason(ev);
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
      if (ctx) summary.imported_created++;
    } catch (e) {
      // Unique-index race with a concurrent tick: the other pass won; fine.
      // (Also where an invite synced from TWO of the member's calendars
      // lands: Google reuses the event id across calendar copies, and the
      // unique index makes the first copy the row.)
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

// ---------------------------------------------------------------------------
// Multi-calendar loop (prompt 96).
// ---------------------------------------------------------------------------

// One settings read per tick. Every knob has a shipped default so a missing
// row (or the whole read failing) never stops the pull.
async function loadPullSettings() {
  const cfg = { windowDaysPast: 30, windowDaysFuture: 180, maxPages: 6, defaultType: 'other', includeAllDay: true, includeDeclined: false };
  try {
    const rows = await sb('GET', '/settings?key=in.(google_pull_window_days_past,google_pull_window_days_future,google_pull_max_pages_per_calendar,google_imported_default_appt_type,google_pull_include_all_day,google_pull_include_declined)&select=key,value');
    const kv = {};
    for (const r of (Array.isArray(rows) ? rows : [])) kv[r.key] = r.value;
    if (Number(kv.google_pull_window_days_past) >= 0) cfg.windowDaysPast = Number(kv.google_pull_window_days_past);
    if (Number(kv.google_pull_window_days_future) > 0) cfg.windowDaysFuture = Number(kv.google_pull_window_days_future);
    if (Number(kv.google_pull_max_pages_per_calendar) > 0) cfg.maxPages = Number(kv.google_pull_max_pages_per_calendar);
    if (APPT_TYPES.includes(kv.google_imported_default_appt_type)) cfg.defaultType = kv.google_imported_default_appt_type;
    if (kv.google_pull_include_all_day != null) cfg.includeAllDay = kv.google_pull_include_all_day !== 'false';
    if (kv.google_pull_include_declined != null) cfg.includeDeclined = kv.google_pull_include_declined === 'true';
  } catch (_) { /* defaults stand */ }
  return cfg;
}

async function patchCalRow(id, patch) {
  try {
    await sb('PATCH', `/pec_sales_member_google_calendars?id=eq.${encodeURIComponent(id)}`, patch);
  } catch (e) {
    console.error('pec-google-calendar-pull: calendar row patch failed:', e && e.message || e);
  }
}

// Same shape as pullMember, but the sync token lives on the CALENDAR row and
// a full sync is bounded by the settings window (see pullWindow). Writes
// last_synced_at / last_error on the row so Settings can show sync health
// per calendar without digging through function logs.
async function pullOneCalendar(member, cal, token, cfg, summary) {
  let syncToken = cal.sync_token;
  let pageToken = null;
  let fullResyncDone = false;

  for (let page = 0; page < cfg.maxPages; page++) {
    const p = new URLSearchParams({ maxResults: '250', singleEvents: 'true' });
    if (pageToken) p.set('pageToken', pageToken);
    else if (syncToken) p.set('syncToken', syncToken);
    else {
      // Full sync only: Google rejects syncToken + timeMin/timeMax together.
      const w = pullWindow(cfg);
      p.set('timeMin', w.timeMin);
      p.set('timeMax', w.timeMax);
    }
    const res = await gcalFetch(token, 'GET',
      `/calendars/${encodeURIComponent(cal.calendar_id)}/events?${p.toString()}`, null, 12000);

    if (res.status === 410 && !fullResyncDone) {
      // Sync token expired: drop it and full-resync (window re-asserted).
      syncToken = null; pageToken = null; fullResyncDone = true;
      await patchCalRow(cal.id, { sync_token: null });
      page = -1; // restart the loop budget for the full pass
      continue;
    }
    if (!res.ok || !res.body) {
      console.error(`pec-google-calendar-pull: list failed for calendar ${cal.calendar_id} (member ${member.id}, ${res.status})`);
      summary.errors++;
      await patchCalRow(cal.id, { last_error: `Google list failed (${res.status})` });
      return;
    }
    const ctx = {
      calendarId: cal.calendar_id,
      defaultType: cfg.defaultType,
      readonlyReason: (ev) => importGuardrailReason(ev, cal),
    };
    for (const ev of res.body.items || []) {
      // Cancellations must pass through even when the filter would skip the
      // live event (e.g. a declined invite later removed): the row may exist
      // from before the setting flipped.
      if (ev && ev.status !== 'cancelled' && shouldSkipImportedEvent(ev, cfg)) { summary.skipped++; continue; }
      try { await processEvent(member, ev, summary, ctx); }
      catch (err) {
        console.error(`pec-google-calendar-pull: event ${ev && ev.id} (calendar ${cal.calendar_id}) failed:`, err && err.message || err);
        summary.errors++;
      }
    }
    if (res.body.nextPageToken) { pageToken = res.body.nextPageToken; continue; }
    await patchCalRow(cal.id, {
      sync_token: res.body.nextSyncToken || null,
      last_synced_at: new Date().toISOString(),
      last_error: null,
    });
    return;
  }
  console.warn(`pec-google-calendar-pull: page cap hit for calendar ${cal.calendar_id} (member ${member.id}); the rest lands next tick`);
  await patchCalRow(cal.id, { last_synced_at: new Date().toISOString(), last_error: null });
}

async function pullMemberCalendars(member, cfg, summary) {
  let cals;
  try {
    cals = await sb('GET', `/pec_sales_member_google_calendars?member_id=eq.${encodeURIComponent(member.id)}&sync_enabled=eq.true&select=*`);
  } catch (_) { return; } // pre-migration: multi-calendar is simply off
  // The dedicated TopCoat calendar is ALWAYS skipped here, ticked or not: it
  // is the push target, owned by the legacy per-member token path above.
  cals = (Array.isArray(cals) ? cals : []).filter(c => c.calendar_id && c.calendar_id !== member.google_calendar_id);
  if (!cals.length) return;
  const token = await getFreshAccessToken(sb, member.id);
  if (!token) return;
  for (const cal of cals) {
    summary.calendars++;
    try { await pullOneCalendar(member, cal, token, cfg, summary); }
    catch (err) {
      // One calendar's failure must not poison the member's others.
      console.error(`pec-google-calendar-pull: calendar ${cal.calendar_id} (member ${member.id}) failed:`, err && err.message || err);
      summary.errors++;
      await patchCalRow(cal.id, { last_error: String(err && err.message || err).slice(0, 300) });
    }
  }
}

exports.handler = async () => {
  const summary = { members: 0, members_skipped: 0, calendars: 0, created: 0, imported_created: 0, updated: 0, canceled: 0, echoes: 0, skipped: 0, errors: 0, not_configured: false, not_migrated: false };
  try {
    if (!googleConfigured()) { summary.not_configured = true; return json(200, { ok: true, ...summary }); }
    let members;
    try {
      members = await sb('GET', '/pec_sales_team_members?google_connected=eq.true&select=id,name,google_calendar_id');
    } catch (e) { summary.not_migrated = true; return json(200, { ok: true, ...summary }); }
    members = Array.isArray(members) ? members : [];
    summary.members = members.length;
    const cfg = await loadPullSettings();
    for (const m of members) {
      try { await pullMember(m, summary); }
      catch (err) {
        console.error(`pec-google-calendar-pull: member ${m.id} failed:`, err && err.message || err);
        summary.errors++;
      }
      try { await pullMemberCalendars(m, cfg, summary); }
      catch (err) {
        console.error(`pec-google-calendar-pull: member ${m.id} multi-calendar failed:`, err && err.message || err);
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

// Exported for the fixture test (mapping + echo rule + the prompt-96 window,
// filter, and guardrail predicates are the fiddly parts).
module.exports.mapEventToRow = mapEventToRow;
module.exports.shouldSkipEcho = shouldSkipEcho;
module.exports.importGuardrailReason = importGuardrailReason;
module.exports.shouldSkipImportedEvent = shouldSkipImportedEvent;
module.exports.pullWindow = pullWindow;

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
