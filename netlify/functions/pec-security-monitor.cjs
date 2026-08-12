// Scheduled security monitor (security remediation Phase 3, "audit + monitoring").
// Runs on a schedule (see netlify.toml) and raises an out-of-band Slack alert on
// the highest-signal account-takeover indicator we can derive from data we already
// collect: a staff sign-in from an IP address that user has NEVER used before.
//
// Why this signal: sign_in_log records every successful staff sign-in with user +
// IP + timestamp. A first-ever IP for a given user is the classic "someone signed
// in from a new device/location" alert. It is out-of-band (Slack, not the in-app
// bell) so it still lands even if someone is tampering inside the app.
//
// Gated by the security_alerts_enabled setting (standing rule 12: every feature's
// knobs live in Settings). Fully best-effort: any failure is logged and swallowed,
// never throws, so a monitor hiccup cannot affect anything else.
//
// Scheduled-only: this reads sign_in_log via the service role and posts to Slack;
// it takes no request input, so it does not need (and does not add) an HTTP auth
// gate the way the manual endpoints do. If it is ever made HTTP-triggerable, add a
// requireStaff/secret gate first.

const { sb } = require('./_pec-supabase.cjs');

const SLACK_OFFICE_WEBHOOK = process.env.SLACK_OFFICE_WEBHOOK;
const DEFAULT_LOOKBACK_MIN = 20; // must be >= the schedule interval so nothing is missed

exports.handler = async () => {
  try {
    // Setting gate (default on).
    let enabled = true;
    let lookbackMin = DEFAULT_LOOKBACK_MIN;
    try {
      const rows = await sb('GET', '/settings?key=in.(security_alerts_enabled,security_alerts_lookback_min)&select=key,value');
      const map = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
      if (String(map.security_alerts_enabled || 'true') === 'false') enabled = false;
      const lb = parseInt(map.security_alerts_lookback_min, 10);
      if (Number.isFinite(lb) && lb > 0) lookbackMin = lb;
    } catch (_) { /* defaults */ }
    if (!enabled) return { statusCode: 200, body: 'disabled' };
    if (!SLACK_OFFICE_WEBHOOK) return { statusCode: 200, body: 'no-webhook' };

    const sinceIso = new Date(Date.now() - lookbackMin * 60 * 1000).toISOString();
    // Recent sign-ins in the window.
    const recent = await sb('GET',
      `/sign_in_log?created_at=gte.${encodeURIComponent(sinceIso)}&select=id,auth_user_id,email,ip_address,user_agent,created_at&order=created_at.asc`);
    if (!Array.isArray(recent) || !recent.length) return { statusCode: 200, body: 'no-recent' };

    const alerts = [];
    for (const row of recent) {
      if (!row.auth_user_id || !row.ip_address) continue;
      // Has this user EVER signed in from this IP before this row? (strictly earlier)
      const prior = await sb('GET',
        `/sign_in_log?auth_user_id=eq.${encodeURIComponent(row.auth_user_id)}` +
        `&ip_address=eq.${encodeURIComponent(row.ip_address)}` +
        `&created_at=lt.${encodeURIComponent(row.created_at)}&select=id&limit=1`);
      const seenBefore = Array.isArray(prior) && prior.length > 0;
      if (!seenBefore) {
        alerts.push(row);
      }
    }
    if (!alerts.length) return { statusCode: 200, body: 'no-new-locations' };

    const lines = alerts.map((a) => {
      const who = a.email || a.auth_user_id;
      const when = new Date(a.created_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      return `• *${who}* signed in from a new IP ${a.ip_address} (${when})`;
    });
    const text = `:lock: New-location staff sign-in detected:\n${lines.join('\n')}\nIf this was not expected, have them reset their password and turn on 2FA.`;
    try {
      await fetch(SLACK_OFFICE_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch (e) {
      console.error('pec-security-monitor: slack post failed', e && e.message ? e.message : e);
    }
    return { statusCode: 200, body: `alerted:${alerts.length}` };
  } catch (err) {
    console.error('pec-security-monitor error (non-fatal):', err && err.message ? err.message : err);
    return { statusCode: 200, body: 'error-swallowed' };
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
      if (res && res.statusCode === 200 && res.body !== 'error-swallowed') await writeHeartbeat('pec-security-monitor');
    } catch (_) { /* best-effort */ }
    return res;
  };
}
