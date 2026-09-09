// Fixture test for the Google -> TopCoat pull's fiddly parts (prompt 37):
// event mapping (timed + all-day in the fixed-offset Phoenix convention),
// the echo/LWW rule, cancellation, and the upsert-by-google_event_id path,
// driven through the exported helpers plus the shared mini-PostgREST.
// Run: node production/google-pull.test.cjs
'use strict';
const { mapEventToRow, shouldSkipEcho } = require('../netlify/functions/pec-google-calendar-pull.cjs');
const { composeGcalDescription, stripGcalDescription, GCAL_DESC_SEPARATOR } = require('../netlify/functions/_pec-google.cjs');
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

  console.log('# description compose/strip round-trip (prompt 38 notes split)');
  {
    const composed = composeGcalDescription('Bring the moisture meter.\nGate code 1234', [
      'Customer: Sam Jones (928) 555-1234',
      'Open in TopCoat: https://prescottepoxy.netlify.app/?appt=appt1',
    ]);
    ok(composed.startsWith('Bring the moisture meter.') && composed.includes('\n\n' + GCAL_DESC_SEPARATOR + '\n'), 'notes first, then the separator + contact block');
    ok(/Customer: Sam Jones/.test(composed) && /\?appt=appt1/.test(composed), 'contact line + deep link present');
    ok(!composed.includes('—'), 'no em dash in the composed description');
    ok(stripGcalDescription(composed) === 'Bring the moisture meter.\nGate code 1234', 'strip returns exactly the human-typed notes');
    const edited = composed.replace('Bring the moisture meter.', 'Bring the BIG grinder.');
    ok(stripGcalDescription(edited) === 'Bring the BIG grinder.\nGate code 1234', 'a Google-side edit above the separator survives, the auto block never lands in notes');
    ok(stripGcalDescription(composeGcalDescription('', ['Open in TopCoat: x'])) === null, 'block-only description strips to null notes');
    ok(stripGcalDescription('plain hand-typed text') === 'plain hand-typed text', 'a description with no separator passes through untouched');
    ok(composeGcalDescription('only notes', []) === 'only notes', 'no contact lines means no separator');
  }
  {
    const { row } = mapEventToRow({
      id: 'gev4', summary: 'Estimate',
      description: 'human note\n\n' + GCAL_DESC_SEPARATOR + '\nCustomer: X\nOpen in TopCoat: y',
      start: { dateTime: '2026-07-21T10:00:00-07:00' }, end: { dateTime: '2026-07-21T11:00:00-07:00' },
    }, MEMBER);
    ok(row.notes === 'human note', 'pull mapping ingests only the free-text part into notes');
  }

  console.log('# no-start events are skipped as invalid');
  {
    const { valid } = mapEventToRow({ id: 'gev3', summary: 'weird' }, MEMBER);
    ok(valid === false, 'an event with no usable start never lands as a row');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  if (state.failed) process.exit(1);
})();

