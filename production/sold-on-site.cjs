'use strict';
// Prompt 94 C: the sold-on-site rule, ONE implementation shared by the accept
// path in pec-public-estimate.cjs and the dashboard's manual "Mark accepted"
// mirror (index.html deriveSoldOnSiteLocal; keep in lockstep).
//
// An accepted estimate is sold-on-site when accepted_at falls inside a
// matched appointment's window: [start_at - lookback, end_at + grace].
// The caller pre-matches appointments to the estimate (lead_id first, else
// customer_id; there is no estimate_id on pec_appointments by design) and
// passes the raw rows; this module filters by type + not-canceled and applies
// the window. The result is STAMPED at accept time (never derived live on a
// metrics render) so a later appointment edit cannot rewrite history, and a
// human override column always outranks it:
//   effective = coalesce(sold_on_site_override, sold_on_site, false)
//
// Appointment selection when more than one matches (locked decision,
// documented here because it is the kind of tie a future reader will ask
// about): the appointment whose start_at is nearest BEFORE accepted_at wins;
// ties take the smallest id so the pick is deterministic. When no matching
// appointment started before accepted_at (only reachable with a lookback,
// e.g. the customer signs while the rep is setting up), the earliest-starting
// one wins. The picked appointment is returned either way so the estimate
// page can show WHY the rule decided what it decided ("matched your 2:00 PM
// on-site estimate; accepted 3:14 PM").

const DEFAULT_GRACE_MINUTES = 120;
const DEFAULT_APPT_TYPES = ['on_site_estimate'];

// settings value ('on_site_estimate,site_visit') -> array; blank/invalid
// falls back to the default.
function parseApptTypes(value) {
  const arr = String(value == null ? '' : value)
    .split(',').map((s) => s.trim()).filter(Boolean);
  return arr.length ? arr : DEFAULT_APPT_TYPES.slice();
}

// -> { sold, appointment, reason }
//   sold: boolean       reason: 'no_appointment' | 'in_window' | 'outside_window'
//   appointment: the picked row (null when none matched at all)
function deriveSoldOnSite({ acceptedAt, appointments, graceMinutes, lookbackHours, apptTypes }) {
  const grace = Number(graceMinutes);
  const graceMs = (Number.isFinite(grace) && grace >= 0 ? grace : DEFAULT_GRACE_MINUTES) * 60000;
  const lb = Number(lookbackHours);
  const lookbackMs = (Number.isFinite(lb) && lb > 0 ? lb : 0) * 3600000;
  const types = Array.isArray(apptTypes) && apptTypes.length ? apptTypes.map(String) : DEFAULT_APPT_TYPES;
  const t = new Date(acceptedAt || '').getTime();
  if (!Number.isFinite(t)) return { sold: false, appointment: null, reason: 'no_appointment' };
  const cands = (Array.isArray(appointments) ? appointments : [])
    .filter((p) => p && types.includes(String(p.appt_type)) && String(p.status) !== 'canceled')
    .map((p) => ({ p, s: new Date(p.start_at).getTime(), e: new Date(p.end_at).getTime() }))
    .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.e));
  if (!cands.length) return { sold: false, appointment: null, reason: 'no_appointment' };
  const pick = (arr) => arr.slice().sort((a, b) => {
    const aBefore = a.s <= t, bBefore = b.s <= t;
    if (aBefore !== bBefore) return aBefore ? -1 : 1; // started-before beats upcoming
    if (aBefore && b.s !== a.s) return b.s - a.s;     // nearest before = latest start <= t
    if (!aBefore && a.s !== b.s) return a.s - b.s;    // else earliest upcoming
    return String(a.p.id) < String(b.p.id) ? -1 : 1;  // tie: smallest id, deterministic
  })[0];
  const inWin = cands.filter((x) => t >= x.s - lookbackMs && t <= x.e + graceMs);
  if (inWin.length) return { sold: true, appointment: pick(inWin).p, reason: 'in_window' };
  return { sold: false, appointment: pick(cands).p, reason: 'outside_window' };
}

module.exports = { deriveSoldOnSite, parseApptTypes, DEFAULT_GRACE_MINUTES, DEFAULT_APPT_TYPES };
