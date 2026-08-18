// Routemize update replay (prompt 95 Part E). Re-runs the AppointmentUpdated
// envelopes stored in pec_webhook_ingest_log through the FIXED mapper
// (pec-appt-intake.cjs reads newStartTime/newEndTime since prompt 95; before
// that every update took the defensive no-readable-start-time branch and the
// appointment kept its stale time). Times ONLY: a replay never touches
// status (the cancels in the stored set already landed through their own
// AppointmentCancelled events), notes, customer_notes, or linkage.
//
// POST /.netlify/functions/pec-appt-replay          -> DRY RUN (default)
// POST /.netlify/functions/pec-appt-replay?apply=1  -> apply
// Header: x-webhook-secret: <PEC_WEBHOOK_SECRET>
//
// The dry run prints the count and the exact before/after for every row it
// would touch, including whether a touched appointment is linked to an
// ACCEPTED estimate (the sold-on-site audit line on an estimate page renders
// from the appointment's start time, so its wording will change; the stamped
// sold_on_site value will not, prompt 94 stamps it at accept). Count first,
// apply second: the prompt-56 lesson.
//
// Re-runnable and idempotent: rows are processed oldest first with the
// running value tracked per appointment, only a real difference PATCHes, an
// applied change kicks the Google push and leaves the same reschedule trail
// a live update leaves (lead note + bell), and a second apply run finds no
// differences and writes nothing. Applied changes log a 'replay: applied'
// ingest row (same deal_id), which is what clears the appointment's
// appt_intake_not_applied rows off the Ops Queue derived check.

const { sb, json, badSecret, logIngest } = require('./_pec-supabase.cjs');
const { mapRoutemizeEnvelope, parseApptDate, normalizeEventType } = require('./pec-appt-intake.cjs');
const { pushApptById } = require('./_pec-appt-push.cjs');
const { apptDateStr, apptTimeStr } = require('./_pec-appt.cjs');

