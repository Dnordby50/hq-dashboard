// HQ Dashboard MCP server (v0.2, read-only).
// Streamable-HTTP transport, stateless: one POST = one JSON-RPC response.
// Auth: Authorization: Bearer ${MCP_BEARER_TOKEN_V2}
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
  {
    name: 'get_sales_recordings',
    description: 'List SalesAsk in-home sales visit recordings (Supabase pec_salesask_recordings), newest first. Each row carries the AI summary, action items, process score (followed/total), duration, recording link, processing status, and the linked customer/rep/lead/appointment ids. Filter by customer name, rep name, and/or a date window. Use this to review what happened in recent sales appointments or to check coaching scores; transcripts are large and are NOT returned here.',
    inputSchema: {
      type: 'object',
      properties: {
        customer: {
          type: 'string',
          description: 'Partial, case-insensitive match on the linked customer name.',
        },
        rep: {
          type: 'string',
          description: 'Partial, case-insensitive match on the sales rep name.',
        },
        from: {
          type: 'string',
          description: 'ISO date (YYYY-MM-DD); only recordings on/after this date.',
        },
        to: {
          type: 'string',
          description: 'ISO date (YYYY-MM-DD); only recordings on/before this date.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum recordings to return, newest first. Default 20, max 100.',
          minimum: 1,
          maximum: 100,
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

async function tool_get_sales_recordings(args) {
  const limit = clampLimit(args.limit, 20, 100);
  // Embedded joins: !inner only when the corresponding filter is present, so
  // an unfiltered list still includes unmatched recordings (customer_id null).
  const custJoin = args.customer ? 'customers!inner(name)' : 'customers(name)';
  const repJoin = args.rep ? 'pec_sales_team_members!inner(name)' : 'pec_sales_team_members(name)';
  const params = [
    `select=id,salesask_recording_id,occurred_at,status,title,summary,action_items,` +
    `process_followed,process_missed,process_total,duration_seconds,recording_url,` +
    `match_method,lead_id,appointment_id,${custJoin},${repJoin}`,
  ];
  if (args.customer) {
    const pat = ilikePattern(args.customer);
    if (pat) params.push(`customers.name=ilike.${pat}`);
  }
  if (args.rep) {
    const pat = ilikePattern(args.rep);
    if (pat) params.push(`pec_sales_team_members.name=ilike.${pat}`);
  }
  if (parseDate(args.from)) params.push(`occurred_at=gte.${encodeURIComponent(String(args.from))}`);
  if (parseDate(args.to)) params.push(`occurred_at=lte.${encodeURIComponent(String(args.to))}T23:59:59Z`);
  params.push(`limit=${limit}`, 'order=occurred_at.desc.nullslast');

  const data = await sbSelect('pec_salesask_recordings', params.join('&'));
  const recordings = data.map(r => ({
    id: r.id,
    salesask_recording_id: r.salesask_recording_id,
    occurred_at: r.occurred_at || null,
    status: r.status || null,
    title: r.title || null,
    customer: r.customers ? r.customers.name : null,
    rep: r.pec_sales_team_members ? r.pec_sales_team_members.name : null,
    duration_seconds: r.duration_seconds != null ? Number(r.duration_seconds) : null,
    process_score: (r.process_followed != null && r.process_total != null)
      ? `${r.process_followed}/${r.process_total}` : null,
    summary: r.summary || null,
    action_items: r.action_items || null,
    recording_url: r.recording_url || null,
    match_method: r.match_method || null,
    lead_id: r.lead_id || null,
    appointment_id: r.appointment_id || null,
  }));
  return { count: recordings.length, recordings };
}

const HANDLERS = {
  get_schedule: tool_get_schedule,
  get_sales_summary: tool_get_sales_summary,
  find_customers: tool_find_customers,
  find_jobs: tool_find_jobs,
  list_pipeline: tool_list_pipeline,
  get_sales_recordings: tool_get_sales_recordings,
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

// Constant-time bearer-token comparison. A plain !== leaks, via timing, how many
// leading bytes matched, which can let an attacker recover MCP_BEARER_TOKEN_V2 one
// byte at a time. Compare in length-independent time; unequal lengths are an
// immediate (safe) miss.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Only explicitly provisioned machine clients can exchange credentials.
// Interactive authorization and dynamic registration remain disabled until an
// authenticated, consent-based authorization service is available.
function oauthMetadata(origin) {
  return {
    issuer: origin,
    token_endpoint: `${origin}/oauth/token`,
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
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

  // Discovery is public; it never establishes permission to read company data.
  // Retired routes deliberately issue no credentials, codes, or redirects.
  if (path === '/register' || path === '/oauth/authorize') {
    return {
      statusCode: 403,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'access_denied', error_description: 'Use an explicitly provisioned integration credential.' }),
    };
  }

  if (path === '/oauth/token') {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: { ...cors, Allow: 'POST' }, body: '' };
    }
    let form;
    try { form = parseForm(event.body || ''); }
    catch (_) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'invalid_request' }) };
    }
    const tokenHeaders = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (form.grant_type !== 'client_credentials') {
      return { statusCode: 400, headers: tokenHeaders, body: JSON.stringify({ error: 'unsupported_grant_type' }) };
    }
    const expectedId = process.env.MCP_OAUTH_CLIENT_ID_V2;
    const expectedSecret = process.env.MCP_OAUTH_CLIENT_SECRET_V2;
    const bearer = process.env.MCP_BEARER_TOKEN_V2;
    if (!expectedId || !expectedSecret || !bearer) {
      return { statusCode: 503, headers: tokenHeaders, body: JSON.stringify({ error: 'temporarily_unavailable' }) };
    }
    const basic = parseBasicAuth(event.headers.authorization || event.headers.Authorization || '');
    const clientId = basic ? basic.id : (form.client_id || '');
    const clientSecret = basic ? basic.secret : (form.client_secret || '');
    // Do not combine partial credentials from different authentication methods.
    if (!safeEqual(clientId, expectedId) || !safeEqual(clientSecret, expectedSecret)) {
      return {
        statusCode: 401,
        headers: { ...tokenHeaders, 'WWW-Authenticate': 'Basic realm="hq-dashboard-mcp"' },
        body: JSON.stringify({ error: 'invalid_client' }),
      };
    }
    // This provisioned bearer is valid until rotated. Do not claim an expiry
    // that the existing bearer validator does not enforce.
    return {
      statusCode: 200,
      headers: tokenHeaders,
      body: JSON.stringify({ access_token: bearer, token_type: 'Bearer', scope: 'mcp' }),
    };
  }

  // ---- MCP JSON-RPC endpoint (Bearer required) ----
  // Auth: Authorization: Bearer ${MCP_BEARER_TOKEN_V2}, OR ?token= query param as
  // a fallback so clients whose UI only takes a URL (Anthropic custom HTTP
  // connector form, which has no headers field) can still authenticate. Note:
  // URLs containing the token may land in Netlify access logs; prefer the
  // header where possible, and rotate MCP_BEARER_TOKEN_V2 if the URL leaks.
  const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
  const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const queryToken = (event.queryStringParameters && event.queryStringParameters.token) || '';
  const presented = headerToken || queryToken;
  // Deliberately no fallback to the retired credential names. Until replacement
  // credentials are provisioned, external MCP access stays paused.
  const expected = process.env.MCP_BEARER_TOKEN_V2;
  if (!expected) {
    return {
      statusCode: 503,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'temporarily_unavailable' }),
    };
  }
  if (!safeEqual(presented, expected)) {
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
