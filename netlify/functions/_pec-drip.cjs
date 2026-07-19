// Lead drip engine core (prompt 34, Phase 2). Shared by pec-drip-runner.cjs
// (the scheduled function), pec-lead-intake.cjs (auto-enroll on arrival), and
// the fixture test. Everything with a side effect goes through the injected
// `deps` object so the test can drive the REAL engine against stubbed
// Supabase / Quo / Resend / Anthropic layers.
//
// SAFETY MODEL (each is spec, not decoration):
//   - Global master switch: settings key 'drip_sending_enabled' must be the
//     string 'true' or the run no-ops. Ships seeded 'false'.
//   - Per-campaign mode: 'dry_run' renders the real AI copy into
//     pec_drip_sends (status dry_run) and never touches a provider; 'live'
//     actually sends. New campaigns default dry_run.
//   - Kill-switches re-checked AT SEND TIME, never trusted from enrollment:
//    (see checkKillSwitches) replied / stage advanced or lost / opted out /
//     max touches.
//   - Consent: opted_out stops the whole enrollment (a do-not-contact
//     signal). sms_consent=false does NOT stop it: it skips the SMS leg
//     (recorded as a 'skipped' ledger row) and the email drip continues,
//     because absent SMS permission is not "never contact me". This is the
//     deliberate reading of the "skip/stop" guardrail; most leads arrive
//     with sms_consent=false and stopping would gut the email sequence.
//   - Quiet hours: SMS only inside 08:00-20:00 America/Phoenix (fixed UTC-7,
//     no DST, per project context). A step with an SMS leg due outside the
//     window is DEFERRED to the next window open, never skipped. Email-only
//     steps send any time.
//   - Concurrency: CLAIM-FIRST. The conditional PATCH that advances
//     next_step_index (guarded on its current value AND status=active) is
//     atomic in Postgres; whoever wins the claim sends, the loser sees zero
//     rows updated and walks away. A double-send is therefore impossible; the
//     cost is that a crash after claim but before send loses that one touch
//     (visible as a step gap in the ledger). For marketing outreach,
//     never-double-text beats never-lose-a-touch.
//   - Failure policy: a provider failure (or AI render failure) records a
//     'failed' ledger row and the sequence continues at the NEXT step on its
//     own schedule. The same rendered message is never auto-retried (the
//     non-idempotent-write discipline from CLAUDE.md: a retry can double-send
//     if the first request actually landed).
//   - Rate limits: per-lead ceiling = campaign.max_touches (default 8);
//     per-run global cap RUN_CAP enrollments, logged when hit.
//
// PHASE 3 (prompt 35): enrollments are now SUBJECT-keyed, not lead-keyed.
// subject_type 'lead' covers lead-nurture AND estimate drips (an estimate
// belongs to a lead); subject_type 'job' covers invoice reminders (the
// recipient is the job's customer). resolveRecipient() turns a subject into
// "who do I contact and may I", and checkKillSwitches() runs a universal
// core (missing / opted out / max touches / replied) plus a per-kind adapter
// (KIND_CHECKS): lead = stage rules, estimate = accepted/lost/portal
// activity, invoice = balance recomputed from jobs+pec_payments EVERY run so
// a partial payment keeps reminding and a full payment stops instantly.
// Estimate links / pay links / balances are appended by CODE after the AI
// render (scrubCopy strips model-written URLs on purpose; data beats the
// model for anything that must be exactly right).

const RUN_CAP = 25;               // enrollments per run; taper is day-grained so backlog clears fast
const MAX_SMS_LEN = 480;          // hard cap on AI SMS copy (~3 segments)
const QUIET_START_HOUR = 8;       // America/Phoenix, fixed UTC-7 (no DST)
const QUIET_END_HOUR = 20;
const PHX_OFFSET_MS = 7 * 60 * 60 * 1000;
const DRIP_BRAND = 'prescott-epoxy';   // leads are PEC-only today; matches pec_sms_senders/pec_email_senders keys
const STOP_LINE = ' Reply STOP to opt out.';
// Same base URL rule as pec-send-sms.cjs / pec-public-estimate.cjs, so drip
// links match the links the rest of the app hands out.
const SITE_URL = process.env.URL || 'https://prescottepoxy.netlify.app';
const BALANCE_EPS = 0.005;        // same epsilon as the AR "paid" predicate in index.html

function usd(n) {
  const v = Number(n || 0);
  return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Mirror pec-send-sms.cjs toE164 EXACTLY so stored numbers match on both sides.
function toE164(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15 ? '+' + digits : null;
  }
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  if (d.length >= 11 && d.length <= 15) return '+' + d;
  return null;
}
// The one phone-tail rule (last 10 digits), matching leads.phone_norm.
function phoneTail(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

// Quiet hours in fixed-offset Phoenix time. Returns { inWindow, nextOpen }.
// nextOpen is the next 08:00 Phoenix as a Date (only meaningful when
// !inWindow).
function quietHours(now) {
  const phx = new Date(now.getTime() - PHX_OFFSET_MS);   // wall clock via UTC getters
  const h = phx.getUTCHours();
  const inWindow = h >= QUIET_START_HOUR && h < QUIET_END_HOUR;
  if (inWindow) return { inWindow, nextOpen: null };
  const open = new Date(Date.UTC(phx.getUTCFullYear(), phx.getUTCMonth(), phx.getUTCDate(), QUIET_START_HOUR, 0, 0));
  if (h >= QUIET_END_HOUR) open.setUTCDate(open.getUTCDate() + 1);  // tonight -> tomorrow 8am
  return { inWindow, nextOpen: new Date(open.getTime() + PHX_OFFSET_MS) };
}

function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000);
}

// Customer-facing scrubber: the model is told "no em dashes, no links", and
// this enforces it anyway (standing rule 6 is not left to model compliance).
function scrubCopy(text) {
  if (text == null) return null;
  let s = String(text)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return s || null;
}
// max is overridable so callers can reserve room for a code-appended tail
// (estimate/pay link + STOP line); the tail itself must never be truncated.
function capSms(text, max = MAX_SMS_LEN) {
  if (!text) return text;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max - 60 ? cut.slice(0, sp) : cut).trim();
}

// ---------------------------------------------------------------------------
// AI copy rendering. One Anthropic call per touch; the guidance is the step's
// instruction, the record is the only fact source. Customer-facing rules are
// hard constraints in the system prompt AND enforced by scrubCopy after.
// ---------------------------------------------------------------------------
// The SHARED hard rules live in each prompt verbatim (kept inline so a future
// edit to one kind cannot silently loosen another). Per-kind framing differs:
// lead = nurture someone who asked about a floor; estimate = nudge a review
// of an estimate that exists; invoice = politely remind about a real balance.
// The model NEVER writes links or amounts we did not hand it; code appends
// the authoritative link/balance tail after scrubbing anyway.
const RENDER_SYSTEM_PROMPT = `You write short outreach messages from Prescott Epoxy Company (PEC), an epoxy floor coating company in Prescott, Arizona, to a sales lead who asked about a floor and has not booked yet. You get the lead's record and one instruction for this touch. Hard rules:
- Use ONLY facts present in the lead record. NEVER invent or imply prices, discounts, dates, appointment times, crew availability, warranties, named customers, reviews, or statistics.
- Do not use em dashes or en dashes anywhere.
- Do not include links, phone numbers, or email addresses in the message text.
- Write like a friendly local business owner: brief, plain, warm, zero corporate filler, no emoji.
- Use the lead's first name when one is available; otherwise no name.
- sms: 1 to 3 sentences, under 300 characters, identify Prescott Epoxy by name.
- email_body: 2 to 5 short sentences in plain paragraphs (separate paragraphs with a blank line), signed off as "the Prescott Epoxy team". No subject line inside the body.
- email_subject: short and plain; if a suggested subject is provided, use it or a light variation.
Respond with ONLY a JSON object, no markdown fences: {"sms": <string or null>, "email_subject": <string or null>, "email_body": <string or null>}. Produce only the channels requested; set the others null.`;

