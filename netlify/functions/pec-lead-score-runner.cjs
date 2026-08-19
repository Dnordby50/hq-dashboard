// Nightly lead re-score runner (prompt 97 Part B). A score written once at
// intake is a snapshot of inquiry quality, not a read on who to call today
// (prompt 49 named this): an estimate sent, an inbound call, a week of
// silence all change the answer, and a Hot-first sort over frozen numbers is
// close to sorting by arrival order. This tick re-scores the open pipeline
// through the SAME core the Refresh button and intake kicks use
// (_pec-lead-score.cjs), so there is exactly one scoring implementation.
//
// Subject set: not deleted, not archived, stage in the settings list
// (lead_score_stages; lost/accepted can never be in it). Opted-out leads
// still score: opting out of texts does not make a lead dead. Ordered by
// staleness (never scored first, then oldest scored_at), capped at
// lead_score_batch_cap (default 50) so a bad day costs a bounded number of
// model calls. Leads scored in the last 20 hours are skipped, so a hand
// refresh earlier today is never immediately clobbered while yesterday's own
// nightly scores (24h old) are never mistaken for fresh.
//
// Timeline rule: NO lead_event per quiet re-score. Only a Hot/Warm/Cold band
// change writes a 'score_band_changed' row (a first-ever score counts: it
// records when scoring began). Eighteen event rows a night would bury the
// real history.
//
// Scheduled nightly at 15:30 UTC = 08:30 MST in netlify.toml, offset from
// the 15:00 pec-lost-reason-backfill so two AI jobs never stack. Gated by
// lead_score_nightly_enabled (missing row = on). On-demand runs (the Part D
// backfill) go through pec-lead-score-run.cjs: Netlify refuses direct
// invocation of schedule-declared functions.

const { json } = require('./_pec-supabase.cjs');
const { runScorePass, loadScoreSettings } = require('./_pec-lead-score.cjs');

exports.handler = async () => {
  try {
    const cfg = await loadScoreSettings();
    if (!cfg.enabled) {
      return json(200, { ok: true, skipped: 'lead_score_nightly_enabled is false' });
    }
    const result = await runScorePass({ freshHours: 20, source: 'nightly_runner' });
    console.log('pec-lead-score-runner:', JSON.stringify(result));
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error('pec-lead-score-runner failed:', err);
    return json(500, { ok: false, error: String(err && err.message || err) });
  }
};

// Heartbeat (prompt 90 Task A): stamp AFTER a successful run by wrapping the
// handler, so every ok exit path stamps (including the gated no-op: the
// SCHEDULE firing is what the monitor watches, not the feature toggle).
// Best-effort by contract; a heartbeat failure never fails the job.
{
  const { writeHeartbeat } = require('./_pec-supabase.cjs');
  const _handler = exports.handler;
  exports.handler = async (event, context) => {
    const res = await _handler(event, context);
    try {
      if (res && res.statusCode === 200 && JSON.parse(res.body || '{}').ok === true) await writeHeartbeat('pec-lead-score-runner');
    } catch (_) { /* best-effort */ }
    return res;
  };
}
