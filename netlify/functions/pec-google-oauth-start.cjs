// Google OAuth start (prompt 37, Phase B). The Settings panel POSTs
// { sales_member_id } with a staff JWT and gets back { url }, the Google
// consent URL for that roster member, which the browser opens in a new tab.
// POST-then-open (instead of a bare GET link) keeps the start authenticated:
// only signed-in staff can mint a consent URL, and the HMAC-signed state is
// what the callback later trusts.

const { sb } = require('./_pec-supabase.cjs');
const { googleConfigured, consentUrl, getStaffUser } = require('./_pec-google.cjs');

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
const jc = (statusCode, body) => ({ statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { ok: false, error: 'Method not allowed' });

  const user = await getStaffUser(event);
  if (!user) return jc(401, { ok: false, error: 'Not authenticated' });

  if (!googleConfigured()) {
    return jc(503, { ok: false, error: 'Google sync is not configured yet (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET missing in Netlify env). Ask Dylan to finish the Google Cloud setup.' });
  }

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { ok: false, error: 'Invalid JSON' }); }
  const memberId = input.sales_member_id;
  if (!memberId) return jc(400, { ok: false, error: 'sales_member_id is required' });

  // The member must exist on the roster; a bad id would otherwise mint a
  // consent URL that stores tokens against nothing.
  const rows = await sb('GET', `/pec_sales_team_members?id=eq.${encodeURIComponent(memberId)}&select=id,name&limit=1`);
  if (!Array.isArray(rows) || !rows[0]) return jc(404, { ok: false, error: 'Sales team member not found' });

  return jc(200, { ok: true, url: consentUrl(memberId) });
};
