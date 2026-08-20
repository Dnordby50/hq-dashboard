// TopCoat online booking: the availability engine (prompt 101 Part B).
//
// PURE MODULE by design: no network, no database, no clock reads. Inputs in,
// slots out, so the whole thing is testable and the public endpoint and the
// booking re-check run the SAME function (rule B6: never emit a slot the
// write path would reject; the endpoint re-runs computeSlots with fresh busy
// rows before writing, and the Postgres advisory-lock function is the last
// fence for the race the re-check cannot close).
//
// Timezone: America/Phoenix at the project's FIXED -07:00 convention
// (Arizona does not observe DST). All math is UTC milliseconds; Phoenix is
// only a rendering/wall-clock concern, handled by adding/subtracting the
// fixed offset.
//
// computeSlots({ now, reps, busy, workingHours, config, driveTimes })
//   -> [{ start, end, sales_member_id, buffer_before, buffer_after }]
//      (start/end ISO strings, buffers in minutes, sorted by start)
//
//   now          Date or ms. The engine never calls Date.now() itself.
//   reps         [{ id }] booking-enabled reps (the endpoint passes active
//                roster members). One rep degrades naturally: every offered
//                slot is theirs, no special case (locked decision 3).
//   busy         pec_appointments-shaped rows for the window:
//                { id, sales_member_id, start_at, end_at, all_day, status,
//                  source, location_address, location_city, location_zip }.
//                WHATEVER the source: a source='google' focus block is real
//                busy time (rule B3). status='canceled' rows and the row
//                being rescheduled (config.excludeApptId) never block.
//                Rows with sales_member_id NULL block EVERY rep: an
//                unassigned scheduled visit is still a visit someone must
//                make, and offering over it risks a double-book.
//   workingHours { mon: ["08:00","17:00"] | null, ... } Phoenix wall clock.
//                Per-rep override: workingHours[rep.id] = that same map.
//   config       see DEFAULTS below. Durations/granularity/buffers minutes.
//   driveTimes   { [addrKey]: minutes } drive minutes from that neighbor's
//                address TO the customer's address (symmetric enough for
//                buffer purposes). Missing key -> bufferDefaultMinutes.
//                HOME_KEY is the home-base pair (rule B4: the first and last
//                appointment of a rep's day measure against home base).
//
// Buffer rule (B4): a candidate must clear its NEAREST preceding busy block
// by clamp(driveMinutes, bufferMin, bufferMax) and its nearest following
// block the same way. Only the nearest neighbor matters (the rep physically
// drives from there); a farther block never constrains. With no preceding
// block, the boundary is the working-day start measured from home base
// (the rep leaves home at day start and must be able to arrive); with no
// following block, the working-day end (they must get home inside hours).
//
// Round robin (B5): a start time is offered if ANY rep is free for it.
// Assignment picks the free rep with the fewest source='booking'
// appointments in the horizon, tie-broken by the earliest next scheduled
// appointment at-or-after the slot (the rep already heading out soonest
// absorbs the booking, which keeps the other rep's day from clumping), then
// by rep id for determinism.

'use strict';

const PHX_OFFSET_MS = 7 * 3600 * 1000; // fixed -07:00, no DST in Arizona
const DAY_MS = 24 * 3600 * 1000;
const MIN_MS = 60 * 1000;

const HOME_KEY = '__home__';

const DEFAULTS = {
  slotGranularityMinutes: 30,
  durationMinutes: 60,
  minNoticeMinutes: 120,
  horizonDays: 30,
  bufferMinMinutes: 20,
  bufferMaxMinutes: 90,
  bufferDefaultMinutes: 30,
  excludeApptId: null,
};

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Normalized address key for the driveTimes map: lowercased, collapsed
// whitespace, street line plus city plus zip (enough to be distinct across a
// service area without being brittle about commas). Exported so the endpoint
// builds keys the same way it asks the drive-time module to resolve them.
function addrKey(address, city, zip) {
  const s = [address, city, zip].map(v => String(v == null ? '' : v).trim()).filter(Boolean).join(' ');
  return s.toLowerCase().replace(/\s+/g, ' ') || null;
}

function busyAddrKey(b) {
  return addrKey(b.location_address, b.location_city, b.location_zip);
}

// Phoenix calendar parts for a UTC instant.
function phxParts(ms) {
  const d = new Date(ms - PHX_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(),
    weekday: WEEKDAY_KEYS[d.getUTCDay()],
  };
}

// UTC instant for a Phoenix wall-clock "HH:MM" on a Phoenix calendar day.
function phxWallToUtc(y, m, d, hhmm) {
  const mm = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!mm) return null;
  return Date.UTC(y, m, d, Number(mm[1]), Number(mm[2])) + PHX_OFFSET_MS;
}

function clampBuffer(driveMinutes, cfg) {
  if (driveMinutes == null || !isFinite(driveMinutes)) return cfg.bufferDefaultMinutes;
  return Math.min(Math.max(Math.round(driveMinutes), cfg.bufferMinMinutes), cfg.bufferMaxMinutes);
}

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}

