// On-demand system heartbeat (prompt 90 Task A): the HTTP twin of the
// scheduled pec-system-heartbeat, needed because Netlify refuses direct
// invocation of schedule-declared functions with an empty 403. Two callers:
// the Settings > System health card's "Run now" button (staff JWT) and
// Cowork's verification curl (x-webhook-secret). Same core, same stored
// result, same Slack rule.

const { json, badSecret, requireStaff } = require('./_pec-supabase.cjs');
const { runHealthChecks } = require('./_pec-health.cjs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (badSecret(event)) {
    const auth = await requireStaff(event);
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });
  }
  try {
    const result = await runHealthChecks();
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error('pec-system-heartbeat-run failed:', err && err.message || err);
    return json(500, { ok: false, error: String(err && err.message || err) });
  }
};
