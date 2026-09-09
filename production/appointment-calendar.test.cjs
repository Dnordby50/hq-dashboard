'use strict';

// Execute the real inline calendar functions with a read-only fake database.
// No browser login, production database, or Google calls are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const names = ['apptDateInputVal', 'apptFmtWhen', 'apptRowsByDay', 'loadAppointmentsRange', 'apptConfirmOverlap', 'apptGoogleHealth', 'renderApptSyncHealth', 'apptStartLiveRefresh', 'apptCommitMove', 'apptSyncNow'];
const source = names.map(name => {
  const m = html.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}'));
  assert(m, 'real function exists: ' + name); return m[0];
}).join('\n');

function fakeDb(rows, error = null) {
  const calls = [];
  return { calls, from(table) {
    const call = { table, operations: [] }; calls.push(call);
    let data = rows.filter(r => !r._table || r._table === table), single = false;
    const q = {
      select() { return q; },
      eq(k, v) { call.operations.push(['eq', k, v]); data = data.filter(r => r[k] === v); return q; },
      neq(k, v) { call.operations.push(['neq', k, v]); data = data.filter(r => r[k] !== v); return q; },
      gt(k, v) { call.operations.push(['gt', k, v]); data = data.filter(r => r[k] > v); return q; },
      lt(k, v) { call.operations.push(['lt', k, v]); data = data.filter(r => r[k] < v); return q; },
      order() { return q; }, limit(n) { data = data.slice(0, n); return q; },
      in(k, vs) { data = data.filter(r => vs.includes(r[k])); return q; },
      single() { single = true; return q; },
      update(patch) { call.operations.push(['update', patch]); return q; },
      then(resolve, reject) { return Promise.resolve({ data: single ? data[0] || null : data, error }).then(resolve, reject); },
    }; return q;
  } };
}
function env(extra = {}) {
  const context = vm.createContext({ Date, console, setInterval, clearInterval, setTimeout, clearTimeout, AbortController,
    state: { apptFilters: {} }, withFreshSession: fn => fn(), withFreshWriteRetry: fn => fn(),
    confirm: () => true, showToast() {}, apptPostWrite() {}, apptDayBlockedInfo: async () => [], ...extra });
  vm.runInContext(source, context); return context;
}
let checks = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(() => { checks++; console.log('  ✓ ' + name); }); }
const start = '2026-09-09T07:00:00.000Z', end = '2026-09-10T07:00:00.000Z';
const base = { sales_member_id: 'dylan', status: 'scheduled', appt_type: 'other', source: 'google', start_at: '2026-09-08T07:00:00.000Z', end_at: end, title: 'Vacation', all_day: true };

