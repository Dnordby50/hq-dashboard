// Public hosted invoice page at /pay/<token> (netlify.toml rewrites /pay/* here
// with the token in ?token=). Unauthenticated but unguessable (v4 UUID acts as
// a bearer token in the URL). Server-rendered HTML, no client JS needed to view.
// On a miss it returns a generic 404 page (never leaks the token or DB detail),
// and every response is noindex/nofollow so shared links are not crawled.
// Online card payment is via Stripe Checkout: the "Pay by card" buttons link to
// /api/stripe/checkout (pec-stripe-checkout.cjs), and the payment is recorded by
// the signature-verified pec-stripe-webhook.cjs (never by this page).

const { sb } = require('./_pec-supabase.cjs');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (s) => s ? new Date(String(s).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC' }) : '';

// Payment instructions are stored as PLAIN TEXT (so non-technical staff can edit
// them without breaking the page). Convert to safe HTML here on the way out:
// blank lines become paragraphs, single newlines become <br>, everything is
// escaped. Legacy values that already contain HTML tags pass through unchanged.
function paymentInstructionsHtml(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/<\w+[^>]*>/.test(s)) return s; // legacy HTML, trust it
  return s.split(/\n{2,}/).map(p => '<p style="margin:0 0 10px">' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
}

const BRAND_DEFAULTS = {
  logo_url: null, primary_color: '#14181C', accent_color: '#D8531C',
  business_name: 'Prescott Epoxy Company', address_line: '', phone: '',
  license_number: '', website: '', footer_disclaimer: '', payment_instructions_html: '',
  zelle_email: 'dylan@prescottepoxy.com', card_surcharge_pct: 3,
  // Editable customer-facing invoice text (Settings > Brand). Stored plain;
  // rendered through paymentInstructionsHtml. Empty string = section hidden.
  invoice_intro_text: '', offline_payment_details_text: '',
  invoice_footer_text: '', invoice_terms_text: '',
};

// Hosted logo (navy "PRESCOTT" + orange "EPOXY COMPANY" on transparent). Shown
// on the light background, NOT on the orange band (its orange text would vanish
// there). Used unless the brand row sets its own logo_url. Relative path so it
// resolves against whatever domain serves the page (domain-rename proof).
const LOGO_URL = '/assets/pec-logo.png';

function htmlResponse(statusCode, html) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
    },
    body: html,
  };
}

function notFoundPage() {
  return htmlResponse(404, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice not found</title></head>
<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;color:#0f172a">
  <div style="max-width:520px;margin:80px auto;padding:0 20px;text-align:center">
    <h1 style="font-size:20px">Invoice not found</h1>
    <p style="color:#64748b">This link is invalid or has expired. If you believe this is a mistake, please contact Prescott Epoxy Company at (928) 800-8154.</p>
  </div>
</body></html>`);
}

function lineItemsRows(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '<tr><td colspan="2" style="padding:10px;color:#64748b;text-align:center">No line items.</td></tr>';
  return list.map(li => {
    const price = li.price != null ? li.price : (li.total != null ? li.total : li.unit_price);
    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0">${esc(li.name || '')}${li.is_change_order ? ' <span style="color:#b45309;font-size:12px">(change order)</span>' : ''}${li.description ? `<div style="color:#64748b;font-size:13px;margin-top:3px;white-space:pre-wrap">${esc(li.description)}</div>` : ''}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap">${price != null ? usd(price) : ''}</td>
    </tr>`;
  }).join('');
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Status pill shown in the header (right side). Color + label only.
function statusPill(row) {
  const balance = Number(row.balance_remaining || 0);
  if (balance <= 0.005) return { bg: '#16a34a', text: 'Paid in full' };
  if (row.status === 'completed') return { bg: '#b91c1c', text: 'Payment due' };
  if (!row.deposit_collected && !row.deposit_waived) return { bg: '#b45309', text: 'Deposit due' };
  return { bg: '#334155', text: 'Balance due' };
}

