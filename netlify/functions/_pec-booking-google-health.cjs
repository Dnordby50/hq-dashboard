'use strict';

// A connected flag or a recent worker heartbeat cannot prove every source
// calendar was imported. Only each calendar's completed recovery baseline
// and last completed pull can establish safe availability.
function googleBookingMaxAgeMinutes(settings = {}) {
  const raw = settings.google_booking_max_sync_age_minutes;
  const parsed = Number(raw);
  const value = raw != null && String(raw).trim() !== '' && Number.isFinite(parsed) ? parsed : 45;
  return Math.max(15, Math.min(1440, value));
}

function googleCalendarHealthAllowsBooking(rep, calendars, settings, now) {
  const dedicatedId = rep.google_calendar_id || null;
  const required = calendars.filter(c => c.member_id === rep.id
    && (c.sync_enabled === true || (dedicatedId && c.calendar_id === dedicatedId)));
  // A never-connected member with no enabled source has no Google
  // dependency. A disconnected member with retained sources still does.
  if (!required.length && !dedicatedId && !rep.google_needs_reconnect && rep.google_connected !== true) return true;
  if (rep.google_connected !== true || rep.google_needs_reconnect === true) return false;
  if (!required.length) return false;
  if (dedicatedId && !required.some(c => c.calendar_id === dedicatedId)) return false;

  const nowMs = now.getTime();
  const oldest = nowMs - googleBookingMaxAgeMinutes(settings) * 60000;
  const connectedAt = rep.google_connected_at == null ? null : Date.parse(rep.google_connected_at);
  if (connectedAt != null && !Number.isFinite(connectedAt)) return false;
  return required.every(c => {
    const completedAt = c.last_synced_at == null ? NaN : Date.parse(c.last_synced_at);
    return Number(c.pull_version || 0) >= 2
      && !String(c.last_error || '').trim()
      && Number.isFinite(completedAt)
      // The sync can complete between request-clock capture and this read.
      && completedAt >= oldest && completedAt <= nowMs + 60000
      && (connectedAt == null || completedAt >= connectedAt);
  });
}

async function repsWithVerifiedGoogleCalendars(db, reps, settings, now) {
  if (!reps.length) return { reps: [], unavailableCount: 0 };
  try {
    const ids = reps.map(r => encodeURIComponent(r.id)).join(',');
    const rows = await db('GET', `/pec_sales_member_google_calendars?member_id=in.(${ids})`
      + '&select=member_id,calendar_id,sync_enabled,last_synced_at,last_error,pull_version');
    if (!Array.isArray(rows)) throw new Error('Calendar health response was not a list');
    const eligible = reps.filter(rep => googleCalendarHealthAllowsBooking(rep, rows, settings, now));
    return { reps: eligible, unavailableCount: reps.length - eligible.length };
  } catch (err) {
    // An unknown calendar state must never be interpreted as free time.
    console.warn('pec-booking: calendar health could not be verified:', err && err.message);
    return { reps: [], unavailableCount: reps.length };
  }
}

module.exports = { googleBookingMaxAgeMinutes, googleCalendarHealthAllowsBooking, repsWithVerifiedGoogleCalendars };
