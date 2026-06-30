// Send an SMS to a customer through Quo (the rebrand of OpenPhone).
// The QUO_API_KEY lives ONLY in Netlify env; the browser never sees it.
// Flow: validate the caller's Supabase JWT -> resolve the brand's Quo number
// (pec_sms_senders) -> resolve + E.164-normalize the recipient -> CHECK the
// customer's sms_opt_out consent -> build the body for the kind (invoice /
// manual / estimate) -> POST to Quo -> write a pec_sms_log row (service role).
// Every outcome, success or failure, writes a log row so the UI thread is
// complete. This mirrors pec-send-email.cjs one-for-one; the SMS stack is a
// parallel build, not a new pattern.
//
// Input JSON: { brand, to_number?, customer_id?, job_id?, kind, body?, estimate_token? }
//   kind=invoice  -> body built from the AR row (pay link), customer_id/job_id resolved.
//   kind=manual   -> staff-provided `body` sent verbatim (trimmed, length-guarded).
//   kind=estimate -> STUB. Dormant until a real estimate token is supplied.
//
// Compliance: A2P 10DLC is approved on the account, so deliverability is not a
// code concern, but the opt-out guard below is non-negotiable and every send
// carries a "Reply STOP to opt out" line.

const { sb } = require('./_pec-supabase.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUO_API_KEY = process.env.QUO_API_KEY;
const SITE_URL = process.env.URL || 'https://prescottepoxy.netlify.app';

// Quo (OpenPhone) messages endpoint. Quo uses the RAW key in the Authorization
// header (NOT a Bearer prefix). Confirm against https://www.quo.com/docs.
const QUO_MESSAGES_URL = 'https://api.openphone.com/v1/messages';

// Hard cap a single text at 1600 chars (~10 SMS segments) so a runaway manual
// body can never burn a pile of prepaid credits in one send.
const MAX_SMS_LEN = 1600;

// Brand -> business name fallback, used when pec_brand_identity has no row for
// the brand (only prescott-epoxy is seeded there today). KEEP the keys aligned
// with pec_sms_senders / customers.company.
const BRAND_NAME = {
  'prescott-epoxy': 'Prescott Epoxy Company',
  'finishing-touch': 'Finishing Touch',
};

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
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Normalize a phone string to E.164 (US default). Returns null if it cannot be
// made into a plausible number. Mirror this logic in the inbound webhook so the
// numbers we store match on both sides.
function toE164(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15 ? '+' + digits : null;
  }
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;          // bare US 10-digit
  if (d.length === 11 && d.startsWith('1')) return '+' + d; // 1 + 10-digit
  if (d.length >= 11 && d.length <= 15) return '+' + d;     // already country-coded
  return null;
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
    const out = await sb('POST', '/pec_sms_log', row, true);
    return Array.isArray(out) && out[0] ? out[0].id : null;
  } catch (e) { console.error('pec-send-sms: log insert failed', e.message); return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { ok: false, error: 'Method not allowed' });

  // Auth: require a valid Supabase JWT.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const user = await getUser(token);
  if (!user || !user.id) return jc(401, { ok: false, error: 'Not authenticated' });

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { ok: false, error: 'Invalid JSON' }); }

  const { brand, to_number = null, customer_id = null, job_id = null,
          kind = 'manual', body: rawBody = null, estimate_token = null } = input;
  if (!brand) return jc(400, { ok: false, error: 'brand is required' });
  const VALID_KINDS = ['invoice', 'manual', 'estimate'];
  if (!VALID_KINDS.includes(kind)) return jc(400, { ok: false, error: `kind must be one of ${VALID_KINDS.join(', ')}` });

  // Env guard: surface a clean 503 and still record the attempt.
  if (!QUO_API_KEY) {
    await logRow({ direction: 'out', brand, customer_id, job_id, kind, status: 'failed', sent_by_user: user.id, error_message: 'QUO_API_KEY not configured' });
    return jc(503, { ok: false, error: 'Texting is not configured yet (QUO_API_KEY missing). Ask Dylan to set the Netlify env var.' });
  }

  try {
    // Rate limit: hard cap 50 outbound sends per user per hour (Supabase counter,
    // reliable across function instances). Mirrors the email function.
    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = await sb('GET', `/pec_sms_log?direction=eq.out&sent_by_user=eq.${encodeURIComponent(user.id)}&created_at=gte.${encodeURIComponent(sinceIso)}&select=id`);
    if (Array.isArray(recent) && recent.length >= 50) {
      return jc(429, { ok: false, error: 'Rate limit reached (50 texts/hour). Try again later.' });
    }

    // Brand sender -> the Quo "from" number.
    const senders = await sb('GET', `/pec_sms_senders?brand=eq.${encodeURIComponent(brand)}&active=eq.true&select=*&limit=1`);
    const sender = Array.isArray(senders) ? senders[0] : null;
    if (!sender || !sender.from_number) return jc(400, { ok: false, error: `No active SMS sender configured for brand "${brand}".` });
    const fromNumber = sender.from_number;

    // Resolve the customer (for the phone fallback AND the opt-out check). If a
    // job_id is given we also use it to pull the customer_id from the AR row.
    let custId = customer_id;
    let customer = null;
    if (!custId && job_id) {
      const arForCust = await sb('GET', `/pec_job_ar?id=eq.${encodeURIComponent(job_id)}&select=customer_id&limit=1`);
      if (Array.isArray(arForCust) && arForCust[0]) custId = arForCust[0].customer_id;
    }
    if (custId) {
      const custRows = await sb('GET', `/customers?id=eq.${encodeURIComponent(custId)}&select=id,name,phone,sms_opt_out&limit=1`);
      customer = Array.isArray(custRows) ? custRows[0] : null;
    }

    // Recipient: explicit to_number wins, else the customer's phone.
    const recipient = toE164(to_number || (customer && customer.phone));
    if (!recipient) {
      await logRow({ direction: 'out', brand, from_number: fromNumber, customer_id: custId, job_id, kind, status: 'failed', sent_by_user: user.id, error_message: 'No valid recipient phone number' });
      return jc(400, { ok: false, error: 'No valid phone number for this recipient.' });
    }

    // COMPLIANCE GUARD: never text an opted-out customer. Nothing is sent and
    // nothing is logged as sent (we log the refusal as a failed row for audit).
    if (customer && customer.sms_opt_out) {
      await logRow({ direction: 'out', brand, from_number: fromNumber, to_number: recipient, customer_id: custId, job_id, kind, status: 'failed', sent_by_user: user.id, error_message: 'Customer has opted out of texts' });
      return jc(409, { ok: false, error: 'This customer has opted out of texts (replied STOP). You cannot text them.' });
    }

    const businessName = BRAND_NAME[brand] || sender.brand || 'Prescott Epoxy Company';
    const STOP_LINE = ' Reply STOP to opt out.';

    // Build the message body for the kind.
    let messageBody = '';
    if (kind === 'invoice') {
      if (!job_id) return jc(400, { ok: false, error: 'job_id is required for an invoice text.' });
      // Pull the rolled-up AR row, same source the email invoice uses, incl. the
      // public_token for the pay link (/pay/<token>).
      const arRows = await sb('GET', `/pec_job_ar?id=eq.${encodeURIComponent(job_id)}&select=customer_name,price,balance_remaining,hq_invoice_number,dripjobs_deal_id,public_token&limit=1`);
      const ar = Array.isArray(arRows) ? arRows[0] : null;
      if (!ar) return jc(400, { ok: false, error: 'Invoice not found for that job.' });
      if (!ar.public_token) return jc(400, { ok: false, error: 'This invoice has no public link yet (run the brand/public-invoice migration).' });
      const invNo = ar.hq_invoice_number || ar.dripjobs_deal_id || String(job_id).slice(0, 8);
      const total = usd(ar.price);
      const payUrl = `${SITE_URL}/pay/${ar.public_token}`;
      // Short, 1-2 segment transactional body with the identified sender + pay link.
      messageBody = `${businessName}: Your invoice ${invNo} for ${total} is ready. View and pay: ${payUrl}.${STOP_LINE}`;
    } else if (kind === 'estimate') {
      // STUB. The sales/estimator-texting flow does not exist yet. The path is
      // WIRED (kind accepted, sender + recipient + opt-out all resolved) but
      // guarded: without a real estimate token there is nothing legitimate to
      // link, so we refuse rather than fake data.
      // >>> SEAM: when the estimator sales flow ships, look up the estimate by
      // estimate_token, build `${SITE_URL}/estimate/<token>` (or the real public
      // estimate URL), and compose the body here. Until then this stays dormant.
      if (!estimate_token) {
        return jc(501, { ok: false, error: 'Estimate texting is not enabled yet. It turns on when the estimator sales flow ships.' });
      }
      // Defensive: even if a token is passed today, there is no estimate store to
      // validate it against, so do not pretend. Remove this block when the seam
      // above is built.
      return jc(501, { ok: false, error: 'Estimate texting is not enabled yet (no estimate link source wired).' });
    } else { // manual
      const trimmed = String(rawBody || '').trim();
      if (!trimmed) return jc(400, { ok: false, error: 'Message body is empty.' });
      if (trimmed.length > MAX_SMS_LEN) return jc(400, { ok: false, error: `Message is too long (max ${MAX_SMS_LEN} characters).` });
      messageBody = trimmed; // verbatim; staff is responsible for STOP/compliance in free text
    }

    // Send via Quo. NON-IDEMPOTENT: a timeout here is NOT retried automatically
    // (same rule as payments). We surface the failure and let staff retry; the
    // log is the dedupe record.
    const payload = { content: messageBody, from: fromNumber, to: [recipient] };
    const res = await fetch(QUO_MESSAGES_URL, {
      method: 'POST',
      headers: { Authorization: QUO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const resBody = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = (resBody && (resBody.message || (resBody.error && (resBody.error.message || resBody.error)) || resBody.errors)) || `Quo error ${res.status}`;
      await logRow({ direction: 'out', brand, from_number: fromNumber, to_number: recipient, customer_id: custId, job_id, body: messageBody, kind, status: 'failed', sent_by_user: user.id, error_message: String(JSON.stringify(msg)).slice(0, 500) });
      return jc(502, { ok: false, error: `Could not send text: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}` });
    }

    // Quo returns the created message under data.id (tolerate a flat id too).
    const quoId = (resBody && resBody.data && resBody.data.id) || resBody.id || null;
    const logId = await logRow({
      direction: 'out', brand, from_number: fromNumber, to_number: recipient,
      customer_id: custId, job_id, body: messageBody, kind, status: 'sent',
      quo_message_id: quoId, sent_by_user: user.id,
    });
    return jc(200, { ok: true, log_id: logId, quo_message_id: quoId });
  } catch (err) {
    console.error('pec-send-sms error:', err.message);
    await logRow({ direction: 'out', brand, customer_id, job_id, kind, status: 'failed', sent_by_user: user.id, error_message: String(err.message).slice(0, 500) });
    return jc(500, { ok: false, error: 'Send failed. Please try again.' });
  }
};