// Online card payment via Stripe Checkout (PEC absorbs the processing fee, so the
// customer is charged the exact amount -- no surcharge). The "Pay by card" button
// links to /api/stripe/checkout; a "Pay deposit" button also shows when a deposit
// is still due and is smaller than the balance. Check + Zelle stay as secondary
// options. `token` is the invoice public_token used to build the checkout link.
function payButtons(b, row, token) {
  const due = round2(row.balance_remaining);
  if (due <= 0.005 || !token) return '';
  const primary = esc(b.primary_color);
  const accent = esc(b.accent_color);
  const btn = (href, label, bg) => `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:#fff;font-weight:700;font-size:15px;border-radius:8px;padding:13px 22px;text-decoration:none">${label}</a>`;
  const depositDue = !row.deposit_collected && !row.deposit_waived;
  const owed = row.deposit_amount != null ? round2(row.deposit_amount) : round2(Number(row.price) * 0.5);
  const showDeposit = depositDue && owed >= 0.5 && owed < due - 0.005;
  const zelle = b.zelle_email || 'dylan@prescottepoxy.com';
  const phone = b.phone || '(928) 800-8154';
  const tok = encodeURIComponent(token);
  return `<div class="card" style="margin-top:16px;padding:20px 22px">
    <h3 style="margin:0 0 14px;color:${primary};font-size:16px">Pay online</h3>
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">
      ${btn(`/api/stripe/checkout?token=${tok}&kind=balance`, `Pay ${usd(due)} by card`, accent)}
      ${showDeposit ? btn(`/api/stripe/checkout?token=${tok}&kind=deposit`, `Pay deposit ${usd(owed)}`, primary) : ''}
    </div>
    <div style="font-size:13px;color:#64748b;margin-top:12px;line-height:1.5">Secure card payment by Stripe (we cover the processing fee). Prefer another way? Pay by check (give it to the crew) or Zelle to <strong>${esc(zelle)}</strong>. Questions? Call ${esc(name(b))} at <strong>${esc(phone)}</strong>.</div>
  </div>`;
}
function name(b) { return b.business_name || 'Prescott Epoxy Company'; }

// Payment ledger for this invoice (from pec_payments). Shows date, method,
// reference (check #), and amount per payment, plus the total paid.
function paymentsSection(payments, b) {
  const list = Array.isArray(payments) ? payments : [];
  if (!list.length) return '';
  const methodLabel = (m) => ({ check: 'Check', cash: 'Cash', zelle: 'Zelle', stripe: 'Card', card: 'Card' }[m] || (m ? m.charAt(0).toUpperCase() + m.slice(1) : '—'));
  const rows = list.map(p => `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${esc(fmtDate(p.received_date))}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${esc(methodLabel(p.method))}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${esc(p.reference || '')}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap">${usd(p.amount)}</td>
    </tr>`).join('');
  const totalPaid = list.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  return `<div class="card" style="margin-top:16px;padding:20px 22px">
    <h3 style="margin:0 0 12px;color:${esc(b.primary_color)};font-size:16px">Payments received</h3>
    <table class="li">
      <thead><tr><th>Date</th><th>Method</th><th>Reference / Check #</th><th style="text-align:right;width:120px">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="text-align:right;margin-top:10px;font-weight:700;color:${esc(b.primary_color)}">Total paid: ${usd(totalPaid)}</div>
  </div>`;
}