const RENDER_SYSTEM_PROMPT_ESTIMATE = `You write short follow-up messages from Prescott Epoxy Company (PEC), an epoxy floor coating company in Prescott, Arizona, to a customer who received a written estimate and has not signed yet. You get the estimate facts and one instruction for this touch. Hard rules:
- Use ONLY facts present in the record. You may mention the estimate price ONLY if a price is given in the record, stated exactly as given. NEVER invent or imply discounts, expiration dates, appointment times, crew availability, warranties, named customers, reviews, or statistics.
- Do not use em dashes or en dashes anywhere.
- Do not include links, phone numbers, or email addresses in the message text. The system appends the estimate link automatically after your message.
- Write like a friendly local business owner: brief, plain, warm, zero corporate filler, no emoji, no pressure tactics.
- Use the customer's first name when one is available; otherwise no name.
- sms: 1 to 3 sentences, under 250 characters, identify Prescott Epoxy by name.
- email_body: 2 to 5 short sentences in plain paragraphs (separate paragraphs with a blank line), signed off as "the Prescott Epoxy team". No subject line inside the body.
- email_subject: short and plain; if a suggested subject is provided, use it or a light variation.
Respond with ONLY a JSON object, no markdown fences: {"sms": <string or null>, "email_subject": <string or null>, "email_body": <string or null>}. Produce only the channels requested; set the others null.`;

const RENDER_SYSTEM_PROMPT_INVOICE = `You write short, professional payment reminders from Prescott Epoxy Company (PEC), an epoxy floor coating company in Prescott, Arizona, to a customer whose job is done and who has an open invoice balance. You get the invoice facts and one instruction for this touch. Hard rules:
- Use ONLY facts present in the record. You may state the remaining balance ONLY as given in the record, exactly. NEVER invent or imply amounts, due dates, late fees, penalties, discounts, or payment plans.
- Do not use em dashes or en dashes anywhere.
- Do not include links, phone numbers, or email addresses in the message text. The system appends the payment link and balance automatically after your message.
- Tone: courteous, appreciative, and direct. Thank them for their business. Never threatening, never apologetic to the point of undermining the ask.
- Use the customer's first name when one is available; otherwise no name.
- sms: 1 to 3 sentences, under 250 characters, identify Prescott Epoxy by name.
- email_body: 2 to 5 short sentences in plain paragraphs (separate paragraphs with a blank line), signed off as "the Prescott Epoxy team". No subject line inside the body.
- email_subject: short and plain; if a suggested subject is provided, use it or a light variation.
Respond with ONLY a JSON object, no markdown fences: {"sms": <string or null>, "email_subject": <string or null>, "email_body": <string or null>}. Produce only the channels requested; set the others null.`;

const RENDER_SYSTEM_PROMPTS = {
  lead: RENDER_SYSTEM_PROMPT,
  estimate: RENDER_SYSTEM_PROMPT_ESTIMATE,
  invoice: RENDER_SYSTEM_PROMPT_INVOICE,
};

function daysAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return ms > 0 ? Math.floor(ms / (24 * 60 * 60 * 1000)) : 0;
}

