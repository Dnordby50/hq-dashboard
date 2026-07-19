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
// PHASE 3 SEAM: campaigns carry kind ('lead' | 'estimate' | 'invoice').
// This runner processes enrollments regardless of kind; Phase 3 adds the
// estimate/invoice enrollment triggers and campaigns, not runner surgery.

const RUN_CAP = 25;               // enrollments per run; taper is day-grained so backlog clears fast
const MAX_SMS_LEN = 480;          // hard cap on AI SMS copy (~3 segments)
const QUIET_START_HOUR = 8;       // America/Phoenix, fixed UTC-7 (no DST)
const QUIET_END_HOUR = 20;
const PHX_OFFSET_MS = 7 * 60 * 60 * 1000;
const DRIP_BRAND = 'prescott-epoxy';   // leads are PEC-only today; matches pec_sms_senders/pec_email_senders keys
const STOP_LINE = ' Reply STOP to opt out.';

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
function capSms(text) {
  if (!text) return text;
  if (text.length <= MAX_SMS_LEN) return text;
  const cut = text.slice(0, MAX_SMS_LEN);
  const sp = cut.lastIndexOf(' ');
  return (sp > MAX_SMS_LEN - 60 ? cut.slice(0, sp) : cut).trim();
}

// ---------------------------------------------------------------------------
// AI copy rendering. One Anthropic call per touch; the guidance is the step's
// instruction, the record is the only fact source. Customer-facing rules are
// hard constraints in the system prompt AND enforced by scrubCopy after.
// ---------------------------------------------------------------------------
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