const ENDPOINT = 'appt-intake';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });
  if (badSecret(event)) return json(401, { success: false, error: 'Invalid webhook secret' });
  const qs = event.queryStringParameters || {};
  const apply = qs.apply === '1' || qs.apply === 'true';

  try {
    // Oldest first, so a multi-update appointment replays in delivery order
    // and lands on its latest value.
    const logRows = await sb('GET',
      `/pec_webhook_ingest_log?endpoint=eq.${ENDPOINT}&order=created_at.asc&limit=2000&select=id,created_at,message,payload`);
    const updates = (Array.isArray(logRows) ? logRows : []).filter(r =>
      r.payload && typeof r.payload === 'object'
      && normalizeEventType(r.payload.eventType) === 'appointmentupdated');
    const alreadyReplayed = new Set((Array.isArray(logRows) ? logRows : [])
      .filter(r => /^replay:/.test(String(r.message || '')))
      .map(r => { const m = String(r.message || '').match(/appointment ([0-9a-f-]{36})/i); return m && m[1]; })
      .filter(Boolean));

    const report = [];
    const current = {}; // routemize_appt_id -> the row as the replay sees it now
    const appliedByAppt = {};
    for (const row of updates) {
      const mapped = await mapRoutemizeEnvelope(sb, row.payload);
      if (!mapped.recognized || !mapped.body.routemize_appt_id) continue;
      const rmId = mapped.body.routemize_appt_id;
      const afterStart = parseApptDate(mapped.body.start_at);
      const afterEnd = parseApptDate(mapped.body.end_at);
      if (!(rmId in current)) {
        const rows = await sb('GET', `/pec_appointments?routemize_appt_id=eq.${encodeURIComponent(rmId)}&select=id,title,status,start_at,end_at,lead_id,customer_id&limit=1`);
        current[rmId] = (Array.isArray(rows) && rows[0]) || null;
      }
      const appt = current[rmId];
      const entry = {
        ingest_id: row.id,
        ingest_at: row.created_at,
        routemize_appt_id: rmId,
        appointment_id: appt ? appt.id : null,
        matched: !!appt,
        readable: !!afterStart,
        changed: false,
      };
      if (appt && afterStart) {
        const sameStart = new Date(appt.start_at).getTime() === new Date(afterStart).getTime();
        const sameEnd = !afterEnd || new Date(appt.end_at).getTime() === new Date(afterEnd).getTime();
        entry.before = { start_at: appt.start_at, end_at: appt.end_at };
        entry.after = { start_at: afterStart, end_at: afterEnd || appt.end_at };
        entry.changed = !(sameStart && sameEnd);
        if (entry.changed) {
          if (apply) {
            const patch = { start_at: afterStart, ...(afterEnd ? { end_at: afterEnd } : {}) };
            await sb('PATCH', `/pec_appointments?id=eq.${encodeURIComponent(appt.id)}`, patch);
            // Several stored updates can move the same appointment; the trail
            // reads original -> final, not the intermediate hops.
            const prior = appliedByAppt[appt.id];
            appliedByAppt[appt.id] = { ...entry, before: prior ? prior.before : entry.before, title: appt.title, lead_id: appt.lead_id, customer_id: appt.customer_id };
          }
          // Track the running value either way, so a later stored update for
          // the same appointment diffs against what THIS row would leave.
          current[rmId] = { ...appt, start_at: afterStart, end_at: afterEnd || appt.end_at };
        }
      }
      report.push(entry);
    }

    // Accepted-estimate linkage for every appointment a change touches
    // (lead_id first, else customer_id: the same indirect join the
    // sold-on-site derivation uses; no estimate_id exists on
    // pec_appointments).
    const touched = report.filter(r => r.changed);
    const estimateWarnings = [];
    const seen = new Set();
    for (const t of touched) {
      if (!t.appointment_id || seen.has(t.appointment_id)) continue;
      seen.add(t.appointment_id);
      const appt = Object.values(current).find(a => a && a.id === t.appointment_id);
      if (!appt) continue;
      let ests = [];
      if (appt.lead_id) ests = await sb('GET', `/estimates?lead_id=eq.${encodeURIComponent(appt.lead_id)}&status=eq.accepted&select=id,estimate_number&limit=5`);
      if ((!Array.isArray(ests) || !ests.length) && appt.customer_id) {
        ests = await sb('GET', `/estimates?customer_id=eq.${encodeURIComponent(appt.customer_id)}&status=eq.accepted&select=id,estimate_number&limit=5`);
      }
      for (const e of (Array.isArray(ests) ? ests : [])) {
        estimateWarnings.push({ appointment_id: t.appointment_id, estimate_number: e.estimate_number, note: 'accepted estimate linked; its sold-on-site audit line renders from this appointment time (the stamped sold_on_site value does not change)' });
      }
    }

    // Apply-mode side effects, per appointment (not per stored row): the same
    // trail a live reschedule leaves, the Google push so the calendar
    // follows, and the ingest-log rows that clear the Ops Queue check.
    if (apply) {
      for (const [apptId, a] of Object.entries(appliedByAppt)) {
        try { await pushApptById(sb, apptId); }
        catch (e) { console.warn('pec-appt-replay: push kick failed (non-fatal):', e && e.message); }
        const fromTxt = `${apptDateStr(a.before.start_at)}, ${apptTimeStr(a.before.start_at)}`;
        const toTxt = `${apptDateStr(a.after.start_at)}, ${apptTimeStr(a.after.start_at)}`;
        if (a.lead_id) {
          await sb('POST', '/lead_events', {
            lead_id: a.lead_id, event_type: 'note',
            payload: { text: `Rescheduled via Routemize (replayed): ${fromTxt} to ${toTxt}`, via: 'routemize_reschedule', appointment_id: apptId },
          }).catch(e => console.warn('pec-appt-replay: lead note failed (non-fatal):', e && e.message));
        }
        await sb('POST', '/pec_notifications', {
          type: 'appointment_rescheduled',
          body: `Routemize reschedule replayed: ${a.title || 'appointment'} moved to ${toTxt} (was ${fromTxt})`,
          target_view: 'appointments', target_id: apptId,
        }).catch(e => console.warn('pec-appt-replay: bell failed (non-fatal):', e && e.message));
        await logIngest({ endpoint: ENDPOINT, deal_id: a.routemize_appt_id, customer_name: null, outcome: 'ok', status_code: 200, message: `replay: applied appointment ${apptId}: start ${a.before.start_at} -> ${a.after.start_at}`, payload: null });
      }
      // A quiet 'no change needed' row per untouched appointment, once ever
      // (skipped when a replay row for it already exists): it clears any
      // lingering not-applied rows off the derived check without re-logging
      // on every re-run.
      for (const [rmId, appt] of Object.entries(current)) {
        if (!appt || appliedByAppt[appt.id] || alreadyReplayed.has(appt.id)) continue;
        await logIngest({ endpoint: ENDPOINT, deal_id: rmId, customer_name: null, outcome: 'ok', status_code: 200, message: `replay: no change needed (appointment ${appt.id} already correct)`, payload: null });
      }
    }

    return json(200, {
      success: true,
      dry_run: !apply,
      examined: report.length,
      would_change: touched.length,
      applied: apply ? Object.keys(appliedByAppt).length : 0,
      accepted_estimate_warnings: estimateWarnings,
      rows: report,
    });
  } catch (err) {
    console.error('pec-appt-replay failed:', err);
    return json(500, { success: false, error: err && err.message });
  }
};
