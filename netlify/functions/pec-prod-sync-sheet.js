// PEC PM Module 1: sync a production job to the PEC Order Sheet, or move it
// to COMPLETED JOBS when the install is done.
//
// Caller must pass their own Supabase JWT as Bearer; the function checks that
// the caller is in admin_users with role IN ('admin','pm','office').
//
// POST /.netlify/functions/pec-prod-sync-sheet
// Body:
//   { action: 'sync',          job_id }   sync the job's current state to NEW ORDER SHEET
//   { action: 'mark_complete', job_id }   move to COMPLETED JOBS, set job.status='completed'
//
// Env vars (Netlify):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   PEC_SHEETS_PROXY_URL          existing /exec URL of the Apps Script proxy
//   PEC_SHEETS_PROXY_SECRET       must match SCRIPT_SECRET in Apps Script Project Properties
//   PEC_PROD_SHEET_ID             production sheet id
//   PEC_PROD_SHEET_ID_TEST        copy used during dev. Used when body.use_test=true
//                                 OR when CONTEXT='dev' (Netlify Dev / preview).

const { sb, json } = require('./_pec-supabase.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHEETS_PROXY_URL = process.env.PEC_SHEETS_PROXY_URL;
const SHEETS_PROXY_SECRET = process.env.PEC_SHEETS_PROXY_SECRET;
const SHEET_ID_PROD = process.env.PEC_PROD_SHEET_ID;
const SHEET_ID_TEST = process.env.PEC_PROD_SHEET_ID_TEST;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jsonCors(405, { error: 'Method not allowed' });

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) return jsonCors(401, { error: 'Missing bearer token' });
  const jwt = authHeader.slice(7);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { error: 'Invalid JSON' }); }

  const { action, job_id, use_test } = body;
  if (!['sync', 'mark_complete'].includes(action)) {
    return jsonCors(400, { error: 'action must be "sync" or "mark_complete"' });
  }
  if (!job_id) return jsonCors(400, { error: 'job_id required' });

  // Validate caller -> admin_users.
  const caller = await validateCaller(jwt);
  if (!caller.ok) return jsonCors(caller.status, { error: caller.error });

  // Sync config check.
  if (!SHEETS_PROXY_URL || !SHEETS_PROXY_SECRET) {
    return jsonCors(503, {
      error: 'Sheet sync not configured. Dylan needs to set PEC_SHEETS_PROXY_URL and PEC_SHEETS_PROXY_SECRET in Netlify env.',
    });
  }
  const sheetId = pickSheetId(use_test, event);
  if (!sheetId) {
    return jsonCors(503, {
      error: 'No sheet id configured. Set PEC_PROD_SHEET_ID (or PEC_PROD_SHEET_ID_TEST for dev).',
    });
  }

  try {
    const job = await loadJobBundle(job_id);
    if (!job) return jsonCors(404, { error: 'Job not found' });

    if (action === 'sync') {
      return await doSync({ job, sheetId, caller, useTest: !!use_test });
    } else {
      return await doMarkComplete({ job, sheetId, caller, useTest: !!use_test });
    }
  } catch (err) {
    console.error('pec-prod-sync-sheet error:', err);
    return jsonCors(500, { error: err.message });
  }
};

// ---------------------------------------------------------------------------
async function validateCaller(jwt) {
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!userRes.ok) return { ok: false, status: 401, error: 'Invalid session' };
  const auth = await userRes.json();

  const rows = await sb('GET', `/admin_users?auth_user_id=eq.${auth.id}&select=id,email,role&limit=1`);
  if (!rows.length) return { ok: false, status: 403, error: 'Not a staff member' };
  if (!['admin', 'pm', 'office'].includes(rows[0].role)) {
    return { ok: false, status: 403, error: 'Staff role required' };
  }
  return { ok: true, auth_user_id: auth.id, email: rows[0].email, admin_id: rows[0].id, role: rows[0].role };
}

function pickSheetId(useTestFlag, event) {
  // Explicit body flag wins. Otherwise pick TEST when running in Netlify Dev
  // (CONTEXT=dev) and TEST is set; fall back to PROD otherwise.
  const ctx = process.env.CONTEXT || '';
  if (useTestFlag && SHEET_ID_TEST) return SHEET_ID_TEST;
  if (ctx === 'dev' && SHEET_ID_TEST) return SHEET_ID_TEST;
  return SHEET_ID_PROD || SHEET_ID_TEST || null;
}

// ---------------------------------------------------------------------------
async function loadJobBundle(jobId) {
  const jobs = await sb('GET', `/pec_prod_jobs?id=eq.${jobId}&limit=1`);
  if (!jobs.length) return null;
  const job = jobs[0];

  const areas = await sb('GET', `/pec_prod_areas?job_id=eq.${jobId}&order=order_index.asc`);
  const lines = await sb('GET', `/pec_prod_material_lines?job_id=eq.${jobId}&order=order_index.asc`);

  // System-type names so we can build a friendly summary string for column D.
  let systemTypeNames = {};
  if (areas.length) {
    const ids = [...new Set(areas.map((a) => a.system_type_id).filter(Boolean))];
    if (ids.length) {
      const idList = ids.map((id) => `"${id}"`).join(',');
      const sysRows = await sb('GET', `/pec_prod_system_types?id=in.(${idList})&select=id,name`);
      systemTypeNames = Object.fromEntries(sysRows.map((r) => [r.id, r.name]));
    }
  }

  return { job, areas, lines, systemTypeNames };
}

