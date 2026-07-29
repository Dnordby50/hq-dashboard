// Scheduled SalesAsk sync — one function, three duties, every 15 minutes
// (netlify.toml). Also curl-able for manual sweeps:
//   curl https://prescottepoxy.netlify.app/.netlify/functions/pec-salesask-sync
//
//   1. PUSH appointments: upsert upcoming pec_appointments to SalesAsk as
//      scheduled tasks (POST /v1/scheduled-tasks, event_id = appointment id)
//      so the rep's mobile recording auto-attaches. A cron (not an inline
//      kick) because appointments are born in THREE places — the dashboard
//      modal, the Routemize Zapier intake, and the Google Calendar pull — and
//      only a server-side sweep covers all three without exposing the API key
//      to the browser. Appointments are booked hours/days ahead, so 15-minute
//      lag is invisible. salesask_sync_hash (sha256 of the pushed fields)
//      makes unchanged rows free to re-scan; canceled rows get a DELETE.
//   2. RECONCILE recordings: list recent recordings from the REST API and
//      upsert them. SalesAsk webhooks have NO retries, so this sweep is the
//      delivery guarantee; the unique salesask_recording_id makes overlap
//      with the webhook harmless.
//   3. COMPLETE pending rows: fetch the full document + transcript for rows
//      the webhook/reconcile left thin (transcript_pending), run matching,
//      and insert the 'salesask_recording' lead_events row (timeline + AI
//      feed). Dedupe lives in insertRecordingLeadEvent.
//
// Master switch: settings key salesask_sync_enabled (seeded 'false'; Settings
// > Appointments > SalesAsk). No key or switch off => skip-with-note, so the
// schedule stays harmless before setup (same shape as pec-openphone-sync).
// Per-row try/catch throughout: one bad appointment or recording never kills
// the sweep. Scheduled functions return 200 with ok:false on error, never a
// non-2xx (a non-2xx would mark the deploy's function unhealthy).

const crypto = require('crypto');
const { sb, json } = require('./_pec-supabase.cjs');
const {
  SALESASK_API_KEY, saFetch, loadRepEmailMap, upsertRecording,
  extractRecordingFields, extractEventId, matchRecordingToAppointment,
  insertRecordingLeadEvent, getSetting,
} = require('./_pec-salesask.cjs');

const MAX_PAGES = 5;          // 5 x 100 recordings per reconcile sweep
const MAX_COMPLETIONS = 20;   // full-doc + transcript fetches per tick (2 API calls each)

const hashOf = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);

// ---- Duty 1: push appointments -> SalesAsk scheduled tasks ----------------
async function pushAppointments(windowDays, emailMap) {
  const out = { scanned: 0, pushed: 0, deleted: 0, unchanged: 0, noRepEmail: 0, failures: [] };
  const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const to = new Date(Date.now() + windowDays * 24 * 3600 * 1000).toISOString();
  // customers embeds via the FK; leads has no FK from appointments, so lead
  // names for customer-less appointments are fetched in one IN() batch below.
  const appts = await sb('GET',
    `/pec_appointments?status=in.(scheduled,canceled)` +
    `&start_at=gte.${encodeURIComponent(from)}&start_at=lte.${encodeURIComponent(to)}` +
    `&select=id,title,appt_type,lead_id,customer_id,sales_member_id,start_at,end_at,status,` +
    `salesask_synced_at,salesask_sync_hash,customers(name,email)`);

  const leadIds = [...new Set((appts || []).filter(a => !a.customers && a.lead_id).map(a => a.lead_id))];
  const leadById = {};
  if (leadIds.length) {
    const leads = await sb('GET', `/leads?id=in.(${leadIds.join(',')})&select=id,full_name,first_name,last_name,email`);
    for (const l of (leads || [])) leadById[l.id] = l;
  }

  for (const a of (appts || [])) {
    out.scanned++;
    try {
      if (a.status === 'canceled') {
        // Only un-book what we actually booked; 404 = already gone = success.
        if (!a.salesask_synced_at || a.salesask_sync_hash === 'deleted') { out.unchanged++; continue; }
        try { await saFetch('DELETE', `/v1/scheduled-tasks/${encodeURIComponent(a.id)}`); }
        catch (e) { if (e.status !== 404) throw e; }
        await sb('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(a.id)}`,
          { salesask_sync_hash: 'deleted', salesask_synced_at: new Date().toISOString() });
        out.deleted++;
        continue;
      }

      const repEmail = a.sales_member_id ? emailMap.byMemberId[a.sales_member_id] : null;
      if (!repEmail) { out.noRepEmail++; continue; }

      const lead = a.lead_id ? leadById[a.lead_id] : null;
      const custName = (a.customers && a.customers.name)
        || (lead && (lead.full_name || [lead.first_name, lead.last_name].filter(Boolean).join(' '))) || null;
      const custEmail = (a.customers && a.customers.email) || (lead && lead.email) || null;

      const task = {
        event_id: a.id,
        user_email: repEmail,
        start_time: new Date(a.start_at).toISOString(),
        end_time: a.end_at ? new Date(a.end_at).toISOString() : undefined,
        title: a.title || (custName ? `${custName} — ${a.appt_type}` : a.appt_type),
      };
      if (custName) {
        task.customer = { id: a.customer_id || a.lead_id || undefined, name: custName, email: custEmail || undefined };
      }

      const hash = hashOf(task);
      if (a.salesask_sync_hash === hash) { out.unchanged++; continue; }

      await saFetch('POST', '/v1/scheduled-tasks', task);  // documented as create-or-update
      await sb('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(a.id)}`,
        { salesask_sync_hash: hash, salesask_synced_at: new Date().toISOString() });
      out.pushed++;
    } catch (err) {
      out.failures.push({ appointment_id: a.id, error: err.message });
    }
  }
  return out;
}

