// Quo (OpenPhone) inbound webhook -> two-way texting + STOP handling + call log.
// Routed at /api/quo/webhook (netlify.toml). Quo POSTs here when a customer
// texts one of our workspace numbers. We:
//   1. Verify the request is really from Quo (QUO_WEBHOOK_SECRET).
//   2. Match the sender's number to a customer (phone, normalized).
//   3. Insert a pec_sms_log row (direction in, status received).
//   4. Handle STOP / START so the CRM's own opt-out state stays in sync with
//      the carrier-level STOP that Quo already enforces.
//
// CALL EVENTS (2026-07-06, Dylan: call summaries on the customer profile):
// the same webhook also ingests three call events into pec_call_log, keyed on
// the Quo call id so they can arrive in ANY order, each PATCHing in what it
// knows (insert-on-first-arrival):
//   call.completed            -> base row: direction, numbers, duration, when,
//                                brand, matched customer
//   call.summary.completed    -> Quo's AI summary + next steps
//   call.transcript.completed -> the dialogue turns (jsonb)
// The customer profile's Calls card reads pec_call_log by customer_id.
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

// Match a customer by phone. Customers store phone in varied formats, so we
// match on the normalized E.164 AND the bare 10-digit tail as a fallback,
// re-normalizing candidates so a partial digit-run can't false-match. Shared
// by the message path and the call path so both attribute identically.
async function matchCustomerByPhone(e164) {
  if (!e164) return null;
  const exact = await sb('GET', `/customers?phone=eq.${encodeURIComponent(e164)}&select=id,sms_opt_out&limit=1`);
  if (Array.isArray(exact) && exact[0]) return exact[0];
  const tail = e164.replace(/\D/g, '').slice(-10);
  // PostgREST: phone contains the 10-digit tail (handles (928) 555-1234 etc.)
  const fuzzy = await sb('GET', `/customers?phone=like.*${encodeURIComponent(tail)}*&select=id,phone,sms_opt_out&limit=2`);
  if (Array.isArray(fuzzy)) return fuzzy.find(c => toE164(c.phone) === e164) || null;
  return null;
}

// Brand from OUR workspace number (the pec_sms_senders map, same as texting).
async function brandForOurNumber(e164) {
  if (!e164) return null;
  const senders = await sb('GET', `/pec_sms_senders?from_number=eq.${encodeURIComponent(e164)}&select=brand&limit=1`);
  return (Array.isArray(senders) && senders[0]) ? senders[0].brand : null;
}

// Upsert a pec_call_log row keyed on quo_call_id: PATCH what this event knows
// onto the existing row, else INSERT a fresh one. Events arrive in any order
// (summary can beat call.completed); each fills only its own fields, so no
// event can null out another's work. The unique index on quo_call_id is the
// backstop if two events race their inserts; the loser re-PATCHes.
async function upsertCall(quoCallId, fields) {
  if (!quoCallId) return;
  const q = `/pec_call_log?quo_call_id=eq.${encodeURIComponent(quoCallId)}`;
  const patched = await sb('PATCH', q, fields, true);
  if (Array.isArray(patched) && patched.length) return;
  try {
    await sb('POST', '/pec_call_log', { quo_call_id: quoCallId, ...fields });
  } catch (e) {
    if (/duplicate|23505|409/.test(String(e.message || ''))) { await sb('PATCH', q, fields, true); return; }
    throw e;
  }
}

// Handle the three call events. Field extraction is deliberately tolerant of
// payload shape drift (from/to strings vs a participants array; summary as an
// array of lines vs one string) so a Quo API change degrades to sparse rows,
// never to a hard failure that makes Quo retry.
async function handleCallEvent(type, payload) {
  const obj = (payload.data && (payload.data.object || payload.data)) || payload.object || {};
  if (/summary/i.test(type)) {
    const summary = Array.isArray(obj.summary) ? obj.summary.join('\n') : (obj.summary || null);
    const nextSteps = Array.isArray(obj.nextSteps) ? obj.nextSteps.join('\n') : (obj.nextSteps || null);
    const fields = {};
    if (summary) fields.summary = summary;
    if (nextSteps) fields.next_steps = nextSteps;
    if (Object.keys(fields).length) await upsertCall(obj.callId || obj.id, fields);
    return;
  }
  if (/transcript/i.test(type)) {
    const dialogue = Array.isArray(obj.dialogue) ? obj.dialogue : null;
    const fields = {};
    if (dialogue) fields.transcript = dialogue;
    if (Number(obj.duration) > 0) fields.duration_seconds = Number(obj.duration);
    if (Object.keys(fields).length) await upsertCall(obj.callId || obj.id, fields);
    return;
  }
  // call.completed (or any other call.* lifecycle event carrying the call object)
  const callId = obj.id || obj.callId;
  if (!callId) return;
  const direction = /out/i.test(obj.direction || '') ? 'out' : 'in';
  let from = obj.from, to = obj.to;
  if (Array.isArray(to)) to = to[0];
  if (!from && Array.isArray(obj.participants)) from = obj.participants[0];
  if (!to && Array.isArray(obj.participants)) to = obj.participants[1];
  const fromN = toE164(from), toN = toE164(to);
  const ourNum = direction === 'in' ? toN : fromN;     // our workspace number
  const custNum = direction === 'in' ? fromN : toN;    // the customer's number
  const customer = await matchCustomerByPhone(custNum).catch(() => null);
  const brand = await brandForOurNumber(ourNum).catch(() => null);
  const durationSec = Number(obj.duration) > 0 ? Number(obj.duration)
    : (obj.answeredAt && obj.completedAt ? Math.max(0, Math.round((new Date(obj.completedAt) - new Date(obj.answeredAt)) / 1000)) : null);
  const fields = {
    direction,
    from_number: fromN || from || null,
    to_number: toN || to || null,
    occurred_at: obj.createdAt || obj.answeredAt || obj.completedAt || new Date().toISOString(),
    status: obj.status || 'completed',
  };
  if (customer) fields.customer_id = customer.id;
  if (brand) fields.brand = brand;
  if (durationSec != null) fields.duration_seconds = durationSec;
  await upsertCall(callId, fields);
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
    const evType = String(payload.type || payload.event || '');

    // Call events peel off first; everything below is the message path.
    if (/^call\./i.test(evType)) {
      await handleCallEvent(evType, payload);
      return json(200, { success: true });
    }

    const msg = parseInbound(payload);

    // Only act on INBOUND messages. Quo also fires events for outbound + delivery;
    // outbound is already logged by pec-send-sms, so ignore non-inbound here.
    const isInbound = /received|incoming|message\.received/i.test(msg.type) || /incoming|inbound/i.test(msg.direction);
    if (!isInbound || !msg.from) return json(200, { success: true, ignored: 'not an inbound message' });

    const fromE164 = toE164(msg.from);   // customer
    const toE164Num = toE164(msg.to);    // our workspace number (brand)
    const bodyTrimmed = msg.body.trim();

    // Brand: which of our numbers received this text.
    const brand = await brandForOurNumber(toE164Num).catch(() => null);

    // Match the customer by phone (shared helper; also used by the call path).
    const customer = fromE164 ? await matchCustomerByPhone(fromE164).catch(() => null) : null;

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
