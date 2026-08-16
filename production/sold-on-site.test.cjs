'use strict';
// Prompt 94 C: the sold-on-site rule (production/sold-on-site.cjs).

const { deriveSoldOnSite, parseApptTypes } = require('./sold-on-site.cjs');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${label}`); }
}

const appt = (id, startIso, endIso, over = {}) => ({
  id, appt_type: 'on_site_estimate', status: 'scheduled', start_at: startIso, end_at: endIso, ...over,
});
const run = (acceptedAt, appointments, opts = {}) =>
  deriveSoldOnSite({ acceptedAt, appointments, graceMinutes: 120, lookbackHours: 0, apptTypes: ['on_site_estimate'], ...opts });

// In window: accepted during the appointment.
{
  const r = run('2026-08-16T21:30:00Z', [appt('a1', '2026-08-16T21:00:00Z', '2026-08-16T22:00:00Z')]);
  ok(r.sold === true && r.appointment.id === 'a1' && r.reason === 'in_window', 'accepted mid-appointment is sold on site');
}
// Grace: accepted 90 min after end_at, inside the 120-min grace.
{
  const r = run('2026-08-16T23:30:00Z', [appt('a1', '2026-08-16T21:00:00Z', '2026-08-16T22:00:00Z')]);
  ok(r.sold === true, 'accepted inside the grace window counts');
}
// Past grace: 121 minutes after end_at.
{
  const r = run('2026-08-17T00:01:00Z', [appt('a1', '2026-08-16T21:00:00Z', '2026-08-16T22:00:00Z')]);
  ok(r.sold === false && r.reason === 'outside_window' && r.appointment.id === 'a1',
    'past the grace is not sold on site, but the nearest appointment is still returned for the audit note');
}
// Lookback off: accepted 10 min BEFORE start_at does not count...
{
  const r = run('2026-08-16T20:50:00Z', [appt('a1', '2026-08-16T21:00:00Z', '2026-08-16T22:00:00Z')]);
  ok(r.sold === false, 'zero lookback: an accept before start_at is not sold on site');
}
// ...but counts with lookback_hours = 1.
{
  const r = run('2026-08-16T20:50:00Z', [appt('a1', '2026-08-16T21:00:00Z', '2026-08-16T22:00:00Z')], { lookbackHours: 1 });
  ok(r.sold === true, 'a lookback lets a sign-while-setting-up accept count');
}
// Canceled and wrong-type appointments never match.
{
  const r = run('2026-08-16T21:30:00Z', [
    appt('a1', '2026-08-16T21:00:00Z', '2026-08-16T22:00:00Z', { status: 'canceled' }),
    appt('a2', '2026-08-16T21:00:00Z', '2026-08-16T22:00:00Z', { appt_type: 'site_visit' }),
  ]);
  ok(r.sold === false && r.appointment === null && r.reason === 'no_appointment', 'canceled + wrong type = no match, not sold');
}
// Tunable types: site_visit counts when the setting includes it.
{
  const r = run('2026-08-16T21:30:00Z', [appt('a2', '2026-08-16T21:00:00Z', '2026-08-16T22:00:00Z', { appt_type: 'site_visit' })],
    { apptTypes: ['on_site_estimate', 'site_visit'] });
  ok(r.sold === true, 'sold_on_site_appt_types widens the match');
}
// Two matches: nearest start_at BEFORE accepted_at wins.
{
  const r = run('2026-08-16T21:30:00Z', [
    appt('a-early', '2026-08-16T15:00:00Z', '2026-08-16T16:00:00Z'),
    appt('a-near', '2026-08-16T21:00:00Z', '2026-08-16T22:00:00Z'),
  ]);
  ok(r.sold === true && r.appointment.id === 'a-near', 'nearest-before appointment is picked');
}
// Identical start times: smallest id, deterministically.
{
  const r = run('2026-08-16T21:30:00Z', [
    appt('b', '2026-08-16T21:00:00Z', '2026-08-16T22:00:00Z'),
    appt('a', '2026-08-16T21:00:00Z', '2026-08-16T22:00:00Z'),
  ]);
  ok(r.appointment.id === 'a', 'start_at tie broken by smallest id');
}
// No appointments at all = no match (not "unknown"), rule C1.
{
  const r = run('2026-08-16T21:30:00Z', []);
  ok(r.sold === false && r.reason === 'no_appointment', 'no matching appointment = not sold on site');
}
// Garbage in, false out.
{
  ok(run(null, [appt('a1', '2026-08-16T21:00:00Z', '2026-08-16T22:00:00Z')]).sold === false, 'null accepted_at derives false');
  ok(run('2026-08-16T21:30:00Z', [appt('a1', 'nope', 'nope')]).sold === false, 'unparseable appointment times are skipped');
}
// parseApptTypes
{
  ok(JSON.stringify(parseApptTypes('on_site_estimate, site_visit')) === JSON.stringify(['on_site_estimate', 'site_visit']), 'comma list parses with trim');
  ok(JSON.stringify(parseApptTypes('')) === JSON.stringify(['on_site_estimate']), 'blank falls back to the default');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
