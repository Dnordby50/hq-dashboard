// On-demand twin of pec-quo-contact-sync (prompt 107): Netlify refuses direct
// invocation of schedule-declared functions, so a staff JWT (or the webhook
// secret) drives this one. Two jobs:
//   POST {}                          drain the queue now (same pass)
//   POST { "backfill": "dry" }       the one-time backfill DRY RUN report:
//                                    every Quo contact it would create,
//                                    rename (old -> new) or skip, with counts
//   POST { "backfill": "live" }      enqueue the backfill rows (idempotent);
//                                    ONLY after Dylan reviews the dry run.
// Explicit manual runs are their own authorization (the Run now pattern) and
// are not gated by quo_contact_sync_enabled... except the LIVE backfill,
// which also refuses while the sync is switched off so rows cannot pile up
// unpushed.
const { json, badSecret, requireStaff } = require('./_pec-supabase.cjs');
const { runSyncPass, planBackfill, loadSettings } = require('./_pec-quo-contacts.cjs');
const { sb } = require('./_pec-supabase.cjs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (badSecret(event)) {
    const auth = await requireStaff(event);
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });
  }
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  try {
    if (body.backfill === 'dry' || body.backfill === 'live') {
      if (body.backfill === 'live') {
        const s = await loadSettings(sb);
        if (!s.enabled) return json(409, { ok: false, error: 'quo_contact_sync_enabled is false; switch the sync on before the live backfill.' });
      }
      const report = await planBackfill({ dry: body.backfill === 'dry' });
      return json(200, { ok: true, mode: body.backfill, ...report });
    }
    const result = await runSyncPass({ source: 'manual_run', cap: Number.isFinite(Number(body.cap)) && Number(body.cap) > 0 ? Number(body.cap) : 40 });
    return json(200, result);
  } catch (err) {
    console.error('pec-quo-contact-sync-run failed:', err && err.message);
    return json(500, { ok: false, error: err && err.message });
  }
};
