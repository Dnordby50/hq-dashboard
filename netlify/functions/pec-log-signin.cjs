// Log a staff sign-in event (IP + timestamp).
// Called by the browser immediately after supabase.auth.signInWithPassword() succeeds.
// No secret needed — the only data collected is the caller's own sign-in event;
// the service-role key stays server-side.

const { sb, json } = require('./_pec-supabase.cjs');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { auth_user_id, email } = body;
  if (!auth_user_id && !email) return json(400, { error: 'auth_user_id or email required' });

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
    return json(500, { error: err.message });
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
