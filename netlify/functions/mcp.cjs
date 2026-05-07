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
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
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

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected || presented !== expected) {
    return {
      statusCode: 401,
      headers: { ...cors, 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="hq-dashboard-mcp"' },
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
