// BusyBusy Payroll Export import (prompt 52). Replaces the dead GraphQL proxy
// (pec-busybusy.cjs, 401 since 2026-06-13) with the AlignOps-supplied snapshot
// endpoint: GET https://export.busybusy.io/?start=..&end=.. returning CSV.
//
// Two modes on one endpoint, both admin-only:
//   POST ?mode=preview  -> fetch + parse + classify, return the summary. NO writes
//                          to time entries (it does persist newly-seen employee
//                          names and project rows so the mapping screens fill).
//   POST ?mode=commit   -> re-fetch (never trust a client payload), then call the
//                          pec_busybusy_import RPC which atomically replaces the
//                          window (insert audit row + delete window + insert rows
//                          in ONE transaction).
//
// THE RULE THAT MATTERS MOST: a fetch failure (401, 5xx, network, bad header)
// NEVER reaches the delete step. 401 means the member-session token died (no exp
// claim, but a logout/password change kills it silently); the stored window must
// survive that untouched. Only a parsed, well-formed response can replace data.
//
// Deliberately NOT parsed or returned: the Wage and Cost columns. Their OT1 Wage
// is 1.5x and Cost includes the OT premium but not our burden; costing uses
// pec_prod_crew_members.hourly_wage + the existing burden math. No wage figure
// ever reaches the browser from here.
const { json, requireStaff, sb } = require('./_pec-supabase.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUSYBUSY_EXPORT_TOKEN = process.env.BUSYBUSY_EXPORT_TOKEN;

// The exact 45-column header the parser was built against (discovery task 2).
// A drifted header means silent mis-mapping, so we reject with the difference
// named instead of guessing.
const EXPECTED_COLUMNS = [
  'Id', 'CreatedBy', 'LastEditedBy', 'EmployeeId', 'FirstName', 'LastName',
  'EmployeePosition', 'EmployeeGroup', 'Date', 'Start', 'End', 'Wage', 'Hours',
  'BreakHours', 'WageType', 'Cost', 'SafetySignOffInjured',
  'CorrectTimeSignOffTimeAccurate', 'BudgetedHours', 'BudgetedCost', 'Customer',
  'ProjectCity', 'ProjectState', 'ProjectGroup', 'ProjectNumber', 'Project',
  'SubProject1Number', 'SubProject1', 'SubProject2Number', 'SubProject2',
  'SubProject3Number', 'SubProject3', 'SubProject4Number', 'SubProject4',
  'SubProject5Number', 'SubProject5', 'SubProject6Number', 'SubProject6',
  'CostCode', 'CostCodeDescription', 'CostCodeGroup', 'Equipment',
  'EquipmentMakeModel', 'EquipmentMeterReading', 'Description',
];

// RFC4180-style CSV parser: quoted fields, "" escapes, LF or CRLF. The export
// double-quotes every field and Description is free text, so a split-on-comma
// would corrupt rows. Returns array of arrays of TRIMMED strings (discovery:
// EquipmentMakeModel is a literal single space on every row; trim everything
// before any empties test).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field.trim()); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field.trim()); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

// Lowercase + collapse whitespace: the ONLY name normalization allowed. Fuzzy
// matching is proven dangerous on this data ('Gordon' also hits "Gordon  Clarry",
// 'Rhodes' also hits "Wayne Rhodes").
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// 'MM/DD/YYYY' -> 'YYYY-MM-DD'. The Date column is authoritative for work_date
// (verified equal to date(Start) on every row); we convert format only.
function isoDate(mdy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mdy || '');
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

// 'YYYY-MM-DD HH:mm:ss' local Arizona -> explicit-offset timestamptz string.
// Arizona has no DST so a fixed -07:00 is ALWAYS correct; never let a runtime
// guess the zone.
function azTimestamp(s) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s || '') ? s.replace(' ', 'T') + '-07:00' : null;
}

