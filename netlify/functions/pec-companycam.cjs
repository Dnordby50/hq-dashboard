// Netlify Function: CompanyCam read proxy.
// GET /.netlify/functions/pec-companycam?action=projects
//     -> recent CompanyCam projects [{ id, name, address }]
// GET /.netlify/functions/pec-companycam?action=photos&project_id=<id>
//     -> photos for a project [{ id, url, thumb, captured_at }]
//
// Why this exists: the CompanyCam API token must not ship in client code, and
// the CompanyCam API does not send CORS headers for browser calls. This runs
// server-side, authenticates with the token, and returns JSON from the
// dashboard's own origin. Read-only — it never writes to CompanyCam.
//
// Requires the COMPANYCAM_API_TOKEN environment variable (set in Netlify).
// .cjs extension is deliberate: package.json has "type":"module", so a plain
// .js file here would be treated as ESM and `exports.handler` would fail.

const CC_BASE = 'https://api.companycam.com/v2';

// Flatten a CompanyCam address object into a one-line string.
function fmtAddress(a) {
  if (!a || typeof a !== 'object') return '';
  return [a.street_address_1, a.street_address_2, a.city, a.state, a.postal_code]
    .filter(Boolean)
    .join(', ');
}

// Pick the best display + thumbnail URL from a photo's uris array.
function photoUrls(uris) {
  const byType = {};
  for (const u of (Array.isArray(uris) ? uris : [])) byType[u.type] = u.uri;
  const url = byType.web || byType.original || byType.thumbnail || '';
  const thumb = byType.thumbnail || byType.web || url;
  return { url, thumb };
}

// Verify the caller's Supabase session token. The dashboard sends its signed-in
// user's access token as Authorization: Bearer; GoTrue's /auth/v1/user endpoint
// validates it (signature, expiry, revocation) in one cheap GET. Without this
// gate the proxy leaked project names, addresses, and photo URLs to anyone on
// the internet.
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  // Return HTTP 200 with an { error } body for every failure (unconfigured,
  // unauthorized, upstream error, exception). The dashboard reads res.error and
  // shows a graceful "CompanyCam unavailable" state; returning a non-2xx here
  // only adds a red error to the browser console on every job-detail open for
  // no benefit.
  const fail = (error, extra = {}) => ({ statusCode: 200, headers: cors, body: JSON.stringify({ error, projects: [], photos: [], ...extra }) });

  if (!(await callerIsStaff(event))) {
    return fail('Not authorized');
  }

  const token = process.env.COMPANYCAM_API_TOKEN;
  if (!token) {
    return fail('CompanyCam is not configured. Set COMPANYCAM_API_TOKEN in the Netlify environment.');
  }

  const params = event.queryStringParameters || {};
  const action = params.action || 'projects';
  const ccGet = (path) => fetch(CC_BASE + path, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

  try {
    if (action === 'projects') {
      // With ?query=<text>, CompanyCam filters by project name or address line
      // 1 server-side (the account is shared by FTP and PEC, so the 100 most
      // recent are not enough for older jobs). Without it, today's behavior:
      // most-recent first, CompanyCam returns newest-first by default.
      const q = (params.query || '').trim();
      const res = await ccGet(q ? `/projects?per_page=30&query=${encodeURIComponent(q)}` : '/projects?per_page=100');
      const data = await res.json();
      if (!res.ok) {
        return fail(data && data.message ? data.message : 'CompanyCam projects fetch failed');
      }
      const projects = (Array.isArray(data) ? data : []).map((p) => ({
        id: String(p.id),
        name: p.name || '(unnamed project)',
        address: fmtAddress(p.address),
      }));
      return { statusCode: 200, headers: cors, body: JSON.stringify({ projects }) };
    }

    if (action === 'photos') {
      const projectId = params.project_id;
      if (!projectId) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'project_id is required' }) };
      }
      const res = await ccGet(`/projects/${encodeURIComponent(projectId)}/photos?per_page=100`);
      const data = await res.json();
      if (!res.ok) {
        return fail(data && data.message ? data.message : 'CompanyCam photos fetch failed');
      }
      const photos = (Array.isArray(data) ? data : []).map((ph) => {
        const { url, thumb } = photoUrls(ph.uris);
        return { id: String(ph.id), url, thumb, captured_at: ph.captured_at || null };
      }).filter((ph) => ph.url);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ photos }) };
    }

    return fail(`Unknown action "${action}"`);
  } catch (err) {
    return fail('CompanyCam request failed: ' + (err && err.message ? err.message : String(err)));
  }
};
