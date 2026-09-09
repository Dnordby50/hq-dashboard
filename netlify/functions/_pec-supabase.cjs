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
  const authController = opts && Number(opts.timeoutMs) > 0 ? new AbortController() : null;
  const authTimer = authController ? setTimeout(() => authController.abort(), Number(opts.timeoutMs)) : null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
      ...(authController ? { signal: authController.signal } : {}),
    });
    if (!res.ok) return { ok: false, status: 401, error: 'Invalid session' };
    user = await res.json();
  } catch (_) {
    return { ok: false, status: 401, error: 'Invalid session' };
  } finally { if (authTimer) clearTimeout(authTimer); }
  if (!user || !user.id) return { ok: false, status: 401, error: 'Invalid session' };

  let staff;
  try {
    const rows = await sb('GET', `/admin_users?auth_user_id=eq.${encodeURIComponent(user.id)}&select=id,email,name,role&limit=1`, null, opts && opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined);
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

// opts: boolean (legacy returnRow) or { returnRow, actor, headers }.
// actor (2026-09-21): a short label naming WHO this write is for, sent as the
// x-topcoat-actor header. PostgREST exposes request headers to SQL as the
// request.headers GUC, and the pec_appointments audit trigger
// (pec_appt_actor) reads that header when there is no signed-in user, so a
// service-role write from /book manage, the Routemize intake, or the Google
// pull is attributed to the right party instead of a generic 'System'.
async function sb(method, path, payload, opts) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase env vars not configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)');
  }
  const o = (opts && typeof opts === 'object') ? opts : { returnRow: !!opts };
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (o.returnRow) headers['Prefer'] = 'return=representation';
  if (o.actor) headers['x-topcoat-actor'] = String(o.actor).slice(0, 120);
  if (o.headers && typeof o.headers === 'object') Object.assign(headers, o.headers);

  // Opt-in deadline for resumable workers. Keep the timer through body reads
  // and actually abort the request; a Promise.race would leave writes running.
  const controller = Number(o.timeoutMs) > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Number(o.timeoutMs)) : null;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${text}`);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    return await (ct.includes('application/json') ? res.json() : res.text());
  } finally {
    if (timer) clearTimeout(timer);
  }
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

// Heartbeat stamp for scheduled functions (prompt 90 Task A). Each scheduled
// job calls this at the end of a SUCCESSFUL run; the daily
// pec-system-heartbeat monitor flags any function whose last_ok_at is older
// than its cadence plus slack. Same contract as logIngest: NEVER throws, a
// heartbeat failure must never fail the job it observes. GET-then-write
// instead of upsert because sb()'s headers are fixed (the saveTokenRow
// pattern); scheduled jobs never race themselves on this row.
async function writeHeartbeat(functionName, details) {
  try {
    const patch = { last_ok_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (details !== undefined) patch.details = details;
    const rows = await sb('GET', `/pec_heartbeats?function_name=eq.${encodeURIComponent(functionName)}&select=function_name&limit=1`);
    if (Array.isArray(rows) && rows[0]) {
      await sb('PATCH', `/pec_heartbeats?function_name=eq.${encodeURIComponent(functionName)}`, patch);
    } else {
      await sb('POST', '/pec_heartbeats', { function_name: functionName, ...patch });
    }
  } catch (e) {
    console.error(`writeHeartbeat(${functionName}) failed (non-fatal):`, e && e.message ? e.message : e);
  }
}

// Wrap a db function so every call carries the actor label (see sb()). Works
// over the real sb and over injected test doubles (which ignore the extra
// option). The wrapped function keeps the (method, path, payload, opts) shape.
function withActor(db, actor) {
  return (method, path, payload, opts) => {
    const o = (opts && typeof opts === 'object') ? { ...opts } : { returnRow: !!opts };
    if (!o.actor) o.actor = actor;
    return db(method, path, payload, o);
  };
}

module.exports = { sb, withActor, json, badSecret, safeEqual, requireStaff, randomToken, tokenFromEvent, epoxyStages, paintStages, logIngest, writeHeartbeat };
