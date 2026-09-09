// Resumable Google pull. No Google writes or customer-facing effects here.
// A lease covers one page; only its holder may checkpoint. Every page keeps
// the original query, and a failed write leaves that page available to retry.
'use strict';
const { randomUUID } = require('crypto');
const { sb } = require('./_pec-supabase.cjs');
const google = require('./_pec-google.cjs');
const { mapEventToRow, shouldSkipEcho, importGuardrailReason, shouldSkipImportedEvent, pullWindow } = require('./pec-google-calendar-pull.cjs');

const VERSION = 2;
const PAGE_SIZE = 100;
const RECONCILE_SIZE = 500;
const LEDGER = '/pec_sales_member_google_calendars';
const ACTOR = 'Google Calendar sync';
const enc = encodeURIComponent;
const rows = value => Array.isArray(value) ? value : [];
const iso = ms => new Date(ms).toISOString();
const eq = value => value == null ? 'is.null' : `eq.${enc(value)}`;
class YieldPull extends Error {}
class LostLease extends Error {}

async function loadPullSettings(db) {
  const cfg = { windowDaysPast: 30, windowDaysFuture: 180, maxPages: 6, defaultType: 'other', includeAllDay: true, includeDeclined: false };
  const all = rows(await db('GET', '/settings?key=in.(google_pull_window_days_past,google_pull_window_days_future,google_pull_max_pages_per_calendar,google_imported_default_appt_type,google_pull_include_all_day,google_pull_include_declined)&select=key,value'));
  const kv = Object.fromEntries(all.map(r => [r.key, r.value]));
  if (kv.google_pull_window_days_past != null && Number(kv.google_pull_window_days_past) >= 0) cfg.windowDaysPast = Math.min(365, Number(kv.google_pull_window_days_past));
  if (Number(kv.google_pull_window_days_future) > 0) cfg.windowDaysFuture = Math.min(730, Number(kv.google_pull_window_days_future));
  if (Number(kv.google_pull_max_pages_per_calendar) > 0) cfg.maxPages = Math.min(20, Math.floor(Number(kv.google_pull_max_pages_per_calendar)));
  if (['on_site_estimate', 'project_walkthrough', 'site_visit', 'other'].includes(kv.google_imported_default_appt_type)) cfg.defaultType = kv.google_imported_default_appt_type;
  cfg.includeAllDay = kv.google_pull_include_all_day !== 'false';
  cfg.includeDeclined = kv.google_pull_include_declined === 'true';
  return cfg;
}

function newPullState(cal, cfg, now) {
  // A version change repairs previously dropped events. Daily bounded full
  // scans move the future horizon forward and reconcile missed deletions.
  const full = cal.pull_version !== VERSION || !cal.sync_token || !cal.last_full_synced_at ||
    now - Date.parse(cal.last_full_synced_at) >= 86400000;
  return {
    version: VERSION, mode: full ? 'full' : 'incremental', phase: 'events',
    started_at: iso(now), page_token: null, seen_ids: [],
    config: { windowDaysPast: cfg.windowDaysPast, windowDaysFuture: cfg.windowDaysFuture, defaultType: cfg.defaultType, includeAllDay: cfg.includeAllDay, includeDeclined: cfg.includeDeclined },
    query: { maxResults: String(PAGE_SIZE), singleEvents: 'true', showDeleted: 'true', showHiddenInvitations: 'true',
      ...(full ? pullWindow(cfg, new Date(now)) : { syncToken: cal.sync_token }) },
  };
}

function pagePath(calendarId, state) {
  const p = new URLSearchParams(state.query);
  if (state.page_token) p.set('pageToken', state.page_token);
  return `/calendars/${enc(calendarId)}/events?${p}`;
}

function appointmentCas(row) {
  return `/pec_appointments?id=eq.${enc(row.id)}&updated_at=${eq(row.updated_at)}&google_event_id=${eq(row.google_event_id)}&google_calendar_id=${eq(row.google_calendar_id)}`;
}

