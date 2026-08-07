// Public customer-facing estimate at /e/<token> (netlify.toml rewrites /e/*
// here with the token in ?token=), plus the action POST at /api/estimate/action.
// Modeled on pec-public-invoice.cjs / pec-public-change-order.cjs: server-
// rendered HTML with no client framework, an unguessable UUID token acting as
// a bearer in the URL, a generic 404 on ANY miss (bad token, unknown token, or
// an estimate that has not been SENT yet -- all three render the identical
// page, so a probe learns nothing), noindex/nofollow, and the voltcoatings-
// inspired PEC look shared with the hosted invoice.
//
// PRIVATE UNTIL SENT (decision 1): the row's sent_at gates the page. The token
// is minted at creation (column default, 2026-07-11 migration) but is inert
// until the dashboard's Send action stamps sent_at.
//
// The customer can do exactly THREE things (decision 2): accept and sign
// (typed name), request changes with a message, or reject with a reason.
// NO payment on this page (decision 3): the deposit lives in the invoice path.
//
// Optional line items are tickable (decision 4); the selection at signature
// time is frozen onto the estimate (selected_by_customer + the final price).
//
// Accepting creates the JOB (decision 5) in BOTH job tables, following
// pec-webhook-proposal-accepted.cjs: public.jobs (+customers, timeline_stages,
// job_areas) for the Jobs page, and pec_prod_jobs (+pec_prod_areas) for the
// Job Schedule calendar.
//
// IDEMPOTENCY: every id this path creates is DETERMINISTIC (a v5-style UUID
// derived from the estimate id), so a double-click, a mobile retry of a timed-
// out POST, or a refresh of the confirmation page can never create a second
// job, customer, or lead event: the retry computes the same ids, finds the
// rows already exist, and reuses them. Every write is existence-checked first
// (never a blind retry of a non-idempotent write, per CLAUDE.md), and the
// status flip itself is a compare-and-swap (PATCH filtered on the current
// status), so exactly one request wins the transition.

