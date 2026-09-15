import { supabase } from '../lib/supabase';
import { assertAccount, blockAccount, clearAccountDenial, offlineAccessDenied, type AccountScope } from './account';
import { idbGet, idbPut } from './idb';
import { verifyStaffSession } from './session';

const PROOF_KEY = 'verified-access';
type OfflineProof = { sessionId: string; aal: 'aal1' | 'aal2'; hasVerifiedFactor: boolean };

// Local proof only permits offline use of this session's already loaded data.
// It is never sent to the server or accepted instead of RLS on a queued write.
export async function verifyOfflineAccess(account: AccountScope): Promise<void> {
  const proof = await idbGet<OfflineProof>('catalog', PROOF_KEY, account);
  assertAccount(account);
  if (offlineAccessDenied(account) || !proof || proof.sessionId !== account.sessionId || !['aal1', 'aal2'].includes(proof.aal) || proof.aal !== account.assurance ||
      typeof proof.hasVerifiedFactor !== 'boolean' || (proof.hasVerifiedFactor && proof.aal !== 'aal2')) {
    throw new Error('Reconnect and finish signing in on the dashboard before using this account offline. Your drafts are preserved.');
  }
}
export async function verifyOnlineAccess(account: AccountScope): Promise<{ role: string }> {
  const staff = await verifyStaffSession(account);
  let level: 'aal1' | 'aal2';
  let verified: boolean;
  try {
    const [assurance, factors] = await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
    ]);
    assertAccount(account);
    const current = assurance.data?.currentLevel;
    const next = assurance.data?.nextLevel;
    const all = factors.data?.all;
    const totp = factors.data?.totp;
    const validFactor = (factor: unknown): factor is { id: string; status: string; factor_type: string } => {
      if (!factor || typeof factor !== 'object') return false;
      const value = factor as Record<string, unknown>;
      return typeof value.id === 'string' && !!value.id &&
        typeof value.status === 'string' && ['verified', 'unverified'].includes(value.status) &&
        typeof value.factor_type === 'string' && ['totp', 'phone', 'webauthn'].includes(value.factor_type);
    };
    if (assurance.error || factors.error || !['aal1', 'aal2'].includes(current || '') ||
        !['aal1', 'aal2'].includes(next || '') || !Array.isArray(all) || !Array.isArray(totp) ||
        !all.every(validFactor) || !totp.every(validFactor) ||
        totp.some(factor => !all.some(item => item.id === factor.id && item.status === factor.status))) {
      throw new Error('Could not verify sign-in security. Retry signing in on the dashboard. Your drafts are preserved.');
    }
    verified = all.some(factor => factor.status === 'verified');
    if ((verified || next === 'aal2') && current !== 'aal2') {
      throw new Error('Finish two-step verification on the dashboard before opening the estimator. Your drafts are preserved.');
    }
    level = current as 'aal1' | 'aal2';
  } catch (error) {
    // A completed staff check followed by any MFA error cannot fall back to
    // an older local proof. Never clear a newer account from a late callback.
    assertAccount(account);
    blockAccount(account);
    throw error;
  }
  const proof: OfflineProof = { sessionId: account.sessionId, aal: level as 'aal1' | 'aal2', hasVerifiedFactor: verified };
  try { await idbPut('catalog', proof, PROOF_KEY, account); } catch { assertAccount(account); /* online-only if storage unavailable */ }
  clearAccountDenial(account);
  return staff;
}
