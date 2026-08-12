// Google Calendar helper (prompt 37, Phase B). Shared by the OAuth pair
// (pec-google-oauth-start / -callback), pec-google-disconnect, the push
// (pec-appt-sync-push) and the pull (pec-google-calendar-pull).
//
// TRUST MODEL: tokens live ONLY in pec_sales_member_google_tokens (RLS on,
// zero policies = service-role only). Every function here runs server-side;
// the browser sees connection status through the client-readable roster
// flags (google_connected / google_email / google_calendar_id) and never a
// token. GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are Netlify env
// vars (Dylan handoff); nothing here is committed as a secret.
//
// CALENDAR MODEL (the locked-unless-Dylan-says-otherwise design): each
// member gets a dedicated secondary calendar named "TopCoat" in their own
// Google account, created on connect. TopCoat pushes into THAT calendar and
// pulls only THAT calendar, so full two-way sync can never ingest or mutate
// personal events on their primary calendar.

const crypto = require('crypto');

const SITE_URL = process.env.URL || 'https://prescottepoxy.netlify.app';
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';
const TOPCOAT_CAL_NAME = 'TopCoat';

const googleConfigured = () => !!(CLIENT_ID && CLIENT_SECRET);
const redirectUri = () => `${SITE_URL}/.netlify/functions/pec-google-oauth-callback`;

// Bounded fetch (the server-side cousin of the dashboard's timedFetch): no
// Google call may hold a lambda open past its budget.
async function timedFetch(url, opts = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

// ---------------------------------------------------------------------------
// Signed OAuth state: the callback arrives from Google with no staff JWT, so
// the HMAC-signed state is what proves the flow was started by our own
// authenticated start endpoint for that member. 15-minute expiry.
// ---------------------------------------------------------------------------
function signState(memberId) {
  const exp = Date.now() + 15 * 60 * 1000;
  const base = `${memberId}.${exp}`;
  const sig = crypto.createHmac('sha256', CLIENT_SECRET || 'unconfigured').update(base).digest('hex');
  return `${base}.${sig}`;
}
function verifyState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return null;
  const [memberId, exp, sig] = parts;
  const expect = crypto.createHmac('sha256', CLIENT_SECRET || 'unconfigured').update(`${memberId}.${exp}`).digest('hex');
  let okSig = false;
  try { okSig = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)); } catch (_) { okSig = false; }
  if (!okSig || Number(exp) < Date.now()) return null;
  return memberId;
}

function consentUrl(memberId) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    // calendar.events covers event read/write; calendar (full) is needed once
    // at connect time to create the dedicated TopCoat calendar, and
    // openid/email identify whose account was linked.
    scope: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events openid email',
    access_type: 'offline',
    prompt: 'consent', // guarantees a refresh_token even on re-connect
    state: signState(memberId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

async function exchangeCode(code) {
  const res = await timedFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri(), grant_type: 'authorization_code',
    }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
  return body; // { access_token, refresh_token?, expires_in, id_token, ... }
}

// The id_token's email claim. Decode-only, no signature verification: the
// token arrived over TLS directly from Google's token endpoint in the same
// response, so its origin is already authenticated.
function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return payload.email || null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Token store (service role only). GET-then-write instead of upsert because
// the shared sb() helper has fixed headers; connect/disconnect concurrency
// is effectively zero.
// ---------------------------------------------------------------------------
async function getTokenRow(sb, memberId) {
  const rows = await sb('GET', `/pec_sales_member_google_tokens?sales_member_id=eq.${encodeURIComponent(memberId)}&select=*&limit=1`);
  return (Array.isArray(rows) && rows[0]) || null;
}
async function saveTokenRow(sb, memberId, patch) {
  const existing = await getTokenRow(sb, memberId);
  if (existing) {
    await sb('PATCH', `/pec_sales_member_google_tokens?sales_member_id=eq.${encodeURIComponent(memberId)}`, patch);
  } else {
    await sb('POST', '/pec_sales_member_google_tokens', { sales_member_id: memberId, ...patch });
  }
}

// A dead refresh token (Google's invalid_grant: expired, revoked, or the
// OAuth app's Testing-mode 7-day lifetime) is permanent until the member
// re-consents; silently returning null here is how two weeks of auth failure
// went unnoticed (prompt 88). Flip the roster to an honest "needs reconnect"
// state: google_connected=false stops the push/pull from hammering a dead
// token, google_needs_reconnect=true makes Settings > Appointments show
// "Reconnect" instead of "Not connected", and ONE shared bell row goes out
// (the false->true transition is the once-guard; the flag is state, not a
// setting, per rule 12). Best-effort: a failure here never breaks the caller.
async function markNeedsReconnect(sb, memberId) {
  try {
    const rows = await sb('GET', `/pec_sales_team_members?id=eq.${encodeURIComponent(memberId)}&select=id,name,google_needs_reconnect&limit=1`);
    const m = Array.isArray(rows) && rows[0];
    if (!m || m.google_needs_reconnect) return; // already flagged (or gone): bell already rang
    await sb('PATCH', `/pec_sales_team_members?id=eq.${encodeURIComponent(memberId)}`,
      { google_connected: false, google_needs_reconnect: true });
    await sb('POST', '/pec_notifications', {
      type: 'google_sync_reconnect',
      body: `Google Calendar sync stopped for ${m.name}: Google no longer accepts the saved connection. Reconnect from Settings > Appointments.`,
      target_view: 'settings-appointments',
    });
    console.warn(`_pec-google: member ${memberId} (${m.name}) flagged needs-reconnect (invalid_grant)`);
  } catch (e) {
    console.error('_pec-google: markNeedsReconnect failed:', e && e.message || e);
  }
}