const { sb, json, randomToken, tokenFromEvent, epoxyStages } = require('./_pec-supabase.cjs');
const { prepareDepositInstallment, resolveCurrentAsk } = require('./_pec-installments.cjs');
// Estimate-side payment schedule (prompt 74): the same math module the
// estimator's schedule card runs, so the customer render, the accept-time
// freeze, and the rep's card can never disagree about a dollar.
const {
  computeScheduleCents,
  freezeSchedule,
  scheduleValidationError,
  triggerLabel,
} = require('../../production/estimate-installments.cjs');
const { loadFinancingSettings, financingBlockHtml } = require('./_pec-financing.cjs');
const { maybeCreateBusybusyProject } = require('./_pec-busybusy.cjs');
// Optional-lines rules (prompt 72): the same module the estimator bundles,
// so the accept guard and the job-side filters share one implementation.
const {
  acceptSelectionInvalid,
  declinedAreaIdSet,
  filterAreasForJob,
  isDeclinedLine,
  declinedNoteLine,
  selectedScopeDoc,
} = require('../../production/optional-lines.cjs');
const crypto = require('crypto');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SLACK_OFFICE_WEBHOOK = process.env.SLACK_OFFICE_WEBHOOK;
const OFFICE_NOTIFY_EMAIL = process.env.OFFICE_NOTIFY_EMAIL || '';
const SITE_URL = process.env.URL || 'https://prescottepoxy.netlify.app';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Validate a staff access token for the authenticated PREVIEW route (the
// public estimate routes are token-based and unauthenticated; preview is not).
// Same pattern as pec-estimate-ai.cjs.
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

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => (Number(n) < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtStamp = (s) => s ? new Date(s).toLocaleString('en-US', { timeZone: 'America/Phoenix', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BRAND_DEFAULTS = {
  logo_url: null, primary_color: '#14181C', accent_color: '#D8531C',
  business_name: 'Prescott Epoxy Company', address_line: '', phone: '',
  license_number: '', website: '',
  // Estimate terms and conditions (prompt 74): per-brand, edited in Settings.
  // Empty = the terms card does not render at all (FTP until Dylan writes it).
  estimate_terms_text: '',
};
const LOGO_URL = '/assets/pec-logo.png';

// Deterministic v5-style UUID (sha1, version + variant bits set) namespaced to
// this accept path. THE idempotency anchor: retries of the same estimate's
// accept always compute the same job/customer/event ids, so an existence check
// by id is a complete duplicate guard even if a prior attempt crashed between
// writes (nothing depends on state the crash could have lost).
function deterministicUuid(name) {
  const h = crypto.createHash('sha1').update('pec-estimate-accept:' + name).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// The one line-items money rule, mirroring estimateLineItemsTotal in
// index.html: optional lines count ONLY when selected_by_customer. Line items
// are estimate_line_items ROWS since 2026-07-13 (is_optional); the legacy
// jsonb key (optional) is still honored so nothing breaks mid-deploy.
const isOptionalLine = (li) => !!li && (li.is_optional === true || li.optional === true);
function includedTotal(items) {
  return (Array.isArray(items) ? items : []).reduce((sum, li) => {
    if (!li) return sum;
    if (isOptionalLine(li) && !li.selected_by_customer) return sum;
    const t = Number(li.total);
    return sum + (Number.isFinite(t) ? t : 0);
  }, 0);
}

// Freeze the customer's optional-item selection at signature time (decision 4):
// required lines are untouched, each optional line's selected_by_customer is
// set from the ids the customer had ticked when they signed. Pure; the DB rows
// are patched separately by applySelection (winner-only, after the CAS).
function freezeLineItems(items, selectedIds) {
  const sel = new Set(Array.isArray(selectedIds) ? selectedIds.map(String) : []);
  return (Array.isArray(items) ? items : []).map(li => {
    if (!isOptionalLine(li)) return li;
    return { ...li, selected_by_customer: sel.has(String(li.id)) };
  });
}

// Write the signed selection onto the estimate_line_items rows. Idempotent
// (absolute values per row) and driven by the signature's frozen id list, so
// the accept-heal path can re-apply it after any crash. Only OPTIONAL rows are
// touched; scoped to the estimate so a stray id cannot reach another estimate.
async function applySelection(estimateId, items, selectedIds) {
  const sel = new Set(Array.isArray(selectedIds) ? selectedIds.map(String) : []);
  for (const li of (Array.isArray(items) ? items : [])) {
    if (!isOptionalLine(li)) continue;
    const want = sel.has(String(li.id));
    if (li.selected_by_customer === want) continue;
    await sb('PATCH',
      `/estimate_line_items?id=eq.${encodeURIComponent(li.id)}&estimate_id=eq.${encodeURIComponent(estimateId)}`,
      { selected_by_customer: want });
  }
}

// Escape-then-format: the scope document is model-assembled markdown, and it
// NEVER reaches the page as raw HTML. esc() runs FIRST, then a minimal, safe
// subset of markdown (headings, bold, bullets, rules) is rebuilt from the
// escaped text, so no model or user input can smuggle markup in.
function mdToSafeHtml(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const out = [];
  let list = null;
  const flushList = () => { if (list) { out.push(`<ul style="margin:6px 0 10px;padding-left:20px">${list.join('')}</ul>`); list = null; } };
  const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-*]\s+/.test(line)) {
      (list ??= []).push(`<li style="margin:2px 0">${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    if (/^---+$/.test(line.trim())) { out.push('<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">'); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push(`<div style="font-weight:800;font-size:${h[1].length <= 2 ? '15px' : '13.5px'};margin:14px 0 6px">${inline(h[2])}</div>`); continue; }
    out.push(`<p style="margin:6px 0">${inline(line)}</p>`);
  }
  flushList();
  return out.join('');
}

const estimateNo = (est) => est && est.estimate_number != null ? `EST-${est.estimate_number}` : 'Estimate';
const phoenixToday = () => new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);

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

// Generic 404: identical for a malformed token, an unknown token, and a real
// but UNSENT estimate, so nothing about the miss leaks.
function notFoundPage() {
  return htmlResponse(404, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Estimate not found</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"></head>
<body style="margin:0;font-family:'Inter',-apple-system,'Segoe UI',Arial,sans-serif;background:#f4f5f7;color:#14181C">
  <div style="max-width:520px;margin:80px auto;padding:0 20px">
    <div style="background:#fff;border-radius:16px;box-shadow:0 1px 2px rgba(16,24,40,.05),0 8px 24px rgba(16,24,40,.06);padding:34px 32px;text-align:center">
      <div style="font-size:11px;font-weight:800;letter-spacing:2.2px;text-transform:uppercase;color:#D8531C;margin-bottom:10px">Estimate</div>
      <h1 style="margin:0 0 10px;font-size:22px;font-weight:800;letter-spacing:-.01em">Estimate not found</h1>
      <p style="margin:0;color:#6b7280;font-size:14.5px;line-height:1.6">This link is invalid or has expired. If you believe this is a mistake, please contact Prescott Epoxy Company at (928) 800-8154.</p>
    </div>
  </div>
</body></html>`);
}

// ---------------------------------------------------------------------------
// Page render
// ---------------------------------------------------------------------------

function scopeRowsHtml(est, sysName, totalSqft) {
  const mvbLabel = est.mvb === 'standalone' ? 'Moisture vapor barrier (standalone)'
    : est.mvb === 'addon' ? 'Included' : null;
  const systemLabel = sysName || (est.mvb === 'standalone' ? 'Moisture vapor barrier (MVB)' : null);
  const rows = [
    systemLabel ? ['System', esc(systemLabel)] : null,
    totalSqft > 0 ? ['Square footage', esc(Math.round(totalSqft).toLocaleString('en-US')) + ' sq ft'] : null,
    mvbLabel ? ['Moisture vapor barrier', esc(mvbLabel)] : null,
    est.flake_color ? ['Flake color', esc(est.flake_color)] : null,
  ].filter(Boolean);
  return rows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${v}</td></tr>`).join('');
}

// The sqft subtitle under a line's label (prompt 74 A2): derived from the
// line's AREA row (no new column; description is scope-only now). Customer-
// facing form is "970 sq ft" with the space, plus the MVB note when that area
// carries a barrier (the MVB-only system hides its per-area checkbox, so its
// mvb flag stays false and no redundant note prints). Lines with no area
// (add-ons, the whole-estimate custom line) get no subtitle.
function liSubtitleHtml(li, areaById) {
  const area = li && li.estimate_area_id && areaById ? areaById.get(li.estimate_area_id) : null;
  if (!area) return '';
  const parts = [];
  const sqft = Number(area.sqft);
  if (Number.isFinite(sqft) && sqft > 0) parts.push(`${Math.round(sqft).toLocaleString('en-US')} sq ft`);
  if (area.mvb === true) parts.push('includes moisture vapor barrier (MVB)');
  if (!parts.length) return '';
  return `<div class="subtl">${esc(parts.join(', '))}</div>`;
}

// The per-line description is the AI-assembled scope of work (markdown),
// rendered through mdToSafeHtml (escape-then-format) so it reads like the
// DripJobs proposal under each line and can never inject markup.
// Prompt 74 A3: EXPANDED by default inside a native <details open> with a
// CSS-only collapse control (no JS: the scope must be readable with scripts
// disabled and must never depend on the optional-lines script). A line with
// no description renders NO details element at all, so there is never an
// empty caret. Long scopes are never capped; the customer asked for all of it.
const liDescHtml = (li) => li.description ? `
          <details class="scopefold" open>
            <summary><span class="fold-open">&#9662; Tap to collapse</span><span class="fold-closed">&#9656; Tap to expand</span></summary>
            <div class="desc">${mdToSafeHtml(li.description)}</div>
          </details>` : '';

// "Your project" (prompt 72 D1): required lines PLUS pre-selected optional
// lines. A required line has NO control at all (not a disabled checkbox; a
// disabled checkbox invites a support call). A pre-selected optional line is
// part of the job the customer reads, with a ticked .opt-toggle and a small
// Optional tag; unticking removes it from the total live through the same
// script the add-on cards use.
function lineItemRowsHtml(items, readOnly, areaById) {
  const list = Array.isArray(items) ? items : [];
  const shown = list.filter(li => li && (!isOptionalLine(li) || li.selected_by_customer === true));
  const row = (li) => {
    const optional = isOptionalLine(li);
    const control = optional
      ? `<input type="checkbox" class="opt-toggle" data-li-id="${esc(li.id)}" data-li-total="${Number(li.total) || 0}" checked ${readOnly ? 'disabled' : ''} style="width:18px;height:18px;flex:0 0 auto;margin-top:2px;accent-color:#D8531C">`
      : '';
    const tag = optional
      ? ' <span style="font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#D8531C;border:1px solid #D8531C;border-radius:999px;padding:1px 7px;vertical-align:2px">Optional</span>'
      : '';
    return `<tr>
      <td><div style="display:flex;gap:10px;align-items:flex-start">${control}<div style="flex:1;min-width:0"><span style="font-weight:700">${esc(li.label || '')}</span>${tag}${liSubtitleHtml(li, areaById)}${liDescHtml(li)}</div></div></td>
      <td>${usd(li.total)}</td>
    </tr>`;
  };
  return shown.length ? shown.map(row).join('')
    : '<tr><td colspan="2" style="padding:14px 12px;color:#6b7280;text-align:center">No line items.</td></tr>';
}

// "Options to add" (prompt 72 D1): optional lines that start UNSELECTED
// (add-ons keep their opt-in behavior, plus any area line the rep set to
// start unselected). Same .opt-toggle inputs and data attributes as always,
// so the tick-to-update script and the signature freeze are untouched.
function optionalCardsHtml(items, readOnly, areaById) {
  const optional = (Array.isArray(items) ? items : []).filter(li => isOptionalLine(li) && li.selected_by_customer !== true);
  if (!optional.length) return '';
  const card = (li) => `
      <label class="optcard" style="cursor:${readOnly ? 'default' : 'pointer'}">
        <input type="checkbox" class="opt-toggle" data-li-id="${esc(li.id)}" data-li-total="${Number(li.total) || 0}" ${li.selected_by_customer ? 'checked' : ''} ${readOnly ? 'disabled' : ''} style="margin-top:3px;width:19px;height:19px;flex:0 0 auto;accent-color:#D8531C">
        <span style="flex:1;min-width:0"><span style="font-weight:700">${esc(li.label || '')}</span>${liSubtitleHtml(li, areaById)}${liDescHtml(li)}</span>
        <span style="font-weight:800;white-space:nowrap;font-variant-numeric:tabular-nums">${usd(li.total)}</span>
      </label>`;
  return `
        <div style="margin-top:24px">
          <div class="eyebrow">Options to add</div>
          <div style="color:#6b7280;font-size:13px;margin-top:3px">${readOnly ? 'These items were offered and not selected.' : 'Tick any you would like to add. The total updates as you choose.'}</div>
          <div style="display:grid;gap:12px;margin-top:12px">${optional.map(card).join('')}</div>
        </div>`;
}

// Status banner + whether the action buttons render. accepted / rejected /
// lost are terminal: a signed document must not be re-signable.
function stateForStatus(est, payCta) {
  if (est.status === 'accepted') {
    // Prompt 74 Part E: right after signing, offer the deposit payment. The
    // link is the EXISTING pay page (/pay/<job token>); the amount there is
    // resolved server-side by resolveCurrentAsk at click time, card and ACH,
    // no surcharge, exactly like every other payment. A plain link, never an
    // auto-redirect, and skipping is fine (the deposit stays planned and
    // staff send it normally). Absent when the accept created no deposit row.
    const payHtml = payCta
      ? `<div style="margin-top:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><a class="btn accent noprint" href="${esc(payCta.url)}">Pay your ${usd(payCta.amount)} deposit now</a><span style="font-size:13px;color:#14532d">Card or bank transfer (ACH), no card fees. Prefer to wait? We will send your invoice.</span></div>`
      : '';
    return {
      live: false,
      banner: `<div class="banner ok"><strong>Accepted and signed${est.signed_name ? ' by ' + esc(est.signed_name) : ''}</strong>${est.signed_at ? ' on ' + esc(fmtStamp(est.signed_at)) : ''}. We will be in touch to schedule your project. You can print or save this page for your records.${payHtml}</div>`,
    };
  }
  if (est.status === 'rejected') {
    return {
      live: false,
      banner: `<div class="banner muted"><strong>This estimate was declined${est.rejected_at ? ' on ' + esc(fmtStamp(est.rejected_at)) : ''}.</strong> If you change your mind, call us at (928) 800-8154 and we will be glad to help.</div>`,
    };
  }
  if (est.status === 'lost') {
    return {
      live: false,
      banner: `<div class="banner muted"><strong>This estimate is no longer active.</strong> Please contact us at (928) 800-8154 for a current quote.</div>`,
    };
  }
  if (est.status === 'change_requested') {
    return {
      live: true,
      changePending: true,
      banner: `<div class="banner warn"><strong>We received your change request.</strong> We are working on an updated estimate and will send it shortly. You can still accept or decline the estimate as shown below.</div>`,
    };
  }
  return { live: true, banner: '' };
}

// Split-first customer identity (build 23): prefer the split columns the
// estimator now writes, fall back to the composed customer_name /
// customer_address safety nets (which every save keeps current, so a row
// from before the split still renders). Commercial = has a company name.
function customerDisplay(est) {
  const t = (v) => (v == null ? '' : String(v).trim());
  const company = t(est.customer_company);
  const contact = [t(est.customer_first_name), t(est.customer_last_name)].filter(Boolean).join(' ');
  const splitAddress = [
    t(est.customer_address1), t(est.customer_address2),
    t(est.customer_city), t(est.customer_state), t(est.customer_zip),
  ].filter(Boolean).join(', ');
  return {
    company: company || null,
    contact: contact || null,
    // The bold "Prepared for" line: the company when commercial, else the person.
    name: company || contact || t(est.customer_name) || null,
    address: splitAddress || t(est.customer_address) || null,
  };
}

function estimatePage(est, brand, sysName, totalSqft, opts) {
  const b = { ...BRAND_DEFAULTS, ...(brand || {}) };
  const biz = b.business_name || 'Prescott Epoxy Company';
  const logoUrl = b.logo_url || LOGO_URL;
  const primary = esc(b.primary_color);
  const accent = esc(b.accent_color);
  const state = stateForStatus(est, opts && opts.acceptedPay);
  const who = customerDisplay(est);
  // Area lookup for the per-line sqft subtitles (prompt 74 A2).
  const areaById = new Map((Array.isArray(opts && opts.areas) ? opts.areas : []).map(a => [a.id, a]));
  // PREVIEW MODE (15c): staff sees the EXACT customer page from this same
  // renderer, but nothing is live. interactive gates the client script + the
  // enabled controls, so a preview carries NO public token and NO working
  // actions (buttons render disabled). Faithful preview or none.
  const preview = !!(opts && opts.preview);
  const interactive = state.live && !preview;
  const items = Array.isArray(est.line_items) ? est.line_items : [];
  const total = (interactive || preview) ? includedTotal(items) : Number(est.price || includedTotal(items));

  // Payment schedule (prompt 74 C4). On a LIVE or preview page the rows come
  // from estimate_installments and resolve against the current selection's
  // total (percent rows recompute as options are ticked, via the same
  // .opt-toggle script that already updates the totals). On an ACCEPTED page
  // the FROZEN record in the signature renders verbatim: that is what the
  // customer agreed to, and it never recomputes again. A schedule that fails
  // validation is not rendered (the send gate blocks that state; this guards
  // a legacy row) and is logged.
  const instRows = Array.isArray(opts && opts.installments) ? opts.installments : [];
  const frozenSchedule = est.status === 'accepted' && est.signature && Array.isArray(est.signature.schedule) && est.signature.schedule.length
    ? est.signature.schedule : null;
  let scheduleView = null;
  if (frozenSchedule) {
    scheduleView = frozenSchedule.map((r) => ({
      label: r.label || (r.is_deposit ? 'Deposit' : 'Installment'),
      due: triggerLabel(r.trigger_kind, r.due_date),
      cents: Math.round((Number(r.computed_amount) || 0) * 100),
      kind: r.amount_kind === 'fixed' ? 'fixed' : 'percent',
      value: Number(r.amount_value) || 0,
      frozen: true,
    }));
  } else if (instRows.length && (interactive || preview)) {
    const totalCents = Math.round(total * 100);
    const invalid = scheduleValidationError(instRows, totalCents);
    if (invalid) {
      console.warn('public-estimate: schedule skipped (does not resolve to the total):', invalid.message);
    } else {
      const cents = computeScheduleCents(instRows, totalCents);
      scheduleView = instRows.map((r, i) => ({
        label: r.label || (r.is_deposit ? 'Deposit' : 'Installment'),
        due: triggerLabel(r.trigger_kind, r.due_date),
        cents: cents[i] || 0,
        kind: r.amount_kind === 'fixed' ? 'fixed' : 'percent',
        value: Number(r.amount_value) || 0,
        frozen: false,
      }));
    }
  }
  const lastSched = scheduleView && scheduleView.length ? scheduleView[scheduleView.length - 1] : null;
  const schedAttrs = (r) => r.frozen ? '' : ` data-sched-kind="${esc(r.kind)}" data-sched-value="${Number(r.value) || 0}" data-sched-orig="${r.cents}"`;
  const scheduleBlock = !scheduleView ? '' : `
        <div style="margin-top:26px">
          <div class="eyebrow">Payment schedule</div>
          <table class="sched">
            ${scheduleView.map((r, i) => `<tr${i === scheduleView.length - 1 ? ' class="last"' : ''}>
              <td><div style="font-weight:${i === scheduleView.length - 1 ? '800' : '600'}">${esc(r.label)}</div><div class="subtl">${esc(r.due)}</div></td>
              <td class="amt"${schedAttrs(r)}>${usd(r.cents / 100)}</td>
            </tr>`).join('')}
          </table>
          ${frozenSchedule
            ? `<div style="color:#6b7280;font-size:12.5px;margin-top:6px">This is the schedule you agreed to at signing.</div>`
            : `<div style="color:#6b7280;font-size:12.5px;margin-top:6px">Amounts update with the options you choose above.</div>`}
        </div>`;

  // Terms and conditions (prompt 74 D2): per-brand text in a fixed-height
  // scrollable box ABOVE the signature, expanded fully in print. No card at
  // all when the brand has no terms text yet.
  const termsBlock = b.estimate_terms_text && String(b.estimate_terms_text).trim() ? `
    <div class="card pad" style="margin-top:18px">
      <div class="eyebrow">Terms and Conditions</div>
      <div class="termsbox">${mdToSafeHtml(b.estimate_terms_text)}</div>
    </div>` : '';

  const invNoTxt = estimateNo(est);
  const pillMeta = est.status === 'accepted' ? ['#16a34a', 'Accepted']
    : est.status === 'rejected' ? ['#64748b', 'Declined']
    : est.status === 'lost' ? ['#64748b', 'Inactive']
    : est.status === 'change_requested' ? ['#b45309', 'Changes requested']
    : ['#334155', 'For your review'];

  const actions = !(state.live || preview) ? '' : `
    <div class="card pad" style="margin-top:18px" id="actionsCard">
      <div class="eyebrow">Your decision</div>
      <h3 class="sec">Ready to move forward?</h3>
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">
        <button type="button" class="btn accent" id="btnAccept"${preview ? ' disabled' : ''}>Accept &amp; sign</button>
        ${state.changePending ? '' : `<button type="button" class="btn ink" id="btnChange"${preview ? ' disabled' : ''}>Request changes</button>`}
        <button type="button" class="btn ghost" id="btnReject"${preview ? ' disabled' : ''}>Decline</button>
      </div>
      ${preview ? '<div style="margin-top:12px;color:#6b7280;font-size:13px">These buttons are live for the customer. In this preview they are disabled.</div>' : ''}

      <div id="panelAccept" class="panel" style="display:none">
        <div style="font-weight:700;margin-bottom:6px">Accept this estimate</div>
        <div style="font-size:13.5px;color:#6b7280;line-height:1.6;margin-bottom:12px">By typing your name and signing, you accept this estimate for the total shown above, which reflects the items you have selected. We will contact you to schedule the work and arrange the deposit.</div>
        <label class="lbl">Type your full name as your signature</label>
        <input id="sigName" autocomplete="name" placeholder="Full name" maxlength="120">
        <div id="sigPreview" style="font-family:'Snell Roundhand','Segoe Script',cursive;font-size:26px;min-height:34px;margin-top:8px;border-bottom:1.5px solid #94a3b8;max-width:360px;padding:2px 6px"></div>
        <button type="button" class="btn accent" id="goAccept" style="margin-top:16px">Sign &amp; accept for <span id="acceptTotal">${usd(total)}</span></button>
      </div>

      <div id="panelChange" class="panel" style="display:none">
        <div style="font-weight:700;margin-bottom:6px">Request changes</div>
        <label class="lbl">What would you like changed?</label>
        <textarea id="changeNote" rows="4" maxlength="2000" placeholder="Tell us what you'd like adjusted (scope, areas, options, price...)"></textarea>
        <button type="button" class="btn ink" id="goChange" style="margin-top:14px">Send change request</button>
      </div>

      <div id="panelReject" class="panel" style="display:none">
        <div style="font-weight:700;margin-bottom:6px">Decline this estimate</div>
        <label class="lbl">Mind telling us why? It helps us improve.</label>
        <textarea id="rejectReason" rows="3" maxlength="2000" placeholder="Reason (optional but appreciated)"></textarea>
        <button type="button" class="btn ghost" id="goReject" style="margin-top:14px;border-color:#dc2626;color:#dc2626">Decline estimate</button>
      </div>

      <div id="actionErr" style="margin-top:12px;font-size:13.5px;font-weight:600;color:#dc2626"></div>
    </div>`;

  const signedBlock = est.status !== 'accepted' ? '' : `
    <div class="card pad" style="margin-top:18px">
      <div class="eyebrow">Signature</div>
      <h3 class="sec">Signed</h3>
      <div style="font-family:'Snell Roundhand','Segoe Script',cursive;font-size:28px;border-bottom:1.5px solid #94a3b8;max-width:360px;padding:2px 6px">${esc(est.signed_name || '')}</div>
      <div style="color:#6b7280;font-size:13px;margin-top:8px">${esc(est.signed_name || '')}${est.signed_at ? ' &middot; ' + esc(fmtStamp(est.signed_at)) : ''}</div>
    </div>`;

  // Financing (prompt 58 Part F): between the total and the accept panel,
  // where a customer hesitating on price is looking. '' unless
  // financing_enabled is on and the total clears financing_min_amount, and
  // the interpolation below sits flush against signedBlock so the disabled
  // state renders byte-identical to the pre-financing page.
  const financingBlock = financingBlockHtml(opts && opts.financing, total, { accent: b.accent_color });

  return htmlResponse(200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Estimate ${esc(invNoTxt)} &middot; ${esc(biz)}</title>
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
  .pill { display:inline-block; background:${esc(pillMeta[0])}; color:#fff; font-size:11px; font-weight:800; letter-spacing:1.2px; text-transform:uppercase; border-radius:999px; padding:6px 14px; white-space:nowrap; }
  .hero { background:${primary}; color:#fff; padding:30px; display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:20px; }
  .hero .big { font-size:34px; font-weight:800; letter-spacing:-.02em; line-height:1.05; }
  .hero .sub { color:rgba(255,255,255,.62); font-size:13px; margin-top:8px; }
  .hero .right { text-align:right; }
  .lbl { display:block; font-size:11px; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:#98a1ad; margin-bottom:6px; }
  .grid2 { display:flex; flex-wrap:wrap; gap:22px; margin-bottom:24px; font-size:14.5px; }
  .grid2 > div { flex:1; min-width:200px; }
  table.li { width:100%; border-collapse:collapse; font-size:14.5px; font-variant-numeric:tabular-nums; }
  table.li th { text-align:left; padding:0 12px 10px; font-size:11px; font-weight:800; letter-spacing:1.8px; text-transform:uppercase; color:#98a1ad; border-bottom:2px solid ${primary}; }
  table.li td { padding:14px 12px; border-bottom:1px solid #eef0f3; vertical-align:top; line-height:1.5; }
  table.li th:last-child, table.li td:last-child { text-align:right; width:130px; white-space:nowrap; }
  .desc { color:#6b7280; font-size:13px; margin-top:4px; line-height:1.5; white-space:pre-wrap; font-weight:400; }
  .subtl { color:#6b7280; font-size:12.5px; margin-top:2px; font-weight:400; }
  details.scopefold { margin-top:6px; }
  details.scopefold summary { list-style:none; cursor:pointer; font-size:10.5px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:${accent}; -webkit-user-select:none; user-select:none; }
  details.scopefold summary::-webkit-details-marker { display:none; }
  details.scopefold .fold-closed { display:none; }
  details.scopefold:not([open]) .fold-closed { display:inline; }
  details.scopefold:not([open]) .fold-open { display:none; }
  table.sched { width:100%; border-collapse:collapse; font-size:14.5px; font-variant-numeric:tabular-nums; margin-top:8px; }
  table.sched td { padding:10px 0; border-bottom:1px solid #eef0f3; vertical-align:top; }
  table.sched td.amt { text-align:right; width:130px; white-space:nowrap; font-weight:600; }
  table.sched tr.last td { border-bottom:none; }
  table.sched tr.last td.amt { font-weight:800; color:${accent}; }
  .balline { text-align:right; margin-top:8px; font-size:14.5px; color:#374151; font-variant-numeric:tabular-nums; }
  .balline strong { color:${accent}; font-weight:800; }
  .termsbox { max-height:260px; overflow-y:auto; border:1px solid #e5e7eb; border-radius:10px; padding:14px 16px; font-size:13.5px; color:#374151; line-height:1.65; }
  .optcard { display:flex; gap:12px; align-items:flex-start; border:1.5px solid #e5e7eb; border-radius:12px; padding:14px 16px; background:#fff; transition:border-color .15s, box-shadow .15s; }
  .optcard:has(.opt-toggle:checked) { border-color:${accent}; box-shadow:0 0 0 1px ${accent}; }
  table.scope { width:100%; border-collapse:collapse; font-size:14.5px; }
  table.scope td { padding:9px 0; border-bottom:1px solid #eef0f3; vertical-align:top; }
  table.scope td.k { color:#6b7280; width:180px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:1.8px; padding-right:12px; }
  table.tot { width:100%; border-collapse:collapse; font-size:14.5px; font-variant-numeric:tabular-nums; margin-top:10px; }
  table.tot td { padding:5px 12px; }
  table.tot td:first-child { text-align:right; color:#6b7280; }
  table.tot td:last-child { text-align:right; width:130px; white-space:nowrap; }
  table.tot tr.total td { border-top:2px solid ${primary}; padding-top:12px; font-size:19px; font-weight:800; color:${primary}; }
  table.tot tr.total td:last-child { color:${accent}; }
  .btn { display:inline-block; border:0; border-radius:10px; padding:14px 24px; font-family:inherit; font-size:15px; font-weight:700; cursor:pointer; text-decoration:none; transition:filter .15s; }
  .btn:hover { filter:brightness(.9); }
  .btn:disabled { opacity:.55; cursor:default; }
  .btn.accent { background:${accent}; color:#fff; }
  .btn.ink { background:${primary}; color:#fff; }
  .btn.ghost { background:#fff; border:1.5px solid ${primary}; color:${primary}; }
  .panel { display:none; margin-top:20px; border-top:1px solid #eef0f3; padding-top:20px; }
  .panel input, .panel textarea { width:100%; max-width:460px; padding:11px 13px; font-size:15px; font-family:inherit; border:1px solid #cbd5e1; border-radius:8px; }
  .banner { border-radius:12px; padding:14px 18px; margin-bottom:18px; font-weight:500; font-size:14px; line-height:1.6; }
  .banner.ok { background:#f0fdf4; border:1px solid #16a34a; color:#14532d; }
  .banner.warn { background:#fffbeb; border:1px solid #f59e0b; color:#92400e; }
  .banner.muted { background:#f8fafc; border:1px solid #cbd5e1; color:#334155; }
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
    /* A printed or saved-PDF estimate always carries the FULL scope with no
       caret furniture, even if the customer collapsed a line on screen. */
    details.scopefold { display:block; }
    details.scopefold > *:not(summary) { display:block !important; }
    details.scopefold summary { display:none; }
    /* And the full terms, never scrolled off. */
    .termsbox { max-height:none; overflow:visible; }
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
  ${preview ? `<div style="position:sticky;top:0;z-index:10;background:${accent};color:#fff;text-align:center;padding:10px 16px;font-size:13.5px;font-weight:700;letter-spacing:.02em">PREVIEW &middot; this is exactly what the customer will see. It has not been sent, and the buttons are disabled.</div>` : ''}
  <div class="wrap">
    ${preview ? '' : state.banner}
    <div class="card">
      <div class="topbar">
        <img src="${esc(logoUrl)}" alt="${esc(biz)}">
        <span class="pill">${esc(pillMeta[1])}</span>
      </div>
      <div class="hero">
        <div>
          <div class="eyebrow">${esc(biz)}</div>
          <div class="big">Estimate ${esc(invNoTxt)}</div>
          ${est.sent_at ? `<div class="sub">Sent ${esc(fmtStamp(est.sent_at))}</div>` : ''}
        </div>
        <div class="right">
          <div class="eyebrow">${(state.live || preview) ? 'Your total' : 'Total'}</div>
          <div class="big" id="heroTotal">${usd(total)}</div>
          ${interactive ? '<div class="sub">Updates as you tick optional items</div>' : ''}
        </div>
      </div>
      <div class="pad">
        <div class="grid2">
          <div><span class="lbl">Prepared for</span><div style="font-weight:700">${esc(who.name || '')}</div>${who.company && who.contact ? `<div style="color:#4b5563;margin-top:2px">Attn: ${esc(who.contact)}</div>` : ''}${who.address ? `<div style="color:#4b5563;margin-top:2px">${esc(who.address)}</div>` : ''}</div>
          <div><span class="lbl">Estimate</span><div style="color:#4b5563">${esc(invNoTxt)}${est.sent_at ? ' &middot; sent ' + esc(fmtStamp(est.sent_at)) : ''}</div></div>
        </div>
        <div class="eyebrow">Scope of work</div>
        <table class="scope">${scopeRowsHtml(est, sysName, totalSqft)}</table>
        ${/* Prompt 74 A4: the whole-document scope render is GONE. The scope
             lives under each line now (decision 3); estimates.scope_of_work
             stays the internal record feeding the job, the crew scope, and
             the declined-line filter, and is never rendered here again. */''}
        <div class="eyebrow" style="margin-top:26px">Your project</div>
        <table class="li">
          <thead><tr><th>Item</th><th style="text-align:right">Amount</th></tr></thead>
          <tbody>${lineItemRowsHtml(items, !interactive, areaById)}</tbody>
        </table>
        ${optionalCardsHtml(items, !interactive, areaById)}
        ${/* "Your investment" (prompt 74 F6). No tax row: estimates carries no
             tax concept, so none is invented and none is hardcoded at $0. */''}
        <div class="eyebrow" style="margin-top:26px">Your investment</div>
        <table class="tot">
          <tr><td>Subtotal</td><td id="subTotal">${usd(total)}</td></tr>
          <tr class="total"><td>Project total</td><td id="grandTotal">${usd(total)}</td></tr>
        </table>
        ${lastSched ? `<div class="balline">${esc(lastSched.label)} (${esc(lastSched.due.toLowerCase())}): <strong id="balCompletion">${usd(lastSched.cents / 100)}</strong></div>` : ''}
        ${scheduleBlock}
      </div>
    </div>

    ${financingBlock}${termsBlock}${signedBlock}
    ${actions}
    ${literatureBlockHtml(opts && opts.literature, b.accent_color)}

    <div class="noprint" style="text-align:center;margin-top:24px">
      <button class="printbtn" onclick="window.print()">Print / Save as PDF</button>
    </div>
    <div class="footerband">
      <div class="rule"></div>
      <div class="bizname">${esc(biz)}</div>
      <div class="meta">${[b.address_line, b.phone, b.license_number ? 'License ' + b.license_number : ''].filter(Boolean).map(esc).join(' &middot; ')}</div>
    </div>
  </div>
${!interactive ? '' : `<script>
(function(){
  var TOKEN=${JSON.stringify(String(est.public_token))};
  var money=function(n){return '$'+(Number(n)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});};
  var toggles=Array.prototype.slice.call(document.querySelectorAll('.opt-toggle'));
  var baseTotal=${JSON.stringify(includedTotal(items.filter(li => li && !isOptionalLine(li))))};
  function currentTotal(){
    var t=baseTotal;
    toggles.forEach(function(cb){ if(cb.checked) t+=Number(cb.getAttribute('data-li-total'))||0; });
    return Math.round(t*100)/100;
  }
  function selectedIds(){
    return toggles.filter(function(cb){return cb.checked;}).map(function(cb){return cb.getAttribute('data-li-id');});
  }
  // Payment-schedule live recompute (prompt 74 C4): a CLIENT MIRROR of
  // computeScheduleCents in production/estimate-installments.cjs; keep the
  // two in lockstep (the pecInstallmentAsk convention). Percent rows scale
  // with the new total, fixed rows hold, the LAST row absorbs the remainder,
  // and a fixed row bigger than the shrunken total re-allocates the whole
  // schedule as proportions of the original. Never a negative installment;
  // the rows always sum to the displayed total exactly, in cents.
  var schedCells=Array.prototype.slice.call(document.querySelectorAll('td.amt[data-sched-kind]'));
  function schedRecalc(totalCents){
    var rows=schedCells.map(function(c){return {kind:c.getAttribute('data-sched-kind'),value:Number(c.getAttribute('data-sched-value'))||0,orig:Number(c.getAttribute('data-sched-orig'))||0};});
    if(!rows.length) return [];
    var out=rows.map(function(r){return Math.round(r.kind==='percent'?totalCents*r.value/100:Math.round(r.value*100));});
    var others=0; for(var i=0;i<out.length-1;i++) others+=out[i];
    var last=totalCents-others;
    if(last>=0){ out[out.length-1]=last; return out; }
    var wsum=0; var weights=rows.map(function(r){var w=Math.max(0,r.orig); wsum+=w; return w;});
    if(!wsum){ out=rows.map(function(){return 0;}); out[out.length-1]=totalCents; return out; }
    out=weights.map(function(w){return Math.floor(totalCents*w/wsum);});
    var sum=0; out.forEach(function(c){sum+=c;});
    out[out.length-1]+=totalCents-sum;
    return out;
  }
  function refresh(){
    var total=currentTotal();
    var t=money(total);
    document.getElementById('heroTotal').textContent=t;
    document.getElementById('grandTotal').textContent=t;
    var st=document.getElementById('subTotal'); if(st) st.textContent=t;
    var at=document.getElementById('acceptTotal'); if(at) at.textContent=t;
    if(schedCells.length){
      var cents=schedRecalc(Math.round(total*100));
      schedCells.forEach(function(c,i){ c.textContent=money((cents[i]||0)/100); });
      var bal=document.getElementById('balCompletion');
      if(bal && cents.length) bal.textContent=money((cents[cents.length-1]||0)/100);
    }
  }
  toggles.forEach(function(cb){ cb.addEventListener('change', refresh); });
  refresh();

  var panels={accept:'panelAccept',change:'panelChange',reject:'panelReject'};
  function show(which){
    var target=document.getElementById(panels[which]);
    var opening=target && target.style.display==='none';
    Object.keys(panels).forEach(function(k){
      var el=document.getElementById(panels[k]);
      if(el) el.style.display='none';
    });
    if(target && opening){
      target.style.display='block';
      target.scrollIntoView({behavior:'smooth',block:'nearest'});
    }
  }
  var bA=document.getElementById('btnAccept'), bC=document.getElementById('btnChange'), bR=document.getElementById('btnReject');
  if(bA) bA.addEventListener('click',function(){show('accept');});
  if(bC) bC.addEventListener('click',function(){show('change');});
  if(bR) bR.addEventListener('click',function(){show('reject');});

  var sigName=document.getElementById('sigName'), sigPreview=document.getElementById('sigPreview');
  if(sigName) sigName.addEventListener('input',function(){ sigPreview.textContent=sigName.value; });

  var err=document.getElementById('actionErr');
  var inFlight=false;
  function post(payload, btn){
    if(inFlight) return;
    inFlight=true; err.textContent='';
    var prev=btn.textContent; btn.disabled=true; btn.textContent='Sending\\u2026';
    fetch('/api/estimate/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok, j:j};});})
      .then(function(res){
        if(!res.ok) throw new Error((res.j && res.j.error)||'Something went wrong. Please try again.');
        location.reload();
      })
      .catch(function(e){
        err.textContent=e.message;
        inFlight=false; btn.disabled=false; btn.textContent=prev;
      });
  }
  var goA=document.getElementById('goAccept');
  if(goA) goA.addEventListener('click',function(){
    var name=(sigName.value||'').trim();
    if(!name){ err.textContent='Please type your full name to sign.'; return; }
    post({token:TOKEN,action:'accept',name:name,selected_optional_ids:selectedIds()}, goA);
  });
  var goC=document.getElementById('goChange');
  if(goC) goC.addEventListener('click',function(){
    var note=(document.getElementById('changeNote').value||'').trim();
    if(!note){ err.textContent='Please tell us what you would like changed.'; return; }
    post({token:TOKEN,action:'change',note:note}, goC);
  });
  var goR=document.getElementById('goReject');
  if(goR) goR.addEventListener('click',function(){
    var reason=(document.getElementById('rejectReason').value||'').trim();
    if(!confirm('Decline this estimate?')) return;
    post({token:TOKEN,action:'reject',reason:reason}, goR);
  });
})();
<\/script>`}
</body></html>`);
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

// Load the estimate by its public token. Returns null on ANY miss, including
// an estimate that exists but was never sent (private until sent, decision 1).
async function loadEstimate(token) {
  if (!UUID_RE.test(String(token || ''))) return null;
  const rows = await sb('GET', `/estimates?public_token=eq.${encodeURIComponent(token)}&deleted_at=is.null&select=*&limit=1`);
  const est = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!est || !est.sent_at) return null;
  // Line items are estimate_line_items ROWS (2026-07-13). Load them onto
  // est.line_items so every downstream reader (render, total, accept freeze)
  // sees the rows, then overwrite the legacy jsonb reference. The rows carry
  // the id the customer's tick and the signature freeze key on.
  est.line_items = await loadLineItems(est.id);
  return est;
}

async function loadLineItems(estimateId) {
  try {
    // estimate_area_id rides along (prompt 69) so ensureJobCreated can carry
    // each line's price + scope onto its job_areas row; the page render
    // ignores it.
    const rows = await sb('GET', `/estimate_line_items?estimate_id=eq.${encodeURIComponent(estimateId)}&select=id,estimate_area_id,label,description,qty,unit_price,total,is_optional,selected_by_customer,sort_order&order=sort_order.asc`);
    return Array.isArray(rows) ? rows : [];
  } catch (_) { return []; }
}

// The estimate's payment schedule rows (prompt 74). Tolerant of a database
// the migration has not reached: an error just means no schedule block.
async function loadInstallments(estimateId) {
  try {
    const rows = await sb('GET', `/estimate_installments?estimate_id=eq.${encodeURIComponent(estimateId)}&select=seq,label,amount_kind,amount_value,trigger_kind,due_date,is_deposit&order=seq.asc`);
    return Array.isArray(rows) ? rows : [];
  } catch (_) { return []; }
}

// Part E: the deposit CTA on the accepted page. Non-null only when the accept
// created a deposit installment that is still the CURRENT ask (resolved by
// the same resolveCurrentAsk the pay page and Stripe checkout use, so the
// button disappears by itself once the deposit is paid or waived).
async function loadAcceptedPay(est) {
  try {
    if (est.status !== 'accepted' || !est.job_id) return null;
    const jr = await sb('GET', `/jobs?id=eq.${encodeURIComponent(est.job_id)}&select=id,price,status,public_token,deposit_amount,deposit_collected,deposit_waived,voided_at,archived_at&limit=1`);
    const job = Array.isArray(jr) && jr[0] ? jr[0] : null;
    if (!job || !job.public_token || job.voided_at || job.archived_at) return null;
    const [inst, pays] = await Promise.all([
      sb('GET', `/pec_invoice_installments?job_id=eq.${encodeURIComponent(job.id)}&select=*`),
      sb('GET', `/pec_payments?job_id=eq.${encodeURIComponent(job.id)}&select=amount`),
    ]);
    const installments = Array.isArray(inst) ? inst : [];
    if (!installments.some(i => i && i.is_deposit)) return null; // no deposit row = no button
    const ask = resolveCurrentAsk({ job, installments, payments: Array.isArray(pays) ? pays : [] });
    if (!ask || ask.mode !== 'installment' || !ask.isDeposit || !(ask.amount > 0)) return null;
    return { url: `/pay/${job.public_token}`, amount: ask.amount };
  } catch (err) {
    console.warn('public-estimate: deposit CTA skipped:', err.message);
    return null;
  }
}

// Load an estimate BY ID for the staff preview (no token, no sent_at gate: the
// whole point of a preview is to see an unsent estimate). Staff-authenticated
// at the call site.
async function loadEstimateById(id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const rows = await sb('GET', `/estimates?id=eq.${encodeURIComponent(id)}&deleted_at=is.null&select=*&limit=1`);
  const est = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!est) return null;
  est.line_items = await loadLineItems(est.id);
  return est;
}

async function loadAreas(estimateId) {
  try {
    // id / is_custom / custom_label added for the accept path (prompt 69).
    // estimate_areas.notes is INTERNAL and is deliberately NOT selected here:
    // nothing this function loads can leak it onto the customer page.
    const rows = await sb('GET', `/estimate_areas?estimate_id=eq.${encodeURIComponent(estimateId)}&select=id,name,sqft,sort_order,system_type_id,mvb,flake_product_id,basecoat_product_id,topcoat_product_id,basecoat_cure_speed,topcoat_cure_speed,is_custom,custom_label&order=sort_order.asc`);
    return Array.isArray(rows) ? rows : [];
  } catch (_) { return []; }
}

async function loadSystemName(systemTypeId) {
  if (!systemTypeId) return null;
  try {
    const rows = await sb('GET', `/pec_prod_system_types?id=eq.${encodeURIComponent(systemTypeId)}&select=name&limit=1`);
    return Array.isArray(rows) && rows[0] ? rows[0].name : null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Presentation literature (prompt 64). One content store, two consumers: these
// same pec_presentation_sections rows render as slides in the dashboard's
// Present mode AND read-only on this public page, so the story the rep told in
// the driveway is the one the spouse re-reads at the kitchen table. brand is
// REQUIRED on every row; estimates.brand carries the short forms (PEC/FTP),
// pec_presentation_sections keys on pec_brand_identity's long forms, and this
// map is the same PEC/FTP <-> company convention the dashboard uses everywhere.
// ---------------------------------------------------------------------------
const presentationBrandKey = (brand) =>
  (brand === 'FTP' || brand === 'finishing-touch') ? 'finishing-touch' : 'prescott-epoxy';

const presentationImageUrl = (p) =>
  `${SUPABASE_URL}/storage/v1/object/public/pec-presentation/${String(p).split('/').map(encodeURIComponent).join('/')}`;

async function loadLiterature(estBrand) {
  try {
    const brandKey = presentationBrandKey(estBrand);
    const sections = await sb('GET', `/pec_presentation_sections?brand=eq.${encodeURIComponent(brandKey)}&active=is.true&select=id,kind,title,body,images,sort_order&order=sort_order.asc`);
    if (!Array.isArray(sections) || !sections.length) return { sections: [], reviews: [] };
    let reviews = [];
    // Reviews ride the gallery section, pulled live from the prompt-60 reviews
    // table. Count and minimum rating are Settings values, not constants.
    if (sections.some(s => s.kind === 'gallery')) {
      const set = await sb('GET', '/settings?key=in.(presentation_reviews_count,presentation_reviews_min_rating)&select=key,value');
      const cfg = Object.fromEntries((set || []).map((r) => [r.key, r.value]));
      const count = Math.min(10, Math.max(1, Number(cfg.presentation_reviews_count) || 3));
      const minRating = Math.min(5, Math.max(1, Number(cfg.presentation_reviews_min_rating) || 4));
      const rows = await sb('GET', `/reviews?rating=gte.${minRating}&review_text=not.is.null&select=reviewer_name,rating,review_text,posted_at,created_at&order=posted_at.desc.nullslast&limit=${count}`);
      reviews = Array.isArray(rows) ? rows : [];
    }
    return { sections, reviews };
  } catch (_) { return { sections: [], reviews: [] }; }
}

const SECTION_KIND_LABELS = {
  why_us: 'Why choose us', process: 'How the work happens',
  gallery: 'Our work', financing: 'Ways to pay',
};

function literatureBlockHtml(literature, accent) {
  const sections = literature && Array.isArray(literature.sections) ? literature.sections : [];
  if (!sections.length) return '';
  const reviews = Array.isArray(literature.reviews) ? literature.reviews : [];
  const stars = (n) => '&#9733;'.repeat(Math.max(1, Math.min(5, Number(n) || 5)));
  const reviewsHtml = reviews.length ? `
      <div style="display:grid;gap:12px;margin-top:18px">
        ${reviews.map((r) => `<div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px">
          <div style="color:${esc(accent)};font-size:15px;letter-spacing:2px">${stars(r.rating)}</div>
          <div style="font-size:14px;color:#374151;line-height:1.65;margin-top:8px;white-space:pre-wrap">${esc(r.review_text || '')}</div>
          <div style="font-weight:700;font-size:13px;margin-top:10px">${esc(r.reviewer_name || 'Verified customer')}</div>
        </div>`).join('')}
      </div>` : '';
  const imagesHtml = (imgs) => {
    const list = Array.isArray(imgs) ? imgs.filter(Boolean) : [];
    if (!list.length) return '';
    return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin-top:16px">
      ${list.map((p) => `<img src="${esc(presentationImageUrl(p))}" alt="" loading="lazy" style="width:100%;height:160px;object-fit:cover;border-radius:10px;background:#eef0f3">`).join('')}
    </div>`;
  };
  return sections.map((s) => `
    <div class="card pad" style="margin-top:18px">
      <div class="eyebrow">${esc(SECTION_KIND_LABELS[s.kind] || 'About us')}</div>
      <h3 class="sec">${esc(s.title || '')}</h3>
      ${s.body ? `<div style="font-size:14px;color:#374151;line-height:1.7">${mdToSafeHtml(s.body)}</div>` : ''}
      ${imagesHtml(s.images)}
      ${s.kind === 'gallery' ? reviewsHtml : ''}
    </div>`).join('');
}

async function loadBrand(brandKey) {
  let brand = { ...BRAND_DEFAULTS };
  try {
    const biRows = await sb('GET', `/pec_brand_identity?brand=eq.${encodeURIComponent(brandKey || 'prescott-epoxy')}&select=*&limit=1`);
    if (Array.isArray(biRows) && biRows[0]) brand = { ...BRAND_DEFAULTS, ...biRows[0] };
    else {
      const fallback = await sb('GET', `/pec_brand_identity?brand=eq.prescott-epoxy&select=*&limit=1`);
      if (Array.isArray(fallback) && fallback[0]) brand = { ...BRAND_DEFAULTS, ...fallback[0] };
    }
  } catch (_) { /* defaults */ }
  return brand;
}

// ---------------------------------------------------------------------------
// Office notification (accept / change request / reject). Mirrors
// pec-invoice-intent.cjs: email via the brand's Resend sender + Slack incoming
// webhook to #epoxysales, each attempted independently and best-effort. This
// deliberately reuses the channels that are already wired; no new channel.
// ---------------------------------------------------------------------------
async function notifyOffice(est, kind, detail) {
  const invNoTxt = estimateNo(est);
  const customer = est.customer_name || 'Customer';
  const url = `${SITE_URL}/e/${est.public_token}`;
  const headline = kind === 'accepted'
    ? `${customer} ACCEPTED estimate ${invNoTxt} for ${usd(est.price)}`
    : kind === 'change'
      ? `${customer} requested changes on estimate ${invNoTxt}`
      : `${customer} declined estimate ${invNoTxt}`;

  // Email (best-effort)
  try {
    const brandKey = est.brand || 'prescott-epoxy';
    let sender = null;
    try {
      const senders = await sb('GET', `/pec_email_senders?brand=eq.${encodeURIComponent(brandKey)}&select=*&limit=1`);
      sender = Array.isArray(senders) ? senders[0] : null;
    } catch (_) { /* fall through */ }
    if (RESEND_API_KEY && sender && sender.from_email) {
      const toEmail = OFFICE_NOTIFY_EMAIL || sender.reply_to || sender.from_email;
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
        <p><strong>${esc(headline)}</strong></p>
        ${detail ? `<p style="white-space:pre-wrap">${esc(detail)}</p>` : ''}
        ${kind === 'accepted' ? '<p>The job was created automatically on the Jobs page and the Job Schedule.</p>' : ''}
        <p><a href="${esc(url)}">Open the estimate</a></p>
      </div>`;
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `${sender.from_name || 'Prescott Epoxy Company'} <${sender.from_email}>`, to: [toEmail], subject: headline, html }),
      });
      if (!res.ok) console.error('public-estimate: notify email failed', res.status);
    }
  } catch (e) { console.error('public-estimate: notify email error', e.message); }

  // Slack (best-effort, never blocks)
  if (SLACK_OFFICE_WEBHOOK) {
    try {
      const emoji = kind === 'accepted' ? ':tada:' : kind === 'change' ? ':pencil2:' : ':x:';
      const text = `${emoji} *${headline}*${detail ? '\n> ' + detail.replace(/\n/g, '\n> ') : ''}\n<${url}|Open estimate>`;
      const res = await fetch(SLACK_OFFICE_WEBHOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      if (!res.ok) console.error('public-estimate: notify slack failed', res.status);
    } catch (e) { console.error('public-estimate: notify slack error', e.message); }
  }
}

// ---------------------------------------------------------------------------
// Lead moves (best-effort: the estimate transition is already committed, so a
// lead hiccup must not fail the customer's action; it is repairable from the
// dashboard). Both use a DETERMINISTIC lead_event id so a retried accept or
// reject can never write a second event.
// ---------------------------------------------------------------------------
async function moveLead(est, toStage, extra) {
  if (!est.lead_id) return;
  try {
    const leads = await sb('GET', `/leads?id=eq.${encodeURIComponent(est.lead_id)}&select=id,stage,accepted_at,lost_at,lost_reason&limit=1`);
    const lead = Array.isArray(leads) && leads[0] ? leads[0] : null;
    if (!lead) return;
    // Never yank an already-won lead to lost: if a different estimate won it,
    // a reject on this one records only the event, not a stage downgrade.
    if (toStage === 'lost' && lead.stage === 'accepted') return;
    if (lead.stage !== toStage) {
      const patch = { stage: toStage };
      // First-touch timestamps (mirrors LEAD_STAGE_TS in index.html).
      if (toStage === 'accepted' && !lead.accepted_at) patch.accepted_at = new Date().toISOString();
      if (toStage === 'lost') {
        if (!lead.lost_at) patch.lost_at = new Date().toISOString();
        if (extra && extra.lost_reason) patch.lost_reason = extra.lost_reason;
      }
      await sb('PATCH', `/leads?id=eq.${encodeURIComponent(lead.id)}`, patch);
    }
    const evtId = deterministicUuid(`leadevent-${toStage}:${est.id}`);
    const existing = await sb('GET', `/lead_events?id=eq.${evtId}&select=id&limit=1`);
    if (!existing.length) {
      await sb('POST', '/lead_events', {
        id: evtId,
        lead_id: lead.id,
        event_type: 'stage_change',
        from_stage: lead.stage,
        to_stage: toStage,
        payload: {
          estimate_id: est.id,
          estimate_number: est.estimate_number,
          via: 'public_estimate_page',
          ...(extra || {}),
        },
      });
    }
  } catch (e) { console.error('public-estimate: lead move failed (non-fatal)', e.message); }
}

// ---------------------------------------------------------------------------
// Accept creates the JOB, following pec-webhook-proposal-accepted.cjs: both
// job tables, customer upsert, default timeline, areas copied so the crew's
// work order is populated without re-keying. Idempotent end to end: every id
// is deterministic and every write is existence-checked first, so running the
// whole function twice (double-click, mobile retry, refresh) is a no-op the
// second time regardless of where a first attempt may have crashed.
// ---------------------------------------------------------------------------
async function ensureJobCreated(est) {
  const intake = est.intake || {};
  const allAreas = await loadAreas(est.id);
  // Custom sqft (prompt 32): a custom estimate has no area rows, so totalSqft
  // is 0 and jobs.sqft used to land null (every $/sqft readout showed "no
  // sqft on file"). The typed estimates.custom_sqft fills that gap. Standard
  // estimates keep the area sum; the manual jobs.sqft field stays a backfill
  // override edited on the job page.
  const customSqft = est.is_custom === true && Number(est.custom_sqft) > 0
    ? Math.round(Number(est.custom_sqft))
    : null;
  // Read line items from the TABLE (est.line_items may be the row set already,
  // or absent on a raw re-read); reloading makes ensureJobCreated correct no
  // matter which caller reached it, including the crash-heal path. The signed
  // selection was frozen onto the rows by applySelection before this runs.
  const items = await loadLineItems(est.id);
  const included = items.filter(li => li && (!isOptionalLine(li) || li.selected_by_customer));

  // Decisions 5 and 9 (prompt 72): the job is built from the SELECTED areas
  // only. This is the RE-COST, and it is deliberately NOT a pricing change:
  // the signed total and every line price are honored exactly; what changes
  // is the material plan, the ordering, and the costing rollup, which are
  // computed on what was actually sold instead of what was offered (a
  // declined bay's share of a kit-merged material plan has to be bought in
  // full by the remaining areas). Declined lines stay on the estimate rows
  // (is_optional AND NOT selected_by_customer) as the record of what was
  // offered and refused. GUARDRAIL (in filterAreasForJob): an area with NO
  // line item at all is KEPT; only areas named on a declined line drop.
  const declinedLines = items.filter(isDeclinedLine);
  const declinedIds = declinedAreaIdSet(items);
  const areas = filterAreasForJob(allAreas, declinedIds);
  const totalSqft = areas.reduce((s, a) => s + (Number(a.sqft) > 0 ? Number(a.sqft) : 0), 0);
  // Decision 10: estimates.scope_of_work is NEVER rewritten after signature
  // (it is the document the customer read and signed). The JOB side shows
  // only the selected lines' scope; when nothing was declined this is the
  // full document, byte-for-byte as today.
  const jobScope = declinedLines.length ? (selectedScopeDoc(included) || null) : (est.scope_of_work || null);
  const declinedNote = declinedNoteLine(declinedLines);

  // -- Customer: reuse by email, then by exact name + company (the manual-job
  // rule), then by this path's own deterministic id; create only when all
  // three miss. A retry always lands on the same row.
  //
  // Split identity pass-through (build 23): customers already has
  // first_name / last_name / company_name (2026-05-04; company_name is the
  // customer's BUSINESS, customers.company stays the brand). Fill them from
  // the estimate's split columns, only when the estimate has values, so an
  // estimate saved before the split never blanks an existing customer.
  const splitIdentity = {};
  if (est.customer_first_name) splitIdentity.first_name = est.customer_first_name;
  if (est.customer_last_name) splitIdentity.last_name = est.customer_last_name;
  if (est.customer_company) splitIdentity.company_name = est.customer_company;
  let customer = null;
  // Prompt 62 Part E: an estimate started FROM a customer carries
  // estimates.customer_id; that row wins outright (no lead is invented, no
  // duplicate customer is created by the name/email matching below).
  if (est.customer_id) {
    const found = await sb('GET', `/customers?id=eq.${encodeURIComponent(est.customer_id)}&select=*&limit=1`);
    if (found.length) {
      const updated = await sb('PATCH', `/customers?id=eq.${found[0].id}`, {
        name: est.customer_name || found[0].name,
        phone: est.customer_phone || found[0].phone,
        email: est.customer_email || found[0].email,
        ...splitIdentity,
      }, true);
      customer = updated[0];
    }
  }
  if (!customer && est.customer_email) {
    const found = await sb('GET', `/customers?email=eq.${encodeURIComponent(est.customer_email)}&select=*&limit=1`);
    if (found.length) {
      const updated = await sb('PATCH', `/customers?id=eq.${found[0].id}`, {
        name: est.customer_name || found[0].name,
        phone: est.customer_phone || found[0].phone,
        ...splitIdentity,
      }, true);
      customer = updated[0];
    }
  }
  if (!customer && est.customer_name) {
    const found = await sb('GET', `/customers?name=eq.${encodeURIComponent(est.customer_name)}&company=eq.prescott-epoxy&select=*&limit=1`);
    if (found.length) customer = found[0];
  }
  const customerId = deterministicUuid(`customer:${est.id}`);
  if (!customer) {
    const found = await sb('GET', `/customers?id=eq.${customerId}&select=*&limit=1`);
    if (found.length) customer = found[0];
  }
  if (!customer) {
    const created = await sb('POST', '/customers', {
      id: customerId,
      token: randomToken(),
      name: est.customer_name || 'Customer',
      email: est.customer_email || null,
      phone: est.customer_phone || null,
      company: 'prescott-epoxy',
      ...splitIdentity,
    }, true);
    customer = created[0];
  }

  // -- public.jobs (the Jobs page side)
  const jobId = deterministicUuid(`job:${est.id}`);
  const existingJobs = await sb('GET', `/jobs?id=eq.${jobId}&select=id&limit=1`);
  if (!existingJobs.length) {
    await sb('POST', '/jobs', {
      id: jobId,
      customer_id: customer.id,
      type: 'epoxy',
      address: est.customer_address || null,
      scope: jobScope,
      // jobs.sqft is TEXT, so both paths write a string.
      sqft: totalSqft > 0 ? String(Math.round(totalSqft)) : (customSqft != null ? String(customSqft) : null),
      // Internal crew brief (prompt 32): rides to the job so the crew work
      // order can print it. NEVER rendered on this function's customer page.
      crew_notes: est.crew_notes || null,
      price: est.price != null ? Number(est.price) : null,
      salesperson: intake.salesperson_name || null,
      signed_date: phoenixToday(),
      source: 'estimate',
      system_type_id: est.system_type_id || null,
      // The signed document's included lines become the invoice line items
      // (jobs.line_items shape: name/description/price, see pec-public-invoice).
      line_items: included.map(li => ({
        name: li.label || '',
        description: li.description || null,
        price: Number(li.total) || 0,
      })),
      // Production detail from the estimator intake, so the work order is
      // populated without re-keying (these are real jobs columns).
      gate_code: intake.gate_code || null,
      moisture: intake.moisture != null ? intake.moisture : null,
      mohs_hardness: intake.mohs_hardness != null ? intake.mohs_hardness : null,
      additional_non_slip: intake.additional_non_slip || null,
      grinder_tooling_grit: intake.grinder_tooling_grit || null,
      coat_past_garage: !!intake.coat_past_garage,
      stem_walls: !!intake.stem_walls,
    }, true);
  }

  // Default timeline + areas: guarded by their own existence checks (NOT by
  // "did this request create the job"), so a crash between the job insert and
  // these child writes is healed by the retry instead of leaving them missing.
  const existingStages = await sb('GET', `/timeline_stages?job_id=eq.${jobId}&select=id&limit=1`);
  if (!existingStages.length) {
    await sb('POST', '/timeline_stages', epoxyStages.map((name, i) => ({
      job_id: jobId,
      stage_name: name,
      status: i === 0 ? 'completed' : 'pending',
      completed_at: i === 0 ? new Date().toISOString() : null,
      sort_order: i,
    })));
  }
  if (areas.length) {
    const existingAreas = await sb('GET', `/job_areas?job_id=eq.${jobId}&select=id&limit=1`);
    if (!existingAreas.length) {
      // Each area's line item (prompt 69): its FINAL price and its scope
      // description ride onto the job_areas row so the crew sees the line's
      // money and words on the work order. A custom line becomes a REAL area
      // (decision 7): name from custom_label, no system, sqft only if typed.
      const liByArea = new Map();
      for (const li of included) {
        if (li && li.estimate_area_id && !liByArea.has(li.estimate_area_id)) liByArea.set(li.estimate_area_id, li);
      }
      await sb('POST', '/job_areas', areas.map((a, i) => {
        const li = a.id ? liByArea.get(a.id) : null;
        const isCustomLine = a.is_custom === true;
        return {
          job_id: jobId,
          name: isCustomLine ? (a.custom_label || a.name || 'Custom work') : (a.name || 'Area'),
          sqft: a.sqft != null ? a.sqft : null,
          system_type_id: isCustomLine ? null : (a.system_type_id || null),
          flake_product_id: isCustomLine ? null : (a.flake_product_id || null),
          basecoat_product_id: isCustomLine ? null : (a.basecoat_product_id || null),
          topcoat_cure_speed: a.topcoat_cure_speed || null,
          order_index: a.sort_order != null ? a.sort_order : i,
          price: li && li.total != null ? Number(li.total) : null,
          description: li && li.description ? String(li.description) : null,
        };
      }));
    }
  }

  // -- pec_prod_jobs (the Job Schedule side)
  const prodJobId = deterministicUuid(`prodjob:${est.id}`);
  const existingProd = await sb('GET', `/pec_prod_jobs?id=eq.${prodJobId}&select=id&limit=1`);
  if (!existingProd.length) {
    // The crew-facing note: the production detail in one glanceable block.
    const noteLines = [
      jobScope,
      intake.gate_code ? `Gate code: ${intake.gate_code}` : null,
      intake.moisture != null ? `Moisture: ${intake.moisture}/5` : null,
      intake.mohs_hardness != null ? `MOHS: ${intake.mohs_hardness}` : null,
      intake.grinder_tooling_grit ? `Grinder tooling/grit: ${intake.grinder_tooling_grit}` : null,
      intake.additional_non_slip ? `Non-slip: ${intake.additional_non_slip}` : null,
      intake.stem_walls ? 'Stem walls: yes' : null,
      intake.coat_past_garage ? 'Coat past garage door: yes' : null,
      est.flake_color ? `Flake color: ${est.flake_color}` : null,
      intake.special_notes || null,
      // Prompt 72 decision 11: the crew should know what was offered and not
      // sold, so nobody coats a declined patio out of muscle memory.
      declinedNote,
    ].filter(Boolean);
    await sb('POST', '/pec_prod_jobs', {
      id: prodJobId,
      proposal_number: est.estimate_number != null ? `EST-${est.estimate_number}` : `EST-${String(est.id).slice(0, 8)}`,
      customer_id: customer.id,
      customer_name: est.customer_name || customer.name || null,
      address: est.customer_address || null,
      revenue: est.price != null ? Number(est.price) : null,
      status: 'unscheduled',
      sync_status: 'dirty',
      sales_team: intake.salesperson_name || null,
      standalone_mvb: est.mvb === 'standalone',
      notes: noteLines.length ? noteLines.join('\n') : null,
    }, true);
  }
  // pec_prod_areas is the RECIPE side (its sqft and system_type_id are NOT
  // NULL): it drives the material plan, which a custom line contributes
  // nothing to (decision 6). Custom lines are skipped here; their scope and
  // price live on job_areas (decision 7) and in the prod job's notes (the
  // scope_of_work document includes the custom section).
  const prodAreas = areas.filter((a) => a.is_custom !== true && a.system_type_id && Number(a.sqft) > 0);
  if (prodAreas.length) {
    const existingProdAreas = await sb('GET', `/pec_prod_areas?job_id=eq.${prodJobId}&select=id&limit=1`);
    if (!existingProdAreas.length) {
      await sb('POST', '/pec_prod_areas', prodAreas.map((a, i) => ({
        job_id: prodJobId,
        name: a.name || 'Area',
        sqft: a.sqft != null ? a.sqft : null,
        system_type_id: a.system_type_id || null,
        // Per-area moisture vapor barrier (build 17): carry the flag so the job
        // costs and orders the MVB the estimate priced, and so the standalone_mvb
        // job flag and the area flag stay consistent.
        mvb: !!a.mvb,
        flake_product_id: a.flake_product_id || null,
        basecoat_product_id: a.basecoat_product_id || null,
        topcoat_product_id: a.topcoat_product_id || null,
        basecoat_cure_speed: a.basecoat_cure_speed || null,
        topcoat_cure_speed: a.topcoat_cure_speed || null,
        order_index: a.sort_order != null ? a.sort_order : i,
      })));
    }
  }

  // -- Point the estimate at both jobs (idempotent PATCH; same values every run).
  await sb('PATCH', `/estimates?id=eq.${encodeURIComponent(est.id)}`, {
    job_id: jobId,
    pec_prod_job_id: prodJobId,
  });

  // -- Payment schedule / deposit (prompt 74 C5 replaces prompt 45 here).
  // When the signature carries a FROZEN schedule, that schedule becomes the
  // job's real installments, REPLACING the old auto-prepared 50% deposit
  // (replace, never stack: prepareDepositInstallment is skipped entirely).
  // IDEMPOTENCY: if the job already has ANY pec_invoice_installments rows,
  // nothing is written -- the deposit unique index only covers the deposit
  // row, so this existence check is what stops a double-fired accept from
  // duplicating the non-deposit installments. NO blind retry (CLAUDE.md):
  // the bulk POST is one atomic statement behind an existence check, a
  // failure is logged, and the customer's retry/refresh re-runs this whole
  // function and heals it. Rows land 'planned'; staff send them through the
  // existing kit. A signature never triggers an outbound invoice by itself.
  const frozenSchedule = est.signature && Array.isArray(est.signature.schedule) ? est.signature.schedule : [];
  if (frozenSchedule.length) {
    try {
      const existingInst = await sb('GET', `/pec_invoice_installments?job_id=eq.${jobId}&select=id&limit=1`);
      if (!existingInst.length) {
        await sb('POST', '/pec_invoice_installments', frozenSchedule.map((r, i) => ({
          job_id: jobId,
          seq: r.seq != null ? Number(r.seq) : i,
          label: r.label || (r.is_deposit ? 'Deposit' : 'Installment'),
          amount_kind: r.amount_kind === 'fixed' ? 'fixed' : 'percent',
          amount_value: Number(r.amount_value) || 0,
          computed_amount: Number(r.computed_amount) || 0,
          trigger_kind: r.trigger_kind || 'manual',
          due_date: r.due_date || null,
          status: 'planned',
          is_deposit: r.is_deposit === true,
          standalone: false,
        })));
        // Keep the legacy deposit fields coherent, same as
        // prepareDepositInstallment: the pay page's no-schedule deposit
        // button and the Stripe webhook's deposit auto-flip read
        // jobs.deposit_amount. Fill only when null; never clobber a manual value.
        const dep = frozenSchedule.find(r => r && r.is_deposit === true);
        if (dep && Number(dep.computed_amount) > 0) {
          await sb('PATCH', `/jobs?id=eq.${encodeURIComponent(jobId)}&deposit_amount=is.null`, { deposit_amount: Number(dep.computed_amount) })
            .catch(err => console.warn('public-estimate: deposit_amount mirror failed:', String(err && err.message || err)));
        }
      }
    } catch (err) {
      console.error('public-estimate: schedule copy failed (acceptance unaffected, heals on retry):', String(err && err.message || err));
    }
  } else {
    // No schedule on the estimate: the prompt-45 behavior stays EXACTLY as
    // today. PREPARE a deposit installment at the resolved default (per-job
    // manual jobs.deposit_amount, else the system type's deposit_pct, else
    // settings default_deposit_pct). Staff SEND it manually from the invoice;
    // nothing auto-sends here. Idempotent inside (existence-checked + unique
    // index), best-effort by design: an acceptance must never fail because
    // the deposit prep hiccuped.
    try {
      await prepareDepositInstallment(sb, jobId, { systemTypeId: est.system_type_id || null });
    } catch (err) {
      console.error('public-estimate: deposit prepare failed (acceptance unaffected):', String(err && err.message || err));
    }
  }

  // -- Lead to accepted (first-touch accepted_at + one deterministic event).
  await moveLead(est, 'accepted', null);

  // -- BusyBusy project auto-create (prompt 68). Best-effort BY CONTRACT:
  // maybeCreateBusybusyProject never throws (settings gate, idempotency
  // check, pending pec_prod_busybusy_projects row, then the Catch Hook POST
  // with a 4s abort), and this belt-and-suspenders try/catch means even a
  // bug in it cannot reject an acceptance. Running here (not in handleAccept)
  // also covers the heal path, where the idempotency check makes it a no-op.
  // isCallback is literal false: this path only ever creates fresh jobs from
  // signed estimates; touch-up jobs are minted elsewhere and never come here.
  try {
    await maybeCreateBusybusyProject({ sb, env: process.env, est, prodJobId, isCallback: false });
  } catch (err) {
    console.warn('busybusy kick failed (acceptance unaffected):', String(err && err.message || err));
  }

  return { jobId, prodJobId, customerId: customer.id };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleAccept(est, body, event) {
  // Already accepted: heal any half-finished job creation, then confirm. This
  // is the double-click / refresh / retry path; it must not 409, and thanks to
  // deterministic ids + existence checks it cannot double-create anything.
  if (est.status === 'accepted') {
    await ensureJobCreated(est);
    return json(200, { ok: true, already: true });
  }
  if (est.status === 'rejected' || est.status === 'lost') {
    return json(409, { ok: false, error: 'This estimate is no longer open. Please contact us at (928) 800-8154.' });
  }

  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) return json(400, { ok: false, error: 'Please type your full name to sign.' });
  const selectedIds = Array.isArray(body.selected_optional_ids) ? body.selected_optional_ids.slice(0, 50).map(String) : [];

  const frozenItems = freezeLineItems(est.line_items, selectedIds);
  const total = Math.round(includedTotal(frozenItems) * 100) / 100;
  // Decision 4 defense: the rep-side send gate (at least one required line)
  // makes a zero-selection accept unreachable through the UI; this guard is
  // for a hand-crafted POST, and it keeps a $0 accept from ever creating a
  // real job. Checked BEFORE the CAS so status never flips.
  if (acceptSelectionInvalid(frozenItems)) {
    return json(400, { ok: false, error: 'Please select at least one item before signing.' });
  }
  const nowIso = new Date().toISOString();
  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
  const ua = String(event.headers['user-agent'] || '').slice(0, 300) || null;

  // Prompt 74 C5: resolve the payment schedule at the SIGNED total and freeze
  // it into the signature jsonb. freezeSchedule allocates in cents with the
  // last row absorbing the remainder, so the frozen dollars sum to the signed
  // total exactly; ensureJobCreated copies this record to the job's
  // pec_invoice_installments. Loaded BEFORE the CAS so the winner writes it
  // atomically with the signature. No schedule rows = no key, and the legacy
  // auto-deposit flow stays exactly as today.
  const schedRows = await loadInstallments(est.id);
  const frozenSched = schedRows.length ? freezeSchedule(schedRows, Math.round(total * 100)) : null;

  // Compare-and-swap: only a row still in an open status flips to accepted,
  // so exactly ONE request wins the signature. The signed total becomes the
  // estimate's price (it is what the job and the win metrics read); the frozen
  // selection is recorded in the signature jsonb (the audit record) AND
  // written onto the estimate_line_items rows below.
  const updated = await sb('PATCH',
    `/estimates?id=eq.${encodeURIComponent(est.id)}&status=in.(sent,signed,change_requested,draft)`,
    {
      status: 'accepted',
      accepted_at: nowIso,
      signed_name: name,
      signed_at: nowIso,
      signed_ip: ip,
      signature: {
        typed_name: name, signed_at: nowIso, ip, user_agent: ua,
        selected_optional_ids: selectedIds, total, via: 'public_estimate_page',
        ...(frozenSched ? { schedule: frozenSched } : {}),
      },
      price: total,
    }, true);

  let fresh;
  if (Array.isArray(updated) && updated.length) {
    fresh = updated[0];
  } else {
    // Lost the race: someone else transitioned the row between our read and
    // the CAS. Re-read and act on what actually happened.
    const rows = await sb('GET', `/estimates?id=eq.${encodeURIComponent(est.id)}&select=*&limit=1`);
    const now = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (now && now.status === 'accepted') {
      await ensureJobCreated(now);
      return json(200, { ok: true, already: true });
    }
    return json(409, { ok: false, error: 'This estimate is no longer open. Please contact us at (928) 800-8154.' });
  }

  // Freeze the selection onto the rows (per-row PATCH; idempotent by absolute
  // value, keyed on the signed id list, so a retry re-applies the same state).
  // Runs only from the CAS winner, before job creation reads the rows.
  await applySelection(est.id, est.line_items, selectedIds);

  const result = await ensureJobCreated(fresh);
  // Notify only from the request that won the CAS, so a retry storm sends one
  // notification, not five. Best-effort by construction.
  await notifyOffice(fresh, 'accepted', `Signed by ${name}. Total: ${usd(total)}.`);
  return json(200, { ok: true, job_id: result.jobId });
}

async function handleChange(est, body) {
  const note = String(body.note || '').trim().slice(0, 2000);
  if (!note) return json(400, { ok: false, error: 'Please tell us what you would like changed.' });
  if (est.status === 'accepted') return json(409, { ok: false, error: 'This estimate is already accepted. Call us at (928) 800-8154 for changes.' });
  if (est.status === 'rejected' || est.status === 'lost') return json(409, { ok: false, error: 'This estimate is no longer open. Please contact us at (928) 800-8154.' });
  // One change request per send: once status is change_requested, further
  // POSTs are refused until the office re-sends (the replay/spam guard).
  if (est.status === 'change_requested') {
    return json(409, { ok: false, error: 'We already have your change request and are working on it. Call us at (928) 800-8154 to add anything.' });
  }
  const updated = await sb('PATCH',
    `/estimates?id=eq.${encodeURIComponent(est.id)}&status=in.(sent,signed,draft)`,
    { status: 'change_requested', change_request_note: note }, true);
  if (!Array.isArray(updated) || !updated.length) {
    return json(409, { ok: false, error: 'This estimate just changed state. Refresh the page to see where it stands.' });
  }
  await notifyOffice(updated[0], 'change', note);
  return json(200, { ok: true });
}

async function handleReject(est, body) {
  const reason = String(body.reason || '').trim().slice(0, 2000) || null;
  if (est.status === 'accepted') return json(409, { ok: false, error: 'This estimate is already accepted. Call us at (928) 800-8154.' });
  if (est.status === 'rejected') return json(200, { ok: true, already: true });
  if (est.status === 'lost') return json(409, { ok: false, error: 'This estimate is no longer open.' });
  const updated = await sb('PATCH',
    `/estimates?id=eq.${encodeURIComponent(est.id)}&status=in.(sent,signed,change_requested,draft)`,
    { status: 'rejected', rejected_reason: reason, rejected_at: new Date().toISOString() }, true);
  if (!Array.isArray(updated) || !updated.length) {
    const rows = await sb('GET', `/estimates?id=eq.${encodeURIComponent(est.id)}&select=status&limit=1`);
    if (rows.length && rows[0].status === 'rejected') return json(200, { ok: true, already: true });
    return json(409, { ok: false, error: 'This estimate just changed state. Refresh the page to see where it stands.' });
  }
  // Lost reason is what conversion-by-source in Metrics reads; the customer's
  // words go on the lead verbatim (prefixed so the report reads cleanly).
  await moveLead(updated[0], 'lost', { lost_reason: reason ? `Estimate declined: ${reason}` : 'Estimate declined online' });
  await notifyOffice(updated[0], 'reject', reason);
  return json(200, { ok: true });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Estimate view logging (prompt 44). Every customer open of /e/<token> writes
// a pec_estimate_views row and (when enabled in Settings) a shared-bell
// pec_notifications row. Dylan chose EVERY open (no throttle), so the only
// filter is link-preview bots: SMS and email clients pre-fetch the link to
// build a preview card, which would light the bell before the customer ever
// tapped it. The regex targets known unfurler/crawler UA tokens plus obvious
// script clients; a normal phone/desktop browser UA never matches. The staff
// ?preview= route never reaches this (separate handler branch), but a staff
// member opening the raw public link DOES log, same as the portal.
// Best-effort by design: a logging failure must never break the customer page.
const BOT_UA_RE = /\bbot\b|bot[\/;)]|crawler|spider|crawling|preview|prefetch|prerender|facebookexternalhit|whatsapp|slackbot|imgproxy|telegram|skypeuripreview|discord|twitterbot|linkedin|pinterest|embedly|googleimageproxy|snapchat|viber|\bline\//i;

// "1st" / "2nd" / "3rd" / "11th" for the Slack line.
function viewOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
// Compact "3 hours" / "2 days" for "sent N ago".
function agoLabel(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(mins, 1)} minute${mins === 1 ? '' : 's'}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? '' : 's'}`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

async function logEstimateView(est, event) {
  try {
    const ua = String(event.headers['user-agent'] || '').slice(0, 300);
    if (BOT_UA_RE.test(ua)) return;
    const ip = String(event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 60) || null;
    await sb('POST', '/pec_estimate_views', { estimate_id: est.id, user_agent: ua || null, ip });

    const set = await sb('GET', '/settings?key=in.(estimate_view_notifications_enabled,estimate_view_notify_first_per_day,estimate_view_slack_enabled)&select=key,value');
    const cfg = Object.fromEntries((set || []).map((r) => [r.key, r.value]));

    // Which open is this? Counted AFTER the insert above, so the row just
    // written is included ("1st view" on the very first open).
    let viewCount = null;
    try {
      const vrows = await sb('GET', `/pec_estimate_views?estimate_id=eq.${est.id}&select=id`);
      if (Array.isArray(vrows)) viewCount = vrows.length;
    } catch (_) { /* count is decoration; the post below degrades without it */ }

    // Slack on EVERY logged open (prompt 75 D1, Dylan's decision 7: no
    // throttle; the bot-UA filter above is the only gate). Its own switch
    // (estimate_view_slack_enabled), independent of the bell settings below;
    // the first-per-day throttle applies to the BELL only. Best-effort,
    // exactly like notifyOffice: wrapped, logged on failure, never blocks
    // the customer render.
    if (SLACK_OFFICE_WEBHOOK && String(cfg.estimate_view_slack_enabled || 'true') !== 'false') {
      try {
        const repName = (est.intake && est.intake.salesperson_name) || null;
        const sentAgo = est.sent_at ? agoLabel(Date.now() - Date.parse(est.sent_at)) : null;
        const url = `${SITE_URL}/e/${est.public_token}`;
        const facts = [
          est.price != null ? usd(est.price) : null,
          repName ? `sold by ${repName}` : null,
          viewCount ? `${viewOrdinal(viewCount)} view` : null,
          sentAgo ? `sent ${sentAgo} ago` : null,
        ].filter(Boolean).join(' · ');
        const text = `:eyes: *${est.customer_name || 'Customer'} opened estimate ${estimateNo(est)}*${facts ? '\n' + facts : ''}\n<${url}|Open estimate>`;
        const res = await fetch(SLACK_OFFICE_WEBHOOK, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
        });
        if (!res.ok) console.error('public-estimate: view slack failed', res.status);
      } catch (e) { console.error('public-estimate: view slack error', e.message); }
    }

    if (String(cfg.estimate_view_notifications_enabled || 'true') === 'false') return;
    if (String(cfg.estimate_view_notify_first_per_day || 'false') === 'true') {
      // One bell per estimate per Phoenix day. Phoenix is UTC-7 year-round
      // (no DST), so today's local midnight is a fixed UTC offset. The
      // per-rep row below sits after this return ON PURPOSE: shared and
      // personal bells throttle together, so the two can never disagree
      // about whether "today's view" was announced.
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date());
      const dupes = await sb('GET', `/pec_notifications?type=eq.estimate_viewed&target_id=eq.${est.id}&created_at=gte.${day}T07:00:00Z&select=id&limit=1`);
      if ((dupes || []).length) return;
    }
    await sb('POST', '/pec_notifications', {
      type: 'estimate_viewed',
      job_id: est.job_id || null,
      body: est.estimate_number != null ? `Customer viewed estimate #${est.estimate_number}` : 'Customer viewed an estimate',
      priority: 'normal',
      target_view: 'estimates',
      target_id: est.id,
    });

    // Personal bell for the rep who sold it (prompt 75 D2). Resolution chain:
    // intake->salesperson_id -> pec_sales_team_members.auth_user_id ->
    // admin_users(auth_user_id).id -> pec_notifications.target_user_id.
    // If ANY hop fails (no salesperson on the intake, member with no login,
    // pre-migration column missing), skip SILENTLY: the shared row above and
    // Slack already fired. This is a display filter, never privacy: staff RLS
    // still lets everyone read the row.
    try {
      const spId = est.intake && est.intake.salesperson_id;
      if (!spId) return;
      const members = await sb('GET', `/pec_sales_team_members?id=eq.${encodeURIComponent(spId)}&select=auth_user_id&limit=1`);
      const authId = Array.isArray(members) && members[0] && members[0].auth_user_id;
      if (!authId) return;
      const admins = await sb('GET', `/admin_users?auth_user_id=eq.${encodeURIComponent(authId)}&select=id&limit=1`);
      const adminId = Array.isArray(admins) && admins[0] && admins[0].id;
      if (!adminId) return;
      await sb('POST', '/pec_notifications', {
        type: 'estimate_viewed_rep',
        job_id: est.job_id || null,
        body: est.estimate_number != null
          ? `Your customer viewed estimate #${est.estimate_number}${viewCount ? ` (${viewOrdinal(viewCount)} view)` : ''}`
          : 'Your customer viewed an estimate',
        priority: 'normal',
        target_view: 'estimates',
        target_id: est.id,
        target_user_id: adminId,
      });
    } catch (e) { console.warn('estimate view rep bell skipped:', e.message); }
  } catch (err) {
    console.warn('estimate view log skipped:', err.message);
  }
}

exports.handler = async (event) => {
  // POST /api/estimate/action: the three customer actions.
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { ok: false, error: 'Invalid request' }); }
    const token = String(body.token || '').trim();
    if (!UUID_RE.test(token)) return json(404, { ok: false, error: 'Not found' });
    try {
      const est = await loadEstimate(token);
      if (!est) return json(404, { ok: false, error: 'Not found' });
      const action = String(body.action || '');
      if (action === 'accept') return await handleAccept(est, body, event);
      if (action === 'change') return await handleChange(est, body);
      if (action === 'reject') return await handleReject(est, body);
      return json(400, { ok: false, error: 'Unknown action' });
    } catch (err) {
      console.error('public-estimate action error:', err.message);
      return json(500, { ok: false, error: 'Something went wrong on our end. Please try again.' });
    }
  }

  if (event.httpMethod && event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });

  const qs = event.queryStringParameters || {};

  // STAFF PREVIEW: GET ?preview=<estimate_id> with a staff JWT renders the
  // EXACT customer page (same estimatePage renderer, preview:true) for an
  // estimate that has NOT been sent, WITHOUT setting sent_at, flipping status,
  // or exposing the public token. Authenticated, not token-based. The dashboard
  // fetches this with the user's Bearer token and drops the HTML into an
  // iframe, so it never navigates the browser (which would drop the header).
  if (qs.preview) {
    const auth = event.headers.authorization || event.headers.Authorization || '';
    const user = await getUser(auth.replace(/^Bearer\s+/i, ''));
    if (!user || !user.id) return htmlResponse(401, '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px">Not authorized to preview this estimate.</body>');
    if (!UUID_RE.test(String(qs.preview))) return notFoundPage();
    try {
      const est = await loadEstimateById(qs.preview);
      if (!est) return notFoundPage();
      const [brand, sysName, areas, financing, literature, installments] = await Promise.all([
        loadBrand(est.brand),
        loadSystemName(est.system_type_id),
        loadAreas(est.id),
        loadFinancingSettings(sb),
        loadLiterature(est.brand),
        loadInstallments(est.id),
      ]);
      const totalSqft = areas.reduce((s, a) => s + (Number(a.sqft) > 0 ? Number(a.sqft) : 0), 0);
      return estimatePage(est, brand, sysName, totalSqft, { preview: true, financing, literature, areas, installments });
    } catch (err) {
      console.error('public-estimate preview error:', err.message);
      return notFoundPage();
    }
  }

  // GET /e/<token>: render. ?token= with the path-parse fallback for
  // Netlify's :splat quirk (tokenFromEvent, the /co/ lesson).
  const token = tokenFromEvent(event);
  try {
    const est = await loadEstimate(token);
    if (!est) return notFoundPage();
    const [brand, sysName, areas, financing, literature, installments, acceptedPay] = await Promise.all([
      loadBrand(est.brand),
      loadSystemName(est.system_type_id),
      loadAreas(est.id),
      loadFinancingSettings(sb),
      loadLiterature(est.brand),
      loadInstallments(est.id),
      loadAcceptedPay(est),
    ]);
    const totalSqft = areas.reduce((s, a) => s + (Number(a.sqft) > 0 ? Number(a.sqft) : 0), 0);
    // Await (not fire-and-forget): the lambda may freeze the instant the
    // response returns, which would drop an un-awaited insert.
    // present=1 (prompt 64): the dashboard's Present mode loads this live page
    // in its signing step with the REP driving, so it is not a customer view
    // and must not light the bell mid-presentation. The param's ONLY effect is
    // skipping this log; render, buttons, and the action path are identical.
    // A customer who hand-added the param would only skip a convenience log.
    if (String(qs.present || '') !== '1') await logEstimateView(est, event);
    return estimatePage(est, brand, sysName, totalSqft, { financing, literature, areas, installments, acceptedPay });
  } catch (err) {
    console.error('public-estimate error:', err.message);
    return notFoundPage();
  }
};

// Exposed for the test harness so it drives the REAL functions (with
// _pec-supabase mocked through the require cache), not reimplementations.
exports._internals = {
  deterministicUuid, includedTotal, freezeLineItems, ensureJobCreated,
  loadEstimate, loadEstimateById, estimatePage, notFoundPage, stateForStatus, moveLead,
  mdToSafeHtml, applySelection, loadLiterature, literatureBlockHtml, presentationBrandKey,
  loadInstallments, loadAcceptedPay, liSubtitleHtml,
};
