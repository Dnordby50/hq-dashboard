// Follow-up Slack digest ticker (prompt 98 Part F). Every 15 minutes; the
// engine sends at the settings-controlled Phoenix time (followup_digest_time,
// default 07:30) at most once a day, deduped through a pec_webhook_ingest_log
// marker row (endpoint 'followup-digest') because a "last sent" value is
// STATE, and state never gets a settings row (rule 12). Posts the top N due
// rows to SLACK_OFFICE_WEBHOOK (falling back to SLACK_LEADS_WEBHOOK, logged
// no-op when neither is set); skips entirely when the queue is empty rather
// than saying "nothing to do" every morning.
'use strict';

const { json } = require('./_pec-supabase.cjs');
const { runFollowupDigest } = require('./_pec-followup.cjs');

exports.handler = async () => {
  try {
    const result = await runFollowupDigest();
    if (!result.skipped) console.log('pec-followup-digest:', JSON.stringify(result));
    return json(200, result);
  } catch (err) {
    console.error('pec-followup-digest failed:', err);
    return json(500, { ok: false, error: String(err && err.message || err) });
  }
};

// Heartbeat (prompt 90 Task A): every ok tick stamps, skips included.
{
  const { writeHeartbeat } = require('./_pec-supabase.cjs');
  const _handler = exports.handler;
  exports.handler = async (event, context) => {
    const res = await _handler(event, context);
    try {
      if (res && res.statusCode === 200 && JSON.parse(res.body || '{}').ok === true) await writeHeartbeat('pec-followup-digest');
    } catch (_) { /* best-effort */ }
    return res;
  };
}
