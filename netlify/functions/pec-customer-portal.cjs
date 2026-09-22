'use strict';

// Read-only customer hub. The existing bearer-token RPC establishes customer
// identity; every subsequent service-role read is scoped to that identity.
// Never accept a customer/job ID supplied by the browser or return DB rows
// wholesale. Existing public estimate/invoice endpoints still own document
// rendering, signing and payment actions.
const crypto = require('node:crypto');
const { sb } = require('./_pec-supabase.cjs');
const { postgrestLiteral } = require('./_pec-lead-match.cjs');
const { takeBookingRateLimit } = require('./_pec-booking-drive.cjs');
const { resolveCurrentAsk } = require('./_pec-installments.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const EPS = 0.005;
const PAGE = 200;
const round2 = value => Math.round((Number(value) || 0) * 100) / 100;
// Scalar equality takes a URL-encoded value. Quoting belongs to PostgREST's
// in/or list grammar; quoting a scalar UUID instead makes its cast fail.
const eq = value => 'eq.' + encodeURIComponent(String(value));
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const validId = value => typeof value === 'string' && UUID.test(value);
const text = value => value == null ? null : String(value);
const only = (row, fields) => Object.fromEntries(fields.map(key => [key, row[key] == null ? null : row[key]]));
const idSet = rows => new Set(rows.map(row => row.id).filter(validId));
const CUSTOMER_FIELDS = ['id', 'name', 'first_name', 'last_name', 'email', 'phone', 'company', 'company_name', 'billing_address_line1', 'billing_address_line2', 'billing_city', 'billing_state', 'billing_zip'];
const JOB_FIELDS = ['id', 'type', 'status', 'address', 'package', 'price', 'warranty', 'confirmed', 'confirmed_at', 'signature_data', 'created_at', 'colors_confirmed'];
const ESTIMATE_COLUMNS = 'id,customer_id,job_id,lead_id,estimate_number,status,price,sent_at,signed_at,signed_name,public_token,deleted_at,created_at,customer_address,is_custom,choice_picked_line_id';
const SHARED_ESTIMATE_STATUSES = ['sent', 'signed', 'accepted', 'change_requested', 'rejected', 'lost'];
const PROD_COLUMNS = 'id,crm_job_id,customer_id,dripjobs_deal_id,install_date,archived_at,is_callback,crm_link_declined';
const INVOICE_COLUMNS = 'id,customer_id,status,address,price,hq_invoice_number,deposit_amount,deposit_collected,deposit_waived,paid_to_date,balance_remaining,public_token,invoice_first_sent_at,invoice_terms,invoice_due_date';
const INSTALLMENT_COLUMNS = 'id,job_id,seq,label,computed_amount,trigger_kind,due_date,status,is_deposit,standalone,sent_at,paid_at,created_at';
const BRAND_COLUMNS = 'brand,business_name,phone,website,logo_url,license_number,address_line,primary_color,accent_color';
const SETTINGS = ['customer_portal_referrals_enabled', 'customer_portal_reviews_enabled', 'referral_reward_amount', 'google_review_link_epoxy', 'google_review_link_paint', 'portal_yelp_link_epoxy', 'portal_yelp_link_paint'];

function response(statusCode, body, headers = {}) {
  return { statusCode, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, private',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  }, body: JSON.stringify(body) };
}

function webUrl(value, hosts) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (hosts && (url.protocol !== 'https:' || !hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)))) return null;
    return url.href;
  } catch (_) { return null; }
}
function publicAsset(value) {
  if (typeof value === 'string' && /^\/(?!\/)[A-Za-z0-9_./-]+$/.test(value)) return value;
  return webUrl(value);
}
function docUrl(kind, token) { return validId(token) ? '/' + kind + '/' + token : null; }
function reviewUrl(value, platform) {
  const safe = webUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  if (url.protocol !== 'https:' || url.port) return null;
  if (platform === 'google') return ['google.com', 'www.google.com', 'search.google.com', 'maps.google.com', 'g.page', 'maps.app.goo.gl', 'goo.gl'].includes(url.hostname) ? safe : null;
  return ['yelp.com', 'www.yelp.com', 'yelp.ca', 'www.yelp.ca'].includes(url.hostname) && /^\/biz\/[^/]+/.test(url.pathname) ? safe : null;
}
function phoenixDay(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time - 7 * 3600 * 1000).toISOString().slice(0, 10) : null;
}

