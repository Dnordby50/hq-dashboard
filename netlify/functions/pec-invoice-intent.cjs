// Public, token-gated "Let our office know" action from the hosted invoice page.
// When a customer chooses to pay by check / cash / Zelle, the invoice page POSTs
// here with the invoice public_token and the chosen method; we notify the office
// by BOTH email (Resend) and Slack (incoming webhook to #epoxysales).
//
// SECURITY: the only auth is the invoice public_token (same gate as the public
// invoice page) -- the customer is NOT a logged-in staff user, so this never
// requires a Supabase JWT. All secrets (service role, Resend key, Slack webhook)
// live ONLY in process.env and are never returned to the client.
//
// Resilience: a missing SLACK_OFFICE_WEBHOOK (or a Slack failure) must NOT block
// the email, and a missing RESEND_API_KEY must NOT block Slack. Each channel is
// attempted independently; the response reports which ones fired.

const { sb } = require('./_pec-supabase.cjs');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SLACK_OFFICE_WEBHOOK = process.env.SLACK_OFFICE_WEBHOOK;
// Office recipient for the notification email. Configurable so Dylan can point
// it wherever; falls back to the brand sender's reply-to / from address below.
const OFFICE_NOTIFY_EMAIL = process.env.OFFICE_NOTIFY_EMAIL || '';
const SITE_URL = process.env.URL || 'https://prescottepoxy.netlify.app';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHOD_LABEL = { check: 'Check', cash: 'Cash', zelle: 'Zelle' };

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function jc(statusCode, body) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { ok: false, error: 'Method not allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return jc(400, { ok: false, error: 'Bad JSON' }); }
  const token = String(body.token || '').trim();
  const method = String(body.method || '').trim().toLowerCase();
  if (!UUID_RE.test(token)) return jc(400, { ok: false, error: 'Invalid token' });
  if (!METHOD_LABEL[method]) return jc(400, { ok: false, error: 'Invalid method' });

  // Resolve the invoice by its public token (service role; same lookup the
  // public invoice page uses). Never trust client-supplied customer/amount.
  let row = null;
  try {
    const rows = await sb('GET', `/pec_job_ar?public_token=eq.${encodeURIComponent(token)}&select=*&limit=1`);
    row = Array.isArray(rows) ? rows[0] : null;
  } catch (e) {
    console.error('invoice-intent: lookup failed', e && e.message ? e.message : e);
    return jc(502, { ok: false, error: 'Could not look up the invoice' });
  }
  if (!row) return jc(404, { ok: false, error: 'Invoice not found' });

  const brandKey = row.customer_company || 'prescott-epoxy';
  const customer = row.customer_name || 'Customer';
  const invNo = row.hq_invoice_number || row.dripjobs_deal_id || String(row.id || '').slice(0, 8);
  const balance = Number(row.balance_remaining || 0);
  const methodLabel = METHOD_LABEL[method];
  const payUrl = `${SITE_URL}/pay/${token}`;

  // ---- Email the office (best-effort) -------------------------------------
  let emailed = false, emailError = null;
  try {
    let sender = null;
    try {
      const senders = await sb('GET', `/pec_email_senders?brand=eq.${encodeURIComponent(brandKey)}&select=*&limit=1`);
      sender = Array.isArray(senders) ? senders[0] : null;
    } catch (_) { /* no sender row; fall back below */ }
    if (!RESEND_API_KEY) {
      emailError = 'RESEND_API_KEY not configured';
    } else if (!sender || !sender.from_email) {
      emailError = 'No email sender configured for brand ' + brandKey;
    } else {
      const toEmail = OFFICE_NOTIFY_EMAIL || sender.reply_to || sender.from_email;
      const fromAddr = `${sender.from_name || 'Prescott Epoxy Company'} <${sender.from_email}>`;
      const subject = `Invoice #${invNo}: ${customer} wants to pay by ${methodLabel}`;
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
        <p><strong>${esc(customer)}</strong> opened invoice <strong>#${esc(invNo)}</strong> and chose to pay by <strong>${esc(methodLabel)}</strong>.</p>
        <p>Balance due: <strong>${esc(usd(balance))}</strong></p>
        <p>Reach out to arrange collection. Invoice: <a href="${esc(payUrl)}">${esc(payUrl)}</a></p>
      </div>`;
      const payload = { from: fromAddr, to: [toEmail], subject, html };
      if (sender.reply_to) payload.reply_to = sender.reply_to;
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) emailed = true;
      else { emailError = 'Resend ' + res.status; console.error('invoice-intent: resend failed', res.status, await res.text().catch(() => '')); }
    }
  } catch (e) {
    emailError = e && e.message ? e.message : String(e);
    console.error('invoice-intent: email error', emailError);
  }

  // ---- Slack #epoxysales (best-effort, never blocks the email) ------------
  let slacked = false, slackError = null;
  if (SLACK_OFFICE_WEBHOOK) {
    try {
      const text = `:moneybag: *${customer}* wants to pay invoice *#${invNo}* by *${methodLabel}*\nBalance due: *${usd(balance)}*\n<${payUrl}|Open invoice>`;
      const res = await fetch(SLACK_OFFICE_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.ok) slacked = true;
      else { slackError = 'Slack ' + res.status; console.error('invoice-intent: slack failed', res.status); }
    } catch (e) {
      slackError = e && e.message ? e.message : String(e);
      console.error('invoice-intent: slack error', slackError);
    }
  } else {
    slackError = 'SLACK_OFFICE_WEBHOOK not configured';
  }

  // Success if EITHER channel reached the office. The customer just needs to
  // know the office was told; partial delivery is logged server-side above.
  const ok = emailed || slacked;
  return jc(ok ? 200 : 502, { ok, emailed, slacked, emailError, slackError });
};
