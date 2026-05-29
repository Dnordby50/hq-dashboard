// Admin-only: set a new password for an existing staff member.
// Caller passes their own Supabase JWT as Bearer token; the function verifies
// the caller is in admin_users with role='admin' before acting, then uses the
// service role to update the target auth user's password. Mirrors the auth
// pattern in pec-create-staff.cjs.
// POST /.netlify/functions/pec-reset-password
// Body: { auth_user_id, password }

const { sb, json } = require('./_pec-supabase.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) return json(401, { error: 'Missing bearer token' });
  const jwt = authHeader.slice(7);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { auth_user_id, password } = body;
  if (!auth_user_id || !password) return json(400, { error: 'auth_user_id and password required' });
  if (password.length < 8) return json(400, { error: 'Password must be at least 8 characters' });

  try {
    // 1. Validate caller is an admin (same check as pec-create-staff).
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${jwt}` },
    });
    if (!userRes.ok) return json(401, { error: 'Invalid session' });
    const caller = await userRes.json();

    const callerAdmin = await sb('GET', `/admin_users?auth_user_id=eq.${caller.id}&select=role&limit=1`);
    if (!callerAdmin.length || callerAdmin[0].role !== 'admin') {
      return json(403, { error: 'Admins only' });
    }

    // 2. Confirm the target is a real staff member (avoid resetting arbitrary auth users).
    const target = await sb('GET', `/admin_users?auth_user_id=eq.${encodeURIComponent(auth_user_id)}&select=id,email&limit=1`);
    if (!target.length) return json(404, { error: 'No staff member with that auth_user_id' });

    // 3. Set the new password via the admin API (service role).
    const updRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(auth_user_id)}`, {
      method: 'PUT',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
    });
    if (!updRes.ok) {
      const text = await updRes.text();
      return json(updRes.status, { error: text || 'Failed to update password' });
    }

    return { statusCode: 200, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, email: target[0].email }) };
  } catch (err) {
    console.error('pec-reset-password error:', err);
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
