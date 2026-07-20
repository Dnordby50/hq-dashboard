// Appointment confirmation + reminder core (prompt 37). Shared by
// pec-appt-notify.cjs (the immediate on-book kick, staff JWT) and
// pec-appt-reminder-runner.cjs (the 15-minute scheduled tick, the safety
// net). One engine, two callers, same posture as the blast drain.
//
// SAFETY MODEL:
//   - Idempotency: the pec_appointment_reminder_sends ledger's unique index
//     on (appointment_id, rule_id, channel) IS the claim. A send leg first
//     INSERTs its ledger row with status 'claimed'; a 409/conflict means
//     another pass owns that leg and this one walks away. A crash after
//     claim but before send leaves a 'claimed' row that is NEVER retried
//     (the first request may have landed; never-double-text beats
//     never-lose-a-touch, same rule as the drip engine).
//   - Consent, re-checked at send time from the live row: a lead needs
//     positive sms_consent AND not opted_out for texts, email_consent for
//     email; a customer is opt-out-only (sms_opt_out). No consent writes a
//     'skipped_consent' ledger row so the leg is never re-evaluated.
//   - Quiet hours: SMS only inside 08:00-20:00 America/Phoenix. A held SMS
//     leg writes NO ledger row, so the next in-window tick picks it up.
//     Email sends any time.
//   - Past appointments never message the customer: a rule that comes due
//     after start_at has passed writes 'skipped_past'.
//   - Ad-hoc blocks (type 'other' with no lead/customer) send nothing.
//   - Copy hygiene: rendered bodies are scrubbed of em dashes (standing rule
//     6 is enforced in code, not left to whoever edits the template), and
//     every customer SMS carries the STOP line.
//
// Rules semantics (pec_appointment_reminder_rules):
//   on_book=true  -> fires once shortly after booking (offset ignored).
//   on_book=false -> fires when now >= start_at - offset_minutes.
//   appt_type null = all types. audience 'customer' sends sms/email per
//   channel; audience 'salesperson' supports channel 'in_app' only (the
//   roster has no phone/email columns) and lands in the pec_notifications
//   bell. The on-book salesperson bell is NOT a rule: the client's
//   log_appointment_booked RPC covers it instantly at booking time.

const {
  quietHours, toE164, sendQuoSmsReal, sendResendEmailReal,
  getSmsSender, getEmailSender, dripEmailHtml,
} = require('./_pec-drip.cjs');

const BRAND = 'prescott-epoxy';
const STOP_LINE = ' Reply STOP to opt out.';
const PHX_TZ = 'America/Phoenix';

function fmtPhx(iso, opts) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: PHX_TZ, ...opts }).format(new Date(iso)); }
  catch (_) { return String(iso); }
}
const apptDateStr = (iso) => fmtPhx(iso, { weekday: 'long', month: 'long', day: 'numeric' });
const apptTimeStr = (iso) => fmtPhx(iso, { hour: 'numeric', minute: '2-digit' });

// Standing rule 6, enforced on stored templates: no em dash reaches a
// customer no matter what was typed into the rules editor.
const scrubDashes = (s) => String(s == null ? '' : s).replace(/\s*[—–]\s*/g, ', ');

