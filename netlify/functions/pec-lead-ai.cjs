// AI analysis for a single lead. Called two ways:
//   1. From the dashboard (Refresh analysis button): Authorization: Bearer
//      <supabase access token>, validated against /auth/v1/user.
//   2. Server-to-server (auto-run on new lead arrival): x-webhook-secret
//      header, same PEC_WEBHOOK_SECRET as the other webhooks.
//
// POST /.netlify/functions/pec-lead-ai   Body: { lead_id }
//
// Gathers the lead row, its event timeline (including OpenPhone call
// transcripts stored on 'call' lead_events), and any linked estimates, then
// asks Claude for a structured read: summary, 1-100 score, next action, what
// to say on the call, and draft SMS/email follow-ups. The result is stored on
// leads.ai_analysis (whole blob replaced each run), leads.score is mirrored
// for kanban sorting, scored_at stamps the run (prompt 97), and an
// 'ai_analysis' lead_event records it.
//
// Prompt 97: the gather-and-score core moved to _pec-lead-score.cjs so the
// nightly re-score runner (pec-lead-score-runner.cjs) shares one
// implementation with this endpoint. Behavior here is unchanged: same auth,
// same response shape, an event on every run.
//
// The AI NEVER contacts a customer. Drafts are copy-paste material for a human
// (Dylan's decision, 2026-07-10). Keep it that way.
//
// Env: ANTHROPIC_API_KEY (already set for sop-chat), optional PEC_LEAD_AI_MODEL.

const { sb, json, badSecret, requireStaff } = require('./_pec-supabase.cjs');
const { scoreLead, loadScoreSettings, textFromMessage } = require('./_pec-lead-score.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.PEC_LEAD_AI_MODEL || 'claude-sonnet-5';

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
// Same pattern as pec-send-email.cjs.
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { success: false, error: 'Method not allowed' });

  // Auth: staff JWT OR webhook secret (server-to-server).
  let actorUserId = null;
  if (badSecret(event)) {
    const gate = await requireStaff(event);
    if (!gate.ok) return jc(gate.status, { success: false, error: gate.error });
    actorUserId = gate.user.id;
  }

  if (!ANTHROPIC_API_KEY) return jc(503, { success: false, error: 'ANTHROPIC_API_KEY not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { success: false, error: 'Invalid JSON' }); }

  // Phase 3 (prompt 35): draft ONE-TO-MANY blast copy. Draft-only by design,
  // exactly like the per-lead drafts: the AI fills the compose fields and a
  // human edits and sends. Rides here (not a new function) because the auth,
  // Anthropic plumbing, and draft discipline already live in this file.
  if (body.action === 'draft_blast') {
    const goal = String(body.goal || '').trim().slice(0, 1000);
    const channel = ['sms', 'email', 'both'].includes(body.channel) ? body.channel : 'both';
    if (!goal) return jc(400, { success: false, error: 'goal is required' });
    try {
      const { scrubCopy, capSms } = require('./_pec-drip.cjs');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 800,
          system: `You draft ONE outbound message from Prescott Epoxy Company (PEC), an epoxy floor coating company in Prescott, Arizona, that will be sent to MANY recipients at once (a blast). Hard rules:
- The same text goes to everyone: no per-recipient facts. You may use the literal token {first_name}, which the system replaces per recipient.
- Use ONLY what the staff goal below states. NEVER invent offers, prices, discounts, dates, deadlines, or statistics that the goal does not spell out.
- Do not use em dashes or en dashes anywhere. Do not include links, phone numbers, or email addresses.
- Friendly local business owner voice: brief, plain, warm, zero corporate filler, no emoji.
- sms: 1 to 3 sentences, under 250 characters, identify Prescott Epoxy by name. Do not write an opt-out line; the system appends one.
- email_body: 2 to 6 short sentences in plain paragraphs (blank line between paragraphs), signed off as "the Prescott Epoxy team".
- email_subject: short and plain.
Respond with ONLY a JSON object, no markdown fences: {"sms": <string or null>, "email_subject": <string or null>, "email_body": <string or null>}. Produce only the channels requested; set the others null.`,
          messages: [{
            role: 'user',
            content: `STAFF GOAL FOR THIS BLAST (the only fact source): ${goal}\nCHANNELS REQUESTED: ${channel === 'both' ? 'sms, email' : channel}${body.audience_desc ? `\nAUDIENCE (context only, do not reference directly): ${String(body.audience_desc).slice(0, 300)}` : ''}`,
          }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const raw = textFromMessage(await res.json()).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const obj = JSON.parse(raw);
      return jc(200, {
        success: true,
        draft: {
          sms: capSms(scrubCopy(obj.sms), 480),
          email_subject: scrubCopy(obj.email_subject),
          email_body: scrubCopy(obj.email_body),
        },
      });
    } catch (err) {
      console.error('pec-lead-ai draft_blast failed:', err);
      return jc(500, { success: false, error: 'Draft failed', detail: err && err.message });
    }
  }

  const leadId = body.lead_id;
  if (!leadId) return jc(400, { success: false, error: 'lead_id is required' });

  try {
    // The shared core gathers, scores, and writes back (ai_analysis /
    // ai_analyzed_at / score / scored_at). The settings model override
    // (lead_score_model) rides both this endpoint and the nightly runner;
    // empty = the same env/default model as before prompt 97.
    const cfg = await loadScoreSettings();
    const { analysis } = await scoreLead(leadId, { model: cfg.model });
    await sb('POST', '/lead_events', {
      lead_id: leadId,
      event_type: 'ai_analysis',
      payload: { score: analysis.score, next_action: analysis.next_action, model: analysis.model },
      actor_user_id: actorUserId,
    });

    return jc(200, { success: true, analysis });
  } catch (err) {
    if (err && err.status === 404) return jc(404, { success: false, error: 'Lead not found' });
    console.error('pec-lead-ai failed:', err);
    return jc(500, { success: false, error: 'Analysis failed', detail: err && err.message });
  }
};
