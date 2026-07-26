// Stuck-sync escalation endpoint (prompt 48, Part B). The estimator POSTs
// here ONCE per screen session when a queued save first crosses the failure
// threshold, so the office gets a bell even when the rep does not read (or
// understand) the red banner. Payload is metadata only: op/table/row ids,
// attempt counts, timestamps, and the raw error string. NO customer PII
// beyond ids and NO row bodies, by design.
//
// Writes are idempotent: reports upsert on op_id (a repeat from the same
// device updates attempts/error instead of piling up rows), and the bell
// fires only when a report is NEW or was previously marked resolved and has
// re-broken -- so one stuck op is one notification, however many sessions
// re-report it. Gated by the sync_stuck_escalation_enabled setting (the
// client checks it too via the catalog; this is the authoritative check).
//
// Requires supabase/migrations/2026-07-25_sync_stuck_reports.sql. Before it
// lands, the insert fails and this returns ok:false -- the estimator treats
// the report as best-effort, so nothing user-facing breaks.

const { sb, json, requireStaff } = require('./_pec-supabase.cjs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);
const MAX_OPS = 25;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });
  // Staff-only: this writes to pec_notifications with a caller-influenced body.
  // Unauthenticated it was a spoofing / notification-spam vector. The estimator
  // sends the rep's staff JWT.
  const auth = await requireStaff(event);
  if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });
  try {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { ok: false, error: 'invalid JSON' });
    }
    const ops = Array.isArray(body.ops) ? body.ops.slice(0, MAX_OPS) : [];
    if (!ops.length) return json(400, { ok: false, error: 'no ops' });

    const set = await sb('GET', '/settings?key=eq.sync_stuck_escalation_enabled&select=value');
    if (((set || [])[0] || {}).value === 'false') {
      return json(200, { ok: true, skipped: 'sync_stuck_escalation_enabled is false' });
    }

    let reported = 0;
    let notified = 0;
    const failures = [];
    for (const op of ops) {
      try {
        const opId = String(op.opId || '').slice(0, 120);
        if (!opId) continue;
        const fields = {
          table_name: String(op.table || 'unknown').slice(0, 60),
          row_id: uuidOrNull(op.id),
          attempts: Number.isFinite(Number(op.attempts)) ? Number(op.attempts) : 0,
          first_queued_at: op.firstQueuedAt && !isNaN(Date.parse(op.firstQueuedAt)) ? op.firstQueuedAt : null,
          last_error: op.lastError != null ? String(op.lastError).slice(0, 2000) : null,
          estimate_id: uuidOrNull(op.estimateId),
          reported_at: new Date().toISOString(),
        };

        const existing = await sb('GET', `/pec_sync_stuck_reports?op_id=eq.${encodeURIComponent(opId)}&select=id,resolved_at&limit=1`);
        const row = (existing || [])[0];
        // Bell on a NEW report, or on a resolved one that has re-broken
        // (re-opened below). An open, already-reported op stays silent.
        const shouldNotify = !row || row.resolved_at != null;
        if (row) {
          await sb('PATCH', `/pec_sync_stuck_reports?id=eq.${row.id}`, { ...fields, resolved_at: null });
        } else {
          await sb('POST', '/pec_sync_stuck_reports', { op_id: opId, ...fields });
        }
        reported++;

        if (shouldNotify) {
          const what = fields.estimate_id ? `estimate ${fields.estimate_id.slice(0, 8)}` : `${fields.table_name} row`;
          const since = fields.first_queued_at ? ` since ${fields.first_queued_at.slice(0, 10)}` : '';
          await sb('POST', '/pec_notifications', {
            type: 'sync_stuck',
            body: `An estimator save is stuck (${what}, ${fields.attempts} attempts${since}). The rep's work is saved on their device, not in the database. Error: ${(fields.last_error || 'unknown').slice(0, 200)}`,
            priority: 'high',
            target_view: fields.estimate_id ? 'estimates' : null,
            target_id: fields.estimate_id,
          });
          notified++;
        }
      } catch (e) {
        failures.push({ opId: op && op.opId, error: e.message || String(e) });
      }
    }
    return json(200, { ok: failures.length === 0, reported, notified, failures });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
