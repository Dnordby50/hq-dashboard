// On-demand lead re-score pass (prompt 97): the HTTP twin of the scheduled
// pec-lead-score-runner, needed because Netlify refuses direct invocation of
// schedule-declared functions with an empty 403 (the pec-system-heartbeat-run
// pattern). Two callers: staff JWT, or Cowork's backfill curl with
// x-webhook-secret.
//
// SIZED TO THE PLATFORM (Cowork's 2026-08-18 backfill finding): a
// synchronous Netlify invocation is killed at ~26 seconds and one score is
// one 8-12s model call, so this twin caps each pass at 3 leads BY DEFAULT
// and reports `remaining`. To drain a backlog, call it in a loop until
// remaining is 0; every pass resumes where the last stopped (leads are
// written as scored; staleness order + the freshness skip are the cursor).
// Do NOT read a 504 as failure, and never say "one curl" in a handoff.
// Overrides:
//   { "cap": 5 }           leads per pass (keep it 26s-safe)
//   { "fresh_hours": 24 }  freshness skip window (default 24 here per the
//                          prompt: never clobber a lead somebody refreshed by
//                          hand in the last day; the nightly tick uses 20)
// Deliberately NOT gated by lead_score_nightly_enabled: an explicit manual
// run is its own authorization, exactly like the heartbeat's Run now button.

const { json, badSecret, requireStaff } = require('./_pec-supabase.cjs');
const { runScorePass } = require('./_pec-lead-score.cjs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (badSecret(event)) {
    const auth = await requireStaff(event);
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });
  }
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  try {
    const result = await runScorePass({
      cap: Number.isFinite(Number(body.cap)) && Number(body.cap) > 0 ? Number(body.cap) : 3,
      freshHours: Number.isFinite(Number(body.fresh_hours)) ? Number(body.fresh_hours) : 24,
      source: 'manual_run',
    });
    console.log('pec-lead-score-run:', JSON.stringify(result));
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error('pec-lead-score-run failed:', err);
    return json(500, { ok: false, error: String(err && err.message || err) });
  }
};
