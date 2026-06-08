// Create a new staff member (auth user + admin_users row).
// Caller must pass their own Supabase JWT as Bearer token; the function verifies
// the caller is in admin_users with role='admin' before acting.
// POST /.netlify/functions/pec-create-staff
// Body: { name, email, password, role? }

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

  const { name, email, password, role } = body;
  if (!name || !email || !password) return json(400, { error: 'name, email, password required' });
  if (password.length < 8) return json(400, { error: 'Password must be at least 8 characters' });
  const newRole = ['admin', 'office', 'pm'].includes(role) ? role : 'office';

  try {
    // 1. Validate caller is admin
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${jwt}` },
    });
    if (!userRes.ok) return json(401, { error: 'Invalid session' });
    const caller = await userRes.json();

    const callerAdmin = await sb('GET', `/admin_users?auth_user_id=eq.${caller.id}&select=role&limit=1`);
    if (!callerAdmin.length || callerAdmin[0].role !== 'admin') {
      return json(403, { error: 'Admins only' });
    }

    // 2. Check email isn't already a staff row
    const existing = await sb('GET', `/admin_users?email=eq.${encodeURIComponent(email)}&select=id&limit=1`);
    if (existing.length) return json(409, { error: 'Email already on the staff list' });

    // 3. Create auth user (email auto-confirmed)
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (!createRes.ok) {
      const text = await createRes.text();
      return json(createRes.status, { error: text || 'Failed to create auth user' });
    }
    const newUser = await createRes.json();

    // 4. Insert admin_users row
    const inserted = await sb('POST', '/admin_users', {
      auth_user_id: newUser.id,
      email,
      name,
      role: newRole,
    }, true);

    // 5. Seed an all-on user_permissions row so a new account has every
    // capability by default (the table's columns all default true, so inserting
    // just the FK is enough). Best-effort: if the migration is not live yet the
    // app falls back to all-true in memory anyway, so a failure must not block
    // staff creation.
    const newAdminId = inserted[0]?.id;
    if (newAdminId) {
      try { await sb('POST', '/user_permissions', { admin_user_id: newAdminId }, true); }
      catch (e) { console.warn('pec-create-staff: user_permissions seed failed:', e.message); }
    }

    return { statusCode: 200, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, id: newAdminId, auth_user_id: newUser.id }) };
  } catch (err) {
    console.error('pec-create-staff error:', err);
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