// Explicit pagination prevents a customer's older documents/payments from
// silently disappearing at PostgREST's default row cap. Excessive histories
// fail visibly rather than reporting an incorrect financial total.
async function readAll(db, path) {
  const rows = [];
  for (let offset = 0; offset < 10000; offset += PAGE) {
    const page = await db('GET', path + '&limit=' + PAGE + '&offset=' + offset);
    if (!Array.isArray(page)) throw new Error('Invalid portal dataset');
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
  throw new Error('Portal dataset exceeds the read limit');
}
async function byIds(db, table, column, ids, select, extra = '') {
  const values = [...new Set(ids)].filter(validId);
  const rows = [];
  for (let start = 0; start < values.length; start += 50) {
    rows.push(...await readAll(db, `/${table}?${column}=in.(${values.slice(start, start + 50).join(',')})&select=${select}${extra}&order=id.asc`));
  }
  return rows;
}
function uniqueRows(lists) {
  return [...new Map(lists.flat().filter(row => row && validId(row.id)).map(row => [row.id, row])).values()];
}

function portalJob(row) {
  return {
    ...only(row, JOB_FIELDS),
    timeline: (Array.isArray(row.timeline) ? row.timeline : []).map(stage => only(stage, ['id', 'stage_name', 'status', 'sort_order', 'completed_at'])),
    colors: (Array.isArray(row.colors) ? row.colors : []).map(color => ({ ...only(color, ['id', 'label', 'name', 'type', 'hex', 'sku']), swatch_image: publicAsset(color.swatch_image) })),
    photos: (Array.isArray(row.photos) ? row.photos : []).map(photo => ({ ...only(photo, ['id', 'caption', 'created_at']), url: webUrl(photo.url) })).filter(photo => photo.url),
    review: row.review ? only(row.review, ['id', 'rating', 'feedback', 'created_at']) : null,
    // Rebuilt below from explicitly owned estimate rows, including a signed
    // legacy receipt whose public document was never sent.
    estimate_signature: null,
    scheduled_dates: [], install_date: null, schedule_status: 'unavailable',
  };
}

function estimateOwned(estimate, customerId, jobIds, leadIds) {
  if (estimate.customer_id) return estimate.customer_id === customerId;
  // An explicit conflicting job link must not be overridden by a lead match.
  if (estimate.job_id) return jobIds.has(estimate.job_id);
  return !!estimate.lead_id && leadIds.has(estimate.lead_id);
}

async function loadEstimates(db, customerId, jobs, leads) {
  const jobIds = idSet(jobs), leadIds = idSet(leads);
  // A record reverted to draft can retain its original sent_at. Its current
  // contents are a working revision, not a new shared historical document.
  const sent = '&deleted_at=is.null&sent_at=not.is.null&status=in.(' + SHARED_ESTIMATE_STATUSES.join(',') + ')';
  const lists = await Promise.all([
    readAll(db, `/estimates?customer_id=${eq(customerId)}&select=${ESTIMATE_COLUMNS}${sent}&order=id.asc`),
    byIds(db, 'estimates', 'job_id', [...jobIds], ESTIMATE_COLUMNS, sent + '&customer_id=is.null'),
    byIds(db, 'estimates', 'lead_id', [...leadIds], ESTIMATE_COLUMNS, sent + '&customer_id=is.null'),
  ]);
  const jobsById = new Map(jobs.map(job => [job.id, job]));
  const shared = uniqueRows(lists).filter(row => row.sent_at && !row.deleted_at && SHARED_ESTIMATE_STATUSES.includes(row.status) && estimateOwned(row, customerId, jobIds, leadIds));
  const choices = await byIds(db, 'estimate_line_items', 'estimate_id', shared.map(row => row.id), 'id,estimate_id,choice_group', '&choice_group=not.is.null');
  return shared.sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)) || a.id.localeCompare(b.id)).map(row => {
    const choiceLines = choices.filter(line => line.estimate_id === row.id && line.choice_group);
    const needsChoice = !['accepted', 'signed'].includes(row.status) && choiceLines.length > 0 && !choiceLines.some(line => line.id === row.choice_picked_line_id);
    return {
      ...only(row, ['id', 'estimate_number', 'status', 'sent_at', 'signed_at', 'signed_name', 'created_at']),
      price: needsChoice ? null : row.price, needs_choice: needsChoice,
      job_id: jobIds.has(row.job_id) ? row.job_id : null,
      title: jobsById.get(row.job_id)?.package || (row.is_custom ? 'Custom estimate' : 'Project estimate'),
      address: text(row.customer_address || jobsById.get(row.job_id)?.address),
      url: docUrl('e', row.public_token),
    };
  }).filter(row => row.url);
}