async function parallel(items, concurrency, fn) {
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try { await fn(item); } catch (err) { failure = failure || err; }
    }
  }));
  if (failure) throw failure;
}

async function processEvents(ctx, events) {
  const { db, member, cal, cfg, summary, canWork } = ctx;
  const ids = [...new Set(events.filter(e => e && e.id).map(e => e.id))];
  if (!ids.length) return;
  // One lookup per page, not one HTTP round trip for each recurring instance.
  const found = rows(await db('GET', `/pec_appointments?google_event_id=in.(${ids.map(id => enc(JSON.stringify(id))).join(',')})&select=id,google_updated,updated_at,google_event_id,google_calendar_id,status,source`));
  const byId = new Map(found.map(r => [r.google_event_id, r]));
  const unique = [...new Map(events.filter(e => e && e.id).map(e => [e.id, e])).values()];
  await parallel(unique, 4, async ev => {
    if (!canWork()) throw new YieldPull('Saving progress before the execution deadline');
    const existing = byId.get(ev.id);
    // The existing global unique Google id deliberately deduplicates invite
    // copies. A different calendar must not steal or cancel the winning row.
    if (existing && existing.google_calendar_id !== cal.calendar_id) { summary.echoes++; return; }
    if (ev.status === 'cancelled') {
      if (!existing || existing.status === 'canceled') return;
      if (ev.updated && shouldSkipEcho(ev, existing)) { summary.echoes++; return; }
      const changed = rows(await db('PATCH', appointmentCas(existing), { status: 'canceled', ...(ev.updated ? { google_updated: ev.updated } : {}) }, { returnRow: true, actor: ACTOR }));
      if (!changed.length) throw new Error('An appointment changed during sync; this page will retry.');
      summary.canceled++;
      return;
    }
    const imported = cal.calendar_id !== member.google_calendar_id;
    if (imported && shouldSkipImportedEvent(ev, cfg)) { summary.skipped++; return; }
    const mapped = mapEventToRow(ev, member, { calendarId: cal.calendar_id, defaultType: imported ? cfg.defaultType : 'other' });
    if (!mapped.valid) throw new Error('Google returned an event without a usable start time.');
    // Google incremental sync may expand changed recurring series beyond
    // the initial full-list time bounds (observed through 2040 in prod).
    // Retain the immutable Google query, but do not INSERT distant instances.
    // Existing mappings still move/cancel outside this window so an old busy
    // slot cannot survive a remote reschedule. Bounds match events.list:
    // event end > timeMin and event start < timeMax; spanning all-day blocks
    // therefore remain visible. The window is fixed to this pull's start.
    if (!existing && ctx.window && !(Date.parse(mapped.row.end_at) > Date.parse(ctx.window.timeMin) && Date.parse(mapped.row.start_at) < Date.parse(ctx.window.timeMax))) {
      summary.skipped++;
      return;
    }
    // Native bookings retain customer/lead/source/type/assignee. Imported
    // writes retain the same organizer and calendar guardrails as before.
    if (imported) mapped.row.google_readonly_reason = importGuardrailReason(ev, cal);
    if (existing) {
      if (shouldSkipEcho(ev, existing)) { summary.echoes++; return; }
      const changed = rows(await db('PATCH', appointmentCas(existing), { ...mapped.row, status: 'scheduled' }, { returnRow: true, actor: ACTOR }));
      if (!changed.length) throw new Error('An appointment changed during sync; this page will retry.');
      summary.updated++;
    } else {
      try {
        await db('POST', '/pec_appointments', { ...mapped.row, appt_type: mapped.apptType, sales_member_id: member.id, status: 'scheduled', source: 'google' }, { actor: ACTOR });
        summary.created++;
      } catch (err) {
        // Never swallow another constraint failure as an echo. A unique-id
        // race is retried as a page, so the winning row gets LWW on retry.
        if (/409|duplicate|unique/i.test(String(err.message))) throw new Error('An appointment arrived during sync; this page will retry.');
        throw err;
      }
    }
  });
}

