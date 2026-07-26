// AI weekly sales read for the Metrics tab's Sales section. Called from the
// dashboard's "Refresh" button (staff JWT) or server-to-server (webhook
// secret). The dashboard RENDER never calls this: it shows the cached copy
// from public.settings key 'metrics_sales_ai_insight'; only the button does.
//
// POST /.netlify/functions/pec-metrics-ai   Body: { force?: boolean }
//   or (prompt 50 Part B, the whole-tab read):
// Body: { mode: 'tab', force?, window_key, window_label, window_start,
//         window_end, salesperson?, metrics: {computed values} }
//
// Caching: the last insight lives in settings.value as JSON
// { text, generated_at, model }. A cached copy younger than the TTL is
// returned as-is unless force, so an accidental hammering of the endpoint
// cannot re-bill the API. Upsert on key makes the whole handler idempotent.
// TTL: the metrics_ai_cache_days settings row when set, else CACHE_TTL_DAYS.
// Tab mode caches under 'metrics_tab_ai_insights' as a map keyed by
// window + salesperson (so MTD and YTD never serve each other's text),
// pruned to the newest TAB_CACHE_MAX entries.
//
// This writes INTERNAL analysis only: 3-4 plain sentences about the funnel.
// It never drafts customer contact (that is pec-lead-ai's copy-only job).
//
// Env: ANTHROPIC_API_KEY (shared with sop-chat / pec-lead-ai), optional
// PEC_METRICS_AI_MODEL.

const { sb, json, badSecret, requireStaff } = require('./_pec-supabase.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.PEC_METRICS_AI_MODEL || 'claude-sonnet-5';
const CACHE_KEY = 'metrics_sales_ai_insight';
const CACHE_TTL_DAYS = 7; // fallback when the metrics_ai_cache_days setting is absent
const TAB_CACHE_KEY = 'metrics_tab_ai_insights';
const TAB_CACHE_MAX = 10;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-webhook-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function jc(statusCode, body) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Validate a Supabase access token; returns the user object or null.
// Same pattern as pec-lead-ai.cjs / pec-send-email.cjs.
async function getUser(token) {
  if (!token || !SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
}

const SYSTEM_PROMPT = `You are the weekly sales analyst for Prescott Epoxy Company (PEC), an epoxy floor coating company in Prescott, Arizona. You get funnel aggregates and write a short internal read for the owner. Respond with ONLY 3-4 plain sentences (no markdown, no lists, no JSON): what changed this week, where leads are stalling in the pipeline, and the one thing to act on. Ground every claim in the numbers provided; never invent data. This is internal analysis; never draft anything addressed to a customer.`;

const TAB_SYSTEM_PROMPT = `You are the sales and operations analyst for Prescott Epoxy Company (PEC), an epoxy floor coating company in Prescott, Arizona. You get the COMPUTED metric values from the owner's dashboard Metrics tab for one selected time window (KPI cards plus the Sales section). Respond with ONLY 4-6 plain sentences (no markdown, no lists, no JSON). Start by naming the window you analyzed using its provided label (for example "Month to date"). Cover what moved versus the prior period, notable anomalies, and the one or two things to act on. Ground every claim in the numbers provided; you may summarize but never invent a number that is not in the payload. This is internal analysis; never draft anything addressed to a customer.`;

// One shared Anthropic call: 25s abort (Netlify kills at ~26s), joins every
// text block (content[0] is not guaranteed to be text; same trap as
// pec-lead-ai hit live on 2026-07-11).
async function callModel(system, userContent) {
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), 25000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } finally { clearTimeout(killer); }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
  }
  const out = await res.json();
  const blocks = Array.isArray(out.content) ? out.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) {
    const types = blocks.map((b) => (b && b.type) || 'unknown').join(',') || 'none';
    throw new Error(`empty insight from the model (stop_reason=${out.stop_reason}, blocks=[${types}])`);
  }
  return text;
}

