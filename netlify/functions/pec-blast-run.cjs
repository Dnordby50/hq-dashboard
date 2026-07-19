// "Send now" kick for a confirmed blast (prompt 35 Part D). The wizard calls
// this right after the confirm click so recipients start going out
// immediately instead of waiting for the next 15-minute drip tick; the
// scheduled tick (pec-drip-runner.cjs) remains the safety net that resumes
// any blast this call did not finish (crash, function time budget, quiet
// hours holding SMS, master switch flipped on later).
//
// Safe to call repeatedly: drainBlasts only ever processes 'queued' ledger
// rows and claims each with a conditional PATCH, so a re-kick can never
// double-send. With the master switch OFF this is a no-op that says so.
//
// Auth: staff JWT, same posture as pec-send-sms.cjs (this endpoint takes a
// parameter and pushes real messages, so the open-runner posture would be
// wrong here).

const { sb, json } = require('./_pec-supabase.cjs');
const { drainBlasts } = require('./_pec-drip.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ~20s work budget: Netlify functions cap at 26s and the client treats a
// partial drain as success (the scheduled tick finishes the rest).
const TIME_BUDGET_MS = 20000;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function jc(statusCode, body) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function getUser(token) {
  if (!token || !SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { ok: false, error: 'Method not allowed' });

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const user = await getUser(authHeader.replace(/^Bearer\s+/i, '').trim());
  if (!user || !user.id) return jc(401, { ok: false, error: 'Not authenticated' });

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { ok: false, error: 'Invalid JSON' }); }
  const blastId = input.blast_id;
  if (!blastId) return jc(400, { ok: false, error: 'blast_id is required' });

  try {
    const started = Date.now();
    const totals = { master_off: false, sent: 0, failed: 0, skipped: 0, stalled: 0, done: 0, passes: 0, sms_held_quiet: false };
    // Loop passes until the blast is done, a pass makes no progress (all SMS
    // held for quiet hours), or the time budget runs out.
    for (;;) {
      const s = await drainBlasts({ sb }, { blastId });
      totals.passes++;
      totals.master_off = s.master_off;
      totals.sent += s.sent; totals.failed += s.failed; totals.skipped += s.skipped; totals.stalled += s.stalled;
      totals.sms_held_quiet = totals.sms_held_quiet || s.sms_held_quiet;
      totals.done = s.done;
      const progressed = (s.sent + s.failed + s.skipped) > 0;
      if (s.master_off || s.done || !progressed || Date.now() - started > TIME_BUDGET_MS) break;
    }
    console.log('pec-blast-run:', blastId, JSON.stringify(totals));
    return jc(200, { ok: true, ...totals });
  } catch (err) {
    console.error('pec-blast-run failed:', err && err.message || err);
    return jc(500, { ok: false, error: String(err && err.message || err) });
  }
};
