// Scheduled function: the appointment confirmation/reminder tick (prompt 37).
// All logic lives in _pec-appt.cjs (runApptReminders); this tick is the
// safety net behind pec-appt-notify's immediate on-book kick, and the only
// sender for offset reminders (e.g. the seeded customer reminder 1 day
// before start_at). Runs every 15 minutes (netlify.toml). Also callable
// on-demand for manual ticks, same posture as pec-drip-runner: an outside
// call can only trigger an ordinary idempotent run, because the
// reminder-sends ledger's unique index makes every leg exactly-once and
// consent is re-checked from the live row at send time. Pre-migration the
// run is a silent no-op (summary.not_migrated).

const { sb, json } = require('./_pec-supabase.cjs');
const { runApptReminders } = require('./_pec-appt.cjs');

exports.handler = async () => {
  try {
    const summary = await runApptReminders({ sb });
    console.log('pec-appt-reminder-runner:', JSON.stringify(summary));
    return json(200, { ok: true, ...summary });
  } catch (err) {
    console.error('pec-appt-reminder-runner failed:', err && err.message || err);
    return json(500, { ok: false, error: String(err && err.message || err) });
  }
};

// Heartbeat (prompt 90 Task A): stamp AFTER a successful run by wrapping the
// handler, so every ok exit path stamps (including gated no-ops: the
// SCHEDULE firing is what the monitor watches, not the feature toggle)
// without touching each return site. Best-effort by contract; a heartbeat
// failure never fails the job.
{
  const { writeHeartbeat } = require('./_pec-supabase.cjs');
  const _handler = exports.handler;
  exports.handler = async (event, context) => {
    const res = await _handler(event, context);
    try {
      if (res && res.statusCode === 200 && JSON.parse(res.body || '{}').ok === true) await writeHeartbeat('pec-appt-reminder-runner');
    } catch (_) { /* best-effort */ }
    return res;
  };
}
