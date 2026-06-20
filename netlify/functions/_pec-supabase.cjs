// Shared helpers for pec-webhook-* Netlify Functions.
// Uses the service-role key to bypass RLS. Set these env vars in Netlify:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PEC_WEBHOOK_SECRET
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PEC_WEBHOOK_SECRET = process.env.PEC_WEBHOOK_SECRET;

const epoxyStages = [
  'Proposal Accepted', 'Scheduled', 'Prep Day', 'Coating Day',
  'Cure Period', 'Final Walkthrough', 'Complete',
];
const paintStages = [
  'Proposal Accepted', 'Scheduled', 'Prep', 'Prime',
  'Paint', 'Final Walkthrough', 'Complete',
];

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function badSecret(event) {
  const got = event.headers['x-webhook-secret'] || event.headers['X-Webhook-Secret'];
  if (!PEC_WEBHOOK_SECRET || !got) return true;
  return got !== PEC_WEBHOOK_SECRET;
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function sb(method, path, payload, returnRow) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase env vars not configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)');
  }
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (returnRow) headers['Prefer'] = 'return=representation';

  const res = await fetch(url, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${text}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// Best-effort ingestion logger. Writes one row to pec_webhook_ingest_log per
// inbound webhook attempt so partial/rejected/errored deliveries are queryable
// (the "DripJobs Sync Health" view reads this). CRITICAL: this must NEVER throw
// or change the handler's response -- a logging failure (table missing before
// the migration lands, network blip, bad field) is swallowed entirely. Uses the
// service-role sb() client, which bypasses RLS. Fire-and-forget but awaited so
// the lambda does not freeze before the write lands.
async function logIngest(fields) {
  try {
    await sb('POST', '/pec_webhook_ingest_log', {
      endpoint: fields.endpoint || null,
      deal_id: fields.deal_id != null ? String(fields.deal_id) : null,
      customer_name: fields.customer_name || null,
      company: fields.company || null,
      outcome: fields.outcome,            // 'ok' | 'rejected' | 'error' | 'bridge_failed'
      status_code: fields.status_code != null ? fields.status_code : null,
      message: fields.message != null ? String(fields.message).slice(0, 2000) : null,
      payload: fields.payload != null ? fields.payload : null,
      public_job_id: fields.public_job_id || null,
      prod_job_id: fields.prod_job_id || null,
    });
  } catch (logErr) {
    // Intentionally swallowed: the log is observability, never a gate on ingest.
    console.error('logIngest failed (non-fatal):', logErr && logErr.message ? logErr.message : logErr);
  }
}

module.exports = { sb, json, badSecret, randomToken, epoxyStages, paintStages, logIngest };
