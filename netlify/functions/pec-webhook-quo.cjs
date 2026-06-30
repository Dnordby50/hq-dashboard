// Quo (OpenPhone) inbound webhook -> two-way texting + STOP handling.
// Routed at /api/quo/webhook (netlify.toml). Quo POSTs here when a customer
// texts one of our workspace numbers. We:
//   1. Verify the request is really from Quo (QUO_WEBHOOK_SECRET).
//   2. Match the sender's number to a customer (phone, normalized).
//   3. Insert a pec_sms_log row (direction in, status received).
//   4. Handle STOP / START so the CRM's own opt-out state stays in sync with
//      the carrier-level STOP that Quo already enforces.
//
// Defensive by design: this NEVER throws back to Quo in a way that makes it
// retry forever. Handled events return 200 even on a soft failure (we log and
// move on). Follows the verify-then-200 shape of pec-webhook-resend.cjs, but
// for inbound messages instead of delivery events.

const crypto = require('crypto');
const { sb, json } = require('./_pec-supabase.cjs');

const WEBHOOK_SECRET = process.env.QUO_WEBHOOK_SECRET;

// STOP/START keyword sets (case-insensitive, trimmed, exact-word match). These
// mirror the carrier-standard opt-out keywords Quo also honors.
const STOP_WORDS = new Set(['stop', 'unsubscribe', 'cancel', 'end', 'quit', 'stopall']);
const START_WORDS = new Set(['start', 'unstop', 'yes', 'unsubscribe_no', 'resume']);

// Mirror pec-send-sms.cjs toE164 EXACTLY so stored numbers match on both sides.
function toE164(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15 ? '+' + digits : null;
  }
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  if (d.length >= 11 && d.length <= 15) return '+' + d;
  return null;
}

const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

// Verify the request is from Quo. Two accepted mechanisms, both keyed on
// QUO_WEBHOOK_SECRET, so whichever Quo's webhook config offers will work:
//   (a) HMAC signature (OpenPhone style): the `openphone-signature` header holds
//       `hmac;<version>;<timestamp>;<base64sig>`, where sig = HMAC-SHA256 over
//       `${timestamp}.${rawBody}` with the base64-decoded signing key.
//   (b) Shared secret: an `x-quo-secret` / `x-webhook-secret` header equal to
//       QUO_WEBHOOK_SECRET (used if the workspace is set up with a plain secret).
// Confirm the exact scheme against https://www.quo.com/docs and keep whichever
// one Quo actually sends.
function verifyQuo(headers, rawBody) {
  if (!WEBHOOK_SECRET) return false;

  // (b) plain shared-secret header.
  const plain = headers['x-quo-secret'] || headers['x-webhook-secret'] || headers['X-Quo-Secret'] || headers['X-Webhook-Secret'];
  if (plain && safeEqual(plain, WEBHOOK_SECRET)) return true;

  // (a) HMAC signature header.
  const sigHeader = headers['openphone-signature'] || headers['OpenPhone-Signature'] || headers['quo-signature'] || headers['x-quo-signature'];
  if (sigHeader) {
    const parts = String(sigHeader).split(';');
    // Tolerate either `hmac;ver;ts;sig` or a bare `ts;sig` / `sig`.
    const sig = parts[parts.length - 1];
    const ts = parts.length >= 3 ? parts[parts.length - 2] : '';
    if (!sig) return false;
    let key;
    try { key = Buffer.from(WEBHOOK_SECRET, 'base64'); }
    catch (_) { key = Buffer.from(WEBHOOK_SECRET); }
    const signedData = ts ? `${ts}.${rawBody}` : rawBody;
    const expected = crypto.createHmac('sha256', key).update(signedData).digest('base64');
    if (safeEqual(sig, expected)) return true;
    // Also try the raw (non-base64) secret, in case Quo signs with the literal key.
    const expectedRaw = crypto.createHmac('sha256', Buffer.from(WEBHOOK_SECRET)).update(signedData).digest('base64');
    if (safeEqual(sig, expectedRaw)) return true;
  }
  return false;
}

