// Polish for a CUSTOM estimate's typed scope (build 24). Dylan types the
// scope of a one-off job in his own words in the estimator; this cleans that
// text into proposal-ready language. This is POLISH, NOT AUTHORSHIP (same
// discipline as pec-estimate-scope.cjs): the model fixes grammar, structure,
// and formatting only. It must preserve his meaning, every exclusion, and
// every dollar figure verbatim, and may never invent scope, warranties, or
// cure-time claims. The exclusions he types are what protect him in a
// dispute; a model that "improves" them will eventually soften the one
// clause that mattered.
//
// POST /.netlify/functions/pec-estimate-custom-polish
// Body: { text }  ->  { success: true, polished }
//
// Pure text in, text out: no estimate row is read or written. The estimator
// keeps the original in memory and offers an undo, and nothing persists
// until Dylan saves, so the never-overwrite guarantees live client-side
// here. The button never fires automatically.
//
// Auth + text extraction follow pec-estimate-ai.cjs / pec-estimate-scope.cjs
// (textFromMessage carries the lesson from commit 613245a: NEVER index
// content[0].text; filter for text blocks and join).
//
// Env: ANTHROPIC_API_KEY (shared), optional PEC_SCOPE_AI_MODEL.

const { badSecret, requireStaff } = require('./_pec-supabase.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.PEC_SCOPE_AI_MODEL || 'claude-sonnet-5';

// A typed scope is at most a few pages; anything bigger is a paste mistake,
// and capping it bounds the model bill.
const MAX_TEXT_CHARS = 20000;

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

const SYSTEM_PROMPT = `You polish a contractor's hand-typed scope-of-work text into clean, proposal-ready language for Prescott Epoxy Company. Your job is POLISH, not authorship.

Rules, in order of importance:
1. Preserve the writer's meaning exactly. Every statement of what IS included, what is NOT included, and every exclusion or limitation must survive with its meaning intact. Keep the substance of every exclusion; you may fix its grammar but never weaken, generalize, or drop it.
2. Keep every dollar figure, quantity, measurement, and date VERBATIM, character for character.
3. You may fix spelling, grammar, punctuation, and capitalization; break run-ons into sentences; group related items; and add simple structure (short paragraphs or a markdown bullet list) when it makes the scope easier to read.
4. You may NOT add scope, work steps, materials, warranties, guarantees, or cure-time / dry-time claims that the writer did not type. You may NOT soften or remove anything the writer typed. If the text seems incomplete, leave it incomplete.
5. Write in plain professional language a customer will read. No em dashes. No marketing fluff.

Respond with ONLY the polished text. No preamble, no commentary, no code fences.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { success: false, error: 'Method not allowed' });

  if (badSecret(event)) {
    const gate = await requireStaff(event);
    if (!gate.ok) return jc(gate.status, { success: false, error: gate.error });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { success: false, error: 'Invalid JSON' }); }
  const text = String(body.text || '').trim();
  if (!text) return jc(400, { success: false, error: 'text is required' });
  if (text.length > MAX_TEXT_CHARS) {
    return jc(400, { success: false, error: `text is too long (${text.length} chars, max ${MAX_TEXT_CHARS})` });
  }

  if (!ANTHROPIC_API_KEY) return jc(503, { success: false, error: 'ANTHROPIC_API_KEY not configured' });

  try {
    // 25s abort, one second under Netlify's 26s kill (pec-metrics-ai pattern).
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
          max_tokens: 4000,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `Polish this scope-of-work text:\n\n${text}` }],
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 500)}`);
      }
      out = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const polished = textFromMessage(out);
    return jc(200, { success: true, polished, model: MODEL });
  } catch (err) {
    console.error('pec-estimate-custom-polish failed:', err);
    return jc(500, { success: false, error: 'Polish failed', detail: err && err.message });
  }
};
