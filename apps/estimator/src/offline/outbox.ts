import { idbDelete, idbGetAll, idbPut } from './idb';

// A queued mutation. The row's PRIMARY KEY (`id`) is client-minted, so syncing
// is an idempotent upsert (`on conflict (id) do update`): replaying the queue
// after an ambiguous failure can never duplicate or double-write a row. `opId`
// is unique per queue entry (lets the same row be re-queued safely).
export type OutboxOp = {
  opId: string;
  table: 'leads' | 'estimates' | 'estimate_areas' | 'estimate_area_materials';
  id: string;
  row: Record<string, unknown>;
  client_updated_at: string;
  enqueued_at: string;
  attempts: number;
  status: 'pending' | 'error';
  lastError?: string;
};

export async function enqueue(op: Omit<OutboxOp, 'attempts' | 'status' | 'enqueued_at'> & { enqueued_at?: string }): Promise<void> {
  const full: OutboxOp = {
    attempts: 0,
    status: 'pending',
    enqueued_at: op.enqueued_at ?? new Date().toISOString(),
    ...op,
  };
  await idbPut('outbox', full);
}

// FIFO so a parent row (estimate) is uploaded before its children (areas).
export async function listOps(): Promise<OutboxOp[]> {
  const ops = await idbGetAll<OutboxOp>('outbox');
  return ops.sort((a, b) => a.enqueued_at.localeCompare(b.enqueued_at));
}

export const markError = (op: OutboxOp, message: string) =>
  idbPut('outbox', { ...op, attempts: op.attempts + 1, status: 'error' as const, lastError: message });

export const removeOp = (opId: string) => idbDelete('outbox', opId);

export const pendingCount = async () => (await listOps()).filter((o) => o.status !== 'error' || true).length;