function computeSlots({ now, reps, busy, workingHours, config, driveTimes }) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const nowMs = toMs(now);
  const drive = driveTimes || {};
  const wh = workingHours || {};
  const repList = (reps || []).filter(r => r && r.id);
  if (nowMs == null || !repList.length) return [];

  const noticeBoundary = nowMs + cfg.minNoticeMinutes * MIN_MS;
  const horizonEnd = nowMs + cfg.horizonDays * DAY_MS;
  const durMs = cfg.durationMinutes * MIN_MS;
  const granMs = cfg.slotGranularityMinutes * MIN_MS;

  // Blocking rows, normalized once. Unassigned (null member) rows land in
  // every rep's list.
  const blocking = [];
  for (const b of (busy || [])) {
    if (!b || b.status !== 'scheduled') continue;
    if (cfg.excludeApptId && b.id === cfg.excludeApptId) continue;
    const s = toMs(b.start_at), e = toMs(b.end_at);
    if (s == null || e == null) continue;
    blocking.push({ ...b, _s: s, _e: e });
  }
  const repBusy = new Map(repList.map(r => [r.id, []]));
  for (const b of blocking) {
    if (b.sales_member_id == null) {
      for (const list of repBusy.values()) list.push(b);
    } else if (repBusy.has(b.sales_member_id)) {
      repBusy.get(b.sales_member_id).push(b);
    }
  }
  for (const list of repBusy.values()) list.sort((a, b) => a._s - b._s);

  // Round-robin inputs: booking-load and next-appointment lookups per rep.
  const bookingCount = new Map(repList.map(r => [r.id, 0]));
  for (const b of blocking) {
    if (b.source === 'booking' && b.sales_member_id != null
      && b._s >= nowMs && b._s <= horizonEnd && bookingCount.has(b.sales_member_id)) {
      bookingCount.set(b.sales_member_id, bookingCount.get(b.sales_member_id) + 1);
    }
  }
  const nextApptAfter = (repId, ms) => {
    const list = repBusy.get(repId) || [];
    for (const b of list) if (b._s >= ms) return b._s;
    return Infinity;
  };

  const hoursFor = (rep, weekday) => {
    const perRep = wh[rep.id];
    const map = (perRep && typeof perRep === 'object') ? perRep : wh;
    const h = map ? map[weekday] : null;
    return (Array.isArray(h) && h.length === 2) ? h : null;
  };

  // offersByStart: startMs -> [{ rep, bufBefore, bufAfter }]
  const offersByStart = new Map();

  const firstDay = phxParts(nowMs);
  for (let dayOff = 0; dayOff <= cfg.horizonDays; dayOff++) {
    // Anchor each day at Phoenix noon of the first day plus N days, then
    // re-derive parts: immune to any month-boundary arithmetic slips.
    const anchor = Date.UTC(firstDay.y, firstDay.m, firstDay.d + dayOff, 12) + PHX_OFFSET_MS;
    const parts = phxParts(anchor);

    for (const rep of repList) {
      const hours = hoursFor(rep, parts.weekday);
      if (!hours) continue;
      const dayStart = phxWallToUtc(parts.y, parts.m, parts.d, hours[0]);
      const dayEnd = phxWallToUtc(parts.y, parts.m, parts.d, hours[1]);
      if (dayStart == null || dayEnd == null || dayEnd <= dayStart) continue;

      const list = repBusy.get(rep.id) || [];
      // All-day row touching this Phoenix date blocks the rep's whole day.
      const dayBlocked = list.some(b => b.all_day === true && b._s < dayEnd && b._e > dayStart);
      if (dayBlocked) continue;
      const dayList = list.filter(b => !b.all_day && b._e > dayStart && b._s < dayEnd);

      for (let s = dayStart; s + durMs <= dayEnd; s += granMs) {
        if (s < noticeBoundary) continue;   // exactly at the boundary is offered
        if (s > horizonEnd) break;
        const e = s + durMs;

        let overlapped = false;
        let preceding = null, following = null;
        for (const b of dayList) {
          if (b._s < e && b._e > s) { overlapped = true; break; }
          if (b._e <= s && (!preceding || b._e > preceding._e)) preceding = b;
          if (b._s >= e && (!following || b._s < following._s)) following = b;
        }
        if (overlapped) continue;

        const beforeKey = preceding ? busyAddrKey(preceding) : HOME_KEY;
        const afterKey = following ? busyAddrKey(following) : HOME_KEY;
        const bufBefore = clampBuffer(beforeKey != null ? drive[beforeKey] : undefined, cfg);
        const bufAfter = clampBuffer(afterKey != null ? drive[afterKey] : undefined, cfg);

        const gapBefore = preceding ? (s - preceding._e) : (s - dayStart);
        const gapAfter = following ? (following._s - e) : (dayEnd - e);
        // First slot of the day: the rep leaves home base at day start, so a
        // slot flush against opening only works when the drive fits. Same
        // shape at close: they get home inside working hours.
        if (gapBefore < bufBefore * MIN_MS) continue;
        if (gapAfter < bufAfter * MIN_MS) continue;

        if (!offersByStart.has(s)) offersByStart.set(s, []);
        offersByStart.get(s).push({ rep, bufBefore, bufAfter });
      }
    }
  }

  // Assignment (rule B5).
  const out = [];
  const starts = [...offersByStart.keys()].sort((a, b) => a - b);
  for (const s of starts) {
    const candidates = offersByStart.get(s);
    candidates.sort((a, b) => {
      const loadA = bookingCount.get(a.rep.id) || 0;
      const loadB = bookingCount.get(b.rep.id) || 0;
      if (loadA !== loadB) return loadA - loadB;
      const nextA = nextApptAfter(a.rep.id, s);
      const nextB = nextApptAfter(b.rep.id, s);
      if (nextA !== nextB) return nextA - nextB;
      return String(a.rep.id).localeCompare(String(b.rep.id));
    });
    const pick = candidates[0];
    out.push({
      start: new Date(s).toISOString(),
      end: new Date(s + durMs).toISOString(),
      sales_member_id: pick.rep.id,
      buffer_before: pick.bufBefore,
      buffer_after: pick.bufAfter,
    });
  }
  return out;
}

module.exports = { computeSlots, addrKey, busyAddrKey, clampBuffer, HOME_KEY, DEFAULTS, PHX_OFFSET_MS };
