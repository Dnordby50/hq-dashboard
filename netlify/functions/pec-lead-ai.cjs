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
// for kanban sorting, and an 'ai_analysis' lead_event records the run.
//
// The AI NEVER contacts a customer. Drafts are copy-paste material for a human
// (Dylan's decision, 2026-07-10). Keep it that way.
//
// Env: ANTHROPIC_API_KEY (already set for sop-chat), optional PEC_LEAD_AI_MODEL.

const { sb, json, badSecret } = require('./_pec-supabase.cjs');

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
  lines.push(`TIMELINE (newest first, ${events.length} events; call transcripts included where available):`);
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

// Strip accidental markdown fences and parse.
function parseAnalysis(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const obj = JSON.parse(cleaned);
  if (typeof obj.score !== 'number') throw new Error('analysis missing numeric score');
  obj.score = Math.max(1, Math.min(100, Math.round(obj.score)));
  return obj;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { success: false, error: 'Method not allowed' });

  // Auth: staff JWT OR webhook secret (server-to-server).
  let actorUserId = null;
  if (badSecret(event)) {
    const auth = event.headers.authorization || event.headers.Authorization || '';
    const user = await getUser(auth.replace(/^Bearer\s+/i, ''));
    if (!user || !user.id) return jc(401, { success: false, error: 'Not authorized' });
    actorUserId = user.id;
  }

  if (!ANTHROPIC_API_KEY) return jc(503, { success: false, error: 'ANTHROPIC_API_KEY not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { success: false, error: 'Invalid JSON' }); }
  const leadId = body.lead_id;
  if (!leadId) return jc(400, { success: false, error: 'lead_id is required' });

  try {
    const leads = await sb('GET', `/leads?id=eq.${encodeURIComponent(leadId)}&deleted_at=is.null&select=*&limit=1`);
    if (!leads.length) return jc(404, { success: false, error: 'Lead not found' });
    const lead = leads[0];

    const [events, estimates] = await Promise.all([
      sb('GET', `/lead_events?lead_id=eq.${encodeURIComponent(leadId)}&select=event_type,from_stage,to_stage,payload,created_at&order=created_at.desc&limit=50`),
      sb('GET', `/estimates?lead_id=eq.${encodeURIComponent(leadId)}&deleted_at=is.null&select=status,price,sent_at,created_at&order=created_at.desc&limit=10`),
    ]);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(lead, events, estimates) }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
    }
    const out = await res.json();
    const analysis = parseAnalysis(out.content && out.content[0] && out.content[0].text);
    analysis.model = MODEL;
    analysis.generated_at = new Date().toISOString();

    await sb('PATCH', `/leads?id=eq.${encodeURIComponent(leadId)}`, {
      ai_analysis: analysis,
      ai_analyzed_at: analysis.generated_at,
      score: analysis.score,
    });
    await sb('POST', '/lead_events', {
      lead_id: leadId,
      event_type: 'ai_analysis',
      payload: { score: analysis.score, next_action: analysis.next_action, model: MODEL },
      actor_user_id: actorUserId,
    });

    return jc(200, { success: true, analysis });
  } catch (err) {
    console.error('pec-lead-ai failed:', err);
    return jc(500, { success: false, error: 'Analysis failed', detail: err && err.message });
  }
};
