// Prompt 70: per-line AI price recommendation logic, shared between the
// estimator PWA (payload + inputs key) and pec-estimate-ai.cjs (prompt,
// parse, and the SERVER-computed confidence flag). CJS on purpose, the
// scope.cjs / estimate-draft.cjs pattern: the Netlify function requires it
// and Vite bundles it, so the fixture tests drive the exact logic both run.
//
// The LINE payload shape (client -> server), one entry per estimate line, in
// line order:
//   { line_key, kind: 'calc' | 'custom', label,
//     system_type_id (calc; for the key), system_type_name (calc; for the
//     model), sqft (calc, or typed custom sqft or null), mvb (calc boolean),
//     calc_price (calc: the line's solved price; custom: the typed price),
//     target_gp_pct (calc), scope_text (custom: the typed scope, verbatim),
//     comps: { rule, rule_label, sample_size, median_ppsf, rows[] } | null }
// Custom lines carry comps: null BY DEFINITION: there is no system to
// hard-filter on, so no comparable set exists (prompt 70 locked scope).
//
// CONFIDENCE IS A SERVER FACT, NEVER MODEL-CLAIMED (the history_available
// pattern): it is computed here from the comps sample the client sent, which
// the same canonical production/comps.js produced, and stamped onto each line
// AFTER the model responds, overwriting anything the model said.

const MIN_COMPS_SAMPLE = 3;

// comps_backed: >= minSample same-system comps (the hard filter means every
// comp IS same-system now). thin_sample: 1..minSample-1. no_comps: zero, or
// no comps object at all (every custom line).
function lineConfidence(comps, minSample = MIN_COMPS_SAMPLE) {
  const n = comps && Number(comps.sample_size) > 0 ? Number(comps.sample_size) : 0;
  const min = Number(minSample) > 0 ? Number(minSample) : MIN_COMPS_SAMPLE;
  if (n <= 0) return 'no_comps';
  return n >= min ? 'comps_backed' : 'thin_sample';
}

const CONFIDENCE_LABELS = {
  comps_backed: 'Comps-backed',
  thin_sample: 'Thin sample',
  no_comps: 'No comps',
};

