// Google OAuth callback (prompt 37, Phase B). Google redirects the member's
// browser here with ?code&state after consent. No staff JWT exists on this
// request; the HMAC-signed state (minted by pec-google-oauth-start for a
// specific roster member, 15-minute expiry) is the authentication. On
// success: exchange the code, create-or-reuse the member's dedicated
// "TopCoat" calendar, store tokens in the service-role-only vault, flip the
// client-readable roster flags, and render a small "you can close this tab"
// page (the dashboard is a SPA; a redirect into it would lose the Settings
// context anyway).

const { sb } = require('./_pec-supabase.cjs');
const {
  googleConfigured, verifyState, exchangeCode, emailFromIdToken,
  getTokenRow, saveTokenRow, ensureTopcoatCalendar,
} = require('./_pec-google.cjs');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(title, bodyHtml, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#f5f6f8;color:#0f1420;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border:1px solid #e6e8ec;border-radius:12px;box-shadow:0 8px 24px rgba(15,20,32,.08);padding:32px;max-width:460px;text-align:center}
h1{font-size:1.1rem;margin:0 0 10px}p{font-size:.9rem;line-height:1.5;color:#4b5563;margin:0 0 6px}</style></head>
<body><div class="card">${bodyHtml}</div></body></html>`,
  };
}

exports.handler = async (event) => {
  if (!googleConfigured()) {
    return page('Not configured', '<h1>Google sync is not configured</h1><p>The OAuth client id/secret are not set in Netlify yet. Ask Dylan to finish the Google Cloud setup, then try again from Settings.</p>', 503);
  }
  const qp = event.queryStringParameters || {};
  if (qp.error) {
    return page('Connection canceled', `<h1>Connection canceled</h1><p>Google said: ${esc(qp.error)}.</p><p>You can close this tab and try again from TopCoat Settings.</p>`);
  }
  const memberId = verifyState(qp.state);
  if (!memberId || !qp.code) {
    return page('Invalid link', '<h1>This connect link is invalid or expired</h1><p>Start again from TopCoat Settings (links expire after 15 minutes).</p>', 400);
  }

  try {
    const rows = await sb('GET', `/pec_sales_team_members?id=eq.${encodeURIComponent(memberId)}&select=id,name&limit=1`);
    const member = Array.isArray(rows) && rows[0];
    if (!member) return page('Unknown member', '<h1>Sales team member not found</h1><p>Start again from TopCoat Settings.</p>', 404);

    const tok = await exchangeCode(qp.code);
    const email = emailFromIdToken(tok.id_token);

    // prompt=consent means a refresh_token normally arrives; keep the old one
    // if a re-connect ever omits it so the connection never silently loses
    // its ability to refresh.
    const prev = await getTokenRow(sb, memberId);
    const refreshToken = tok.refresh_token || (prev && prev.refresh_token) || null;
    if (!refreshToken) {
      return page('Connection incomplete', '<h1>Google did not return a refresh token</h1><p>Remove TopCoat from your Google account&#39;s third-party access list (myaccount.google.com &gt; Security), then connect again from TopCoat Settings.</p>', 400);
    }

    // Dedicated "TopCoat" calendar (create or reuse): the only calendar
    // TopCoat ever writes to or pulls from.
    const calendarId = await ensureTopcoatCalendar(tok.access_token);

    await saveTokenRow(sb, memberId, {
      access_token: tok.access_token,
      refresh_token: refreshToken,
      token_expiry: new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString(),
      sync_token: null, // fresh connection: the pull runner starts with a full sync
    });
    await sb('PATCH', `/pec_sales_team_members?id=eq.${encodeURIComponent(memberId)}`, {
      google_connected: true,
      google_needs_reconnect: false, // a fresh consent heals the dead-token state (prompt 88)
      google_email: email,
      google_calendar_id: calendarId,
      google_connected_at: new Date().toISOString(),
    });

    console.log(`pec-google-oauth-callback: connected member ${memberId} (${email})`);
    return page('Connected', `<h1>Google Calendar connected</h1>
      <p><strong>${esc(member.name)}</strong> is now linked to <strong>${esc(email || 'your Google account')}</strong>.</p>
      <p>A calendar named "TopCoat" now lives in that Google account. TopCoat appointments appear there, and events added to it show up in TopCoat within about 15 minutes.</p>
      <p>You can close this tab and return to TopCoat.</p>`);
  } catch (err) {
    console.error('pec-google-oauth-callback failed:', err && err.message || err);
    return page('Connection failed', `<h1>Could not finish connecting</h1><p>${esc(String(err && err.message || err).slice(0, 300))}</p><p>You can close this tab and try again from TopCoat Settings.</p>`, 500);
  }
};
