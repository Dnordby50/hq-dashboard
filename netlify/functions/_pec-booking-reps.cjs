'use strict';
// Online booking rep eligibility (prompt 105, 2026-09-21). THE one place the
// "who can the public book?" rule lives; the slots endpoint, the booking
// insert re-check, and the self-serve reschedule all call loadEligibleReps.
// No second copy of the rule exists on purpose (see the migration header
// for the Dusty double-book that motivated the split from roster `active`).
//
// Eligible = active = true AND bookable_online = true AND
//            (google_connected = true OR booking_require_google_connected is 'false')
//
// The query pre-filters on active only; isBookableRep is the whole rule so a
// reader can point at exactly one function. A read failure or a missing
// column (migration pending) yields NO reps: fail closed, never "all active".
//
// Assignment mode (booking_assignment_mode):
//   primary_first  (default) offer a slot when any eligible rep is free;
//                  assign the primary when the primary is free, else the
//                  next eligible rep by the round-robin order.
//   primary_only   slots come from the primary rep's calendar only.
//   round_robin    the prompt-101 behavior over the eligible list.
// A primary that is missing, inactive, or not eligible falls back to
// round_robin over the eligible list and surfaces `warning` (Settings >
// Booking shows it). With one eligible rep all three modes are identical.

const REP_SELECT = 'id,name,active,bookable_online,google_connected,google_calendar_id,google_connected_at,google_needs_reconnect';
const MODES = ['primary_first', 'primary_only', 'round_robin'];

const cleanStr = (s) => { const v = String(s == null ? '' : s).trim(); return v || null; };

function requireGoogleConnected(settings) {
  return String((settings && settings.booking_require_google_connected) == null ? 'true' : settings.booking_require_google_connected).trim() !== 'false';
}

function assignmentModeSetting(settings) {
  const raw = cleanStr(settings && settings.booking_assignment_mode);
  return MODES.includes(raw) ? raw : 'primary_first';
}

// The rule. Boolean-strict on purpose: an undefined bookable_online (column
// not there yet) is NOT eligible.
function isBookableRep(rep, settings) {
  if (!rep || rep.active !== true || rep.bookable_online !== true) return false;
  return rep.google_connected === true || !requireGoogleConnected(settings);
}

// Pure resolution over already-loaded rows (the tests and the Settings card
// use this shape too). Returns { reps, mode, requestedMode, primaryId, warning }.
function resolveEligibility(rows, settings) {
  const reps = (Array.isArray(rows) ? rows : []).filter(r => isBookableRep(r, settings));
  const requestedMode = assignmentModeSetting(settings);
  const primaryIdRaw = cleanStr(settings && settings.booking_primary_member_id);
  const primaryRow = primaryIdRaw ? (Array.isArray(rows) ? rows : []).find(r => r && r.id === primaryIdRaw) : null;
  const primaryEligible = !!(primaryRow && reps.some(r => r.id === primaryIdRaw));
  let mode = requestedMode;
  let warning = null;
  if (!primaryEligible && requestedMode !== 'round_robin') {
    mode = 'round_robin';
    warning = !primaryIdRaw ? 'No primary rep is set; bookings rotate across everyone bookable online.'
      : !primaryRow ? 'The primary rep is not on the roster; bookings rotate across everyone bookable online.'
      : primaryRow.active !== true ? `${primaryRow.name || 'The primary rep'} is inactive; bookings rotate across everyone bookable online.`
      : `${primaryRow.name || 'The primary rep'} is not bookable online; bookings rotate across everyone bookable online.`;
  }
  return { reps, mode, requestedMode, primaryId: primaryEligible ? primaryIdRaw : null, warning };
}

async function loadEligibleReps(db, settings) {
  let rows = [];
  try {
    rows = await db('GET', `/pec_sales_team_members?active=eq.true&select=${REP_SELECT}&order=name`);
    if (!Array.isArray(rows)) throw new Error('roster response was not a list');
  } catch (e) {
    // Fail closed (locked decision 5): an unreadable roster offers nothing.
    console.warn('pec-booking: roster read failed, no rep is bookable:', e && e.message);
    return { ...resolveEligibility([], settings), error: String(e && e.message || e) };
  }
  return resolveEligibility(rows, settings);
}

module.exports = { loadEligibleReps, resolveEligibility, isBookableRep, assignmentModeSetting, requireGoogleConnected, MODES, REP_SELECT };
