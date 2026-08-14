// Public hosted invoice page at /pay/<token> (netlify.toml rewrites /pay/* here
// with the token in ?token=). Unauthenticated but unguessable (v4 UUID acts as
// a bearer token in the URL). Server-rendered HTML, no client JS needed to view.
// On a miss it returns a generic 404 page (never leaks the token or DB detail),
// and every response is noindex/nofollow so shared links are not crawled.
// Online card payment is via Stripe Checkout: the "Pay by card" buttons link to
// /api/stripe/checkout (pec-stripe-checkout.cjs), and the payment is recorded by
// the signature-verified pec-stripe-webhook.cjs (never by this page).
//
// Look (Dylan 2026-07-09): modeled on voltcoatings.com's design language in PEC
// brand colors. White cards with soft shadows on an off-white page, a dark ink
// hero band with the invoice number and amount due in big tight-tracked type,
// uppercase letterspaced "eyebrow" section labels in the accent orange, chunky
// rounded buttons, and a dark footer band with the accent rule. All payment
// logic (ACH pending/failed treatment, netting, deposit clamp, offline intent
// flow) is unchanged from prompts 11 + 13.

const { sb, tokenFromEvent } = require('./_pec-supabase.cjs');
const { loadFinancingSettings, financingBlockHtml } = require('./_pec-financing.cjs');
// Prompt 45: payment schedules. resolveCurrentAsk is the ONE definition of
// "the current amount due" (shared with Stripe checkout, the reminder drip,
// and the staff UI). A job with no installment rows resolves to null and this
// page renders EXACTLY its legacy full-balance behavior.
const { resolveCurrentAsk } = require('./_pec-installments.cjs');
const { depositOwed } = require('../../production/deposits.cjs');
const { termsLabel } = require('./_pec-invoice-terms.cjs');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Accounting-style negatives ("-$745.00"): a refund is a negative pec_payments
// row, and it shows on the customer's payment ledger like any other line.
const usd = (n) => (Number(n) < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
// on the white topbar, NEVER on the dark hero or orange surfaces (its orange
// text would vanish there). Used unless the brand row sets its own logo_url.
// Relative path so it resolves against whatever domain serves the page
// (domain-rename proof).
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
  return htmlResponse(404, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice not found</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"></head>
<body style="margin:0;font-family:'Inter',-apple-system,'Segoe UI',Arial,sans-serif;background:#f4f5f7;color:#14181C">
  <div style="max-width:520px;margin:80px auto;padding:0 20px">
    <div style="background:#fff;border-radius:16px;box-shadow:0 1px 2px rgba(16,24,40,.05),0 8px 24px rgba(16,24,40,.06);padding:34px 32px;text-align:center">
      <div style="font-size:11px;font-weight:800;letter-spacing:2.2px;text-transform:uppercase;color:#D8531C;margin-bottom:10px">Invoice</div>
      <h1 style="margin:0 0 10px;font-size:22px;font-weight:800;letter-spacing:-.01em">Invoice not found</h1>
      <p style="margin:0;color:#6b7280;font-size:14.5px;line-height:1.6">This link is invalid or has expired. If you believe this is a mistake, please contact Prescott Epoxy Company at (928) 800-8154.</p>
    </div>
  </div>
</body></html>`);
}

function lineItemsRows(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '<tr><td colspan="2" style="padding:14px 12px;color:#6b7280;text-align:center">No line items.</td></tr>';
  return list.map(li => {
    const price = li.price != null ? li.price : (li.total != null ? li.total : li.unit_price);
    return `<tr>
      <td><span style="font-weight:600">${esc(li.name || '')}</span>${li.is_change_order ? ' <span style="color:#b45309;font-size:12px;font-weight:600">(change order)</span>' : ''}${li.description ? `<div class="desc">${esc(li.description)}</div>` : ''}</td>
      <td>${price != null ? usd(price) : ''}</td>
    </tr>`;
  }).join('');
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Status pill shown in the topbar (right side). Color + label only. When an
// in-flight bank transfer covers the whole balance the pill says so; a
// "Payment due" pill next to the netted "$0.00" amount would read as a
// contradiction (the exact confusion prompt 13 removed everywhere else).
function statusPill(row, pendingSum, ask) {
  const balance = Number(row.balance_remaining || 0);
  if (balance <= 0.005) return { bg: '#16a34a', text: 'Paid in full' };
  // Schedule mode (prompt 45): the pill reflects the CURRENT ask, never the
  // full balance, so "no payment due yet" reads calm, not delinquent.
  if (ask) {
    if (ask.mode === 'none' || ask.mode === 'paid') return { bg: '#334155', text: 'On schedule' };
    if (round2(ask.amount - (Number(pendingSum) || 0)) <= 0.005) return { bg: '#b45309', text: 'Payment processing' };
    if (ask.isDeposit) return { bg: '#b45309', text: 'Deposit due' };
    return { bg: '#b91c1c', text: 'Payment due' };
  }
  if (round2(balance - (Number(pendingSum) || 0)) <= 0.005) return { bg: '#b45309', text: 'Payment processing' };
  if (row.status === 'completed') return { bg: '#b91c1c', text: 'Payment due' };
  if (!row.deposit_collected && !row.deposit_waived) return { bg: '#b45309', text: 'Deposit due' };
  return { bg: '#334155', text: 'Balance due' };
}

// Customer-facing milestone phrasing for the schedule card. No em dashes.
function askDuePhrase(inst) {
  switch (inst.trigger_kind) {
    case 'on_acceptance': return 'Due at acceptance';
    case 'on_start': return 'Due when work begins';
    case 'on_completion': return 'Due at completion';
    case 'date': return inst.due_date ? 'Due ' + fmtDate(inst.due_date) : 'Due by date';
    default: return 'On request';
  }
}

// The payment schedule card (prompt 45, locked decision 7): every installment
// with what is paid and what is upcoming, plus the project money context.
function scheduleSection(ask, b) {
  if (!ask) return '';
  const rows = (ask.schedule || []).map(s => {
    const state = s.settled
      ? '<span style="color:#16a34a;font-weight:700">Paid</span>'
      : s.isCurrent && (ask.mode === 'installment')
        ? '<span style="color:' + esc(b.accent_color) + ';font-weight:800">Due now</span>'
        : '<span style="color:#6b7280">Upcoming</span>';
    const applied = !s.settled && s.applied > 0.005 ? `<div class="desc">${usd(s.applied)} received</div>` : '';
    return `<tr>
      <td><span style="font-weight:600">${esc(s.label || (s.isDeposit ? 'Deposit' : 'Installment'))}</span><div class="desc">${esc(askDuePhrase({ trigger_kind: s.trigger_kind, due_date: null }))}</div></td>
      <td style="text-align:right;width:130px;white-space:nowrap">${usd(s.amount)}${applied}</td>
      <td style="text-align:right;width:110px;white-space:nowrap">${state}</td>
    </tr>`;
  }).join('');
  return `<div class="card pad" style="margin-top:18px">
    <div class="eyebrow">Payment schedule</div>
    <h3 class="sec">Your payment plan</h3>
    <table class="li">
      <thead><tr><th>Payment</th><th style="text-align:right">Amount</th><th style="text-align:right">Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="text-align:right;margin-top:14px;font-size:13.5px;color:#374151">Project total ${usd(ask.totals.price)} &middot; Paid ${usd(ask.totals.paid)} &middot; Remaining ${usd(ask.totals.balance)}</div>
    ${ask.mode === 'none' ? `<div style="margin-top:10px;font-size:13.5px;color:#6b7280;line-height:1.6">No payment is due right now. The next payment comes due at its milestone above.</div>` : ''}
  </div>`;
}

// Online payment via Stripe Checkout (PEC absorbs the processing fee, so the
// customer is charged the exact amount -- no surcharge). The "Pay online" button
// links to /api/stripe/checkout, where Stripe's hosted page offers every method
// the Dashboard enables (card, and ACH once Dylan flips the toggle; the nudge
// line below the buttons is decision 9 of prompt 11). A "Pay deposit" button
// also shows when a deposit is still due and is smaller than the balance. Check
// + Zelle stay as secondary options. `token` is the invoice public_token.
function payButtons(b, row, token, pendingSum, ask) {
  const due = round2(row.balance_remaining);
  if (due <= 0.005 || !token) return '';
  // Schedule mode (prompt 45): nothing due right now = no pay buttons at all
  // (one outstanding ask at a time; the schedule card explains what is next).
  if (ask && (ask.mode === 'none' || ask.mode === 'paid')) return '';
  // Prompt 13 decisions 3 + 4: a pending bank transfer covering the FULL
  // balance replaces the buttons with a processing note (they return
  // automatically if the ACH fails, because failed markers leave pendingSum);
  // a PARTIAL pending leaves the buttons targeting the remainder only. The
  // checkout function clamps server-side too, so a stale link or back button
  // cannot double-charge past the remainder either way.
  const pendSum = round2(Number(pendingSum) || 0);
  // Schedule mode nets the pending ACH against the CURRENT ask; legacy mode
  // nets against the full balance, exactly as before.
  const remainder = ask
    ? round2(Math.max(0, ask.amount - pendSum))
    : round2(Math.max(0, due - pendSum));
  if (remainder <= 0.005) {
    return `<div class="card pad" style="margin-top:18px">
      <div class="eyebrow">Payment</div>
      <h3 class="sec">Payment processing</h3>
      <div style="font-size:14.5px;color:#374151;line-height:1.6">Your bank transfer of ${usd(pendSum)} is processing and covers the ${ask ? 'payment that is due' : 'balance'}. No further payment is needed right now. Bank transfers take 3 to 5 business days to clear.</div>
    </div>`;
  }
  const depositDue = !row.deposit_collected && !row.deposit_waived;
  const owed = depositOwed(row.deposit_amount, row.price); // the ONE shared rule (production/deposits.cjs)
  // The legacy standalone deposit button only exists WITHOUT a schedule; with
  // one, the deposit is an installment and the current ask IS the button.
  const showDeposit = !ask && depositDue && owed >= 0.5 && owed < remainder - 0.005;
  const zelle = b.zelle_email || 'dylan@prescottepoxy.com';
  const phone = b.phone || '(928) 800-8154';
  const tok = encodeURIComponent(token);
  // Offline details: the editable brand text if set, else a sensible default.
  const offlineDetails = b.offline_payment_details_text
    ? paymentInstructionsHtml(b.offline_payment_details_text)
    : `<p style="margin:0 0 10px">Pay by check (give it to the crew or mail it) or send Zelle to <strong>${esc(zelle)}</strong>. Questions? Call ${esc(name(b))} at <strong>${esc(phone)}</strong>.</p>`;
  // Card AND offline are presented with equal weight (filled buttons of the
  // same size). The offline button expands an in-page panel; no navigation.
  // Schedule mode: the primary button charges the CURRENT ask (server-side
  // amount via kind=installment; the client never supplies an amount). A
  // secondary full-balance button appears when more than this ask remains, so
  // a customer who wants to pay everything still can (kind=balance already
  // clamps server-side).
  const balNet = round2(Math.max(0, due - pendSum));
  const primaryHref = ask ? `/api/stripe/checkout?token=${tok}&kind=installment` : `/api/stripe/checkout?token=${tok}&kind=balance`;
  const primaryLabel = ask
    ? `Pay ${usd(remainder)}${ask.isDeposit ? ' deposit' : ''} online`
    : `Pay ${usd(remainder)} online`;
  return `<div class="card pad" style="margin-top:18px">
    <div class="eyebrow">Payment options</div>
    <h3 class="sec">${ask ? (ask.isDeposit ? 'Pay your deposit' : 'Pay what is due') : 'Pay your balance'}</h3>
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">
      <a class="btn accent" href="${primaryHref}">${primaryLabel}</a>
      ${showDeposit ? `<a class="btn ink" href="/api/stripe/checkout?token=${tok}&kind=deposit">Pay deposit ${usd(owed)}</a>` : ''}
      ${ask && balNet > remainder + 0.005 ? `<a class="btn ink" href="/api/stripe/checkout?token=${tok}&kind=balance">Pay the full remaining ${usd(balNet)}</a>` : ''}
      <button type="button" id="offlineToggle" class="btn ink">Pay by check, cash, or Zelle</button>
    </div>
    <div class="secure"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Pay online by card or bank transfer (ACH), no card fees on bank transfer. Payments are secured by Stripe (we cover the processing fee).</div>
    <div id="offlinePanel" style="display:none;margin-top:18px;border-top:1px solid #eef0f3;padding-top:18px">
      <div style="font-size:14.5px;color:#374151;line-height:1.6">${offlineDetails}</div>
      <div style="margin-top:14px;font-size:13px;color:#6b7280">Let our office know how you'll pay so we can watch for it:</div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:10px">
        <button type="button" data-intent-method="check" class="btn mini">Paying by check</button><button type="button" data-intent-method="cash" class="btn mini">Paying cash</button><button type="button" data-intent-method="zelle" class="btn mini">Sending Zelle</button>
      </div>
      <div id="intentStatus" style="margin-top:12px;font-size:13px;font-weight:600"></div>
    </div>
    <script>
      (function(){
        var t=${JSON.stringify(token)}, ph=${JSON.stringify(phone)};
        var tog=document.getElementById('offlineToggle'), panel=document.getElementById('offlinePanel');
        if(tog&&panel){tog.addEventListener('click',function(){panel.style.display=panel.style.display==='none'?'block':'none';});}
        var status=document.getElementById('intentStatus');
        Array.prototype.forEach.call(document.querySelectorAll('[data-intent-method]'),function(btn){
          btn.addEventListener('click',function(){
            var m=btn.getAttribute('data-intent-method');
            Array.prototype.forEach.call(document.querySelectorAll('[data-intent-method]'),function(x){x.disabled=true;});
            if(status){status.style.color='#6b7280';status.textContent='Letting the office know…';}
            fetch('/api/invoice/intent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t,method:m})})
              .then(function(r){return r.json();}).then(function(d){
                if(d&&d.ok){if(status){status.style.color='#16a34a';status.textContent='Thanks! Our office has been notified and will be in touch.';}}
                else{throw new Error('failed');}
              }).catch(function(){
                if(status){status.style.color='#dc2626';status.textContent='Could not reach the office automatically. Please call '+ph+'.';}
                Array.prototype.forEach.call(document.querySelectorAll('[data-intent-method]'),function(x){x.disabled=false;});
              });
          });
        });
      })();
    </script>
  </div>`;
}
function name(b) { return b.business_name || 'Prescott Epoxy Company'; }

// Payment ledger for this invoice (from pec_payments), plus any IN-FLIGHT bank
// transfers (prompt 13): a pending ACH renders as a real line with a PENDING
// badge on every visit while it clears, so the customer sees their payment
// exists the moment they make it. Pending lines are NOT counted in Total paid
// (the money has not settled); the Amount due math handles the netting.
function paymentsSection(payments, b, pendingRows) {
  const list = Array.isArray(payments) ? payments : [];
  const pend = Array.isArray(pendingRows) ? pendingRows : [];
  if (!list.length && !pend.length) return '';
  const methodLabel = (m) => ({ check: 'Check', cash: 'Cash', zelle: 'Zelle', stripe: 'Card', card: 'Card' }[m] || (m ? m.charAt(0).toUpperCase() + m.slice(1) : '-'));
  const rows = list.map(p => `<tr>
      <td>${esc(fmtDate(p.received_date))}</td>
      <td>${esc(methodLabel(p.method))}</td>
      <td>${esc(p.reference || '')}</td>
      <td>${usd(p.amount)}</td>
    </tr>`).join('');
  // Initiated day in Phoenix time (created_at is a UTC timestamptz).
  const phxDay = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t - 7 * 3600 * 1000).toISOString().slice(0, 10) : null; };
  const pendRows = pend.map(p => `<tr>
      <td>${esc(fmtDate(phxDay(p.created_at)))}</td>
      <td>Bank transfer</td>
      <td style="color:#6b7280">processing</td>
      <td>${usd(p.amount)} <span class="pendtag">PENDING</span></td>
    </tr>`).join('');
  const totalPaid = list.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  return `<div class="card pad" style="margin-top:18px">
    <div class="eyebrow">Payment history</div>
    <h3 class="sec">Payments received</h3>
    <table class="li">
      <thead><tr><th>Date</th><th>Method</th><th>Reference / Check #</th><th style="text-align:right;width:130px">Amount</th></tr></thead>
      <tbody>${rows}${pendRows}</tbody>
    </table>
    <div style="text-align:right;margin-top:14px;font-weight:800;font-size:15px;color:${esc(b.primary_color)}">Total paid: ${usd(totalPaid)}</div>
    ${pend.length ? `<div style="text-align:right;font-size:12px;color:#92400e;margin-top:4px">Pending bank transfers are not counted until they clear (3 to 5 business days).</div>` : ''}
  </div>`;
}

function invoicePage(row, brand, payments, opts) {
  const o = opts || {};
  const b = { ...BRAND_DEFAULTS, ...(brand || {}) };
  const biz = name(b);
  const logoUrl = b.logo_url || LOGO_URL;
  const invNo = row.hq_invoice_number || row.dripjobs_deal_id || String(row.id || '').slice(0, 8);
  const billTo = row.bill_to_address || row.address || '';
  const total = Number(row.price || 0);
  const due = Number(row.balance_remaining || 0);
  // Prompt 13: Amount due shows NET of in-flight bank transfers, so a customer
  // whose ACH is clearing never reads as still owing that money. Reverts
  // automatically if the ACH fails (failed markers are not in pendingSum).
  const pendingSum = Number(o.pendingSum || 0);
  const dueNet = Math.max(0, round2(due - pendingSum));
  // Schedule mode (prompt 45): the hero "Amount due" is the CURRENT ask (net
  // of in-flight ACH), never the full balance. ask == null -> legacy page.
  const ask = o.ask || null;
  const heroDue = ask ? Math.max(0, round2(ask.amount - pendingSum)) : dueNet;
  const dueLater = ask ? Math.max(0, round2(dueNet - heroDue)) : 0;
  const pill = statusPill(row, pendingSum, ask);
  const primary = esc(b.primary_color);
  const accent = esc(b.accent_color);
  const dateLine = row.completed_date
    ? `Completed ${esc(fmtDate(row.completed_date))}`
    : (row.signed_date ? `Signed ${esc(fmtDate(row.signed_date))}` : '');
  // Invoice terms (2026-08-17): the top-of-invoice terms line, shown in the
  // hero AND the bill-to band (DripJobs shows its due date in both spots).
  // Informational only: the schedule/ask owns every amount and the due box.
  // Paid invoices keep the terms label but drop the date (nothing is due).
  const termsBits = [];
  const termsName = termsLabel(row.invoice_terms);
  if (termsName && row.invoice_terms !== 'custom_date') termsBits.push(termsName);
  if (row.invoice_due_date && due > 0.005) termsBits.push('Due ' + fmtDate(row.invoice_due_date));
  const termsLine = termsBits.map(esc).join(' &middot; ');

  return htmlResponse(200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${esc(invNo)} &middot; ${esc(biz)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  @page { size: letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:'Inter',-apple-system,'Segoe UI',Arial,sans-serif; background:#f4f5f7; color:${primary}; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:780px; margin:0 auto; padding:28px 18px 56px; }
  .card { background:#fff; border-radius:16px; box-shadow:0 1px 2px rgba(16,24,40,.05), 0 8px 24px rgba(16,24,40,.06); overflow:hidden; }
  .pad { padding:26px 30px; }
  .eyebrow { font-size:11px; font-weight:800; letter-spacing:2.2px; text-transform:uppercase; color:${accent}; margin-bottom:6px; }
  h3.sec { margin:0 0 16px; font-size:19px; font-weight:800; letter-spacing:-.01em; color:${primary}; }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:18px 30px; }
  .topbar img { max-height:46px; max-width:240px; display:block; }
  .pill { display:inline-block; background:${pill.bg}; color:#fff; font-size:11px; font-weight:800; letter-spacing:1.2px; text-transform:uppercase; border-radius:999px; padding:6px 14px; white-space:nowrap; }
  .hero { background:${primary}; color:#fff; padding:30px; display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:20px; }
  .hero .big { font-size:34px; font-weight:800; letter-spacing:-.02em; line-height:1.05; }
  .hero .sub { color:rgba(255,255,255,.62); font-size:13px; margin-top:8px; }
  .hero .right { text-align:right; }
  .lbl { font-size:11px; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:#98a1ad; margin-bottom:6px; }
  .grid2 { display:flex; flex-wrap:wrap; gap:22px; margin-bottom:24px; font-size:14.5px; }
  .grid2 > div { flex:1; min-width:200px; }
  table.li { width:100%; border-collapse:collapse; font-size:14.5px; font-variant-numeric:tabular-nums; }
  table.li th { text-align:left; padding:0 12px 10px; font-size:11px; font-weight:800; letter-spacing:1.8px; text-transform:uppercase; color:#98a1ad; border-bottom:2px solid ${primary}; }
  table.li td { padding:14px 12px; border-bottom:1px solid #eef0f3; vertical-align:top; line-height:1.5; }
  table.li th:last-child, table.li td:last-child { text-align:right; width:130px; white-space:nowrap; }
  table.li .desc { color:#6b7280; font-size:13px; margin-top:4px; line-height:1.5; white-space:pre-wrap; font-weight:400; }
  /* Totals table: same width + last-column width as the line items table, so the
     amounts line up directly under the line-item Amount column. */
  table.tot { width:100%; border-collapse:collapse; font-size:14.5px; font-variant-numeric:tabular-nums; margin-top:10px; }
  table.tot td { padding:5px 12px; }
  table.tot td:first-child { text-align:right; color:#6b7280; }
  table.tot td:last-child { text-align:right; width:130px; white-space:nowrap; }
  table.tot tr.total td { border-top:2px solid ${primary}; padding-top:12px; font-size:19px; font-weight:800; color:${primary}; }
  table.tot tr.total td:last-child { color:${accent}; }
  .btn { display:inline-block; border:0; border-radius:10px; padding:14px 24px; font-family:inherit; font-size:15px; font-weight:700; cursor:pointer; text-decoration:none; transition:filter .15s; }
  .btn:hover { filter:brightness(.9); }
  .btn.accent { background:${accent}; color:#fff; }
  .btn.ink { background:${primary}; color:#fff; }
  .btn.mini { background:#fff; border:1.5px solid ${primary}; color:${primary}; font-size:13px; font-weight:600; border-radius:8px; padding:9px 14px; }
  .btn.mini:disabled { opacity:.55; cursor:default; }
  .secure { display:flex; align-items:flex-start; gap:8px; font-size:13px; color:#6b7280; margin-top:14px; line-height:1.5; }
  .secure svg { width:15px; height:15px; flex:none; margin-top:1px; color:#16a34a; }
  .banner { border-radius:12px; padding:14px 18px; margin-bottom:18px; font-weight:600; font-size:14px; line-height:1.5; }
  .duebox { background:${accent}14; border:1px solid ${accent}55; border-radius:12px; padding:14px 18px; margin-bottom:22px; font-weight:700; color:${primary}; font-size:15px; }
  .footerband { background:${primary}; color:#fff; border-radius:16px; padding:28px 30px; margin-top:18px; text-align:center; }
  .footerband .rule { width:44px; height:4px; background:${accent}; margin:0 auto 16px; border-radius:2px; }
  .footerband .bizname { font-weight:800; letter-spacing:1.5px; text-transform:uppercase; font-size:15px; }
  .footerband .meta { color:rgba(255,255,255,.6); font-size:13px; margin-top:8px; line-height:1.6; }
  .printbtn { display:inline-block; background:#fff; color:${primary}; border:1.5px solid ${primary}; border-radius:10px; padding:12px 22px; font-family:inherit; font-size:14px; font-weight:700; cursor:pointer; }
  @media print {
    .noprint { display:none !important; }
    body { background:#fff; }
    .card, .footerband { box-shadow:none; border:1px solid #e5e7eb; }
    * { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  }
  @media (max-width:560px) {
    .pad { padding:22px; }
    .topbar { padding:16px 22px; }
    .hero { padding:24px 22px; }
    .hero .right { text-align:left; }
    .hero .big { font-size:28px; }
  }
</style></head>
<body>
  <div class="wrap">
    ${pendingSum > 0.005
      ? `<div class="banner noprint" style="background:#fffbeb;border:1px solid #f59e0b;color:#92400e">Payment initiated (${usd(pendingSum)}). Bank transfers take 3 to 5 business days to clear. No need to pay that amount again; it shows as PENDING under Payments until it clears.</div>`
      : o.achFailed
        ? `<div class="banner noprint" style="background:#fef2f2;border:1px solid #dc2626;color:#7f1d1d">Your bank transfer could not be completed. Please pay again below or contact us.</div>`
        : o.paid ? `<div class="banner noprint" style="background:#f0fdf4;border:1px solid #16a34a;color:#14532d">Payment received, thank you! It will appear in the Payments section below within a moment.</div>` : ''}
    <div class="card">
      <div class="topbar">
        <img src="${esc(logoUrl)}" alt="${esc(biz)}">
        <span class="pill">${esc(pill.text)}</span>
      </div>
      <div class="hero">
        <div>
          <div class="eyebrow">${esc(biz)}</div>
          <div class="big">Invoice #${esc(invNo)}</div>
          ${dateLine ? `<div class="sub">${dateLine}</div>` : ''}
          ${termsLine ? `<div class="sub" style="color:rgba(255,255,255,.88);font-weight:700">${termsLine}</div>` : ''}
        </div>
        <div class="right">
          <div class="eyebrow">${ask ? 'Amount due now' : 'Amount due'}</div>
          <div class="big">${usd(heroDue)}</div>
          <div class="sub">Total ${usd(total)} &middot; Paid ${usd(row.paid_to_date)}${ask && dueLater > 0.005 ? ` &middot; Later ${usd(dueLater)}` : ''}</div>
        </div>
      </div>
      <div class="pad">
        ${b.invoice_intro_text ? `<div style="font-size:14.5px;color:#374151;line-height:1.6;margin-bottom:20px">${paymentInstructionsHtml(b.invoice_intro_text)}</div>` : ''}
        ${ask
          ? (heroDue > 0.005
              ? `<div class="duebox">A payment of ${usd(heroDue)} is due${ask.label && ask.mode === 'installment' ? ' (' + esc(ask.label) + ')' : ''}. See payment options below.</div>`
              : (ask.mode === 'none' && dueNet > 0.005 ? `<div class="duebox" style="background:#f8fafc;border-color:#cbd5e1">No payment is due right now. Your payment schedule is below.</div>` : ''))
          : (dueNet > 0.005 ? `<div class="duebox">A payment of ${usd(dueNet)} is due. See payment options below.</div>` : '')}
        <div class="grid2">
          <div><div class="lbl">Bill to</div><div style="font-weight:700">${esc(row.customer_name || '')}</div><div style="color:#4b5563;margin-top:2px">${esc(billTo)}</div></div>
          <div><div class="lbl">Job address</div><div style="color:#4b5563">${esc(row.address || billTo)}</div>${dateLine ? `<div style="color:#4b5563;font-size:13px;margin-top:4px">${dateLine}</div>` : ''}</div>
          ${termsLine ? `<div><div class="lbl">Terms</div><div style="color:#4b5563;font-weight:600">${termsLine}</div></div>` : ''}
        </div>
        <table class="li">
          <thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
          <tbody>${lineItemsRows(row.line_items)}</tbody>
        </table>
        <table class="tot">
          <tr><td>Invoice amount</td><td>${usd(total)}</td></tr>
          <tr><td>Tax</td><td>${usd(0)}</td></tr>
          <tr><td>Paid to date</td><td>-${usd(row.paid_to_date)}</td></tr>
          ${pendingSum > 0.005 ? `<tr><td>Pending bank transfer</td><td>-${usd(pendingSum)}</td></tr>` : ''}
          ${ask && dueLater > 0.005 ? `<tr><td>Scheduled for later</td><td>-${usd(dueLater)}</td></tr>` : ''}
          <tr class="total"><td>${ask ? 'Amount due now' : 'Amount due'}</td><td>${usd(heroDue)}</td></tr>
        </table>
        ${pendingSum > 0.005 ? `<div style="text-align:right;font-size:12px;color:#92400e;margin-top:8px">Amount due reflects a pending bank transfer of ${usd(pendingSum)} that takes 3 to 5 business days to clear.</div>` : ''}
      </div>
    </div>

    ${scheduleSection(ask, b)}

    ${paymentsSection(payments, b, o.pendingRows)}

    ${/* Financing (prompt 58 Part F): keyed on the BALANCE DUE, not the
        invoice total, right above the pay buttons where a customer weighing
        the payment is looking. '' unless enabled, and flush against
        payButtons so the disabled state renders byte-identical. */
      financingBlockHtml(o.financing, dueNet, { accent: b.accent_color })}${payButtons(b, row, o.token, pendingSum, ask)}

    ${b.payment_instructions_html ? `<div class="card pad" style="margin-top:18px">
      <div class="eyebrow">Good to know</div>
      <h3 class="sec">More on payment</h3>
      <div style="font-size:14.5px;color:#374151;line-height:1.6">${paymentInstructionsHtml(b.payment_instructions_html)}</div>
    </div>` : ''}

    ${b.invoice_footer_text ? `<div class="card pad" style="margin-top:18px">
      <div style="font-size:14.5px;color:#374151;line-height:1.6">${paymentInstructionsHtml(b.invoice_footer_text)}</div>
    </div>` : ''}

    ${b.invoice_terms_text ? `<div style="margin-top:18px;font-size:12px;color:#9ca3af;line-height:1.6">${paymentInstructionsHtml(b.invoice_terms_text)}</div>` : ''}

    <div class="noprint" style="text-align:center;margin-top:24px">
      <button class="printbtn" onclick="window.print()">Print / Save as PDF</button>
    </div>
    <div class="footerband">
      <div class="rule"></div>
      <div class="bizname">${esc(biz)}</div>
      <div class="meta">${[b.address_line, b.phone, b.license_number ? 'License ' + b.license_number : ''].filter(Boolean).map(esc).join(' &middot; ')}</div>
    </div>
  </div>
  ${o.print ? `<script>window.addEventListener('load',function(){setTimeout(function(){try{window.print()}catch(e){}},350);});<\/script>` : ''}
</body></html>`);
}

exports.handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') return htmlResponse(405, 'Method not allowed');
  // ?token= with a path-parse fallback for Netlify's :splat quirk; see
  // tokenFromEvent in _pec-supabase.cjs.
  const token = tokenFromEvent(event);
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
    // Payment schedule (prompt 45): resolve the current ask through the
    // shared resolver. Best-effort: a pre-migration schema or read hiccup
    // means no schedule treatment and the page renders its legacy behavior.
    let ask = null;
    try {
      const instRows = await sb('GET', `/pec_invoice_installments?job_id=eq.${encodeURIComponent(row.id)}&select=*`);
      if (Array.isArray(instRows) && instRows.length) {
        ask = resolveCurrentAsk({ job: row, installments: instRows, payments });
      }
    } catch (_) { /* no schedule treatment */ }
    // ACH state (prompts 11 + 13): pending markers make the invoice reflect an
    // in-flight bank transfer IMMEDIATELY and persistently (pending line in
    // Payments, net Amount due, buttons hidden when fully covered), and the
    // newest failed marker drives the pay-again notice. Checked on EVERY
    // render, not just ?paid=1. Best-effort: a missing table pre-migration (or
    // any read hiccup) just means no ACH treatment; the page never breaks.
    let pendingRows = [];
    let achFailed = false;
    try {
      const marks = await sb('GET', `/pec_stripe_pending?job_id=eq.${encodeURIComponent(row.id)}&status=in.(pending,failed)&select=amount,kind,status,created_at,resolved_at&order=created_at.asc`);
      const list = Array.isArray(marks) ? marks : [];
      pendingRows = list.filter(m => m.status === 'pending');
      // Failure notice (decision 6): show while the NEWEST failed marker has no
      // successful payment dated on/after its initiation day (received_date is
      // a Phoenix date, so compare at day granularity; a same-day payment
      // counts as the customer having paid again). Judgment call: also
      // suppressed while a NEWER pending marker exists, because "pay again"
      // next to "payment initiated" for the retry they already made would
      // read as a contradiction; if that retry fails too, ITS failure shows.
      const failed = list.filter(m => m.status === 'failed');
      const newestFailed = failed.length ? failed[failed.length - 1] : null;
      if (newestFailed) {
        const failedDay = new Date(Date.parse(newestFailed.created_at) - 7 * 3600 * 1000).toISOString().slice(0, 10);
        const paidAfter = (payments || []).some(p => p.received_date && p.received_date >= failedDay);
        const retriedAfter = pendingRows.some(p => String(p.created_at) > String(newestFailed.created_at));
        achFailed = !paidAfter && !retriedAfter;
      }
    } catch (_) { /* no ACH treatment */ }
    const pendingSum = round2(pendingRows.reduce((s2, p) => s2 + (Number(p.amount) || 0), 0));
    const paidParam = (event.queryStringParameters && event.queryStringParameters.paid) || '';
    // print=1: staff opened this page from the dashboard to print it. Only
    // effect is auto-opening the print dialog on load; render is identical.
    const printParam = (event.queryStringParameters && event.queryStringParameters.print) || '';
    const financing = await loadFinancingSettings(sb);
    return invoicePage(row, brand, payments, { token, paid: paidParam === '1' || paidParam === 'true', print: printParam === '1', pendingRows, pendingSum, achFailed, ask, financing });
  } catch (err) {
    // Distinct from the no-row case: the pec_job_ar query (or render) threw.
    console.error('public-invoice: query error', err.message);
    return notFoundPage();
  }
};