function invoicePage(row, brand, payments, opts) {
  const o = opts || {};
  const b = { ...BRAND_DEFAULTS, ...(brand || {}) };
  const biz = name(b);
  const logoUrl = b.logo_url || LOGO_URL;
  const invNo = row.hq_invoice_number || row.dripjobs_deal_id || String(row.id || '').slice(0, 8);
  const pill = statusPill(row);
  const billTo = row.bill_to_address || row.address || '';
  const total = Number(row.price || 0);
  const due = Number(row.balance_remaining || 0);

  return htmlResponse(200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${esc(invNo)} — ${esc(biz)}</title>
<style>
  @page { size: letter; margin: 0.5in; }
  body { margin:0; font-family:Arial,Helvetica,sans-serif; background:#f1f5f9; color:${esc(b.primary_color)}; }
  .wrap { max-width:720px; margin:0 auto; padding:24px 16px 48px; }
  .card { background:#fff; border-radius:12px; box-shadow:0 1px 6px rgba(0,0,0,.08); overflow:hidden; }
  .band { background:${esc(b.accent_color)}; color:#fff; padding:22px; display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:14px; }
  .band .inv { text-align:right; }
  .pill { display:inline-block; background:${pill.bg}; color:#fff; font-size:12px; font-weight:700; border-radius:999px; padding:4px 12px; margin-top:6px; }
  table.li { width:100%; border-collapse:collapse; font-size:14px; }
  table.li th { background:${esc(b.primary_color)}; color:#fff; text-align:left; padding:9px 12px; font-size:12px; }
  table.li th:last-child, table.li td:last-child { text-align:right; width:130px; white-space:nowrap; }
  /* Totals table: same width + last-column width as the line items table, so the
     amounts line up directly under the line-item Amount column. */
  table.tot { width:100%; border-collapse:collapse; font-size:14px; margin-top:6px; }
  table.tot td { padding:4px 12px; }
  table.tot td:first-child { text-align:right; color:#475569; }
  table.tot td:last-child { text-align:right; width:130px; white-space:nowrap; }
  table.tot tr.total td { border-top:2px solid ${esc(b.primary_color)}; padding-top:8px; font-size:16px; font-weight:700; color:${esc(b.primary_color)}; }
  .printbtn { display:inline-block; background:${esc(b.primary_color)}; color:#fff; border:0; border-radius:8px; padding:11px 20px; font-size:14px; font-weight:600; cursor:pointer; }
  @media print { .noprint { display:none !important; } body { background:#fff; } .card { box-shadow:none; } }
</style></head>
<body>
  <div class="wrap">
    ${o.paid ? `<div class="noprint" style="background:#dcfce7;border:1px solid #16a34a;border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#14532d;font-weight:600">Payment received — thank you! It will appear in the Payments section below within a moment.</div>` : ''}
    <div style="text-align:center;margin-bottom:18px"><img src="${esc(logoUrl)}" alt="${esc(biz)}" style="max-height:64px;max-width:280px"></div>
    <div class="card">
      <div class="band">
        <div>
          <div style="font-size:22px;font-weight:800;letter-spacing:.5px;margin-bottom:6px">${esc(biz)}</div>
          <div style="font-size:13px;opacity:.95">${esc(b.address_line)}</div>
          ${b.phone ? `<div style="font-size:13px;opacity:.95">${esc(b.phone)}</div>` : ''}
          ${b.license_number ? `<div style="font-size:12px;opacity:.85">License ${esc(b.license_number)}</div>` : ''}
        </div>
        <div class="inv">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;opacity:.9">Invoice</div>
          <div style="font-size:22px;font-weight:800">#${esc(invNo)}</div>
          <div class="pill">${esc(pill.text)}</div>
        </div>
      </div>
      <div style="padding:22px">
        ${b.invoice_intro_text ? `<div style="font-size:14px;color:#334155;line-height:1.55;margin-bottom:18px">${paymentInstructionsHtml(b.invoice_intro_text)}</div>` : ''}
        ${due > 0.005 ? `<div style="background:${esc(b.accent_color)}1a;border:1px solid ${esc(b.accent_color)};border-radius:8px;padding:12px 16px;margin-bottom:18px;font-weight:600;color:${esc(b.primary_color)}">A payment of ${usd(due)} is due. See payment options below.</div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:18px;margin-bottom:18px;font-size:14px">
          <div style="flex:1;min-width:180px"><div style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px">Bill to</div><div style="font-weight:600">${esc(row.customer_name || '')}</div><div style="color:#475569">${esc(billTo)}</div></div>
          <div style="min-width:160px"><div style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px">Job address</div><div style="color:#475569">${esc(row.address || billTo)}</div>${row.completed_date ? `<div style="color:#475569;font-size:13px;margin-top:4px">Completed ${esc(fmtDate(row.completed_date))}</div>` : (row.signed_date ? `<div style="color:#475569;font-size:13px;margin-top:4px">Signed ${esc(fmtDate(row.signed_date))}</div>` : '')}</div>
        </div>
        <table class="li">
          <thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
          <tbody>${lineItemsRows(row.line_items)}</tbody>
        </table>
        <table class="tot">
          <tr><td>Invoice amount</td><td>${usd(total)}</td></tr>
          <tr><td>Tax</td><td>${usd(0)}</td></tr>
          <tr><td>Paid to date</td><td>-${usd(row.paid_to_date)}</td></tr>
          <tr class="total"><td>Amount due</td><td>${usd(due)}</td></tr>
        </table>
      </div>
    </div>

    ${paymentsSection(payments, b)}

    ${payButtons(b, row, o.token)}

    ${b.payment_instructions_html ? `<div class="card" style="margin-top:16px;padding:20px 22px">
      <h3 style="margin:0 0 8px;color:${esc(b.primary_color)};font-size:16px">More on payment</h3>
      <div style="font-size:14px;color:#334155;line-height:1.5">${paymentInstructionsHtml(b.payment_instructions_html)}</div>
    </div>` : ''}

    ${b.invoice_footer_text ? `<div class="card" style="margin-top:16px;padding:20px 22px">
      <div style="font-size:14px;color:#334155;line-height:1.5">${paymentInstructionsHtml(b.invoice_footer_text)}</div>
    </div>` : ''}

    ${b.invoice_terms_text ? `<div style="margin-top:16px;font-size:12px;color:#94a3b8;line-height:1.5">${paymentInstructionsHtml(b.invoice_terms_text)}</div>` : ''}

    <div class="noprint" style="text-align:center;margin-top:22px">
      <button class="printbtn" onclick="window.print()">Print / Save as PDF</button>
    </div>
    <div style="text-align:center;color:#94a3b8;font-size:12px;margin-top:22px">
      ${esc(biz)}${b.address_line ? ' &middot; ' + esc(b.address_line) : ''}${b.license_number ? ' &middot; License ' + esc(b.license_number) : ''}
    </div>
  </div>
</body></html>`);
}

exports.handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') return htmlResponse(405, 'Method not allowed');
  // Token normally arrives as ?token= (set by the /pay/* rewrite). But Netlify
  // does NOT reliably interpolate :splat into a toml redirect's query string, so
  // through /pay the query token can be empty. Fall back to parsing the UUID out
  // of the request path (event.path / rawUrl is the original /pay/<token>).
  let token = (event.queryStringParameters && event.queryStringParameters.token) || '';
  let rawUrlPath = '';
  try { rawUrlPath = event.rawUrl ? new URL(event.rawUrl).pathname : ''; } catch (_) {}
  if (!token) {
    const src = `${event.path || ''} ${rawUrlPath}`;
    const m = src.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
    if (m) token = m[1];
  }
  // Basic shape check before hitting the DB (v4 UUID).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    console.warn('public-invoice: token failed UUID shape check');
    return notFoundPage();
  }

  try {
    const rows = await sb('GET', `/pec_job_ar?public_token=eq.${encodeURIComponent(token)}&select=*&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) {
      // Distinct from the catch below: the query SUCCEEDED but matched no row
      // (genuinely no such token, or the row is voided/filtered by the view).
      console.warn('public-invoice: no row for token');
      return notFoundPage();
    }
    let brand = { ...BRAND_DEFAULTS };
    try {
      const biRows = await sb('GET', `/pec_brand_identity?brand=eq.${encodeURIComponent(row.customer_company || 'prescott-epoxy')}&select=*&limit=1`);
      if (Array.isArray(biRows) && biRows[0]) brand = { ...BRAND_DEFAULTS, ...biRows[0] };
      else {
        const fallback = await sb('GET', `/pec_brand_identity?brand=eq.prescott-epoxy&select=*&limit=1`);
        if (Array.isArray(fallback) && fallback[0]) brand = { ...BRAND_DEFAULTS, ...fallback[0] };
      }
    } catch (_) { /* defaults */ }
    // Payment ledger for the "Payments received" section. Best-effort: a failure
    // here should not blank the invoice, so fall back to an empty list.
    let payments = [];
    try {
      const pr = await sb('GET', `/pec_payments?job_id=eq.${encodeURIComponent(row.id)}&select=amount,method,reference,received_date&order=received_date.asc`);
      if (Array.isArray(pr)) payments = pr;
    } catch (_) { /* show page without the ledger */ }
    const paidParam = (event.queryStringParameters && event.queryStringParameters.paid) || '';
    return invoicePage(row, brand, payments, { token, paid: paidParam === '1' || paidParam === 'true' });
  } catch (err) {
    // Distinct from the no-row case: the pec_job_ar query (or render) threw.
    console.error('public-invoice: query error', err.message);
    return notFoundPage();
  }
};