function renderTemplate(tpl, ctx) {
  return scrubDashes(tpl || '')
    .replace(/\{customer_first\}/g, ctx.customerFirst || 'there')
    .replace(/\{appt_date\}/g, ctx.date || '')
    .replace(/\{appt_time\}/g, ctx.time || '')
    .replace(/\{sales_name\}/g, ctx.salesName || 'our estimator')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Who to message and may we. Lead first (it carries explicit consent
// columns); customer as fallback (opt-out-only, the drip engine's deliberate
// reading). Null = nobody to contact.
async function resolveApptRecipient(sb, appt) {
  if (appt.lead_id) {
    const rows = await sb('GET', `/leads?id=eq.${encodeURIComponent(appt.lead_id)}&select=first_name,full_name,phone,email,sms_consent,email_consent,opted_out&limit=1`);
    const l = Array.isArray(rows) ? rows[0] : null;
    if (l) {
      return {
        customer_id: appt.customer_id || null,
        first: (l.first_name || String(l.full_name || '').split(' ')[0] || '').trim(),
        phone: toE164(l.phone), email: l.email || null,
        smsOk: !!l.sms_consent && !l.opted_out,
        emailOk: l.email_consent !== false && !l.opted_out,
      };
    }
  }
  if (appt.customer_id) {
    const rows = await sb('GET', `/customers?id=eq.${encodeURIComponent(appt.customer_id)}&select=id,name,first_name,phone,email,sms_opt_out&limit=1`);
    const c = Array.isArray(rows) ? rows[0] : null;
    if (c) {
      return {
        customer_id: c.id,
        first: (c.first_name || String(c.name || '').split(' ')[0] || '').trim(),
        phone: toE164(c.phone), email: c.email || null,
        smsOk: !c.sms_opt_out, emailOk: true,
      };
    }
  }
  return null;
}

// Claim one (appointment, rule, channel) leg. True = we own it; false =
// already claimed/sent by an earlier or concurrent pass.
async function claimLeg(sb, apptId, ruleId, channel) {
  try {
    await sb('POST', '/pec_appointment_reminder_sends', {
      appointment_id: apptId, rule_id: ruleId, channel, status: 'claimed',
    });
    return true;
  } catch (e) {
    if (/409|duplicate|unique/i.test(String(e && e.message))) return false;
    throw e;
  }
}
async function settleLeg(sb, apptId, ruleId, channel, status) {
  await sb('PATCH',
    `/pec_appointment_reminder_sends?appointment_id=eq.${encodeURIComponent(apptId)}&rule_id=eq.${encodeURIComponent(ruleId)}&channel=eq.${encodeURIComponent(channel)}`,
    { status, sent_at: new Date().toISOString() });
}
// A skip is terminal bookkeeping, not a claim-then-send: write it directly
// (conflict = some other pass already recorded this leg, which is fine).
async function skipLeg(sb, apptId, ruleId, channel, status, summary) {
  try {
    await sb('POST', '/pec_appointment_reminder_sends', {
      appointment_id: apptId, rule_id: ruleId, channel, status,
    });
    summary.skipped++;
  } catch (_) { /* already recorded */ }
}

async function processCustomerRule(sb, rule, appt, ctx, now, summary, caches, senders) {
  const wantSms = rule.channel === 'sms' || rule.channel === 'both';
  const wantEmail = rule.channel === 'email' || rule.channel === 'both';
  const rcpt = await resolveApptRecipient(sb, appt);
  if (!rcpt) {
    if (wantSms) await skipLeg(sb, appt.id, rule.id, 'sms', 'skipped_no_contact', summary);
    if (wantEmail) await skipLeg(sb, appt.id, rule.id, 'email', 'skipped_no_contact', summary);
    return;
  }
  ctx.customerFirst = rcpt.first;
  // The customer-facing "Job notes" ride every customer message on both
  // channels (prompt 38): appended after the template, scrubbed of em dashes
  // like everything else customer-facing. Salesperson messages never carry
  // it; select('*') simply lacks the column pre-migration, so this is a
  // clean no-op until 2026-07-21_appointment_customer_notes.sql lands.
  const jobNote = String(appt.customer_notes || '').trim();
  const body = renderTemplate(rule.message_template, ctx)
    + (jobNote ? '\n\n' + scrubDashes(jobNote) : '');
  const started = new Date(appt.start_at) <= now;

  if (wantSms) {
    if (started) await skipLeg(sb, appt.id, rule.id, 'sms', 'skipped_past', summary);
    else if (!rcpt.phone) await skipLeg(sb, appt.id, rule.id, 'sms', 'skipped_no_contact', summary);
    else if (!rcpt.smsOk) await skipLeg(sb, appt.id, rule.id, 'sms', 'skipped_consent', summary);
    else if (!quietHours(now).inWindow) summary.held_quiet++; // no ledger row: retried next in-window tick
    else if (await claimLeg(sb, appt.id, rule.id, 'sms')) {
      const sender = await getSmsSender(sb, caches.sms);
      let out;
      if (!sender || !sender.from_number) out = { ok: false, id: null, error: 'no SMS sender for brand' };
      else {
        try { out = await senders.sendSms({ from: sender.from_number, to: rcpt.phone, content: body + STOP_LINE }); }
        catch (err) { out = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
      }
      await sb('POST', '/pec_sms_log', {
        direction: 'out', brand: BRAND,
        from_number: sender ? sender.from_number : null, to_number: rcpt.phone,
        customer_id: rcpt.customer_id, body: body + STOP_LINE, kind: 'appointment',
        status: out.ok ? 'sent' : 'failed', quo_message_id: out.id, error_message: out.error,
      }).catch(e => console.error('pec-appt: sms log failed', e.message));
      await settleLeg(sb, appt.id, rule.id, 'sms', out.ok ? 'sent' : 'failed');
      if (out.ok) summary.sent++; else summary.failed++;
    }
  }

  if (wantEmail) {
    if (started) await skipLeg(sb, appt.id, rule.id, 'email', 'skipped_past', summary);
    else if (!rcpt.email) await skipLeg(sb, appt.id, rule.id, 'email', 'skipped_no_contact', summary);
    else if (!rcpt.emailOk) await skipLeg(sb, appt.id, rule.id, 'email', 'skipped_consent', summary);
    else if (await claimLeg(sb, appt.id, rule.id, 'email')) {
      const sender = await getEmailSender(sb, caches.email);
      const subject = rule.on_book
        ? 'Your appointment with Prescott Epoxy Company is booked'
        : 'Appointment reminder from Prescott Epoxy Company';
      const html = dripEmailHtml(body);
      let out;
      if (!sender || !sender.from_email) out = { ok: false, id: null, error: 'no email sender for brand' };
      else {
        try {
          out = await senders.sendEmail({
            from: `${sender.from_name} <${sender.from_email}>`, to: rcpt.email,
            subject, html, reply_to: sender.reply_to || undefined,
          });
        } catch (err) { out = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
      }
      await sb('POST', '/pec_email_log', {
        customer_id: rcpt.customer_id, brand: BRAND, template_key: 'appointment',
        to_email: rcpt.email, from_email: sender ? sender.from_email : null, subject,
        body_html: html, status: out.ok ? 'sent' : 'failed', resend_id: out.id, error_message: out.error,
      }).catch(e => console.error('pec-appt: email log failed', e.message));
      await settleLeg(sb, appt.id, rule.id, 'email', out.ok ? 'sent' : 'failed');
      if (out.ok) summary.sent++; else summary.failed++;
    }
  }
}

async function processSalespersonRule(sb, rule, appt, ctx, summary) {
  // Roster members have no phone/email columns; in_app is the only channel
  // that can actually reach them. Anything else is recorded, not guessed at.
  if (rule.channel !== 'in_app') {
    await skipLeg(sb, appt.id, rule.id, 'in_app', 'skipped_no_contact', summary);
    return;
  }
  if (!(await claimLeg(sb, appt.id, rule.id, 'in_app'))) return;
  const body = renderTemplate(rule.message_template, ctx)
    || `Upcoming appointment for ${ctx.salesName || 'the sales team'}: ${ctx.date} at ${ctx.time}.`;
  try {
    await sb('POST', '/pec_notifications', {
      type: 'appointment_reminder', body,
      target_view: 'appointments', target_id: appt.id,
    });
    await settleLeg(sb, appt.id, rule.id, 'in_app', 'sent');
    summary.sent++;
  } catch (e) {
    await settleLeg(sb, appt.id, rule.id, 'in_app', 'failed').catch(() => {});
    summary.failed++;
  }
}

// The tick. opts.appointmentId narrows to one appointment (the on-book kick);
// without it the runner scans for due work. Always safe to call again: the
// ledger makes every leg exactly-once.
async function runApptReminders(deps, opts = {}) {
  const sb = deps.sb;
  const now = deps.now ? deps.now() : new Date();
  // Injectable providers (fixture test drives the real engine, same pattern
  // as runDrips); production callers pass only { sb }.
  const senders = {
    sendSms: deps.sendSms || sendQuoSmsReal,
    sendEmail: deps.sendEmail || sendResendEmailReal,
  };
  const summary = { rules: 0, appts: 0, sent: 0, failed: 0, skipped: 0, held_quiet: 0, not_migrated: false };

  let rules;
  try {
    rules = await sb('GET', '/pec_appointment_reminder_rules?enabled=eq.true&select=*');
  } catch (e) {
    // Pre-migration: the table does not exist yet. A silent no-op keeps the
    // scheduled tick green until Cowork applies the migration.
    summary.not_migrated = true;
    return summary;
  }
  rules = Array.isArray(rules) ? rules : [];
  summary.rules = rules.length;
  if (!rules.length) return summary;
  const onBookRules = rules.filter(r => r.on_book);
  const offsetRules = rules.filter(r => !r.on_book);

  // Target appointments. On-book rules look back 24h of creations (so a
  // quiet-hours-held confirmation still goes out next morning); offset rules
  // look forward to the largest configured offset.
  let appts = [];
  if (opts.appointmentId) {
    appts = await sb('GET', `/pec_appointments?id=eq.${encodeURIComponent(opts.appointmentId)}&status=eq.scheduled&select=*&limit=1`);
    appts = Array.isArray(appts) ? appts : [];
  } else {
    const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const maxOffsetMin = offsetRules.reduce((mx, r) => Math.max(mx, Number(r.offset_minutes) || 0), 0);
    const horizon = new Date(now.getTime() + (maxOffsetMin + 20) * 60000).toISOString();
    const [recent, upcoming] = await Promise.all([
      onBookRules.length
        ? sb('GET', `/pec_appointments?status=eq.scheduled&created_at=gte.${encodeURIComponent(dayAgo)}&select=*&limit=200`)
        : Promise.resolve([]),
      offsetRules.length
        ? sb('GET', `/pec_appointments?status=eq.scheduled&start_at=gte.${encodeURIComponent(now.toISOString())}&start_at=lte.${encodeURIComponent(horizon)}&select=*&limit=200`)
        : Promise.resolve([]),
    ]);
    const seen = new Set();
    for (const a of [...(recent || []), ...(upcoming || [])]) {
      if (a && !seen.has(a.id)) { seen.add(a.id); appts.push(a); }
    }
  }
  if (!appts.length) return summary;
  summary.appts = appts.length;

  const caches = { sms: {}, email: {} };
  const salesNames = {};
  for (const appt of appts) {
    // Ad-hoc blocks with nobody attached are private busy time, not comms.
    const adHoc = appt.appt_type === 'other' && !appt.lead_id && !appt.customer_id;
    let salesName = '';
    if (appt.sales_member_id) {
      if (!(appt.sales_member_id in salesNames)) {
        const r = await sb('GET', `/pec_sales_team_members?id=eq.${encodeURIComponent(appt.sales_member_id)}&select=name&limit=1`).catch(() => []);
        salesNames[appt.sales_member_id] = (Array.isArray(r) && r[0] && r[0].name) || '';
      }
      salesName = salesNames[appt.sales_member_id];
    }
    const ctx = { date: apptDateStr(appt.start_at), time: apptTimeStr(appt.start_at), salesName };

    for (const rule of rules) {
      if (rule.appt_type && rule.appt_type !== appt.appt_type) continue;
      const due = rule.on_book
        ? true // targets are already creation-windowed (or the explicit kick)
        : (new Date(appt.start_at).getTime() - (Number(rule.offset_minutes) || 0) * 60000) <= now.getTime();
      if (!due) continue;
      try {
        if (rule.audience === 'customer') {
          if (adHoc) continue; // nothing to send, and no ledger noise
          await processCustomerRule(sb, rule, appt, { ...ctx }, now, summary, caches, senders);
        } else if (rule.audience === 'salesperson') {
          if (rule.on_book) continue; // covered by the booking RPC bell
          await processSalespersonRule(sb, rule, appt, ctx, summary);
        }
      } catch (err) {
        console.error(`pec-appt: rule ${rule.id} for appt ${appt.id} failed:`, err && err.message || err);
        summary.failed++;
      }
    }
  }
  return summary;
}

module.exports = { runApptReminders, resolveApptRecipient, renderTemplate, scrubDashes, apptDateStr, apptTimeStr };
