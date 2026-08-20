'use strict';
// Prompt 101 Part B: the booking availability engine (pure module).
// Run: node production/booking-availability.test.cjs

const { computeSlots, addrKey, HOME_KEY } = require('./booking-availability.cjs');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${label}`); }
}

// Phoenix is fixed -07:00: "HH:MM Phoenix on day D" = UTC HH+7.
// Base Monday: 2026-08-24. phx('2026-08-24','09:00') -> 2026-08-24T16:00:00Z.
const phx = (day, hhmm) => new Date(`${day}T${hhmm}:00-07:00`).toISOString();

const HOURS = {
  mon: ['08:00', '17:00'], tue: ['08:00', '17:00'], wed: ['08:00', '17:00'],
  thu: ['08:00', '17:00'], fri: ['08:00', '17:00'], sat: null, sun: null,
};
const REP_A = { id: 'aaaaaaaa-0000-0000-0000-000000000001' };
const REP_B = { id: 'bbbbbbbb-0000-0000-0000-000000000002' };

let seq = 0;
const busyRow = (rep, startIso, endIso, over = {}) => ({
  id: `busy-${++seq}`, sales_member_id: rep ? rep.id : null,
  start_at: startIso, end_at: endIso, all_day: false,
  status: 'scheduled', source: 'topcoat', ...over,
});

// now = Monday 07:00 Phoenix; min notice 120 -> boundary 09:00 Phoenix.
const NOW = phx('2026-08-24', '07:00');
const base = (over = {}) => ({
  now: new Date(NOW), reps: [REP_A], busy: [], workingHours: HOURS,
  config: { horizonDays: 7 }, driveTimes: {}, ...over,
});
const startsOn = (slots, day) => slots.filter(s => s.start.startsWith(new Date(phx(day, '12:00')).toISOString().slice(0, 10)) || new Date(s.start).getTime() >= new Date(phx(day, '00:00')).getTime() && new Date(s.start).getTime() < new Date(phx(day, '00:00')).getTime() + 86400000).map(s => s.start);
const hasStart = (slots, day, hhmm) => slots.some(s => s.start === phx(day, hhmm));

// 9. Empty calendar returns a full day of slots.
{
  const slots = computeSlots(base());
  // Tuesday (fully past the notice window): home-base default buffer 30 makes
  // the first start 08:30 and the last 15:30 (end 16:30 + 30 home = 17:00).
  const tue = slots.filter(s => s.start >= phx('2026-08-25', '00:00') && s.start < phx('2026-08-26', '00:00'));
  ok(tue.length === 15, `empty calendar: full Tuesday of slots (got ${tue.length}, want 15)`);
  ok(tue[0].start === phx('2026-08-25', '08:30'), 'empty calendar: first slot 08:30 (home-base buffer)');
  ok(tue[tue.length - 1].start === phx('2026-08-25', '15:30'), 'empty calendar: last slot 15:30 (home-base buffer at close)');
  ok(tue.every(s => s.sales_member_id === REP_A.id), 'single rep: every slot is theirs');
}

// 3. Min-notice boundary: exactly at the boundary offered, one minute inside is not.
{
  const slots = computeSlots(base());
  ok(hasStart(slots, '2026-08-24', '09:00'), 'min notice: slot exactly at now+120min is offered');
  ok(!hasStart(slots, '2026-08-24', '08:30'), 'min notice: slot inside the notice window is not offered');
  const slots2 = computeSlots(base({ now: new Date(phx('2026-08-24', '07:01')) }));
  ok(!hasStart(slots2, '2026-08-24', '09:00'), 'min notice: one minute inside the boundary is not offered');
  ok(hasStart(slots2, '2026-08-24', '09:30'), 'min notice: the next grid slot is offered');
}

// 4. Horizon boundary: through now + horizon_days inclusive, nothing past it.
{
  // now Monday 09:00 Phoenix, horizon 2 days -> end Wednesday 09:00 Phoenix.
  const slots = computeSlots(base({ now: new Date(phx('2026-08-24', '09:00')), config: { horizonDays: 2 } }));
  ok(hasStart(slots, '2026-08-26', '09:00'), 'horizon: slot exactly at the horizon boundary is offered');
  ok(!hasStart(slots, '2026-08-26', '09:30'), 'horizon: slot past the boundary is not offered');
}

// 1. Buffer math: long drive on one side, short on the other.
{
  const A = { location_address: '1 Far Rd', location_city: 'Prescott', location_zip: '86301' };
  const B = { location_address: '2 Near St', location_city: 'Prescott', location_zip: '86301' };
  const busy = [
    busyRow(REP_A, phx('2026-08-25', '10:00'), phx('2026-08-25', '11:00'), A),
    busyRow(REP_A, phx('2026-08-25', '13:30'), phx('2026-08-25', '14:30'), B),
  ];
  const driveTimes = {
    [addrKey(A.location_address, A.location_city, A.location_zip)]: 60,
    [addrKey(B.location_address, B.location_city, B.location_zip)]: 20,
    [HOME_KEY]: 20,
  };
  const slots = computeSlots(base({ busy, driveTimes }));
  ok(!hasStart(slots, '2026-08-25', '11:30'), 'buffer: 30-min gap after a 60-min drive neighbor is not offered');
  ok(hasStart(slots, '2026-08-25', '12:00'), 'buffer: 60-min gap clears the 60-min drive neighbor');
  // 12:00-13:00 must ALSO clear the following near block (gap 30 >= 20).
  ok(!hasStart(slots, '2026-08-25', '13:00'), 'buffer: flush against the following block is not offered');
  // Before the far block: even 08:30-09:30 leaves only 30 min to a
  // 60-min-away job, so the whole morning ahead of it is honestly closed.
  ok(!hasStart(slots, '2026-08-25', '08:30'), 'buffer: slot too close BEFORE a far neighbor is not offered');
  ok(!hasStart(slots, '2026-08-25', '09:30'), 'buffer: overlap-adjacent slot before the far neighbor is not offered');
}

// Buffer fallback: neighbor with no drive-time entry uses the default (30).
{
  const busy = [busyRow(REP_A, phx('2026-08-25', '10:00'), phx('2026-08-25', '11:00'))];
  const slots = computeSlots(base({ busy, driveTimes: { [HOME_KEY]: 20 } }));
  ok(!hasStart(slots, '2026-08-25', '11:00'), 'fallback buffer: flush slot blocked');
  ok(hasStart(slots, '2026-08-25', '11:30'), 'fallback buffer: 30-min default gap clears');
  ok(hasStart(slots, '2026-08-25', '08:30'), 'home buffer: 20-min home drive allows an 08:30 first slot');
}

// 2. All-day event blocks the whole day for that rep.
{
  const busy = [busyRow(REP_A, phx('2026-08-25', '00:00'), phx('2026-08-26', '00:00'), { all_day: true })];
  const slots = computeSlots(base({ busy }));
  ok(!slots.some(s => s.start >= phx('2026-08-25', '00:00') && s.start < phx('2026-08-26', '00:00')),
    'all-day: no Tuesday slots');
  ok(hasStart(slots, '2026-08-26', '08:30'), 'all-day: Wednesday unaffected');
}

// 5. A canceled appointment does not block.
{
  const busy = [busyRow(REP_A, phx('2026-08-25', '10:00'), phx('2026-08-25', '11:00'), { status: 'canceled' })];
  const slots = computeSlots(base({ busy }));
  ok(hasStart(slots, '2026-08-25', '10:00'), 'canceled: its slot is offered');
}

// 6. A source=google focus block DOES block.
{
  const busy = [busyRow(REP_A, phx('2026-08-25', '10:00'), phx('2026-08-25', '11:00'), { source: 'google' })];
  const slots = computeSlots(base({ busy }));
  ok(!hasStart(slots, '2026-08-25', '10:00'), 'google: imported block blocks its slot');
  ok(!hasStart(slots, '2026-08-25', '10:30'), 'google: overlap blocked');
}

// Reschedule: the row being moved never blocks its own new slot list.
{
  const row = busyRow(REP_A, phx('2026-08-25', '10:00'), phx('2026-08-25', '11:00'));
  const slots = computeSlots(base({ busy: [row], config: { horizonDays: 7, excludeApptId: row.id } }));
  ok(hasStart(slots, '2026-08-25', '10:00'), 'reschedule: own block excluded from busy');
}

// An unassigned scheduled row blocks every rep.
{
  const busy = [busyRow(null, phx('2026-08-25', '10:00'), phx('2026-08-25', '11:00'))];
  const slots = computeSlots(base({ reps: [REP_A, REP_B], busy }));
  ok(!hasStart(slots, '2026-08-25', '10:00'), 'unassigned scheduled row blocks the slot for everyone');
}

// 8. Round robin over one rep returns that rep, no special case.
{
  const slots = computeSlots(base());
  ok(slots.length > 0 && slots.every(s => s.sales_member_id === REP_A.id), 'one rep: every slot assigned to them');
}

// 7. Round robin over two reps distributes by booking load, then next-appt.
{
  // Rep A already carries one source='booking' appointment in the horizon:
  // every open slot goes to B (fewest bookings).
  const busy = [busyRow(REP_A, phx('2026-08-26', '10:00'), phx('2026-08-26', '11:00'), { source: 'booking' })];
  const slots = computeSlots(base({ reps: [REP_A, REP_B], busy }));
  const tue = slots.filter(s => s.start >= phx('2026-08-25', '00:00') && s.start < phx('2026-08-26', '00:00'));
  ok(tue.length > 0 && tue.every(s => s.sales_member_id === REP_B.id), 'two reps: booking load routes new slots to the lighter rep');

  // Equal load: the rep with the EARLIER next appointment absorbs the slot.
  const busy2 = [busyRow(REP_A, phx('2026-08-25', '13:00'), phx('2026-08-25', '14:00'), { source: 'topcoat' })];
  const slots2 = computeSlots(base({ reps: [REP_A, REP_B], busy2: null, busy: busy2 }));
  const nine = slots2.find(s => s.start === phx('2026-08-25', '09:00'));
  ok(nine && nine.sales_member_id === REP_A.id, 'two reps: equal load ties break to the rep with the earlier next appointment');
  // And a slot only ONE rep can take is still offered (offered if ANY rep free).
  const eleven30 = slots2.find(s => s.start === phx('2026-08-25', '13:00'));
  ok(eleven30 && eleven30.sales_member_id === REP_B.id, 'two reps: a slot one rep is busy for is offered through the other');
}

// 10. A rep with no working hours for that weekday returns none.
{
  const slots = computeSlots(base({ config: { horizonDays: 7 } }));
  ok(!slots.some(s => {
    const t = new Date(s.start).getTime() - 7 * 3600 * 1000;
    const wd = new Date(t).getUTCDay();
    return wd === 0 || wd === 6;
  }), 'weekend (null hours) produces no slots');
  const perRep = { [REP_A.id]: { ...HOURS, tue: null } };
  const slots2 = computeSlots(base({ workingHours: perRep }));
  ok(!slots2.some(s => s.start >= phx('2026-08-25', '00:00') && s.start < phx('2026-08-26', '00:00')),
    'per-rep null weekday produces no slots that day');
}

console.log(`booking-availability: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
