// System heartbeat check core (prompt 90 Task A). Shared by the daily
// scheduled wrapper (pec-system-heartbeat) and the HTTP runner
// (pec-system-heartbeat-run: the Settings card's "Run now" button and
// Cowork's curl), because Netlify refuses direct HTTP invocation of any
// schedule-declared function with an empty 403 (verified live 2026-08-12;
// the same refusal is why pec-migration-drift-run.cjs exists).
//
// The result is STORED (writeHeartbeat details JSON on the monitor's own
// row) and the Ops Queue + Settings > System health card DERIVE their
// display from it at render, so a red line self-clears the next time a run
// comes back green. Nothing here inserts Ops rows (the prompt-55 pattern:
// derived, not stored). One Slack line goes out only when something is
// failing; silence is green.

const { sb, writeHeartbeat } = require('./_pec-supabase.cjs');

const SITE_URL = process.env.URL || 'https://prescottepoxy.netlify.app';

// Expected cadence (hours) per scheduled function. UPDATE THIS MAP when a
// schedule is added to or removed from netlify.toml — the monitor flags any
// entry whose last_ok_at is older than cadence + the staleness slack, and a
// function listed here that never writes a heartbeat shows as "never
// recorded". The monitor itself is deliberately absent (the Ops Queue
// watches the watcher client-side, so a dead monitor cannot vouch for
// itself).
const SCHEDULED_CADENCE_HOURS = {
  'pec-auto-progress': 24,
  'pec-openphone-sync': 0.25,
  'pec-drip-runner': 0.25,
  'pec-appt-reminder-runner': 0.25,
  'pec-migration-drift': 24,
  'pec-birthday-reminders': 24,
  'pec-security-monitor': 0.25,
  'pec-google-calendar-pull': 0.25,
  'pec-lost-reason-backfill': 24,
  'pec-lead-score-runner': 24,
  'pec-salesask-sync': 0.25,
};

