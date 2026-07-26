// Log a staff sign-in event (IP + timestamp).
// Called by the browser immediately after supabase.auth.signInWithPassword() succeeds,
// passing the freshly-minted session token as a Bearer header.
//
// SECURITY: the identity is taken from the VERIFIED token (requireStaff), never
// from the request body. Previously auth_user_id/email came from the body with
// no auth at all, so anyone could POST forged sign-in rows for any email/IP and
// pollute the audit trail. Now an anonymous or non-staff caller is rejected and
// a caller can only log a sign-in as themselves.

const { sb, json, requireStaff } = require('./_pec-supabase.cjs');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = await requireStaff(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });
  const auth_user_id = auth.user.id;
  const email = auth.staff.email || auth.user.email || null;

  const ip = event.headers['x-nf-client-connection-ip']
          || (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || event.headers['client-ip']
          || null;
  const ua = event.headers['user-agent'] || null;

  try {
    await sb('POST', '/sign_in_log', {
      auth_user_id: auth_user_id || null,
      email: email || null,
      ip_address: ip,
      user_agent: ua,
    });
    return { statusCode: 200, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('pec-log-signin error:', err);
    return json(500, { error: 'Internal error' });
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
