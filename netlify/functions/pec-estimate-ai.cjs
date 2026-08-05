// AI price recommendation for one estimate-in-progress. Called by the
// estimator PWA automatically (debounced client-side) once system type and
// sqft are both present.
//
// POST /.netlify/functions/pec-estimate-ai
// Body (per-line, prompt 70): { estimate_id (nullable), lead_id, inputs_key,
//         sqft (total), calc_price (total),
//         lines: [{ line_key, kind: 'calc'|'custom', label, system_type_id,
//                   system_type_name, sqft, mvb, calc_price, target_gp_pct,
//                   scope_text, comps|null }] }
//   One model call returns a recommendation PER LINE plus a short job-level
//   roll-up whose range is the SUM of the line ranges (server-derived). Each
//   line carries a SERVER-computed confidence flag (comps_backed /
//   thin_sample / no_comps, from its comps sample vs comps_min_sample), never
//   model-claimed. Custom lines have no comps by definition and their why
//   must state it (deterministically enforced in ai-lines.cjs).
// Body (legacy, kept for not-yet-refreshed PWA caches): { estimate_id,
//         inputs_key, system_type_name, sqft, mvb, calc_price, target_gp_pct,
//         comps: { rule, rule_label, sample_size, median_ppsf, rows[] } }
//
// The COMPS come from the client on purpose: they are computed by the same
// canonical production/comps.js the rep is looking at, so the model reasons
// over exactly the rows the rep sees and the two can never disagree. This
// endpoint is staff-authed either way.
//
// The AI NEVER sets the price. It returns a recommended sell range plus one
// paragraph of why; the rep decides. When there are zero comps it must SAY it
// is pricing without comparables instead of inventing confidence.
//
// INTENT SIGNAL (2026-07-13): when the estimate hangs off a lead (lead_id in
// the body), the customer's Quo (OpenPhone) history is read as intent signal:
// 'call' lead_events (the pec-openphone-sync writer), pec_call_log rows (the
// pec-webhook-quo call events, matched by the lead's phone), and the SMS
// thread in pec_sms_log (same webhook; matched by phone). Any intent claim
// must cite a specific quote from a transcript or text so the read is
// auditable instead of vibes. HONESTY REQUIREMENT: pec-openphone-sync has
// never successfully returned data from the live API (2026-07-11 Cowork log),
// so every source is assumed possibly EMPTY; with no history the response
// carries history_available=false (computed SERVER-SIDE, never model-claimed)
// and intent_read is forced null, so the panel says "no call history on file"
// instead of the model inferring intent from silence. A history-read failure
// never breaks the price read.
//
// Caching: when estimate_id is present (reopening a saved estimate), a stored
// pricing_snapshot whose inputs_key matches is served without a model call, so
// reopening never re-bills. A fresh result is merged back onto the row. The
// pre-save flow (no estimate_id yet) is cached client-side and persisted by the
// estimator's save.
//
// Env: ANTHROPIC_API_KEY (shared), optional PEC_ESTIMATE_AI_MODEL.

