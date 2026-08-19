// Shared lead-scoring core (prompt 97). Extracted from pec-lead-ai.cjs so the
// on-demand endpoint (Refresh button + intake kicks) and the nightly runner
// score through ONE implementation instead of two drifting copies.
//
// What lives here: the system prompt, the gather (lead + timeline + estimates),
// the model call, the parse, and the write-back (ai_analysis / ai_analyzed_at /
// score / scored_at). What does NOT live here: lead_events. The endpoint writes
// an 'ai_analysis' event on every run (unchanged behavior); the nightly runner
// writes a 'score_band_changed' event only when the Hot/Warm/Cold band moved,
// so eighteen quiet re-scores a night do not bury the timeline.
//
// The AI NEVER contacts a customer. Drafts are copy-paste material for a human
// (Dylan's decision, 2026-07-10). Keep it that way.
//
// Env: ANTHROPIC_API_KEY, optional PEC_LEAD_AI_MODEL. The settings key
// lead_score_model (behind Advanced on Settings > Drips) overrides both when
// non-empty, so a model swap is a Settings edit, not a deploy (rule 12).

const { sb } = require('./_pec-supabase.cjs');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL = process.env.PEC_LEAD_AI_MODEL || 'claude-sonnet-5';

// The stages the nightly runner considers "open enough to re-score". Kept as
// the fallback when the settings row is missing or empty; 'lost' and
// 'accepted' are stripped even if someone types them into the setting.
const DEFAULT_SCORE_STAGES = ['new', 'contacted', 'estimate_scheduled', 'presented', 'estimate_sent'];

// Mirrors leadScoreBand in index.html: hot 70-100, warm 40-69, cold 1-39.
// Null score = no band (unknown, not Cold).
function scoreBand(score) {
  if (score == null || !Number.isFinite(Number(score))) return null;
  const n = Number(score);
  return n >= 70 ? 'hot' : n >= 40 ? 'warm' : 'cold';
}

const SYSTEM_PROMPT = `You are the sales analyst for Prescott Epoxy Company (PEC), a residential and commercial epoxy floor coating company in Prescott, Arizona. You analyze one sales lead at a time and give the salesperson concrete, specific guidance. Ground every claim in the data provided; never invent details about the customer. Voice for drafts: friendly, brief, local, zero corporate filler. Respond with ONLY a JSON object, no markdown fences, with exactly these keys:
{
  "summary": "2-3 sentence read on who this lead is and where they stand",
  "score": <1-100 integer, likelihood this lead becomes a sold job soon>,
  "score_reason": "one sentence on why that score",
  "next_action": "the single best next step, specific (e.g. call before noon and offer Tuesday slot)",
  "call_script": "3-5 bullet talking points for the next phone call, tuned to this lead's source, timeline signals, and any prior call content",
  "draft_sms": "a ready-to-send text message under 300 chars, or null if SMS is not appropriate (no consent)",
  "draft_email": "a short ready-to-send email body, or null if no email on file",
  "risk_flags": ["array of concerns, e.g. going cold (5 days no contact), price shopper language on call, bad number"]
}`;

