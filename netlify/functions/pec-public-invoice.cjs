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

// Informational pay options (NO online processor). Card surcharge is computed
// live from the brand rate so the customer sees the real card total. Phone and
// Zelle come from the brand row (with code defaults as fallback).
function payButtons(b, due) {
  if (due <= 0.005) return '';
  const pct = Number(b.card_surcharge_pct != null ? b.card_surcharge_pct : 3) || 0;
  const surcharge = round2(due * pct / 100);
  const phone = b.phone || '(928) 800-8154';
  const zelle = b.zelle_email || 'dylan@prescottepoxy.com';
  const opt = (title, sub) => `<div style="flex:1;min-width:200px;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
      <div style="display:inline-block;background:${esc(b.accent_color)};color:#fff;font-weight:700;font-size:14px;border-radius:6px;padding:8px 14px;margin-bottom:8px">${title}</div>
      <div style="font-size:13px;color:#334155;line-height:1.5">${sub}</div>
    </div>`;
  return `<div class="card" style="margin-top:16px;padding:20px 22px">
    <h3 style="margin:0 0 12px;color:${esc(b.primary_color)};font-size:16px">How to pay</h3>
    <div style="display:flex;flex-wrap:wrap;gap:12px">
      ${opt(`Credit Card + ${usd(surcharge)}`, `A ${pct}% card surcharge (${usd(surcharge)}) applies. Call ${esc(name(b))} at <strong>${esc(phone)}</strong> to pay by card.`)}
      ${opt('Pay with Check', 'Give a check to the crew when they finish the job.')}
      ${opt('Zelle', `Send to <strong>${esc(zelle)}</strong>.`)}
    </div>
  </div>`;
}
function name(b) { return b.business_name || 'Prescott Epoxy Company'; }

function invoicePage(row, brand) {
  const b = { ...BRAND_DEFAULTS, ...(brand || {}) };
  const biz = name(b);
  const invNo = row.hq_invoice_number || row.dripjobs_deal_id || String(row.id || '').slice(0, 8);
  const pill = statusPill(row);
  const billTo = row.bill_to_address || row.address || '';
  const total = Number(row.price || 0);
  const due = Number(row.balance_remaining || 0);
  const header = b.logo_url
    ? `<img src="${esc(b.logo_url)}" alt="${esc(biz)}" style="max-height:52px;max-width:240px">`
    : `<div style="font-size:22px;font-weight:800;letter-spacing:.5px">${esc(biz)}</div>`;

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
  .sumrow { display:flex; justify-content:space-between; padding:4px 0; font-size:14px; }
  .sumrow.total { border-top:2px solid ${esc(b.primary_color)}; margin-top:6px; padding-top:8px; font-size:16px; font-weight:700; }
  .printbtn { display:inline-block; background:${esc(b.primary_color)}; color:#fff; border:0; border-radius:8px; padding:11px 20px; font-size:14px; font-weight:600; cursor:pointer; }
  @media print { .noprint { display:none !important; } body { background:#fff; } .card { box-shadow:none; } }
</style></head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="band">
        <div>
          <div style="margin-bottom:6px">${header}</div>
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
        ${due > 0.005 ? `<div style="background:${esc(b.accent_color)}1a;border:1px solid ${esc(b.accent_color)};border-radius:8px;padding:12px 16px;margin-bottom:18px;font-weight:600;color:${esc(b.primary_color)}">A payment of ${usd(due)} is due. See payment options below.</div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:18px;margin-bottom:18px;font-size:14px">
          <div style="flex:1;min-width:180px"><div style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px">Bill to</div><div style="font-weight:600">${esc(row.customer_name || '')}</div><div style="color:#475569">${esc(billTo)}</div></div>
          <div style="min-width:160px"><div style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px">Job address</div><div style="color:#475569">${esc(row.address || billTo)}</div>${row.completed_date ? `<div style="color:#475569;font-size:13px;margin-top:4px">Completed ${esc(fmtDate(row.completed_date))}</div>` : (row.signed_date ? `<div style="color:#475569;font-size:13px;margin-top:4px">Signed ${esc(fmtDate(row.signed_date))}</div>` : '')}</div>
        </div>
        <table class="li">
          <thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
          <tbody>${lineItemsRows(row.line_items)}</tbody>
        </table>
        <div style="max-width:300px;margin-left:auto;margin-top:16px">
          <div class="sumrow"><span>Invoice amount</span><span>${usd(total)}</span></div>
          <div class="sumrow"><span>Tax</span><span>${usd(0)}</span></div>
          <div class="sumrow"><span>Paid to date</span><span>-${usd(row.paid_to_date)}</span></div>
          <div class="sumrow total"><span>Amount due</span><span>${usd(due)}</span></div>
        </div>
      </div>
    </div>

    ${payButtons(b, due)}

    ${b.payment_instructions_html ? `<div class="card" style="margin-top:16px;padding:20px 22px">
      <h3 style="margin:0 0 8px;color:${esc(b.primary_color)};font-size:16px">More on payment</h3>
      <div style="font-size:14px;color:#334155;line-height:1.5">${paymentInstructionsHtml(b.payment_instructions_html)}</div>
    </div>` : ''}

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
    return invoicePage(row, brand);
  } catch (err) {
    // Distinct from the no-row case: the pec_job_ar query (or render) threw.
    console.error('public-invoice: query error', err.message);
    return notFoundPage();
  }
};