const { sb, badSecret, requireStaff } = require('./_pec-supabase.cjs');
// Per-line read (prompt 70): prompt building, response validation, and the
// SERVER-computed confidence flag live in the shared, test-covered module.
const {
  MIN_COMPS_SAMPLE,
  LINES_SYSTEM_PROMPT,
  buildLinesUserPrompt,
  parseLinesRecommendation,
  finalizeLinesRecommendation,
} = require('../../production/ai-lines.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.PEC_ESTIMATE_AI_MODEL || 'claude-sonnet-5';

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

const SYSTEM_PROMPT = `You are the pricing analyst for Prescott Epoxy Company (PEC), a residential and commercial epoxy floor coating company in Prescott, Arizona. You review ONE in-progress estimate at a time against the company's own completed comparable jobs and its cost-plus calculator price, then recommend a sell range. Rules you must follow:
- Ground every claim in the numbers provided. Never invent jobs, market data, or confidence you do not have.
- If the comps sample is empty, say plainly that you are pricing WITHOUT comparables and lean on the calculator price and target margin only.
- If the comps sample is small or was widened (the rule label says so), name that limitation.
- The calculator price is engineered to hit the target gross profit; recommending below it means recommending margin give-up, so justify it or do not do it.
- COMMUNICATION HISTORY, when present, is intent signal only (urgency, budget language, competing quotes, timeline, who decides). Every intent claim MUST include a short verbatim quote from a transcript or text to back it, so the read is auditable. When the history section says there is none, set intent_read to null and draw NO conclusions from the silence.
- You NEVER set the price; the salesperson decides.
Respond with ONLY a JSON object, no markdown fences, exactly these keys:
{
  "recommended_low": <integer dollars, bottom of the sell range>,
  "recommended_high": <integer dollars, top of the sell range>,
  "why": "one short paragraph (3-5 sentences) explaining the range against the comps' $/sqft, the calculator price, and the target GP, including any sample-size caveat",
  "intent_read": "2-4 sentences on the customer's intent, each claim backed by a verbatim quote from the calls/texts" OR null when there is no communication history
}`;

function buildUserPrompt(b, history) {
  const lines = [];
  lines.push('ESTIMATE IN PROGRESS:');
  lines.push(JSON.stringify({
    system: b.system_type_name,
    sqft: b.sqft,
    mvb: b.mvb, // none | addon (extra moisture-vapor-barrier coat) | standalone (MVB-only job)
    calculator_price: b.calc_price,
    calculator_price_per_sqft: b.sqft > 0 ? Number((b.calc_price / b.sqft).toFixed(2)) : null,
    target_gp_pct: b.target_gp_pct,
  }));
  lines.push('');
  const c = b.comps || {};
  lines.push(`COMPARABLE COMPLETED JOBS (${c.sample_size || 0}; selection rule: ${c.rule_label || 'none'}):`);
  lines.push(JSON.stringify({
    median_price_per_sqft: c.median_ppsf != null ? Number(Number(c.median_ppsf).toFixed(2)) : null,
    jobs: (Array.isArray(c.rows) ? c.rows : []).slice(0, 20).map((r) => ({
      sqft: r.sqft, price: r.price,
      ppsf: r.ppsf != null ? Number(Number(r.ppsf).toFixed(2)) : null,
      actual_gp_pct: r.gp_pct != null ? Number((Number(r.gp_pct) * 100).toFixed(1)) : null,
    })),
  }));
  lines.push('');
  if (history && history.available) {
    lines.push('COMMUNICATION HISTORY (Quo calls and texts with this customer, newest first):');
    lines.push(JSON.stringify(history.items));
  } else {
    lines.push('COMMUNICATION HISTORY: none. NO CALL OR TEXT HISTORY IS ON FILE for this customer. Set intent_read to null and infer nothing from the silence.');
  }
  return lines.join('\n');
}

const clip = (s, n) => {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n) + ' …[truncated]' : str;
};

// Read the lead's Quo history from the three places the existing integrations
// land data (NO new integration): 'call' lead_events (pec-openphone-sync),
// pec_call_log (pec-webhook-quo call events, matched by the lead's phone), and
// pec_sms_log (same webhook, the SMS thread). Every source is best-effort and
// assumed possibly empty; a failure here must never break the price read.
async function loadQuoHistory(leadId) {
  const none = { available: false, items: [] };
  if (!leadId) return none;
  const items = [];
  let phoneTail = '';
  try {
    const leads = await sb('GET', `/leads?id=eq.${encodeURIComponent(leadId)}&select=phone&limit=1`);
    phoneTail = (Array.isArray(leads) && leads[0] && leads[0].phone ? String(leads[0].phone) : '').replace(/\D/g, '').slice(-10);
  } catch (_) { /* phone-matched sources just skip */ }

  try {
    const evts = await sb('GET', `/lead_events?lead_id=eq.${encodeURIComponent(leadId)}&event_type=eq.call&select=created_at,payload&order=created_at.desc&limit=10`);
    for (const e of (Array.isArray(evts) ? evts : [])) {
      items.push({ kind: 'call', at: e.created_at, detail: clip(JSON.stringify(e.payload || {}), 3000) });
    }
  } catch (_) { /* empty is the expected state; the sync has never returned live data */ }

  if (phoneTail) {
    const orFilter = `or=(from_number.like.*${phoneTail},to_number.like.*${phoneTail})`;
    try {
      const calls = await sb('GET', `/pec_call_log?${orFilter}&select=direction,occurred_at,duration_seconds,summary,next_steps,transcript&order=occurred_at.desc&limit=10`);
      for (const c of (Array.isArray(calls) ? calls : [])) {
        const turns = Array.isArray(c.transcript)
          ? c.transcript.map((t) => `${(t && (t.identifier || t.speaker || t.userId)) || 'speaker'}: ${(t && (t.content || t.text)) || ''}`).join('\n')
          : null;
        items.push({
          kind: 'call',
          at: c.occurred_at,
          direction: c.direction,
          duration_seconds: c.duration_seconds,
          summary: c.summary ? clip(c.summary, 1500) : null,
          next_steps: c.next_steps ? clip(c.next_steps, 500) : null,
          transcript: turns ? clip(turns, 4000) : null,
        });
      }
    } catch (_) { /* best effort */ }
    try {
      const texts = await sb('GET', `/pec_sms_log?${orFilter}&select=direction,created_at,body&order=created_at.desc&limit=50`);
      for (const t of (Array.isArray(texts) ? texts : [])) {
        items.push({ kind: 'text', at: t.created_at, direction: t.direction, body: clip(t.body, 800) });
      }
    } catch (_) { /* best effort */ }
  }

  return items.length ? { available: true, items } : none;
}