async function reconcilePage(ctx, state) {
  const { db, cal, token, requestGoogle, canWork } = ctx;
  const seen = new Set(state.seen_ids);
  const after = state.reconcile_after_id ? `&id=gt.${enc(state.reconcile_after_id)}` : '';
  // Only unlinked Google-import blocks in the completed snapshot's bounded
  // window are candidates. Native bookings and out-of-window rows stay put.
  const candidates = rows(await db('GET', `/pec_appointments?google_calendar_id=eq.${enc(cal.calendar_id)}&source=eq.google&status=eq.scheduled&start_at=lt.${enc(state.query.timeMax)}&end_at=gt.${enc(state.query.timeMin)}&updated_at=lte.${enc(state.started_at)}&order=id.asc&limit=${RECONCILE_SIZE}${after}&select=id,google_event_id,google_calendar_id,google_updated,updated_at,status,source`));
  await parallel(candidates.filter(r => !seen.has(r.google_event_id)), 4, async existing => {
    if (!canWork()) throw new YieldPull('Saving reconciliation progress');
    // Absence from a bounded list alone is NOT a deletion: the event could
    // have moved outside the window. Verify every candidate with Google.
    const res = await requestGoogle(token, `/calendars/${enc(cal.calendar_id)}/events/${enc(existing.google_event_id)}`);
    if (res.status === 404 || res.status === 410 || (res.ok && res.body && res.body.status === 'cancelled')) {
      const changed = rows(await db('PATCH', `${appointmentCas(existing)}&source=eq.google&status=eq.scheduled`, { status: 'canceled' }, { returnRow: true, actor: ACTOR }));
      // A newer local edit wins and is not evidence of a missing Google event.
      ctx.summary.canceled += changed.length;
    } else if (res.ok && res.body) {
      await processEvents(ctx, [res.body]);
    } else throw new Error(`Google deletion check failed (${res.status}).`);
  });
  return candidates.length === RECONCILE_SIZE ? { ...state, reconcile_after_id: candidates[candidates.length - 1].id } : null;
}

