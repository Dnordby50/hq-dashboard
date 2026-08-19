// Nightly follow-up rank (prompt 98), scheduled wrapper. 13:15 UTC = 06:15
// MST (prompt 49's slot: ranks are ready before the sales day starts, ahead
// of the 07:00 drift check and the 07:30 default Slack digest). The engine
// lives in _pec-followup.cjs; the HTTP twin pec-followup-rank-run.cjs serves
// the view's "Re-rank now" button, because Netlify refuses direct invocation
// of schedule-declared functions.
//
// Membership is deterministic (production/followup-rules.cjs); this run only
// ORDERS the already-selected subjects and words the openers. Gated by
// followup_enabled; AI portion further gated by followup_ai_rank_enabled,
// and any model failure still writes fallback rows so the table is never
// empty.
'use strict';

const { json } = require('./_pec-supabase.cjs');
const { runFollowupRank } = require('./_pec-followup.cjs');

exports.handler = async () => {
  try {
    const result = await runFollowupRank();
    console.log('pec-followup-rank:', JSON.stringify(result));
    return json(200, result);
  } catch (err) {
    console.error('pec-followup-rank failed:', err);
    return json(500, { ok: false, error: String(err && err.message || err) });
  }
};

// Heartbeat (prompt 90 Task A): stamp AFTER a successful run, gated no-ops
// included (the SCHEDULE firing is what the monitor watches). Best-effort.
{
  const { writeHeartbeat } = require('./_pec-supabase.cjs');
  const _handler = exports.handler;
  exports.handler = async (event, context) => {
    const res = await _handler(event, context);
    try {
      if (res && res.statusCode === 200 && JSON.parse(res.body || '{}').ok === true) await writeHeartbeat('pec-followup-rank');
    } catch (_) { /* best-effort */ }
    return res;
  };
}
