// Stripe webhook: the ONLY place an online card payment is recorded. Verifies the
// Stripe-Signature HMAC with node:crypto (no SDK), then on a paid
// checkout.session.completed inserts an idempotent pec_payments row keyed on the
// PaymentIntent id, and auto-marks the deposit collected when the payment covers
// it. Mirrors the Svix verification in pec-webhook-resend.cjs.
const crypto = require('crypto');
const { sb } = require('./_pec-supabase.cjs');

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || { received: true }) });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  if (!STRIPE_WEBHOOK_SECRET) { console.error('stripe-webhook: STRIPE_WEBHOOK_SECRET not set'); return reply(503, { error: 'not configured' }); }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!verifyStripe(sig, rawBody, STRIPE_WEBHOOK_SECRET)) return reply(400, { error: 'invalid signature' });

  let evt;
  try { evt = JSON.parse(rawBody || '{}'); } catch (_) { return reply(400, { error: 'bad json' }); }

  // Act only on a completed, paid checkout; acknowledge everything else with 200.
  if (evt.type !== 'checkout.session.completed') return reply(200, { ignored: evt.type });
  const s = (evt.data && evt.data.object) || {};
  if (s.payment_status && s.payment_status !== 'paid') return reply(200, { ignored: 'unpaid' });

  const md = s.metadata || {};
  const jobId = md.job_id || null;
  const kind = md.kind || 'balance';
  const piId = typeof s.payment_intent === 'string' ? s.payment_intent : ((s.payment_intent && s.payment_intent.id) || s.id);
  const amount = round2((Number(s.amount_total) || 0) / 100);
  if (!jobId || !piId || !(amount > 0)) { console.error('stripe-webhook: incomplete session', { jobId, piId, amount }); return reply(200, { ignored: 'incomplete' }); }

  try {
    // Idempotent on the PaymentIntent id in `reference`. The partial-unique index
    // (recommended migration) is the hard guard against concurrent retries.
    const existing = await sb('GET', `/pec_payments?reference=eq.${encodeURIComponent(piId)}&select=id&limit=1`);
    if (Array.isArray(existing) && existing.length) return reply(200, { duplicate: true });

    try {
      await sb('POST', '/pec_payments', {
        job_id: jobId,
        amount,
        method: 'stripe',
        reference: piId,
        received_date: phoenixToday(),
        recorded_by: 'Stripe',
        notes: `Stripe Checkout ${s.id || ''}`.trim(),
      });
    } catch (insErr) {
      // Another delivery already recorded it (unique violation) -> success.
      if (/duplicate key|unique/i.test(insErr.message || '')) return reply(200, { duplicate: true });
      throw insErr;
    }

    // Auto-reflect the deposit, mirroring the in-app rule. pec_job_ar.paid_to_date
    // already includes the row we just inserted (it sums pec_payments).
    try {
      const jr = await sb('GET', `/pec_job_ar?id=eq.${encodeURIComponent(jobId)}&select=price,paid_to_date,deposit_amount,deposit_collected,deposit_waived&limit=1`);
      const j = Array.isArray(jr) ? jr[0] : null;
      if (j && !j.deposit_collected && !j.deposit_waived) {
        const owed = j.deposit_amount != null ? round2(j.deposit_amount) : round2(Number(j.price) * 0.5);
        const paid = round2(j.paid_to_date);
        if (kind === 'deposit' || paid + 0.005 >= owed) {
          await sb('PATCH', `/jobs?id=eq.${encodeURIComponent(jobId)}`, { deposit_collected: true });
        }
      }
    } catch (depErr) {
      // The payment is recorded; never fail the webhook over the deposit flag.
      console.error('stripe-webhook: deposit reflect failed (payment recorded)', depErr.message);
    }

    return reply(200, { recorded: true });
  } catch (err) {
    // Genuine DB failure: 500 so Stripe RETRIES and the idempotent insert lands.
    console.error('stripe-webhook: record failed', err.message);
    return reply(500, { error: 'record failed' });
  }
};
