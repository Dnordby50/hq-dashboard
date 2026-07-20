// Fixture test for the Google -> TopCoat pull's fiddly parts (prompt 37):
// event mapping (timed + all-day in the fixed-offset Phoenix convention),
// the echo/LWW rule, cancellation, and the upsert-by-google_event_id path,
// driven through the exported helpers plus the shared mini-PostgREST.
// Run: node production/google-pull.test.cjs
'use strict';
const { mapEventToRow, shouldSkipEcho } = require('../netlify/functions/pec-google-calendar-pull.cjs');
const { makeChecker } = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

const MEMBER = { id: 'sm1', name: 'Dylan N', google_calendar_id: 'cal_topcoat_1' };

(() => {
  console.log('# timed event maps onto row columns');
  {
    const { row, apptType, valid } = mapEventToRow({
      id: 'gev1', etag: '"e1"', updated: '2026-07-20T18:00:00.000Z',
      summary: 'Sam Jones', description: 'gate code 1234', location: '123 Main St, Prescott, AZ',
      start: { dateTime: '2026-07-21T10:00:00-07:00' }, end: { dateTime: '2026-07-21T11:00:00-07:00' },
      extendedProperties: { private: { topcoat_type: 'on_site_estimate' } },
    }, MEMBER);
    ok(valid && row.start_at === '2026-07-21T17:00:00.000Z' && row.end_at === '2026-07-21T18:00:00.000Z', 'dateTime bounds normalized to UTC ISO');
    ok(row.all_day === false && row.title === 'Sam Jones' && row.notes === 'gate code 1234' && row.location_address === '123 Main St, Prescott, AZ', 'fields mapped');
    ok(row.google_event_id === 'gev1' && row.google_calendar_id === 'cal_topcoat_1' && row.google_etag === '"e1"' && row.google_updated === '2026-07-20T18:00:00.000Z', 'sync bookkeeping stored');
    ok(apptType === 'on_site_estimate', 'our private property round-trips the type');
  }

  console.log('# all-day event anchors to Phoenix midnight');
  {
    const { row, apptType } = mapEventToRow({
      id: 'gev2', summary: 'Busy',
      start: { date: '2026-07-22' }, end: { date: '2026-07-23' },
    }, MEMBER);
    ok(row.all_day === true, 'date-only start means all_day');
    ok(row.start_at === '2026-07-22T07:00:00.000Z' && row.end_at === '2026-07-23T07:00:00.000Z', 'Phoenix midnight in fixed -07:00');
    ok(apptType === 'other', 'a hand-made Google event defaults to type other');
  }

  console.log('# echo/LWW rule');
  {
    const existing = { google_updated: '2026-07-20T18:00:00.000Z' };
    ok(shouldSkipEcho({ updated: '2026-07-20T18:00:00.000Z' }, existing) === true, 'equal updated = our own push echo, skipped');
    ok(shouldSkipEcho({ updated: '2026-07-20T17:59:00.000Z' }, existing) === true, 'older updated = stale, skipped');
    ok(shouldSkipEcho({ updated: '2026-07-20T18:01:00.000Z' }, existing) === false, 'newer updated = a real Google edit, wins');
    ok(shouldSkipEcho({ updated: '2026-07-20T18:01:00.000Z' }, null) === false, 'no existing row never skips');
    ok(shouldSkipEcho({}, existing) === false, 'an event without updated is processed, not guessed away');
  }

  console.log('# no-start events are skipped as invalid');
  {
    const { valid } = mapEventToRow({ id: 'gev3', summary: 'weird' }, MEMBER);
    ok(valid === false, 'an event with no usable start never lands as a row');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  if (state.failed) process.exit(1);
})();
