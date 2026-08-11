// Revoke (or restore) a staff member's LOGIN without touching their records.
// POST /.netlify/functions/pec-revoke-login
// Body: { action: 'revoke' | 'restore', adminUserId, reassignToAdminUserId? }
//
// What a revoke IS (prompt 86, locked decisions): ban the auth user
// permanently (the auth.users row stays, so audit attribution keeps
// resolving), delete their auth sessions server-side (refresh tokens cascade
// away; access JWTs live out their <=1h expiry, which the dashboard's
// kill-switch poll covers), stamp admin_users.login_revoked_at/by, and
// optionally reassign their OPEN work. What it is NOT: a delete of anything,
// or a change to people / pec_sales_team_members / pec_prod_crew_members
// (people.active would mirror-forward into the role tables and retire their
// sales/crew roles, which revoke must never do).
//
// Restore unbans the auth user and clears the stamp. It does NOT return
// reassigned work and does NOT touch user_permissions (locked decision 5).
//
// Caller gate: any staff login with user_permissions.can_manage_team
// (deliberately looser than pec-create-staff's role='admin'), and never
// against the caller's own row (the one guardrail; it also makes a full
// admin lockout impossible, since locking out every admin would require
// revoking yourself).

const { sb, json, requireStaff } = require('./_pec-supabase.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// GoTrue has no literal "permanent" ban; the documented convention is a
// 100-year duration (the docs' own "Ban a user for 100 years" example).
const PERMANENT_BAN = '876000h';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { error: 'Invalid JSON' }); }
  const action = body.action;
  const adminUserId = String(body.adminUserId || '');
  const reassignTo = body.reassignToAdminUserId ? String(body.reassignToAdminUserId) : null;
  if (!['revoke', 'restore', 'preview'].includes(action)) return jc(400, { error: "action must be 'revoke', 'restore', or 'preview'" });
  if (!adminUserId) return jc(400, { error: 'adminUserId required' });

  const auth = await requireStaff(event);
  if (!auth.ok) return jc(auth.status, { error: auth.error });

  try {
    // can_manage_team gate. A missing user_permissions row falls back to
    // allowed, matching the app's in-memory all-true fallback for pre-
    // migration accounts.
    const permRows = await sb('GET', `/user_permissions?admin_user_id=eq.${auth.staff.id}&select=can_manage_team&limit=1`);
    if (permRows.length && permRows[0].can_manage_team === false) {
      return jc(403, { error: 'Managing team logins requires the can_manage_team permission.' });
    }

    // The one guardrail, enforced server-side.
    if (adminUserId === auth.staff.id) return jc(400, { error: 'You cannot revoke your own login.' });

    const targetRows = await sb('GET', `/admin_users?id=eq.${encodeURIComponent(adminUserId)}&select=id,auth_user_id,email,name,login_revoked_at,login_revoked_by&limit=1`);
    const target = targetRows[0];
    if (!target) return jc(404, { error: 'No staff login with that id.' });

    if (action === 'restore') return await restore(target, auth);

    // preview: the open-work counts the confirm dialog shows, computed with
    // the SAME filters the revoke uses (client RLS cannot count another
    // user's todos, so the service role answers). Read-only.
    if (action === 'preview') {
      const [ops, todos, notifs, leads] = await Promise.all([
        sbCount(`/pec_ops_items?assigned_to=eq.${target.id}&status=eq.open&select=id`),
        sbCount(`/pec_user_todos?admin_user_id=eq.${target.id}&done=eq.false&select=id`),
        sbCount(`/pec_notifications?target_user_id=eq.${target.id}&read_at=is.null&select=id`),
        target.auth_user_id
          ? sbCount(`/leads?owner_user_id=eq.${target.auth_user_id}&deleted_at=is.null&archived_at=is.null&stage=neq.lost&select=id`)
          : Promise.resolve(0),
      ]);
      return jc(200, { ok: true, counts: { ops_items: ops, todos, notifications: notifs, leads } });
    }

    if (target.login_revoked_at) return jc(409, { error: 'That login is already revoked.' });

    // 1. Reassign open work FIRST, while the row is coherent. Convenience,
    // not a precondition: no reassignTo means revoke anyway, counts all zero.
    const counts = { ops_items: 0, todos: 0, notifications: 0, leads: 0 };
    if (reassignTo) {
      if (reassignTo === adminUserId) return jc(400, { error: 'Cannot reassign work to the login being revoked.' });
      const newRows = await sb('GET', `/admin_users?id=eq.${encodeURIComponent(reassignTo)}&select=id,auth_user_id,login_revoked_at&limit=1`);
      const dest = newRows[0];
      if (!dest) return jc(400, { error: 'Reassignment target not found.' });
      if (dest.login_revoked_at) return jc(400, { error: 'Reassignment target has a revoked login.' });

      // Open work only; history (created_by, done_by, estimate/job
      // salespeople, audit_log) is never rewritten.
      const movedOps = await sb('PATCH', `/pec_ops_items?assigned_to=eq.${target.id}&status=eq.open`, { assigned_to: dest.id }, true);
      counts.ops_items = Array.isArray(movedOps) ? movedOps.length : 0;
      const movedTodos = await sb('PATCH', `/pec_user_todos?admin_user_id=eq.${target.id}&done=eq.false`, { admin_user_id: dest.id }, true);
      counts.todos = Array.isArray(movedTodos) ? movedTodos.length : 0;
      const movedNotifs = await sb('PATCH', `/pec_notifications?target_user_id=eq.${target.id}&read_at=is.null`, { target_user_id: dest.id }, true);
      counts.notifications = Array.isArray(movedNotifs) ? movedNotifs.length : 0;
      // leads.owner_user_id stores the AUTH uid (qoStaffNames keys the Owner
      // picker by auth_user_id; verified live, and the column has no FK).
      // Live leads only: not deleted, not archived, not lost.
      if (target.auth_user_id && dest.auth_user_id) {
        const movedLeads = await sb('PATCH', `/leads?owner_user_id=eq.${target.auth_user_id}&deleted_at=is.null&archived_at=is.null&stage=neq.lost`, { owner_user_id: dest.auth_user_id }, true);
        counts.leads = Array.isArray(movedLeads) ? movedLeads.length : 0;
      }
    }

    // 2. Ban the auth user (skip when the staff row was never linked to auth).
    if (target.auth_user_id) {
      const banRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${target.auth_user_id}`, {
        method: 'PUT',
        headers: adminHeaders(),
        body: JSON.stringify({ ban_duration: PERMANENT_BAN }),
      });
      if (!banRes.ok) return jc(502, { error: `Could not ban the auth user (${banRes.status}). Nothing was revoked; reassignments (if any) already ran.` });

      // 3. Kill every session server-side. GoTrue has no sign-out-by-user-id
      // REST endpoint, so the migration's SECURITY DEFINER RPC deletes the
      // auth.sessions rows (refresh tokens cascade). service_role only.
      await sb('POST', '/rpc/pec_admin_kill_sessions', { target_auth_user_id: target.auth_user_id });
    }

    // 4. Stamp the admin_users row.
    await sb('PATCH', `/admin_users?id=eq.${target.id}`, { login_revoked_at: new Date().toISOString(), login_revoked_by: auth.staff.id });

    // 5. One audit row, written with the service role (staff sessions cannot
    // insert into audit_log directly, same constraint as pec_notifications).
    await sb('POST', '/audit_log', {
      action: 'revoke_login',
      entity_type: 'admin_users',
      entity_id: target.id,
      auth_user_id: auth.user.id,
      admin_email: auth.staff.email,
      before_json: { email: target.email, name: target.name, login_revoked_at: null },
      after_json: { login_revoked_at: 'now', login_revoked_by: auth.staff.id, reassigned_to: reassignTo, reassigned_counts: counts },
    });

    return jc(200, { ok: true, counts });
  } catch (err) {
    console.error('pec-revoke-login error:', err);
    return jc(500, { error: err.message });
  }
};

async function restore(target, auth) {
  if (!target.login_revoked_at) return jc(409, { error: 'That login is not revoked.' });
  if (target.auth_user_id) {
    const unbanRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${target.auth_user_id}`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ ban_duration: 'none' }),
    });
    if (!unbanRes.ok) return jc(502, { error: `Could not unban the auth user (${unbanRes.status}).` });
  }
  await sb('PATCH', `/admin_users?id=eq.${target.id}`, { login_revoked_at: null, login_revoked_by: null });
  await sb('POST', '/audit_log', {
    action: 'restore_login',
    entity_type: 'admin_users',
    entity_id: target.id,
    auth_user_id: auth.user.id,
    admin_email: auth.staff.email,
    before_json: { login_revoked_at: target.login_revoked_at, login_revoked_by: target.login_revoked_by },
    after_json: { login_revoked_at: null },
  });
  return jc(200, { ok: true, restored: true });
}

async function sbCount(path) {
  const rows = await sb('GET', path);
  return Array.isArray(rows) ? rows.length : 0;
}

function adminHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function jc(status, body) {
  return { statusCode: status, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