async function runGooglePull(deps = {}) {
  const clock = deps.now || Date.now;
  const start = clock();
  const deadline = start + Math.min(22000, deps.budgetMs || 22000);
  const baseDb = deps.sb || sb;
  const summary = { ok: true, complete: false, pending: 0, errors: 0, created: 0, updated: 0, canceled: 0, echoes: 0, skipped: 0, calendars: 0, completed_calendars: 0, failed_calendars: [] };
  const canWork = () => clock() < deadline - 4500;
  const db = (method, path, payload, opts = {}) => baseDb(method, path, payload, { ...opts, timeoutMs: Math.max(100, Math.min(3000, deadline - clock())) });
  const requestGoogle = (token, path) => (deps.gcalFetch || google.gcalFetch)(token, 'GET', path, null, Math.max(100, Math.min(3000, deadline - clock() - 3500)));
  const tokenFor = deps.getFreshAccessToken || google.getFreshAccessToken;
  const completed = new Set();
  const failed = new Set();
  let calendars = [];
  try {
    if (!(deps.googleConfigured || google.googleConfigured)()) throw new Error('Google Calendar sync is not configured.');
    const members = rows(await db('GET', '/pec_sales_team_members?google_connected=eq.true&select=id,name,google_calendar_id,google_connected_at'));
    const cfg = await loadPullSettings(db);
    const memberById = new Map(members.map(m => [m.id, m]));
    // The dedicated calendar now uses the same durable ledger, including
    // members connected since the migration. Do not overwrite existing state.
    const seeds = members.filter(m => m.google_calendar_id).map(m => ({ member_id: m.id, calendar_id: m.google_calendar_id, summary: 'TopCoat', access_role: 'owner', sync_enabled: true }));
    if (seeds.length) await db('POST', `${LEDGER}?on_conflict=member_id,calendar_id`, seeds, { headers: { Prefer: 'resolution=ignore-duplicates' } });
    calendars = rows(await db('GET', `${LEDGER}?select=*&order=last_attempt_at.asc.nullsfirst,id.asc`))
      .filter(cal => memberById.has(cal.member_id) && (cal.sync_enabled || cal.calendar_id === memberById.get(cal.member_id).google_calendar_id));
    summary.calendars = calendars.length;
    const tokens = new Map();
    // Round robin: at most one page per calendar per pass. Oldest attempts
    // sort first next tick, so a busy primary cannot starve another source.
    for (let round = 0; round < cfg.maxPages && canWork(); round++) {
      for (const listed of calendars) {
        if (!canWork()) break;
        if (completed.has(listed.id) || failed.has(listed.id)) continue;
        const leaseId = (deps.randomUUID || randomUUID)();
        const acquired = rows(await db('PATCH', `${LEDGER}?id=eq.${enc(listed.id)}&or=(lease_until.is.null,lease_until.lt.${enc(iso(clock()))})`, { lease_id: leaseId, lease_until: iso(clock() + 60000), last_attempt_at: iso(clock()) }, { returnRow: true }));
        if (!acquired.length) continue;
        const cal = acquired[0];
        const member = memberById.get(cal.member_id);
        const save = async patch => {
          const changed = rows(await db('PATCH', `${LEDGER}?id=eq.${enc(cal.id)}&lease_id=eq.${enc(leaseId)}&lease_until=gt.${enc(iso(clock()))}`, patch, { returnRow: true }));
          if (!changed.length) throw new LostLease('Another sync owns this calendar now.');
          Object.assign(cal, patch);
        };
        try {
          if (!tokens.has(member.id)) tokens.set(member.id, await tokenFor(db, member.id, Math.max(100, Math.min(3000, deadline - clock() - 3500))));
          const token = tokens.get(member.id);
          if (!token) throw new Error('Google connection needs attention; reconnect if prompted.');
          if (!canWork()) throw new YieldPull('Saving progress before the execution deadline');
          const currentMembers = rows(await db('GET', `/pec_sales_team_members?id=eq.${enc(member.id)}&google_connected=eq.true&select=id,google_connected_at`));
          if (!currentMembers.length || currentMembers[0].google_connected_at !== member.google_connected_at) throw new LostLease('The Google connection changed during sync.');
          // Reconnecting must force another full pass even if the ledger
          // retained a recently completed token from the old connection.
          const reconnect = member.google_connected_at && (!cal.last_synced_at || Date.parse(member.google_connected_at) > Date.parse(cal.last_synced_at));
          let state = cal.pull_state && cal.pull_state.version === VERSION ? cal.pull_state : null;
          const currentConfig = newPullState(cal, cfg, clock()).config;
          // PostgreSQL JSONB reorders object keys when it stores a document.
          // Compare the actual option values, never serialization order, or
          // every resumed page becomes another first-page full sync.
          const configChanged = state && Object.keys(currentConfig).some(key => !state.config || state.config[key] !== currentConfig[key]);
          if (!state || configChanged || (member.google_connected_at && Date.parse(member.google_connected_at) > Date.parse(state.started_at))) {
            state = newPullState(reconnect || configChanged ? { ...cal, sync_token: null } : cal, cfg, clock());
            await save({ pull_state: state });
          }
          const snapshotConfig = { ...cfg, ...state.config };
          const ctx = { db, member, cal, cfg: snapshotConfig, summary, canWork, token, requestGoogle,
            window: pullWindow(snapshotConfig, new Date(state.started_at)) };
          if (state.phase === 'reconcile') {
            const next = await reconcilePage(ctx, state);
            if (next) await save({ pull_state: next });
            else {
              await save({ pull_state: null, sync_token: state.next_sync_token, pull_version: VERSION, last_synced_at: iso(clock()), last_full_synced_at: iso(clock()), last_error: null });
              completed.add(cal.id);
            }
          } else {
            const res = await requestGoogle(token, pagePath(cal.calendar_id, state));
            if ((res.status === 410 && (state.query.syncToken || state.page_token)) || (res.status === 400 && state.page_token)) {
              // An expired sync/page token starts a NEW bounded snapshot;
              // no reconciliation is allowed from the abandoned snapshot.
              await save({ sync_token: null, pull_state: newPullState({ ...cal, sync_token: null }, cfg, clock()) });
              continue;
            }
            if (!res.ok || !res.body) throw new Error(`Google calendar read failed (${res.status}).`);
            // A disconnect/reconnect invalidates the ledger lease. Check it
            // after the Google request before applying any returned events.
            await save({ lease_until: cal.lease_until });
            await processEvents(ctx, rows(res.body.items));
            const seenIds = state.mode === 'full' ? [...new Set([...state.seen_ids, ...rows(res.body.items).filter(e => e && e.id).map(e => e.id)])] : [];
            if (res.body.nextPageToken) await save({ pull_state: { ...state, page_token: res.body.nextPageToken, seen_ids: seenIds } });
            else if (!res.body.nextSyncToken) throw new Error('Google did not return a continuation or completion token.');
            else if (state.mode === 'full') await save({ pull_state: { ...state, phase: 'reconcile', seen_ids: seenIds, page_token: null, next_sync_token: res.body.nextSyncToken } });
            else {
              await save({ pull_state: null, sync_token: res.body.nextSyncToken, pull_version: VERSION, last_synced_at: iso(clock()), last_error: null });
              completed.add(cal.id);
            }
          }
        } catch (err) {
          if (!(err instanceof YieldPull) && !(err instanceof LostLease)) {
            // Keep raw HTTP paths, tokens and event content out of the safe
            // view and response. Detailed errors stay in server logs only.
            console.error('Google pull failed for calendar ledger', cal.id, err && err.message);
            const message = /Google .*\(\d+\)|Google connection|Google did not|usable start time|appointment changed|appointment arrived/i.test(String(err.message)) ? String(err.message).slice(0, 200) : 'Calendar sync could not finish. Saved progress will retry.';
            summary.errors++;
            failed.add(cal.id);
            summary.failed_calendars.push({ id: cal.id, name: cal.summary || 'Google calendar', error: message });
            try { await save({ last_error: message }); } catch (_) { /* lease lost or database unavailable */ }
          }
        } finally {
          try { await db('PATCH', `${LEDGER}?id=eq.${enc(cal.id)}&lease_id=eq.${enc(leaseId)}`, { lease_id: null, lease_until: null }); } catch (_) { /* expires after a killed/unreachable run */ }
        }
      }
    }
  } catch (err) {
    summary.errors++;
    summary.error = 'Calendar sync could not start. Check the connection and try again.';
    console.error('Google pull setup failed:', err && err.message);
  }
  summary.completed_calendars = completed.size;
  summary.pending = Math.max(0, calendars.length - completed.size);
  summary.ok = summary.errors === 0;
  summary.complete = summary.ok && summary.pending === 0;
  summary.duration_ms = Math.max(0, clock() - start);
  // This heartbeat proves the worker ran; its details truthfully distinguish
  // completed data from pending/error state. Calendar health uses the ledger.
  try {
    const details = { ...summary, failed_calendars: summary.failed_calendars.map(c => ({ id: c.id, error: c.error })) };
    if (deps.writeHeartbeat) await deps.writeHeartbeat('pec-google-calendar-pull', details);
    else if (clock() < deadline) {
      const patch = { updated_at: iso(clock()), details, ...(summary.complete ? { last_ok_at: iso(clock()) } : {}) };
      if (summary.complete) await db('POST', '/pec_heartbeats?on_conflict=function_name', {
        function_name: 'pec-google-calendar-pull', ...patch,
      }, { headers: { Prefer: 'resolution=merge-duplicates' } });
      else await db('PATCH', '/pec_heartbeats?function_name=eq.pec-google-calendar-pull', patch);
    }
  } catch (_) {}
  return summary;
}

module.exports = { runGooglePull, newPullState, pagePath, processEvents, reconcilePage, appointmentCas, VERSION };