// A valid access token for the member, refreshing through the refresh_token
// when the stored one is stale (60s early-expiry margin). Null when the
// member is not connected or the refresh is rejected (revoked in Google);
// callers treat null as "not connected" and skip, never crash.
async function getFreshAccessToken(sb, memberId) {
  const row = await getTokenRow(sb, memberId);
  if (!row || !row.refresh_token) return null;
  if (row.access_token && row.token_expiry && new Date(row.token_expiry).getTime() > Date.now() + 60000) {
    return row.access_token;
  }
  const res = await timedFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: row.refresh_token, client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET, grant_type: 'refresh_token',
    }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    console.error(`_pec-google: refresh failed for member ${memberId} (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
    // invalid_grant ONLY: a 500 or a network blip is transient and must not
    // disconnect anyone; invalid_grant means this refresh token will never
    // work again.
    if (body && body.error === 'invalid_grant') await markNeedsReconnect(sb, memberId);
    return null;
  }
  await saveTokenRow(sb, memberId, {
    access_token: body.access_token,
    token_expiry: new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000).toISOString(),
  });
  return body.access_token;
}

// Calendar API wrapper: JSON in/out, bounded, never throws on HTTP errors
// (returns { ok, status, body } so callers branch on 404/410/etc).
async function gcalFetch(accessToken, method, path, payload, ms = 8000) {
  const res = await timedFetch(`${GCAL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  }, ms);
  let body = null;
  try { body = res.status === 204 ? null : await res.json(); } catch (_) { body = null; }
  return { ok: res.ok, status: res.status, body };
}

// Create-or-reuse the member's dedicated "TopCoat" calendar. Reuse looks
// through calendarList so a disconnect/reconnect never piles up duplicates.
async function ensureTopcoatCalendar(accessToken) {
  const list = await gcalFetch(accessToken, 'GET', '/users/me/calendarList?maxResults=250');
  if (list.ok && list.body && Array.isArray(list.body.items)) {
    const hit = list.body.items.find(c => c.summary === TOPCOAT_CAL_NAME && c.accessRole === 'owner');
    if (hit) return hit.id;
  }
  const created = await gcalFetch(accessToken, 'POST', '/calendars', {
    summary: TOPCOAT_CAL_NAME,
    description: 'TopCoat sales appointments (two-way synced). Events you add here appear in TopCoat.',
    timeZone: 'America/Phoenix',
  });
  if (!created.ok || !created.body || !created.body.id) {
    throw new Error(`could not create the TopCoat calendar (${created.status}): ${JSON.stringify(created.body).slice(0, 200)}`);
  }
  return created.body.id;
}

// ---------------------------------------------------------------------------
// Event-description composition (prompt 38). The pushed description = the
// internal company notes (pec_appointments.notes) + a separator + an
// auto-added contact/link block (customer name, phone, TopCoat deep link) so
// the salesperson has everything on their phone calendar. The separator line
// is load-bearing: the pull side strips everything from it downward before
// ingesting a Google-side description edit back into `notes`, so the
// auto-added block can never clobber the human-typed notes. customer_notes
// (the customer-facing job note) is deliberately NEVER pushed to Google.
// ---------------------------------------------------------------------------
const GCAL_DESC_SEPARATOR = '----';

function composeGcalDescription(notes, contactLines) {
  const parts = [];
  const n = String(notes || '').trim();
  if (n) parts.push(n);
  const lines = (contactLines || []).filter(Boolean);
  if (lines.length) parts.push(GCAL_DESC_SEPARATOR + '\n' + lines.join('\n'));
  return parts.join('\n\n');
}

// The free-text portion above the separator (a Google-side edit to the notes),
// with the auto-added block removed. Null when nothing human-typed remains.
function stripGcalDescription(desc) {
  const lines = String(desc || '').split(/\r?\n/);
  const i = lines.findIndex(l => l.trim() === GCAL_DESC_SEPARATOR);
  const kept = (i >= 0 ? lines.slice(0, i) : lines).join('\n').trim();
  return kept || null;
}

async function revokeToken(token) {
  try {
    await timedFetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch (_) { /* best-effort; clearing our stored tokens is the real disconnect */ }
}

// Staff gate for the JWT-authenticated endpoints: a valid Supabase user that
// exists in admin_users (same boundary the dashboard RLS uses).
async function getStaffUser(event) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token || !SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await timedFetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user || !user.id) return null;
    const staff = await timedFetch(
      `${SUPABASE_URL}/rest/v1/admin_users?auth_user_id=eq.${encodeURIComponent(user.id)}&select=id,role&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const rows = staff.ok ? await staff.json() : [];
    return Array.isArray(rows) && rows[0] ? { ...user, staffRole: rows[0].role } : null;
  } catch (_) { return null; }
}

module.exports = {
  googleConfigured, redirectUri, consentUrl, signState, verifyState,
  exchangeCode, emailFromIdToken, getTokenRow, saveTokenRow,
  getFreshAccessToken, gcalFetch, ensureTopcoatCalendar, revokeToken,
  getStaffUser, timedFetch, TOPCOAT_CAL_NAME, SITE_URL,
  GCAL_DESC_SEPARATOR, composeGcalDescription, stripGcalDescription,
};
