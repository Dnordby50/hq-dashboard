// HQ Dashboard MCP server (v0.2, read-only).
// Streamable-HTTP transport, stateless: one POST = one JSON-RPC response.
// Auth: Authorization: Bearer ${MCP_BEARER_TOKEN}
//
// Connect from Claude.ai or Claude Code with URL = https://<site>/mcp
// (or /.netlify/functions/mcp), header Authorization: Bearer <token>.
//
// v0.2 surface (all READ-ONLY, no mutations):
//   - get_schedule       Booked Jobs sheet rows (Google Sheets via Apps Script proxy)
//   - get_sales_summary  aggregated booked counts/revenue from the same sheet
//   - find_customers     search public.customers (Supabase service-role SELECT)
//   - find_jobs          search public.jobs joined to public.customers (Supabase)
//   - list_pipeline      pec_job_ar view by AR/pipeline stage (Supabase)
// The Supabase tools issue PostgREST GET only; there is no write path here.
// Draft-write tools are a later round, kept out of this read-only connector.

const SHEETS_PROXY = 'https://script.google.com/macros/s/AKfycbxvM8U5sKn6B8gKWHG7-JD-fPFyquOlbpjQjDiRDSOUJD2P8XVIKuREGaKkFHCdum-KRA/exec';
const BOOKED_JOBS_ID = '1oNMMiuPmtrmu-x9Vxcy4kz0xxzQV00WNCGvk35rGLr4';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'hq-dashboard-mcp', version: '0.2.0' };

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
  {
    name: 'get_sales_summary',
    description: 'Aggregate the Booked Jobs Google Sheet into booked-job counts and total revenue for a filtered date range. Same data and date rule as get_schedule (matches scheduled date when present, otherwise date booked). Use this to answer "how much did we book this month / quarter" and "who booked it" - it returns totals plus an optional per-group breakdown. For the raw job rows use get_schedule instead.',
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
        group_by: {
          type: 'string',
          enum: ['none', 'business', 'salesperson'],
          description: "Break the totals down by this dimension. Default 'none' (grand total only).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'find_customers',
    description: 'Search the live CRM (Supabase public.customers) by name, email, or phone (case-insensitive, partial match). Returns id, name, email, phone, business/company, and the number of jobs each customer has. Use this to look up a customer record or get their customer id to feed into find_jobs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to match against customer name, email, or phone.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum customers to return. Default 20, max 200.',
          minimum: 1,
          maximum: 200,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_jobs',
    description: 'Search the live CRM jobs (Supabase public.jobs joined to public.customers). Filter by customer name, address, status, and/or business; any subset of filters can be supplied. Returns job id, customer, address, status, type (epoxy/paint), revenue, signed date, and the scheduled install date when reachable. Use this for the detailed per-job records the dashboard shows on the Jobs page.',
    inputSchema: {
      type: 'object',
      properties: {
        customer: {
          type: 'string',
          description: 'Partial, case-insensitive match on the customer name.',
        },
        address: {
          type: 'string',
          description: 'Partial, case-insensitive match on the job address.',
        },
        status: {
          type: 'string',
          description: "Exact job status. Common values: 'confirmed', 'scheduled', 'in_progress', 'completed' (some jobs use 'signed').",
        },
        business: {
          type: 'string',
          enum: ['all', 'pec', 'ftp'],
          description: "Which business to include (pec = Prescott Epoxy, ftp = Finishing Touch). Default 'all'.",
        },
        limit: {
          type: 'integer',
          description: 'Maximum jobs to return, newest first. Default 20, max 200.',
          minimum: 1,
          maximum: 200,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_pipeline',
    description: 'List jobs by AR / pipeline stage from the Supabase pec_job_ar view, newest first. Returns customer, stage (status), revenue, amount paid, balance remaining, and the AR timestamps (signed, completed, last payment, days outstanding, days since signed). Use this to see where jobs sit from accepted to complete and which ones still owe money.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          description: "Exact pipeline stage to filter by. Common values: 'signed', 'scheduled', 'in_progress', 'completed'. Omit for all stages.",
        },
        business: {
          type: 'string',
          enum: ['all', 'pec', 'ftp'],
          description: "Which business to include. Default 'all'.",
        },
        limit: {
          type: 'integer',
          description: 'Maximum jobs to return, newest first. Default 50, max 200.',
          minimum: 1,
          maximum: 200,
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

// Shared parse of the Booked Jobs sheet (columns A:G) into typed rows. Factored
// out so get_schedule and get_sales_summary read the SAME column mapping and
// can't drift. Returns raw strings (empty string for blanks); callers decide
// how to present nulls. Skips the header row and any row missing the first 5
// columns (matches get_schedule's original < 5 guard).
function parseBookedJobsRows(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 5) continue;
    out.push({
      job_name: r[0] || '',
      business: r[1] || '',
      customer: r[2] || '',
      scheduled_date: r[3] || '',
      revenue: parseFloat(String(r[4] || '0').replace(/[$,]/g, '')) || 0,
      sold_by: r[5] || '',
      date_booked: r[6] || '',
    });
  }
  return out;
}

// Inclusive-date-range predicate shared by the two sheet tools. Mirrors the
// original get_schedule rule: match on scheduled date when present else date
// booked; rows with no parseable date are excluded when any date filter is set.
function rowInRange(row, start, end) {
  const d = parseDate(row.scheduled_date) || parseDate(row.date_booked);
  if ((start || end) && !d) return false;
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

async function tool_get_schedule(args) {
  const business = args.business || 'all';
  const start = args.start_date ? parseDate(args.start_date) : null;
  const end = args.end_date ? parseDate(args.end_date) : null;
  if (end) end.setHours(23, 59, 59, 999);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 100, 1), 500);

  const parsed = parseBookedJobsRows(await fetchSheet(BOOKED_JOBS_ID, 'booked jobs!A:G'));
  const out = [];
  for (const row of parsed) {
    if (!bizMatch(row.business, business)) continue;
    if (!rowInRange(row, start, end)) continue;
    out.push({
      job_name: row.job_name,
      business: row.business,
      customer: row.customer,
      scheduled_date: row.scheduled_date || null,
      date_booked: row.date_booked || null,
      revenue: row.revenue,
      sold_by: row.sold_by,
    });
  }
  out.sort((a, b) => {
    const da = parseDate(a.scheduled_date) || parseDate(a.date_booked);
    const db = parseDate(b.scheduled_date) || parseDate(b.date_booked);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });
  return { count: Math.min(out.length, limit), total_matched: out.length, rows: out.slice(0, limit) };
}

// Round to cents so floating-point revenue sums report cleanly.
function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function tool_get_sales_summary(args) {
  const business = args.business || 'all';
  const start = args.start_date ? parseDate(args.start_date) : null;
  const end = args.end_date ? parseDate(args.end_date) : null;
  if (end) end.setHours(23, 59, 59, 999);
  const groupBy = ['none', 'business', 'salesperson'].includes(args.group_by) ? args.group_by : 'none';

  const parsed = parseBookedJobsRows(await fetchSheet(BOOKED_JOBS_ID, 'booked jobs!A:G'));
  let totalCount = 0;
  let totalRevenue = 0;
  const groups = {};
  for (const row of parsed) {
    if (!bizMatch(row.business, business)) continue;
    if (!rowInRange(row, start, end)) continue;
    totalCount++;
    totalRevenue += row.revenue;
    if (groupBy !== 'none') {
      const key = (groupBy === 'business' ? row.business : row.sold_by) || '(unknown)';
      const g = groups[key] || (groups[key] = { count: 0, revenue: 0 });
      g.count++;
      g.revenue += row.revenue;
    }
  }

  const result = {
    business,
    date_range: { start: args.start_date || null, end: args.end_date || null },
    group_by: groupBy,
    total_count: totalCount,
    total_revenue: money(totalRevenue),
  };
  if (groupBy !== 'none') {
    result.groups = Object.entries(groups)
      .map(([group, v]) => ({ group, count: v.count, revenue: money(v.revenue) }))
      .sort((a, b) => b.revenue - a.revenue);
  }
  return result;
}

// ---- Supabase READ-ONLY access ----------------------------------------------
// Service-role key bypasses RLS, which is fine server-side, but this connector
// is strictly read-only: sbSelect only ever issues a PostgREST GET (SELECT).
// There is deliberately NO insert/update/delete path here. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are already set in the site env; if a tool can't
// reach them it throws a clean Error that the tools/call wrapper turns into an
// isError result rather than a 500.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbSelect(resource, query) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing for the mcp function)');
  }
  const url = `${SUPABASE_URL}/rest/v1/${resource}${query ? `?${query}` : ''}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// Map the business enum to the customers.company value the schema uses.
function companyFor(biz) {
  if (biz === 'pec') return 'prescott-epoxy';
  if (biz === 'ftp') return 'finishing-touch';
  return null; // 'all' or unset -> no filter
}

// Build an ilike pattern, stripping characters that have meaning in PostgREST's
// or=()/filter grammar so user input can't break out of the value position.
// encodeURIComponent leaves '*' (the wildcard) intact and encodes spaces, so the
// result is safe to drop straight into a query string.
function ilikePattern(q) {
  const cleaned = String(q || '').replace(/[(),*]/g, ' ').trim();
  return cleaned ? encodeURIComponent(`*${cleaned}*`) : '';
}

function clampLimit(v, def, max) {
  return Math.min(Math.max(parseInt(v, 10) || def, 1), max);
}

async function tool_find_customers(args) {
  const pat = ilikePattern(args.query);
  if (!pat) throw new Error('query is required');
  const limit = clampLimit(args.limit, 20, 200);
  const q = [
    'select=id,name,email,phone,company,jobs(count)',
    `or=(name.ilike.${pat},email.ilike.${pat},phone.ilike.${pat})`,
    `limit=${limit}`,
    'order=created_at.desc',
  ].join('&');
  const data = await sbSelect('customers', q);
  const customers = data.map(c => ({
    id: c.id,
    name: c.name || null,
    email: c.email || null,
    phone: c.phone || null,
    company: c.company || null,
    job_count: Array.isArray(c.jobs) && c.jobs[0] ? c.jobs[0].count : 0,
  }));
  return { count: customers.length, customers };
}

async function tool_find_jobs(args) {
  const limit = clampLimit(args.limit, 20, 200);
  // customers!inner so customer-scoped filters (name, company) become an inner
  // join; the FK is NOT NULL so this never drops legitimate jobs.
  const params = ['select=id,address,status,type,price,signed_date,created_at,dripjobs_deal_id,customers!inner(name,company,email,phone)'];
  if (args.customer) {
    const pat = ilikePattern(args.customer);
    if (pat) params.push(`customers.name=ilike.${pat}`);
  }
  if (args.address) {
    const pat = ilikePattern(args.address);
    if (pat) params.push(`address=ilike.${pat}`);
  }
  if (args.status) params.push(`status=eq.${encodeURIComponent(String(args.status))}`);
  const company = companyFor(args.business);
  if (company) params.push(`customers.company=eq.${company}`);
  params.push(`limit=${limit}`, 'order=created_at.desc');

  const data = await sbSelect('jobs', params.join('&'));
  let jobs = data.map(j => ({
    id: j.id,
    customer: j.customers ? j.customers.name : null,
    company: j.customers ? j.customers.company : null,
    address: j.address || null,
    status: j.status || null,
    type: j.type || null,
    revenue: j.price != null ? Number(j.price) : null,
    signed_date: j.signed_date || null,
    created_at: j.created_at || null,
    scheduled_date: null,
    dripjobs_deal_id: j.dripjobs_deal_id || null,
  }));

  // Best-effort scheduled-date enrichment: public.jobs has no install date (that
  // lives on pec_prod_jobs, bridged by dripjobs_deal_id per the two-parallel-job-
  // tables gotcha). A failure here leaves scheduled_date null rather than failing
  // the whole tool.
  try {
    const dealIds = [...new Set(jobs.map(j => j.dripjobs_deal_id).filter(Boolean))]
      .map(d => String(d).replace(/[^a-zA-Z0-9_-]/g, ''))
      .filter(Boolean);
    if (dealIds.length) {
      const prod = await sbSelect('pec_prod_jobs', `select=dripjobs_deal_id,install_date&dripjobs_deal_id=in.(${dealIds.join(',')})`);
      const byDeal = {};
      for (const p of prod) if (p.dripjobs_deal_id && p.install_date) byDeal[p.dripjobs_deal_id] = p.install_date;
      jobs = jobs.map(j => ({ ...j, scheduled_date: j.dripjobs_deal_id ? (byDeal[j.dripjobs_deal_id] || null) : null }));
    }
  } catch { /* enrichment is best-effort; scheduled_date stays null */ }

  return { count: jobs.length, jobs };
}

async function tool_list_pipeline(args) {
  const limit = clampLimit(args.limit, 50, 200);
  const params = ['select=id,customer_name,customer_company,status,price,paid_to_date,balance_remaining,signed_date,completed_date,last_payment_date,days_outstanding,days_since_signed,created_at'];
  if (args.stage) params.push(`status=eq.${encodeURIComponent(String(args.stage))}`);
  const company = companyFor(args.business);
  if (company) params.push(`customer_company=eq.${company}`);
  params.push(`limit=${limit}`, 'order=created_at.desc');

  const data = await sbSelect('pec_job_ar', params.join('&'));
  const jobs = data.map(r => ({
    id: r.id,
    customer: r.customer_name || null,
    company: r.customer_company || null,
    stage: r.status || null,
    revenue: r.price != null ? Number(r.price) : null,
    paid_to_date: r.paid_to_date != null ? Number(r.paid_to_date) : null,
    balance_remaining: r.balance_remaining != null ? Number(r.balance_remaining) : null,
    signed_date: r.signed_date || null,
    completed_date: r.completed_date || null,
    last_payment_date: r.last_payment_date || null,
    days_outstanding: r.days_outstanding != null ? r.days_outstanding : null,
    days_since_signed: r.days_since_signed != null ? r.days_since_signed : null,
    created_at: r.created_at || null,
  }));
  return { count: jobs.length, stage: args.stage || 'all', business: args.business || 'all', jobs };
}

const HANDLERS = {
  get_schedule: tool_get_schedule,
  get_sales_summary: tool_get_sales_summary,
  find_customers: tool_find_customers,
  find_jobs: tool_find_jobs,
  list_pipeline: tool_list_pipeline,
};

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
  const origin = `https://${event.headers['x-forwarded-host'] || event.headers.host || 'prescottepoxy.netlify.app'}`;

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