// ctx is the resolveRecipient() result (plus .estimate/.balance attached by
// the kill-switch adapters). The fact block is the ONLY thing the model may
// draw from, so each kind serializes exactly what it is allowed to say.
function buildRenderPrompt(ctx, step, campaign, needs) {
  const kind = campaign.kind || 'lead';
  let recordLabel, record, touchLine;
  if (kind === 'estimate' && ctx.estimate) {
    const est = ctx.estimate;
    recordLabel = 'ESTIMATE RECORD (the only fact source):';
    record = {
      first_name: ctx.first_name,
      estimate_number: est.estimate_number || null,
      price: est.price != null ? usd(est.price) : null,
      sent_days_ago: daysAgo(est.sent_at),
      city: ctx.lead ? ctx.lead.city : null,
    };
    touchLine = `THIS TOUCH: step ${step.step_index + 1} of ${campaign.max_touches} in the "${campaign.name}" sequence, day ${step.day_offset} after their estimate went out.`;
  } else if (kind === 'invoice' && ctx.job) {
    recordLabel = 'INVOICE RECORD (the only fact source):';
    record = {
      first_name: ctx.first_name,
      invoice_number: ctx.job.hq_invoice_number || null,
      balance: ctx.balance != null ? usd(ctx.balance) : null,
      job_address: ctx.job.address || null,
      invoice_sent_days_ago: daysAgo(ctx.job.invoice_first_sent_at),
    };
    touchLine = `THIS TOUCH: step ${step.step_index + 1} of ${campaign.max_touches} in the "${campaign.name}" sequence, day ${step.day_offset} after their invoice went out.`;
  } else {
    const lead = ctx.lead || ctx;   // legacy shape tolerated (tests, old callers)
    recordLabel = 'LEAD RECORD (the only fact source):';
    record = {
      first_name: lead.first_name || (lead.full_name ? String(lead.full_name).split(/\s+/)[0] : null),
      full_name: lead.full_name,
      source: lead.source,
      campaign: lead.campaign,
      city: lead.city,
      has_address: !!lead.address,
      notes: lead.notes,
      stage: lead.stage,
      created_at: lead.created_at,
    };
    touchLine = `THIS TOUCH: step ${step.step_index + 1} of ${campaign.max_touches} in the "${campaign.name}" sequence, day ${step.day_offset} after they reached out.`;
  }
  return [
    recordLabel,
    JSON.stringify(record),
    '',
    touchLine,
    `INSTRUCTION FOR THIS TOUCH: ${step.ai_guidance}`,
    step.email_subject ? `SUGGESTED EMAIL SUBJECT: ${step.email_subject}` : '',
    `CHANNELS REQUESTED: ${[needs.sms ? 'sms' : '', needs.email ? 'email' : ''].filter(Boolean).join(', ')}`,
    `CURRENT TIME: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n');
}

// Same text-block discipline as pec-lead-ai.cjs textFromMessage (content[0]
// is not guaranteed to be the text block).
function textFromMessage(out) {
  const blocks = (out && Array.isArray(out.content)) ? out.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('\n').trim();
  if (!text) {
    const types = blocks.map((b) => (b && b.type) || 'unknown').join(',') || 'none';
    throw new Error(`no text block in model response (stop_reason=${out && out.stop_reason}, blocks=[${types}])`);
  }
  return text;
}

async function renderCopyReal(ctx, step, campaign, needs) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
  const model = process.env.PEC_DRIP_AI_MODEL || 'claude-sonnet-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 800,
      system: RENDER_SYSTEM_PROMPTS[campaign.kind] || RENDER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildRenderPrompt(ctx, step, campaign, needs) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const raw = textFromMessage(await res.json())
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const obj = JSON.parse(raw);
  return {
    sms: capSms(scrubCopy(obj.sms)),
    email_subject: scrubCopy(obj.email_subject),
    email_body: scrubCopy(obj.email_body),
  };
}

// ---------------------------------------------------------------------------
// Provider sends. Same request shapes as pec-send-sms.cjs / pec-send-email.cjs
// (raw QUO key in Authorization, Bearer for Resend). Return {ok, id, error};
// they never throw for HTTP-level failures, only for transport errors, which
// the caller records as failed too.
// ---------------------------------------------------------------------------
async function sendQuoSmsReal({ from, to, content }) {
  const key = process.env.QUO_API_KEY;
  if (!key) return { ok: false, id: null, error: 'QUO_API_KEY not configured' };
  const res = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, from, to: [to] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body && (body.message || (body.error && (body.error.message || body.error)) || body.errors)) || `Quo error ${res.status}`;
    return { ok: false, id: null, error: String(JSON.stringify(msg)).slice(0, 500) };
  }
  return { ok: true, id: (body && body.data && body.data.id) || body.id || null, error: null };
}

async function sendResendEmailReal({ from, to, subject, html, reply_to }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, id: null, error: 'RESEND_API_KEY not configured' };
  const payload = { from, to: [to], subject, html };
  if (reply_to) payload.reply_to = reply_to;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body && (body.message || body.error)) || `Resend error ${res.status}`;
    return { ok: false, id: null, error: String(msg).slice(0, 500) };
  }
  return { ok: true, id: body.id || null, error: null };
}

// Brand sender lookups, shared by the drip runner and the blast drain. The
// cache object is per-run (callers pass their own), so a stale sender never
// outlives one tick.
async function getSmsSender(sb, cache) {
  if (!(DRIP_BRAND in cache)) {
    const senders = await sb('GET', `/pec_sms_senders?brand=eq.${DRIP_BRAND}&active=eq.true&select=*&limit=1`);
    cache[DRIP_BRAND] = (Array.isArray(senders) && senders[0]) || null;
  }
  return cache[DRIP_BRAND];
}
async function getEmailSender(sb, cache) {
  if (!(DRIP_BRAND in cache)) {
    const senders = await sb('GET', `/pec_email_senders?brand=eq.${DRIP_BRAND}&select=*&limit=1`);
    cache[DRIP_BRAND] = (Array.isArray(senders) && senders[0]) || null;
  }
  return cache[DRIP_BRAND];
}

const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Drip emails deliberately look like a short personal note, NOT the branded
// invoice chrome (wrapInChrome in pec-send-email.cjs): a heavy header on a
// "just checking in" email reads as a blast. Plain paragraphs, name signature,
// a human opt-out line. The reply goes to the brand's reply_to inbox; email
// replies are not machine-tracked (the replied kill-switch reads SMS/call
// logs), so the opt-out line invites a reply that staff acts on with the
// Stop drip button.
function dripEmailHtml(bodyText) {
  // Code-appended tails (estimate/pay links) arrive as plain-text URLs in the
  // body so the ledger stores exactly what was sent; linkify them here.
  const linkify = (s) => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#c2410c">$1</a>');
  const paras = String(bodyText || '').split(/\n\s*\n/)
    .map(p => `<p style="margin:0 0 14px">${linkify(escHtml(p.trim())).replace(/\n/g, '<br>')}</p>`).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f2937;max-width:600px;margin:0 auto;padding:8px 0">
    ${paras}
    <p style="margin:18px 0 0;color:#6b7280;font-size:12px">Prescott Epoxy Company, Prescott, AZ. Prefer not to hear from us? Just reply and tell us and we will stop.</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Enrollment. Used by pec-lead-intake.cjs on arrival (the dashboard's manual
// New Lead modal enrolls client-side with the same shape). Best-effort: every
// failure returns {enrolled:false, reason} and never throws, so intake can
// never fail because of the drip.
// ---------------------------------------------------------------------------
// Shared by all three kinds: find the active campaign of `kind`, insert an
// active enrollment at its first step. The Phase 3 unique index makes a
// duplicate a clean 409 ('already_active').
async function enrollSubject(sb, kind, subjectType, subjectId, leadId, now) {
  try {
    const camps = await sb('GET', `/pec_drip_campaigns?kind=eq.${kind}&status=eq.active&select=id&order=created_at.asc&limit=1`);
    const camp = Array.isArray(camps) ? camps[0] : null;
    if (!camp) return { enrolled: false, reason: 'no_active_campaign' };
    const steps = await sb('GET', `/pec_drip_steps?campaign_id=eq.${encodeURIComponent(camp.id)}&active=eq.true&select=step_index,day_offset&order=step_index.asc&limit=1`);
    const step0 = Array.isArray(steps) ? steps[0] : null;
    if (!step0) return { enrolled: false, reason: 'no_steps' };
    const row = {
      subject_type: subjectType,
      subject_id: subjectId,
      lead_id: leadId,
      campaign_id: camp.id,
      status: 'active',
      next_step_index: step0.step_index,
      next_send_at: addDays(now.toISOString(), step0.day_offset).toISOString(),
    };
    try {
      await sb('POST', '/pec_drip_enrollments', row);
    } catch (err) {
      // Pre-Phase-3 schema (no subject columns yet): fall back to the Phase 2
      // shape so lead enrollment keeps working if the code deploys first.
      const m = String(err && err.message || err);
      if (subjectType === 'lead' && /subject_type|subject_id|PGRST204/i.test(m)) {
        const { subject_type, subject_id, ...legacy } = row;
        await sb('POST', '/pec_drip_enrollments', legacy);
      } else throw err;
    }
    return { enrolled: true, campaign_id: camp.id };
  } catch (err) {
    const m = String(err && err.message || err);
    if (/23505|409|duplicate/i.test(m)) return { enrolled: false, reason: 'already_active' };
    console.warn(`enroll ${kind} failed (non-fatal):`, m);
    return { enrolled: false, reason: 'error', error: m };
  }
}

async function enrollLead(sb, leadId, now = new Date()) {
  return enrollSubject(sb, 'lead', 'lead', leadId, leadId, now);
}

// Estimate follow-up enrollment, fired when an estimate transitions to
// 'sent'. EAGERLY stops any active lead-nurture drip first (stop_reason
// 'estimate_sent'): a sent estimate means the lead progressed, and without
// the eager stop both sequences could touch the same person until the next
// runner tick notices the stage change. Re-sending a revised estimate while
// an estimate drip is active is a clean 409 no-op; after a stop (say
// change_requested), a re-send starts a FRESH taper on purpose (a revised
// estimate deserves its own follow-up clock). The client-side mirror in
// index.html (enrollEstimateDripClient) must match this logic.
async function enrollEstimateDrip(sb, leadId, now = new Date()) {
  try {
    const act = await sb('GET', `/pec_drip_enrollments?lead_id=eq.${encodeURIComponent(leadId)}&status=eq.active&select=id,campaign_id`);
    const list = Array.isArray(act) ? act : [];
    if (list.length) {
      const ids = [...new Set(list.map(e => e.campaign_id))];
      const camps = await sb('GET', `/pec_drip_campaigns?id=in.(${ids.join(',')})&select=id,kind`);
      const leadCamps = new Set((Array.isArray(camps) ? camps : []).filter(c => c.kind === 'lead').map(c => c.id));
      for (const e of list) {
        if (leadCamps.has(e.campaign_id)) {
          await sb('PATCH', `/pec_drip_enrollments?id=eq.${encodeURIComponent(e.id)}&status=eq.active`, {
            status: 'stopped', stop_reason: 'estimate_sent', stopped_at: now.toISOString(), next_send_at: null,
          });
        }
      }
    }
  } catch (err) {
    console.warn('enrollEstimateDrip lead-stop failed (non-fatal):', String(err && err.message || err));
  }
  return enrollSubject(sb, 'estimate', 'lead', leadId, leadId, now);
}

// Invoice payment-reminder enrollment, fired when an invoice FIRST goes out
// to the customer (the jobs.invoice_first_sent_at null->set transition, which
// fires exactly once per job). Enrollment is anchored to NOW, never backdated
// to an old stamp: a backdated anchor would make every step instantly due and
// fire four reminders in an hour.
async function enrollJobInvoiceDrip(sb, jobId, now = new Date()) {
  return enrollSubject(sb, 'invoice', 'job', jobId, null, now);
}

// ---------------------------------------------------------------------------
// Recipient resolution: (subject_type, subject_id) -> who to contact and
// whether we may, per channel. Consent models DIFFER by subject on purpose:
//   lead:     positive sms_consent required (most arrive without it) and
//             opted_out is a global do-not-contact that stops the enrollment.
//   customer: opt-out only (sms_opt_out), matching pec-send-sms.cjs; it
//             silences the SMS leg, not email (STOP is an SMS-scope signal).
// Never throws; ok:false means the subject is gone and the drip should stop.
// ---------------------------------------------------------------------------
async function resolveRecipient(sb, subjectType, subjectId) {
  const id = encodeURIComponent(subjectId);
  if (subjectType === 'job') {
    const jobs = await sb('GET', `/jobs?id=eq.${id}&select=id,price,public_token,customer_id,voided_at,archived_at,completed_date,hq_invoice_number,invoice_first_sent_at,address&limit=1`);
    const job = (Array.isArray(jobs) && jobs[0]) || null;
    if (!job) return { ok: false, reason: 'job_missing' };
    const custs = job.customer_id
      ? await sb('GET', `/customers?id=eq.${encodeURIComponent(job.customer_id)}&select=id,name,first_name,phone,phone_norm,email,sms_opt_out&limit=1`)
      : [];
    const customer = (Array.isArray(custs) && custs[0]) || null;
    if (!customer) return { ok: false, reason: 'job_missing' };
    const smsTo = toE164(customer.phone);
    return {
      ok: true, kind: 'job', job, customer,
      phone: customer.phone, phone_norm: customer.phone_norm, email: customer.email, smsTo,
      smsAllowed: !customer.sms_opt_out && !!smsTo,
      smsSkipReason: customer.sms_opt_out ? 'sms_opted_out' : (!smsTo ? 'no_valid_phone' : null),
      emailAllowed: !!customer.email,
      emailSkipReason: !customer.email ? 'no_email' : null,
      optedOut: false,
      customer_id: customer.id,
      first_name: customer.first_name || (customer.name ? String(customer.name).split(/\s+/)[0] : null),
    };
  }
  const leads = await sb('GET', `/leads?id=eq.${id}&select=*&limit=1`);
  const lead = (Array.isArray(leads) && leads[0] && !leads[0].deleted_at) ? leads[0] : null;
  if (!lead) return { ok: false, reason: 'lead_missing' };
  const smsTo = toE164(lead.phone);
  return {
    ok: true, kind: 'lead', lead,
    phone: lead.phone, phone_norm: lead.phone_norm, email: lead.email, smsTo,
    smsAllowed: !!lead.sms_consent && !!smsTo,
    smsSkipReason: !lead.sms_consent ? 'no_sms_consent' : (!smsTo ? 'no_valid_phone' : null),
    emailAllowed: !!lead.email && lead.email_consent !== false,
    emailSkipReason: !lead.email ? 'no_email' : (lead.email_consent === false ? 'no_email_consent' : null),
    optedOut: !!lead.opted_out,
    customer_id: lead.customer_id,
    first_name: lead.first_name || (lead.full_name ? String(lead.full_name).split(/\s+/)[0] : null),
  };
}

// ---------------------------------------------------------------------------
// Kill-switches, re-checked at send time. Universal core (subject gone /
// opted out / max touches / replied) + one adapter per campaign kind.
// Returns null (clear to proceed) or { action: 'stopped'|'completed', reason }.
// Adapters may attach copy context to rcpt (estimate row, live balance).
// ---------------------------------------------------------------------------
const KIND_CHECKS = {
  // Lead nurture: 'new'/'contacted' keep dripping; anything further means a
  // human is engaged and the drip must shut up.
  async lead(sb, enr, rcpt) {
    const lead = rcpt.lead;
    if (lead.stage === 'lost') return { action: 'stopped', reason: 'lost' };
    if (['estimate_sent', 'presented', 'accepted'].includes(lead.stage)) {
      return { action: 'stopped', reason: 'stage_advanced' };
    }
    return null;
  },
  // Estimate follow-up (subject is the LEAD the estimate belongs to).
  // 'signed' is the interim e-sign state and MUST count as accepted, or the
  // drip nags a customer who just signed. change_requested means the customer
  // engaged through the portal, so a human takes over (stop as 'replied').
  async estimate(sb, enr, rcpt) {
    const ests = await sb('GET',
      `/estimates?lead_id=eq.${encodeURIComponent(enr.subject_id || enr.lead_id)}&deleted_at=is.null&select=id,status,sent_at,price,public_token,estimate_number&order=sent_at.desc`);
    const list = Array.isArray(ests) ? ests : [];
    if (list.some(e => e.status === 'accepted' || e.status === 'signed')) {
      return { action: 'stopped', reason: 'accepted' };
    }
    if (rcpt.lead && rcpt.lead.stage === 'lost') return { action: 'stopped', reason: 'lost' };
    if (list.some(e => e.status === 'change_requested')) return { action: 'stopped', reason: 'replied' };
    const sent = list.filter(e => e.status === 'sent' && e.sent_at);
    if (!sent.length) return { action: 'stopped', reason: 'lost' };   // rejected/lost/reverted: nothing left to chase
    rcpt.estimate = sent[0];   // newest sent estimate feeds the copy + link
    return null;
  },
  // Invoice reminders (subject is the JOB). The balance is recomputed from
  // base tables EVERY run (never cached, never the pec_job_ar view: that view
  // is security_invoker + granted to authenticated only, so the service role
  // cannot rely on it): a partial payment keeps the reminders coming, a full
  // payment stops them the next tick.
  async invoice(sb, enr, rcpt) {
    const job = rcpt.job;
    if (job.voided_at || job.archived_at) return { action: 'stopped', reason: 'job_closed' };
    const pays = await sb('GET', `/pec_payments?job_id=eq.${encodeURIComponent(job.id)}&select=amount`);
    const paidToDate = (Array.isArray(pays) ? pays : []).reduce((s, p) => s + Number(p.amount || 0), 0);
    const balance = Number(job.price || 0) - paidToDate;
    if (balance <= BALANCE_EPS) return { action: 'stopped', reason: 'paid' };
    rcpt.balance = balance;   // the ONLY amount the copy may state
    return null;
  },
};

// Replied: ANY inbound text or call from this subject's person since
// enrollment, matched by customer_id or phone tail.
async function checkReplied(sb, enr, rcpt) {
  const since = encodeURIComponent(enr.enrolled_at);
  const tail = rcpt.phone_norm || phoneTail(rcpt.phone);
  const orParts = [];
  if (rcpt.customer_id) orParts.push(`customer_id.eq.${rcpt.customer_id}`);
  if (tail) orParts.push(`from_number.ilike.*${tail}`);
  if (!orParts.length) return null;
  const orQ = encodeURIComponent(`(${orParts.join(',')})`);
  const [smsIn, callIn] = await Promise.all([
    sb('GET', `/pec_sms_log?direction=eq.in&created_at=gt.${since}&or=${orQ}&select=id&limit=1`),
    sb('GET', `/pec_call_log?direction=eq.in&occurred_at=gt.${since}&or=${orQ}&select=id&limit=1`),
  ]);
  if ((Array.isArray(smsIn) && smsIn.length) || (Array.isArray(callIn) && callIn.length)) {
    return { action: 'stopped', reason: 'replied' };
  }
  return null;
}

async function checkKillSwitches(sb, enr, campaign, rcpt) {
  if (!rcpt || !rcpt.ok) return { action: 'stopped', reason: (rcpt && rcpt.reason) || 'lead_missing' };
  if (rcpt.optedOut) return { action: 'stopped', reason: 'opted_out' };
  if (enr.next_step_index >= campaign.max_touches) return { action: 'completed', reason: 'max_touches' };
  const kindCheck = await (KIND_CHECKS[campaign.kind] || KIND_CHECKS.lead)(sb, enr, rcpt);
  if (kindCheck) return kindCheck;
  return checkReplied(sb, enr, rcpt);
}

// The authoritative link/amount tail, appended by CODE after render + scrub
// (scrubCopy strips model URLs, so this is the only way a link ships).
// Returns { sms, text } or null; `text` is the email paragraph appended to
// the body (dripEmailHtml linkifies it).
function kindTail(kind, rcpt) {
  if (kind === 'estimate' && rcpt.estimate && rcpt.estimate.public_token) {
    const url = `${SITE_URL}/e/${rcpt.estimate.public_token}`;
    return { sms: ` View and sign your estimate: ${url}`, text: `View and sign your estimate here: ${url}` };
  }
  if (kind === 'invoice' && rcpt.job && rcpt.job.public_token) {
    const url = `${SITE_URL}/pay/${rcpt.job.public_token}`;
    const bal = rcpt.balance != null ? `Balance: ${usd(rcpt.balance)}. ` : '';
    return { sms: ` ${bal}Pay online: ${url}`, text: `${bal}Pay online here: ${url}` };
  }
  return null;
}

async function endEnrollment(sb, enr, action, reason, nowIso) {
  // Guard on status=active so a concurrent run's stop cannot fight this one.
  await sb('PATCH', `/pec_drip_enrollments?id=eq.${encodeURIComponent(enr.id)}&status=eq.active`, {
    status: action, stop_reason: reason, stopped_at: nowIso, next_send_at: null,
  });
}

// One master switch for everything outbound-automated: drips AND blasts.
async function masterSwitchOn(sb) {
  const sw = await sb('GET', `/settings?key=eq.drip_sending_enabled&select=value&limit=1`);
  return Array.isArray(sw) && !!sw[0] && sw[0].value === 'true';
}

// ---------------------------------------------------------------------------
// The runner. deps:
//   sb(method, path, payload, returnRow)   REST layer (service role)
//   now()                                  clock (tests freeze it)
//   renderCopy(lead, step, campaign, needs)  AI copy (tests stub it)
//   sendSms({from,to,content})             Quo (tests stub it)
//   sendEmail({from,to,subject,html,reply_to})  Resend (tests stub it)
// Returns a summary object (also what the scheduled function logs).
// ---------------------------------------------------------------------------
async function runDrips(deps) {
  const sb = deps.sb;
  const now = deps.now || (() => new Date());
  const renderCopy = deps.renderCopy || renderCopyReal;
  const sendSms = deps.sendSms || sendQuoSmsReal;
  const sendEmail = deps.sendEmail || sendResendEmailReal;
  const summary = {
    master_off: false, capped: false, checked: 0, sent: 0, dry_run: 0,
    skipped: 0, deferred: 0, stopped: 0, completed: 0, failed: 0, claimed_lost: 0,
  };

  // 1. Global master switch: anything but the string 'true' means OFF.
  if (!(await masterSwitchOn(sb))) {
    summary.master_off = true;
    return summary;
  }

  // 2. Due work, oldest first, hard per-run cap.
  const nowIso = now().toISOString();
  const due = await sb('GET',
    `/pec_drip_enrollments?status=eq.active&next_send_at=lte.${encodeURIComponent(nowIso)}&select=*&order=next_send_at.asc&limit=${RUN_CAP + 1}`);
  const list = Array.isArray(due) ? due : [];
  if (list.length > RUN_CAP) {
    summary.capped = true;
    console.log(`pec-drip-runner: per-run cap hit (${RUN_CAP}); remainder picked up next run`);
  }

  const campCache = {}, stepsCache = {}, smsSenderCache = {}, emailSenderCache = {};
  const getCampaign = async (id) => campCache[id] ||
    (campCache[id] = (await sb('GET', `/pec_drip_campaigns?id=eq.${encodeURIComponent(id)}&select=*&limit=1`))[0] || null);
  const getSteps = async (id) => stepsCache[id] ||
    (stepsCache[id] = (await sb('GET', `/pec_drip_steps?campaign_id=eq.${encodeURIComponent(id)}&active=eq.true&select=*&order=step_index.asc`)) || []);

  for (const enr of list.slice(0, RUN_CAP)) {
    summary.checked++;
    try {
      const campaign = await getCampaign(enr.campaign_id);
      if (!campaign) { await endEnrollment(sb, enr, 'stopped', 'campaign_missing', nowIso); summary.stopped++; continue; }
      if (campaign.status === 'paused') continue;   // holds in place; resumes when unpaused

      // Pre-backfill rows have no subject columns; fall back to lead_id.
      const subjectType = enr.subject_type || 'lead';
      const subjectId = enr.subject_id || enr.lead_id;
      const rcpt = await resolveRecipient(sb, subjectType, subjectId);

      // 3. Kill-switches at send time (universal core + per-kind adapter;
      // adapters attach copy context: rcpt.estimate / rcpt.balance).
      const kill = await checkKillSwitches(sb, enr, campaign, rcpt);
      if (kill) {
        await endEnrollment(sb, enr, kill.action, kill.reason, nowIso);
        summary[kill.action === 'completed' ? 'completed' : 'stopped']++;
        continue;
      }

      const steps = await getSteps(enr.campaign_id);
      const step = steps.find(s => s.step_index >= enr.next_step_index);
      if (!step) { await endEnrollment(sb, enr, 'completed', 'no_more_steps', nowIso); summary.completed++; continue; }

      // 4. Channel resolution for THIS recipient, this step (consent and
      // reachability were computed by resolveRecipient per subject model).
      const wantSms = step.channel === 'sms' || step.channel === 'both';
      const wantEmail = step.channel === 'email' || step.channel === 'both';
      const smsTo = rcpt.smsTo;
      const canSms = wantSms && rcpt.smsAllowed;
      const canEmail = wantEmail && rcpt.emailAllowed;
      const smsSkipReason = wantSms && !canSms ? rcpt.smsSkipReason : null;
      const emailSkipReason = wantEmail && !canEmail ? rcpt.emailSkipReason : null;

      // 5. Quiet hours: any live SMS leg due outside 8am-8pm Phoenix defers
      // the WHOLE step (sms+email stay a coherent pair) to the window open.
      // Dry-run ignores quiet hours so Dylan's review copy shows up promptly.
      if (canSms && campaign.mode === 'live') {
        const q = quietHours(now());
        if (!q.inWindow) {
          await sb('PATCH',
            `/pec_drip_enrollments?id=eq.${encodeURIComponent(enr.id)}&status=eq.active&next_step_index=eq.${enr.next_step_index}`,
            { next_send_at: q.nextOpen.toISOString() });
          summary.deferred++;
          continue;
        }
      }

      // 6. CLAIM (the atomic advance). Compute the post-step state first.
      const nextStep = steps.find(s => s.step_index > step.step_index);
      const willComplete = !nextStep || step.step_index + 1 >= campaign.max_touches;
      const claimPatch = willComplete
        ? { status: 'completed', stop_reason: 'sequence_complete', stopped_at: nowIso, next_step_index: step.step_index + 1, next_send_at: null }
        : { next_step_index: nextStep.step_index, next_send_at: addDays(enr.enrolled_at, nextStep.day_offset).toISOString() };
      const claimed = await sb('PATCH',
        `/pec_drip_enrollments?id=eq.${encodeURIComponent(enr.id)}&status=eq.active&next_step_index=eq.${enr.next_step_index}`,
        claimPatch, true);
      if (!Array.isArray(claimed) || !claimed.length) { summary.claimed_lost++; continue; } // another run owns this step
      if (willComplete) summary.completed++;

      const ledgerBase = {
        enrollment_id: enr.id, campaign_id: campaign.id,
        subject_type: subjectType, subject_id: subjectId,
        lead_id: subjectType === 'lead' ? subjectId : null,   // Phase 1 contact-count join
        step_index: step.step_index, scheduled_for: enr.next_send_at,
      };
      // Pre-Phase-3 schema fallback mirrors enrollSubject's: strip the
      // subject columns and retry, so a code-first deploy never loses rows.
      const writeLedger = (row) => sb('POST', '/pec_drip_sends', { ...ledgerBase, ...row })
        .catch(e => {
          if (subjectType === 'lead' && /subject_type|subject_id|PGRST204/i.test(String(e && e.message || e))) {
            const { subject_type, subject_id, ...legacy } = ledgerBase;
            return sb('POST', '/pec_drip_sends', { ...legacy, ...row })
              .catch(e2 => console.error('pec-drip: ledger write failed', e2.message));
          }
          console.error('pec-drip: ledger write failed', e.message);
        });

      // Wanted-but-unsendable legs are recorded, so the ledger explains gaps.
      if (smsSkipReason) { await writeLedger({ channel: 'sms', status: 'skipped', error_message: smsSkipReason }); summary.skipped++; }
      if (emailSkipReason) { await writeLedger({ channel: 'email', status: 'skipped', error_message: emailSkipReason }); summary.skipped++; }
      if (!canSms && !canEmail) continue;   // nothing sendable this step; schedule already advanced

      // 7. Render the copy (one model call per touch).
      let copy;
      try {
        copy = await renderCopy(rcpt, step, campaign, { sms: canSms, email: canEmail });
      } catch (err) {
        const msg = 'ai_render_failed: ' + String(err && err.message || err).slice(0, 400);
        if (canSms) await writeLedger({ channel: 'sms', status: 'failed', error_message: msg });
        if (canEmail) await writeLedger({ channel: 'email', status: 'failed', error_message: msg });
        summary.failed++;
        continue;   // step consumed; next touch continues the sequence
      }
      // The estimate link / balance + pay link tail is appended AFTER scrub
      // and AFTER the cap (with the cap shortened so the tail and STOP line
      // can never be truncated off). Data-owned facts, not model-owned.
      const tail = kindTail(campaign.kind, rcpt);
      let smsBody = canSms ? scrubCopy(copy.sms) : null;
      if (smsBody) {
        smsBody = tail
          ? capSms(smsBody, MAX_SMS_LEN - tail.sms.length - STOP_LINE.length) + tail.sms
          : capSms(smsBody);
      }
      const emailSubject = canEmail ? (scrubCopy(copy.email_subject) || step.email_subject || 'From Prescott Epoxy') : null;
      let emailBody = canEmail ? scrubCopy(copy.email_body) : null;
      if (emailBody && tail) emailBody = emailBody + '\n\n' + tail.text;

      // First DRIP SMS for this enrollment carries the STOP line (appended
      // once; dry_run rows count so the review copy matches what would send).
      if (smsBody) {
        const prior = await sb('GET',
          `/pec_drip_sends?enrollment_id=eq.${encodeURIComponent(enr.id)}&channel=eq.sms&status=in.(sent,dry_run)&select=id&limit=1`);
        if ((!Array.isArray(prior) || !prior.length) && !/\bSTOP\b/.test(smsBody)) smsBody += STOP_LINE;
      }

      // 8. Dry run: write the would-send copy, touch no provider, done.
      if (campaign.mode !== 'live') {
        if (smsBody) { await writeLedger({ channel: 'sms', status: 'dry_run', body: smsBody }); summary.dry_run++; }
        if (canEmail && emailBody) { await writeLedger({ channel: 'email', status: 'dry_run', subject: emailSubject, body: emailBody }); summary.dry_run++; }
        continue;
      }

      // 9. Live sends. Each leg records a ledger row AND mirrors into the
      // comms log (kind/template_key 'drip') so the conversation threads stay
      // complete; the Phase 1 contact counter EXCLUDES those mirror rows and
      // counts the ledger instead (the de-dupe rule).
      let anySent = false;
      if (smsBody) {
        const sender = await getSmsSender(sb, smsSenderCache);
        if (!sender || !sender.from_number) {
          await writeLedger({ channel: 'sms', status: 'failed', body: smsBody, error_message: 'no active SMS sender for brand' });
          summary.failed++;
        } else {
          let out;
          try { out = await sendSms({ from: sender.from_number, to: smsTo, content: smsBody }); }
          catch (err) { out = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
          await sb('POST', '/pec_sms_log', {
            direction: 'out', brand: DRIP_BRAND, from_number: sender.from_number, to_number: smsTo,
            customer_id: rcpt.customer_id, job_id: subjectType === 'job' ? subjectId : null,
            body: smsBody, kind: 'drip',
            status: out.ok ? 'sent' : 'failed', quo_message_id: out.id, error_message: out.error,
          }).catch(e => console.error('pec-drip: sms log failed', e.message));
          await writeLedger({ channel: 'sms', status: out.ok ? 'sent' : 'failed', body: smsBody, provider_id: out.id, sent_at: out.ok ? now().toISOString() : null, error_message: out.error });
          if (out.ok) { anySent = true; summary.sent++; } else summary.failed++;
        }
      }
      if (canEmail && emailBody) {
        const sender = await getEmailSender(sb, emailSenderCache);
        if (!sender || !sender.from_email) {
          await writeLedger({ channel: 'email', status: 'failed', subject: emailSubject, body: emailBody, error_message: 'no email sender for brand' });
          summary.failed++;
        } else {
          let out;
          try {
            out = await sendEmail({
              from: `${sender.from_name} <${sender.from_email}>`, to: rcpt.email,
              subject: emailSubject, html: dripEmailHtml(emailBody), reply_to: sender.reply_to || undefined,
            });
          } catch (err) { out = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
          await sb('POST', '/pec_email_log', {
            customer_id: rcpt.customer_id, job_id: subjectType === 'job' ? subjectId : null,
            brand: DRIP_BRAND, template_key: 'drip',
            to_email: rcpt.email, from_email: sender.from_email, subject: emailSubject,
            status: out.ok ? 'sent' : 'failed', resend_id: out.id, error_message: out.error,
          }).catch(e => console.error('pec-drip: email log failed', e.message));
          await writeLedger({ channel: 'email', status: out.ok ? 'sent' : 'failed', subject: emailSubject, body: emailBody, provider_id: out.id, sent_at: out.ok ? now().toISOString() : null, error_message: out.error });
          if (out.ok) { anySent = true; summary.sent++; } else summary.failed++;
        }
      }

      // 10. First-touch stamp, only when null (contacted_at is a write-once
      // first-contact column; speed-to-lead depends on it). Dry runs never
      // touch it. Lead subjects only (estimate drips still count: they go to
      // the lead); job subjects have no lead row to stamp.
      if (anySent && rcpt.lead && !rcpt.lead.contacted_at) {
        await sb('PATCH', `/leads?id=eq.${encodeURIComponent(rcpt.lead.id)}&contacted_at=is.null`, { contacted_at: now().toISOString() })
          .catch(e => console.error('pec-drip: contacted_at stamp failed', e.message));
      }
    } catch (err) {
      // One enrollment's failure never takes down the run.
      console.error('pec-drip-runner: enrollment', enr.id, 'failed:', err && err.message || err);
      summary.failed++;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// BLASTS (prompt 35 Part D). A blast is ONE composed message to a chosen
// audience, not an enrolled sequence, so it never touches the runner loop.
// The wizard materializes every recipient as a status 'queued' pec_drip_sends
// row (blast_id set, enrollment_id null) at confirm time; that queue IS the
// resume mechanism and the no-double-send guard: the drain only ever
// processes 'queued' rows, claims each one (queued -> 'sending', the same
// conditional-PATCH atomicity as the runner), and a crashed pass leaves rows
// it claimed as 'sending' for the stall sweep to mark failed. A stalled row
// is NEVER re-queued (the send may have landed; non-idempotent-write rule).
// ---------------------------------------------------------------------------
const BLAST_BATCH = 25;                   // rows per blast per pass; separate from RUN_CAP so a big blast never starves the drips
const BLAST_STALL_MS = 60 * 60 * 1000;    // 'sending' rows older than this are failed, never re-sent

// Pure audience math, shared verbatim with the wizard in index.html so the
// count Dylan confirms is computed by the SAME rules the queue insert uses.
// candidates: [{source:'lead'|'customer', id, name/full_name, first_name,
//   phone, phone_norm, email, sms_consent, email_consent, opted_out,
//   sms_opt_out}]. channel: 'sms'|'email'|'both'.
// Consent hard-filter FIRST (leads need positive sms_consent and not
// opted_out; customers are opt-out only), then de-dupe by phone tail and
// lowercased email. Leads are processed first so on a collision the LEAD
// wins and the send keeps lead attribution (contact counts).
function computeBlastAudience(candidates, channel) {
  const wantSms = channel === 'sms' || channel === 'both';
  const wantEmail = channel === 'email' || channel === 'both';
  const recipients = [];
  let removedConsent = 0, removedDupes = 0;
  const seenPhones = new Set(), seenEmails = new Set();
  const ordered = [
    ...candidates.filter(c => c.source === 'lead'),
    ...candidates.filter(c => c.source !== 'lead'),
  ];
  for (const c of ordered) {
    const isLead = c.source === 'lead';
    const smsTo = toE164(c.phone);
    const tail = c.phone_norm || phoneTail(c.phone);
    const emailLc = c.email ? String(c.email).trim().toLowerCase() : null;
    const optedOut = isLead ? !!c.opted_out : false;
    const smsOk = wantSms && !optedOut && !!smsTo && (isLead ? !!c.sms_consent : !c.sms_opt_out);
    const emailOk = wantEmail && !optedOut && !!emailLc && (isLead ? c.email_consent !== false : true);
    if (!smsOk && !emailOk) { removedConsent++; continue; }
    if ((tail && seenPhones.has(tail)) || (emailLc && seenEmails.has(emailLc))) { removedDupes++; continue; }
    if (tail) seenPhones.add(tail);
    if (emailLc) seenEmails.add(emailLc);
    const name = c.name || c.full_name || null;
    recipients.push({
      key: (isLead ? 'lead:' : 'customer:') + c.id,
      source: isLead ? 'lead' : 'customer',
      id: c.id, name,
      first_name: c.first_name || (name ? String(name).split(/\s+/)[0] : null),
      smsOk, emailOk, phone: c.phone || null, smsTo, email: c.email || null,
    });
  }
  return { recipients, removedConsent, removedDupes };
}

// The drain. Two callers, one engine: the 15-min scheduled tick (safety net +
// resume after crash / quiet hours / master switch flipped on later) and
// pec-blast-run.cjs (the "send now" kick right after confirm). deps as
// runDrips; opts.blastId scopes to one blast.
// Quiet hours: outside 8am-8pm Phoenix only email rows are claimed; SMS rows
// simply stay queued for the next in-window pass. Blasts have no dry_run
// (the human confirm IS the review gate), so this applies unconditionally.
// Consent is RE-CHECKED at send time from the live lead/customer row: a STOP
// that lands between confirm and send wins ('opted_out_after_queue').
async function drainBlasts(deps, opts = {}) {
  const sb = deps.sb;
  const now = deps.now || (() => new Date());
  const sendSms = deps.sendSms || sendQuoSmsReal;
  const sendEmail = deps.sendEmail || sendResendEmailReal;
  const summary = { master_off: false, blasts: 0, sent: 0, failed: 0, skipped: 0, stalled: 0, done: 0, sms_held_quiet: false };
  if (!(await masterSwitchOn(sb))) { summary.master_off = true; return summary; }

  const nowIso = now().toISOString();
  const q = quietHours(now());
  const idFilter = opts.blastId ? `&id=eq.${encodeURIComponent(opts.blastId)}` : '';
  const blasts = await sb('GET', `/pec_blasts?status=in.(confirmed,sending)${idFilter}&select=*&order=confirmed_at.asc`);
  const smsSenderCache = {}, emailSenderCache = {};

  for (const blast of (Array.isArray(blasts) ? blasts : [])) {
    summary.blasts++;
    const bid = encodeURIComponent(blast.id);
    try {
      if (blast.status === 'confirmed') {
        await sb('PATCH', `/pec_blasts?id=eq.${bid}&status=eq.confirmed`, { status: 'sending' });
      }

      // Stall sweep: rows a crashed pass left in 'sending' (scheduled_for is
      // re-stamped at claim, so it doubles as the claim timestamp).
      const stallIso = new Date(now().getTime() - BLAST_STALL_MS).toISOString();
      const stalled = await sb('PATCH',
        `/pec_drip_sends?blast_id=eq.${bid}&status=eq.sending&scheduled_for=lte.${encodeURIComponent(stallIso)}`,
        { status: 'failed', error_message: 'stalled after claim; never auto-resent (the first send may have landed)' }, true);
      if (Array.isArray(stalled)) summary.stalled += stalled.length;

      const chanFilter = q.inWindow ? '' : '&channel=eq.email';
      if (!q.inWindow) summary.sms_held_quiet = true;
      const queued = await sb('GET',
        `/pec_drip_sends?blast_id=eq.${bid}&status=eq.queued${chanFilter}&select=*&order=created_at.asc&limit=${BLAST_BATCH}`);
      const rows = Array.isArray(queued) ? queued : [];

      // Live subject rows for the send-time consent re-check + destination
      // (the destination is deliberately NOT frozen into the queue row, so a
      // phone/email fixed between confirm and send is honored).
      const leadIds = [...new Set(rows.filter(r => r.subject_type === 'lead').map(r => r.subject_id))];
      const custIds = [...new Set(rows.filter(r => r.subject_type === 'customer').map(r => r.subject_id))];
      const [leadRows, custRows] = await Promise.all([
        leadIds.length ? sb('GET', `/leads?id=in.(${leadIds.join(',')})&select=id,phone,email,opted_out,sms_consent,email_consent,customer_id,deleted_at`) : [],
        custIds.length ? sb('GET', `/customers?id=in.(${custIds.join(',')})&select=id,phone,email,sms_opt_out`) : [],
      ]);
      const subjMap = new Map([
        ...(Array.isArray(leadRows) ? leadRows : []).map(r => ['lead:' + r.id, r]),
        ...(Array.isArray(custRows) ? custRows : []).map(r => ['customer:' + r.id, r]),
      ]);

      for (const row of rows) {
        // CLAIM: queued -> sending, conditional on still being queued.
        const claimed = await sb('PATCH', `/pec_drip_sends?id=eq.${encodeURIComponent(row.id)}&status=eq.queued`,
          { status: 'sending', scheduled_for: nowIso }, true);
        if (!Array.isArray(claimed) || !claimed.length) continue;   // another pass owns it

        const finalize = (patch) => sb('PATCH', `/pec_drip_sends?id=eq.${encodeURIComponent(row.id)}`, patch)
          .catch(e => console.error('pec-blast: finalize failed', e.message));

        const subj = subjMap.get(row.subject_type + ':' + row.subject_id);
        const isLead = row.subject_type === 'lead';
        const gone = !subj || (isLead && subj.deleted_at);
        const optedNow = gone
          || (isLead && (subj.opted_out || (row.channel === 'sms' && !subj.sms_consent) || (row.channel === 'email' && subj.email_consent === false)))
          || (!isLead && row.channel === 'sms' && subj.sms_opt_out);
        if (optedNow) {
          await finalize({ status: 'skipped', error_message: gone ? 'recipient_missing' : 'opted_out_after_queue' });
          summary.skipped++; continue;
        }
        const customerId = isLead ? (subj.customer_id || null) : row.subject_id;

        let out;
        if (row.channel === 'sms') {
          const to = toE164(subj.phone);
          if (!to) { await finalize({ status: 'skipped', error_message: 'no_valid_phone' }); summary.skipped++; continue; }
          const sender = await getSmsSender(sb, smsSenderCache);
          if (!sender || !sender.from_number) {
            await finalize({ status: 'failed', error_message: 'no active SMS sender for brand' });
            summary.failed++; continue;
          }
          try { out = await sendSms({ from: sender.from_number, to, content: row.body }); }
          catch (err) { out = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
          await sb('POST', '/pec_sms_log', {
            direction: 'out', brand: DRIP_BRAND, from_number: sender.from_number, to_number: to,
            customer_id: customerId, body: row.body, kind: 'blast',
            status: out.ok ? 'sent' : 'failed', quo_message_id: out.id, error_message: out.error,
          }).catch(e => console.error('pec-blast: sms log failed', e.message));
        } else {
          const to = subj.email;
          if (!to) { await finalize({ status: 'skipped', error_message: 'no_email' }); summary.skipped++; continue; }
          const sender = await getEmailSender(sb, emailSenderCache);
          if (!sender || !sender.from_email) {
            await finalize({ status: 'failed', error_message: 'no email sender for brand' });
            summary.failed++; continue;
          }
          try {
            out = await sendEmail({
              from: `${sender.from_name} <${sender.from_email}>`, to,
              subject: row.subject || 'From Prescott Epoxy', html: dripEmailHtml(row.body),
              reply_to: sender.reply_to || undefined,
            });
          } catch (err) { out = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
          await sb('POST', '/pec_email_log', {
            customer_id: customerId, brand: DRIP_BRAND, template_key: 'blast',
            to_email: to, from_email: sender.from_email, subject: row.subject || null,
            status: out.ok ? 'sent' : 'failed', resend_id: out.id, error_message: out.error,
          }).catch(e => console.error('pec-blast: email log failed', e.message));
        }
        await finalize({ status: out.ok ? 'sent' : 'failed', sent_at: out.ok ? now().toISOString() : null, provider_id: out.id, error_message: out.error });
        if (out.ok) summary.sent++; else summary.failed++;
      }

      // Rollup onto the header (guarded so a concurrent Cancel is never
      // overwritten). done = nothing queued AND nothing mid-claim.
      const all = await sb('GET', `/pec_drip_sends?blast_id=eq.${bid}&select=status`);
      const counts = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0, dry_run: 0 };
      (Array.isArray(all) ? all : []).forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
      const remaining = counts.queued + counts.sending;
      await sb('PATCH', `/pec_blasts?id=eq.${bid}&status=in.(confirmed,sending)`, {
        total_sent: counts.sent, total_failed: counts.failed, total_skipped: counts.skipped,
        ...(remaining === 0 ? { status: 'done', completed_at: nowIso } : {}),
      });
      if (remaining === 0) summary.done++;
    } catch (err) {
      console.error('pec-blast: blast', blast.id, 'failed:', err && err.message || err);
    }
  }
  return summary;
}

module.exports = {
  runDrips, drainBlasts, computeBlastAudience, enrollLead, enrollEstimateDrip,
  enrollJobInvoiceDrip, enrollSubject, resolveRecipient, checkKillSwitches,
  masterSwitchOn, kindTail, quietHours, toE164, phoneTail, scrubCopy, capSms,
  usd, dripEmailHtml, buildRenderPrompt, RENDER_SYSTEM_PROMPT,
  RENDER_SYSTEM_PROMPTS, RUN_CAP, BLAST_BATCH, STOP_LINE, SITE_URL,
};
