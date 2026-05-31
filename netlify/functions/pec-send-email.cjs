// Send a transactional email through Resend.
// The RESEND_API_KEY lives ONLY in Netlify env; the browser never sees it.
// Flow: validate the caller's Supabase JWT -> look up the sender + template for
// the brand -> render {{tokens}} (caller vars + auto-injected invoice fields) ->
// POST to Resend -> write a pec_email_log row (service role). Every outcome,
// success or failure, writes a log row so the UI history is complete.
//
// Body: { template_key, brand, to_email, job_id?, customer_id?, vars? }

const { sb } = require('./_pec-supabase.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SITE_URL = process.env.URL || 'https://hq-prescott.netlify.app';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function jc(statusCode, body) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const render = (tpl, map) => String(tpl || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (map[k] != null ? String(map[k]) : ''));

function lineItemsTableHtml(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  const rows = list.map(li => {
    const price = li.price != null ? li.price : (li.total != null ? li.total : li.unit_price);
    return `<tr>
      <td style="padding:6px 8px;border:1px solid #e2e8f0">${esc(li.name || '')}${li.is_change_order ? ' <em>(change order)</em>' : ''}${li.description ? `<div style="color:#64748b;font-size:12px;margin-top:2px;white-space:pre-wrap">${esc(li.description)}</div>` : ''}</td>
      <td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;white-space:nowrap">${price != null ? usd(price) : ''}</td>
    </tr>`;
  }).join('');
  return `<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px">
    <thead><tr><th style="text-align:left;padding:6px 8px;background:#0f172a;color:#fff">Item</th><th style="text-align:right;padding:6px 8px;background:#0f172a;color:#fff">Price</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// Validate a Supabase access token; returns the user object or null.
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

// Best-effort log write (service role). Returns the inserted row's id or null.
async function logRow(row) {
  try {
    const out = await sb('POST', '/pec_email_log', row, true);
    return Array.isArray(out) && out[0] ? out[0].id : null;
  } catch (e) { console.error('pec-send-email: log insert failed', e.message); return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { ok: false, error: 'Method not allowed' });

  // Auth: require a valid Supabase JWT.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const user = await getUser(token);
  if (!user || !user.id) return jc(401, { ok: false, error: 'Not authenticated' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { ok: false, error: 'Invalid JSON' }); }

  const { template_key, brand, to_email, job_id = null, customer_id = null, vars = {} } = body;
  if (!template_key || !brand || !to_email) return jc(400, { ok: false, error: 'template_key, brand and to_email are required' });

  // Env guard: surface a clean 503 and still record the attempt.
  if (!RESEND_API_KEY) {
    await logRow({ sent_by_user: user.id, job_id, customer_id, brand, template_key, to_email, status: 'failed', error_message: 'RESEND_API_KEY not configured' });
    return jc(503, { ok: false, error: 'Email is not configured yet (RESEND_API_KEY missing). Ask Dylan to set the Netlify env var.' });
  }

  try {
    // Rate limit: hard cap 50 sends per user per hour (Supabase counter, reliable
    // across function instances).
    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = await sb('GET', `/pec_email_log?sent_by_user=eq.${encodeURIComponent(user.id)}&sent_at=gte.${encodeURIComponent(sinceIso)}&select=id`);
    if (Array.isArray(recent) && recent.length >= 50) {
      return jc(429, { ok: false, error: 'Rate limit reached (50 emails/hour). Try again later.' });
    }

    // Sender + template for this brand.
    const senders = await sb('GET', `/pec_email_senders?brand=eq.${encodeURIComponent(brand)}&select=*&limit=1`);
    const sender = Array.isArray(senders) ? senders[0] : null;
    if (!sender) return jc(400, { ok: false, error: `No sender configured for brand "${brand}".` });
    const templates = await sb('GET', `/pec_email_templates?key=eq.${encodeURIComponent(template_key)}&brand=eq.${encodeURIComponent(brand)}&select=*&limit=1`);
    const template = Array.isArray(templates) ? templates[0] : null;
    if (!template) return jc(400, { ok: false, error: `No "${template_key}" template for brand "${brand}".` });

    // Auto-injected fields. For an invoice, pull the rolled-up AR row.
    const auto = {};
    let portalLink = '';
    if (job_id) {
      const arRows = await sb('GET', `/pec_job_ar?id=eq.${encodeURIComponent(job_id)}&select=customer_name,price,balance_remaining,paid_to_date,hq_invoice_number,dripjobs_deal_id,line_items&limit=1`);
      const ar = Array.isArray(arRows) ? arRows[0] : null;
      if (ar) {
        auto.customer_name = ar.customer_name || '';
        auto.invoice_number = ar.hq_invoice_number || ar.dripjobs_deal_id || String(job_id).slice(0, 8);
        auto.total = usd(ar.price);
        auto.balance = usd(ar.balance_remaining);
        auto.line_items_table = lineItemsTableHtml(ar.line_items);
      }
    }
    if (customer_id) {
      try {
        const custRows = await sb('GET', `/customers?id=eq.${encodeURIComponent(customer_id)}&select=name,token&limit=1`);
        const cust = Array.isArray(custRows) ? custRows[0] : null;
        if (cust) {
          if (!auto.customer_name) auto.customer_name = cust.name || '';
          if (cust.token) portalLink = `${SITE_URL}/?portal=${encodeURIComponent(cust.token)}`;
        }
      } catch (_) { /* token lookup is optional */ }
    }
    auto.portal_link = portalLink;
    auto.brand_name = sender.from_name;
    auto.from_name = sender.from_name;
    auto.year = String(new Date().getFullYear());

    // Build the token maps. Text fields are HTML-escaped for the body; the
    // pre-built line_items_table stays raw. Subject uses raw text.
    const merged = { ...auto, ...vars };
    const htmlMap = {};
    for (const [k, v] of Object.entries(merged)) htmlMap[k] = (k === 'line_items_table') ? v : esc(v);
    const subject = render(template.subject, merged);
    const html = render(template.html, htmlMap);

    // Send via Resend.
    const fromAddr = `${sender.from_name} <${sender.from_email}>`;
    const payload = { from: fromAddr, to: [to_email], subject, html };
    if (sender.reply_to) payload.reply_to = sender.reply_to;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const resBody = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = (resBody && (resBody.message || resBody.error)) || `Resend error ${res.status}`;
      await logRow({ sent_by_user: user.id, job_id, customer_id, brand, template_key, to_email, from_email: sender.from_email, subject, status: 'failed', error_message: String(msg).slice(0, 500) });
      return jc(502, { ok: false, error: `Could not send: ${msg}` });
    }

    const logId = await logRow({
      sent_by_user: user.id, job_id, customer_id, brand, template_key,
      to_email, from_email: sender.from_email, subject, status: 'sent', resend_id: resBody.id || null,
    });
    return jc(200, { ok: true, log_id: logId, resend_id: resBody.id || null });
  } catch (err) {
    console.error('pec-send-email error:', err.message);
    await logRow({ sent_by_user: user.id, job_id, customer_id, brand, template_key, to_email, status: 'failed', error_message: String(err.message).slice(0, 500) });
    return jc(500, { ok: false, error: 'Send failed. Please try again.' });
  }
};
