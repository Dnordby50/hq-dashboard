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

module.exports = { sb, json, badSecret, randomToken, epoxyStages, paintStages };
