// Public hosted invoice page at /pay/<token> (netlify.toml rewrites /pay/* here
// with the token in ?token=). Unauthenticated but unguessable (v4 UUID acts as
// a bearer token in the URL). Server-rendered HTML, no client JS needed to view.
// On a miss it returns a generic 404 page (never leaks the token or DB detail),
// and every response is noindex/nofollow so shared links are not crawled.
// No payment processor: payment is instructions + reply only.

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
};

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
    <p style="color:#64748b">This link is invalid or has expired. If you believe this is a mistake, please contact the company that sent you the invoice.</p>
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

function statusBanner(row) {
  const balance = Number(row.balance_remaining || 0);
  const paid = balance <= 0.005;
  if (paid) return { bg: '#16a34a', text: 'Paid in full — thank you!' };
  if (row.status === 'completed') return { bg: '#dc2626', text: 'Payment due: ' + usd(balance) };
  if (!row.deposit_collected && !row.deposit_waived) return { bg: '#ea580c', text: 'Deposit due to schedule your job' };
  return { bg: '#1e3a5f', text: 'Balance: ' + usd(balance) };
}

function invoicePage(row, brand) {
  const b = { ...BRAND_DEFAULTS, ...(brand || {}) };
  const name = b.business_name;
  const invNo = row.hq_invoice_number || row.dripjobs_deal_id || String(row.id || '').slice(0, 8);
  const banner = statusBanner(row);
  const billTo = row.bill_to_address || row.address || '';
  const header = b.logo_url
    ? `<img src="${esc(b.logo_url)}" alt="${esc(name)}" style="max-height:54px;max-width:260px">`
    : `<div style="font-size:24px;font-weight:800;letter-spacing:1px;color:${esc(b.primary_color)}">${esc(name)}</div>`;
  const total = Number(row.price || 0);
  const due = Number(row.balance_remaining || 0);

  return htmlResponse(200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${esc(invNo)} — ${esc(name)}</title>
<style>
  @page { size: letter; margin: 0.5in; }
  body { margin:0; font-family:Arial,Helvetica,sans-serif; background:#f1f5f9; color:#0f172a; }
  .wrap { max-width:720px; margin:0 auto; padding:24px 16px 48px; }
  .card { background:#fff; border-radius:10px; box-shadow:0 1px 6px rgba(0,0,0,.08); overflow:hidden; }
  .band { background:${esc(b.accent_color)}; color:#fff; padding:18px 22px; display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px; }
  .band .inv { text-align:right; }
  table.li { width:100%; border-collapse:collapse; font-size:14px; }
  table.li th { background:#0f172a; color:#fff; text-align:left; padding:8px 12px; font-size:12px; }
  .sumrow { display:flex; justify-content:space-between; padding:4px 0; font-size:14px; }
  .sumrow.total { border-top:2px solid #0f172a; margin-top:6px; padding-top:8px; font-size:16px; font-weight:700; }
  .printbtn { display:inline-block; background:${esc(b.primary_color)}; color:#fff; border:0; border-radius:6px; padding:10px 18px; font-size:14px; font-weight:600; cursor:pointer; }
  @media print { .noprint { display:none !important; } body { background:#fff; } .card { box-shadow:none; } }
</style></head>
<body>
  <div class="wrap">
    <div style="text-align:center;margin-bottom:16px">${header}</div>
    <div style="background:${banner.bg};color:#fff;border-radius:8px;padding:12px 16px;font-weight:600;margin-bottom:16px;text-align:center">${esc(banner.text)}</div>
    <div class="card">
      <div class="band">
        <div>
          <div style="font-weight:700;font-size:16px">${esc(name)}</div>
          <div style="font-size:13px;opacity:.92">${esc(b.address_line)}</div>
          ${b.phone ? `<div style="font-size:13px;opacity:.92">${esc(b.phone)}</div>` : ''}
          ${b.license_number ? `<div style="font-size:12px;opacity:.85">License ${esc(b.license_number)}</div>` : ''}
        </div>
        <div class="inv">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;opacity:.9">Invoice</div>
          <div style="font-size:20px;font-weight:800">${esc(invNo)}</div>
          <div style="font-size:13px;opacity:.92;margin-top:4px">Total ${usd(total)}</div>
        </div>
      </div>
      <div style="padding:20px 22px">
        <div style="display:flex;flex-wrap:wrap;gap:18px;margin-bottom:18px;font-size:14px">
          <div style="flex:1;min-width:180px"><div style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px">Bill to</div><div>${esc(row.customer_name || '')}</div><div style="color:#475569">${esc(billTo)}</div></div>
          <div style="min-width:140px"><div style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px">Amount due</div><div style="font-size:18px;font-weight:700">${usd(due)}</div>${row.completed_date ? `<div style="color:#475569;font-size:13px">Completed ${esc(fmtDate(row.completed_date))}</div>` : (row.signed_date ? `<div style="color:#475569;font-size:13px">Signed ${esc(fmtDate(row.signed_date))}</div>` : '')}</div>
        </div>
        <table class="li">
          <thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
          <tbody>${lineItemsRows(row.line_items)}</tbody>
        </table>
        <div style="max-width:280px;margin-left:auto;margin-top:16px">
          <div class="sumrow"><span>Invoice amount</span><span>${usd(total)}</span></div>
          <div class="sumrow"><span>Tax</span><span>${usd(0)}</span></div>
          <div class="sumrow"><span>Paid to date</span><span>-${usd(row.paid_to_date)}</span></div>
          <div class="sumrow total"><span>Amount due</span><span>${usd(due)}</span></div>
        </div>
      </div>
    </div>

    ${b.payment_instructions_html ? `<div class="card" style="margin-top:16px;padding:20px 22px">
      <h3 style="margin:0 0 8px;color:${esc(b.primary_color)};font-size:16px">How to pay</h3>
      <div style="font-size:14px;color:#334155;line-height:1.5">${paymentInstructionsHtml(b.payment_instructions_html)}</div>
    </div>` : ''}

    <div class="noprint" style="text-align:center;margin-top:22px">
      <button class="printbtn" onclick="window.print()">Print / Save as PDF</button>
    </div>
    <div style="text-align:center;color:#94a3b8;font-size:12px;margin-top:22px">
      ${esc(name)}${b.address_line ? ' &middot; ' + esc(b.address_line) : ''}${b.license_number ? ' &middot; License ' + esc(b.license_number) : ''}
    </div>
  </div>
</body></html>`);
}

exports.handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') return htmlResponse(405, 'Method not allowed');
  const token = (event.queryStringParameters && event.queryStringParameters.token) || '';
  // Basic shape check before hitting the DB (v4 UUID).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) return notFoundPage();

  try {
    const rows = await sb('GET', `/pec_job_ar?public_token=eq.${encodeURIComponent(token)}&select=*&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return notFoundPage();
    let brand = { ...BRAND_DEFAULTS };
    try {
      const biRows = await sb('GET', `/pec_brand_identity?brand=eq.${encodeURIComponent(row.customer_company || 'prescott-epoxy')}&select=*&limit=1`);
      if (Array.isArray(biRows) && biRows[0]) brand = { ...BRAND_DEFAULTS, ...biRows[0] };
      else {
        const fallback = await sb('GET', `/pec_brand_identity?brand=eq.prescott-epoxy&select=*&limit=1`);
        if (Array.isArray(fallback) && fallback[0]) brand = { ...BRAND_DEFAULTS, ...fallback[0] };
      }
    } catch (_) { /* defaults */ }
    return invoicePage(row, brand);
  } catch (err) {
    console.error('pec-public-invoice error:', err.message);
    return notFoundPage();
  }
};
