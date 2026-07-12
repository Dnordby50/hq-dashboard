// AI price recommendation for one estimate-in-progress. Called by the
// estimator PWA automatically (debounced client-side) once system type and
// sqft are both present.
//
// POST /.netlify/functions/pec-estimate-ai
// Body: { estimate_id (nullable), inputs_key, system_type_name, sqft, mvb,
//         calc_price, target_gp_pct,
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
// Caching: when estimate_id is present (reopening a saved estimate), a stored
// pricing_snapshot whose inputs_key matches is served without a model call, so
// reopening never re-bills. A fresh result is merged back onto the row. The
// pre-save flow (no estimate_id yet) is cached client-side and persisted by the
// estimator's save.
//
// Env: ANTHROPIC_API_KEY (shared), optional PEC_ESTIMATE_AI_MODEL.

const { sb, badSecret } = require('./_pec-supabase.cjs');

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
- You NEVER set the price; the salesperson decides.
Respond with ONLY a JSON object, no markdown fences, exactly these keys:
{
  "recommended_low": <integer dollars, bottom of the sell range>,
  "recommended_high": <integer dollars, top of the sell range>,
  "why": "one short paragraph (3-5 sentences) explaining the range against the comps' $/sqft, the calculator price, and the target GP, including any sample-size caveat"
}`;

function buildUserPrompt(b) {
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
  return lines.join('\n');
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
  return { recommended_low: Math.round(low), recommended_high: Math.round(high), why: obj.why.trim() };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { success: false, error: 'Method not allowed' });

  // Auth: staff JWT OR webhook secret (server-to-server), pec-lead-ai pattern.
  if (badSecret(event)) {
    const auth = event.headers.authorization || event.headers.Authorization || '';
    const user = await getUser(auth.replace(/^Bearer\s+/i, ''));
    if (!user || !user.id) return jc(401, { success: false, error: 'Not authorized' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { success: false, error: 'Invalid JSON' }); }

  const sqft = Number(body.sqft);
  const calcPrice = Number(body.calc_price);
  if (!body.system_type_name || !(sqft > 0) || !(calcPrice > 0)) {
    return jc(400, { success: false, error: 'system_type_name, sqft and calc_price are required' });
  }
  const inputsKey = String(body.inputs_key || '');
  const estimateId = body.estimate_id || null;

  try {
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
          max_tokens: 1000,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildUserPrompt(body) }],
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

    const recommendation = parseRecommendation(textFromMessage(out));
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
