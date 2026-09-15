import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/supabase';
import { assertAccount, blockAccount, matchesSession, setAccount, type AccountScope } from './account';

export async function accountSession(scope: AccountScope) {
  assertAccount(scope);
  const result = await supabase.auth.getSession();
  assertAccount(scope);
  if (result.error || !matchesSession(scope, result.data.session)) {
    setAccount(null);
    throw new Error('Sign in again to continue. Your offline work has been kept.');
  }
  return result;
}

// Pin this request to the session checked above. The shared Supabase client
// must never replace an old queued write's token with another account's token.
export async function accountRequest(scope: AccountScope, path: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const { data } = await accountSession(scope);
  assertAccount(scope);
  const response = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: 'POST', signal: scope.signal,
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${data.session!.access_token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  assertAccount(scope);
  if (response.status === 401 || response.status === 403) {
    blockAccount(scope);
    throw new Error('Your staff session is no longer available. Offline work has been kept.');
  }
  if (!response.ok) throw new Error(`Sync paused (${response.status}). Your offline work has been kept.`);
  const text = await response.text();
  assertAccount(scope);
  return text ? JSON.parse(text) : null;
}
export async function verifyStaffSession(scope: AccountScope): Promise<{ role: string }> {
  const staff = await accountRequest(scope, '/rpc/pec_staff_session', {}) as { auth_user_id?: string; role: string } | null;
  assertAccount(scope);
  if (!staff || staff.auth_user_id !== scope.ownerId) {
    blockAccount(scope);
    throw new Error('A current staff session is required. Offline work has been kept.');
  }
  return staff;
}