// Pull the model's prose out of a Messages API response.
// Do NOT assume content[0] is the text block: the API can return other block
// types (thinking, tool_use, redacted_thinking) FIRST, in which case
// content[0].text is undefined and any downstream JSON.parse dies on an empty
// string ("Unexpected end of JSON input", the live prod failure on
// 2026-07-11). Join every text block instead, and if there are none, throw an
// error that names what we actually got so the next reader is not guessing.
function textFromMessage(out) {
  const blocks = (out && Array.isArray(out.content)) ? out.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) {
    const types = blocks.map((b) => (b && b.type) || 'unknown').join(',') || 'none';
    throw new Error(`no text block in model response (stop_reason=${out && out.stop_reason}, blocks=[${types}])`);
  }
  return text;
}

// Strip accidental markdown fences and parse + validate the range.
function parseRecommendation(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const obj = JSON.parse(cleaned);
  const low = Number(obj.recommended_low);
  const high = Number(obj.recommended_high);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low) {
    throw new Error('recommendation missing a valid low/high range');
  }
  if (typeof obj.why !== 'string' || !obj.why.trim()) throw new Error('recommendation missing why');
  const intent = typeof obj.intent_read === 'string' && obj.intent_read.trim() ? obj.intent_read.trim() : null;
  return { recommended_low: Math.round(low), recommended_high: Math.round(high), why: obj.why.trim(), intent_read: intent };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { success: false, error: 'Method not allowed' });

  // Auth: staff JWT OR webhook secret (server-to-server), pec-lead-ai pattern.
  if (badSecret(event)) {
    const gate = await requireStaff(event);
    if (!gate.ok) return jc(gate.status, { success: false, error: gate.error });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { success: false, error: 'Invalid JSON' }); }

  // Per-line mode (prompt 70): body.lines = one entry per estimate line (see
  // production/ai-lines.cjs for the shape). The legacy single-recommendation
  // body (no lines) keeps working for any not-yet-refreshed PWA cache.
  const perLine = Array.isArray(body.lines) && body.lines.length > 0;
  const sqft = Number(body.sqft);
  const calcPrice = Number(body.calc_price);
  if (perLine) {
    for (const l of body.lines) {
      if (!l || typeof l.line_key !== 'string' || !l.line_key || !(Number(l.calc_price) > 0)) {
        return jc(400, { success: false, error: 'every line needs a line_key and a positive calc_price' });
      }
    }
  } else if (!body.system_type_name || !(sqft > 0) || !(calcPrice > 0)) {
    return jc(400, { success: false, error: 'system_type_name, sqft and calc_price are required' });
  }
  const inputsKey = String(body.inputs_key || '');
  const estimateId = body.estimate_id || null;

  try {
    // Settings gate (rule 12): estimate_ai_enabled kills the read cleanly
    // (success + disabled, so the client shows a quiet note, not an error);
    // comps_min_sample is the SAME knob the comps ladder uses, so the
    // confidence flag and the panel can never disagree about what "thin" is.
    // Missing rows fall back to the identical defaults the client uses.
    let aiEnabled = true;
    let minSample = MIN_COMPS_SAMPLE;
    try {
      const set = await sb('GET', '/settings?key=in.(estimate_ai_enabled,comps_min_sample)&select=key,value');
      const cfg = Object.fromEntries((set || []).map((r) => [r.key, r.value]));
      aiEnabled = String(cfg.estimate_ai_enabled || 'true') !== 'false';
      if (Number(cfg.comps_min_sample) > 0) minSample = Number(cfg.comps_min_sample);
    } catch (_) { /* defaults stand */ }
    if (!aiEnabled) return jc(200, { success: true, disabled: true });
    // Row cache: reopening a saved estimate with unchanged inputs never
    // re-bills a model call.
    let existingSnapshot = null;
    if (estimateId) {
      const rows = await sb('GET', `/estimates?id=eq.${encodeURIComponent(estimateId)}&select=pricing_snapshot&limit=1`);
      if (rows && rows.length) {
        existingSnapshot = rows[0].pricing_snapshot || null;
        if (
          existingSnapshot && existingSnapshot.ai && inputsKey &&
          existingSnapshot.inputs_key === inputsKey
        ) {
          return jc(200, { success: true, cached: true, recommendation: existingSnapshot.ai });
        }
      }
    }

    if (!ANTHROPIC_API_KEY) return jc(503, { success: false, error: 'ANTHROPIC_API_KEY not configured' });

    // Quo history as intent signal (best-effort; empty is normal and honest).
    const history = await loadQuoHistory(body.lead_id || null).catch(() => ({ available: false, items: [] }));

    // 25s abort, one second under Netlify's 26s kill, so a slow model returns
    // a clean 500 instead of a lambda timeout (pec-metrics-ai pattern).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    let out;
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          // Per-line responses carry one why per line; size accordingly.
          max_tokens: perLine ? 2500 : 1000,
          system: perLine ? LINES_SYSTEM_PROMPT : SYSTEM_PROMPT,
          messages: [{ role: 'user', content: perLine ? buildLinesUserPrompt(body, history) : buildUserPrompt(body, history) }],
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
      }
      out = await res.json();
    } finally {
      clearTimeout(timer);
    }

    // Per-line: validate every sent line came back, stamp the SERVER-computed
    // confidence per line, and derive the roll-up range as the sum of the
    // line ranges (finalizeLinesRecommendation). The top-level keys keep the
    // legacy shape (recommended_low/high, why) so the dashboard's snapshot
    // panel renders either vintage.
    const recommendation = perLine
      ? finalizeLinesRecommendation(parseLinesRecommendation(textFromMessage(out), body.lines), body.lines, minSample)
      : parseRecommendation(textFromMessage(out));
    // history_available is a SERVER fact, never a model claim, and with no
    // history the intent read is forced null so silence can never become
    // invented intent no matter what the model returned.
    recommendation.history_available = history.available;
    if (!history.available) recommendation.intent_read = null;
    recommendation.model = MODEL;
    recommendation.generated_at = new Date().toISOString();
    recommendation.inputs_key = inputsKey || null;

    // Refresh the row cache best-effort. Merge (never replace) the snapshot:
    // the client's save owns the full shape; this only keeps ai/inputs_key/
    // comps current so the next reopen is a cache hit. A PATCH failure never
    // fails the response; the rep still gets the read.
    if (estimateId) {
      try {
        await sb('PATCH', `/estimates?id=eq.${encodeURIComponent(estimateId)}`, {
          pricing_snapshot: {
            ...(existingSnapshot || {}),
            inputs_key: inputsKey || null,
            comps: body.comps || (existingSnapshot && existingSnapshot.comps) || null,
            ai: recommendation,
          },
        });
      } catch (patchErr) {
        console.warn('pec-estimate-ai cache write failed (non-fatal):', patchErr && patchErr.message);
      }
    }

    return jc(200, { success: true, cached: false, recommendation });
  } catch (err) {
    console.error('pec-estimate-ai failed:', err);
    return jc(500, { success: false, error: 'Recommendation failed', detail: err && err.message });
  }
};
