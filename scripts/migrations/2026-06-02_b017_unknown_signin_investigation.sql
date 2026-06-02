-- ============================================================================
-- B-017: investigate the unknown sign-in kvillalba.163@gmail.com
-- ============================================================================
-- Author: Claude Code (2026-06-02). RUN BY COWORK (no DB access in this session).
--
-- Context: Team -> Recent sign-ins shows kvillalba.163@gmail.com signing in
-- successfully on 2026-05-22 from IP 49.150.54.114. Not in the Staff list.
-- Goal: determine whether this is (a) a deleted staffer whose auth row lingered,
-- or (b) unauthorized access.
--
-- *** READ-ONLY. THIS SCRIPT DELETES NOTHING. ***
-- Per the Phase 1 instructions: do NOT delete anything in auth.users or revoke
-- any session without Dylan confirming first. The revoke/delete statements are
-- left COMMENTED at the bottom as a ready-to-run template for AFTER Dylan says go.
--
-- Schema facts (verified 2026-06-02): public.sign_in_log(email, ip_address,
-- user_agent, signed_in_at, auth_user_id -> auth.users ON DELETE SET NULL).
-- public.admin_users(email UNIQUE, auth_user_id -> auth.users, role, name).
-- ============================================================================


-- 1. Every sign-in by this email: how many, when, from which IPs / agents.
SELECT email, ip_address, user_agent, signed_in_at, auth_user_id::text
FROM public.sign_in_log
WHERE email ILIKE 'kvillalba.163@gmail.com'
ORDER BY signed_in_at DESC;

-- 2. Anything else from that IP (is 49.150.54.114 used by any known staffer?).
SELECT email, ip_address, signed_in_at, auth_user_id::text
FROM public.sign_in_log
WHERE ip_address = '49.150.54.114'
ORDER BY signed_in_at DESC;

-- 3. Is this email an admin/staff record at all? (Expect 0 rows = not staff.)
SELECT id::text, email, name, role, auth_user_id::text, created_at
FROM public.admin_users
WHERE email ILIKE 'kvillalba.163@gmail.com';

-- 4. The underlying auth account: does it still exist, is it confirmed, when did
--    it last sign in, and does it map to an admin_users row (LEFT JOIN -> null
--    means it can authenticate but has no staff/role record).
SELECT u.id::text, u.email, u.created_at, u.last_sign_in_at,
       u.email_confirmed_at, u.banned_until,
       a.id::text AS admin_users_id, a.role
FROM auth.users u
LEFT JOIN public.admin_users a ON a.auth_user_id = u.id
WHERE u.email ILIKE 'kvillalba.163@gmail.com';

-- 5. Full sign-in history for that auth_user_id (catch sign-ins logged under a
--    different email casing). Fill the id from query 4 if you want this:
-- SELECT email, ip_address, signed_in_at FROM public.sign_in_log
-- WHERE auth_user_id = '<auth.users.id from query 4>' ORDER BY signed_in_at DESC;


-- ============================================================================
-- DECISION (report to Dylan in the PROJECT-LOG, do NOT act without his OK):
--   * If query 3 is empty AND query 4 shows a real auth account with no
--     admin_users mapping -> the account can authenticate but has no staff role.
--     RLS gates the data (admin_users drives access), so it likely sees the
--     "Access pending" panel, not real data. Still: unknown account = revoke.
--   * If it maps to a deleted staffer, that is the lingering-auth case.
--   * Either way, Dylan decides revoke vs keep.
--
-- READY-TO-RUN (ONLY after Dylan confirms; needs the auth_user_id from query 4).
-- Revoking requires the service-role / GoTrue admin API or the auth schema:
--   -- ban (soft, reversible) the account so it can no longer sign in:
--   -- UPDATE auth.users SET banned_until = 'infinity' WHERE id = '<auth_user_id>';
--   -- OR hard-delete the auth account (cascades sign_in_log.auth_user_id to NULL,
--   -- and admin_users.auth_user_id to NULL if a mapping existed):
--   -- DELETE FROM auth.users WHERE id = '<auth_user_id>';
-- Prefer the Supabase Studio Auth UI (Authentication -> Users -> ... -> Delete
-- user / Ban) over raw SQL on auth.users when possible.
-- ============================================================================
