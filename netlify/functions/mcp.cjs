// HQ Dashboard MCP server (v0.1, spike).
// Streamable-HTTP transport, stateless: one POST = one JSON-RPC response.
// Auth: Authorization: Bearer ${MCP_BEARER_TOKEN}
//
// Connect from Claude.ai or Claude Code with URL = https://<site>/mcp
// (or /.netlify/functions/mcp), header Authorization: Bearer <token>.
//
// v0.1 surface: one tool, get_schedule, reading the Booked Jobs sheet via the
// same Apps Script proxy the dashboard uses. Read tools for jobs/customers/
// proposals and the draft-write tools land in v0.2 once this round-trip is
// confirmed against the live Claude.ai connector.

const SHEETS_PROXY = 'https://script.google.com/macros/s/AKfycbxvM8U5sKn6B8gKWHG7-JD-fPFyquOlbpjQjDiRDSOUJD2P8XVIKuREGaKkFHCdum-KRA/exec';
const BOOKED_JOBS_ID = '1oNMMiuPmtrmu-x9Vxcy4kz0xxzQV00WNCGvk35rGLr4';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'hq-dashboard-mcp', version: '0.1.0' };

const TOOLS = [
  {
    name: 'get_schedule',
    description: 'Read the Booked Jobs schedule from the production Google Sheet. Returns booked jobs (job name, business PEC or FTP, customer, scheduled date, revenue, salesperson, date booked). Filter by business and/or date range; date range matches scheduled date when present, otherwise date booked.',
    inputSchema: {
      type: 'object',
      properties: {
        business: {
          type: 'string',
          enum: ['all', 'pec', 'ftp'],
          description: "Which business to include. Default 'all'.",
        },
        start_date: {
          type: 'string',
          description: 'Inclusive ISO date (YYYY-MM-DD). Rows with no parseable date are excluded when any date filter is set.',
        },
        end_date: {
          type: 'string',
          description: 'Inclusive ISO date (YYYY-MM-DD).',
        },
        limit: {
          type: 'integer',
          description: 'Maximum rows to return, newest first. Default 100, max 500.',
          minimum: 1,
          maximum: 500,
        },
      },
      additionalProperties: false,
    },
  },
];

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function bizMatch(biz, filter) {
  if (!filter || filter === 'all') return true;
  const b = String(biz || '').toUpperCase();
  if (filter === 'pec') return b.includes('PEC') || b.includes('EPOXY') || b.includes('PRESCOTT EPOXY');
  if (filter === 'ftp') return b.includes('FTP') || b.includes('PAINT') || b.includes('FINISHING');
  return true;
}

async function fetchSheet(id, range) {
  const url = `${SHEETS_PROXY}?id=${encodeURIComponent(id)}&range=${encodeURIComponent(range)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets proxy ${res.status}`);
  return res.json();
}

async function tool_get_schedule(args) {
  const business = args.business || 'all';
  const start = args.start_date ? parseDate(args.start_date) : null;
  const end = args.end_date ? parseDate(args.end_date) : null;
  if (end) end.setHours(23, 59, 59, 999);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 100, 1), 500);

  const rows = await fetchSheet(BOOKED_JOBS_ID, 'booked jobs!A:G');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 5) continue;
    const jobName = r[0] || '';
    const biz = r[1] || '';
    const customer = r[2] || '';
    const scheduledDate = r[3] || '';
    const revenue = parseFloat(String(r[4] || '0').replace(/[$,]/g, '')) || 0;
    const soldBy = r[5] || '';
    const dateBooked = r[6] || '';
    const d = parseDate(scheduledDate) || parseDate(dateBooked);

    if (!bizMatch(biz, business)) continue;
    if ((start || end) && !d) continue;
    if (start && d < start) continue;
    if (end && d > end) continue;

    out.push({
      job_name: jobName,
      business: biz,
      customer,
      scheduled_date: scheduledDate || null,
      date_booked: dateBooked || null,
      revenue,
      sold_by: soldBy,
    });
  }
  out.sort((a, b) => {
    const da = parseDate(a.scheduled_date) || parseDate(a.date_booked);
    const db = parseDate(b.scheduled_date) || parseDate(b.date_booked);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });
  return { count: Math.min(out.length, limit), total_matched: out.length, rows: out.slice(0, limit) };
}