(async () => {
  await check('range includes ongoing all-day blocks and excludes exact end boundaries', async () => {
    const db = fakeDb([
      { ...base, id: 'ongoing' },
      { ...base, id: 'ended', end_at: start },
      { ...base, id: 'tomorrow', start_at: end, end_at: '2026-09-11T07:00:00.000Z' },
      { ...base, id: 'canceled', status: 'canceled' },
    ]);
    const ctx = env({ supabase: db });
    const got = await ctx.loadAppointmentsRange(start, end);
    assert.deepEqual(got.rows.map(r => r.id), ['ongoing']);
  });
  await check('range display filters still apply without affecting conflict checks', async () => {
    const db = fakeDb([{ ...base, id: 'google' }, { ...base, id: 'local', source: 'topcoat' }]);
    const ctx = env({ supabase: db, state: { apptFilters: { hideImported: true, member: 'dylan', type: 'other' } } });
    const got = await ctx.loadAppointmentsRange(start, end);
    assert.deepEqual(got.rows.map(r => r.id), ['local']);
  });
  await check('fallback repeats spanning rows on each local day, clipping to the range and exclusive end', () => {
    const ctx = env();
    const row = { start_at: new Date(2026, 8, 7, 9).toISOString(), end_at: new Date(2026, 8, 11, 0).toISOString() };
    const byDay = ctx.apptRowsByDay([row], new Date(2026, 8, 9), new Date(2026, 8, 12));
    assert.deepEqual(Object.keys(byDay), ['2026-09-09', '2026-09-10']);
  });
  await check('overlap warning includes hidden imported and earlier-starting all-day blocks, only for the same rep', async () => {
    let prompt = '';
    const ctx = env({ supabase: fakeDb([
      { ...base, id: 'busy' }, { ...base, id: 'self' },
      { ...base, id: 'other-rep', sales_member_id: 'other', title: 'Other rep' },
      { ...base, id: 'canceled', status: 'canceled', title: 'Canceled' },
      { ...base, id: 'boundary', end_at: start, title: 'Finished' },
    ]), confirm: msg => { prompt = msg; return false; } });
    assert.equal(await ctx.apptConfirmOverlap({ id: 'self', sales_member_id: 'dylan', start_at: start, end_at: end }), false);
    assert.match(prompt, /Vacation/); assert.match(prompt, /all day/); assert.match(prompt, /to /);
    assert.doesNotMatch(prompt, /Other rep|Canceled|Finished/);
    assert.equal((prompt.match(/Vacation/g) || []).length, 1);
  });
  await check('availability read failure blocks saving, while an explicit override succeeds', async () => {
    const failed = env({ supabase: fakeDb([], { message: 'network unavailable' }) });
    await assert.rejects(failed.apptConfirmOverlap({ ...base }), /Nothing was booked or moved/);
    const allowed = env({ supabase: fakeDb([{ ...base }]), confirm: () => true });
    assert.equal(await allowed.apptConfirmOverlap({ ...base }), true);
  });
  await check('health requires complete current-version sync, not connection or a recent attempt', () => {
    const now = Date.parse('2026-09-09T20:00:00Z');
    const m = { id: 'dylan', name: 'Dylan', google_connected: true, google_calendar_id: 'topcoat' };
    const c = { member_id: 'dylan', calendar_id: 'topcoat', sync_enabled: true, pull_version: 2, last_synced_at: '2026-09-09T19:50:00Z' };
    const ctx = env();
    assert.equal(ctx.apptGoogleHealth([m], [c], now)[0].warning, false);
    for (const patch of [{ pull_version: 1 }, { sync_in_progress: true }, { last_error: 'Google rejected request' }, { last_synced_at: null, last_attempt_at: '2026-09-09T19:59:00Z' }, { last_synced_at: '2026-09-09T18:00:00Z' }]) {
      assert.equal(ctx.apptGoogleHealth([m], [{ ...c, ...patch }], now)[0].warning, true);
    }
    assert.equal(ctx.apptGoogleHealth([{ ...m, google_connected_at: '2026-09-09T19:55:00Z' }], [c], now)[0].warning, true);
    assert.equal(ctx.apptGoogleHealth([m], [], now)[0].warning, true);
    assert.equal(ctx.apptGoogleHealth([{ ...m, google_connected: false }], [c], now)[0].warning, true);
  });
  await check('each enabled calendar contributes health independently of salesperson/type display filters', () => {
    const ctx = env({ state: { apptFilters: { member: 'other', hideImported: true } } });
    const rows = ctx.apptGoogleHealth([{ id: 'dylan', name: 'Dylan', google_connected: true, google_calendar_id: 'topcoat' }], [
      { member_id: 'dylan', calendar_id: 'topcoat', summary: 'TopCoat', pull_version: 2, last_synced_at: new Date().toISOString() },
      { member_id: 'dylan', calendar_id: 'primary', summary: 'Personal', sync_enabled: true, pull_version: 0 },
      { member_id: 'dylan', calendar_id: 'off', sync_enabled: false },
    ]);
    assert.equal(rows.length, 2); assert.equal(rows[1].warning, true); assert.match(rows[1].label, /Personal/);
  });
  await check('live refresh pauses when hidden, deduplicates requests, and removes its timer/listeners on exit', async () => {
    const events = new Map(), cleared = [];
    const surface = { hidden: false, addEventListener: (k, fn) => events.set(k, fn), removeEventListener: (k, fn) => { if (events.get(k) === fn) events.delete(k); } };
    let interval, calls = 0, finish, current = true;
    const ctx = env({ document: surface, window: surface, setInterval: (fn, ms) => { assert.equal(ms, 60000); interval = fn; return 4; }, clearInterval: n => cleared.push(n) });
    const stop = ctx.apptStartLiveRefresh(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, () => current);
    surface.hidden = true; await interval(); assert.equal(calls, 0);
    surface.hidden = false; const running = events.get('focus')(); await interval(); assert.equal(calls, 1);
    finish(); await running; current = false; await interval(); assert.equal(calls, 1);
    stop(); assert.deepEqual(cleared, [4]); assert.equal(events.size, 0);
    current = true; await interval(); assert.equal(calls, 1);
  });
  await check('an older health request cannot overwrite a newer result or a departed view', async () => {
    const pending = [], el = { innerHTML: '', querySelector: () => null };
    const ctx = env({ state: { view: 'appointments', apptFilters: {} }, $: () => el, esc: s => s,
      withFreshSession: () => new Promise(resolve => pending.push(resolve)) });
    const first = ctx.renderApptSyncHealth(), second = ctx.renderApptSyncHealth();
    const result = [{ data: [{ id: 'dylan', name: 'Dylan', google_connected: true, google_calendar_id: 'topcoat' }] },
      { data: [{ member_id: 'dylan', calendar_id: 'topcoat', pull_version: 2, last_synced_at: new Date().toISOString() }] }, { data: { value: '45' } }];
    pending[1](result); await second; assert.match(el.innerHTML, /up to date/);
    const latest = el.innerHTML; pending[0]([{ error: new Error('old failure') }, {}, {}]); await first; assert.equal(el.innerHTML, latest);
    const third = ctx.renderApptSyncHealth(); ctx.state.view = 'jobs'; pending[2](result); await third; assert.equal(el.innerHTML, latest);
  });
  await check('drag refusal and failed availability checks revert without writing', async () => {
    for (const failure of [false, true]) {
      const db = fakeDb([{ ...base, id: 'moving' }, { ...base, id: 'busy' }]);
      let reverted = 0;
      const ctx = env({ supabase: db, confirm: () => false });
      if (failure) ctx.apptConfirmOverlap = async () => { throw new Error('Could not check'); };
      await ctx.apptCommitMove({ event: { id: 'moving', start: new Date(start), end: new Date(end), allDay: true }, revert: () => reverted++ }, []);
      assert.equal(reverted, 1);
      assert.equal(db.calls.some(c => c.operations.some(o => o[0] === 'update')), false);
    }
  });
  await check('sync now continues partial batches, sends staff auth, and refreshes without rebuilding the view', async () => {
    const progress = {}, button = {}, responses = [{ ok: true, pending: 1, complete: false }, { ok: true, pending: 0, complete: true }];
    let requests = 0, refreshes = 0;
    const ctx = env({ $: () => progress, supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'fixture-only' } } }) } }, fetch: async (url, opts) => {
      requests++; assert.equal(url, '/.netlify/functions/pec-google-calendar-run'); assert.equal(opts.headers.Authorization, 'Bearer fixture-only');
      return { ok: true, json: async () => responses.shift() };
    } });
    await ctx.apptSyncNow(button, () => true, async () => { refreshes++; });
    assert.equal(requests, 2); assert.equal(refreshes, 2); assert.equal(button.disabled, false); assert.match(progress.textContent, /Sync finished/);
  });
  await check('sync continuation stops at ten batches and errors always release the button', async () => {
    const progress = {}, button = {};
    let requests = 0;
    const ctx = env({ $: () => progress, supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'fixture-only' } } }) } },
      fetch: async () => { requests++; return { ok: true, json: async () => ({ ok: true, pending: 1, complete: false }) }; } });
    await ctx.apptSyncNow(button, () => true, async () => {});
    assert.equal(requests, 10); assert.match(progress.textContent, /still in progress/); assert.equal(button.disabled, false);
    ctx.fetch = async () => { throw new Error('Offline'); };
    await ctx.apptSyncNow(button, () => true, async () => {});
    assert.equal(ctx.state._apptSyncRunning, false); assert.equal(button.disabled, false); assert.match(progress.textContent, /Offline/);
  });
  console.log(`appointment-calendar: ${checks} checks passed`);
})().catch(err => { console.error(err); process.exitCode = 1; });
