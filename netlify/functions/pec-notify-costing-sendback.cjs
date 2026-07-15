// Best-effort Slack notice when a job costing is sent back to its submitter.
// Called from the dashboard (openModal send-back flow) AFTER the send-back row is
// recorded. Posts to the #epoxysales channel via the SLACK_OFFICE_WEBHOOK incoming
// webhook, the same channel + secret the invoice/stripe/estimate paths already use.
//
// There is NO Slack bot token and NO per-user DM path wired, so this is a CHANNEL
// post, not a DM to the submitter. The bell notification (log_costing_sent_back
// RPC) and the on-job banner are the submitter-targeted channels; Slack is the
// broadcast.
//
// Resilience: this is fire-and-forget. A missing SLACK_OFFICE_WEBHOOK or any Slack
// failure must NEVER surface as a send-back failure, so this ALWAYS returns 200.
// The caller does not read the body; it only needs the request not to throw.

const SLACK_OFFICE_WEBHOOK = process.env.SLACK_OFFICE_WEBHOOK;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function jc(statusCode, body) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  // Always 200, even on a bad method or bad JSON: a notifier must not report a
  // failure that would make the caller think the send-back itself failed.
  if (event.httpMethod !== 'POST') return jc(200, { ok: true, slacked: false, reason: 'method' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return jc(200, { ok: true, slacked: false, reason: 'bad-json' }); }

  const customer = String(body.customer || '').trim() || 'a job';
  const sentBackBy = String(body.sentBackBy || '').trim() || 'The reviewer';
  const note = String(body.note || '').trim();

  if (!SLACK_OFFICE_WEBHOOK) return jc(200, { ok: true, slacked: false, reason: 'no-webhook' });

  let slacked = false, slackError = null;
  try {
    const text = `:leftwards_arrow_with_hook: *${customer}* job costing was sent back by *${sentBackBy}*` + (note ? `\nReason: ${note}` : '');
    const res = await fetch(SLACK_OFFICE_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.ok) slacked = true;
    else { slackError = 'Slack ' + res.status; console.error('notify-costing-sendback: slack failed', res.status); }
  } catch (e) {
    slackError = e && e.message ? e.message : String(e);
    console.error('notify-costing-sendback: slack error', slackError);
  }
  return jc(200, { ok: true, slacked, slackError });
};
