// Public, token-gated endpoint that creates a Stripe Checkout Session for an
// invoice and 302-redirects the customer to Stripe's hosted payment page.
// Reached via /api/stripe/checkout?token=<public_token>&kind=balance|deposit
// (netlify.toml rewrite). No client JS: the invoice page links straight here.
//
// The AMOUNT is computed SERVER-SIDE from the token lookup -- never trusted from
// the client. Payment is NOT recorded here; only the signature-verified webhook
// (pec-stripe-webhook.cjs) records it, so a customer landing on success_url is
// never treated as proof of payment. Calls the Stripe REST API directly (no SDK).
const crypto = require('crypto');
const { sb } = require('./_pec-supabase.cjs');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SITE_URL = process.env.URL || 'https://prescottepoxy.netlify.app';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(statusCode, title, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' },
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;color:#0f172a"><div style="max-width:520px;margin:80px auto;padding:0 20px;text-align:center"><h1 style="font-size:20px">${title}</h1><p style="color:#64748b">${body}</p></div></body></html>`,
  };
}
const redirect = (url) => ({ statusCode: 302, headers: { Location: url, 'Cache-Control': 'no-store' }, body: '' });

// application/x-www-form-urlencoded; Stripe nested params are passed as already
// bracketed string keys (e.g. 'line_items[0][price_data][currency]').
function formEncode(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

exports.handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') return page(405, 'Method not allowed', 'Use the payment button on your invoice.');

  const q = event.queryStringParameters || {};
  const token = String(q.token || '').trim();
  const kind = q.kind === 'deposit' ? 'deposit' : (q.kind === 'custom' ? 'custom' : 'balance');
  if (!UUID_RE.test(token)) return page(404, 'Invoice not found', 'This payment link is invalid or has expired.');

  if (!STRIPE_SECRET_KEY) {
    return page(503, 'Card payments not set up yet', 'Online card payment is not configured yet. Please pay by check or Zelle, or contact Prescott Epoxy Company at (928) 800-8154.');
  }

  let row;
  try {
    const rows = await sb('GET', `/pec_job_ar?public_token=eq.${encodeURIComponent(token)}&select=*&limit=1`);
    row = Array.isArray(rows) ? rows[0] : null;
  } catch (err) {
    console.error('stripe-checkout: lookup failed', err.message);
    return page(500, 'Something went wrong', 'Please try again in a moment.');
  }
  if (!row) return page(404, 'Invoice not found', 'This payment link is invalid or has expired.');

  const balance = round2(row.balance_remaining);
  let amount;
  if (kind === 'deposit') {
    if (row.deposit_collected || row.deposit_waived) return redirect(`${SITE_URL}/pay/${token}`);
    const owed = row.deposit_amount != null ? round2(row.deposit_amount) : round2(Number(row.price) * 0.5);
    amount = round2(Math.min(owed, balance));
  } else if (kind === 'custom') {
    // Office-entered amount arrives in CENTS (?amt=). Validate + clamp SERVER-SIDE
    // to [50 cents, current balance] so the client can never charge more than is
    // owed or below the Stripe minimum.
    const cents = Math.round(Number(q.amt));
    if (!Number.isFinite(cents) || cents <= 0) return redirect(`${SITE_URL}/pay/${token}`);
    amount = round2(Math.min(Math.max(cents / 100, 0.5), balance));
  } else {
    amount = balance;
  }
  // Stripe minimum charge is $0.50; nothing meaningful to charge otherwise.
  if (!(amount >= 0.5)) return redirect(`${SITE_URL}/pay/${token}`);

  const invNo = row.hq_invoice_number || row.dripjobs_deal_id || String(row.id || '').slice(0, 8);
  const productName = (kind === 'deposit' ? 'Deposit — Invoice ' : (kind === 'custom' ? 'Payment — Invoice ' : 'Invoice ')) + invNo;
  // PaymentIntent description so the customer name (not just the email) shows in
  // the Stripe Payments list and on the receipt.
  const payDesc = (row.customer_name ? row.customer_name + ' — ' : '') + productName;

  // Fetch-or-create a Stripe Customer so the payment fills Stripe's Customer
  // column with the real name (and one Customer is reused across this customer's
  // payments). Best-effort: any failure falls back to customer_email below so a
  // payment is never blocked over this nicety. The cached id lives on
  // public.customers.stripe_customer_id (2026-06-22_customer_stripe_id.sql).
  let stripeCustomerId = null;
  if (row.customer_id) {
    try {
      const crows = await sb('GET', `/customers?id=eq.${encodeURIComponent(row.customer_id)}&select=stripe_customer_id&limit=1`);
      const existing = Array.isArray(crows) && crows[0] ? crows[0].stripe_customer_id : null;
      if (existing) {
        stripeCustomerId = existing;
      } else {
        // Idempotency-Key on the customer id makes concurrent first-time creates
        // return the SAME Stripe Customer instead of duplicating it.
        const cres = await fetch('https://api.stripe.com/v1/customers', {
          method: 'POST',
          headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': 'cust_' + row.customer_id },
          body: formEncode({ name: row.customer_name || '', email: row.customer_email || '', 'metadata[customer_id]': row.customer_id }),
        });
        const cdata = await cres.json().catch(() => ({}));
        if (cres.ok && cdata.id) {
          stripeCustomerId = cdata.id;
          // Cache for reuse (best-effort; a failure here just means we re-create
          // next time, deduped by the Idempotency-Key within 24h).
          try { await sb('PATCH', `/customers?id=eq.${encodeURIComponent(row.customer_id)}`, { stripe_customer_id: cdata.id }); } catch (_) {}
        } else {
          console.error('stripe-checkout: customer create failed', cres.status, cdata && cdata.error && cdata.error.message);
        }
      }
    } catch (err) {
      console.error('stripe-checkout: customer fetch/create failed (falling back to email)', err.message);
    }
  }

  const params = {
    mode: 'payment',
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': Math.round(amount * 100),
    'line_items[0][price_data][product_data][name]': productName,
    // Mirror the job + kind onto the PaymentIntent so the webhook can read them
    // off the completed session reliably.
    'metadata[job_id]': row.id,
    'metadata[public_token]': token,
    'metadata[kind]': kind,
    'payment_intent_data[metadata][job_id]': row.id,
    'payment_intent_data[metadata][kind]': kind,
    'payment_intent_data[description]': payDesc,
    'payment_intent_data[metadata][customer_name]': row.customer_name || '',
    success_url: `${SITE_URL}/pay/${token}?paid=1`,
    cancel_url: `${SITE_URL}/pay/${token}`,
  };
  // Attach to the Stripe Customer when we have one (fills the Customer column and
  // uses its email for the receipt). Stripe Checkout rejects `customer` +
  // `customer_email` together, so only one is set; fall back to customer_email.
  if (stripeCustomerId) params['customer'] = stripeCustomerId;
  else if (row.customer_email) params['customer_email'] = row.customer_email;

  // Idempotency-Key dedupes a double-click within Stripe's 24h window.
  const idemKey = 'co_' + crypto.createHash('sha256').update(`${token}|${kind}|${Math.round(amount * 100)}`).digest('hex').slice(0, 48);

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idemKey,
      },
      body: formEncode(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) {
      console.error('stripe-checkout: session create failed', res.status, data && data.error && data.error.message);
      return page(502, 'Could not start checkout', 'We could not start the card payment. Please try again, or pay by check or Zelle.');
    }
    return redirect(data.url);
  } catch (err) {
    console.error('stripe-checkout: stripe call threw', err.message);
    return page(502, 'Could not start checkout', 'We could not start the card payment. Please try again, or pay by check or Zelle.');
  }
};