// Cheap, deterministic hash for a custom line's typed scope (djb2, base36).
// Only used inside the inputs key, so reopening an estimate with an unchanged
// scope is a cache hit and an edited scope re-reads.
function scopeHash(text) {
  const s = String(text == null ? '' : text);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// The estimate-level inputs key: the join of per-line keys, order-sensitive
// (line order is part of the estimate's shape). Cheaply hashable per line by
// construction (the prompt-69 seam). A calc line keys on what DRIVES its
// solved price (system + sqft + mvb); a custom line keys on the typed price
// and the typed scope, because both drive its recommendation.
function linesInputsKey(lines) {
  return (Array.isArray(lines) ? lines : []).map((l, i) => {
    if (l && l.kind === 'custom') {
      return `${i}:custom:${Math.round(Number(l.calc_price) || 0)}:${scopeHash(l.scope_text)}`;
    }
    const sqft = Math.round(Number(l && l.sqft) || 0);
    return `${i}:calc:${(l && l.system_type_id) || ''}:${sqft}:${l && l.mvb ? 1 : 0}`;
  }).join('|');
}

// System prompt for the per-line read. Same non-negotiables as the job-level
// prompt (ground every claim, never set the price) plus the per-line rules.
const LINES_SYSTEM_PROMPT = `You are the pricing analyst for Prescott Epoxy Company (PEC), a residential and commercial epoxy floor coating company in Prescott, Arizona. You review ONE in-progress estimate at a time, LINE BY LINE, against the company's own completed comparable jobs and its cost-plus calculator prices, then recommend a sell range PER LINE plus a short job-level roll-up. Rules you must follow:
- Ground every claim in the numbers provided for THAT line. Never invent jobs, market data, or confidence you do not have. Never mix one line's comps into another line's reasoning.
- Every line's comps are SAME-SYSTEM ONLY (a hard filter). When a line's comps sample is empty, say plainly that you are pricing that line WITHOUT comparables and lean on its calculator price and target margin only.
- A CUSTOM line (kind "custom") has NO comparables by definition. Reason from its typed scope of work and its typed price; your why for a custom line MUST state explicitly that no comparable jobs exist for it.
- If a line's comps sample is small or was widened to any-size (the rule label says so), name that limitation in that line's why.
- Each calculator line's price is engineered to hit its own target gross profit; recommending below it means recommending margin give-up, so justify it or do not do it.
- COMMUNICATION HISTORY, when present, is intent signal only (urgency, budget language, competing quotes, timeline, who decides). Every intent claim MUST include a short verbatim quote from a transcript or text. When the history section says there is none, set intent_read to null and draw NO conclusions from the silence.
- You NEVER set a price; the salesperson decides.
Respond with ONLY a JSON object, no markdown fences, exactly these keys:
{
  "lines": [ { "line_key": "<exactly as given>", "recommended_low": <integer dollars>, "recommended_high": <integer dollars>, "why": "2-4 sentences for THIS line against ITS comps' $/sqft, ITS calculator price, and ITS target GP, with any sample-size caveat" } ],
  "rollup_why": "one short paragraph (2-4 sentences) on the whole estimate: how the lines sit together, the biggest pricing risk or opportunity, and any line worth a second look",
  "intent_read": "2-4 sentences on the customer's intent, each claim backed by a verbatim quote" OR null when there is no communication history
}
Return exactly one entry for every line you were given, in the same order.`;

// Per-line user prompt. Comps rows are capped and stripped to numbers (the
// client already removed customer names before the payload left the browser).
function buildLinesUserPrompt(body, history) {
  const out = [];
  out.push('ESTIMATE IN PROGRESS (totals):');
  out.push(JSON.stringify({
    total_calculated_price: body.calc_price,
    total_sqft: body.sqft,
    line_count: (body.lines || []).length,
  }));
  out.push('');
  out.push('LINES (recommend a sell range for EACH, keyed by line_key):');
  for (const l of body.lines || []) {
    const c = l.comps || null;
    out.push(JSON.stringify({
      line_key: l.line_key,
      kind: l.kind,
      label: l.label,
      system: l.kind === 'custom' ? null : l.system_type_name,
      sqft: l.sqft != null ? l.sqft : null,
      mvb: l.kind === 'custom' ? undefined : !!l.mvb,
      calculator_price: l.calc_price,
      calculator_price_per_sqft: Number(l.sqft) > 0 && Number(l.calc_price) > 0
        ? Number((l.calc_price / l.sqft).toFixed(2)) : null,
      target_gp_pct: l.target_gp_pct != null ? l.target_gp_pct : null,
      typed_scope_of_work: l.kind === 'custom' ? String(l.scope_text || '').slice(0, 2000) : undefined,
      comps: l.kind === 'custom' || !c
        ? 'NONE. No comparable jobs exist for this line.'
        : {
            selection_rule: c.rule_label || c.rule || 'none',
            sample_size: c.sample_size || 0,
            median_price_per_sqft: c.median_ppsf != null ? Number(Number(c.median_ppsf).toFixed(2)) : null,
            jobs: (Array.isArray(c.rows) ? c.rows : []).slice(0, 20).map((r) => ({
              sqft: r.sqft, price: r.price,
              ppsf: r.ppsf != null ? Number(Number(r.ppsf).toFixed(2)) : null,
              actual_gp_pct: r.gp_pct != null ? Number((Number(r.gp_pct) * 100).toFixed(1)) : null,
            })),
          },
    }));
  }
  out.push('');
  if (history && history.available) {
    out.push('COMMUNICATION HISTORY (Quo calls and texts with this customer, newest first):');
    out.push(JSON.stringify(history.items));
  } else {
    out.push('COMMUNICATION HISTORY: none. NO CALL OR TEXT HISTORY IS ON FILE for this customer. Set intent_read to null and infer nothing from the silence.');
  }
  return out.join('\n');
}

// Parse + validate the model's per-line response against the lines that were
// SENT: every line_key must come back with a valid range and a why; a
// wandering or missing key throws (the pec-estimate-scope "model omitted
// scope" posture), so a partial answer can never render as a full one.
function parseLinesRecommendation(text, sentLines) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const obj = JSON.parse(cleaned);
  const byKey = new Map();
  for (const l of (Array.isArray(obj.lines) ? obj.lines : [])) {
    if (l && typeof l.line_key === 'string') byKey.set(l.line_key, l);
  }
  const lines = (sentLines || []).map((sent) => {
    const got = byKey.get(sent.line_key);
    if (!got) throw new Error(`model omitted line "${sent.label || sent.line_key}"`);
    const low = Number(got.recommended_low);
    const high = Number(got.recommended_high);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low) {
      throw new Error(`line "${sent.label || sent.line_key}" missing a valid low/high range`);
    }
    if (typeof got.why !== 'string' || !got.why.trim()) {
      throw new Error(`line "${sent.label || sent.line_key}" missing why`);
    }
    return {
      line_key: sent.line_key,
      label: sent.label || null,
      kind: sent.kind === 'custom' ? 'custom' : 'calc',
      recommended_low: Math.round(low),
      recommended_high: Math.round(high),
      why: got.why.trim(),
    };
  });
  if (typeof obj.rollup_why !== 'string' || !obj.rollup_why.trim()) {
    throw new Error('recommendation missing rollup_why');
  }
  const intent = typeof obj.intent_read === 'string' && obj.intent_read.trim() ? obj.intent_read.trim() : null;
  return { lines, rollup_why: obj.rollup_why.trim(), intent_read: intent };
}

// Finalize: stamp the SERVER-computed confidence per line (from the comps
// payload the client sent, never from the model), enforce the custom-line
// no-comparables statement deterministically (the model is instructed to say
// it; this guarantees it), and derive the job-level range as the SUM of the
// line ranges so the roll-up numbers can never drift from the lines.
const NO_COMPS_STATEMENT = 'No comparable completed jobs exist for this custom line.';
function finalizeLinesRecommendation(parsed, sentLines, minSample = MIN_COMPS_SAMPLE) {
  const sentByKey = new Map((sentLines || []).map((l) => [l.line_key, l]));
  const lines = parsed.lines.map((l) => {
    const sent = sentByKey.get(l.line_key) || {};
    const confidence = l.kind === 'custom' ? 'no_comps' : lineConfidence(sent.comps, minSample);
    let why = l.why;
    if (l.kind === 'custom' && !/comparab|no comps|without comps/i.test(why)) {
      why = `${NO_COMPS_STATEMENT} ${why}`;
    }
    return { ...l, why, confidence, confidence_label: CONFIDENCE_LABELS[confidence] };
  });
  return {
    recommended_low: lines.reduce((s, l) => s + l.recommended_low, 0),
    recommended_high: lines.reduce((s, l) => s + l.recommended_high, 0),
    why: parsed.rollup_why,
    lines,
    intent_read: parsed.intent_read,
  };
}

module.exports = {
  MIN_COMPS_SAMPLE,
  CONFIDENCE_LABELS,
  NO_COMPS_STATEMENT,
  LINES_SYSTEM_PROMPT,
  lineConfidence,
  scopeHash,
  linesInputsKey,
  buildLinesUserPrompt,
  parseLinesRecommendation,
  finalizeLinesRecommendation,
};
