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

// Prompt 45: the invoice adapter resolves the CURRENT ask through the shared
// installment resolver (one-way require; _pec-installments never requires
// this module, its runner takes the provider helpers via injected deps).
const { resolveCurrentAsk } = require('./_pec-installments.cjs');

const RUN_CAP = 25;               // enrollments per run; taper is day-grained so backlog clears fast
const MAX_SMS_LEN = 480;          // hard cap on AI SMS copy (~3 segments)
const PHX_OFFSET_MS = 7 * 60 * 60 * 1000;   // America/Phoenix, fixed UTC-7 (no DST)
// Quiet-hours defaults (prompt 42: the window is now settings-driven; these
// apply when the settings rows are missing or unparseable). Minutes since
// midnight Phoenix; days are JS getDay() numbers (0=Sun). Mon-Sat 8am-8pm.
const DEFAULT_QUIET = { startMin: 8 * 60, endMin: 20 * 60, days: [1, 2, 3, 4, 5, 6] };
const QUIET_DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
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
// nextOpen is the next window open as a Date (only meaningful when
// !inWindow). cfg is a parsed quiet config ({ startMin, endMin, days });
// callers with a live DB get one from getDripConfig(sb) so the window is
// adjustable from company Settings; the default keeps the pre-prompt-42
// behavior for direct callers and tests.
function quietHours(now, cfg = DEFAULT_QUIET) {
  const days = (Array.isArray(cfg.days) && cfg.days.length) ? cfg.days : DEFAULT_QUIET.days;
  const phx = new Date(now.getTime() - PHX_OFFSET_MS);   // wall clock via UTC getters
  const minOfDay = phx.getUTCHours() * 60 + phx.getUTCMinutes();
  const inWindow = days.includes(phx.getUTCDay()) && minOfDay >= cfg.startMin && minOfDay < cfg.endMin;
  if (inWindow) return { inWindow, nextOpen: null };
  // Walk forward day by day (Phoenix wall clock) to the first allowed day
  // whose window open is still in the future. 8-day scan covers any day set.
  for (let d = 0; d <= 7; d++) {
    const cand = new Date(Date.UTC(phx.getUTCFullYear(), phx.getUTCMonth(), phx.getUTCDate() + d, 0, cfg.startMin, 0));
    if (!days.includes(cand.getUTCDay())) continue;
    const open = new Date(cand.getTime() + PHX_OFFSET_MS);
    if (open.getTime() > now.getTime()) return { inWindow, nextOpen: open };
  }
  return { inWindow, nextOpen: new Date(now.getTime() + 24 * 60 * 60 * 1000) };  // unreachable with a sane config
}

// Parse the quiet-hours settings rows into the cfg quietHours() takes.
// Malformed values fall back per-field to the defaults; an inverted window
// (end <= start) falls back whole, because honoring it would either always
// or never send.
function parseQuietSettings(rows) {
  const map = Object.fromEntries((Array.isArray(rows) ? rows : []).map(r => [r.key, r.value]));
  const toMin = (v, dflt) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    if (!m) return dflt;
    const min = Number(m[1]) * 60 + Number(m[2]);
    return min >= 0 && min < 1440 ? min : dflt;
  };
  let startMin = toMin(map.drip_quiet_start, DEFAULT_QUIET.startMin);
  let endMin = toMin(map.drip_quiet_end, DEFAULT_QUIET.endMin);
  if (endMin <= startMin) { startMin = DEFAULT_QUIET.startMin; endMin = DEFAULT_QUIET.endMin; }
  let days = DEFAULT_QUIET.days;
  if (map.drip_quiet_days != null && String(map.drip_quiet_days).trim() !== '') {
    const parsed = [...new Set(String(map.drip_quiet_days).toLowerCase().split(',')
      .map(s => QUIET_DAY_KEYS.indexOf(s.trim())).filter(d => d >= 0))].sort();
    if (parsed.length) days = parsed;
  }
  return { startMin, endMin, days };
}