function buildUserPrompt(lead, events, estimates) {
  const lines = [];
  lines.push('LEAD RECORD:');
  lines.push(JSON.stringify({
    name: lead.full_name, source: lead.source, campaign: lead.campaign,
    ad_meta: lead.ad_meta, stage: lead.stage, city: lead.city, address: lead.address,
    phone_on_file: !!lead.phone, email_on_file: !!lead.email,
    sms_consent: lead.sms_consent, notes: lead.notes,
    created_at: lead.created_at, contacted_at: lead.contacted_at,
    estimate_sent_at: lead.estimate_sent_at, presented_at: lead.presented_at,
  }));
  lines.push('');
  lines.push(`TIMELINE (newest first, ${events.length} events; phone call transcripts and in-home sales visit recordings (salesask_recording: AI summary, action items, process score, transcript excerpt) included where available):`);
  for (const ev of events) {
    const payload = ev.payload ? JSON.stringify(ev.payload).slice(0, 4000) : '';
    lines.push(`- [${ev.created_at}] ${ev.event_type}${ev.to_stage ? ` -> ${ev.to_stage}` : ''} ${payload}`);
  }
  if (estimates.length) {
    lines.push('');
    lines.push('ESTIMATES:');
    for (const est of estimates) {
      lines.push(JSON.stringify({ status: est.status, price: est.price, sent_at: est.sent_at, created_at: est.created_at }));
    }
  }
  lines.push('');
  lines.push(`CURRENT TIME: ${new Date().toISOString()}`);
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

// Strip accidental markdown fences and parse.
function parseAnalysis(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const obj = JSON.parse(cleaned);
  if (typeof obj.score !== 'number') throw new Error('analysis missing numeric score');
  obj.score = Math.max(1, Math.min(100, Math.round(obj.score)));
  return obj;
}

// Runner/endpoint configuration off the settings table (rule 12). Missing
// rows fall back to the seeded defaults so the feature works before anyone
// visits Settings; a settings read failure does the same.
async function loadScoreSettings(deps = {}) {
  const db = deps.sb || sb;
  let map = {};
  try {
    const rows = await db('GET', '/settings?key=in.(lead_score_nightly_enabled,lead_score_batch_cap,lead_score_stages,lead_score_model)&select=key,value');
    map = Object.fromEntries((Array.isArray(rows) ? rows : []).map(r => [r.key, r.value]));
  } catch (e) {
    console.warn('_pec-lead-score: settings read failed, using defaults:', e && e.message);
  }
  const cap = Math.max(1, parseInt(map.lead_score_batch_cap, 10) || 50);
  const stages = String(map.lead_score_stages || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    .filter(s => s !== 'lost' && s !== 'accepted');
  return {
    enabled: map.lead_score_nightly_enabled !== 'false',
    cap,
    stages: stages.length ? stages : DEFAULT_SCORE_STAGES,
    model: String(map.lead_score_model || '').trim() || DEFAULT_MODEL,
  };
}

// Score ONE lead: gather, call the model, write the result back. Stamps
// scored_at on EVERY run (prompt 97 B5), including the intake kick, so
// staleness is always readable. Returns { analysis, prevScore, prevBand,
// newBand, bandChanged }; writes NO lead_events (callers own that rule).
async function scoreLead(leadId, opts = {}) {
  const db = opts.sb || sb;
  const fetchFn = opts.fetch || fetch;
  if (!ANTHROPIC_API_KEY && !opts.fetch) {
    const err = new Error('ANTHROPIC_API_KEY not configured');
    err.status = 503;
    throw err;
  }
  const leads = await db('GET', `/leads?id=eq.${encodeURIComponent(leadId)}&deleted_at=is.null&select=*&limit=1`);
  if (!leads.length) {
    const err = new Error('Lead not found');
    err.status = 404;
    throw err;
  }
  const lead = leads[0];

  const [events, estimates] = await Promise.all([
    db('GET', `/lead_events?lead_id=eq.${encodeURIComponent(leadId)}&select=event_type,from_stage,to_stage,payload,created_at&order=created_at.desc&limit=50`),
    db('GET', `/estimates?lead_id=eq.${encodeURIComponent(leadId)}&deleted_at=is.null&select=status,price,sent_at,created_at&order=created_at.desc&limit=10`),
  ]);

  const model = opts.model || DEFAULT_MODEL;
  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(lead, events, estimates) }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
  }
  const out = await res.json();
  const analysis = parseAnalysis(textFromMessage(out));
  analysis.model = model;
  analysis.generated_at = new Date().toISOString();

  const patch = {
    ai_analysis: analysis,
    ai_analyzed_at: analysis.generated_at,
    score: analysis.score,
    scored_at: analysis.generated_at,
  };
  try {
    await db('PATCH', `/leads?id=eq.${encodeURIComponent(leadId)}`, patch);
  } catch (err) {
    // Pre-migration tolerance (the routemize_contact_id pattern): if the
    // scored_at column is not there yet, the score still lands without it.
    if (/scored_at/i.test(String(err && err.message))) {
      const { scored_at, ...rest } = patch;
      await db('PATCH', `/leads?id=eq.${encodeURIComponent(leadId)}`, rest);
    } else throw err;
  }

  const prevScore = lead.score == null ? null : Number(lead.score);
  const prevBand = scoreBand(prevScore);
  const newBand = scoreBand(analysis.score);
  return { analysis, lead, prevScore, prevBand, newBand, bandChanged: prevBand !== newBand };
}

