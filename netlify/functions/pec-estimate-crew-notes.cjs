// Crew-notes draft for an estimate (prompt 32, Part B). The estimator's
// "Generate from proposal" button sends the estimate's assembled scope (or the
// custom typed scope) plus the site facts already on the estimate; this drafts
// a SHORT internal crew brief in two labeled parts: "Cliff notes" (what the
// job is) and "Watch out for" (access, prep, site conditions, customer asks).
//
// This is a SUMMARY, so unlike the customer scope (pec-estimate-scope.cjs's
// verbatim-template discipline) it MAY condense and rephrase. The line it may
// never cross is INVENTION: no facts, warranties, cure times, or numbers that
// are not in the input. Absent facts are left out, not guessed.
//
// The draft is internal-only: the estimator prints it on the crew work order
// and nowhere customer-facing. Nothing persists here; the estimator keeps the
// pre-generate text for undo and only saves on Dylan's explicit Save (same
// client-side never-overwrite shape as pec-estimate-custom-polish.cjs).
//
// POST /.netlify/functions/pec-estimate-crew-notes
// Body: { scope, facts }  ->  { success: true, notes }
//   scope: the assembled proposal / typed custom scope text (string)
//   facts: flat object of site facts (gate code, moisture, mohs, stem walls,
//          coat past garage, non-slip, special notes, add-ons, sqft, system)
//
// Auth + textFromMessage follow pec-estimate-ai.cjs / pec-estimate-scope.cjs
// (textFromMessage carries the lesson from commit 613245a: NEVER index
// content[0].text; filter for text blocks and join).
//
// Env: ANTHROPIC_API_KEY (shared), optional PEC_SCOPE_AI_MODEL.

const { badSecret } = require('./_pec-supabase.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.PEC_SCOPE_AI_MODEL || 'claude-sonnet-5';

// A proposal is at most a few pages; anything bigger is a paste mistake, and
// capping it bounds the model bill (same cap as custom-polish).
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

// Render the facts object as labeled lines, skipping anything absent, so the
// model only ever sees facts that exist (an empty fact it cannot see is a
// fact it cannot invent around).
function factsBlock(facts) {
  if (!facts || typeof facts !== 'object') return '';
  const lines = [];
  for (const [key, value] of Object.entries(facts)) {
    if (value == null) continue;
    const s = String(value).trim();
    if (!s || s === 'null' || s === 'undefined') continue;
    lines.push(`- ${key}: ${s.slice(0, 500)}`);
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You write a SHORT internal crew brief for Prescott Epoxy Company's install crew, from an estimate's proposal text and site facts. The crew reads this on a printed work order; the customer never sees it.

Output EXACTLY two labeled sections, nothing else:

Cliff notes:
- 2-5 tight bullet lines: what the job is (system, areas, sqft, key inclusions/exclusions).

Watch out for:
- 1-6 tight bullet lines: access (gate codes), prep (moisture, MOHS, grinding), site conditions, customer-specific asks, exclusions the crew must respect, anything unusual.

Rules, in order of importance:
1. NEVER invent. Every statement must come from the provided proposal text or facts. No warranties, cure times, dry times, products, prices, or numbers that are not in the input. If a fact is absent, leave it out; never guess or write "unknown".
2. You are summarizing for the crew, so you MAY condense, rephrase, and drop customer-facing pleasantries. Keep exclusions and limitations: the crew must know what NOT to do.
3. Tight bullet-style lines, not paragraphs. Plain shop language. Short.
4. If there is genuinely nothing for a section, write the section header with a single line: "- Nothing flagged."

Respond with ONLY the two sections. No preamble, no commentary, no code fences.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { success: false, error: 'Method not allowed' });

  if (badSecret(event)) {
    const auth = event.headers.authorization || event.headers.Authorization || '';
    const user = await getUser(auth.replace(/^Bearer\s+/i, ''));
    if (!user || !user.id) return jc(401, { success: false, error: 'Not authorized' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { success: false, error: 'Invalid JSON' }); }
  const scope = String(body.scope || '').trim();
  const facts = factsBlock(body.facts);
  if (!scope && !facts) return jc(400, { success: false, error: 'Nothing to summarize: scope or facts required' });
  if (scope.length > MAX_TEXT_CHARS) {
    return jc(400, { success: false, error: `scope is too long (${scope.length} chars, max ${MAX_TEXT_CHARS})` });
  }

  if (!ANTHROPIC_API_KEY) return jc(503, { success: false, error: 'ANTHROPIC_API_KEY not configured' });

  try {
    // 25s abort, one second under Netlify's 26s kill (pec-metrics-ai pattern).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    let out;
    try {
      const userMsg = [
        scope ? `PROPOSAL / SCOPE TEXT:\n\n${scope}` : null,
        facts ? `SITE FACTS:\n\n${facts}` : null,
      ].filter(Boolean).join('\n\n---\n\n');
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
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `Write the crew brief from this estimate:\n\n${userMsg}` }],
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

    const notes = textFromMessage(out);
    return jc(200, { success: true, notes, model: MODEL });
  } catch (err) {
    console.error('pec-estimate-crew-notes failed:', err);
    return jc(500, { success: false, error: 'Crew notes draft failed', detail: err && err.message });
  }
};
