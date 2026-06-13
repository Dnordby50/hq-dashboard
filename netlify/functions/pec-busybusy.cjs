// Netlify Function: BusyBusy read proxy (Part B of the Job Costing build).
// Session-gated, read-only. NEVER writes back to BusyBusy.
//
// Why this exists: the BusyBusy API key must not ship in client code, and the
// browser cannot call BusyBusy directly (no CORS). This runs server-side,
// authenticates with the key, and returns JSON from the dashboard's origin.
//
// API SHAPE (researched 2026-06-13 from the @busybusy/data npm client): the
// BusyBusy API is a VERSIONED JSON/REST API (PHP backend, JSON-API style:
// /<version>/<dasherized-resource>, `filter` query params), NOT GraphQL. There
// are no public docs, so this proxy hardcodes NOTHING about paths, auth, or
// schema. Everything comes from env, and `action=probe` is a generic
// authenticated passthrough so we can discover the real resource names + shape
// once the key is configured, THEN wire action=timeentries / action=projects.
//
// Env (set in Netlify; Dylan handoff):
//   BUSYBUSY_API_TOKEN   the Integration Key value (required)
//   BUSYBUSY_API_URL     API base, e.g. https://api.busybusy.io  (required)
//   BUSYBUSY_AUTH_HEADER header that carries the key (default: Key-Authorization)
//   BUSYBUSY_AUTH_PREFIX optional value prefix, e.g. "Bearer " (default: none)
// Plus the shared SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY used to verify the
// caller's Supabase session.
// .cjs extension is deliberate (package.json has "type":"module").

// Verify the caller's Supabase session (same gate as pec-companycam.cjs): the
// dashboard sends the signed-in user's access token as Authorization: Bearer;
// GoTrue's /auth/v1/user validates it in one cheap GET.
async function callerIsStaff(event) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return false;
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const userToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!userToken) return false;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${userToken}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  // 200-with-{error} for every failure, like pec-companycam.cjs: the dashboard
  // reads res.error and degrades to the manual-hours fallback instead of
  // logging a console error on every costing open.
  const fail = (error, extra = {}) => ({ statusCode: 200, headers: cors, body: JSON.stringify({ error, entries: [], projects: [], ...extra }) });

  if (!(await callerIsStaff(event))) return fail('Not authorized');

  const token = process.env.BUSYBUSY_API_TOKEN;
  if (!token) return fail('BusyBusy is not configured. Set BUSYBUSY_API_TOKEN in the Netlify environment.');
  const base = process.env.BUSYBUSY_API_URL;
  if (!base) return fail('BusyBusy base URL not set. Add BUSYBUSY_API_URL (e.g. https://api.busybusy.io) once the key docs confirm it.');

  // Auth header is configurable because BusyBusy publishes no docs: the key may
  // ride on Key-Authorization (their historical scheme) or Authorization.
  const authHeader = process.env.BUSYBUSY_AUTH_HEADER || 'Key-Authorization';
  const authPrefix = process.env.BUSYBUSY_AUTH_PREFIX || '';
  const baseHeaders = { [authHeader]: authPrefix + token, Accept: 'application/json' };

  const params = event.queryStringParameters || {};
  const action = params.action || 'probe';

  try {
    // Generic authenticated GET passthrough for DISCOVERY. Give it a path (and
    // optional raw query string) and it returns the live status + JSON, so we
    // can find the real time-entry / project / member resources and their
    // field names before wiring typed actions. Path is constrained to a
    // relative path under the configured base (no host override).
    if (action === 'probe') {
      const path = String(params.path || '').replace(/^\/+/, '');
      const qs = params.query ? ('?' + params.query) : '';
      const url = base.replace(/\/+$/, '') + '/' + path + qs;
      const res = await fetch(url, { headers: baseHeaders });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* return raw text below */ }
      return { statusCode: 200, headers: cors, body: JSON.stringify({ status: res.status, url, data: json, raw: json ? undefined : text.slice(0, 2000) }) };
    }

    // action=timeentries / action=projects are intentionally NOT implemented
    // against guessed resource paths or field names. Once `probe` reveals the
    // real resource (e.g. /v1/time-entries) and its shape, map them here and
    // add a since=<ISO> filter for incremental sync.
    if (action === 'timeentries' || action === 'projects') {
      return fail(`action "${action}" is not wired yet: use action=probe&path=<resource> to discover the BusyBusy resource + fields first, then implement it on the real shape.`);
    }

    return fail(`Unknown action "${action}"`);
  } catch (err) {
    return fail('BusyBusy request failed: ' + (err && err.message ? err.message : String(err)));
  }
};