function buildRenderPrompt(lead, step, campaign, needs) {
  return [
    'LEAD RECORD (the only fact source):',
    JSON.stringify({
      first_name: lead.first_name || (lead.full_name ? String(lead.full_name).split(/\s+/)[0] : null),
      full_name: lead.full_name,
      source: lead.source,
      campaign: lead.campaign,
      city: lead.city,
      has_address: !!lead.address,
      notes: lead.notes,
      stage: lead.stage,
      created_at: lead.created_at,
    }),
    '',
    `THIS TOUCH: step ${step.step_index + 1} of ${campaign.max_touches} in the "${campaign.name}" sequence, day ${step.day_offset} after they reached out.`,
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

async function renderCopyReal(lead, step, campaign, needs) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
  const model = process.env.PEC_DRIP_AI_MODEL || 'claude-sonnet-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 800,
      system: RENDER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildRenderPrompt(lead, step, campaign, needs) }],
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
  const paras = String(bodyText || '').split(/\n\s*\n/)
    .map(p => `<p style="margin:0 0 14px">${escHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
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
async function enrollLead(sb, leadId, now = new Date()) {
  try {
    const camps = await sb('GET', `/pec_drip_campaigns?kind=eq.lead&status=eq.active&select=id&order=created_at.asc&limit=1`);
    const camp = Array.isArray(camps) ? camps[0] : null;
    if (!camp) return { enrolled: false, reason: 'no_active_campaign' };
    const steps = await sb('GET', `/pec_drip_steps?campaign_id=eq.${encodeURIComponent(camp.id)}&active=eq.true&select=step_index,day_offset&order=step_index.asc&limit=1`);
    const step0 = Array.isArray(steps) ? steps[0] : null;
    if (!step0) return { enrolled: false, reason: 'no_steps' };
    await sb('POST', '/pec_drip_enrollments', {
      lead_id: leadId,
      campaign_id: camp.id,
      status: 'active',
      next_step_index: step0.step_index,
      next_send_at: addDays(now.toISOString(), step0.day_offset).toISOString(),
    });
    return { enrolled: true };
  } catch (err) {
    const m = String(err && err.message || err);
    if (/23505|409|duplicate/i.test(m)) return { enrolled: false, reason: 'already_active' };
    console.warn('enrollLead failed (non-fatal):', m);
    return { enrolled: false, reason: 'error', error: m };
  }
}

// ---------------------------------------------------------------------------
// Kill-switches, re-checked at send time. Returns null (clear to proceed) or
// { action: 'stopped'|'completed', reason }.
// ---------------------------------------------------------------------------
async function checkKillSwitches(sb, enr, lead, campaign) {
  if (!lead || lead.deleted_at) return { action: 'stopped', reason: 'lead_missing' };
  if (lead.stage === 'lost') return { action: 'stopped', reason: 'lost' };
  // Beyond the pre-sale window: 'new' and 'contacted' keep dripping; anything
  // further means a human is engaged and the drip must shut up.
  if (['estimate_sent', 'presented', 'accepted'].includes(lead.stage)) {
    return { action: 'stopped', reason: 'stage_advanced' };
  }
  if (lead.opted_out) return { action: 'stopped', reason: 'opted_out' };
  if (enr.next_step_index >= campaign.max_touches) return { action: 'completed', reason: 'max_touches' };

  // Replied: ANY inbound text or call from this lead since enrollment.
  const since = encodeURIComponent(enr.enrolled_at);
  const tail = lead.phone_norm || phoneTail(lead.phone);
  const orParts = [];
  if (lead.customer_id) orParts.push(`customer_id.eq.${lead.customer_id}`);
  if (tail) orParts.push(`from_number.ilike.*${tail}`);
  if (orParts.length) {
    const orQ = encodeURIComponent(`(${orParts.join(',')})`);
    const [smsIn, callIn] = await Promise.all([
      sb('GET', `/pec_sms_log?direction=eq.in&created_at=gt.${since}&or=${orQ}&select=id&limit=1`),
      sb('GET', `/pec_call_log?direction=eq.in&occurred_at=gt.${since}&or=${orQ}&select=id&limit=1`),
    ]);
    if ((Array.isArray(smsIn) && smsIn.length) || (Array.isArray(callIn) && callIn.length)) {
      return { action: 'stopped', reason: 'replied' };
    }
  }
  return null;
}

async function endEnrollment(sb, enr, action, reason, nowIso) {
  // Guard on status=active so a concurrent run's stop cannot fight this one.
  await sb('PATCH', `/pec_drip_enrollments?id=eq.${encodeURIComponent(enr.id)}&status=eq.active`, {
    status: action, stop_reason: reason, stopped_at: nowIso, next_send_at: null,
  });
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
  const sw = await sb('GET', `/settings?key=eq.drip_sending_enabled&select=value&limit=1`);
  if (!Array.isArray(sw) || !sw[0] || sw[0].value !== 'true') {
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

      const leads = await sb('GET', `/leads?id=eq.${encodeURIComponent(enr.lead_id)}&select=*&limit=1`);
      const lead = (Array.isArray(leads) && leads[0] && !leads[0].deleted_at) ? leads[0] : null;

      // 3. Kill-switches at send time.
      const kill = await checkKillSwitches(sb, enr, lead, campaign);
      if (kill) {
        await endEnrollment(sb, enr, kill.action, kill.reason, nowIso);
        summary[kill.action === 'completed' ? 'completed' : 'stopped']++;
        continue;
      }

      const steps = await getSteps(enr.campaign_id);
      const step = steps.find(s => s.step_index >= enr.next_step_index);
      if (!step) { await endEnrollment(sb, enr, 'completed', 'no_more_steps', nowIso); summary.completed++; continue; }

      // 4. Channel resolution for THIS lead, this step.
      const wantSms = step.channel === 'sms' || step.channel === 'both';
      const wantEmail = step.channel === 'email' || step.channel === 'both';
      const smsTo = toE164(lead.phone);
      const canSms = wantSms && !!lead.sms_consent && !!smsTo;
      const canEmail = wantEmail && !!lead.email;
      const smsSkipReason = wantSms && !canSms ? (!lead.sms_consent ? 'no_sms_consent' : 'no_valid_phone') : null;
      const emailSkipReason = wantEmail && !canEmail ? 'no_email' : null;

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
        enrollment_id: enr.id, lead_id: lead.id, campaign_id: campaign.id,
        step_index: step.step_index, scheduled_for: enr.next_send_at,
      };
      const writeLedger = (row) => sb('POST', '/pec_drip_sends', { ...ledgerBase, ...row })
        .catch(e => console.error('pec-drip: ledger write failed', e.message));

      // Wanted-but-unsendable legs are recorded, so the ledger explains gaps.
      if (smsSkipReason) { await writeLedger({ channel: 'sms', status: 'skipped', error_message: smsSkipReason }); summary.skipped++; }
      if (emailSkipReason) { await writeLedger({ channel: 'email', status: 'skipped', error_message: emailSkipReason }); summary.skipped++; }
      if (!canSms && !canEmail) continue;   // nothing sendable this step; schedule already advanced

      // 7. Render the copy (one model call per touch).
      let copy;
      try {
        copy = await renderCopy(lead, step, campaign, { sms: canSms, email: canEmail });
      } catch (err) {
        const msg = 'ai_render_failed: ' + String(err && err.message || err).slice(0, 400);
        if (canSms) await writeLedger({ channel: 'sms', status: 'failed', error_message: msg });
        if (canEmail) await writeLedger({ channel: 'email', status: 'failed', error_message: msg });
        summary.failed++;
        continue;   // step consumed; next touch continues the sequence
      }
      let smsBody = canSms ? capSms(scrubCopy(copy.sms)) : null;
      const emailSubject = canEmail ? (scrubCopy(copy.email_subject) || step.email_subject || 'From Prescott Epoxy') : null;
      const emailBody = canEmail ? scrubCopy(copy.email_body) : null;

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
        if (!smsSenderCache[DRIP_BRAND]) {
          const senders = await sb('GET', `/pec_sms_senders?brand=eq.${DRIP_BRAND}&active=eq.true&select=*&limit=1`);
          smsSenderCache[DRIP_BRAND] = (Array.isArray(senders) && senders[0]) || null;
        }
        const sender = smsSenderCache[DRIP_BRAND];
        if (!sender || !sender.from_number) {
          await writeLedger({ channel: 'sms', status: 'failed', body: smsBody, error_message: 'no active SMS sender for brand' });
          summary.failed++;
        } else {
          let out;
          try { out = await sendSms({ from: sender.from_number, to: smsTo, content: smsBody }); }
          catch (err) { out = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
          await sb('POST', '/pec_sms_log', {
            direction: 'out', brand: DRIP_BRAND, from_number: sender.from_number, to_number: smsTo,
            customer_id: lead.customer_id, body: smsBody, kind: 'drip',
            status: out.ok ? 'sent' : 'failed', quo_message_id: out.id, error_message: out.error,
          }).catch(e => console.error('pec-drip: sms log failed', e.message));
          await writeLedger({ channel: 'sms', status: out.ok ? 'sent' : 'failed', body: smsBody, provider_id: out.id, sent_at: out.ok ? now().toISOString() : null, error_message: out.error });
          if (out.ok) { anySent = true; summary.sent++; } else summary.failed++;
        }
      }
      if (canEmail && emailBody) {
        if (!emailSenderCache[DRIP_BRAND]) {
          const senders = await sb('GET', `/pec_email_senders?brand=eq.${DRIP_BRAND}&select=*&limit=1`);
          emailSenderCache[DRIP_BRAND] = (Array.isArray(senders) && senders[0]) || null;
        }
        const sender = emailSenderCache[DRIP_BRAND];
        if (!sender || !sender.from_email) {
          await writeLedger({ channel: 'email', status: 'failed', subject: emailSubject, body: emailBody, error_message: 'no email sender for brand' });
          summary.failed++;
        } else {
          let out;
          try {
            out = await sendEmail({
              from: `${sender.from_name} <${sender.from_email}>`, to: lead.email,
              subject: emailSubject, html: dripEmailHtml(emailBody), reply_to: sender.reply_to || undefined,
            });
          } catch (err) { out = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
          await sb('POST', '/pec_email_log', {
            customer_id: lead.customer_id, brand: DRIP_BRAND, template_key: 'drip',
            to_email: lead.email, from_email: sender.from_email, subject: emailSubject,
            status: out.ok ? 'sent' : 'failed', resend_id: out.id, error_message: out.error,
          }).catch(e => console.error('pec-drip: email log failed', e.message));
          await writeLedger({ channel: 'email', status: out.ok ? 'sent' : 'failed', subject: emailSubject, body: emailBody, provider_id: out.id, sent_at: out.ok ? now().toISOString() : null, error_message: out.error });
          if (out.ok) { anySent = true; summary.sent++; } else summary.failed++;
        }
      }

      // 10. First-touch stamp, only when null (contacted_at is a write-once
      // first-contact column; speed-to-lead depends on it). Dry runs never
      // touch it.
      if (anySent && !lead.contacted_at) {
        await sb('PATCH', `/leads?id=eq.${encodeURIComponent(lead.id)}&contacted_at=is.null`, { contacted_at: now().toISOString() })
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

module.exports = {
  runDrips, enrollLead, checkKillSwitches, quietHours, toE164, phoneTail,
  scrubCopy, capSms, dripEmailHtml, buildRenderPrompt, RENDER_SYSTEM_PROMPT,
  RUN_CAP, STOP_LINE,
};
