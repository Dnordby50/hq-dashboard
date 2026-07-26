// Netlify Function: Google Sheets reverse proxy.
// GET  /.netlify/functions/sheets-proxy?id=<sheetId>&range=<range>  -> sheet read
// POST /.netlify/functions/sheets-proxy  (JSON body)               -> sheet write
//
// Why this exists: the browser cannot call the Google Apps Script /exec URL
// directly. Apps Script responses do not carry an Access-Control-Allow-Origin
// header, so cross-origin GET reads fail CORS and surface as "failed to fetch"
// in the dashboard (booked sales / booked jobs, tasks, etc.). This function
// runs server-side, where CORS does not apply, forwards the request to Apps
// Script, and returns the result from the dashboard's own origin.
//
// The Apps Script deployment (v5) keeps serving unchanged; only the path the
// browser hits moved. The /exec URL is the same value that used to live in
// CONFIG.SHEETS_PROXY in index.html, so it is not a new secret.
//
// SECURITY: this used to be an OPEN proxy -- anyone on the internet could GET
// (read) or POST (write) the company Google Sheets through it, with no auth. It
// now requires a logged-in staff Supabase JWT (Authorization: Bearer <token>),
// verified via requireStaff against admin_users. The browser attaches the token
// through sheetsAuthHeaders() in index.html.

const { requireStaff } = require('./_pec-supabase.cjs');

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxvM8U5sKn6B8gKWHG7-JD-fPFyquOlbpjQjDiRDSOUJD2P8XVIKuREGaKkFHCdum-KRA/exec';

// Only the app's own origins may use this cross-origin. Reflect an allowed
// Origin (so the browser accepts the response) and fall back to the primary
// site otherwise. Env URL/DEPLOY_PRIME_URL cover Netlify's prod + preview URLs.
const ALLOWED_ORIGINS = [
  process.env.URL,
  process.env.DEPLOY_PRIME_URL,
  'https://prescottepoxy.netlify.app',
].filter(Boolean);

function corsFor(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[ALLOWED_ORIGINS.length - 1];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

exports.handler = async (event) => {
  const cors = corsFor(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  // Require a logged-in staff member. Blocks the old open-proxy access path.
  const auth = await requireStaff(event);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error }),
    };
  }

  try {
    let res;
    if (event.httpMethod === 'POST') {
      res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: event.body || '{}',
      });
    } else {
      const params = event.queryStringParameters || {};
      const qs = Object.keys(params)
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
        .join('&');
      res = await fetch(APPS_SCRIPT_URL + (qs ? `?${qs}` : ''));
    }
    const text = await res.text();
    const upstreamCt = (res.headers.get('content-type') || '').toLowerCase();

    // Apps Script returns its uncaught exceptions as an HTML "Script function
    // returned an exception" page (e.g. "Exception: Range not found"). That
    // HTML body would slip through to the client and cause a confusing
    // "Unexpected token <" SyntaxError when the dashboard tries res.json().
    // Detect by content-type or a leading "<" and normalize to a 502 JSON
    // error so the client gets one clean failure path. The happy path (JSON
    // upstream, status 200) is untouched.
    const looksHtml = /^\s*</.test(text);
    const isJsonish = upstreamCt.includes('application/json') || upstreamCt.includes('text/plain');
    if (looksHtml || !isJsonish) {
      const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const message = stripped.slice(0, 400) || 'Apps Script returned a non-JSON body.';
      return {
        statusCode: 502,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'apps_script_exception', message, upstream_status: res.status }),
      };
    }

    return {
      statusCode: res.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'sheets-proxy fetch failed: ' + (err && err.message ? err.message : String(err)) }),
    };
  }
};