// Real runner integration fixtures: no network, real CAS and pagination flow.
(async () => {
  const assert = require('node:assert/strict');
  const { runGooglePull, newPullState, pagePath, processEvents } = require('../netlify/functions/_pec-google-pull.cjs');
  const T = Date.parse('2026-09-09T17:00:00Z');
  const stamp = new Date(T).toISOString();
  const cfg = { windowDaysPast: 30, windowDaysFuture: 180, defaultType: 'other', includeAllDay: true, includeDeclined: false };
  const event = (id, extra = {}) => ({ id, updated: stamp, summary: id, start: { dateTime: '2026-09-09T13:00:00-07:00' }, end: { dateTime: '2026-09-09T14:00:00-07:00' }, organizer: { self: true }, ...extra });
  const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));
  let checks = 0;
  function check(value, message) { assert.ok(value, message); checks++; }
  function rig(options = {}) {
    let time = T;
    const member = { id: 'm1', name: 'Dylan', google_calendar_id: null, google_connected_at: '2026-08-01T00:00:00Z', google_connected: true };
    const cal = { id: 'c1', member_id: 'm1', calendar_id: 'personal', summary: 'Personal', access_role: 'owner', sync_enabled: true, sync_token: null, pull_state: null, pull_version: 0, last_synced_at: null, last_full_synced_at: null, last_attempt_at: null, lease_id: null, lease_until: null, ...options.cal };
    const tables = { pec_sales_team_members: [member], pec_sales_member_google_calendars: [cal], pec_appointments: clone(options.appointments || []), settings: [{ key: 'google_pull_max_pages_per_calendar', value: String(options.maxPages || 1) }], pec_heartbeats: [] };
    const calls = [], requests = [], heartbeat = [];
    const matches = (row, p) => [...p].every(([key, filter]) => {
      if (['select','order','limit','on_conflict'].includes(key)) return true;
      if (key === 'or') return !row.lease_until || row.lease_until < filter.match(/lease_until\.lt\.(.+)\)$/)[1];
      if (filter.startsWith('in.(')) return filter.slice(4,-1).split(',').map(v => v.replace(/^"|"$/g, '')).includes(String(row[key]));
      const dot = filter.indexOf('.'), op = filter.slice(0,dot), value = filter.slice(dot+1);
      if (op === 'is') return value === 'null' && row[key] == null;
      if (op === 'eq') return String(row[key]) === value;
      if (op === 'gt') return row[key] != null && row[key] > value;
      if (op === 'lt') return row[key] != null && row[key] < value;
      if (op === 'lte') return row[key] != null && row[key] <= value;
      throw Error('Unsupported fixture filter ' + filter);
    });
    const db = async (method, path, payload, opts = {}) => {
      calls.push({ method, path, payload: clone(payload), opts });
      const u = new URL('https://fixture.test' + path), table = u.pathname.slice(1), p = u.searchParams;
      await options.beforeDb?.({ method, table, p, payload, tables, opts });
      let found = tables[table].filter(r => matches(r, p));
      if (method === 'GET') {
        if (p.get('order')?.startsWith('id.asc')) found.sort((a,b) => a.id.localeCompare(b.id));
        if (p.get('order')?.startsWith('last_attempt_at')) found.sort((a,b) => (a.last_attempt_at || '').localeCompare(b.last_attempt_at || '') || a.id.localeCompare(b.id));
        return clone(found.slice(0, Number(p.get('limit')) || Infinity));
      }
      if (method === 'PATCH') { found.forEach(r => Object.assign(r, clone(payload))); return opts.returnRow ? clone(found) : null; }
      if (method === 'POST') {
        if (table === 'pec_appointments' && options.failInsert) throw Error('simulated database outage');
        for (const item of Array.isArray(payload) ? payload : [payload]) {
          if (table === 'pec_sales_member_google_calendars' && tables[table].some(c => c.member_id === item.member_id && c.calendar_id === item.calendar_id)) continue;
          tables[table].push({ id: 'a' + tables[table].length, updated_at: stamp, ...clone(item) });
        }
        return null;
      }
      throw Error('Unsupported fixture method');
    };
    const deps = { sb: db, now: () => time, googleConfigured: () => true, getFreshAccessToken: async () => 'fixture-token', writeHeartbeat: async (_, data) => heartbeat.push(data), gcalFetch: async (_token, _method, path, _payload, timeout) => { requests.push({ path, timeout }); return options.google ? options.google(path, tables, () => { time += 18000; }) : { ok: true, status: 200, body: { items: [], nextSyncToken: 'complete' } }; } };
    return { options, deps, tables, cal, member, calls, requests, heartbeat, db, advance: ms => { time += ms; } };
  }
  console.log('# durable Google runner regression cases');
  {
    const r = rig({ google: path => ({ ok: true, status: 200, body: path.includes('pageToken') ? { items: [event('b')], nextSyncToken: 's2' } : { items: [event('a')], nextPageToken: 'p2' } }) });
    let out = await runGooglePull(r.deps);
    check(out.pending === 1 && !out.complete && r.cal.pull_state.page_token === 'p2', 'page cap saves continuation without false completion');
    check(r.cal.last_synced_at === null && r.cal.sync_token === null, 'partial full never stamps completion or sync token');
    const first = new URL('https://x' + r.requests[0].path).searchParams;
    r.advance(15000);
    await runGooglePull(r.deps);
    const second = new URL('https://x' + r.requests[1].path).searchParams;
    check(second.get('pageToken') === 'p2' && second.get('timeMin') === first.get('timeMin') && second.get('timeMax') === first.get('timeMax'), 'next invocation resumes with identical full window');
    check(r.cal.pull_state.phase === 'reconcile' && !r.cal.last_synced_at, 'terminal full page waits for safe reconciliation');
    out = await runGooglePull(r.deps);
    check(out.complete && r.cal.sync_token === 's2' && r.cal.pull_version === 2 && !r.cal.pull_state, 'full completion commits terminal sync token once');
    check(r.tables.pec_appointments.length === 2 && r.tables.pec_appointments.every(a => a.source === 'google'), 'retry-safe inserts preserve imported source');
  }
  {
    const r = rig({ cal: { pull_version: 2, sync_token: 'old', last_synced_at: stamp, last_full_synced_at: stamp }, google: path => ({ ok: true, status: 200, body: path.includes('pageToken') ? { items: [], nextSyncToken: 'new' } : { items: [], nextPageToken: 'p2' } }) });
    await runGooglePull(r.deps); await runGooglePull(r.deps);
    const p = new URL('https://x' + r.requests[1].path).searchParams;
    check(p.get('syncToken') === 'old' && p.get('pageToken') === 'p2' && !p.has('timeMin'), 'incremental page retains original sync token');
    check(r.cal.sync_token === 'new', 'incremental token advances only on completed page');
  }
  {
    const r = rig({ failInsert: true, google: () => ({ ok: true, status: 200, body: { items: [event('failed')], nextSyncToken: 'after-failure' } }) });
    let out = await runGooglePull(r.deps);
    check(!out.ok && out.errors === 1 && !r.cal.sync_token && r.cal.pull_state.phase === 'events', 'event failure cannot advance token or page');
    check(!!r.cal.last_error && !r.cal.last_synced_at, 'event failure persists honest health');
    r.options.failInsert = false;
    out = await runGooglePull(r.deps);
    check(out.ok && r.tables.pec_appointments.length === 1 && !!r.cal.last_error, 'next tick retries failed event and retains warning until complete');
    await runGooglePull(r.deps);
    check(r.cal.last_error === null && r.cal.sync_token === 'after-failure', 'successful replay clears warning only after completion');
  }
  {
    const r = rig({ google: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { ok: true, status: 200, body: { items: [], nextSyncToken: 'done' } }; } });
    const results = await Promise.all([runGooglePull(r.deps), runGooglePull(r.deps)]);
    check(r.requests.length === 1 && results.every(o => o.errors === 0), 'simultaneous manual/scheduled workers share one lease');
  }
  {
    const r = rig({ google: (_path, tables) => { tables.pec_sales_member_google_calendars[0].lease_id = 'new-owner'; return { ok: true, status: 200, body: { items: [], nextSyncToken: 'discard' } }; } });
    await runGooglePull(r.deps);
    check(!r.cal.sync_token && r.cal.pull_state.phase === 'events' && r.cal.lease_id === 'new-owner', 'lost lease cannot checkpoint or release another owner');
  }
  {
    const r = rig({ google: (_path, _tables, spend) => { spend(); return { ok: true, status: 200, body: { items: [event('late')], nextSyncToken: 'late' } }; } });
    const out = await runGooglePull(r.deps);
    check(out.ok && !out.complete && !r.cal.sync_token && r.tables.pec_appointments.length === 0, 'deadline yields cleanly and replays unfinished page');
    check(r.calls.every(c => c.opts.timeoutMs > 0 && c.opts.timeoutMs <= 3000) && r.requests.every(c => c.timeout <= 3000), 'all worker database and Google requests have bounded timeouts');
  }
  {
    const base = { google_calendar_id: 'personal', google_updated: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', status: 'scheduled', source: 'google', start_at: '2026-09-09T20:00:00.000Z', end_at: '2026-09-09T21:00:00.000Z' };
    const r = rig({ appointments: [
      { ...base, id: 'a1', google_event_id: 'deleted' },
      { ...base, id: 'a2', google_event_id: 'moved' },
      { ...base, id: 'a3', google_event_id: 'native', source: 'booking', customer_id: 'customer', lead_id: 'lead' },
      { ...base, id: 'a4', google_event_id: 'outside', start_at: '2028-01-01T00:00:00Z', end_at: '2028-01-01T01:00:00Z' },
      { ...base, id: 'a5', google_event_id: 'new-local', updated_at: '2026-09-09T18:00:00Z' },
    ], google: path => path.endsWith('/deleted') ? { ok: false, status: 404 } : path.endsWith('/moved') ? { ok: true, status: 200, body: event('moved', { start: { dateTime: '2027-09-09T13:00:00-07:00' }, end: { dateTime: '2027-09-09T14:00:00-07:00' } }) } : { ok: true, status: 200, body: { items: [], nextSyncToken: 'full' } } });
    await runGooglePull(r.deps); const out = await runGooglePull(r.deps);
    check(out.complete && r.tables.pec_appointments[0].status === 'canceled', 'missing imported event cancels only after direct Google 404');
    check(r.tables.pec_appointments[1].status === 'scheduled' && r.tables.pec_appointments[1].start_at.startsWith('2027-09-09'), 'event moved outside snapshot is updated, never canceled by absence');
    check(r.tables.pec_appointments.slice(2).every(a => a.status === 'scheduled'), 'native, outside-window and newly-edited rows are excluded from reconciliation');
    const writes = r.calls.filter(c => c.method === 'PATCH' && c.path.startsWith('/pec_appointments'));
    check(writes.every(c => c.path.includes('updated_at=eq.') && c.opts.actor === 'Google Calendar sync'), 'appointment writes preserve audit actor and local-write CAS');
  }
  {
    const r = rig({ cal: { pull_version: 2, sync_token: 'old', last_synced_at: stamp, last_full_synced_at: stamp }, google: () => ({ ok: false, status: 410 }) });
    await runGooglePull(r.deps);
    check(r.cal.sync_token === null && !!r.cal.pull_state.query.timeMin && !r.cal.pull_state.query.syncToken, 'expired sync token resets to bounded full state');
  }
  {
    const r = rig(); r.cal.pull_state = newPullState(r.cal, cfg, T - 3600000); r.cal.pull_state.page_token = 'stale';
    r.member.google_connected_at = stamp;
    await runGooglePull(r.deps);
    check(!r.requests[0].path.includes('pageToken'), 'reconnect never resumes a previous connection page');
    const r2 = rig(); r2.cal.pull_state = newPullState(r2.cal, { ...cfg, includeAllDay: false }, T); r2.cal.pull_state.page_token = 'old-policy';
    await runGooglePull(r2.deps);
    check(!r2.requests[0].path.includes('pageToken') && r2.cal.pull_state.config.includeAllDay, 'changed import settings restart a consistent snapshot');
  }
  {
    const r = rig({ maxPages: 2, google: () => ({ ok: true, status: 200, body: { items: [], nextPageToken: 'more' } }) });
    r.tables.pec_sales_member_google_calendars.push({ ...clone(r.cal), id: 'c2', calendar_id: 'meetings' });
    await runGooglePull(r.deps);
    check(r.requests.map(x => x.path.split('/')[2]).join(',') === 'personal,meetings,personal,meetings', 'round robin gives every enabled calendar a page before returning to primary');
  }
  {
    const old = { id: 'a1', google_event_id: 'same', google_calendar_id: 'personal', google_updated: stamp, updated_at: stamp, source: 'booking', status: 'completed', lead_id: 'lead', customer_id: 'customer' };
    const r = rig({ appointments: [old], google: () => ({ ok: true, status: 200, body: { items: [event('same')], nextSyncToken: 'done' } }) });
    await runGooglePull(r.deps);
    check(r.tables.pec_appointments[0].status === 'completed' && r.tables.pec_appointments[0].customer_id === 'customer', 'stale echoes never revive completed appointments or alter links');
    const r2 = rig({ appointments: [{ ...old, google_calendar_id: 'different' }], google: () => ({ ok: true, status: 200, body: { items: [event('same', { status: 'cancelled', updated: '2026-09-10T00:00:00Z' })], nextSyncToken: 'done' } }) });
    await runGooglePull(r2.deps);
    check(r2.tables.pec_appointments[0].status === 'completed', 'an invite copy cannot cancel another calendar mapping');
  }
  {
    const r = rig({ google: (_path, tables) => {
      tables.pec_sales_team_members[0].google_connected = false;
      tables.pec_sales_member_google_calendars[0].lease_id = null;
      return { ok: true, status: 200, body: { items: [event('after-disconnect')], nextSyncToken: 'discard' } };
    } });
    await runGooglePull(r.deps);
    check(!r.tables.pec_appointments.length && !r.cal.sync_token, 'disconnect during Google read fences both returned events and checkpoint');
    const r2 = rig(); r2.deps.getFreshAccessToken = async () => { r2.member.google_connected = false; return null; };
    const out = await runGooglePull(r2.deps);
    check(!out.ok && out.errors === 1 && !r2.requests.length && !r2.cal.last_synced_at, 'rejected refresh surfaces an error without a Google request or healthy completion');
  }
  {
    const fs = require('node:fs'), vm = require('node:vm');
    function load(file, fetch, overrides = {}) {
      const module = { exports: {} };
      vm.runInNewContext(fs.readFileSync(require.resolve(file), 'utf8'), { module, exports: module.exports, require, process: { env: { SUPABASE_URL: 'https://fixture.test', SUPABASE_SERVICE_ROLE_KEY: 'fixture-key', GOOGLE_OAUTH_CLIENT_ID: 'fixture-client', GOOGLE_OAUTH_CLIENT_SECRET: 'fixture-secret' } }, fetch, AbortController, setTimeout, clearTimeout, Buffer, URLSearchParams, console, ...overrides });
      return module.exports;
    }
    const hangingBody = async (_url, opts) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: () => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Error('aborted body')), { once: true })) });
    const sbHelpers = load('../netlify/functions/_pec-supabase.cjs', hangingBody);
    await assert.rejects(sbHelpers.sb('GET', '/test', null, { timeoutMs: 10 }), /aborted body/);
    check(true, 'optional database timeout aborts a stalled body read');
    const denied = await sbHelpers.requireStaff({ headers: { authorization: 'Bearer fixture-user' } }, { timeoutMs: 10 });
    check(!denied.ok && denied.status === 401, 'manual-run staff auth deadline aborts a stalled auth body');
    const googleHelpers = load('../netlify/functions/_pec-google.cjs', hangingBody);
    await assert.rejects(googleHelpers.gcalFetch('fixture', 'GET', '/test', null, 10), /aborted body/);
    check(true, 'Google request timeout includes response body reads');
    let called = false;
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../netlify/functions/pec-google-calendar-run.cjs'), 'utf8'), { module, exports: module.exports, require: name => name.includes('_pec-supabase') ? { requireStaff: async () => ({ ok: false, status: 403, error: 'Staff only' }), json: (statusCode, body) => ({ statusCode, body }) } : { runGooglePull: async () => { called = true; } } });
    const response = await module.exports.handler({ httpMethod: 'POST', headers: {} });
    check(response.statusCode === 403 && !called, 'nonstaff manual invocation never reaches service-role worker');
  }
  {
    const r = rig(); delete r.deps.writeHeartbeat;
    await runGooglePull(r.deps);
    const partial = r.calls.filter(c => c.path.startsWith('/pec_heartbeats')).pop();
    check(partial.method === 'PATCH' && !('last_ok_at' in partial.payload) && partial.payload.details.pending === 1, 'partial heartbeat preserves prior last successful completion');
    await runGooglePull(r.deps);
    const complete = r.calls.filter(c => c.path.startsWith('/pec_heartbeats')).pop();
    check(complete.method === 'POST' && !!complete.payload.last_ok_at && complete.payload.details.complete, 'completed heartbeat advances success timestamp');
  }
  console.log(`\n${checks} durable runner checks passed`);
})().catch(err => { console.error(err); process.exitCode = 1; });