async function timedFetch(url, opts = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

async function getSettings(keys) {
  const rows = await sb('GET', `/settings?key=in.(${keys.join(',')})&select=key,value`);
  return Object.fromEntries((Array.isArray(rows) ? rows : []).map(r => [r.key, r.value]));
}

// One check = { name, ok, issue? }. Every check is wrapped: a thrown check
// reports itself as an issue instead of killing the run.
async function runHealthChecks() {
  const cfg = await getSettings([
    'system_health_enabled', 'system_health_stale_hours',
    'system_health_slack_enabled', 'system_health_stripe_stale_days',
  ]).catch(() => ({}));
  if ((cfg.system_health_enabled || 'true') === 'false') {
    return { ran_at: new Date().toISOString(), disabled: true, issues: [], checks: [] };
  }
  const slackHours = Number(cfg.system_health_stale_hours) > 0 ? Number(cfg.system_health_stale_hours) : 6;
  const stripeBizDays = Number(cfg.system_health_stripe_stale_days) > 0 ? Number(cfg.system_health_stripe_stale_days) : 7;

  const issues = [];
  const checks = [];
  const check = async (name, fn) => {
    try {
      const issue = await fn();
      checks.push({ name, ok: !issue, issue: issue || null });
      if (issue) issues.push(issue);
    } catch (e) {
      const issue = `${name} check itself failed: ${String(e && e.message || e).slice(0, 120)}`;
      checks.push({ name, ok: false, issue });
      issues.push(issue);
    }
  };

  // 1. Every scheduled function ran within cadence + slack.
  await check('scheduled_functions', async () => {
    const rows = await sb('GET', '/pec_heartbeats?select=function_name,last_ok_at');
    const byName = Object.fromEntries((Array.isArray(rows) ? rows : []).map(r => [r.function_name, r.last_ok_at]));
    const stale = [];
    for (const [name, cadence] of Object.entries(SCHEDULED_CADENCE_HOURS)) {
      const last = byName[name];
      if (!last) { stale.push(`${name} never recorded`); continue; }
      const ageH = (Date.now() - new Date(last).getTime()) / 3600000;
      if (ageH > cadence + slackHours) {
        stale.push(`${name} stale ${ageH >= 48 ? Math.round(ageH / 24) + 'd' : Math.round(ageH) + 'h'}`);
      }
    }
    return stale.length ? `scheduled functions stale: ${stale.join(', ')}` : null;
  });

  // 2. Webhook health: errored ingests in the last 24h.
  await check('webhooks', async () => {
    const since = new Date(Date.now() - 24 * 3600000).toISOString();
    const rows = await sb('GET',
      `/pec_webhook_ingest_log?outcome=in.(error,bridge_failed)&created_at=gte.${encodeURIComponent(since)}&select=endpoint`);
    const n = Array.isArray(rows) ? rows.length : 0;
    return n ? `${n} webhook error${n === 1 ? '' : 's'} in 24h` : null;
  });

  // 3. Send failures in the last 24h. The two logs key on DIFFERENT
  // timestamps (SCHEMA gotcha): email has sent_at, sms has created_at.
  await check('sends', async () => {
    const since = new Date(Date.now() - 24 * 3600000).toISOString();
    const [em, sm] = await Promise.all([
      sb('GET', `/pec_email_log?status=eq.failed&sent_at=gte.${encodeURIComponent(since)}&select=id`),
      sb('GET', `/pec_sms_log?status=eq.failed&created_at=gte.${encodeURIComponent(since)}&select=id`),
    ]);
    const e = Array.isArray(em) ? em.length : 0;
    const s = Array.isArray(sm) ? sm.length : 0;
    const parts = [];
    if (e) parts.push(`${e} email`);
    if (s) parts.push(`${s} SMS`);
    return parts.length ? `send failures in 24h: ${parts.join(', ')}` : null;
  });

  // 4. The review redirect is alive. This one check would have caught the
  // dead review link on day one (302ing to google.com's HOMEPAGE was the
  // bug: assert the Location goes to google.com at all, and record it).
  // The probe token does not exist; the function redirects unconditionally
  // by design.
  await check('review_redirect', async () => {
    const res = await timedFetch(`${SITE_URL}/r/heartbeat-probe`, { redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return `review redirect answered ${res.status}, not a redirect`;
    const loc = res.headers.get('location') || '';
    let host = '';
    try { host = new URL(loc).hostname; } catch (_) {}
    if (!/(^|\.)google\.com$/.test(host)) return `review redirect points at ${host || 'nowhere'}, not google.com`;
    return null;
  });

  // 5. Stripe webhook freshness: pending rows older than N business days
  // (ACH settles in 3-5; a stuck row means the webhook stopped landing).
  // Business days approximated as calendar days * 7/5.
  await check('stripe_pending', async () => {
    const calDays = Math.ceil(stripeBizDays * 7 / 5);
    const cutoff = new Date(Date.now() - calDays * 24 * 3600000).toISOString();
    const rows = await sb('GET',
      `/pec_stripe_pending?status=eq.pending&created_at=lt.${encodeURIComponent(cutoff)}&select=id`);
    const n = Array.isArray(rows) ? rows.length : 0;
    return n ? `${n} Stripe payment${n === 1 ? '' : 's'} stuck pending over ${stripeBizDays} business days` : null;
  });

  // 6. Public page probes: a bogus token must produce the function's own
  // polite not-found response, never a 5xx (a 5xx means the function itself
  // is broken, which is exactly the class of silent failure this exists for).
  await check('public_pages', async () => {
    const bad = [];
    for (const path of ['/e/heartbeat-bogus-token', '/pay/heartbeat-bogus-token']) {
      const res = await timedFetch(`${SITE_URL}${path}`);
      if (res.status >= 500) bad.push(`${path} answered ${res.status}`);
    }
    return bad.length ? `public pages broken: ${bad.join(', ')}` : null;
  });

  const result = { ran_at: new Date().toISOString(), ok: issues.length === 0, issues, checks };

  // ONE Slack line, only when something is failing. Reuses the
  // SLACK_OFFICE_WEBHOOK channel post every other alert uses; a missing
  // webhook or Slack failure never fails the run.
  if (issues.length && (cfg.system_health_slack_enabled || 'true') !== 'false') {
    const hook = process.env.SLACK_OFFICE_WEBHOOK;
    if (hook) {
      try {
        const res = await timedFetch(hook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `:rotating_light: Heartbeat: ${issues.length} issue${issues.length === 1 ? '' : 's'} (${issues.join('; ').slice(0, 600)})` }),
        });
        if (!res.ok) console.warn(`_pec-health: Slack post failed (${res.status})`);
      } catch (e) { console.warn('_pec-health: Slack post failed:', e && e.message); }
    } else {
      console.log('_pec-health: SLACK_OFFICE_WEBHOOK not set; Slack line skipped');
    }
  }

  // The stored result IS the surface: Ops Queue + Settings read this row.
  await writeHeartbeat('pec-system-heartbeat', result);
  return result;
}

module.exports = { runHealthChecks, SCHEDULED_CADENCE_HOURS };
