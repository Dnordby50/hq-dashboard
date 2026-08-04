// AI scope writer for one estimate: assembles the customer-facing scope of
// work from Dylan's VERBATIM DripJobs templates (pec_prod_system_types.
// scope_template / scope_template_mvb) and the add-on catalog's scope_snippet
// paragraphs, substituting THIS estimate's facts (sqft, area names, stem
// walls, coat-past-garage, flake color). The model's job is ASSEMBLY AND
// SUBSTITUTION, NOT AUTHORSHIP: the exclusions and cure-time warnings in
// those templates are what protect Dylan in a dispute, and a model that
// rewrites them freehand will eventually soften the one clause that mattered.
//
// POST /.netlify/functions/pec-estimate-scope
// Body: { estimate_id, force? }
//
// THE NEVER-OVERWRITE RULE (enforced HERE, not just in the UI): once a human
// has edited the scope (estimates.scope_edited_at non-null), this function
// refuses to regenerate without force=true. force is only sent by the
// estimate page's Regenerate button after its explicit "this will replace
// your edited text" confirmation. A successful regenerate clears
// scope_edited_at (the text is machine-written again) and scope_stale.
//
// Writes: estimate_line_items.description per targeted line (so the customer
// page can show the scope under each line, DripJobs-proposal style) and the
// assembled markdown document onto estimates.scope_of_work (reused column;
// the accept path already copies it to jobs.scope). Markdown in, ESCAPED out:
// every renderer of this text must escape or sanitize it, never raw-HTML it.
//
// Auth, timeout, and text extraction follow pec-estimate-ai.cjs (which itself
// carries the textFromMessage lesson from commit 613245a: NEVER index
// content[0].text; filter for text blocks and join).
//
// Env: ANTHROPIC_API_KEY (shared), optional PEC_SCOPE_AI_MODEL.

