// Stripe webhook: the ONLY place an online payment is recorded. Verifies the
// Stripe-Signature HMAC with node:crypto (no SDK), then routes on event TYPE
// FIRST (the Quo lesson, 2026-07-07: classify on the discriminator before any
// field guard; the old top-level "ignore unless payment_status paid" check
// would have swallowed the async ACH events, which carry the same session
// object shape):
//   checkout.session.completed, payment_status 'paid'   -> card path, unchanged:
//     idempotent pec_payments insert keyed on the PaymentIntent id in
//     `reference`, then the best-effort deposit auto-flip.
//   checkout.session.completed, payment_status 'unpaid' -> ACH initiated:
//     idempotent pec_stripe_pending marker (status 'pending'). NO pec_payments
//     row and NO deposit flip (prompt 11 decisions 4 and 6): the money is not
//     real until it settles 3 to 5 business days later.
//   checkout.session.async_payment_succeeded -> ACH settled: the SAME
//     idempotent recording as the card path (received_date = settlement day by
//     construction, since phoenixToday() runs when THIS event arrives), then
//     the pending marker flips to 'succeeded' with resolved_at.
//   checkout.session.async_payment_failed -> the marker flips to 'failed' with
//     the bank's reason, and the office is alerted by Slack and email (both
//     best-effort, neither can fail the webhook response). Invoicing renders
//     the failed marker as a red chip until a later payment lands for the job.
// Everything else 200s as ignored. Genuine DB failures on any recording path
// return 500 so Stripe RETRIES; every write here is idempotent (unique keys on
// pec_payments.reference and pec_stripe_pending.payment_intent), so a retry
// can never double-record, and the failure alerts fire only on the
// pending-to-failed TRANSITION so a retried delivery cannot double-ping.
const crypto = require('crypto');
const { sb } = require('./_pec-supabase.cjs');
// Prompt 45: after a payment records, stamp any installment it covers 'paid'
// (best-effort; the resolver derives settlement from money, so a missed stamp
// self-heals on the next settle call).
const { settleInstallments } = require('./_pec-installments.cjs');
const { depositOwed } = require('../../production/deposits.cjs');

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SLACK_OFFICE_WEBHOOK = process.env.SLACK_OFFICE_WEBHOOK;
// Decision 8 (prompt 11): ACH failure emails go to Dylan.
const OFFICE_NOTIFY_EMAIL = process.env.OFFICE_NOTIFY_EMAIL || 'dnordby50@gmail.com';

const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || { received: true }) });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// America/Phoenix is UTC-7 year round (no DST).
const phoenixToday = () => new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);