// ---------------------------------------------------------------------------
async function doSync({ job: bundle, sheetId, caller, useTest }) {
  const { job, areas, lines, systemTypeNames } = bundle;

  if (!lines.length) {
    return jsonCors(400, {
      error: 'Job has no material lines. Save material lines before syncing.',
    });
  }

  const before = { ...job };

  const payload = {
    secret: SHEETS_PROXY_SECRET,
    action: 'syncJob',
    sheet_id: sheetId,
    proposal_number: job.proposal_number,
    install_date: job.install_date || null,
    job_name: job.customer_name + (job.address ? ` - ${job.address}` : ''),
    system_type_summary: buildSystemSummary(areas, systemTypeNames),
    sqft_total: areas.reduce((sum, a) => sum + Number(a.sqft || 0), 0),
    lines: lines.map((l) => ({
      material: l.product_name,
      supplier: l.supplier || '',
      color: l.color || '',
      qty_needed: Number(l.qty_needed || 0),
      backstock_qty: Number(l.backstock_qty || 0),
      order_qty: Number(l.order_qty || 0),
      use_backstock: !!l.use_backstock,
      backstock_notes: l.notes || '',
      ordered: !!l.ordered,
      delivered: !!l.delivered,
    })),
  };

  let proxyResult;
  try {
    proxyResult = await callProxy(payload);
  } catch (err) {
    await sb('PATCH', `/pec_prod_jobs?id=eq.${job.id}`, {
      sync_status: 'error',
      sync_error: String(err.message || err),
    });
    await writeAudit(caller, 'pec_prod_sync_failed', job.id, before, { error: String(err.message || err), use_test: useTest });
    return jsonCors(502, { error: `Sheet sync failed: ${err.message || err}` });
  }

  if (!proxyResult || proxyResult.ok !== true) {
    const msg = (proxyResult && proxyResult.error) || 'Apps Script returned ok:false';
    await sb('PATCH', `/pec_prod_jobs?id=eq.${job.id}`, { sync_status: 'error', sync_error: msg });
    await writeAudit(caller, 'pec_prod_sync_failed', job.id, before, { error: msg, use_test: useTest });
    return jsonCors(502, { error: `Sheet sync failed: ${msg}` });
  }

  const updatedRows = await sb(
    'PATCH',
    `/pec_prod_jobs?id=eq.${job.id}`,
    {
      last_synced_at: new Date().toISOString(),
      sync_status: 'clean',
      sync_error: null,
    },
    true
  );
  const updated = updatedRows && updatedRows[0] ? updatedRows[0] : null;

  await writeAudit(caller, 'pec_prod_sync', job.id, before, {
    rows_written: proxyResult.rows_written,
    inserted_at_row: proxyResult.inserted_at_row,
    use_test: useTest,
  });

  return jsonCors(200, {
    ok: true,
    job_id: job.id,
    rows_written: proxyResult.rows_written,
    inserted_at_row: proxyResult.inserted_at_row,
    last_synced_at: updated && updated.last_synced_at,
    used_sheet: useTest ? 'test' : 'prod',
  });
}

// ---------------------------------------------------------------------------
async function doMarkComplete({ job: bundle, sheetId, caller, useTest }) {
  const { job } = bundle;
  const before = { ...job };

  const payload = {
    secret: SHEETS_PROXY_SECRET,
    action: 'moveJobToCompleted',
    sheet_id: sheetId,
    proposal_number: job.proposal_number,
    completed_date: todayIso(),
  };

  let proxyResult;
  try {
    proxyResult = await callProxy(payload);
  } catch (err) {
    await writeAudit(caller, 'pec_prod_complete_failed', job.id, before, { error: String(err.message || err), use_test: useTest });
    return jsonCors(502, { error: `Move to completed failed: ${err.message || err}` });
  }
  if (!proxyResult || proxyResult.ok !== true) {
    const msg = (proxyResult && proxyResult.error) || 'Apps Script returned ok:false';
    await writeAudit(caller, 'pec_prod_complete_failed', job.id, before, { error: msg, use_test: useTest });
    return jsonCors(502, { error: `Move to completed failed: ${msg}` });
  }

  // Update DB only after Sheet move succeeded. Material lines preserved.
  const updatedRows = await sb(
    'PATCH',
    `/pec_prod_jobs?id=eq.${job.id}`,
    {
      status: 'completed',
      completed_at: new Date().toISOString(),
      sync_status: 'clean',
      sync_error: null,
    },
    true
  );
  const updated = updatedRows && updatedRows[0] ? updatedRows[0] : null;

  await writeAudit(caller, 'pec_prod_complete', job.id, before, {
    moved_rows: proxyResult.moved,
    completed_date: proxyResult.completed_date,
    use_test: useTest,
  });

  return jsonCors(200, {
    ok: true,
    job_id: job.id,
    moved_rows: proxyResult.moved,
    completed_at: updated && updated.completed_at,
    used_sheet: useTest ? 'test' : 'prod',
  });
}

// ---------------------------------------------------------------------------
function buildSystemSummary(areas, systemTypeNames) {
  if (!areas.length) return '';
  const counts = new Map();
  for (const a of areas) {
    const name = systemTypeNames[a.system_type_id] || 'System';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  if (counts.size === 1) {
    return [...counts.keys()][0];
  }
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(' + ');
}

async function callProxy(payload) {
  const res = await fetch(SHEETS_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    throw new Error(`Apps Script returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  return parsed;
}

async function writeAudit(caller, action, jobId, before, after) {
  try {
    await sb('POST', '/audit_log', {
      auth_user_id: caller.auth_user_id,
      admin_email: caller.email,
      action,
      entity_type: 'pec_prod_job',
      entity_id: jobId,
      before_json: before,
      after_json: after,
    });
  } catch (err) {
    console.error('pec-prod-sync-sheet audit write failed:', err);
  }
}

function todayIso() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonCors(statusCode, payload) {
  return {
    statusCode,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}
