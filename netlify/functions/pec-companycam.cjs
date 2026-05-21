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

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const token = process.env.COMPANYCAM_API_TOKEN;
  if (!token) {
    return {
      statusCode: 503,
      headers: cors,
      body: JSON.stringify({ error: 'CompanyCam is not configured. Set COMPANYCAM_API_TOKEN in the Netlify environment.' }),
    };
  }

  const params = event.queryStringParameters || {};
  const action = params.action || 'projects';
  const ccGet = (path) => fetch(CC_BASE + path, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

  try {
    if (action === 'projects') {
      // Most-recent projects first. CompanyCam returns newest-first by default.
      const res = await ccGet('/projects?per_page=100');
      const data = await res.json();
      if (!res.ok) {
        return { statusCode: res.status, headers: cors, body: JSON.stringify({ error: data && data.message ? data.message : 'CompanyCam projects fetch failed' }) };
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
        return { statusCode: res.status, headers: cors, body: JSON.stringify({ error: data && data.message ? data.message : 'CompanyCam photos fetch failed' }) };
      }
      const photos = (Array.isArray(data) ? data : []).map((ph) => {
        const { url, thumb } = photoUrls(ph.uris);
        return { id: String(ph.id), url, thumb, captured_at: ph.captured_at || null };
      }).filter((ph) => ph.url);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ photos }) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: `Unknown action "${action}"` }) };
  } catch (err) {
    return {
      statusCode: 502,
      headers: cors,
      body: JSON.stringify({ error: 'CompanyCam request failed: ' + (err && err.message ? err.message : String(err)) }),
    };
  }
};