// Verify "Stripe-Signature: t=<ts>,v1=<hexsig>" = HMAC-SHA256(`${t}.${rawBody}`).
function verifyStripe(sigHeader, rawBody, secret) {
  if (!sigHeader || !secret) return false;
  let t, v1;
  for (const part of String(sigHeader).split(',')) {
    const i = part.indexOf('=');
    const k = part.slice(0, i);
    const val = part.slice(i + 1);
    if (k === 't') t = val;
    else if (k === 'v1' && !v1) v1 = val; // first v1 scheme entry is sufficient
  }
  if (!t || !v1) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false; // 5-min replay guard
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The recording path, shared byte-for-byte between a paid card checkout and an
// ACH settlement. Idempotent on the PaymentIntent id in `reference`; the
// partial-unique index is the hard guard against concurrent retries. Returns
// { duplicate: true } or { recorded: true }; throws on genuine DB failure so
// the caller can 500 and Stripe retries.
async function recordPayment(s, jobId, kind, piId, amount) {
  const existing = await sb('GET', `/pec_payments?reference=eq.${encodeURIComponent(piId)}&select=id&limit=1`);
  if (Array.isArray(existing) && existing.length) return { duplicate: true };

  let paymentId = null;
  try {
    const inserted = await sb('POST', '/pec_payments', {
      job_id: jobId,
      amount,
      method: 'stripe',
      reference: piId,
      received_date: phoenixToday(),
      recorded_by: 'Stripe',
      notes: `Stripe Checkout ${s.id || ''}`.trim(),
    }, true);
    paymentId = (Array.isArray(inserted) && inserted[0] && inserted[0].id) || null;
  } catch (insErr) {
    // Another delivery already recorded it (unique violation) -> success.
    if (/duplicate key|unique/i.test(insErr.message || '')) return { duplicate: true };
    throw insErr;
  }

  // Auto-reflect the deposit, mirroring the in-app rule. pec_job_ar.paid_to_date
  // already includes the row we just inserted (it sums pec_payments). For ACH
  // this runs at SETTLEMENT, never at initiation (decision 6).
  try {
    const jr = await sb('GET', `/pec_job_ar?id=eq.${encodeURIComponent(jobId)}&select=price,paid_to_date,deposit_amount,deposit_collected,deposit_waived&limit=1`);
    const j = Array.isArray(jr) ? jr[0] : null;
    if (j && !j.deposit_collected && !j.deposit_waived) {
      const owed = depositOwed(j.deposit_amount, j.price); // the ONE shared rule (production/deposits.cjs)
      const paid = round2(j.paid_to_date);
      if (kind === 'deposit' || paid + 0.005 >= owed) {
        await sb('PATCH', `/jobs?id=eq.${encodeURIComponent(jobId)}`, { deposit_collected: true });
      }
    }
  } catch (depErr) {
    // The payment is recorded; never fail the webhook over the deposit flag.
    console.error('stripe-webhook: deposit reflect failed (payment recorded)', depErr.message);
  }

  // Prompt 45: advance the payment schedule. Every installment the money now
  // covers flips to 'paid' (the current ask then advances by construction,
  // since the resolver derives "current" from the same allocation). Runs for
  // EVERY kind, not just kind=installment: a full-balance or deposit payment
  // settles schedule lines just the same. Best-effort, never fails the
  // webhook; a miss self-heals on the next payment or runner tick.
  try {
    await settleInstallments(sb, jobId, { paymentId });
  } catch (setErr) {
    console.error('stripe-webhook: installment settle failed (payment recorded)', setErr.message);
  }

  return { recorded: true };
}

// Best-effort: pull the bank's failure reason off the PaymentIntent so the
// alert says WHY (insufficient funds, revoked authorization, ...). Any problem
// falls back to a generic line; this can never block the failure handling.
async function fetchFailureReason(piId) {
  const fallback = 'ACH payment failed (the bank returned the debit)';
  if (!STRIPE_SECRET_KEY || !/^pi_/.test(String(piId))) return fallback;
  try {
    const res = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(piId)}`, {
      headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
    });
    const data = await res.json().catch(() => ({}));
    const msg = data && data.last_payment_error && data.last_payment_error.message;
    return msg ? String(msg).slice(0, 500) : fallback;
  } catch (_) { return fallback; }
}

// ACH failure alerts (decision 8): Slack #epoxysales + email to Dylan, each
// channel best-effort and independent (the pec-invoice-intent pattern), and
// NEITHER may fail the webhook response. The red job flag needs no send: it is
// the failed pec_stripe_pending row rendering in Invoicing.
async function sendFailureAlerts({ jobId, amount, reason }) {
  // Names for the alert; the alert still goes out generically if this read fails.
  let customer = 'Customer', invNo = String(jobId || '').slice(0, 8), balance = null, brandKey = 'prescott-epoxy', token = null;
  try {
    const rows = await sb('GET', `/pec_job_ar?id=eq.${encodeURIComponent(jobId)}&select=customer_name,hq_invoice_number,dripjobs_deal_id,balance_remaining,customer_company,public_token&limit=1`);
    const r = Array.isArray(rows) ? rows[0] : null;
    if (r) {
      customer = r.customer_name || customer;
      invNo = r.hq_invoice_number || r.dripjobs_deal_id || invNo;
      balance = r.balance_remaining;
      brandKey = r.customer_company || brandKey;
      token = r.public_token || null;
    }
  } catch (e) { console.error('stripe-webhook: alert lookup failed (alerting generically)', e.message); }

  const balanceLine = balance != null ? ` Balance still owed: ${usd(balance)}.` : '';

  // Slack (best-effort)
  if (SLACK_OFFICE_WEBHOOK) {
    try {
      const text = `:rotating_light: ACH payment FAILED: *${customer}*, invoice *#${invNo}*, ${usd(amount)}.\nReason: ${reason}.${balanceLine}\nThe job is flagged red in Invoicing until a new payment lands.`;
      const res = await fetch(SLACK_OFFICE_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!res.ok) console.error('stripe-webhook: slack alert failed', res.status);
    } catch (e) { console.error('stripe-webhook: slack alert error', e.message); }
  } else {
    console.error('stripe-webhook: SLACK_OFFICE_WEBHOOK not configured; ACH failure not slacked');
  }

  // Email to Dylan (best-effort, Resend, brand sender like pec-invoice-intent)
  try {
    if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
    let sender = null;
    try {
      const senders = await sb('GET', `/pec_email_senders?brand=eq.${encodeURIComponent(brandKey)}&select=*&limit=1`);
      sender = Array.isArray(senders) ? senders[0] : null;
    } catch (_) { /* fall through to the guard below */ }
    if (!sender || !sender.from_email) throw new Error('No email sender configured for brand ' + brandKey);
    const payUrl = token ? `${process.env.URL || 'https://prescottepoxy.netlify.app'}/pay/${token}` : null;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
      <p>The ACH payment of <strong>${esc(usd(amount))}</strong> from <strong>${esc(customer)}</strong> on invoice <strong>#${esc(invNo)}</strong> FAILED after initiation.</p>
      <p>Bank reason: ${esc(reason)}</p>
      <p>${balance != null ? 'Balance still owed: <strong>' + esc(usd(balance)) + '</strong>. ' : ''}The job shows a red "ACH failed" chip in Invoicing until a new payment lands. Reach out to the customer to arrange payment again.</p>
      ${payUrl ? `<p>Invoice: <a href="${esc(payUrl)}">${esc(payUrl)}</a></p>` : ''}
    </div>`;
    const payload = {
      from: `${sender.from_name || 'Prescott Epoxy Company'} <${sender.from_email}>`,
      to: [OFFICE_NOTIFY_EMAIL],
      subject: `ACH payment failed: ${customer}, invoice #${invNo} (${usd(amount)})`,
      html,
    };
    if (sender.reply_to) payload.reply_to = sender.reply_to;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error('stripe-webhook: email alert failed', res.status, await res.text().catch(() => ''));
  } catch (e) { console.error('stripe-webhook: email alert error', e.message); }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  if (!STRIPE_WEBHOOK_SECRET) { console.error('stripe-webhook: STRIPE_WEBHOOK_SECRET not set'); return reply(503, { error: 'not configured' }); }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!verifyStripe(sig, rawBody, STRIPE_WEBHOOK_SECRET)) return reply(400, { error: 'invalid signature' });

  let evt;
  try { evt = JSON.parse(rawBody || '{}'); } catch (_) { return reply(400, { error: 'bad json' }); }

  // Route on the event TYPE first; acknowledge everything unhandled with 200.
  const HANDLED = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed']);
  if (!HANDLED.has(evt.type)) return reply(200, { ignored: evt.type });

  // All three handled events carry the full Checkout Session object.
  const s = (evt.data && evt.data.object) || {};
  const md = s.metadata || {};
  const jobId = md.job_id || null;
  const kind = md.kind || 'balance';
  const piId = typeof s.payment_intent === 'string' ? s.payment_intent : ((s.payment_intent && s.payment_intent.id) || s.id);
  const amount = round2((Number(s.amount_total) || 0) / 100);
  if (!jobId || !piId || !(amount > 0)) { console.error('stripe-webhook: incomplete session', { type: evt.type, jobId, piId, amount }); return reply(200, { ignored: 'incomplete' }); }

  // ---- checkout.session.completed ------------------------------------------
  if (evt.type === 'checkout.session.completed') {
    // Card (or otherwise already-paid) checkout: record now. A missing
    // payment_status is treated as paid, matching the original behavior.
    if (!s.payment_status || s.payment_status === 'paid') {
      try {
        const out = await recordPayment(s, jobId, kind, piId, amount);
        return reply(200, out);
      } catch (err) {
        // Genuine DB failure: 500 so Stripe RETRIES and the idempotent insert lands.
        console.error('stripe-webhook: record failed', err.message);
        return reply(500, { error: 'record failed' });
      }
    }
    // ACH initiated: session completed UNPAID. Write the pending marker only.
    if (s.payment_status === 'unpaid') {
      try {
        const existing = await sb('GET', `/pec_stripe_pending?payment_intent=eq.${encodeURIComponent(piId)}&select=id&limit=1`);
        if (Array.isArray(existing) && existing.length) return reply(200, { duplicate: true });
        try {
          await sb('POST', '/pec_stripe_pending', { payment_intent: piId, job_id: jobId, kind, amount, status: 'pending' });
        } catch (insErr) {
          // A retried delivery raced us past the existence check -> success.
          if (/duplicate key|unique/i.test(insErr.message || '')) return reply(200, { duplicate: true });
          throw insErr;
        }
        return reply(200, { pending: true });
      } catch (err) {
        console.error('stripe-webhook: pending marker failed', err.message);
        return reply(500, { error: 'pending marker failed' });
      }
    }
    // no_payment_required or any future status: nothing to record.
    return reply(200, { ignored: s.payment_status });
  }

  // ---- checkout.session.async_payment_succeeded (ACH settled) ---------------
  if (evt.type === 'checkout.session.async_payment_succeeded') {
    try {
      const out = await recordPayment(s, jobId, kind, piId, amount);
      // Flip the marker inside the try: if this PATCH fails we 500 and Stripe
      // retries the whole delivery; recordPayment dedupes on the reference key,
      // then the PATCH runs again. A missing marker row (pre-migration
      // initiation, or path b never landed) matches zero rows and is fine: the
      // payment row above is the source of truth.
      await sb('PATCH', `/pec_stripe_pending?payment_intent=eq.${encodeURIComponent(piId)}`, { status: 'succeeded', resolved_at: new Date().toISOString() });
      return reply(200, { ...out, settled: true });
    } catch (err) {
      console.error('stripe-webhook: settlement record failed', err.message);
      return reply(500, { error: 'settlement record failed' });
    }
  }

  // ---- checkout.session.async_payment_failed (ACH bounced days later) -------
  try {
    const rows = await sb('GET', `/pec_stripe_pending?payment_intent=eq.${encodeURIComponent(piId)}&select=id,status&limit=1`);
    const prior = Array.isArray(rows) ? rows[0] : null;
    const alreadyFailed = !!(prior && prior.status === 'failed');
    const reason = await fetchFailureReason(piId);
    if (prior) {
      if (!alreadyFailed) {
        await sb('PATCH', `/pec_stripe_pending?payment_intent=eq.${encodeURIComponent(piId)}`, { status: 'failed', failure_message: reason, resolved_at: new Date().toISOString() });
      }
    } else {
      // Initiation event never landed (or pre-migration): create the failed
      // marker directly so the red chip still shows in Invoicing.
      try {
        await sb('POST', '/pec_stripe_pending', { payment_intent: piId, job_id: jobId, kind, amount, status: 'failed', failure_message: reason, resolved_at: new Date().toISOString() });
      } catch (insErr) {
        if (!/duplicate key|unique/i.test(insErr.message || '')) throw insErr;
        await sb('PATCH', `/pec_stripe_pending?payment_intent=eq.${encodeURIComponent(piId)}`, { status: 'failed', failure_message: reason, resolved_at: new Date().toISOString() });
      }
    }
    // Alerts fire only on the TRANSITION to failed, so a Stripe retry of this
    // delivery (or a 500 below on a later attempt) cannot double-ping.
    if (!alreadyFailed) await sendFailureAlerts({ jobId, amount, reason });
    return reply(200, { failed_marked: true });
  } catch (err) {
    console.error('stripe-webhook: failure marking failed', err.message);
    return reply(500, { error: 'failure marking failed' });
  }
};
