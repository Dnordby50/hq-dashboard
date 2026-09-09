// Google -> TopCoat scheduled pull. The resumable engine is shared with the
// staff-only manual endpoint; both coordinate through per-calendar leases.
const { json } = require('./_pec-supabase.cjs');
const { stripGcalDescription } = require('./_pec-google.cjs');

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

exports.handler = async () => {
  const { runGooglePull } = require('./_pec-google-pull.cjs');
  const out = await runGooglePull();
  return json(out.ok ? 200 : 503, out);
};
module.exports.mapEventToRow = mapEventToRow;
module.exports.shouldSkipEcho = shouldSkipEcho;
module.exports.importGuardrailReason = importGuardrailReason;
module.exports.shouldSkipImportedEvent = shouldSkipImportedEvent;
module.exports.pullWindow = pullWindow;
