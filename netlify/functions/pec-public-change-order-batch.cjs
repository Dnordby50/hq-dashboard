// Public BATCH change-order approval page at /co/batch/<token> (netlify.toml
// rewrites /co/batch/* here, BEFORE the /co/* rule so the single-CO page never
// swallows it), plus the signing POST at /api/co/batch/sign. Sibling of
// pec-public-change-order.cjs: unauthenticated but unguessable (v4 UUID bearer
// token), server-rendered HTML, generic 404 on a miss, noindex/nofollow, no
// client frameworks.
//
// HOW IT WORKS (prompt 31, Dylan's decisions 4/5/7/8/9): the link is one
// STABLE token per job and it is LIVE. A pending batch renders whatever COs
// are pending RIGHT NOW (a CO added after the link was texted simply appears
// on the next open), each as its own stacked section with its own price, plus
// a grand total and ONE signature block that approves them all. Already-signed
// COs on the job render greyed as read-only "already approved" context. The
// signed set is captured AT SIGN TIME: the POST re-reads the job's pending
// COs, records their ids on the batch row (signed_co_ids), and flips exactly
// those to signed. After signing, the page renders the signed document (the
// captured COs + the one signature + their grand total, printable).
//
// Signing is NON-idempotent by design: verify-then-write, no blind retry.
// The batch PATCH is guarded with status=eq.pending and checked for an actual
// row transition, so a replay or a concurrent double-click gets a 409 and can
// never overwrite a recorded signature. The drawn signature lives ONLY on the
// batch row; each covered CO gets signed_name/signed_at/batch_id stamped so
// the dashboard badges read as usual (decision 9).

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
// Same drawn-signature size cap as the single-CO page.
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
    <h1 style="font-size:20px">Change orders not found</h1>
    <p style="color:#475569;font-size:14px">This link is invalid or no longer available. Please contact us if you believe this is an error.</p>
  </div>