async function loadJobSignatures(db, customerId, jobs) {
  const rows = await byIds(db, 'estimates', 'job_id', jobs.map(job => job.id),
    'id,job_id,customer_id,estimate_number,signed_at,signed_name,public_token,sent_at,status,deleted_at',
    '&status=eq.accepted&signed_at=not.is.null&deleted_at=is.null');
  for (const job of jobs) {
    const row = rows.filter(estimate => estimate.job_id === job.id && (!estimate.customer_id || estimate.customer_id === customerId)
      && estimate.status === 'accepted' && estimate.signed_at && !estimate.deleted_at)
      .sort((a, b) => String(b.signed_at).localeCompare(String(a.signed_at)) || a.id.localeCompare(b.id))[0];
    if (row) job.estimate_signature = {
      ...only(row, ['estimate_number', 'signed_name', 'signed_at']),
      url: row.sent_at ? docUrl('e', row.public_token) : null,
    };
  }
}

async function loadSchedule(db, customerId, ownedJobs, portalJobs) {
  const jobIds = idSet(ownedJobs);
  const links = await byIds(db, 'estimates', 'job_id', [...jobIds], 'id,job_id,customer_id,pec_prod_job_id', '&deleted_at=is.null&pec_prod_job_id=not.is.null');
  const validLinks = links.filter(row => jobIds.has(row.job_id) && (!row.customer_id || row.customer_id === customerId));
  const [explicit, stamped] = await Promise.all([
    byIds(db, 'pec_prod_jobs', 'crm_job_id', [...jobIds], PROD_COLUMNS, '&archived_at=is.null'),
    byIds(db, 'pec_prod_jobs', 'id', validLinks.map(row => row.pec_prod_job_id), PROD_COLUMNS, '&archived_at=is.null'),
  ]);
  const eligible = row => row && !row.archived_at && !row.is_callback && (!row.customer_id || row.customer_id === customerId);
  const prodRows = uniqueRows([explicit, stamped]).filter(eligible);
  const chosen = new Map();
  const preferred = rows => [...rows].sort((a, b) => Number(!!b.install_date) - Number(!!a.install_date)
    || String(a.install_date || '').localeCompare(String(b.install_date || '')) || a.id.localeCompare(b.id))[0];
  for (const job of ownedJobs) {
    const paired = prodRows.filter(row => row.crm_job_id === job.id);
    if (paired.length) { chosen.set(job.id, preferred(paired)); continue; }
    const stampedIds = new Set(validLinks.filter(row => row.job_id === job.id).map(row => row.pec_prod_job_id));
    const candidates = prodRows.filter(row => stampedIds.has(row.id) && (!row.crm_job_id || row.crm_job_id === job.id) && !row.crm_link_declined);
    if (candidates.length === 1) chosen.set(job.id, candidates[0]);
  }
  const unresolved = ownedJobs.filter(job => !chosen.has(job.id) && job.dripjobs_deal_id);
  const dealIds = [...new Set(unresolved.map(job => String(job.dripjobs_deal_id)))];
  for (let start = 0; start < dealIds.length; start += 50) {
    const values = dealIds.slice(start, start + 50).map(postgrestLiteral).join(',');
    const rows = await readAll(db, `/pec_prod_jobs?dripjobs_deal_id=in.(${encodeURIComponent(values)})&archived_at=is.null&select=${PROD_COLUMNS}&order=id.asc`);
    for (const job of unresolved) {
      const candidates = rows.filter(row => eligible(row) && String(row.dripjobs_deal_id) === String(job.dripjobs_deal_id)
        && (!row.crm_job_id || row.crm_job_id === job.id) && !row.crm_link_declined);
      // No fuzzy name/address match, and ambiguous legacy deal pairs stay
      // unconfirmed instead of borrowing another project's installation date.
      if (candidates.length === 1) chosen.set(job.id, candidates[0]);
    }
  }
  const days = await byIds(db, 'pec_prod_job_schedule_days', 'job_id', [...chosen.values()].map(row => row.id), 'id,job_id,scheduled_date');
  for (const job of portalJobs) {
    const prod = chosen.get(job.id);
    if (!prod) continue;
    let dates = [...new Set(days.filter(day => day.job_id === prod.id).map(day => day.scheduled_date).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
    if (!dates.length && /^\d{4}-\d{2}-\d{2}$/.test(prod.install_date)) dates = [prod.install_date];
    job.scheduled_dates = dates;
    job.install_date = dates[0] || null;
    job.schedule_status = dates.length ? 'scheduled' : 'unscheduled';
  }
}

function invoiceSummary(row, job, installments, payments, markers, today) {
  const money = value => value != null && String(value).trim() !== '' && Number.isFinite(Number(value));
  if (![row.price, row.paid_to_date, row.balance_remaining].every(money)
      || payments.some(payment => !money(payment.amount))
      || installments.some(inst => !money(inst.computed_amount))
      || markers.some(marker => !money(marker.amount))) throw new Error('Invalid invoice amount');
  const ask = resolveCurrentAsk({ job: row, installments, payments, today });
  const pending = markers.filter(marker => marker.status === 'pending');
  const pendingAmount = round2(pending.reduce((total, marker) => total + (Number(marker.amount) || 0), 0));
  const balance = round2(row.balance_remaining);
  const netBalance = Math.max(0, round2(balance - pendingAmount));
  const amountDue = ask ? Math.max(0, round2(ask.amount - pendingAmount)) : netBalance;
  let status, statusLabel;
  if (balance <= EPS) { status = 'paid'; statusLabel = 'Paid in full'; }
  else if (ask && ['none', 'paid'].includes(ask.mode)) { status = 'scheduled'; statusLabel = 'On schedule'; }
  else if ((ask ? round2(ask.amount - pendingAmount) : netBalance) <= EPS) { status = 'processing'; statusLabel = 'Payment processing'; }
  // The legacy /pay hero is the full balance, even when its status pill says
  // Deposit due. Label that displayed balance accurately; only a real
  // deposit installment may call the portal amount a deposit.
  else if (ask?.isDeposit) { status = 'deposit_due'; statusLabel = 'Deposit due'; }
  else if (ask || row.status === 'completed') { status = 'payment_due'; statusLabel = 'Payment due'; }
  else { status = 'balance_due'; statusLabel = 'Balance due'; }
  const newestFailed = markers.filter(marker => marker.status === 'failed').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  const failedDay = newestFailed && phoenixDay(newestFailed.created_at);
  const achFailed = !!(failedDay && !payments.some(payment => payment.received_date && payment.received_date >= failedDay)
    && !pending.some(marker => String(marker.created_at) > String(newestFailed.created_at)));
  const sentDates = installments.filter(inst => inst.sent_at).map(inst => inst.sent_at).sort();
  const current = ask && installments.find(inst => inst.id === ask.installmentId);
  return {
    id: row.id, job_id: row.id, invoice_number: text(row.hq_invoice_number),
    title: job.package || 'Your project', address: text(row.address || job.address),
    total: round2(row.price), paid_to_date: round2(row.paid_to_date), balance_remaining: balance,
    amount_due: amountDue, due_later: ask ? Math.max(0, round2(netBalance - amountDue)) : 0,
    pending_amount: pendingAmount, status, status_label: statusLabel,
    ask_label: ask?.label || (status === 'paid' ? 'Paid in full' : 'Balance'),
    due_date: amountDue > EPS ? (current?.due_date || row.invoice_due_date || null) : null,
    issued_at: row.invoice_first_sent_at || sentDates[0] || payments[0]?.received_date || pending[0]?.created_at || null,
    url: docUrl('pay', row.public_token), can_pay: amountDue > EPS, ach_failed: achFailed,
    payments: [
      ...payments.map(payment => ({ ...only(payment, ['amount', 'method', 'reference', 'received_date']), status: 'received' })),
      ...pending.map(marker => ({ amount: round2(marker.amount), method: 'ach', reference: null, received_date: phoenixDay(marker.created_at), status: 'pending' })),
    ],
  };
}

async function loadInvoices(db, customerId, ownedJobs, portalJobs, today) {
  const jobsById = new Map(portalJobs.map(job => [job.id, job]));
  const eligibleIds = new Set(ownedJobs.filter(job => !job.public_token_revoked_at).map(job => job.id));
  const rows = (await readAll(db, `/pec_job_ar?customer_id=${eq(customerId)}&select=${INVOICE_COLUMNS}&order=id.asc`))
    .filter(row => row.customer_id === customerId && eligibleIds.has(row.id) && jobsById.has(row.id) && docUrl('pay', row.public_token));
  const ids = rows.map(row => row.id);
  const [installments, payments, markers] = await Promise.all([
    byIds(db, 'pec_invoice_installments', 'job_id', ids, INSTALLMENT_COLUMNS),
    byIds(db, 'pec_payments', 'job_id', ids, 'id,job_id,amount,method,reference,received_date'),
    byIds(db, 'pec_stripe_pending', 'job_id', ids, 'id,job_id,amount,kind,status,created_at', '&status=in.(pending,failed)'),
  ]);
  return rows.map(row => {
    const inst = installments.filter(item => item.job_id === row.id);
    const paid = payments.filter(item => item.job_id === row.id).sort((a, b) => String(a.received_date).localeCompare(String(b.received_date)) || a.id.localeCompare(b.id));
    const pending = markers.filter(item => item.job_id === row.id);
    // A prepared invoice is not an issued invoice. A real payment/initiated
    // transfer still belongs in the customer's records even on a legacy job
    // without invoice_first_sent_at.
    if (!row.invoice_first_sent_at && !inst.some(item => item.sent_at) && !paid.length && !pending.length) return null;
    return invoiceSummary(row, jobsById.get(row.id), inst, paid, pending, today);
  }).filter(Boolean).sort((a, b) => String(b.issued_at || '').localeCompare(String(a.issued_at || '')) || a.id.localeCompare(b.id));
}

async function loadBundle(db, token, now) {
  const bundle = await db('POST', '/rpc/get_portal_data', { p_token: token });
  if (!bundle || !validId(bundle.customer?.id)) return null;
  if (!Array.isArray(bundle.jobs)) throw new Error('Invalid portal job dataset');
  const customerId = bundle.customer.id;
  const brandKey = bundle.customer.company === 'finishing-touch' ? 'finishing-touch' : 'prescott-epoxy';
  const [ownedJobs, leads, settingRows, brandRows] = await Promise.all([
    readAll(db, `/jobs?customer_id=${eq(customerId)}&select=id,customer_id,archived_at,voided_at,dripjobs_deal_id,public_token_revoked_at,package,address&order=id.asc`),
    readAll(db, `/leads?customer_id=${eq(customerId)}&deleted_at=is.null&select=id,customer_id,deleted_at&order=id.asc`),
    db('GET', `/settings?key=in.(${SETTINGS.join(',')})&select=key,value`),
    db('GET', `/pec_brand_identity?brand=${eq(brandKey)}&select=${BRAND_COLUMNS}&limit=1`),
  ]);
  if (!Array.isArray(settingRows) || !Array.isArray(brandRows)) throw new Error('Invalid portal configuration');
  // Historical shared quotes keep their explicit job ownership even when
  // that project is archived or voided. Current projects and /pay invoices
  // retain the existing active-only boundary.
  const allOwned = ownedJobs.filter(job => validId(job.id) && job.customer_id === customerId);
  const owned = allOwned.filter(job => !job.archived_at && !job.voided_at);
  const ownedIds = idSet(owned);
  const jobs = (Array.isArray(bundle.jobs) ? bundle.jobs : []).filter(job => ownedIds.has(job.id)).map(portalJob);
  const settings = Object.fromEntries((Array.isArray(settingRows) ? settingRows : []).filter(row => SETTINGS.includes(row.key)).map(row => [row.key, row.value]));
  const brand = (Array.isArray(brandRows) ? brandRows : []).find(row => row.brand === brandKey) || {};
  const paint = brandKey === 'finishing-touch';
  const config = {
    referrals_enabled: settings.customer_portal_referrals_enabled !== 'false',
    reviews_enabled: settings.customer_portal_reviews_enabled !== 'false',
    google_review_url: reviewUrl(settings[paint ? 'google_review_link_paint' : 'google_review_link_epoxy'], 'google'),
    yelp_review_url: reviewUrl(settings[paint ? 'portal_yelp_link_paint' : 'portal_yelp_link_epoxy'], 'yelp'),
  };
  const rawReward = settings.referral_reward_amount ?? bundle.referral_reward_amount ?? 50;
  const reward = Number.isFinite(Number(rawReward)) && Number(rawReward) >= 0 ? round2(rawReward) : 50;
  const [estimates, invoices, referrals] = await Promise.all([
    loadEstimates(db, customerId, allOwned, leads.filter(lead => lead.customer_id === customerId && !lead.deleted_at)),
    loadInvoices(db, customerId, owned, jobs, phoenixDay(now.toISOString())),
    config.referrals_enabled ? readAll(db, `/referrals?customer_id=${eq(customerId)}&select=id,customer_id,friend_name,service_interest,status,payment_amount,paid_at,created_at&order=id.asc`) : [],
    loadSchedule(db, customerId, owned, jobs),
    loadJobSignatures(db, customerId, jobs),
  ]);
  return {
    customer: only(bundle.customer, CUSTOMER_FIELDS), jobs, estimates, invoices,
    referrals: referrals.filter(row => row.customer_id === customerId).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(row => ({
      ...only(row, ['id', 'friend_name', 'service_interest', 'status', 'paid_at', 'created_at']),
      reward_amount: row.payment_amount == null ? null : round2(row.payment_amount),
    })),
    referral_reward_amount: reward, config,
    brand: {
      business_name: text(brand.business_name) || (paint ? 'Finishing Touch Painting' : 'Prescott Epoxy Company'),
      phone: text(brand.phone), website: webUrl(brand.website),
      logo_url: publicAsset(brand.logo_url) || (paint ? null : '/assets/pec-logo.png'),
      license_number: text(brand.license_number), address_line: text(brand.address_line),
      primary_color: /^#[0-9a-f]{6}$/i.test(brand.primary_color) ? brand.primary_color : '#14181C',
      accent_color: /^#[0-9a-f]{6}$/i.test(brand.accent_color) ? brand.accent_color : '#D8531C',
    },
  };
}

function createHandler(deps = {}) {
  const sourceDb = deps.sb || sb;
  const db = async (method, path, payload) => {
    try { return await sourceDb(method, path, payload, { timeoutMs: 8000 }); }
    catch (error) {
      // Only static resource names and protocol codes may reach diagnostics.
      // Never retain a query, payload, database message or customer identifier.
      const resource = path.split('?')[0];
      const diagnostic = new Error('Portal read failed');
      diagnostic.portalRead = {
        resource: /^\/(?:rpc\/)?[a-z_]+$/.test(resource) ? resource : 'unknown',
        http: String(error?.message || '').match(/failed \((\d{3})\)/)?.[1] || null,
        code: String(error?.message || '').match(/"code"\s*:\s*"([A-Z0-9]{5,12})"/)?.[1] || null,
      };
      throw diagnostic;
    }
  };
  const reportError = deps.reportError || (diagnostic => console.error('customer_portal_read_failed', diagnostic));
  const now = deps.now || (() => new Date());
  return async event => {
    const method = event.httpMethod || 'GET';
    if (!['GET', 'POST'].includes(method)) return response(405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
    let token;
    if (method === 'POST') {
      if (typeof event.body !== 'string' || Buffer.byteLength(event.body) > 4096) return response(400, { error: 'Invalid portal request.' });
      try {
        const body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
        token = body && body.token;
      } catch (_) { return response(400, { error: 'Invalid portal request.' }); }
    } else token = event.queryStringParameters?.token;
    if (typeof token !== 'string' || !TOKEN.test(token)) return response(404, { error: 'Portal not found. Check your link.' });
    try {
      const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
      const connection = String(headers['x-nf-client-connection-ip'] || String(headers['x-forwarded-for'] || '').split(',')[0] || 'unknown-connection').slice(0, 256);
      for (const [scope, key] of [['customer_portal_ip', hash(connection)], ['customer_portal_token', hash(token)]]) {
        const quota = await takeBookingRateLimit(db, scope, key, 120, 3600);
        if (!quota.allowed) return response(429, { error: 'Please wait a little before refreshing your portal.' }, { 'Retry-After': String(Math.max(1, Math.ceil(quota.retry_after))) });
      }
      const bundle = await loadBundle(db, token, now());
      return bundle ? response(200, bundle) : response(404, { error: 'Portal not found. Check your link.' });
    } catch (error) {
      // Database errors can include bearer tokens in query paths. Return and
      // log no raw error text; a failed read must never look like $0 due.
      reportError(error?.portalRead || { resource: 'projection', http: null, code: null });
      return response(503, { error: 'We could not load your portal. Please try again or contact the office.' });
    }
  };
}

module.exports = { handler: createHandler(), createHandler, invoiceSummary };
