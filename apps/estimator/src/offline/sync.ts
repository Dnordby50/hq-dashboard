import { supabase } from '../lib/supabase';
import { listOps, markError, removeOp } from './outbox';
import { drainPass } from '../../../../production/outbox-drain.cjs';

// blocked = skipped this pass because a parent op failed or was skipped
// (one root cause reads as one problem); deferred = skipped waiting out its
// backoff timer. Both stay queued; neither counts as a new failure.
export type SyncResult = { synced: number; failed: number; blocked: number; deferred: number; remaining: number };

let _draining: Promise<SyncResult> | null = null;

// Drain the outbox: upsert each queued row by its client-minted PK. Upsert with
// onConflict:'id' is idempotent, so a row that actually landed before an
// ambiguous failure is updated-in-place on replay, never duplicated. Processed
// FIFO so a parent (estimate) lands before its children. Single-flight so the
// 'online' event + the post-load drain can't run concurrently.
//
// The retry POLICY (backoff schedule, absent-means-due, skip children of a
// failed parent, retry-forever-with-no-cap) lives in the shared
// production/outbox-drain.cjs so the fixture tests exercise the exact code
// this runs. { force: true } is the manual "Retry now": every backoff timer
// is ignored for the pass, so a rep who knows the problem is fixed does not
// wait out an hour.
export async function drainOutbox(opts?: { force?: boolean }): Promise<SyncResult> {
  if (_draining) return _draining;
  _draining = (async () => {
    const ops = await listOps();
    const counts = await drainPass(ops, {
      upsert: async (op) => {
        const { error } = await supabase.from(op.table).upsert(op.row, { onConflict: 'id' });
        return error ? error.message : null;
      },
      markError: (op, message, nextAttemptAt) => markError(op, message, nextAttemptAt),
      removeOp: (opId) => removeOp(opId),
      now: () => Date.now(),
    }, { force: opts?.force });
    const remaining = (await listOps()).length;
    return { ...counts, remaining };
  })();
  try {
    return await _draining;
  } finally {
    _draining = null;
  }
}
