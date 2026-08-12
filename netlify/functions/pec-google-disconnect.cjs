// Google disconnect (prompt 37, Phase B). POST { sales_member_id } with a
// staff JWT: revoke the Google grant (best-effort), delete the stored tokens
// (the real disconnect), and clear the roster's connection flags. The
// member's "TopCoat" calendar and its events are deliberately left alone in
// their Google account; existing TopCoat rows keep their google_* columns as
// history but the push/pull skip disconnected members, so nothing moves
// until a re-connect.

const { sb } = require('./_pec-supabase.cjs');
const { getTokenRow, revokeToken, getStaffUser } = require('./_pec-google.cjs');

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

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { ok: false, error: 'Invalid JSON' }); }
  const memberId = input.sales_member_id;
  if (!memberId) return jc(400, { ok: false, error: 'sales_member_id is required' });

  try {
    const row = await getTokenRow(sb, memberId);
    if (row && (row.refresh_token || row.access_token)) {
      await revokeToken(row.refresh_token || row.access_token);
    }
    await sb('DELETE', `/pec_sales_member_google_tokens?sales_member_id=eq.${encodeURIComponent(memberId)}`);
    await sb('PATCH', `/pec_sales_team_members?id=eq.${encodeURIComponent(memberId)}`, {
      google_connected: false, google_needs_reconnect: false,
      google_email: null,
      google_calendar_id: null, google_connected_at: null,
    });
    console.log(`pec-google-disconnect: member ${memberId} disconnected by ${user.email || user.id}`);
    return jc(200, { ok: true });
  } catch (err) {
    console.error('pec-google-disconnect failed:', err && err.message || err);
    return jc(500, { ok: false, error: String(err && err.message || err) });
  }
};