const HANDLERS = { get_schedule: tool_get_schedule };

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpc(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      // Echo the client's requested protocolVersion when it sends one, so
      // newer clients (e.g. 2025-11-25) negotiate cleanly instead of seeing a
      // hard-coded older version; fall back to ours if absent. The auth/tool
      // surface we implement is version-stable, so agreeing to the client's
      // version is safe.
      return rpcResult(id, {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const handler = HANDLERS[name];
      if (!handler) return rpcError(id, -32601, `Unknown tool: ${name}`);
      try {
        const data = await handler(args);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: false,
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `Tool error: ${err.message}` }],
          isError: true,
        });
      }
    }
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// Parse application/x-www-form-urlencoded bodies (OAuth token endpoint).
function parseForm(body) {
  const out = {};
  if (!body) return out;
  for (const pair of body.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
    const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

// Decode Basic auth header into { id, secret }.
function parseBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { id: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
  } catch { return null; }
}

const crypto = require('crypto');

// Base64url helpers (RFC 4648 §5, no padding).
function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  str = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// HMAC helpers. Key derived from MCP_BEARER_TOKEN so rotating the bearer also
// invalidates any in-flight auth codes (zero state, no DB).
function hmac(payload) {
  return crypto.createHmac('sha256', String(process.env.MCP_BEARER_TOKEN || '')).update(payload).digest();
}

// Issue a stateless authorization code (RFC 7636 PKCE). Encodes the request's
// code_challenge + redirect_uri + expiry into the code itself, signed with
// HMAC. Verification: decode payload, verify HMAC, check exp, check S256.
function issueAuthCode({ code_challenge, redirect_uri, client_id }) {
  const payload = JSON.stringify({
    cc: code_challenge,
    ru: redirect_uri,
    ci: client_id,
    exp: Math.floor(Date.now() / 1000) + 600, // 10 min
  });
  const sig = hmac(payload);
  return `${b64uEncode(payload)}.${b64uEncode(sig)}`;
}

function verifyAuthCode(code) {
  if (!code || typeof code !== 'string') return null;
  const dot = code.indexOf('.');
  if (dot < 0) return null;
  const payloadEnc = code.slice(0, dot);
  const sigEnc = code.slice(dot + 1);
  let payloadBuf;
  try { payloadBuf = b64uDecode(payloadEnc); } catch { return null; }
  const expectedSig = hmac(payloadBuf);
  const givenSig = b64uDecode(sigEnc);
  if (expectedSig.length !== givenSig.length || !crypto.timingSafeEqual(expectedSig, givenSig)) return null;
  let payload;
  try { payload = JSON.parse(payloadBuf.toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// Verify PKCE: SHA256(code_verifier) base64url-encoded must equal code_challenge.
function verifyPkce(code_verifier, code_challenge) {
  if (!code_verifier || !code_challenge) return false;
  const h = crypto.createHash('sha256').update(code_verifier).digest();
  return b64uEncode(h) === code_challenge;
}

// Stateless refresh token, same HMAC-signed envelope as the auth code. Anthropic's
// connector registers for the refresh_token grant (offline access), so the token
// response must hand one back or the client treats the server as unable to meet
// its needs. Long-lived (90 days). Like the auth code, the HMAC key is derived
// from MCP_BEARER_TOKEN, so rotating the bearer invalidates all refresh tokens.
function issueRefreshToken({ client_id }) {
  const payload = JSON.stringify({
    t: 'refresh',
    ci: client_id,
    exp: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
  });
  return `${b64uEncode(payload)}.${b64uEncode(hmac(payload))}`;
}

function verifyRefreshToken(token) {
  const payload = verifyAuthCode(token); // same decode + HMAC + exp check
  if (!payload || payload.t !== 'refresh') return null;
  return payload;
}

// OAuth 2.1 authorization server metadata (RFC 8414). MCP 2025-06-18 clients
// (Anthropic's custom-connector UI in particular) need authorization_code +
// PKCE + DCR; we also keep client_credentials for direct M2M use.
function oauthMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/register`,
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: ['mcp'],
  };
}

// RFC 9728 protected-resource metadata. MCP 2025-06-18 clients probe this
// FIRST (at /.well-known/oauth-protected-resource, relative to the resource
// URL) to discover which authorization server gates the resource. Without
// this endpoint Anthropic's custom-connector returns 404 at registration.
function protectedResourceMetadata(origin) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
    resource_documentation: `${origin}/mcp`,
  };
}

exports.handler = async (event) => {
  // Temporary diagnostic: log every request that reaches the function so we
  // can see exactly what Anthropic's MCP client probes during connector add.
  // Remove after the OAuth flow is stable. Logs land in Netlify Function logs.
  try {
    console.log('[mcp-req]', JSON.stringify({
      m: event.httpMethod,
      p: event.path,
      auth: !!(event.headers.authorization || event.headers.Authorization),
      ua: (event.headers['user-agent'] || '').slice(0, 80),
      ct: event.headers['content-type'] || event.headers['Content-Type'] || '',
    }));
  } catch {}

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  // Path routing: same Netlify function serves /mcp, /.well-known/..., and
  // /oauth/token via the redirects in netlify.toml. event.path is the original
  // request path before the rewrite.
  const path = String(event.path || '').replace(/\/+$/, '');
  const origin = `https://${event.headers['x-forwarded-host'] || event.headers.host || 'hq-prescott.netlify.app'}`;

  // ---- OAuth 2.1 discovery metadata (unauthenticated GET) ----
  // Served at three layouts so every client convention hits the same handler:
  //   1. root                              /.well-known/oauth-authorization-server
  //   2. suffix form                       /mcp/.well-known/oauth-authorization-server
  //   3. RFC 8414 path-insertion form      /.well-known/oauth-authorization-server/mcp
  // Form 3 is the canonical one (the well-known segment is inserted BEFORE the
  // resource path), which some clients build themselves instead of following
  // the resource_metadata URL we advertise in WWW-Authenticate.
  if (path === '/.well-known/oauth-authorization-server' || path === '/mcp/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp') {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, headers: { ...cors, Allow: 'GET' }, body: '' };
    }
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify(oauthMetadata(origin)),
    };
  }

  // ---- RFC 9728 protected-resource metadata (unauthenticated GET) ----
  // First thing MCP 2025-06-18 clients fetch. Tells them which authorization
  // server gates this resource. Without it Anthropic's connector 404s.
  if (path === '/.well-known/oauth-protected-resource' || path === '/mcp/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, headers: { ...cors, Allow: 'GET' }, body: '' };
    }
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify(protectedResourceMetadata(origin)),
    };
  }

  // ---- Dynamic Client Registration (RFC 7591) ----
  // Anthropic's MCP client probes /register before falling back to manual
  // Client ID/Secret. We return the pre-configured credentials regardless of
  // what the client sends (single-tenant server; we trust whoever discovered
  // us this far). This lets the connector "just work" without the user pasting
  // anything into the OAuth fields.
  if (path === '/register') {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: { ...cors, Allow: 'POST' }, body: '' };
    }
    const expectedId = process.env.MCP_OAUTH_CLIENT_ID;
    const expectedSecret = process.env.MCP_OAUTH_CLIENT_SECRET;
    if (!expectedId || !expectedSecret) {
      return {
        statusCode: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'server_misconfigured', error_description: 'MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET must be set' }),
      };
    }
    let req = {};
    try { req = JSON.parse(event.body || '{}'); } catch {}
    const redirectUris = Array.isArray(req.redirect_uris) ? req.redirect_uris : [];

    // Secret-safe diagnostic: the DCR REQUEST body carries no credentials (just
    // client metadata), so logging it is safe and tells us exactly what
    // Anthropic's connector asks for. Remove with the rest of the diagnostics.
    try {
      console.log('[mcp-register]', JSON.stringify({
        name: req.client_name || '',
        ru: redirectUris,
        gt: req.grant_types || null,
        rt: req.response_types || null,
        am: req.token_endpoint_auth_method || null,
        scope: req.scope || null,
      }));
    } catch {}

    // Honor the client's requested auth method. Anthropic's connector registers
    // as a PUBLIC client (token_endpoint_auth_method "none", PKCE-only) and has
    // nowhere safe to store a secret; if we force a confidential registration
    // and hand back a client_secret it never asked for, its PKCE flow can't
    // reconcile the response and it stalls before opening the authorize tab.
    // So: when "none" (or unspecified), return a public-client registration with
    // NO secret. Only issue a secret for an explicitly confidential client.
    const requestedAuthMethod = req.token_endpoint_auth_method || 'none';
    const isPublic = requestedAuthMethod === 'none';

    // Echo back the client's requested grant/response types (intersected with
    // what we actually support) so strict clients see their request honored.
    const SUPPORTED_GRANTS = ['authorization_code', 'refresh_token', 'client_credentials'];
    const reqGrants = Array.isArray(req.grant_types) ? req.grant_types.filter(g => SUPPORTED_GRANTS.includes(g)) : [];
    const grantTypes = reqGrants.length ? reqGrants : ['authorization_code'];
    const responseTypes = Array.isArray(req.response_types) && req.response_types.length ? req.response_types : ['code'];

    const reg = {
      client_id: expectedId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: requestedAuthMethod,
      scope: req.scope || 'mcp',
    };
    if (req.client_name) reg.client_name = req.client_name;
    if (!isPublic) {
      reg.client_secret = expectedSecret;
      reg.client_secret_expires_at = 0; // never
    }
    // Secret-safe diagnostic of the RESPONSE shape: log every field we return
    // EXCEPT the secret value (replaced by a presence flag). Lets us confirm the
    // exact registration body the client receives without leaking the secret.
    try {
      const safe = { ...reg };
      if ('client_secret' in safe) safe.client_secret = `<present:${String(reg.client_secret).length}ch>`;
      console.log('[mcp-register-resp]', JSON.stringify(safe));
    } catch {}
    return {
      statusCode: 201,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(reg),
    };
  }

  // ---- OAuth 2.1 authorization endpoint (authorization_code + PKCE S256) ----
  // Single-tenant server: anyone who can reach this URL has already crossed
  // the trust boundary (they had the protected-resource discovery), so we
  // auto-approve without a user-facing consent screen. We do require PKCE
  // (S256) and we sign the code with HMAC so tokens can't be forged.
  if (path === '/oauth/authorize') {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, headers: { ...cors, Allow: 'GET' }, body: '' };
    }
    const q = event.queryStringParameters || {};
    const responseType = q.response_type || '';
    const clientId = q.client_id || '';
    const redirectUri = q.redirect_uri || '';
    const codeChallenge = q.code_challenge || '';
    const codeChallengeMethod = q.code_challenge_method || '';
    const state = q.state || '';
    // Secret-safe diagnostic: authorize query carries no credentials (the
    // code_challenge is a one-way hash, not the verifier). Confirms whether the
    // browser step is reached at all and with what params. Remove later.
    try {
      console.log('[mcp-authorize]', JSON.stringify({
        rt: responseType,
        ci: clientId,
        ru: redirectUri,
        ccm: codeChallengeMethod,
        hasChallenge: !!codeChallenge,
        scope: q.scope || null,
      }));
    } catch {}
    if (responseType !== 'code') {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'unsupported_response_type' }) };
    }
    if (!redirectUri) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid_request', error_description: 'redirect_uri required' }) };
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      // Per RFC 7636, redirect with error rather than 4xx body, so the client
      // surfaces the error to the user instead of treating it as a network fail.
      const u = new URL(redirectUri);
      u.searchParams.set('error', 'invalid_request');
      u.searchParams.set('error_description', 'PKCE S256 required');
      if (state) u.searchParams.set('state', state);
      return { statusCode: 302, headers: { ...cors, Location: u.toString() }, body: '' };
    }
    const code = issueAuthCode({ code_challenge: codeChallenge, redirect_uri: redirectUri, client_id: clientId });
    const u = new URL(redirectUri);
    u.searchParams.set('code', code);
    if (state) u.searchParams.set('state', state);
    return { statusCode: 302, headers: { ...cors, Location: u.toString(), 'Cache-Control': 'no-store' }, body: '' };
  }

  // ---- OAuth 2.1 token endpoint (authorization_code + client_credentials) ----
  if (path === '/oauth/token') {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: { ...cors, Allow: 'POST' }, body: '' };
    }
    const form = parseForm(event.body || '');
    const basic = parseBasicAuth(event.headers.authorization || event.headers.Authorization || '');
    const clientId = (basic && basic.id) || form.client_id || '';
    const clientSecret = (basic && basic.secret) || form.client_secret || '';
    const grantType = form.grant_type || '';
    const expectedId = process.env.MCP_OAUTH_CLIENT_ID;
    const expectedSecret = process.env.MCP_OAUTH_CLIENT_SECRET;
    const bearer = process.env.MCP_BEARER_TOKEN;
    if (!expectedId || !expectedSecret || !bearer) {
      return {
        statusCode: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'server_misconfigured', error_description: 'MCP_OAUTH_CLIENT_ID, MCP_OAUTH_CLIENT_SECRET, MCP_BEARER_TOKEN must be set' }),
      };
    }

    if (grantType === 'authorization_code') {
      const code = form.code || '';
      const codeVerifier = form.code_verifier || '';
      const redirectUri = form.redirect_uri || '';
      const payload = verifyAuthCode(code);
      if (!payload) {
        return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid_grant', error_description: 'Auth code invalid or expired' }) };
      }
      if (redirectUri && payload.ru !== redirectUri) {
        return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }) };
      }
      if (!verifyPkce(codeVerifier, payload.cc)) {
        return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed' }) };
      }
      // client_id MUST match what was bound to the code at /authorize time. For
      // a public client (PKCE), client_secret is not required; for a confidential
      // client it is. We accept either to match Anthropic's behavior.
      if (clientId && payload.ci && clientId !== payload.ci) {
        return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid_client' }) };
      }
      if (clientSecret && clientSecret !== expectedSecret) {
        return { statusCode: 401, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid_client' }) };
      }
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          access_token: bearer,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: issueRefreshToken({ client_id: payload.ci || clientId }),
          scope: 'mcp',
        }),
      };
    }

    // refresh_token grant: the connector trades a refresh token for a fresh
    // access token (and a rotated refresh token). access_token is the static
    // MCP_BEARER_TOKEN, so "refresh" really just re-issues it; we still validate
    // the refresh token's HMAC + expiry so only a token we minted is accepted.
    if (grantType === 'refresh_token') {
      const rt = verifyRefreshToken(form.refresh_token || '');
      if (!rt) {
        return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token invalid or expired' }) };
      }
      if (clientSecret && clientSecret !== expectedSecret) {
        return { statusCode: 401, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid_client' }) };
      }
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          access_token: bearer,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: issueRefreshToken({ client_id: rt.ci }),
          scope: 'mcp',
        }),
      };
    }

    if (grantType === 'client_credentials') {
      if (clientId !== expectedId || clientSecret !== expectedSecret) {
        return {
          statusCode: 401,
          headers: { ...cors, 'Content-Type': 'application/json', 'WWW-Authenticate': 'Basic realm="hq-dashboard-mcp"' },
          body: JSON.stringify({ error: 'invalid_client', error_description: 'Bad client_id or client_secret' }),
        };
      }
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ access_token: bearer, token_type: 'Bearer', expires_in: 3600, scope: 'mcp' }),
      };
    }

    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'unsupported_grant_type', error_description: 'Supported: authorization_code, refresh_token, client_credentials' }),
    };
  }

  // ---- MCP JSON-RPC endpoint (Bearer required) ----
  // Auth: Authorization: Bearer ${MCP_BEARER_TOKEN}, OR ?token= query param as
  // a fallback so clients whose UI only takes a URL (Anthropic custom HTTP
  // connector form, which has no headers field) can still authenticate. Note:
  // URLs containing the token may land in Netlify access logs; prefer the
  // header where possible, and rotate MCP_BEARER_TOKEN if the URL leaks.
  const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
  const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const queryToken = (event.queryStringParameters && event.queryStringParameters.token) || '';
  const presented = headerToken || queryToken;
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected || presented !== expected) {
    return {
      statusCode: 401,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        // Point clients at the protected-resource metadata per RFC 9728. The
        // client follows that to find our auth server. resource_metadata is
        // the field name MCP 2025-06-18 clients look for.
        'WWW-Authenticate': `Bearer realm="hq-dashboard-mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  if (event.httpMethod === 'GET') {
    return {
      statusCode: 405,
      headers: { ...cors, 'Content-Type': 'application/json', Allow: 'POST' },
      body: JSON.stringify({ error: 'GET stream not supported (stateless server)' }),
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...cors, 'Content-Type': 'application/json', Allow: 'POST' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  let msg;
  try { msg = JSON.parse(event.body || ''); }
  catch {
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }

  if (Array.isArray(msg)) {
    const responses = [];
    for (const m of msg) {
      if (m && m.id !== undefined) responses.push(await handleRpc(m));
    }
    if (!responses.length) return { statusCode: 202, headers: cors, body: '' };
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify(responses),
    };
  }

  if (!msg || msg.id === undefined) {
    return { statusCode: 202, headers: cors, body: '' };
  }

  const response = await handleRpc(msg);
  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(response),
  };
};
