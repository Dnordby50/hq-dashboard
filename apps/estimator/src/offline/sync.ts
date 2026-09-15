import { listOps, markError, removeOp } from './outbox';
import { drainPass } from '../../../../production/outbox-drain.cjs';
import { withEstimateWriteLock } from './writeLock';
import { assertAccount, captureAccount, type AccountScope } from './account';
import { accountRequest } from './session';
import { verifyOnlineAccess } from './access';

export type SyncResult = { synced: number; failed: number; blocked: number; deferred: number; remaining: number };
const draining = new Map<AccountScope, Promise<SyncResult>>();

// Single flight per captured account generation. Cancellation rejects the
// pass without deleting or reassigning queued work. Server RLS still checks
// current staff/session state for every upsert; tokens are pinned explicitly.
export async function drainOutbox(opts?: { force?: boolean; account?: AccountScope }): Promise<SyncResult> {
  const account = opts?.account ?? captureAccount();
  assertAccount(account);
  const running = draining.get(account);
  if (running) return running;
  const task = withEstimateWriteLock(async () => {
    assertAccount(account);
    await verifyOnlineAccess(account);
    const ops = await listOps(account);
    const counts = await drainPass(ops, {
      upsert: async op => {
        assertAccount(account);
        if (op.ownerId !== account.ownerId) throw new Error('Offline draft belongs to another account.');
        await accountRequest(account, `/${op.table}?on_conflict=id`, op.row, { Prefer: 'resolution=merge-duplicates,return=minimal' });
        return null;
      },
      markError: (op, message, nextAttemptAt) => { assertAccount(account); return markError(op, message, nextAttemptAt, account); },
      removeOp: opId => { assertAccount(account); return removeOp(opId, account); },
      now: () => Date.now(),
    }, { force: opts?.force });
    assertAccount(account);
    return { ...counts, remaining: (await listOps(account)).length };
  });
  draining.set(account, task);
  try { return await task; } finally { draining.delete(account); }
}