// Cache TTL in days: the metrics_ai_cache_days settings row when it parses
// to a positive number, else the hardcoded fallback (exposed per rule 12).
async function cacheTtlDays() {
  try {
    const rows = await sb('GET', '/settings?key=eq.metrics_ai_cache_days&select=value&limit=1');
    const n = rows.length ? Number(rows[0].value) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) { /* fall through to the default */ }
  return CACHE_TTL_DAYS;
}

// Median helper for speed-to-lead.
function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Gather the aggregates the model reads. All service-role reads via sb().
async function gatherAggregates() {
  const sinceIso = new Date(Date.now() - 28 * 24 * 3600 * 1000).toISOString();
  const weekIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const [leads, estimates] = await Promise.all([
    sb('GET', '/leads?deleted_at=is.null&select=id,stage,source,campaign,created_at,contacted_at,lost_reason'),
    sb('GET', '/estimates?deleted_at=is.null&lead_id=not.is.null&select=lead_id,price,status,created_at&order=created_at.desc'),
  ]);
  // Value per lead: accepted estimate wins, else newest live (same rule as
  // the dashboard's leadValueMapFrom, restated here server-side).
  const valueMap = {}; const acceptedSeen = {};
  for (const e of estimates) {
    const v = Number(e.price) || 0;
    if (e.status === 'accepted') { if (!acceptedSeen[e.lead_id]) { acceptedSeen[e.lead_id] = true; valueMap[e.lead_id] = v; } }
    else if (!acceptedSeen[e.lead_id] && !(e.lead_id in valueMap)) valueMap[e.lead_id] = v;
  }
  const byStage = {};
  const bySource = {};
  let newThisWeek = 0, acceptedThisWeek = 0, lostThisWeek = 0;
  const s2l = [];
  const lostReasons = {};
  for (const l of leads) {
    if (l.stage !== 'accepted' && l.stage !== 'lost') {
      const st = (byStage[l.stage] ||= { n: 0, value: 0 });
      st.n++; st.value += valueMap[l.id] || 0;
    }
    if (l.created_at >= weekIso) newThisWeek++;
    if (l.stage === 'accepted' && l.created_at >= sinceIso) acceptedThisWeek += (l.created_at >= weekIso ? 1 : 0);
    if (l.stage === 'lost') {
      if (l.created_at >= weekIso) lostThisWeek++;
      if (l.lost_reason) lostReasons[l.lost_reason] = (lostReasons[l.lost_reason] || 0) + 1;
    }
    const src = (bySource[l.source || 'unknown'] ||= { leads: 0, accepted: 0 });
    src.leads++; if (l.stage === 'accepted') src.accepted++;
    if (l.contacted_at && l.created_at >= sinceIso) {
      const mins = (new Date(l.contacted_at) - new Date(l.created_at)) / 60000;
      if (Number.isFinite(mins) && mins >= 0) s2l.push(mins);
    }
  }
  return {
    generated_for: new Date().toISOString(),
    total_leads: leads.length,
    new_leads_last_7_days: newThisWeek,
    accepted_last_7_days: acceptedThisWeek,
    lost_last_7_days: lostThisWeek,
    open_pipeline_by_stage: byStage,
    conversion_by_source: bySource,
    median_speed_to_lead_minutes_28d: median(s2l),
    lost_reasons_all_time: lostReasons,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { success: false, error: 'Method not allowed' });

  // Auth: staff JWT OR webhook secret (server-to-server), like pec-lead-ai.
  if (badSecret(event)) {
    const gate = await requireStaff(event);
    if (!gate.ok) return jc(gate.status, { success: false, error: gate.error });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { success: false, error: 'Invalid JSON' }); }

  try {
    const ttlDays = await cacheTtlDays();
    const ttlMs = ttlDays * 24 * 3600 * 1000;

    // ---- Tab mode (prompt 50 Part B): whole-tab read of client-computed
    // metrics, cache keyed by window + salesperson. -------------------------
    if (body.mode === 'tab') {
      if (!body.metrics || typeof body.metrics !== 'object') {
        return jc(400, { success: false, error: 'metrics payload missing' });
      }
      const metricsJson = JSON.stringify(body.metrics, null, 2);
      if (metricsJson.length > 60000) return jc(400, { success: false, error: 'metrics payload too large' });
      const winLabel = String(body.window_label || 'Selected window').slice(0, 80);
      const cacheId = [
        String(body.window_key || '?'),
        String(body.window_start || '?'),
        String(body.window_end || '?'),
        String(body.salesperson || 'all'),
      ].join('|');

      const tabRows = await sb('GET', `/settings?key=eq.${TAB_CACHE_KEY}&select=value&limit=1`);
      let tabMap = {};
      if (tabRows.length) { try { tabMap = JSON.parse(tabRows[0].value) || {}; } catch (_) { tabMap = {}; } }
      const hit = tabMap[cacheId];
      if (hit && !body.force) {
        const ageMs = Date.now() - new Date(hit.generated_at).getTime();
        if (Number.isFinite(ageMs) && ageMs < ttlMs) {
          return jc(200, { success: true, cached: true, insight: hit });
        }
      }

      if (!ANTHROPIC_API_KEY) return jc(503, { success: false, error: 'ANTHROPIC_API_KEY not configured' });
      const userContent = `WINDOW: ${winLabel} (${body.window_start} to ${body.window_end})`
        + (body.salesperson ? `\nSALESPERSON FILTER: ${String(body.salesperson).slice(0, 60)}` : '\nSALESPERSON FILTER: none (all salespeople)')
        + `\nCOMPUTED METRICS:\n` + metricsJson;
      const text = await callModel(TAB_SYSTEM_PROMPT, userContent);
      const insight = { text, generated_at: new Date().toISOString(), model: MODEL, window_label: winLabel };

      tabMap[cacheId] = insight;
      // Prune to the newest TAB_CACHE_MAX so old windows do not grow the row forever.
      const keys = Object.keys(tabMap).sort((a, b) =>
        new Date(tabMap[b].generated_at || 0) - new Date(tabMap[a].generated_at || 0));
      for (const k of keys.slice(TAB_CACHE_MAX)) delete tabMap[k];
      if (tabRows.length) {
        await sb('PATCH', `/settings?key=eq.${TAB_CACHE_KEY}`, { value: JSON.stringify(tabMap) });
      } else {
        await sb('POST', '/settings', { key: TAB_CACHE_KEY, value: JSON.stringify(tabMap) });
      }
      return jc(200, { success: true, cached: false, insight });
    }

    // ---- Weekly pipeline read (the original mode, unchanged) --------------
    // Cache first: fresh enough and not forced -> no model call at all.
    const cachedRows = await sb('GET', `/settings?key=eq.${CACHE_KEY}&select=value&limit=1`);
    if (cachedRows.length && !body.force) {
      try {
        const cached = JSON.parse(cachedRows[0].value);
        const ageMs = Date.now() - new Date(cached.generated_at).getTime();
        if (Number.isFinite(ageMs) && ageMs < ttlMs) {
          return jc(200, { success: true, cached: true, insight: cached });
        }
      } catch (_) { /* unparseable cache regenerates below */ }
    }

    if (!ANTHROPIC_API_KEY) return jc(503, { success: false, error: 'ANTHROPIC_API_KEY not configured' });

    const aggregates = await gatherAggregates();
    const text = await callModel(SYSTEM_PROMPT, 'SALES FUNNEL AGGREGATES:\n' + JSON.stringify(aggregates, null, 2));

    const insight = { text, generated_at: new Date().toISOString(), model: MODEL };
    // Cache write: PATCH the existing row (we already know from cachedRows
    // whether one exists), else insert it. sb() has no upsert-header support,
    // and the only writer is this handler, so update-or-insert is race-safe
    // enough; a duplicate-key insert on the unique key column just errors
    // loudly into the catch.
    if (cachedRows.length) {
      await sb('PATCH', `/settings?key=eq.${CACHE_KEY}`, { value: JSON.stringify(insight) });
    } else {
      await sb('POST', '/settings', { key: CACHE_KEY, value: JSON.stringify(insight) });
    }

    return jc(200, { success: true, cached: false, insight });
  } catch (err) {
    console.error('pec-metrics-ai failed:', err);
    return jc(500, { success: false, error: 'Insight failed', detail: err && err.message });
  }
};