// One re-score pass over the open pipeline (the nightly tick and the on-demand
// backfill both run through here). Subject set: not deleted, not archived,
// stage in the settings list (which can never include lost/accepted). Ordered
// by staleness: never-scored first, then oldest scored_at. Bounded by the
// batch cap so a bad day costs a known number of model calls.
//
// freshHours: skip leads scored within this window (scored_at, falling back
// to ai_analyzed_at for pre-scored_at rows), so a lead somebody refreshed by
// hand today is never immediately clobbered (the prompt-56 count-before-you-
// apply lesson). The nightly tick passes 20 (under the 24h cadence so
// yesterday's own scores are never skipped as "fresh"); the manual backfill
// defaults to 24 per the prompt.
async function runScorePass(opts = {}) {
  const db = opts.sb || sb;
  const cfg = await loadScoreSettings({ sb: db });
  const cap = Math.max(1, parseInt(opts.cap, 10) || cfg.cap);
  const freshHours = Number.isFinite(Number(opts.freshHours)) ? Number(opts.freshHours) : 20;
  const source = opts.source || 'nightly_runner';
  const doScore = opts.scoreLead || scoreLead;

  const stageList = cfg.stages.map(encodeURIComponent).join(',');
  // Candidates come back ordered by staleness; freshness is filtered here
  // (not in the query) because it reads two columns and the open pipeline is
  // small. The 500 limit is a runaway guard, not a working bound.
  const rows = await db('GET',
    `/leads?deleted_at=is.null&archived_at=is.null&stage=in.(${stageList})`
    + '&select=id,full_name,stage,score,scored_at,ai_analyzed_at'
    + '&order=scored_at.asc.nullsfirst,created_at.asc&limit=500');
  const candidates = Array.isArray(rows) ? rows : [];
  const cutoff = Date.now() - freshHours * 3600 * 1000;
  const stale = candidates.filter(l => {
    const last = l.scored_at || l.ai_analyzed_at;
    return !last || new Date(last).getTime() < cutoff;
  });
  const batch = stale.slice(0, cap);

  const result = {
    candidates: candidates.length,
    skipped_fresh: candidates.length - stale.length,
    attempted: batch.length,
    // Cowork's backfill finding (2026-08-18): a synchronous invocation dies
    // at ~26s, so callers must be able to see there is more to do and loop
    // deliberately instead of reading a 504 as failure. Work is never lost
    // either way: each lead is written as it is scored and the staleness
    // order + freshness skip make every pass resume where the last stopped.
    remaining: Math.max(0, stale.length - batch.length),
    scored: 0,
    band_changes: 0,
    errors: [],
  };
  for (const l of batch) {
    try {
      const r = await doScore(l.id, { sb: db, model: cfg.model, fetch: opts.fetch });
      result.scored++;
      // Timeline rule (prompt 97 B6): an event ONLY when the band moved.
      // A first-ever score (null band -> a band) counts as a move: it is the
      // one row that records when scoring began for that lead.
      if (r.bandChanged) {
        result.band_changes++;
        await db('POST', '/lead_events', {
          lead_id: l.id,
          event_type: 'score_band_changed',
          payload: {
            from_score: r.prevScore, to_score: r.analysis.score,
            from_band: r.prevBand, to_band: r.newBand,
            via: source, model: cfg.model,
          },
        }).catch(e => console.warn('_pec-lead-score: band-change event failed (non-fatal):', e && e.message));
      }
    } catch (e) {
      result.errors.push({ lead_id: l.id, error: String(e && e.message || e).slice(0, 300) });
    }
  }
  return result;
}

module.exports = {
  scoreBand, scoreLead, runScorePass, loadScoreSettings,
  SYSTEM_PROMPT, buildUserPrompt, textFromMessage, parseAnalysis,
  DEFAULT_SCORE_STAGES,
};
