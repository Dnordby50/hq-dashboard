// Shared helpers for pec-webhook-* Netlify Functions.
// Uses the service-role key to bypass RLS. Set these env vars in Netlify:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PEC_WEBHOOK_SECRET
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PEC_WEBHOOK_SECRET = process.env.PEC_WEBHOOK_SECRET;

const epoxyStages = [
  'Proposal Accepted', 'Scheduled', 'Prep Day', 'Coating Day',
  'Cure Period', 'Final Walkthrough', 'Complete',
];
const paintStages = [
  'Proposal Accepted', 'Scheduled', 'Prep', 'Prime',
  'Paint', 'Final Walkthrough', 'Complete',
];

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Constant-time string comparison. A plain `a !== b` short-circuits on the first
// differing byte, so its timing leaks how many leading bytes matched, which lets
// an attacker recover a shared secret byte-by-byte. timingSafeEqual compares in
// time independent of content. Lengths must match first (and comparing the length
// is not itself a meaningful leak). Any secret/token equality check in this repo
// should route through here.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function badSecret(event) {
  const got = event.headers['x-webhook-secret'] || event.headers['X-Webhook-Secret'];
  if (!PEC_WEBHOOK_SECRET || !got) return true;
  return !safeEqual(got, PEC_WEBHOOK_SECRET);
}

// Authorization gate for service-role endpoints. getUser-style checks only prove
// the Bearer JWT is a valid Supabase user; they do NOT prove the caller is staff.
// Because these endpoints use the RLS-bypassing service role, "is a valid login"
// is not enough: any Supabase auth user (including one created outside the staff
// flow, or via self-signup if that is ever enabled) would otherwise be able to
// send SMS/email on the company accounts, run blasts, read metrics, etc. This
// verifies the caller has a row in admin_users, mirroring pec-reset-password.cjs.
// Returns { ok:true, user, staff } or { ok:false, status, error } so callers can
// do: `const a = await requireStaff(event); if(!a.ok) return jc(a.status,{error:a.error});`
// Pass { adminOnly:true } to additionally require role='admin'.
async function requireStaff(event, opts) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 500, error: 'Server auth not configured' };
  }
  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'Not authenticated' };

  let user;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, status: 401, error: 'Invalid session' };
    user = await res.json();
  } catch (_) {
    return { ok: false, status: 401, error: 'Invalid session' };
  }
  if (!user || !user.id) return { ok: false, status: 401, error: 'Invalid session' };

  let staff;
  try {
    const rows = await sb('GET', `/admin_users?auth_user_id=eq.${encodeURIComponent(user.id)}&select=id,email,name,role&limit=1`);
    staff = Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (_) {
    return { ok: false, status: 500, error: 'Authorization check failed' };
  }
  if (!staff) return { ok: false, status: 403, error: 'Staff only' };
  if (opts && opts.adminOnly && staff.role !== 'admin') {
    return { ok: false, status: 403, error: 'Admins only' };
  }
  return { ok: true, user, staff };
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Extract the public token for a customer-facing token page (/pay/<token>,
// /co/<token>). The token normally arrives as ?token= (set by the netlify.toml
// rewrite), but Netlify does NOT reliably interpolate :splat into a toml
// redirect's query string, so fall back to parsing the UUID out of the request
// path (event.path / event.rawUrl still carry the original /pay/<token> URL).
// Any new public token page MUST use this instead of reading
// queryStringParameters.token directly. Beware when testing: the direct
// /.netlify/functions/... URL always has the query param, so it renders fine
// even when the customer-facing URL 404s. That masked the /co/ bug (b5ba809).
function tokenFromEvent(event) {
  let token = (event.queryStringParameters && event.queryStringParameters.token) || '';
  if (!token) {
    let rawUrlPath = '';
    try { rawUrlPath = event.rawUrl ? new URL(event.rawUrl).pathname : ''; } catch (_) {}
    const m = `${event.path || ''} ${rawUrlPath}`.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
    if (m) token = m[1];
  }
  return token;
}

async function sb(method, path, payload, returnRow) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase env vars not configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)');
  }
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (returnRow) headers['Prefer'] = 'return=representation';

  const res = await fetch(url, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${text}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// Best-effort ingestion logger. Writes one row to pec_webhook_ingest_log per
// inbound webhook attempt so partial/rejected/errored deliveries are queryable
// (the "DripJobs Sync Health" view reads this). CRITICAL: this must NEVER throw
// or change the handler's response -- a logging failure (table missing before
// the migration lands, network blip, bad field) is swallowed entirely. Uses the
// service-role sb() client, which bypasses RLS. Fire-and-forget but awaited so
// the lambda does not freeze before the write lands.
async function logIngest(fields) {
  try {
    await sb('POST', '/pec_webhook_ingest_log', {
      endpoint: fields.endpoint || null,
      deal_id: fields.deal_id != null ? String(fields.deal_id) : null,
      customer_name: fields.customer_name || null,
      company: fields.company || null,
      outcome: fields.outcome,            // 'ok' | 'rejected' | 'error' | 'bridge_failed'
      status_code: fields.status_code != null ? fields.status_code : null,
      message: fields.message != null ? String(fields.message).slice(0, 2000) : null,
      payload: fields.payload != null ? fields.payload : null,
      public_job_id: fields.public_job_id || null,
      prod_job_id: fields.prod_job_id || null,
    });
  } catch (logErr) {
    // Intentionally swallowed: the log is observability, never a gate on ingest.
    console.error('logIngest failed (non-fatal):', logErr && logErr.message ? logErr.message : logErr);
  }
}

module.exports = { sb, json, badSecret, safeEqual, requireStaff, randomToken, tokenFromEvent, epoxyStages, paintStages, logIngest };