const { sb, badSecret, requireStaff } = require('./_pec-supabase.cjs');
// Canonical BLANK-placeholder logic, shared with the estimator so keys match.
const { applyAnswers, openQuestions, containsBlank } = require('../../production/scope.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.PEC_SCOPE_AI_MODEL || 'claude-sonnet-5';

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

// Pull the model's prose out of a Messages API response. Do NOT assume
// content[0] is the text block (thinking/tool_use can lead the array; that
// exact assumption silently broke the lead AI in prod, fixed in 613245a).
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

// The system prompt states the job in the terms Dylan locked: source of
// truth, verbatim exclusions, resolve-from-data, leave placeholders when the
// data does not say, no invention, no softening, no warranty additions.
const SYSTEM_PROMPT = `You assemble customer-facing scope-of-work documents for Prescott Epoxy Company from the company's own contract templates. Your job is ASSEMBLY AND SUBSTITUTION, not authorship.

Rules, in order of importance:
1. The templates are the source of truth. Keep every exclusion, cure-time warning, and payment term VERBATIM. Do not reword, reorder, tidy, or "improve" template language.
2. Resolve the "is/is not included" placeholders from the estimate's actual data, which is given to you as explicit facts. Example: when the facts say stem walls are included, the line "Stem walls are/are not included" becomes "Stem walls are included"; when they say not included, it becomes "Stem walls are not included". Same for "Concrete past garage door is/is not  included".
3. Fill in the square footage, the flake color, the area names, and the expected project duration where the template has a slot for them and the facts provide a value.
4. When the data does not say, LEAVE THE PLACEHOLDER exactly as it is in the template rather than guessing. That includes "BLANK", empty "Tentative start date:" lines, and any is/is-not line whose fact is not provided.
5. You may NOT invent scope, may NOT soften an exclusion, and may NOT add a warranty term.
6. A line item may carry "internal_notes": the salesperson's private context for that line. Treat it as additional FACTS for resolving that line's placeholders and is/is-not choices ONLY. Never quote or paraphrase internal_notes into the scope text, never let it add scope beyond what the template provides, and never let it override rule 1 or rule 5.

You receive one template (or snippet) per line item plus the estimate facts. Respond with ONLY a JSON object, no markdown fences:
{
  "lines": [ { "line_item_id": "<id exactly as given>", "scope": "<the assembled text for that line, markdown allowed>" } ]
}
Return exactly one entry for every line item you were given, in the same order.`;

function loadOne(rows) { return Array.isArray(rows) && rows.length ? rows[0] : null; }

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
  const estimateId = String(body.estimate_id || '').trim();
  if (!estimateId) return jc(400, { success: false, error: 'estimate_id is required' });
  const force = body.force === true;

  try {
    const est = loadOne(await sb('GET',
      `/estimates?id=eq.${encodeURIComponent(estimateId)}&deleted_at=is.null&select=id,mvb,flake_color,intake,scope_of_work,scope_edited_at,scope_answers,estimate_number&limit=1`));
    if (!est) return jc(404, { success: false, error: 'Estimate not found' });
    const scopeAnswers = (est.scope_answers && typeof est.scope_answers === 'object') ? est.scope_answers : {};

    // The never-overwrite rule: a human's words are never lost without a click.
    if (est.scope_edited_at && !force) {
      return jc(409, {
        success: false,
        needs_confirm: true,
        error: 'The scope was edited by hand. Regenerating will replace the edited text; confirm with force=true.',
      });
    }

    const [areas, lines] = await Promise.all([
      sb('GET', `/estimate_areas?estimate_id=eq.${encodeURIComponent(estimateId)}&select=id,name,sqft,system_type_id,mvb,sort_order,is_custom,custom_scope,notes&order=sort_order.asc`),
      sb('GET', `/estimate_line_items?estimate_id=eq.${encodeURIComponent(estimateId)}&select=id,addon_id,estimate_area_id,label,description,is_optional,selected_by_customer,sort_order&order=sort_order.asc`),
    ]);
    if (!Array.isArray(lines) || !lines.length) {
      return jc(200, { success: true, generated: false, reason: 'This estimate has no line items to write scope for.' });
    }

    const systemIds = [...new Set((areas || []).map((a) => a.system_type_id).filter(Boolean))];
    const systems = systemIds.length
      ? await sb('GET', `/pec_prod_system_types?id=in.(${systemIds.map(encodeURIComponent).join(',')})&select=id,name,scope_template,scope_template_mvb`)
      : [];
    const systemById = new Map((systems || []).map((s) => [s.id, s]));
    const areaById = new Map((areas || []).map((a) => [a.id, a]));

    const addonIds = [...new Set(lines.map((li) => li.addon_id).filter(Boolean))];
    const addons = addonIds.length
      ? await sb('GET', `/pec_prod_addons?id=in.(${addonIds.map(encodeURIComponent).join(',')})&select=id,name,scope_snippet`)
      : [];
    const addonById = new Map((addons || []).map((a) => [a.id, a]));

    // ---- The estimate FACTS the model substitutes from. Stem walls count as
    // included when the intake says so OR a live (non-optional or customer-
    // selected) Stem Walls add-on line is on the estimate.
    const intake = est.intake || {};
    const stemWallsViaAddon = lines.some((li) => {
      const ad = li.addon_id ? addonById.get(li.addon_id) : null;
      if (!ad || !/^stem walls$/i.test(String(ad.name || ''))) return false;
      return !li.is_optional || li.selected_by_customer === true;
    });
    const facts = {
      total_sqft: (areas || []).reduce((s, a) => s + (Number(a.sqft) > 0 ? Number(a.sqft) : 0), 0),
      stem_walls_included: intake.stem_walls === true || stemWallsViaAddon,
      concrete_past_garage_included: intake.coat_past_garage === true,
      flake_color: est.flake_color || null, // null = not chosen yet: leave any color slot alone
      // MVB is per-area now (build 17); the fact lists which areas carry one.
      moisture_vapor_barrier_areas: (areas || []).filter((a) => a.mvb === true).map((a) => a.name),
      areas: (areas || []).map((a) => ({ name: a.name, sqft: Number(a.sqft) || 0, mvb: a.mvb === true })),
    };

    // ---- Which lines get model-assembled scope:
    //   area lines  -> their area's system's template (the MVB variant when
    //                  the estimate carries a moisture barrier, because that
    //                  template is the 3-day MVB language)
    //   add-on lines-> the catalog scope_snippet (skipped when empty; Drive
    //                  Time and Upgraded Flake Color ship without language)
    //   one-offs    -> keep the rep's own description, never model-written
    //   MVB-only    -> no template describes a barrier-only job; skipped
    // Each target carries its RAW template (with any literal BLANK) under a
    // contextLabel (system or add-on name), used to detect BLANK questions with
    // keys that match the estimator's. The `template` sent to the model has the
    // rep's answers already substituted (applyAnswers), so an answered BLANK is
    // gone and an unanswered one stays verbatim (the model leaves it, per the
    // system prompt, and it trips the send warning).
    const targets = [];
    const skipped = [];
    const blankSources = []; // { text: rawTemplate, contextLabel } for open-question detection
    for (const li of lines) {
      if (li.estimate_area_id) {
        const area = areaById.get(li.estimate_area_id);
        // A CUSTOM line (prompt 69): the rep's typed scope is used VERBATIM
        // as this line's description (the save already wrote it there). The
        // writer must never rewrite it; only the explicit Polish button
        // touches custom text, and only when the rep presses it.
        if (area && area.is_custom === true) {
          skipped.push({ id: li.id, label: li.label, reason: 'custom line; typed scope used verbatim' });
          continue;
        }
        const sys = area ? systemById.get(area.system_type_id) : null;
        // Per-line MVB template (build 17): the MVB variant when THIS AREA has a
        // moisture barrier, else the standard template. Mirrors the estimator's
        // per-area choice so client and server agree.
        const rawTemplate = sys
          ? ((area && area.mvb === true && sys.scope_template_mvb) ? sys.scope_template_mvb : sys.scope_template)
          : null;
        if (rawTemplate) {
          const contextLabel = sys ? sys.name : null;
          blankSources.push({ text: rawTemplate, contextLabel });
          targets.push({
            line_item_id: li.id,
            label: li.label,
            kind: 'system',
            area: area ? { name: area.name, sqft: Number(area.sqft) || 0 } : null,
            system_name: sys ? sys.name : null,
            template: applyAnswers(rawTemplate, scopeAnswers, contextLabel),
            // Per-line INTERNAL notes (prompt 69): extra facts for THIS
            // line's substitution only. Constrained by the system prompt:
            // never quoted verbatim, never new scope.
            internal_notes: area && area.notes && String(area.notes).trim() ? String(area.notes).trim() : null,
          });
        } else {
          skipped.push({ id: li.id, label: li.label, reason: sys ? `no scope template on system "${sys.name}"` : 'area has no system' });
        }
        continue;
      }
      if (li.addon_id) {
        const ad = addonById.get(li.addon_id);
        const snippet = ad && ad.scope_snippet && String(ad.scope_snippet).trim();
        if (snippet) {
          const contextLabel = ad.name;
          blankSources.push({ text: snippet, contextLabel });
          targets.push({ line_item_id: li.id, label: li.label, kind: 'addon', template: applyAnswers(snippet, scopeAnswers, contextLabel) });
        } else {
          skipped.push({ id: li.id, label: li.label, reason: 'add-on has no scope snippet yet' });
        }
        continue;
      }
      // One-off or the standalone-MVB line: the rep's words stand.
      skipped.push({ id: li.id, label: li.label, reason: 'one-off or MVB-only line; keeps its own description' });
    }

    // Open BLANK questions (still unanswered), written to the estimate so the
    // page's "Finish the scope" card lists them without loading templates.
    const openBlanks = openQuestions(blankSources, scopeAnswers);

    if (!targets.length) {
      return jc(200, {
        success: true,
        generated: false,
        reason: 'No scope templates or snippets apply to the lines on this estimate.',
        skipped,
      });
    }

    if (!ANTHROPIC_API_KEY) return jc(503, { success: false, error: 'ANTHROPIC_API_KEY not configured' });

    const userPrompt = [
      'ESTIMATE FACTS (substitute from these; anything not stated here is NOT known):',
      JSON.stringify(facts, null, 2),
      '',
      'LINE ITEMS TO ASSEMBLE (one scope per line item, from its template/snippet):',
      JSON.stringify(targets, null, 2),
    ].join('\n');

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
          max_tokens: 8000, // several verbatim templates can be a few KB each
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
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

    const raw = textFromMessage(out).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error(`model returned unparseable JSON (stop_reason=${out.stop_reason}): ${String(e.message)}`); }
    const returned = new Map();
    for (const l of (Array.isArray(parsed.lines) ? parsed.lines : [])) {
      if (l && typeof l.line_item_id === 'string' && typeof l.scope === 'string' && l.scope.trim()) {
        returned.set(l.line_item_id, l.scope.trim());
      }
    }
    const missing = targets.filter((t) => !returned.has(t.line_item_id));
    if (missing.length) {
      throw new Error(`model omitted scope for ${missing.length} line(s): ${missing.map((m) => m.label).join('; ')}`);
    }

    // ---- Write per-line descriptions (only the targeted ids; a wandering id
    // from the model can never touch another estimate's rows because every
    // PATCH is scoped to estimate_id too).
    for (const t of targets) {
      await sb('PATCH',
        `/estimate_line_items?id=eq.${encodeURIComponent(t.line_item_id)}&estimate_id=eq.${encodeURIComponent(estimateId)}`,
        { description: returned.get(t.line_item_id) });
    }

    // ---- Assemble the document: every line in sort order, model-written or
    // not, so the one document mirrors what the customer page shows per line.
    const sections = lines.map((li) => {
      const bodyText = returned.get(li.id) || (li.description ? String(li.description) : '');
      const head = `## ${li.label}${li.is_optional ? ' (optional)' : ''}`;
      return bodyText ? `${head}\n\n${bodyText}` : head;
    });
    const doc = sections.join('\n\n---\n\n');

    // A BLANK can survive two ways: an unanswered question (in openBlanks), or
    // a literal BLANK the model left in text that had no detectable question
    // context. The send gate keys off the ACTUAL document, so report both.
    const docHasBlank = containsBlank(doc);

    const nowIso = new Date().toISOString();
    await sb('PATCH', `/estimates?id=eq.${encodeURIComponent(estimateId)}`, {
      scope_of_work: doc,
      scope_generated_at: nowIso,
      scope_model: MODEL,
      scope_stale: false,
      scope_edited_at: null, // machine text again; the next hand edit re-stamps it
      scope_questions: openBlanks,
    });

    return jc(200, {
      success: true,
      generated: true,
      scope_of_work: doc,
      lines_written: targets.length,
      skipped,
      open_questions: openBlanks,
      has_blank: docHasBlank,
      model: MODEL,
      generated_at: nowIso,
    });
  } catch (err) {
    console.error('pec-estimate-scope failed:', err);
    return jc(500, { success: false, error: 'Scope generation failed', detail: err && err.message });
  }
};