// Pull the inbound message fields out of Quo's payload, tolerant of nesting.
// OpenPhone shape: { type, data: { object: { id, from, to, body|text, direction } } }.
function parseInbound(payload) {
  const type = payload.type || payload.event || '';
  const obj = (payload.data && (payload.data.object || payload.data)) || payload.object || payload.message || {};
  // `to` may be a string or an array of recipients; take the first.
  let to = obj.to;
  if (Array.isArray(to)) to = to[0];
  const fromNum = obj.from || obj.fromNumber || null;
  const body = obj.body != null ? obj.body : (obj.text != null ? obj.text : (obj.content || ''));
  const direction = obj.direction || obj.kind || '';
  return {
    type,
    quoMessageId: obj.id || obj.messageId || null,
    from: fromNum,
    to: to || obj.phoneNumber || null,
    body: String(body || ''),
    direction,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });

  // Verify against the EXACT raw body Quo signed.
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  if (!verifyQuo(event.headers || {}, rawBody)) return json(401, { success: false, error: 'Invalid signature' });

  let payload;
  try { payload = JSON.parse(rawBody || '{}'); }
  catch { return json(200, { success: true, ignored: 'unparseable body' }); }

  try {
    const msg = parseInbound(payload);

    // Only act on INBOUND messages. Quo also fires events for outbound + delivery;
    // outbound is already logged by pec-send-sms, so ignore non-inbound here.
    const isInbound = /received|incoming|message\.received/i.test(msg.type) || /incoming|inbound/i.test(msg.direction);
    if (!isInbound || !msg.from) return json(200, { success: true, ignored: 'not an inbound message' });

    const fromE164 = toE164(msg.from);   // customer
    const toE164Num = toE164(msg.to);    // our workspace number (brand)
    const bodyTrimmed = msg.body.trim();

    // Brand: which of our numbers received this text.
    let brand = null;
    if (toE164Num) {
      const senders = await sb('GET', `/pec_sms_senders?from_number=eq.${encodeURIComponent(toE164Num)}&select=brand&limit=1`);
      if (Array.isArray(senders) && senders[0]) brand = senders[0].brand;
    }

    // Match the customer by phone. Customers store phone in varied formats, so we
    // match on the normalized E.164 AND the bare 10-digit tail as a fallback.
    let customer = null;
    if (fromE164) {
      const exact = await sb('GET', `/customers?phone=eq.${encodeURIComponent(fromE164)}&select=id,sms_opt_out&limit=1`);
      if (Array.isArray(exact) && exact[0]) customer = exact[0];
      if (!customer) {
        const tail = fromE164.replace(/\D/g, '').slice(-10);
        // PostgREST: phone contains the 10-digit tail (handles (928) 555-1234 etc.)
        const fuzzy = await sb('GET', `/customers?phone=like.*${encodeURIComponent(tail)}*&select=id,phone,sms_opt_out&limit=2`);
        // Re-normalize candidates so a partial digit-run can't false-match.
        if (Array.isArray(fuzzy)) customer = fuzzy.find(c => toE164(c.phone) === fromE164) || null;
      }
    }

    // 1. Log the inbound message (best-effort; never blocks STOP handling).
    await sb('POST', '/pec_sms_log', {
      direction: 'in', brand, from_number: fromE164 || msg.from, to_number: toE164Num || msg.to,
      customer_id: customer ? customer.id : null, body: bodyTrimmed, kind: 'system',
      status: 'received', quo_message_id: msg.quoMessageId,
    }).catch(e => console.error('pec-webhook-quo: log insert failed', e.message));

    // 2. STOP / START. Only the first word matters for the keyword check (carriers
    // treat "STOP please" as STOP). Update the matched customer's consent flags.
    const firstWord = bodyTrimmed.toLowerCase().split(/\s+/)[0] || '';
    if (customer && STOP_WORDS.has(firstWord)) {
      await sb('PATCH', `/customers?id=eq.${encodeURIComponent(customer.id)}`, { sms_opt_out: true, sms_opt_out_at: new Date().toISOString() })
        .catch(e => console.error('pec-webhook-quo: opt-out set failed', e.message));
    } else if (customer && START_WORDS.has(firstWord)) {
      await sb('PATCH', `/customers?id=eq.${encodeURIComponent(customer.id)}`, { sms_opt_out: false, sms_opt_out_at: null })
        .catch(e => console.error('pec-webhook-quo: opt-in clear failed', e.message));
    }

    return json(200, { success: true });
  } catch (err) {
    // Never throw back to Quo; log and 200 so it does not retry forever.
    console.error('pec-webhook-quo error:', err.message);
    return json(200, { success: false, error: 'handled' });
  }
};
