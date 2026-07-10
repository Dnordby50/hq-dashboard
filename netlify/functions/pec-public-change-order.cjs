// Public change-order approval page at /co/<token> (netlify.toml rewrites
// /co/* here with the token in ?token=), plus the signing POST at
// /api/co/sign. Mirrors pec-public-invoice.cjs: unauthenticated but
// unguessable (v4 UUID bearer token), server-rendered HTML, generic 404 on a
// miss, noindex/nofollow, no client frameworks (a small block of vanilla JS
// runs the signature canvas).
//
// The page IS the change-order document (Dylan, prompt 12): brand-styled,
// printable, and after signing it renders with the signature block filled so
// printing it produces the signed record. Signature capture is native (typed
// name + drawn canvas), recorded with timestamp, IP, and user agent onto
// pec_change_order_signatures via the service role; the table has NO anon
// policy, so this function is the only unauthenticated path that can touch
// it, and it can only flip pending -> signed for a token it was handed.
// If certified audit trails (e.g. court-grade e-sign) ever matter, replace
// this page with an e-sign API (SignWell/DocuSign); the table already stores
// the snapshot + audit fields such a migration would need.
//
// Signing is NON-idempotent by design: verify-then-write, no blind retry. A
// second sign attempt on an already-signed CO returns 409 and the page shows
// the existing signature.

const { sb, json, tokenFromEvent } = require('./_pec-supabase.cjs');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtStamp = (s) => s ? new Date(s).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

