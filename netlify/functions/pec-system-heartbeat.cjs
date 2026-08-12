// Daily system heartbeat, scheduled wrapper (prompt 90 Task A; netlify.toml
// runs it at 14:45 UTC = 07:45 MST, after the morning dailies). All logic
// lives in _pec-health.cjs; the HTTP twin pec-system-heartbeat-run.cjs runs
// the same core on demand, because Netlify 403s direct invocation of
// schedule-declared functions.

const { json } = require('./_pec-supabase.cjs');
const { runHealthChecks } = require('./_pec-health.cjs');

exports.handler = async () => {
  try {
    const result = await runHealthChecks();
    console.log('pec-system-heartbeat:', JSON.stringify({ ok: result.ok, disabled: !!result.disabled, issues: result.issues }));
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error('pec-system-heartbeat failed:', err && err.message || err);
    return json(500, { ok: false, error: String(err && err.message || err) });
  }
};