// ---- Duty 2: reconcile recent recordings ----------------------------------
async function reconcileRecordings(lookbackDays) {
  const out = { listed: 0, upserted: 0, failures: [] };
  const fromDate = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString();
  let startAfter = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = `?fromDate=${encodeURIComponent(fromDate)}&limit=100${startAfter ? `&startAfter=${encodeURIComponent(startAfter)}` : ''}`;
    const res = await saFetch('GET', `/v1/recordings${qs}`);
    const rows = (res && (res.data || res.recordings || res.items)) || [];
    out.listed += rows.length;
    for (const doc of rows) {
      try {
        const id = doc.id || doc.recordingId;
        if (!id) continue;
        await upsertRecording(id, extractRecordingFields(doc));
        out.upserted++;
      } catch (err) {
        out.failures.push({ recording_id: doc.id, error: err.message });
      }
    }
    startAfter = res && (res.nextCursor || res.startAfter) || null;
    if (!startAfter || !(res && res.hasMore !== false)) break;
  }
  return out;
}

// ---- Duty 3: complete pending rows (full doc + transcript + match + event) --
async function completePending(emailMap) {
  const out = { checked: 0, completed: 0, stillProcessing: 0, events: 0, failures: [] };
  const pending = await sb('GET',
    `/pec_salesask_recordings?transcript_pending=eq.true&select=*` +
    `&order=created_at.asc&limit=${MAX_COMPLETIONS}`);
  for (const row of (pending || [])) {
    out.checked++;
    try {
      const doc = await saFetch('GET', `/v1/recordings/${encodeURIComponent(row.salesask_recording_id)}`);
      const body = (doc && (doc.data || doc.recording)) || doc || {};
      const fields = extractRecordingFields(body);
      const status = fields.status || row.status;
      if (status && status !== 'processed' && status !== 'processing-failed') {
        // Still transcribing; leave transcript_pending for the next tick.
        await upsertRecording(row.salesask_recording_id, fields);
        out.stillProcessing++;
        continue;
      }
      if (status === 'processed') {
        try {
          const tr = await saFetch('GET', `/v1/recordings/${encodeURIComponent(row.salesask_recording_id)}/transcript`);
          const utterances = tr && (tr.utterances || tr.transcript || tr.segments || (Array.isArray(tr) ? tr : null));
          if (Array.isArray(utterances) && utterances.length) fields.transcript = utterances;
        } catch (e) { /* transcript is best-effort; the row still completes */ }
      }
      fields.transcript_pending = false;
      let rec = await upsertRecording(row.salesask_recording_id, fields);
      rec = rec || { ...row, ...fields };
      if (!rec.appointment_id) {
        rec = await matchRecordingToAppointment(rec, extractEventId(body) || extractEventId(row.raw || {}), emailMap);
      }
      if (rec.lead_id && rec.status === 'processed') {
        const inserted = await insertRecordingLeadEvent(rec);
        if (inserted) out.events++;
      }
      out.completed++;
    } catch (err) {
      out.failures.push({ recording_id: row.salesask_recording_id, error: err.message });
    }
  }
  return out;
}

exports.handler = async () => {
  if (!SALESASK_API_KEY) {
    return json(200, { ok: true, skipped: true, note: 'no SALESASK_API_KEY; sync idle' });
  }
  try {
    const enabled = await getSetting('salesask_sync_enabled', 'false');
    if (String(enabled) !== 'true') {
      return json(200, { ok: true, skipped: true, note: 'salesask_sync_enabled is off' });
    }
    const windowDays = Math.max(1, parseInt(await getSetting('salesask_push_window_days', '14'), 10) || 14);
    const lookbackDays = Math.max(1, parseInt(await getSetting('salesask_pull_lookback_days', '3'), 10) || 3);

    const emailMap = await loadRepEmailMap();
    const push = await pushAppointments(windowDays, emailMap);
    const reconcile = await reconcileRecordings(lookbackDays);
    const complete = await completePending(emailMap);

    return json(200, { ok: true, push, reconcile, complete });
  } catch (err) {
    console.error('pec-salesask-sync failed:', err);
    // 200 with ok:false on purpose (scheduled-function health), queryable in logs.
    return json(200, { ok: false, error: err && err.message });
  }
};