async function fetchExport(baseUrl, startDate, endDate) {
  const url = `${baseUrl.replace(/\/+$/, '')}/?start=${encodeURIComponent(startDate + ' 00:00:00')}&end=${encodeURIComponent(endDate + ' 23:59:59')}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  let res;
  try {
    res = await fetch(url, { headers: { 'Key-Authorization': BUSYBUSY_EXPORT_TOKEN }, signal: ctrl.signal });
  } catch (err) {
    clearTimeout(t);
    return { ok: false, hard: true, error: `Could not reach the BusyBusy export endpoint (${err && err.name === 'AbortError' ? 'timed out after 8s' : (err && err.message) || 'network error'}). Nothing was changed.` };
  }
  clearTimeout(t);

  // All four response cases, explicitly (discovery tasks 1 + 10):
  if (res.status === 404) return { ok: true, rows: [] };            // doc claims 404 on empty; treat as zero rows
  if (res.status === 401) return { ok: false, hard: true, error: 'BusyBusy returned 401: the member-session token is dead (it has no expiry but dies on logout, password change, or a server-side prune). Dylan needs to supply a fresh token in the Netlify env var BUSYBUSY_EXPORT_TOKEN. Nothing was changed.' };
  if (!res.ok) return { ok: false, hard: true, error: `BusyBusy export returned HTTP ${res.status}. Nothing was changed.` };

  const text = await res.text();
  if (!text.trim()) return { ok: false, hard: true, error: 'BusyBusy returned 200 with an empty body (no header row). Refusing to treat an unrecognized shape as data. Nothing was changed.' };

  const parsed = parseCsv(text);
  const header = parsed[0] || [];
  if (header.length !== EXPECTED_COLUMNS.length ||
      header.some((h, i) => h !== EXPECTED_COLUMNS[i])) {
    const diffs = [];
    for (let i = 0; i < Math.max(header.length, EXPECTED_COLUMNS.length); i++) {
      if (header[i] !== EXPECTED_COLUMNS[i]) diffs.push(`col ${i + 1}: expected ${EXPECTED_COLUMNS[i] || '(none)'}, got ${header[i] || '(none)'}`);
    }
    return { ok: false, hard: true, error: `BusyBusy CSV header changed; refusing to import rather than mis-map columns. Differences: ${diffs.slice(0, 5).join('; ')}${diffs.length > 5 ? ` (+${diffs.length - 5} more)` : ''}` };
  }
  // 200 with only the header row = a legitimate, successful, empty window
  // (observed live on a future range; the documented 404 did not reproduce).
  const dataRows = parsed.slice(1).filter(r => r.length === EXPECTED_COLUMNS.length);
  const malformed = parsed.length - 1 - dataRows.length;
  if (malformed > 0) return { ok: false, hard: true, error: `${malformed} CSV row(s) had the wrong field count; refusing a partial parse. Nothing was changed.` };
  return { ok: true, rows: dataRows.map(r => Object.fromEntries(EXPECTED_COLUMNS.map((c, i) => [c, r[i]]))) };
}

// Load everything classification needs in one place. Service-role reads.
async function loadContext() {
  const [settingsRows, employees, projects, jobs, schedDays] = await Promise.all([
    sb('GET', '/settings?select=key,value&key=like.busybusy_*'),
    sb('GET', '/pec_prod_busybusy_employees?select=id,busybusy_name,crew_member_id,ignored'),
    sb('GET', '/pec_prod_busybusy_projects?select=id,project_number,project_name,job_id,is_overhead'),
    sb('GET', '/pec_prod_jobs?select=id,customer_name&archived_at=is.null'),
    sb('GET', '/pec_prod_job_schedule_days?select=job_id,scheduled_date'),
  ]);
  const settings = Object.fromEntries((settingsRows || []).map(s => [s.key, s.value]));
  return {
    baseUrl: settings.busybusy_export_base_url || 'https://export.busybusy.io/',
    anomalyThreshold: Number(settings.busybusy_anomaly_hours_threshold) > 0 ? Number(settings.busybusy_anomaly_hours_threshold) : 16,
    overheadNames: String(settings.busybusy_overhead_project_names || 'Shop').split(',').map(norm).filter(Boolean),
    employees: employees || [],
    projects: projects || [],
    jobs: jobs || [],
    schedByJob: (schedDays || []).reduce((acc, d) => { (acc[d.job_id] ||= []).push(d.scheduled_date); return acc; }, {}),
  };
}

// Classify every CSV row into the storage shape. Persists newly-seen employee
// names and project rows (the mapping screens read those), attempts the
// one-time project auto-link, and collects anomalies. Mutates nothing else.
async function classify(csvRows, ctx) {
  const out = { rows: [], unmappedEmployees: new Set(), ignoredEmployees: new Set(), unlinkedProjects: {}, anomalies: [], errors: [] };
  const empByName = Object.fromEntries(ctx.employees.map(e => [e.busybusy_name, e]));
  const projByNumber = {};
  const projByName = {};
  for (const p of ctx.projects) {
    if (p.project_number) projByNumber[p.project_number] = p;
    else projByName[norm(p.project_name)] = p;
  }
  const jobsByNormName = {};
  for (const j of ctx.jobs) {
    const k = norm(j.customer_name);
    if (k) (jobsByNormName[k] ||= []).push(j);
  }

  // Work dates per project (for the multi-match schedule-range tiebreak).
  const projWorkDates = {};
  for (const r of csvRows) {
    const key = r.ProjectNumber || 'name:' + norm(r.Project);
    const d = isoDate(r.Date);
    if (d) (projWorkDates[key] ||= new Set()).add(d);
  }

  // Resolve (and if needed create + auto-link) the project row for a CSV row.
  const resolvedProjects = {}; // cache per CSV project key
  async function resolveProject(r) {
    const key = r.ProjectNumber || 'name:' + norm(r.Project);
    if (resolvedProjects[key]) return resolvedProjects[key];
    let p = r.ProjectNumber ? projByNumber[r.ProjectNumber] : projByName[norm(r.Project)];
    if (!p) {
      // First sight: auto-link by EXACT normalized customer name (locked
      // decision 6). Zero or 2+ matches -> unlinked, human links it in Part E.
      let jobId = null;
      const candidates = jobsByNormName[norm(r.Project)] || [];
      if (candidates.length === 1) jobId = candidates[0].id;
      else if (candidates.length > 1) {
        // Tiebreak: which candidate's scheduled-day range covers a work date
        // this project actually has in this pull. Exactly one survivor links.
        const dates = [...(projWorkDates[key] || [])];
        const survivors = candidates.filter(j => {
          const sched = ctx.schedByJob[j.id] || [];
          if (!sched.length) return false;
          const lo = sched.reduce((a, b) => a < b ? a : b), hi = sched.reduce((a, b) => a > b ? a : b);
          return dates.some(d => d >= lo && d <= hi);
        });
        if (survivors.length === 1) jobId = survivors[0].id;
      }
      const isOverhead = ctx.overheadNames.includes(norm(r.Project));
      try {
        const ins = await sb('POST', '/pec_prod_busybusy_projects', {
          project_number: r.ProjectNumber || null,
          project_name: r.Project,
          job_id: isOverhead ? null : jobId,
          is_overhead: isOverhead,
          linked_at: jobId && !isOverhead ? new Date().toISOString() : null,
        }, true);
        p = Array.isArray(ins) ? ins[0] : ins;
      } catch (err) {
        // Likely a unique-index race with a concurrent request; re-read.
        const q = r.ProjectNumber
          ? `/pec_prod_busybusy_projects?project_number=eq.${encodeURIComponent(r.ProjectNumber)}&limit=1`
          : `/pec_prod_busybusy_projects?project_number=is.null&project_name=ilike.${encodeURIComponent(r.Project)}&limit=1`;
        const rows = await sb('GET', q + '&select=id,project_number,project_name,job_id,is_overhead');
        p = rows && rows[0];
        if (!p) throw err;
      }
      if (p.project_number) projByNumber[p.project_number] = p; else projByName[norm(p.project_name)] = p;
    }
    resolvedProjects[key] = p;
    return p;
  }

  for (const r of csvRows) {
    const employeeName = `${r.FirstName} ${r.LastName}`.trim().replace(/\s+/g, ' ');
    // 1) Employee: exact-name mapping table, never fuzzy. Unknown names get a
    //    row so the Part D screen lists them; their hours import with a null
    //    crew_member_id and never reach costing until mapped.
    let emp = empByName[employeeName];
    if (!emp) {
      try {
        const ins = await sb('POST', '/pec_prod_busybusy_employees', { busybusy_name: employeeName }, true);
        emp = Array.isArray(ins) ? ins[0] : ins;
      } catch (_) {
        const rows = await sb('GET', `/pec_prod_busybusy_employees?busybusy_name=eq.${encodeURIComponent(employeeName)}&select=id,busybusy_name,crew_member_id,ignored&limit=1`);
        emp = (rows && rows[0]) || { busybusy_name: employeeName, crew_member_id: null, ignored: false };
      }
      empByName[employeeName] = emp;
    }
    if (emp.ignored) out.ignoredEmployees.add(employeeName);
    else if (!emp.crew_member_id) out.unmappedEmployees.add(employeeName);

    // 2) Project link: number first, then normalized name (empty-number only).
    const isShopless = !r.Project; // never seen in the data; guarded anyway
    const proj = isShopless ? null : await resolveProject(r);
    // 3) Overhead never carries a job_id (locked decision 5).
    const isOverhead = !!(proj && proj.is_overhead) || ctx.overheadNames.includes(norm(r.Project));
    const jobId = isOverhead ? null : (proj && proj.job_id) || null;

    const workDate = isoDate(r.Date);
    const startedAt = azTimestamp(r.Start);
    const endedAt = azTimestamp(r.End);
    const hours = Number(r.Hours);
    if (!workDate || !Number.isFinite(hours)) {
      out.errors.push(`Unparseable row (Date=${r.Date}, Hours=${r.Hours}, ${employeeName})`);
      continue;
    }
    if (!isOverhead && !jobId && r.Project) {
      const k = `${r.ProjectNumber || ''}|${r.Project}`;
      out.unlinkedProjects[k] = out.unlinkedProjects[k] || { project_number: r.ProjectNumber || null, project_name: r.Project, hours: 0, rows: 0 };
      out.unlinkedProjects[k].hours += hours;
      out.unlinkedProjects[k].rows += 1;
    }

    out.rows.push({
      work_date: workDate,
      employee_name: employeeName,
      crew_member_id: (!emp.ignored && emp.crew_member_id) || null,
      busybusy_project_number: r.ProjectNumber || null,
      busybusy_project_name: r.Project || null,
      job_id: jobId,
      is_overhead: isOverhead,
      started_at: startedAt,
      ended_at: endedAt,
      hours,
      wage_type: r.WageType || 'REG',
      break_hours: Number(r.BreakHours) || 0,
      description: r.Description || null,
      source_export_id: r.Id || null,
    });
  }

  // Anomalies: reported, never acted on (locked decision 9). The 47.78-hour
  // punch and the 24.00-hour row in the sample week are LEGITIMATE rows.
  const th = ctx.anomalyThreshold;
  const windows = new Map(); // dedupe split REG/OT1 pairs (same start/end) before overlap checks
  for (const row of out.rows) {
    if (row.hours > th) out.anomalies.push({ type: 'long_hours', employee: row.employee_name, date: row.work_date, project: row.busybusy_project_name, start: row.started_at, end: row.ended_at, hours: row.hours, detail: `${row.hours} hours in one row (threshold ${th})` });
    if (row.hours <= 0) out.anomalies.push({ type: 'non_positive_hours', employee: row.employee_name, date: row.work_date, project: row.busybusy_project_name, start: row.started_at, end: row.ended_at, hours: row.hours, detail: 'Hours is zero or negative' });
    if (row.started_at && row.ended_at && row.ended_at < row.started_at) out.anomalies.push({ type: 'end_before_start', employee: row.employee_name, date: row.work_date, project: row.busybusy_project_name, start: row.started_at, end: row.ended_at, hours: row.hours, detail: 'End is before Start' });
    if (row.description) out.anomalies.push({ type: 'has_description', employee: row.employee_name, date: row.work_date, project: row.busybusy_project_name, start: row.started_at, end: row.ended_at, hours: row.hours, detail: `Note on the punch (usually a correction): "${row.description}"` });
    const wk = `${row.employee_name}|${row.started_at}|${row.ended_at}`;
    if (!windows.has(wk)) windows.set(wk, row);
  }
  // Overlapping punches per employee, on DISTINCT windows only: a split
  // REG/OT1 pair shares its exact Start/End by design and is not an overlap.
  const byEmp = {};
  for (const w of windows.values()) if (w.started_at && w.ended_at) (byEmp[w.employee_name] ||= []).push(w);
  for (const [emp, ws] of Object.entries(byEmp)) {
    ws.sort((a, b) => a.started_at < b.started_at ? -1 : 1);
    for (let i = 1; i < ws.length; i++) {
      if (ws[i].started_at < ws[i - 1].ended_at) {
        out.anomalies.push({ type: 'overlap', employee: emp, date: ws[i].work_date, project: ws[i].busybusy_project_name, start: ws[i].started_at, end: ws[i].ended_at, hours: ws[i].hours, detail: `Overlaps the previous punch (${ws[i - 1].started_at} to ${ws[i - 1].ended_at} on ${ws[i - 1].busybusy_project_name || 'Shop'})` });
      }
    }
  }
  return out;
}

function summarize(c, jobs) {
  const jobName = Object.fromEntries(jobs.map(j => [j.id, j.customer_name]));
  const perJob = {};
  let total = 0, ot = 0, overhead = 0, jobAttributed = 0;
  const employees = new Set();
  for (const r of c.rows) {
    total += r.hours;
    if (r.wage_type === 'OT1') ot += r.hours;
    if (r.is_overhead) overhead += r.hours;
    if (r.job_id) {
      jobAttributed += r.hours;
      const k = r.job_id;
      perJob[k] = perJob[k] || { job_id: k, customer: jobName[k] || r.busybusy_project_name, hours: 0, ot_hours: 0 };
      perJob[k].hours += r.hours;
      if (r.wage_type === 'OT1') perJob[k].ot_hours += r.hours;
    }
    employees.add(r.employee_name);
  }
  const rnd = (n) => Math.round(n * 100) / 100;
  return {
    rowCount: c.rows.length,
    employees: [...employees].sort(),
    employeeCount: employees.size,
    totalHours: rnd(total),
    regHours: rnd(total - ot),
    otHours: rnd(ot),
    overheadHours: rnd(overhead),
    jobHours: rnd(jobAttributed),
    unattributedJobHours: rnd(total - overhead - jobAttributed), // unlinked-project hours
    perJob: Object.values(perJob).map(j => ({ ...j, hours: rnd(j.hours), ot_hours: rnd(j.ot_hours) })).sort((a, b) => b.hours - a.hours),
    unmappedEmployees: [...c.unmappedEmployees].sort(),
    ignoredEmployees: [...c.ignoredEmployees].sort(),
    unlinkedProjects: Object.values(c.unlinkedProjects).map(p => ({ ...p, hours: rnd(p.hours) })).sort((a, b) => b.hours - a.hours),
    anomalies: c.anomalies,
    parseErrors: c.errors,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const auth = await requireStaff(event, { adminOnly: true });
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (!BUSYBUSY_EXPORT_TOKEN) return json(500, { error: 'BUSYBUSY_EXPORT_TOKEN is not set in the Netlify environment. Dylan needs to add it (Netlify site settings, Environment variables).' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { error: 'Invalid JSON body' }); }
  const mode = (event.queryStringParameters && event.queryStringParameters.mode) || body.mode;
  const { start, end } = body;
  if (mode !== 'preview' && mode !== 'commit') return json(400, { error: 'mode must be preview or commit' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '') || end < start) {
    return json(400, { error: 'start and end must be YYYY-MM-DD with end >= start' });
  }

  try {
    const ctx = await loadContext();
    const fetched = await fetchExport(ctx.baseUrl, start, end);
    if (!fetched.ok) return json(502, { error: fetched.error, hardFailure: true });

    const classified = await classify(fetched.rows, ctx);
    const summary = summarize(classified, ctx.jobs);

    if (mode === 'preview') {
      return json(200, { mode: 'preview', window: { start, end }, ...summary });
    }

    // COMMIT: call the atomic-replace RPC with the CALLER'S JWT (not the
    // service key) so is_admin_staff() sees the real admin and imported_by is
    // honest. Any error inside rolls the whole replacement back.
    const callerJwt = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/pec_busybusy_import`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${callerJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_window_start: start,
        p_window_end: end,
        p_rows: classified.rows,
        p_user: auth.user.id,
        p_summary: { anomaly_count: summary.anomalies.length, notes: body.notes || null },
      }),
    });
    if (!rpcRes.ok) {
      const detail = await rpcRes.text();
      return json(502, { error: `Import RPC failed (${rpcRes.status}); the stored window was not changed (the replace is one transaction). ${detail.slice(0, 400)}` });
    }
    const importId = (await rpcRes.text()).replace(/"/g, '').trim();

    // Note any drift from the preview the admin looked at before pressing
    // Import (a punch edited in BusyBusy between the two fetches).
    let driftFromPreview = null;
    if (body.previewRowCount != null && Number(body.previewRowCount) !== summary.rowCount) {
      driftFromPreview = `Row count changed since the preview: ${body.previewRowCount} then, ${summary.rowCount} now.`;
    } else if (body.previewTotalHours != null && Math.abs(Number(body.previewTotalHours) - summary.totalHours) > 0.01) {
      driftFromPreview = `Total hours changed since the preview: ${body.previewTotalHours} then, ${summary.totalHours} now.`;
    }
    return json(200, { mode: 'commit', importId, window: { start, end }, driftFromPreview, ...summary });
  } catch (err) {
    console.error('pec-busybusy-export failed:', err);
    return json(500, { error: `Import failed before any data was changed: ${(err && err.message) || err}` });
  }
};
