// Netlify Function: BusyBusy read proxy (Part B of the Job Costing build).
// Session-gated, read-only. NEVER writes back to BusyBusy.
//
// Why this exists: the BusyBusy API token must not ship in client code, and
// the browser cannot call BusyBusy directly (no CORS). This runs server-side,
// authenticates with the token, and returns JSON from the dashboard's origin.
//
// IMPORTANT (honest scaffold): BusyBusy publishes no public developer / Open
// API docs. The endpoint, auth scheme, and query shape are UNKNOWN until the
// Integration Key + its docs land (Dylan handoff). So this proxy does NOT
// hardcode an unverified endpoint: it reads BUSYBUSY_API_URL from the env and,
// for `action=introspect`, runs a standard GraphQL introspection so we can
// discover the time-entries schema once the key is set, THEN wire
// `action=timeentries` and `action=projects` on the real field names.
//
// Env: BUSYBUSY_API_TOKEN (the Integration Key), BUSYBUSY_API_URL (the GraphQL
// endpoint, once confirmed), plus the shared SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY used to verify the caller's session.
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

const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema { queryType { name } types { name kind fields { name } } }
}`;

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  // 200-with-{error} for every failure, like pec-companycam.cjs: the dashboard
  // reads res.error and degrades gracefully (manual-hours fallback) instead of
  // logging a console error on every costing open.
  const fail = (error, extra = {}) => ({ statusCode: 200, headers: cors, body: JSON.stringify({ error, entries: [], projects: [], ...extra }) });

  if (!(await callerIsStaff(event))) return fail('Not authorized');

  const token = process.env.BUSYBUSY_API_TOKEN;
  if (!token) return fail('BusyBusy is not configured. Set BUSYBUSY_API_TOKEN in the Netlify environment.');
  const apiUrl = process.env.BUSYBUSY_API_URL;
  if (!apiUrl) return fail('BusyBusy endpoint not set. Add BUSYBUSY_API_URL once the Integration Key docs confirm it.');

  const params = event.queryStringParameters || {};
  const action = params.action || 'introspect';

  // Single GraphQL POST helper. Auth header scheme is a placeholder until the
  // key docs confirm it (Bearer is the common default); change here only.
  const gql = (query, variables = {}) => fetch(apiUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  try {
    if (action === 'introspect') {
      const res = await gql(INTROSPECTION_QUERY);
      const data = await res.json();
      if (!res.ok) return fail(`BusyBusy introspection failed (${res.status})`, { raw: data });
      return { statusCode: 200, headers: cors, body: JSON.stringify({ schema: data }) };
    }

    // action=timeentries and action=projects are intentionally NOT implemented
    // against guessed field names. Once introspection reveals the real schema,
    // add them here (and a since=<ISO> param for incremental sync).
    if (action === 'timeentries' || action === 'projects') {
      return fail(`action "${action}" is not wired yet: run action=introspect first to discover the BusyBusy schema, then implement it on the real field names.`);
    }

    return fail(`Unknown action "${action}"`);
  } catch (err) {
    return fail('BusyBusy request failed: ' + (err && err.message ? err.message : String(err)));
  }
};
