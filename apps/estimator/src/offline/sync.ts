import { supabase } from '../lib/supabase';
import { listOps, markError, removeOp } from './outbox';

export type SyncResult = { synced: number; failed: number; remaining: number };

let _draining: Promise<SyncResult> | null = null;

// Drain the outbox: upsert each queued row by its client-minted PK. Upsert with
// onConflict:'id' is idempotent, so a row that actually landed before an
// ambiguous failure is updated-in-place on replay, never duplicated. Processed
// FIFO so a parent (estimate) lands before its children. Single-flight so the
// 'online' event + the post-load drain can't run concurrently.
export async function drainOutbox(): Promise<SyncResult> {
  if (_draining) return _draining;
  _draining = (async () => {
    let synced = 0;
    let failed = 0;
    const ops = await listOps();
    for (const op of ops) {
      try {
        const { error } = await supabase.from(op.table).upsert(op.row, { onConflict: 'id' });
        if (error) {
          await markError(op, error.message);
          failed++;
        } else {
          await removeOp(op.opId);
          synced++;
        }
      } catch (e) {
        await markError(op, e instanceof Error ? e.message : String(e));
        failed++;
      }
    }
    const remaining = (await listOps()).length;
    return { synced, failed, remaining };
  })();
  try {
    return await _draining;
  } finally {
    _draining = null;
  }
}