const BRAND_DEFAULTS = {
  logo_url: null, primary_color: '#14181C', accent_color: '#D8531C',
  business_name: 'Prescott Epoxy Company', address_line: '', phone: '',
  license_number: '', website: '',
};
const LOGO_URL = '/assets/pec-logo.png';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Drawn signature data-URL cap. A normal canvas signature PNG is 5-30KB;
// 200KB rejects anything abusive without ever biting a real signature.
const MAX_SIG_BYTES = 200 * 1024;

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
  return htmlResponse(404, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title></head>
<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;color:#0f172a">
  <div style="max-width:520px;margin:80px auto;padding:0 20px;text-align:center">
    <h1 style="font-size:20px">Change order not found</h1>
    <p style="color:#475569;font-size:14px">This link is invalid or no longer available. Please contact us if you believe this is an error.</p>
  </div>
</body></html>`);
}

// Fetch the CO row + its job/customer context. Returns null on any miss.
async function loadCo(token) {
  if (!UUID_RE.test(String(token || ''))) return null;
  const rows = await sb('GET', `/pec_change_order_signatures?token=eq.${encodeURIComponent(token)}&select=*&limit=1`);
  const co = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!co) return null;
  let job = null, customer = null;
  try {
    const jobs = await sb('GET', `/jobs?id=eq.${encodeURIComponent(co.job_id)}&select=id,address,price,customer_id,customers(name,company,email,phone)&limit=1`);
    job = Array.isArray(jobs) && jobs[0] ? jobs[0] : null;
    customer = job && job.customers ? job.customers : null;
  } catch (e) { console.error('pec-public-change-order: job fetch failed', e.message); }
  return { co, job, customer };
}

function coPage(co, job, customer, brand) {
  const b = { ...BRAND_DEFAULTS, ...(brand || {}) };
  const logo = b.logo_url || LOGO_URL;
  const signed = co.status === 'signed';
  const scopeRows = [
    co.system_name ? `<tr><td class="k">System</td><td>${esc(co.system_name)}</td></tr>` : '',
    (co.sqft != null && Number(co.sqft) > 0) ? `<tr><td class="k">Square footage</td><td>${esc(Number(co.sqft).toLocaleString('en-US'))} sq ft</td></tr>` : '',
    co.description ? `<tr><td class="k">Scope</td><td style="white-space:pre-wrap">${esc(co.description)}</td></tr>` : '',
  ].filter(Boolean).join('');

  const signedBlock = `
    <div class="sigblock">
      <div class="sig-h">Approved and signed</div>
      ${co.signature_data ? `<img src="${esc(co.signature_data)}" alt="Signature" style="max-width:320px;max-height:110px;background:#fff;border-bottom:1px solid #94a3b8;padding:4px 8px">` : ''}
      <div class="sig-name">${esc(co.signed_name || '')}</div>
      <div class="sig-meta">Signed ${esc(fmtStamp(co.signed_at))}</div>
      <button class="btn ghost noprint" onclick="window.print()">Print signed copy</button>
    </div>`;

  const signForm = `
    <div class="sigblock noprint" id="signWrap">
      <div class="sig-h">Approve this change order</div>
      <p style="font-size:13px;color:#475569;margin:6px 0 12px">By signing below you approve the work and price above, which will be added to your invoice total.</p>
      <label class="lbl">Type your full name</label>
      <input id="sigName" autocomplete="name" placeholder="Full name">
      <label class="lbl" style="margin-top:12px">Draw your signature</label>
      <canvas id="sigPad" width="560" height="140"></canvas>
      <div style="display:flex;gap:10px;align-items:center;margin-top:6px">
        <button class="btn ghost" type="button" id="sigClear">Clear</button>
        <span id="sigErr" style="color:#dc2626;font-size:13px"></span>
      </div>
      <button class="btn primary" type="button" id="sigGo">Approve &amp; sign</button>
    </div>
    <div class="sigblock" id="signedWrap" style="display:none">
      <div class="sig-h">Approved and signed</div>
      <img id="signedImg" alt="Signature" style="max-width:320px;max-height:110px;background:#fff;border-bottom:1px solid #94a3b8;padding:4px 8px">
      <div class="sig-name" id="signedName"></div>
      <div class="sig-meta" id="signedMeta"></div>
      <button class="btn ghost noprint" onclick="window.print()">Print signed copy</button>
    </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Change Order · ${esc(b.business_name)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: Arial, Helvetica, sans-serif; background:#f1f5f9; color:#0f172a; }
  .wrap { max-width:680px; margin:24px auto 60px; padding:0 16px; }
  .doc { background:#fff; border-radius:10px; box-shadow:0 2px 12px rgba(15,23,42,.08); overflow:hidden; }
  .band { background:${esc(b.primary_color)}; color:#fff; padding:18px 26px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  .band .t { font-size:20px; font-weight:700; letter-spacing:.5px; }
  .body { padding:24px 26px; }
  .logo { max-height:44px; }
  table.meta { width:100%; border-collapse:collapse; font-size:14px; margin:14px 0; }
  table.meta td { padding:7px 0; border-bottom:1px solid #e2e8f0; vertical-align:top; }
  table.meta td.k { color:#64748b; width:150px; font-size:12px; text-transform:uppercase; letter-spacing:.6px; padding-right:12px; }
  .price { display:flex; justify-content:space-between; align-items:baseline; margin:16px 0 4px; padding:14px 16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; }
  .price .amt { font-size:24px; font-weight:700; color:${esc(b.accent_color)}; }
  .sigblock { margin-top:22px; padding-top:18px; border-top:2px solid #0f172a; }
  .sig-h { font-size:13px; text-transform:uppercase; letter-spacing:1px; color:#334155; font-weight:700; }
  .sig-name { font-size:16px; font-weight:600; margin-top:6px; }
  .sig-meta { font-size:12.5px; color:#64748b; margin-top:2px; }
  .lbl { display:block; font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:#64748b; margin-bottom:4px; }
  input#sigName { width:100%; max-width:360px; padding:10px 12px; font-size:15px; border:1px solid #cbd5e1; border-radius:8px; }
  canvas#sigPad { width:100%; max-width:560px; height:140px; border:1px dashed #94a3b8; border-radius:8px; background:#fff; touch-action:none; }
  .btn { display:inline-block; margin-top:14px; padding:11px 22px; border-radius:8px; font-size:15px; font-weight:600; cursor:pointer; border:1px solid transparent; }
  .btn.primary { background:${esc(b.accent_color)}; color:#fff; }
  .btn.ghost { background:#fff; color:#334155; border-color:#cbd5e1; margin-top:8px; padding:7px 14px; font-size:13px; }
  .foot { text-align:center; color:#94a3b8; font-size:12px; margin-top:18px; }
  @media print { body { background:#fff; } .doc { box-shadow:none; border-radius:0; } .noprint { display:none !important; } .wrap { margin:0; max-width:none; } }
</style></head>
<body>
  <div class="wrap">
    <div class="doc">
      <div class="band"><span class="t">CHANGE ORDER</span><span style="font-size:13px">${esc(b.business_name)}</span></div>
      <div class="body">
        <img class="logo" src="${esc(logo)}" alt="${esc(b.business_name)}">
        <table class="meta">
          <tr><td class="k">Customer</td><td>${esc((customer && customer.name) || '')}</td></tr>
          ${job && job.address ? `<tr><td class="k">Job address</td><td>${esc(job.address)}</td></tr>` : ''}
          <tr><td class="k">Change order</td><td><strong>${esc(co.title)}</strong></td></tr>
          ${scopeRows}
          <tr><td class="k">Date issued</td><td>${esc(fmtStamp(co.created_at))}</td></tr>
        </table>
        <div class="price"><span style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:.6px">Change order total</span><span class="amt">${usd(co.amount)}</span></div>
        <div style="font-size:12.5px;color:#64748b">This amount is added to the job's invoice total.</div>
        ${signed ? signedBlock : signForm}
      </div>
    </div>
    <div class="foot">${esc(b.business_name)}${b.phone ? ' · ' + esc(b.phone) : ''}${b.license_number ? ' · ROC ' + esc(b.license_number) : ''}</div>
  </div>
${signed ? '' : `<script>
(function () {
  var canvas = document.getElementById('sigPad');
  var ctx = canvas.getContext('2d');
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0f172a';
  var drawing = false, drew = false, last = null;
  function pos(e) {
    var r = canvas.getBoundingClientRect();
    var p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - r.left) * (canvas.width / r.width), y: (p.clientY - r.top) * (canvas.height / r.height) };
  }
  function down(e) { drawing = true; last = pos(e); e.preventDefault(); }
  function move(e) {
    if (!drawing) return;
    var p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; drew = true; e.preventDefault();
  }
  function up() { drawing = false; }
  canvas.addEventListener('mousedown', down); canvas.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  canvas.addEventListener('touchstart', down, { passive: false }); canvas.addEventListener('touchmove', move, { passive: false }); canvas.addEventListener('touchend', up);
  document.getElementById('sigClear').addEventListener('click', function () { ctx.clearRect(0, 0, canvas.width, canvas.height); drew = false; });
  var btn = document.getElementById('sigGo'), err = document.getElementById('sigErr');
  btn.addEventListener('click', function () {
    err.textContent = '';
    var name = document.getElementById('sigName').value.trim();
    if (!name) { err.textContent = 'Type your full name.'; return; }
    if (!drew) { err.textContent = 'Draw your signature.'; return; }
    btn.disabled = true; btn.textContent = 'Signing\\u2026';
    fetch('/api/co/sign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ${JSON.stringify(String(co.token))}, name: name, signature: canvas.toDataURL('image/png') })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j && res.j.error) || 'Could not record the signature.');
        document.getElementById('signWrap').style.display = 'none';
        var w = document.getElementById('signedWrap');
        document.getElementById('signedImg').src = canvas.toDataURL('image/png');
        document.getElementById('signedName').textContent = name;
        document.getElementById('signedMeta').textContent = 'Signed ' + new Date().toLocaleString();
        w.style.display = '';
      })
      .catch(function (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Approve & sign'; });
  });
})();
<\/script>`}
</body></html>`;
}

exports.handler = async (event) => {
  // POST /api/co/sign: record the signature. Verify-then-write: a CO that is
  // already signed is never overwritten (409), so a retry or replay cannot
  // alter the recorded signature.
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { ok: false, error: 'Invalid request' }); }
    const { token, name, signature } = body;
    const cleanName = String(name || '').trim().slice(0, 120);
    if (!UUID_RE.test(String(token || ''))) return json(404, { ok: false, error: 'Not found' });
    if (!cleanName) return json(400, { ok: false, error: 'Name is required' });
    if (typeof signature !== 'string' || !signature.startsWith('data:image/png;base64,')) {
      return json(400, { ok: false, error: 'Signature is required' });
    }
    if (signature.length > MAX_SIG_BYTES) return json(400, { ok: false, error: 'Signature image too large' });
    try {
      const rows = await sb('GET', `/pec_change_order_signatures?token=eq.${encodeURIComponent(token)}&select=id,status&limit=1`);
      const co = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (!co) return json(404, { ok: false, error: 'Not found' });
      if (co.status === 'signed') return json(409, { ok: false, error: 'This change order is already signed.' });
      const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
      const ua = String(event.headers['user-agent'] || '').slice(0, 300) || null;
      await sb('PATCH', `/pec_change_order_signatures?id=eq.${encodeURIComponent(co.id)}&status=eq.pending`, {
        status: 'signed', signed_name: cleanName, signature_data: signature,
        signed_at: new Date().toISOString(), signer_ip: ip, signer_user_agent: ua,
      });
      return json(200, { ok: true });
    } catch (err) {
      console.error('pec-public-change-order sign error:', err.message);
      return json(500, { ok: false, error: 'Could not record the signature. Please try again.' });
    }
  }

  // GET /co/<token>: render the document. ?token= with a path-parse fallback
  // for Netlify's :splat quirk; see tokenFromEvent in _pec-supabase.cjs.
  const token = tokenFromEvent(event);
  try {
    const loaded = await loadCo(token);
    if (!loaded || !loaded.co) return notFoundPage();
    const { co, job, customer } = loaded;
    let brand = { ...BRAND_DEFAULTS };
    try {
      const company = (customer && customer.company) || 'prescott-epoxy';
      const biRows = await sb('GET', `/pec_brand_identity?brand=eq.${encodeURIComponent(company)}&select=*&limit=1`);
      if (Array.isArray(biRows) && biRows[0]) brand = { ...BRAND_DEFAULTS, ...biRows[0] };
      else {
        const fallback = await sb('GET', `/pec_brand_identity?brand=eq.prescott-epoxy&select=*&limit=1`);
        if (Array.isArray(fallback) && fallback[0]) brand = { ...BRAND_DEFAULTS, ...fallback[0] };
      }
    } catch (_) { /* brand defaults are fine */ }
    return htmlResponse(200, coPage(co, job, customer, brand));
  } catch (err) {
    console.error('pec-public-change-order error:', err.message);
    return notFoundPage();
  }
};