</body></html>`);
}

// Fetch the batch row + its job/customer + ALL of the job's CO rows
// (created_at order, so "#N" numbering matches the dashboard card).
// Returns null on any miss.
async function loadBatch(token) {
  if (!UUID_RE.test(String(token || ''))) return null;
  const rows = await sb('GET', `/pec_change_order_batches?token=eq.${encodeURIComponent(token)}&select=*&limit=1`);
  const batch = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!batch) return null;
  let job = null, customer = null, cos = [];
  try {
    const jobs = await sb('GET', `/jobs?id=eq.${encodeURIComponent(batch.job_id)}&select=id,address,price,customer_id,customers(name,company,email,phone)&limit=1`);
    job = Array.isArray(jobs) && jobs[0] ? jobs[0] : null;
    customer = job && job.customers ? job.customers : null;
  } catch (e) { console.error('pec-public-change-order-batch: job fetch failed', e.message); }
  try {
    const coRows = await sb('GET', `/pec_change_order_signatures?job_id=eq.${encodeURIComponent(batch.job_id)}&select=*&order=created_at.asc`);
    cos = Array.isArray(coRows) ? coRows : [];
  } catch (e) { console.error('pec-public-change-order-batch: CO fetch failed', e.message); }
  return { batch, job, customer, cos };
}

// One CO as a stacked document section. num is the CO's 1-based position in
// the job's created_at ordering (same numbering the dashboard card shows).
// greyed renders the read-only "already approved" context style (decision 7).
function coSection(co, num, greyed) {
  // Prompt 78 B2: same treatment as the single CO page. Square footage row
  // gone outright; System and Scope have no per-line equivalent on a change
  // order, so they survive as one-line notes (the estimate page's flake
  // color pattern).
  const scopeNotes = [
    co.system_name ? `<div style="color:#4b5563;font-size:14px;margin-top:4px">System: <strong>${esc(co.system_name)}</strong></div>` : '',
    co.description ? `<div style="color:#4b5563;font-size:14px;margin-top:4px"><strong>Scope:</strong> <span style="white-space:pre-wrap">${esc(co.description)}</span></div>` : '',
  ].filter(Boolean).join('');
  return `
      <div class="cosec${greyed ? ' greyed' : ''}">
        <div class="cosec-h">
          <span>Change Order #${num}: ${esc(co.title)}</span>
          ${greyed ? `<span class="donepill">Already approved${co.signed_at ? ' ' + esc(new Date(co.signed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : ''}</span>` : ''}
        </div>
        <table class="meta">
          <tr><td class="k">Date issued</td><td>${esc(fmtStamp(co.created_at))}</td></tr>
        </table>
        ${scopeNotes}
        <div class="secprice"><span>Change order total</span><strong>${usd(co.amount)}</strong></div>
      </div>`;
}

function batchPage(batch, job, customer, cos, brand) {
  const b = { ...BRAND_DEFAULTS, ...(brand || {}) };
  const logo = b.logo_url || LOGO_URL;
  const numById = {};
  cos.forEach((c, i) => { numById[c.id] = i + 1; });
  const signed = batch.status === 'signed';

  let mainSections, contextSections = '', total = 0, countLine = '', body;
  if (signed) {
    // The signed document: exactly the COs this signature covered (the set
    // captured at sign time), one signature block, their grand total.
    const ids = Array.isArray(batch.signed_co_ids) ? batch.signed_co_ids.map(String) : [];
    const covered = cos.filter(c => ids.includes(String(c.id)));
    total = covered.reduce((s, c) => s + Number(c.amount || 0), 0);
    mainSections = covered.map(c => coSection(c, numById[c.id], false)).join('');
    countLine = `${covered.length} change order${covered.length === 1 ? '' : 's'} approved with one signature`;
  } else {
    // LIVE render: whatever is pending right now signs; signed COs are
    // greyed read-only context.
    const pending = cos.filter(c => c.status !== 'signed');
    const done = cos.filter(c => c.status === 'signed');
    total = pending.reduce((s, c) => s + Number(c.amount || 0), 0);
    mainSections = pending.map(c => coSection(c, numById[c.id], false)).join('');
    contextSections = done.map(c => coSection(c, numById[c.id], true)).join('');
    countLine = pending.length
      ? `${pending.length} change order${pending.length === 1 ? '' : 's'} awaiting your approval`
      : 'No change orders are awaiting approval right now.';
  }
  const hasPending = !signed && cos.some(c => c.status !== 'signed');

  const signedBlock = `
    <div class="sigblock">
      <div class="sig-h">Approved and signed</div>
      ${batch.signature_data ? `<img src="${esc(batch.signature_data)}" alt="Signature" style="max-width:320px;max-height:110px;background:#fff;border-bottom:1px solid #94a3b8;padding:4px 8px">` : ''}
      <div class="sig-name">${esc(batch.signed_name || '')}</div>
      <div class="sig-meta">Signed ${esc(fmtStamp(batch.signed_at))}</div>
      <button class="btn ghost noprint" onclick="window.print()">Print signed copy</button>
    </div>`;

  const signForm = `
    <div class="sigblock noprint" id="signWrap">
      <div class="sig-h">Approve these change orders</div>
      <p style="font-size:13px;color:#475569;margin:6px 0 12px">By signing below you approve every change order listed above and its price. One signature covers all of them, and the total will be added to your invoice.</p>
      <label class="lbl">Type your full name</label>
      <input id="sigName" autocomplete="name" placeholder="Full name">
      <label class="lbl" style="margin-top:12px">Draw your signature</label>
      <canvas id="sigPad" width="560" height="140"></canvas>
      <div style="display:flex;gap:10px;align-items:center;margin-top:6px">
        <button class="btn ghost" type="button" id="sigClear">Clear</button>
        <span id="sigErr" style="color:#dc2626;font-size:13px"></span>
      </div>
      <button class="btn primary" type="button" id="sigGo">Approve &amp; sign all</button>
    </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Change Orders · ${esc(b.business_name)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: Arial, Helvetica, sans-serif; background:#f1f5f9; color:#0f172a; }
  .wrap { max-width:680px; margin:24px auto 60px; padding:0 16px; }
  .doc { background:#fff; border-radius:10px; box-shadow:0 2px 12px rgba(15,23,42,.08); overflow:hidden; }
  .band { background:${esc(b.primary_color)}; color:#fff; padding:18px 26px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  .band .t { font-size:20px; font-weight:700; letter-spacing:.5px; }
  .body { padding:24px 26px; }
  .logo { max-height:44px; }
  .count { font-size:13.5px; color:#475569; margin:10px 0 2px; }
  table.meta { width:100%; border-collapse:collapse; font-size:14px; margin:10px 0 0; }
  table.meta td { padding:7px 0; border-bottom:1px solid #e2e8f0; vertical-align:top; }
  table.meta td.k { color:#64748b; width:150px; font-size:12px; text-transform:uppercase; letter-spacing:.6px; padding-right:12px; }
  .cosec { margin-top:18px; padding:14px 16px; border:1px solid #e2e8f0; border-radius:8px; }
  .cosec-h { font-size:15px; font-weight:700; display:flex; justify-content:space-between; align-items:baseline; gap:10px; flex-wrap:wrap; }
  .cosec .secprice { display:flex; justify-content:space-between; align-items:baseline; margin-top:10px; font-size:14px; color:#334155; }
  .cosec .secprice strong { font-size:17px; color:#0f172a; }
  .cosec.greyed { opacity:.62; background:#f8fafc; }
  .donepill { font-size:11.5px; font-weight:600; color:#15803d; background:#dcfce7; border-radius:20px; padding:3px 10px; white-space:nowrap; }
  .grand { display:flex; justify-content:space-between; align-items:baseline; margin:18px 0 4px; padding:14px 16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; }
  .grand .amt { font-size:24px; font-weight:700; color:${esc(b.accent_color)}; }
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
  @media print { body { background:#fff; } .doc { box-shadow:none; border-radius:0; } .noprint { display:none !important; } .wrap { margin:0; max-width:none; } .cosec { break-inside:avoid; } }
</style></head>
<body>
  <div class="wrap">
    <div class="doc">
      <div class="band"><span class="t">CHANGE ORDERS</span><span style="font-size:13px">${esc(b.business_name)}</span></div>
      <div class="body">
        <img class="logo" src="${esc(logo)}" alt="${esc(b.business_name)}">
        <table class="meta">
          <tr><td class="k">Customer</td><td>${esc((customer && customer.name) || '')}</td></tr>
          ${job && job.address ? `<tr><td class="k">Job address</td><td>${esc(job.address)}</td></tr>` : ''}
        </table>
        <div class="count">${esc(countLine)}</div>
        ${mainSections}
        ${(signed || hasPending) ? `
        <div class="grand"><span style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:.6px">${signed ? 'Approved total' : 'Total you are approving'}</span><span class="amt">${usd(total)}</span></div>
        <div style="font-size:12.5px;color:#64748b">This amount is added to the job's invoice total.</div>` : ''}
        ${signed ? signedBlock : (hasPending ? signForm : '')}
        ${contextSections ? `<div style="margin-top:24px;font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:#64748b">Previously approved</div>${contextSections}` : ''}
      </div>
    </div>
    <div class="foot">${esc(b.business_name)}${b.phone ? ' · ' + esc(b.phone) : ''}${b.license_number ? ' · ROC ' + esc(b.license_number) : ''}</div>
  </div>
${(signed || !hasPending) ? '' : `<script>
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
    fetch('/api/co/batch/sign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ${JSON.stringify(String(batch.token))}, name: name, signature: canvas.toDataURL('image/png') })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j && res.j.error) || 'Could not record the signature.');
        // Reload so the server renders the signed document (the captured CO
        // set + the one signature block), which is also the printable record.
        location.reload();
      })
      .catch(function (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Approve & sign all'; });
  });
})();
<\/script>`}
</body></html>`;
}

exports.handler = async (event) => {
  // POST /api/co/batch/sign: one signature approves every currently-pending
  // CO on the batch's job. Verify-then-write, no blind retry:
  //   1. The pending set is read HERE, at sign time (the link is live, so
  //      this is the moment the covered set is defined).
  //   2. The batch PATCH is guarded with status=eq.pending and checked for an
  //      actual transition, so a replay / concurrent sign gets 409 and can
  //      never overwrite the recorded signature or re-sign anything.
  //   3. Only after the batch row (the signature of record) is safely written
  //      do the covered COs flip to signed. A CO signed some other way in the
  //      meantime is excluded by its own status=eq.pending guard.
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
      const rows = await sb('GET', `/pec_change_order_batches?token=eq.${encodeURIComponent(token)}&select=id,job_id,status&limit=1`);
      const batch = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (!batch) return json(404, { ok: false, error: 'Not found' });
      if (batch.status === 'signed') return json(409, { ok: false, error: 'These change orders are already signed.' });

      // The covered set: the job's currently-pending COs, captured now.
      const pending = await sb('GET', `/pec_change_order_signatures?job_id=eq.${encodeURIComponent(batch.job_id)}&status=eq.pending&select=id&order=created_at.asc`);
      const ids = (Array.isArray(pending) ? pending : []).map(r => r.id);
      if (!ids.length) return json(409, { ok: false, error: 'Nothing is awaiting approval on this link anymore.' });

      const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
      const ua = String(event.headers['user-agent'] || '').slice(0, 300) || null;
      const signedAt = new Date().toISOString();

      // Signature of record first. return=representation + the pending guard:
      // an empty result means another request signed in between; bail with 409
      // WITHOUT touching any CO row.
      const updated = await sb('PATCH', `/pec_change_order_batches?id=eq.${encodeURIComponent(batch.id)}&status=eq.pending`, {
        status: 'signed', signed_co_ids: ids, signed_name: cleanName, signature_data: signature,
        signed_at: signedAt, signer_ip: ip, signer_user_agent: ua,
      }, true);
      if (!Array.isArray(updated) || !updated.length) {
        return json(409, { ok: false, error: 'These change orders are already signed.' });
      }

      // Flip the covered COs. Name/date stamp keeps the dashboard badges
      // working unchanged; the drawn signature stays on the batch only.
      // status=eq.pending re-guard: a CO signed via its own single link in
      // the last instant is left alone. If this flip fails AFTER the batch
      // row landed, still return ok: the signature of record exists and the
      // reload renders the signed document; telling the customer to retry
      // would only get them a confusing "already signed" 409. The loud log
      // line is the staff-side flag that CO badges need a manual look.
      try {
        await sb('PATCH', `/pec_change_order_signatures?id=in.(${ids.map(id => encodeURIComponent(id)).join(',')})&status=eq.pending`, {
          status: 'signed', signed_name: cleanName, signed_at: signedAt,
          signer_ip: ip, signer_user_agent: ua, batch_id: batch.id,
        });
      } catch (flipErr) {
        console.error(`pec-public-change-order-batch: batch ${batch.id} SIGNED but CO flip failed for ids [${ids.join(',')}]:`, flipErr.message);
      }
      return json(200, { ok: true, signed: ids.length });
    } catch (err) {
      console.error('pec-public-change-order-batch sign error:', err.message);
      return json(500, { ok: false, error: 'Could not record the signature. Please try again.' });
    }
  }

  // GET /co/batch/<token>: render the document. Same tokenFromEvent fallback
  // as every public token page (Netlify :splat quirk).
  const token = tokenFromEvent(event);
  try {
    const loaded = await loadBatch(token);
    if (!loaded || !loaded.batch) return notFoundPage();
    const { batch, job, customer, cos } = loaded;
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
    return htmlResponse(200, batchPage(batch, job, customer, cos, brand));
  } catch (err) {
    console.error('pec-public-change-order-batch error:', err.message);
    return notFoundPage();
  }
};