// One read for everything prompt 42 made adjustable: the approval gate and
// the quiet-hours window. Missing rows read as the safe defaults (gate off,
// Mon-Sat 8am-8pm), so pre-migration schemas keep exact Phase-3 behavior.
async function getDripConfig(sb) {
  let rows = [];
  try {
    rows = await sb('GET', '/settings?key=in.(drip_approval_required,drip_quiet_start,drip_quiet_end,drip_quiet_days)&select=key,value');
  } catch (err) {
    console.warn('pec-drip: settings read failed, using defaults:', String(err && err.message || err));
  }
  const map = Object.fromEntries((Array.isArray(rows) ? rows : []).map(r => [r.key, r.value]));
  return { approvalRequired: map.drip_approval_required === 'true', quiet: parseQuietSettings(rows) };
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
// scrubCopy strips every model URL on purpose; the configured booking link
// (prompt 73) is the ONE exception. Swap it for an opaque token, scrub, swap
// back, so the exact configured URL survives and everything else still dies.
function scrubCopyKeepUrl(text, keepUrl) {
  if (text == null) return null;
  if (!keepUrl || !String(text).includes(keepUrl)) return scrubCopy(text);
  const TOKEN = 'XQKEEPURLQX';
  const scrubbed = scrubCopy(String(text).split(keepUrl).join(TOKEN));
  return scrubbed ? scrubbed.split(TOKEN).join(keepUrl) : scrubbed;
}

// ---------------------------------------------------------------------------
// Fixed-template rendering (prompt 73). A step with fixed_template set sends
// that text verbatim after token substitution, with ZERO model calls: the
// day-0 instant touch is instant by construction and Dylan read the exact
// words once, so no AI belongs anywhere near it.
// Tokens: {first_name} (falls back to 'there'), {booking_link}. The
// {{#booking_link}}...{{/booking_link}} block survives only when a booking
// URL is configured: dropping the whole sentence at the template level is a
// hard requirement, so an empty setting can never ship "...right here:" with
// a dangling colon.
// ---------------------------------------------------------------------------
function renderFixedTemplate(tpl, ctx = {}) {
  if (tpl == null) return null;
  const link = String(ctx.booking_link || '').trim();
  const s = String(tpl)
    .replace(/\{\{#booking_link\}\}([\s\S]*?)\{\{\/booking_link\}\}/g, link ? '$1' : '')
    .replace(/\{booking_link\}/g, link)
    .replace(/\{first_name\}/g, String(ctx.first_name || '').trim() || 'there')
    .replace(/\s*[—–]\s*/g, ', ')      // standing rule 6, enforced in code
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return s || null;
}

// The booking link lives in ONE settings row (rule 12: editable in Settings,
// never a deploy). Prompt 101 renamed the key routemize_booking_url ->
// booking_url when TopCoat's own /book page replaced Routemize; the old key
// is still read as a fallback so nothing breaks if only it holds a value.
// Empty / missing / unreadable all read as "no link", which the template
// conditional and the render prompt both degrade around.
async function getBookingUrl(sb) {
  try {
    const rows = await sb('GET', `/settings?key=in.(booking_url,routemize_booking_url)&select=key,value`);
    const map = {};
    for (const r of (Array.isArray(rows) ? rows : [])) map[r.key] = String(r.value || '').trim();
    return map.booking_url || map.routemize_booking_url || null;
  } catch (_) { return null; }
}

// A model hallucinating a booking URL sends a customer to a 404 with our name
// on it: any routemize.com URL in rendered lead copy must be character-
// identical to the configured one (trailing sentence punctuation tolerated),
// and NO routemize.com URL may appear when none is configured.
function bookingUrlViolation(text, configuredUrl) {
  if (!text) return false;
  const found = String(text).match(/https?:\/\/[^\s"'<>)\]]*routemize\.com[^\s"'<>)\]]*/gi) || [];
  return found.some(u => u.replace(/[.,;:!?]+$/, '') !== (configuredUrl || ' none'));
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
- Do not include links, phone numbers, or email addresses in the message text, with ONE exception: when a BOOKING LINK is provided below the instruction, include it exactly as given, once, near the end of the message. Never modify it, never shorten it, never invent a URL, and never mention booking online if no link is provided.
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

// Review asks live under Google's review policies, so two rules here are
// legal-shaped, not stylistic: nothing of value is ever offered in exchange
// for a review, and the ask is never conditioned on the review being positive
// (no rating gating). reviewCopyViolation() enforces the incentive rule
// mechanically after the render, the same belt-and-suspenders posture as
// scrubCopy for links and em dashes.
const RENDER_SYSTEM_PROMPT_REVIEW = `You write short thank-you and review-request messages from Prescott Epoxy Company (PEC), an epoxy floor coating company in Prescott, Arizona, to a customer whose floor job is complete. You get the job facts and one instruction for this touch. Hard rules:
- Use ONLY facts present in the record. NEVER invent details about the job, prices, discounts, dates, warranties, named customers, reviews, or statistics.
- Mention the crew leader by name ONLY when crew_lead in the record is a non-empty name. When crew_lead is null or empty, refer to the crew generally with no name, and NEVER write the word null or leave a blank where a name would go.
- NEVER offer anything of value in exchange for a review: no discounts, gift cards, refunds, entries, or freebies of any kind. Never make the ask conditional on the review being positive, and never suggest an unhappy customer contact you instead of reviewing.
- Do not use em dashes or en dashes anywhere.
- Do not include links, phone numbers, or email addresses in the message text. The system appends the review link automatically after your message.
- Tone: warm, grateful, brief, zero corporate filler, no emoji, no pressure.
- Use the customer's first name when one is available; otherwise no name.
- sms: 1 to 3 sentences, under 250 characters, identify Prescott Epoxy by name.
- email_body: 2 to 5 short sentences in plain paragraphs (separate paragraphs with a blank line), signed off as "the Prescott Epoxy team". No subject line inside the body.
- email_subject: short and plain; if a suggested subject is provided, use it or a light variation.
Respond with ONLY a JSON object, no markdown fences: {"sms": <string or null>, "email_subject": <string or null>, "email_body": <string or null>}. Produce only the channels requested; set the others null.`;

const RENDER_SYSTEM_PROMPTS = {
  lead: RENDER_SYSTEM_PROMPT,
  estimate: RENDER_SYSTEM_PROMPT_ESTIMATE,
  invoice: RENDER_SYSTEM_PROMPT_INVOICE,
  review: RENDER_SYSTEM_PROMPT_REVIEW,
};

// Mechanical enforcement of the no-incentives rule for review copy (landmine
// 10): a leg that trips this is DROPPED (recorded as failed), never rewritten,
// because a rewrite could invert the meaning. Deliberately review-only: dollar
// amounts and "discount" are legitimate words in invoice copy.
const REVIEW_INCENTIVE_RE = /\b(discount|coupon|gift\s*card|raffle|giveaway|sweepstakes?|refund|%\s?off|free\b[^.!?]{0,40}\b(upgrade|service|coating|cleaning|gift|estimate))\b|\$\d/i;
function reviewCopyViolation(text) {
  return !!(text && REVIEW_INCENTIVE_RE.test(String(text)));
}

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
      // Prompt 45 (decision 10): with a payment schedule, `balance` is the
      // CURRENT outstanding ask (deposit or installment), not the full
      // remaining balance; payment_label carries its milestone context.
      balance: ctx.balance != null ? usd(ctx.balance) : null,
      payment_label: ctx.askLabel || null,
      job_address: ctx.job.address || null,
      invoice_sent_days_ago: daysAgo(ctx.job.invoice_first_sent_at),
    };
    touchLine = `THIS TOUCH: step ${step.step_index + 1} of ${campaign.max_touches} in the "${campaign.name}" sequence, day ${step.day_offset} after their invoice went out.`;
  } else if (kind === 'review' && ctx.job) {
    // crew_lead comes from the pec_review_requests SNAPSHOT (decision 9),
    // never re-read from the live schedule. An explicit null tells the model
    // to use the generic no-name wording.
    const req = ctx.reviewRequest || {};
    recordLabel = 'JOB RECORD (the only fact source):';
    record = {
      first_name: ctx.first_name,
      crew_lead: req.crew_lead || null,
      job_address: ctx.job.address || null,
      completed_days_ago: daysAgo(req.job_completed_date || ctx.job.completed_date),
    };
    touchLine = `THIS TOUCH: step ${step.step_index + 1} of ${campaign.max_touches} in the "${campaign.name}" sequence, day ${step.day_offset} after we asked them for a review.`;
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
  // Prompt 73: lead-nurture touches may carry the configured Routemize
  // booking link (rule in the lead system prompt; bookingUrlViolation +
  // scrubCopyKeepUrl enforce exactness downstream). Lead campaigns only:
  // estimate/invoice/review keep their code-appended tails.
  const bookingLine = (kind === 'lead' && ctx.bookingUrl)
    ? `BOOKING LINK (include exactly as given, once, near the end): ${ctx.bookingUrl}` : '';
  return [
    recordLabel,
    JSON.stringify(record),
    '',
    touchLine,
    `INSTRUCTION FOR THIS TOUCH: ${step.ai_guidance}`,
    bookingLine,
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
  // Prompt 73: on the lead campaign, any routemize.com URL the model wrote
  // must be character-identical to the configured booking link (and none may
  // appear when no link is configured). A violation is a FAILED render, never
  // a rewrite: under the gate the step re-renders next tick, live it records
  // failed, and a wrong URL never ships either way.
  const kind = campaign.kind || 'lead';
  const bookingUrl = kind === 'lead' ? (ctx.bookingUrl || null) : null;
  if (kind === 'lead') {
    for (const f of ['sms', 'email_subject', 'email_body']) {
      if (bookingUrlViolation(obj[f], bookingUrl)) {
        throw new Error(`booking_url_mismatch: rendered ${f} carries a routemize.com URL that is not the configured booking link`);
      }
    }
  }
  const sms = capSms(scrubCopyKeepUrl(obj.sms, bookingUrl));
  // A capped SMS must never ship half a URL: a truncated booking link is the
  // same 404 the validation above exists to prevent.
  if (bookingUrl && obj.sms && String(obj.sms).includes(bookingUrl) && (!sms || !sms.includes(bookingUrl))) {
    throw new Error('booking_url_truncated: SMS cap cut the booking link');
  }
  return {
    sms,
    email_subject: scrubCopy(obj.email_subject), // subjects never carry links
    email_body: scrubCopyKeepUrl(obj.email_body, bookingUrl),
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

// Prompt 81: CTA accent for the drip render, from pec_brand_identity.
// Memoized per function instance (a brand-color edit shows up on the next
// cold start, which is fine for a color); falls back to the historical
// orange when the row is missing or the fetch fails.
const DRIP_FALLBACK_ACCENT = '#D8531C';
let _brandAccentMemo = null;
async function getBrandAccent(sb) {
  if (_brandAccentMemo) return _brandAccentMemo;
  try {
    const rows = await sb('GET', `/pec_brand_identity?brand=eq.${DRIP_BRAND}&select=accent_color&limit=1`);
    const c = Array.isArray(rows) && rows[0] && rows[0].accent_color;
    if (c) _brandAccentMemo = c;
  } catch (_) { /* fallback below */ }
  return _brandAccentMemo || DRIP_FALLBACK_ACCENT;
}

// Prompt 81: the code-appended tails (kindTail + the installment reminder)
// render as a lead-in sentence with a centered accent button beneath it,
// naked URL stripped from the visible email. ONLY this HTML render is
// upgraded: the ledger keeps the plain-text 'View and sign your estimate
// here: <url>' verbatim as the audit record, and the SMS leg is untouched.
// A tail edited in Drip Approvals that no longer matches a pattern falls
// through to the plain linkified render. The review /r/ URL lands in the
// button href byte-for-byte or click logging silently breaks.
const DRIP_TAIL_BUTTONS = [
  { re: /^View and sign your estimate here:\s*(https?:\/\/\S+)$/, label: 'View &amp; sign your estimate' },
  { re: /^(?:(?:Amount due now|Balance):\s*\$[\d,.]+\.\s*)?Pay online here:\s*(https?:\/\/\S+)$/, label: 'Pay online' },
  { re: /^View your invoice and pay online here:\s*(https?:\/\/\S+)$/, label: 'Pay online' },
  { re: /^Leave a review here:\s*(https?:\/\/\S+)$/, label: 'Leave a review' },
];

// Drip emails deliberately look like a short personal note, NOT the branded
// invoice chrome (wrapInChrome in pec-send-email.cjs): a heavy header on a
// "just checking in" email reads as a blast. Plain paragraphs, name signature,
// a human opt-out line. The reply goes to the brand's reply_to inbox; email
// replies are not machine-tracked (the replied kill-switch reads SMS/call
// logs), so the opt-out line invites a reply that staff acts on with the
// Stop drip button.
// opts.accent: CTA/link color (callers pass await getBrandAccent(sb)).
// opts.blast: apply the blast promotion rule instead of the tail patterns --
// a body that ends with its ONLY url gets that url promoted to a button;
// two or more urls anywhere stay inline (stacked buttons mid-blast read as
// broken).
function dripEmailHtml(bodyText, opts = {}) {
  const accent = opts.accent || DRIP_FALLBACK_ACCENT;
  const linkify = (s) => s.replace(/(https?:\/\/[^\s<]+)/g, `<a href="$1" style="color:${escHtml(accent)}">$1</a>`);
  const button = (url, label) => `<p style="text-align:center;margin:22px 0"><a href="${escHtml(url)}" style="display:inline-block;background:${escHtml(accent)};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">${label}</a></p>`;
  const plainPara = (t) => `<p style="margin:0 0 14px">${linkify(escHtml(t)).replace(/\n/g, '<br>')}</p>`;
  const rawParas = String(bodyText || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  let paras;
  if (opts.blast) {
    const urls = String(bodyText || '').match(/https?:\/\/[^\s<]+/g) || [];
    const lastIdx = rawParas.length - 1;
    const endMatch = lastIdx >= 0 ? rawParas[lastIdx].match(/^([\s\S]*?)\s*(https?:\/\/\S+)$/) : null;
    if (urls.length === 1 && endMatch) {
      const url = endMatch[2];
      const label = url.includes('/e/') ? 'View &amp; sign your estimate'
        : url.includes('/pay/') ? 'Pay online'
        : url.includes('/r/') ? 'Leave a review'
        : 'Open the link';
      paras = rawParas.slice(0, lastIdx).map(plainPara).join('')
        + (endMatch[1] ? plainPara(endMatch[1]) : '')
        + button(url, label);
    } else {
      paras = rawParas.map(plainPara).join('');
    }
  } else {
    paras = rawParas.map(p => {
      for (const t of DRIP_TAIL_BUTTONS) {
        const m = p.match(t.re);
        if (m) {
          const url = m[1];
          const leadIn = p.slice(0, p.length - url.length).trim();
          return (leadIn ? `<p style="margin:0 0 14px">${escHtml(leadIn)}</p>` : '') + button(url, t.label);
        }
      }
      return plainPara(p);
    }).join('');
  }
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
// opts.minStepIndex (prompt 73): start the enrollment at the first active
// step at or past that index instead of the campaign's very first step. The
// cancel/no-show re-engagement and the backlog enrollment both start at step
// 1 on purpose: the day-0 instant touch is a fresh-inquiry auto-reply, and
// "thanks for reaching out" to someone who inquired weeks ago (or whose
// appointment just fell through) reads as broken.
async function enrollSubject(sb, kind, subjectType, subjectId, leadId, now, opts = {}) {
  try {
    // Prompt 62 Part D: an archived lead never (re-)enrolls in any drip.
    // Mirrors the client guard in index.html enrollSubjectInDrip.
    if (leadId) {
      const lr = await sb('GET', `/leads?id=eq.${encodeURIComponent(leadId)}&select=archived_at&limit=1`);
      const lead = Array.isArray(lr) ? lr[0] : null;
      if (lead && lead.archived_at) return { enrolled: false, reason: 'archived' };
    }
    const camps = await sb('GET', `/pec_drip_campaigns?kind=eq.${kind}&status=eq.active&select=id&order=created_at.asc&limit=1`);
    const camp = Array.isArray(camps) ? camps[0] : null;
    if (!camp) return { enrolled: false, reason: 'no_active_campaign' };
    const minIdx = Number(opts.minStepIndex) || 0;
    const steps = await sb('GET', `/pec_drip_steps?campaign_id=eq.${encodeURIComponent(camp.id)}&active=eq.true&step_index=gte.${minIdx}&select=step_index,day_offset&order=step_index.asc&limit=1`);
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

async function enrollLead(sb, leadId, now = new Date(), opts = {}) {
  return enrollSubject(sb, 'lead', 'lead', leadId, leadId, now, opts);
}

// ---------------------------------------------------------------------------
// THE INSTANT TOUCH (prompt 73 Part D). Fires INLINE in pec-lead-intake.cjs
// immediately after enrollLead, in the same request; never on the runner tick
// (the runner's auto_send branch is only the crash safety net). Same contract
// as enrollLead: NEVER throws, returns a result object, and a failure can
// never fail the intake response back to Zapier.
//
// What it bypasses, and ONLY these two: the approval gate
// (drip_approval_required) and quiet hours. Everything else applies in full:
// kill switch, master switch, per-channel consent, opt-out, archived.
//
// Concurrency: CLAIM-FIRST, the engine's own model. Step 0 has day_offset 0,
// so the enrollment is due IMMEDIATELY and a runner tick could race this
// call; the conditional next_step_index 0 -> 1 advance is the atomic claim,
// so whoever wins it owns the send and a double-text is impossible (the
// prompt sketched send-then-advance; claim-first is strictly stronger and is
// the tradeoff the whole engine already made: never-double-text beats
// never-lose-a-touch). The step-0 ledger check doubles as the Zapier-retry
// guard and makes the skip reason explicit.
// ---------------------------------------------------------------------------
async function sendInstantTouch(sb, leadId, opts = {}) {
  const now = opts.now || (() => new Date());
  const senders = {
    sendSms: (opts.senders && opts.senders.sendSms) || sendQuoSmsReal,
    sendEmail: (opts.senders && opts.senders.sendEmail) || sendResendEmailReal,
  };
  const out = { attempted: false, sent: [], skipped: [], failed: [], reason: null };
  const done = (reason) => {
    out.reason = reason;
    if (reason) console.log(`sendInstantTouch: lead ${leadId} -> ${reason}`);
    return out;
  };
  try {
    // Preconditions, in order, each with its own logged reason.
    const rows = await sb('GET', '/settings?key=in.(drip_instant_touch_enabled,drip_sending_enabled,drip_kill_switch,routemize_booking_url)&select=key,value');
    const map = Object.fromEntries((Array.isArray(rows) ? rows : []).map(r => [r.key, r.value]));
    if (map.drip_instant_touch_enabled !== 'true') return done('instant_touch_disabled');
    if (map.drip_sending_enabled !== 'true') return done('master_off');       // the global masters
    if (map.drip_kill_switch === 'true') return done('kill_switch');          // still outrank everything

    const id = encodeURIComponent(leadId);
    const enrs = await sb('GET', `/pec_drip_enrollments?lead_id=eq.${id}&status=eq.active&select=*`);
    const enrList = Array.isArray(enrs) ? enrs : [];
    if (!enrList.length) return done('not_enrolled');
    // Of the active enrollments, the one on a lead-kind campaign.
    let enr = null, campaign = null;
    for (const e of enrList) {
      const camps = await sb('GET', `/pec_drip_campaigns?id=eq.${encodeURIComponent(e.campaign_id)}&select=*&limit=1`);
      const c = Array.isArray(camps) && camps[0];
      if (c && c.kind === 'lead') { enr = e; campaign = c; break; }
    }
    if (!enr) return done('not_enrolled');
    if (campaign.mode !== 'live') return done('campaign_not_live');   // dry_run: the runner writes the review copy

    const steps = await sb('GET', `/pec_drip_steps?campaign_id=eq.${encodeURIComponent(enr.campaign_id)}&active=eq.true&select=*&order=step_index.asc`);
    const stepList = Array.isArray(steps) ? steps : [];
    const step0 = stepList.find(s => s.step_index === 0);
    if (!step0 || step0.auto_send !== true || !step0.fixed_template) return done('no_auto_step0');

    const rcpt = await resolveRecipient(sb, 'lead', leadId);
    if (!rcpt.ok) return done(rcpt.reason || 'lead_missing');
    if (rcpt.lead.archived_at) return done('archived');
    if (rcpt.optedOut) return done('opted_out');

    // Idempotency: a Zapier retry must not double-send. ANY step-0 row for
    // this enrollment (sent, failed, skipped) means the touch already ran.
    const prior = await sb('GET', `/pec_drip_sends?enrollment_id=eq.${encodeURIComponent(enr.id)}&step_index=eq.0&select=id&limit=1`);
    if (Array.isArray(prior) && prior.length) return done('already_recorded');

    const wantSms = step0.channel === 'sms' || step0.channel === 'both';
    const wantEmail = step0.channel === 'email' || step0.channel === 'both';
    const canSms = wantSms && rcpt.smsAllowed;      // SMS only with positive consent
    const canEmail = wantEmail && rcpt.emailAllowed; // email whenever an address exists

    // CLAIM: advance 0 -> next step before sending (see the header block).
    const nextStep = stepList.find(s => s.step_index > 0);
    const nowIso = now().toISOString();
    const willComplete = !nextStep || 1 >= campaign.max_touches;
    const claimPatch = willComplete
      ? { status: 'completed', stop_reason: 'sequence_complete', stopped_at: nowIso, next_step_index: 1, next_send_at: null }
      : { next_step_index: nextStep.step_index, next_send_at: addDays(enr.enrolled_at, nextStep.day_offset).toISOString() };
    const claimed = await sb('PATCH',
      `/pec_drip_enrollments?id=eq.${encodeURIComponent(enr.id)}&status=eq.active&next_step_index=eq.0`,
      claimPatch, true);
    if (!Array.isArray(claimed) || !claimed.length) return done('claim_lost'); // a runner tick owns step 0
    out.attempted = true;

    const ledgerBase = {
      enrollment_id: enr.id, campaign_id: campaign.id,
      subject_type: 'lead', subject_id: leadId, lead_id: leadId,
      step_index: 0, scheduled_for: enr.next_send_at,
    };
    const writeLedger = (row) => sb('POST', '/pec_drip_sends', { ...ledgerBase, ...row })
      .catch(e => console.error('sendInstantTouch: ledger write failed', e && e.message));

    // Wanted-but-unsendable legs are recorded so the ledger explains gaps
    // (with 14 of 15 leads at sms_consent=false, the SMS leg's skipped row
    // with reason no_sms_consent is the EXPECTED shape, not a failure).
    if (wantSms && !canSms) { await writeLedger({ channel: 'sms', status: 'skipped', error_message: rcpt.smsSkipReason || 'sms_not_allowed' }); out.skipped.push('sms'); }
    if (wantEmail && !canEmail) { await writeLedger({ channel: 'email', status: 'skipped', error_message: rcpt.emailSkipReason || 'email_not_allowed' }); out.skipped.push('email'); }
    if (!canSms && !canEmail) return done('no_sendable_channel'); // claimed: step consumed, taper continues at step 1

    const bookingUrl = String(map.routemize_booking_url || '').trim() || null;
    const body = renderFixedTemplate(step0.fixed_template, { first_name: rcpt.first_name, booking_link: bookingUrl });
    if (!body) {
      if (canSms) { await writeLedger({ channel: 'sms', status: 'failed', error_message: 'fixed_template_rendered_empty' }); out.failed.push('sms'); }
      if (canEmail) { await writeLedger({ channel: 'email', status: 'failed', error_message: 'fixed_template_rendered_empty' }); out.failed.push('email'); }
      return done('template_empty');
    }

    const smsSenderCache = {}, emailSenderCache = {};
    let anySent = false;
    if (canSms) {
      let smsBody = capSms(scrubCopyKeepUrl(body, bookingUrl), MAX_SMS_LEN - STOP_LINE.length);
      if (!/\bSTOP\b/.test(smsBody)) smsBody += STOP_LINE; // always the first drip SMS on a fresh enrollment
      const sender = await getSmsSender(sb, smsSenderCache);
      if (!sender || !sender.from_number) {
        await writeLedger({ channel: 'sms', status: 'failed', body: smsBody, error_message: 'no active SMS sender for brand' });
        out.failed.push('sms');
      } else {
        let res;
        try { res = await senders.sendSms({ from: sender.from_number, to: rcpt.smsTo, content: smsBody }); }
        catch (err) { res = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
        await sb('POST', '/pec_sms_log', {
          direction: 'out', brand: DRIP_BRAND, from_number: sender.from_number, to_number: rcpt.smsTo,
          customer_id: rcpt.customer_id, body: smsBody, kind: 'drip',
          status: res.ok ? 'sent' : 'failed', quo_message_id: res.id, error_message: res.error,
        }).catch(e => console.error('sendInstantTouch: sms log failed', e && e.message));
        await writeLedger({ channel: 'sms', status: res.ok ? 'sent' : 'failed', body: smsBody, provider_id: res.id, sent_at: res.ok ? now().toISOString() : null, error_message: res.error });
        if (res.ok) { anySent = true; out.sent.push('sms'); } else out.failed.push('sms');
      }
    }
    if (canEmail) {
      const emailBody = scrubCopyKeepUrl(body, bookingUrl);
      const emailSubject = step0.fixed_subject || step0.email_subject || 'From Prescott Epoxy';
      const sender = await getEmailSender(sb, emailSenderCache);
      if (!sender || !sender.from_email) {
        await writeLedger({ channel: 'email', status: 'failed', subject: emailSubject, body: emailBody, error_message: 'no email sender for brand' });
        out.failed.push('email');
      } else {
        let res;
        try {
          res = await senders.sendEmail({
            from: `${sender.from_name} <${sender.from_email}>`, to: rcpt.email,
            subject: emailSubject, html: dripEmailHtml(emailBody, { accent: await getBrandAccent(sb) }), reply_to: sender.reply_to || undefined,
          });
        } catch (err) { res = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
        await sb('POST', '/pec_email_log', {
          customer_id: rcpt.customer_id, brand: DRIP_BRAND, template_key: 'drip',
          to_email: rcpt.email, from_email: sender.from_email, subject: emailSubject,
          status: res.ok ? 'sent' : 'failed', resend_id: res.id, error_message: res.error,
        }).catch(e => console.error('sendInstantTouch: email log failed', e && e.message));
        await writeLedger({ channel: 'email', status: res.ok ? 'sent' : 'failed', subject: emailSubject, body: emailBody, provider_id: res.id, sent_at: res.ok ? now().toISOString() : null, error_message: res.error });
        if (res.ok) { anySent = true; out.sent.push('email'); } else out.failed.push('email');
      }
    }

    // First-touch stamp, same write-once rule as the runner.
    if (anySent && rcpt.lead && !rcpt.lead.contacted_at) {
      await sb('PATCH', `/leads?id=eq.${id}&contacted_at=is.null`, { contacted_at: now().toISOString() })
        .catch(e => console.error('sendInstantTouch: contacted_at stamp failed', e && e.message));
    }
    return done(anySent ? null : 'nothing_sent');
  } catch (err) {
    out.reason = 'error';
    out.error = String(err && err.message || err);
    console.warn('sendInstantTouch failed (non-fatal):', out.error);
    return out;
  }
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

// Review-request enrollment, fired when a completed job's close-out popup (or
// the job detail's "Request review" button, or the one-time backfill) chooses
// Send. Anchored to NOW like every enrollment (enrollSubject computes
// next_send_at from `now`), which is exactly what makes the backfill safe: a
// job completed 25 days ago still starts at step 0 today, never 3 steps
// overdue at once (Part H's anchoring rule).
//
// ENROLL-TIME GUARD (decision 15 / landmine 11): this campaign ships
// mode='live' with NO dry_run cushion, so the drip_approval_required gate is
// the only thing between it and a real customer's phone. Refuse to enroll
// while the gate is not 'true' AND the campaign has never had an approved
// send (no status='sent' row). Once a human has approved at least one send,
// flipping the gate off is an informed choice and enrollment proceeds. A
// failed guard read also refuses: when we cannot PROVE the gate is on, we do
// not enroll into an ungated live campaign.
async function enrollReviewDrip(sb, jobId, now = new Date()) {
  try {
    const camps = await sb('GET', `/pec_drip_campaigns?kind=eq.review&status=eq.active&select=id,mode&order=created_at.asc&limit=1`);
    const camp = Array.isArray(camps) ? camps[0] : null;
    if (camp && camp.mode === 'live') {
      const rows = await sb('GET', `/settings?key=eq.drip_approval_required&select=value&limit=1`);
      const gateOn = Array.isArray(rows) && !!rows[0] && rows[0].value === 'true';
      if (!gateOn) {
        const sent = await sb('GET', `/pec_drip_sends?campaign_id=eq.${encodeURIComponent(camp.id)}&status=eq.sent&select=id&limit=1`);
        if (!Array.isArray(sent) || !sent.length) {
          console.warn(`enrollReviewDrip refused for job ${jobId}: campaign is live, drip_approval_required is not 'true', and no send has ever been approved. Turn the approval gate on (Settings) before enrolling review drips.`);
          return { enrolled: false, reason: 'approval_gate_off' };
        }
      }
    }
  } catch (err) {
    console.warn('enrollReviewDrip gate check failed; refusing to enroll (fail-safe):', String(err && err.message || err));
    return { enrolled: false, reason: 'gate_check_failed' };
  }
  return enrollSubject(sb, 'review', 'job', jobId, null, now);
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
    // status + deposit flags feed the installment resolver (prompt 45).
    const jobs = await sb('GET', `/jobs?id=eq.${id}&select=id,price,status,public_token,customer_id,voided_at,archived_at,completed_date,hq_invoice_number,invoice_first_sent_at,address,deposit_collected,deposit_waived,invoice_terms,invoice_due_date&limit=1`);
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
  // human is engaged and the drip must shut up. estimate_scheduled is in the
  // stop list for the lead a human DRAGS into that column: a booking already
  // stops the enrollment eagerly (stop_reason 'appointment_booked'), but a
  // hand-drag fires nothing server-side, so this check is its safety net.
  async lead(sb, enr, rcpt) {
    const lead = rcpt.lead;
    // Prompt 62 Part D: archive means all automatic follow-up stops.
    if (lead.archived_at) return { action: 'stopped', reason: 'archived' };
    if (lead.stage === 'lost') return { action: 'stopped', reason: 'lost' };
    if (['estimate_scheduled', 'estimate_sent', 'presented', 'accepted'].includes(lead.stage)) {
      return { action: 'stopped', reason: 'stage_advanced' };
    }
    return null;
  },
  // Estimate follow-up (subject is the LEAD the estimate belongs to).
  // 'signed' is the interim e-sign state and MUST count as accepted, or the
  // drip nags a customer who just signed. change_requested means the customer
  // engaged through the portal, so a human takes over (stop as 'replied').
  async estimate(sb, enr, rcpt) {
    // Prompt 62 Part D: an archived lead stops estimate follow-up too.
    if (rcpt.lead && rcpt.lead.archived_at) return { action: 'stopped', reason: 'archived' };
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
    // Prompt 45 (decision 10): when the job has a payment schedule, the
    // reminder nudges on the CURRENT outstanding ask (deposit or the current
    // installment), never the full remaining balance. Nothing currently due
    // (the next installment's milestone has not fired) stops the enrollment
    // as 'not_due'; the send that queues/ships the next installment
    // re-enrolls, so reminders resume anchored to the new ask. Best-effort
    // read: a pre-migration schema keeps the exact legacy behavior.
    try {
      const instRows = await sb('GET', `/pec_invoice_installments?job_id=eq.${encodeURIComponent(job.id)}&select=*`);
      if (Array.isArray(instRows) && instRows.length) {
        const ask = resolveCurrentAsk({ job, installments: instRows, payments: Array.isArray(pays) ? pays : [] });
        if (ask) {
          if (ask.mode === 'paid') return { action: 'stopped', reason: 'paid' };
          if (ask.mode === 'none') return { action: 'stopped', reason: 'not_due' };
          rcpt.balance = ask.amount;      // the ONLY amount the copy may state
          rcpt.askLabel = ask.mode === 'installment' ? (ask.label || null) : null;
          rcpt.askIsSchedule = true;
          return null;
        }
      }
    } catch (err) {
      console.warn('pec-drip: installment resolve skipped (legacy balance):', String(err && err.message || err));
    }
    // Invoice terms (2026-08-17): no schedule owns this invoice (a schedule
    // returned above), so a FUTURE due date holds the reminders. 'hold' never
    // ends the enrollment: the runner leaves it active and this PATCH
    // re-anchors the whole sequence to the due-date morning (8 AM Phoenix),
    // so a Net 30 customer gets touches at due+0/+3/+7/+14, not day 3
    // dunning off the send date. Re-anchoring enrolled_at is deliberate: the
    // step scheduler computes every next_send_at from it. Known trade-off,
    // accepted: checkReplied counts replies since enrolled_at, so a reply
    // BEFORE the due date will not auto-stop the sequence (nothing is
    // sending during the hold anyway, and staff see the reply in comms).
    if (job.invoice_due_date) {
      const dueMs = Date.parse(job.invoice_due_date + 'T15:00:00Z');   // 8 AM Phoenix (fixed UTC-7)
      if (Number.isFinite(dueMs) && dueMs > Date.now()) {
        const dueIso = new Date(dueMs).toISOString();
        await sb('PATCH', `/pec_drip_enrollments?id=eq.${encodeURIComponent(enr.id)}&status=eq.active`,
          { enrolled_at: dueIso, next_send_at: dueIso }).catch(() => {});
        return { action: 'hold', reason: 'awaiting_due_date' };
      }
    }
    rcpt.balance = balance;   // the ONLY amount the copy may state
    return null;
  },
  // Review request (subject is the JOB, prompt 60). Reads the job's latest
  // pec_review_requests row every run; each stop condition gets its own
  // distinct stop_reason so the Drips activity log stays readable. Replies
  // and STOP/opt-out are handled by the universal core (checkReplied +
  // resolveRecipient's customer opt-out model), NOT re-implemented here.
  async review(sb, enr, rcpt) {
    const job = rcpt.job;
    if (job.voided_at || job.archived_at) return { action: 'stopped', reason: 'job_closed' };
    const jid = encodeURIComponent(enr.subject_id || enr.lead_id);
    const reqs = await sb('GET', `/pec_review_requests?job_id=eq.${jid}&select=*&order=created_at.desc&limit=1`);
    const req = (Array.isArray(reqs) && reqs[0]) || null;
    if (!req) return { action: 'stopped', reason: 'request_missing' };
    if (req.status === 'reviewed' || req.review_id) return { action: 'stopped', reason: 'reviewed' };
    if (req.status === 'skipped') return { action: 'stopped', reason: 'request_skipped' };
    if (req.status === 'stopped') return { action: 'stopped', reason: req.stop_reason || 'request_stopped' };
    // Touch-up / callback gate, settings-driven (review_stop_on_touchup,
    // default true). A touch-up lives either on the prod job row itself
    // (touchup_state) or on a child callback row (is_callback=true,
    // original_job_id pointing back); 'done' or a closed stamp means it no
    // longer blocks. Best-effort: a failed READ never stops the drip.
    if (req.prod_job_id) {
      try {
        const gRows = await sb('GET', `/settings?key=eq.review_stop_on_touchup&select=value&limit=1`);
        const gateOn = !(Array.isArray(gRows) && gRows[0] && gRows[0].value === 'false');
        if (gateOn) {
          const pid = encodeURIComponent(req.prod_job_id);
          const prows = await sb('GET', `/pec_prod_jobs?or=(id.eq.${pid},original_job_id.eq.${pid})&select=id,is_callback,touchup_state,touchup_closed_at`);
          const open = (Array.isArray(prows) ? prows : []).some(p =>
            (p.touchup_state && p.touchup_state !== 'done')
            || (p.is_callback && !p.touchup_closed_at));
          if (open) return { action: 'stopped', reason: 'touchup_opened' };
        }
      } catch (err) {
        console.warn('pec-drip: review touch-up check skipped:', String(err && err.message || err));
      }
    }
    rcpt.reviewRequest = req;   // token feeds kindTail; crew_lead feeds the copy
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
    // Schedule jobs say "Amount due now" (the current ask), plain jobs keep
    // the legacy "Balance" wording byte-for-byte (prompt 45, decision 10).
    const bal = rcpt.balance != null ? `${rcpt.askIsSchedule ? 'Amount due now' : 'Balance'}: ${usd(rcpt.balance)}. ` : '';
    return { sms: ` ${bal}Pay online: ${url}`, text: `${bal}Pay online here: ${url}` };
  }
  if (kind === 'review' && rcpt.reviewRequest && rcpt.reviewRequest.token) {
    // The /r/ tracking link: logs the click, then 302s to the Google review
    // page. Appended by CODE, never the model (scrubCopy strips model URLs).
    const url = `${SITE_URL}/r/${rcpt.reviewRequest.token}`;
    return { sms: ` Leave a review here: ${url}`, text: `Leave a review here: ${url}` };
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
    pending: 0, pending_held: 0,
  };

  // 1. Global master switch: anything but the string 'true' means OFF.
  if (!(await masterSwitchOn(sb))) {
    summary.master_off = true;
    return summary;
  }
  // Prompt 42: approval gate + settings-driven quiet hours, read once per run.
  const cfg = await getDripConfig(sb);

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
  let reviewEnabled;   // lazy per-run read of review_drip_enabled
  let bookingUrl;      // lazy per-run read of routemize_booking_url (prompt 73, lead campaigns)
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
      // Review campaigns have their OWN master switch (review_drip_enabled)
      // on top of the global one; off holds in place exactly like paused,
      // never stops. Read once per run.
      if (campaign.kind === 'review') {
        if (reviewEnabled === undefined) {
          const r = await sb('GET', `/settings?key=eq.review_drip_enabled&select=value&limit=1`);
          reviewEnabled = !(Array.isArray(r) && r[0] && r[0].value === 'false');
        }
        if (!reviewEnabled) continue;
      }

      // Pre-backfill rows have no subject columns; fall back to lead_id.
      const subjectType = enr.subject_type || 'lead';
      const subjectId = enr.subject_id || enr.lead_id;
      const rcpt = await resolveRecipient(sb, subjectType, subjectId);

      // 3. Kill-switches at send time (universal core + per-kind adapter;
      // adapters attach copy context: rcpt.estimate / rcpt.balance).
      const kill = await checkKillSwitches(sb, enr, campaign, rcpt);
      if (kill) {
        // 'hold' (invoice terms, due date in the future) keeps the enrollment
        // active: the adapter already pushed next_send_at to the due date.
        if (kill.action === 'hold') { summary.held = (summary.held || 0) + 1; continue; }
        await endEnrollment(sb, enr, kill.action, kill.reason, nowIso);
        summary[kill.action === 'completed' ? 'completed' : 'stopped']++;
        continue;
      }

      // Prompt 73: lead-nurture copy (fixed AND AI) may carry the configured
      // booking link; renderCopyReal validates it and scrubCopyKeepUrl lets
      // exactly that one URL through the scrubber. One settings read per run.
      if ((campaign.kind || 'lead') === 'lead') {
        if (bookingUrl === undefined) bookingUrl = await getBookingUrl(sb);
        rcpt.bookingUrl = bookingUrl;
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

      // 4.5 Approval gate (prompt 42). Applies to LIVE campaigns with a
      // sendable leg. If a pending row already exists for this step, the
      // enrollment HOLDS here (no advance, no send, nothing new written)
      // until a human approves or skips it in the Drip Approvals view; this
      // is enforced regardless of the gate setting so flipping the gate off
      // can never auto-send (or double-write) an item a human was reviewing.
      // Prompt 73: auto_send is PER-STEP (the day-0 instant touch, fixed
      // template only) and bypasses the gate; here the runner is only the
      // crash safety net for it (the intake-inline sendInstantTouch is the
      // real path). The pending-hold check above the bypass stays: a step a
      // human is mid-review on can never be auto-sent by flipping anything.
      const autoStep = step.auto_send === true && step.fixed_template != null;
      const gateHold = campaign.mode === 'live' && (canSms || canEmail);
      if (gateHold) {
        const held = await sb('GET',
          `/pec_drip_sends?enrollment_id=eq.${encodeURIComponent(enr.id)}&step_index=eq.${enr.next_step_index}&status=eq.pending&select=id&limit=1`);
        if (Array.isArray(held) && held.length) { summary.pending_held++; continue; }
      }
      const gatePending = gateHold && cfg.approvalRequired && !autoStep;

      // 5. Quiet hours: any live SMS leg due outside the allowed window
      // (settings-driven; default 8am-8pm Phoenix Mon-Sat) defers the WHOLE
      // step (sms+email stay a coherent pair) to the window open. Dry-run
      // ignores quiet hours so Dylan's review copy shows up promptly, and so
      // does the approval gate: the pending draft is written any time (Anne
      // reviews on her schedule) and quiet hours are enforced at APPROVE
      // time instead.
      // An auto_send step also skips the quiet-hours defer (decision 7: the
      // instant touch is an immediate reply to a message the person just
      // sent); steps without auto_send keep deferring exactly as before.
      if (canSms && campaign.mode === 'live' && !gatePending && !autoStep) {
        const q = quietHours(now(), cfg.quiet);
        if (!q.inWindow) {
          await sb('PATCH',
            `/pec_drip_enrollments?id=eq.${encodeURIComponent(enr.id)}&status=eq.active&next_step_index=eq.${enr.next_step_index}`,
            { next_send_at: q.nextOpen.toISOString() });
          summary.deferred++;
          continue;
        }
      }

      // 6. CLAIM (the atomic advance). Compute the post-step state first.
      // Skipped entirely when the approval gate holds the step: the whole
      // point of the gate is that the enrollment does NOT advance (and the
      // schedule does not move) until a human approves or skips; there the
      // pending-leg unique index is the concurrency guard instead.
      if (!gatePending) {
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
      }

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
      // Under the approval gate these writes move into the pending block
      // below (after a successful render) so a held step never re-writes
      // them on later ticks.
      if (!gatePending) {
        if (smsSkipReason) { await writeLedger({ channel: 'sms', status: 'skipped', error_message: smsSkipReason }); summary.skipped++; }
        if (emailSkipReason) { await writeLedger({ channel: 'email', status: 'skipped', error_message: emailSkipReason }); summary.skipped++; }
        if (!canSms && !canEmail) continue;   // nothing sendable this step; schedule already advanced
      }

      // 7. Render the copy: one model call per touch, EXCEPT fixed-template
      // steps (prompt 73: the day-0 instant touch), which render by token
      // substitution with zero model calls.
      let copy;
      try {
        copy = step.fixed_template != null
          ? {
              sms: renderFixedTemplate(step.fixed_template, { first_name: rcpt.first_name, booking_link: rcpt.bookingUrl }),
              email_subject: step.fixed_subject || step.email_subject || null,
              email_body: renderFixedTemplate(step.fixed_template, { first_name: rcpt.first_name, booking_link: rcpt.bookingUrl }),
            }
          : await renderCopy(rcpt, step, campaign, { sms: canSms, email: canEmail });
      } catch (err) {
        if (gatePending) {
          // Nothing was claimed and nothing was written, so the step is NOT
          // consumed: the next tick simply retries the render. (The live
          // path consumes the step instead because it already claimed it.)
          summary.failed++;
          continue;
        }
        const msg = 'ai_render_failed: ' + String(err && err.message || err).slice(0, 400);
        if (canSms) await writeLedger({ channel: 'sms', status: 'failed', error_message: msg });
        if (canEmail) await writeLedger({ channel: 'email', status: 'failed', error_message: msg });
        summary.failed++;
        continue;   // step consumed; next touch continues the sequence
      }
      // Review copy gets the mechanical no-incentives check (landmine 10): a
      // leg that trips it is dropped and recorded, never rewritten. Under the
      // approval gate nothing is written, so the step just re-renders next
      // tick; on the live path the step is already claimed, so the failed
      // row explains the gap.
      if (campaign.kind === 'review') {
        if (canSms && reviewCopyViolation(copy.sms)) {
          copy.sms = null;
          if (!gatePending) { await writeLedger({ channel: 'sms', status: 'failed', error_message: 'incentive_language_blocked' }); summary.failed++; }
        }
        if (canEmail && (reviewCopyViolation(copy.email_body) || reviewCopyViolation(copy.email_subject))) {
          copy.email_body = null;
          if (!gatePending) { await writeLedger({ channel: 'email', status: 'failed', error_message: 'incentive_language_blocked' }); summary.failed++; }
        }
      }
      // The estimate link / balance + pay link tail is appended AFTER scrub
      // and AFTER the cap (with the cap shortened so the tail and STOP line
      // can never be truncated off). Data-owned facts, not model-owned.
      const tail = kindTail(campaign.kind, rcpt);
      let smsBody = canSms ? scrubCopyKeepUrl(copy.sms, rcpt.bookingUrl) : null;
      if (smsBody) {
        smsBody = tail
          ? capSms(smsBody, MAX_SMS_LEN - tail.sms.length - STOP_LINE.length) + tail.sms
          : capSms(smsBody);
      }
      const emailSubject = canEmail ? (scrubCopy(copy.email_subject) || step.email_subject || 'From Prescott Epoxy') : null;
      let emailBody = canEmail ? scrubCopyKeepUrl(copy.email_body, rcpt.bookingUrl) : null;
      if (emailBody && tail) emailBody = emailBody + '\n\n' + tail.text;

      // First DRIP SMS for this enrollment carries the STOP line (appended
      // once; dry_run rows count so the review copy matches what would send).
      if (smsBody) {
        const prior = await sb('GET',
          `/pec_drip_sends?enrollment_id=eq.${encodeURIComponent(enr.id)}&channel=eq.sms&status=in.(sent,dry_run)&select=id&limit=1`);
        if ((!Array.isArray(prior) || !prior.length) && !/\bSTOP\b/.test(smsBody)) smsBody += STOP_LINE;
      }

      // 7.5 Approval gate: persist the exact would-send copy (tail + STOP
      // line included) as PENDING rows and hold. No claim, no advance, no
      // provider; a human approves, edits, or skips it in Drip Approvals.
      // Raw POST (not writeLedger) so a failure surfaces here: the partial
      // unique index uq_pec_drip_sends_pending_leg turns a concurrent
      // tick's duplicate into a clean conflict, and on ANY failure nothing
      // advances, so the step safely retries next tick.
      if (gatePending) {
        try {
          if (smsSkipReason) { await writeLedger({ channel: 'sms', status: 'skipped', error_message: smsSkipReason }); summary.skipped++; }
          if (emailSkipReason) { await writeLedger({ channel: 'email', status: 'skipped', error_message: emailSkipReason }); summary.skipped++; }
          if (smsBody) { await sb('POST', '/pec_drip_sends', { ...ledgerBase, channel: 'sms', status: 'pending', body: smsBody }); summary.pending++; }
          if (canEmail && emailBody) { await sb('POST', '/pec_drip_sends', { ...ledgerBase, channel: 'email', status: 'pending', subject: emailSubject, body: emailBody }); summary.pending++; }
        } catch (err) {
          console.error('pec-drip: pending write failed (step held, retries next tick):', String(err && err.message || err));
        }
        continue;
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
              subject: emailSubject, html: dripEmailHtml(emailBody, { accent: await getBrandAccent(sb) }), reply_to: sender.reply_to || undefined,
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
// APPROVAL GATE resolution (prompt 42). resolvePendingStep is the backend of
// the Drip Approvals view: it takes ONE held step (all its pending legs) and
// either approves it (send the possibly-edited copy, then advance the
// enrollment exactly as an auto-send would) or skips it (advance without
// sending). Everything is re-checked at approve time, never trusted from
// render time: consent, opt-out, replies, stage/paid/lost, quiet hours.
// ---------------------------------------------------------------------------

// Light scrub for HUMAN-edited copy: enforce the no-em-dash rule (standing
// rule 6) but keep URLs, because the pending body already carries the
// code-appended estimate/pay link and full scrubCopy would strip it.
function scrubEditedCopy(text) {
  if (text == null) return null;
  const s = String(text).replace(/\s*[—–]\s*/g, ', ').trim();
  return s || null;
}

// One approved leg through the provider + comms-log mirror (same request
// shapes and log rows as the runner's live path). finalize PATCHes the
// ledger row; returns true when the provider accepted the send.
async function sendApprovedLeg(sb, providers, ctx) {
  const { row, body, subject, rcpt, subjectType, subjectId, smsSenderCache, emailSenderCache, finalize, now } = ctx;
  if (row.channel === 'sms') {
    const sender = await getSmsSender(sb, smsSenderCache);
    if (!sender || !sender.from_number) {
      await finalize({ status: 'failed', error_message: 'no active SMS sender for brand' });
      return false;
    }
    let out;
    try { out = await providers.sendSms({ from: sender.from_number, to: rcpt.smsTo, content: body }); }
    catch (err) { out = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
    await sb('POST', '/pec_sms_log', {
      direction: 'out', brand: DRIP_BRAND, from_number: sender.from_number, to_number: rcpt.smsTo,
      customer_id: rcpt.customer_id, job_id: subjectType === 'job' ? subjectId : null,
      body, kind: 'drip',
      status: out.ok ? 'sent' : 'failed', quo_message_id: out.id, error_message: out.error,
    }).catch(e => console.error('pec-drip-approve: sms log failed', e.message));
    await finalize({ status: out.ok ? 'sent' : 'failed', body, sent_at: out.ok ? now().toISOString() : null, provider_id: out.id, error_message: out.error });
    return out.ok;
  }
  const sender = await getEmailSender(sb, emailSenderCache);
  if (!sender || !sender.from_email) {
    await finalize({ status: 'failed', error_message: 'no email sender for brand' });
    return false;
  }
  let out;
  try {
    out = await providers.sendEmail({
      from: `${sender.from_name} <${sender.from_email}>`, to: rcpt.email,
      subject: subject || 'From Prescott Epoxy', html: dripEmailHtml(body, { accent: await getBrandAccent(sb) }), reply_to: sender.reply_to || undefined,
    });
  } catch (err) { out = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
  await sb('POST', '/pec_email_log', {
    customer_id: rcpt.customer_id, job_id: subjectType === 'job' ? subjectId : null,
    brand: DRIP_BRAND, template_key: 'drip',
    to_email: rcpt.email, from_email: sender.from_email, subject: subject || 'From Prescott Epoxy',
    status: out.ok ? 'sent' : 'failed', resend_id: out.id, error_message: out.error,
  }).catch(e => console.error('pec-drip-approve: email log failed', e.message));
  await finalize({ status: out.ok ? 'sent' : 'failed', subject: subject || null, body, sent_at: out.ok ? now().toISOString() : null, provider_id: out.id, error_message: out.error });
  return out.ok;
}

// opts: { enrollmentId, stepIndex, action: 'approve'|'skip',
//         edits: { [sendRowId]: { body, subject } } }
// Returns { ok, outcome: 'approved'|'skipped'|'voided', ... } or
// { ok:false, error } for caller mistakes / lost races.
async function resolvePendingStep(deps, { enrollmentId, stepIndex, action, edits = {} }) {
  const sb = deps.sb;
  const now = deps.now || (() => new Date());
  const providers = { sendSms: deps.sendSms || sendQuoSmsReal, sendEmail: deps.sendEmail || sendResendEmailReal };
  const nowIso = now().toISOString();
  const step = Number(stepIndex);
  if (!enrollmentId || !Number.isInteger(step) || !['approve', 'skip'].includes(action)) {
    return { ok: false, error: 'bad_request' };
  }
  const eid = encodeURIComponent(enrollmentId);

  const pend = await sb('GET', `/pec_drip_sends?enrollment_id=eq.${eid}&step_index=eq.${step}&status=eq.pending&select=*`);
  const rows = Array.isArray(pend) ? pend : [];
  if (!rows.length) return { ok: false, error: 'nothing_pending' };

  // Voiding keeps the ledger honest: the row survives as 'skipped' with the
  // reason in error_message so the queue (and the lead page) can say WHY a
  // reviewed message never went out.
  const voidRows = async (reason) => {
    for (const r of rows) {
      await sb('PATCH', `/pec_drip_sends?id=eq.${encodeURIComponent(r.id)}&status=eq.pending`,
        { status: 'skipped', error_message: reason });
    }
  };

  const enrs = await sb('GET', `/pec_drip_enrollments?id=eq.${eid}&select=*&limit=1`);
  const enr = (Array.isArray(enrs) && enrs[0]) || null;
  if (!enr) { await voidRows('voided: enrollment_missing'); return { ok: true, outcome: 'voided', reason: 'enrollment_missing' }; }
  if (enr.status !== 'active') {
    await voidRows('voided: enrollment_' + enr.status);
    return { ok: true, outcome: 'voided', reason: 'enrollment_' + enr.status };
  }
  const camps = await sb('GET', `/pec_drip_campaigns?id=eq.${encodeURIComponent(enr.campaign_id)}&select=*&limit=1`);
  const campaign = (Array.isArray(camps) && camps[0]) || null;
  if (!campaign) {
    await voidRows('voided: campaign_missing');
    await endEnrollment(sb, enr, 'stopped', 'campaign_missing', nowIso);
    return { ok: true, outcome: 'voided', reason: 'campaign_missing' };
  }

  const subjectType = enr.subject_type || 'lead';
  const subjectId = enr.subject_id || enr.lead_id;

  // The advance is the SAME conditional claim the runner uses, so approve
  // and skip move the schedule exactly like an auto-send would, and two
  // concurrent reviewers cannot both own the step.
  const steps = await sb('GET', `/pec_drip_steps?campaign_id=eq.${encodeURIComponent(enr.campaign_id)}&active=eq.true&select=*&order=step_index.asc`);
  const nextStep = (Array.isArray(steps) ? steps : []).find(s => s.step_index > step);
  const willComplete = !nextStep || step + 1 >= campaign.max_touches;
  const claimPatch = willComplete
    ? { status: 'completed', stop_reason: 'sequence_complete', stopped_at: nowIso, next_step_index: step + 1, next_send_at: null }
    : { next_step_index: nextStep.step_index, next_send_at: addDays(enr.enrolled_at, nextStep.day_offset).toISOString() };
  const advance = async () => {
    const claimed = await sb('PATCH',
      `/pec_drip_enrollments?id=eq.${eid}&status=eq.active&next_step_index=eq.${step}`, claimPatch, true);
    return Array.isArray(claimed) && claimed.length > 0;
  };

  if (action === 'skip') {
    if (!(await advance())) return { ok: false, error: 'already_resolved' };
    await voidRows('skipped_by_reviewer');
    return { ok: true, outcome: 'skipped', completed: willComplete };
  }

  // APPROVE. Sending is still governed by the master switch, and consent +
  // kill-switches are re-run NOW, because everything can change between
  // render and approval (reply, STOP, payment, lost, stage advance).
  if (!(await masterSwitchOn(sb))) return { ok: false, error: 'master_off' };
  const rcpt = await resolveRecipient(sb, subjectType, subjectId);
  const kill = await checkKillSwitches(sb, enr, campaign, rcpt);
  if (kill) {
    // 'hold' (invoice due date in the future): not sendable NOW, but nothing
    // is wrong; leave the rendered rows and the enrollment intact.
    if (kill.action === 'hold') return { ok: false, error: kill.reason };
    await voidRows('voided: ' + kill.reason);
    await endEnrollment(sb, enr, kill.action, kill.reason, nowIso);
    return { ok: true, outcome: 'voided', reason: kill.reason };
  }

  const q = quietHours(now(), (await getDripConfig(sb)).quiet);
  // Claim-first, same tradeoff as the runner: whoever wins the advance owns
  // the send; a crash after claim loses the touch, never doubles it.
  if (!(await advance())) return { ok: false, error: 'already_resolved' };

  const result = { ok: true, outcome: 'approved', sent: 0, failed: 0, deferred: 0, voided_legs: 0, completed: willComplete };
  const smsSenderCache = {}, emailSenderCache = {};
  let anySent = false;
  for (const row of rows) {
    const edit = edits[row.id] || {};
    const body = scrubEditedCopy(edit.body != null ? edit.body : row.body);
    const subject = scrubEditedCopy(edit.subject != null ? edit.subject : row.subject);
    // Per-leg claim (pending -> sending) persists the edited copy and makes
    // a double-click / double-tab approve a no-op on the second pass.
    const claimedRow = await sb('PATCH', `/pec_drip_sends?id=eq.${encodeURIComponent(row.id)}&status=eq.pending`,
      { status: 'sending', body, subject }, true);
    if (!Array.isArray(claimedRow) || !claimedRow.length) continue;
    const finalize = (patch) => sb('PATCH', `/pec_drip_sends?id=eq.${encodeURIComponent(row.id)}`, patch)
      .catch(e => console.error('pec-drip-approve: finalize failed', e.message));

    if (!body) { await finalize({ status: 'skipped', error_message: 'empty_after_edit' }); result.voided_legs++; continue; }
    const allowed = row.channel === 'sms' ? rcpt.smsAllowed : rcpt.emailAllowed;
    if (!allowed) {
      const why = row.channel === 'sms' ? (rcpt.smsSkipReason || 'sms_not_allowed') : (rcpt.emailSkipReason || 'email_not_allowed');
      await finalize({ status: 'skipped', error_message: 'voided: ' + why });
      result.voided_legs++;
      continue;
    }
    if (row.channel === 'sms' && !q.inWindow) {
      // Approved outside the quiet-hours window: hold the (edited) message
      // as 'queued' for the runner's flush at the window open; never late.
      await finalize({ status: 'queued', scheduled_for: q.nextOpen.toISOString() });
      result.deferred++;
      continue;
    }
    const sentOk = await sendApprovedLeg(sb, providers, {
      row, body, subject, rcpt, subjectType, subjectId, smsSenderCache, emailSenderCache, finalize, now,
    });
    if (sentOk) { anySent = true; result.sent++; } else result.failed++;
  }
  // First-touch stamp, same write-once rule as the runner.
  if (anySent && rcpt.lead && !rcpt.lead.contacted_at) {
    await sb('PATCH', `/leads?id=eq.${encodeURIComponent(rcpt.lead.id)}&contacted_at=is.null`, { contacted_at: now().toISOString() })
      .catch(e => console.error('pec-drip-approve: contacted_at stamp failed', e.message));
  }
  return result;
}

// Runner-side flush for approved-then-deferred sends (SMS approved during
// quiet hours sits as 'queued' with enrollment_id set; blast rows are
// excluded by blast_id=is.null). The human approved the COPY; what can
// still change is re-checked here: consent/opt-out, per-kind stop
// conditions (paid / lost / accepted), and an inbound reply.
async function flushApprovedDrips(deps) {
  const sb = deps.sb;
  const now = deps.now || (() => new Date());
  const providers = { sendSms: deps.sendSms || sendQuoSmsReal, sendEmail: deps.sendEmail || sendResendEmailReal };
  const summary = { master_off: false, flushed: 0, failed: 0, skipped: 0, held: false };
  if (!(await masterSwitchOn(sb))) { summary.master_off = true; return summary; }
  const q = quietHours(now(), (await getDripConfig(sb)).quiet);
  const rows = await sb('GET',
    `/pec_drip_sends?status=eq.queued&blast_id=is.null&enrollment_id=not.is.null&select=*&order=created_at.asc&limit=${BLAST_BATCH}`);
  const smsSenderCache = {}, emailSenderCache = {};
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (row.channel === 'sms' && !q.inWindow) { summary.held = true; continue; }  // stays queued for the next in-window tick
    const claimed = await sb('PATCH', `/pec_drip_sends?id=eq.${encodeURIComponent(row.id)}&status=eq.queued`,
      { status: 'sending' }, true);
    if (!Array.isArray(claimed) || !claimed.length) continue;   // another tick owns it
    const finalize = (patch) => sb('PATCH', `/pec_drip_sends?id=eq.${encodeURIComponent(row.id)}`, patch)
      .catch(e => console.error('pec-drip-flush: finalize failed', e.message));
    try {
      const subjectType = row.subject_type || 'lead';
      const subjectId = row.subject_id || row.lead_id;
      const rcpt = await resolveRecipient(sb, subjectType, subjectId);
      let stop = null;
      if (!rcpt.ok) stop = rcpt.reason;
      else if (rcpt.optedOut) stop = 'opted_out';
      else if (row.channel === 'sms' && !rcpt.smsAllowed) stop = rcpt.smsSkipReason || 'sms_not_allowed';
      else if (row.channel === 'email' && !rcpt.emailAllowed) stop = rcpt.emailSkipReason || 'email_not_allowed';
      if (!stop) {
        const enrs = await sb('GET', `/pec_drip_enrollments?id=eq.${encodeURIComponent(row.enrollment_id)}&select=*&limit=1`);
        const enr = (Array.isArray(enrs) && enrs[0]) || null;
        const camps = enr ? await sb('GET', `/pec_drip_campaigns?id=eq.${encodeURIComponent(enr.campaign_id)}&select=*&limit=1`) : [];
        const campaign = (Array.isArray(camps) && camps[0]) || null;
        if (enr && campaign) {
          // Per-kind stop conditions + replied, but NOT the max-touches core:
          // the enrollment already advanced at approve time, so that check
          // would misread this leg as over the ceiling.
          const kindCheck = await (KIND_CHECKS[campaign.kind] || KIND_CHECKS.lead)(sb, enr, rcpt);
          if (kindCheck) stop = kindCheck.reason;
          else {
            const replied = await checkReplied(sb, enr, rcpt);
            if (replied) stop = replied.reason;
          }
        }
      }
      if (stop) { await finalize({ status: 'skipped', error_message: 'voided: ' + stop }); summary.skipped++; continue; }
      const sentOk = await sendApprovedLeg(sb, providers, {
        row, body: row.body, subject: row.subject, rcpt, subjectType, subjectId,
        smsSenderCache, emailSenderCache, finalize, now,
      });
      if (sentOk) {
        summary.flushed++;
        if (rcpt.lead && !rcpt.lead.contacted_at) {
          await sb('PATCH', `/leads?id=eq.${encodeURIComponent(rcpt.lead.id)}&contacted_at=is.null`, { contacted_at: now().toISOString() })
            .catch(e => console.error('pec-drip-flush: contacted_at stamp failed', e.message));
        }
      } else summary.failed++;
    } catch (err) {
      await finalize({ status: 'failed', error_message: String(err && err.message || err).slice(0, 400) });
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
  // Same settings-driven window as the drips (one definition of quiet hours).
  const q = quietHours(now(), (await getDripConfig(sb)).quiet);
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
              subject: row.subject || 'From Prescott Epoxy', html: dripEmailHtml(row.body, { accent: await getBrandAccent(sb), blast: true }),
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
  enrollJobInvoiceDrip, enrollReviewDrip, reviewCopyViolation,
  enrollSubject, resolveRecipient, checkKillSwitches,
  masterSwitchOn, kindTail, quietHours, toE164, phoneTail, scrubCopy, capSms,
  usd, dripEmailHtml, getBrandAccent, buildRenderPrompt, RENDER_SYSTEM_PROMPT,
  RENDER_SYSTEM_PROMPTS, RUN_CAP, BLAST_BATCH, STOP_LINE, SITE_URL,
  // Prompt 42: approval gate + settings-driven quiet hours.
  resolvePendingStep, flushApprovedDrips, getDripConfig, parseQuietSettings,
  scrubEditedCopy, DEFAULT_QUIET,
  // Prompt 73: the day-0 instant touch, fixed-template rendering, and the
  // booking-link plumbing.
  sendInstantTouch, renderFixedTemplate, bookingUrlViolation, scrubCopyKeepUrl,
  getBookingUrl,
  // Prompt 37: the appointment confirmation/reminder core (_pec-appt.cjs)
  // sends through the same provider + brand-sender helpers as the drips so
  // there is exactly one Quo/Resend code path per provider.
  sendQuoSmsReal, sendResendEmailReal, getSmsSender, getEmailSender,
};
