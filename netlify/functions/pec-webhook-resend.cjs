// Resend webhook -> updates pec_email_log delivery events.
// Resend signs webhooks with Svix (svix-id / svix-timestamp / svix-signature
// headers; HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`, base64, key is the
// base64 part of the whsec_ secret). We verify that signature, then PATCH the
// matching log row by resend_id (= data.email_id). 200s fast and never throws
// back to Resend. Follows the early-return shape of pec-webhook-stage-changed.cjs
// but with real Svix verification instead of the plain x-webhook-secret compare.

const crypto = require('crypto');
const { sb, json } = require('./_pec-supabase.cjs');

const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

function verifySvix(headers, rawBody) {
  const id = headers['svix-id'];
  const ts = headers['svix-timestamp'];
  const sigHeader = headers['svix-signature'];
  if (!WEBHOOK_SECRET || !id || !ts || !sigHeader) return false;
  let key;
  try { key = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64'); }
  catch (_) { return false; }
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
  const expBuf = Buffer.from(expected);
  // The header is a space-delimited list of `v1,<signature>` entries.
  return String(sigHeader).split(' ').some(part => {
    const sig = part.includes(',') ? part.split(',')[1] : part;
    if (!sig) return false;
    const sigBuf = Buffer.from(sig);
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });

  // Verify against the EXACT raw body Resend signed.
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  if (!verifySvix(event.headers, rawBody)) return json(401, { success: false, error: 'Invalid signature' });

  try {
    const payload = JSON.parse(rawBody || '{}');
    const type = payload.type || '';
    const resendId = payload.data && payload.data.email_id;
    if (!resendId) return json(200, { success: true, ignored: 'no email_id' });

    const at = payload.created_at || (payload.data && payload.data.created_at) || new Date().toISOString();
    let updates = null;
    if (type === 'email.delivered') updates = { status: 'delivered' };
    else if (type === 'email.opened') updates = { status: 'opened', opened_at: at };
    else if (type === 'email.clicked') updates = { status: 'clicked', clicked_at: at };
    else if (type === 'email.bounced') updates = { status: 'bounced', bounced_at: at };
    else if (type === 'email.complained') updates = { status: 'complained' };

    if (updates) {
      await sb('PATCH', `/pec_email_log?resend_id=eq.${encodeURIComponent(resendId)}`, updates);
    }
    return json(200, { success: true });
  } catch (err) {
    // Never throw back to Resend; just log and 200 so it does not retry forever.
    console.error('pec-webhook-resend error:', err.message);
    return json(200, { success: false, error: 'handled' });
  }
};
