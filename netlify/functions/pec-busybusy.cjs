// Netlify Function: BusyBusy read proxy (Part B of the Job Costing build).
// Session-gated, read-only. NEVER writes back to BusyBusy.
//
// Why this exists: the BusyBusy API key must not ship in client code, and the
// browser cannot call BusyBusy directly (no CORS). This runs server-side,
// authenticates with the key, and returns JSON from the dashboard's origin.
//
// API SHAPE (captured live from app.busybusy.io by Cowork 2026-06-13): the
// CURRENT BusyBusy product uses a GraphQL API (the @busybusy/data npm client
// that implied REST /v1 is the legacy 2017 ember-data layer). Confirmed:
//   endpoint: https://graphql.busybusy.io/  (HTTPS POST, GraphQL)
//   auth header: key-authorization  (value = BARE token, no Bearer/key prefix)
//   TimeEntry: id, memberId, projectId, costCodeId, equipmentId, startTime,
//     endTime, breaks[], actionType, description, createdOn, updatedOn,
//     deletedOn, submittedOn  (NO hours field: duration = endTime - startTime
//     minus breaks; updatedOn = edit marker; deletedOn = soft delete; a running
//     entry has endTime null).
//   Project: id, title, parentProjectId, projectInfo{ customer, number, ... }.
//   Member: id, firstName, lastName, username, memberNumber, email, deletedOn.
// The ROOT query names + args are anonymous in the web app, so they are still
// UNVERIFIED here: action=introspect (below) is the source of truth for them.
// The typed queries use the captured field selections (known-correct) with a
// best-guess root; if a root name/arg is wrong the GraphQL error surfaces and
// it is a one-line fix.
//
// Env (Netlify): BUSYBUSY_API_TOKEN (the Integration Key), BUSYBUSY_API_URL
// (defaults to the confirmed endpoint), BUSYBUSY_AUTH_HEADER (default
// key-authorization), BUSYBUSY_AUTH_PREFIX (default none). Plus the shared
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY for the session gate.
// .cjs extension is deliberate (package.json has "type":"module").

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

// Field selections captured live (known-correct). Root query names/args are
// confirmed via action=introspect, then adjust ROOTS below if needed.
const TIME_ENTRY_FIELDS = 'id memberId projectId costCodeId equipmentId startTime endTime actionType description createdOn updatedOn deletedOn submittedOn breaks { id startTime endTime }';
const PROJECT_FIELDS = 'id title parentProjectId projectInfo { customer number }';
const MEMBER_FIELDS = 'id firstName lastName username memberNumber email deletedOn';

const INTROSPECTION_QUERY = 'query Introspection { __schema { queryType { name } types { name kind fields { name args { name } } } } }';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const fail = (error, extra = {}) => ({ statusCode: 200, headers: cors, body: JSON.stringify({ error, entries: [], projects: [], members: [], ...extra }) });

  if (!(await callerIsStaff(event))) return fail('Not authorized');

  const token = process.env.BUSYBUSY_API_TOKEN;
  if (!token) return fail('BusyBusy is not configured. Set BUSYBUSY_API_TOKEN in the Netlify environment.');
  const apiUrl = process.env.BUSYBUSY_API_URL || 'https://graphql.busybusy.io/';
  const authHeader = process.env.BUSYBUSY_AUTH_HEADER || 'key-authorization';
  const authPrefix = process.env.BUSYBUSY_AUTH_PREFIX || '';

  // One GraphQL POST. Returns { ok, status, json }.
  const gql = async (query, variables = {}) => {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { [authHeader]: authPrefix + token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    let json = null; const text = await res.text();
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  };

  const params = event.queryStringParameters || {};
  const action = params.action || 'probe';

  try {
    // Confirm the endpoint + key auth in one tiny call.
    if (action === 'probe') {
      const r = await gql('query Probe { __typename }');
      return { statusCode: 200, headers: cors, body: JSON.stringify({ status: r.status, ok: r.ok, data: r.json, raw: r.json ? undefined : (r.text || '').slice(0, 1000) }) };
    }

    // Discover the real root query names + args (the source of truth).
    if (action === 'introspect') {
      const r = await gql(INTROSPECTION_QUERY);
      if (!r.ok) return fail(`BusyBusy introspection failed (${r.status})`, { raw: r.json || r.text });
      return { statusCode: 200, headers: cors, body: JSON.stringify({ schema: r.json }) };
    }

    // Generic passthrough so we can run any query while wiring this up. The
    // dashboard POSTs { query, variables } in the body.
    if (action === 'graphql') {
      let payload = {};
      try { payload = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
      if (!payload.query) return fail('graphql action requires a { query } body');
      const r = await gql(payload.query, payload.variables || {});
      return { statusCode: 200, headers: cors, body: JSON.stringify({ status: r.status, ok: r.ok, data: r.json }) };
    }

    // Typed queries: known FIELDS, best-guess ROOTS (confirm via introspect).
    // updatedOnSince drives incremental sync so edits/deletes propagate.
    if (action === 'timeentries') {
      const q = `query TimeEntries($updatedOnSince: String) { timeEntries(filter: { updatedOn: { greaterThanOrEqualTo: $updatedOnSince } }) { ${TIME_ENTRY_FIELDS} } }`;
      const r = await gql(q, { updatedOnSince: params.since || null });
      if (!r.ok || (r.json && r.json.errors)) return fail('BusyBusy time entries query failed (confirm root name/args via action=introspect)', { status: r.status, raw: r.json || r.text });
      return { statusCode: 200, headers: cors, body: JSON.stringify({ entries: (r.json && r.json.data && r.json.data.timeEntries) || [] }) };
    }
    if (action === 'projects') {
      const q = `query Projects { projects { ${PROJECT_FIELDS} } }`;
      const r = await gql(q);
      if (!r.ok || (r.json && r.json.errors)) return fail('BusyBusy projects query failed (confirm root name/args via action=introspect)', { status: r.status, raw: r.json || r.text });
      return { statusCode: 200, headers: cors, body: JSON.stringify({ projects: (r.json && r.json.data && r.json.data.projects) || [] }) };
    }
    if (action === 'members') {
      const q = `query Members { members { ${MEMBER_FIELDS} } }`;
      const r = await gql(q);
      if (!r.ok || (r.json && r.json.errors)) return fail('BusyBusy members query failed (confirm root name/args via action=introspect)', { status: r.status, raw: r.json || r.text });
      return { statusCode: 200, headers: cors, body: JSON.stringify({ members: (r.json && r.json.data && r.json.data.members) || [] }) };
    }

    return fail(`Unknown action "${action}"`);
  } catch (err) {
    return fail('BusyBusy request failed: ' + (err && err.message ? err.message : String(err)));
  }
};
