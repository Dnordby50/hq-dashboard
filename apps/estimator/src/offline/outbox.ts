import { idbDelete, idbGetAll, idbPut } from './idb';

// A queued mutation. The row's PRIMARY KEY (`id`) is client-minted, so syncing
// is an idempotent upsert (`on conflict (id) do update`): replaying the queue
// after an ambiguous failure can never duplicate or double-write a row.
//
// `opId` is built to sort chronologically (ISO time + a monotonic counter), so
// IndexedDB returns ops in FIFO order and a parent row (estimate) is always
// uploaded before its children (areas, then area materials) which carry its id
// in a foreign key.
export type OutboxOp = {
  opId: string;
  table: 'leads' | 'estimates' | 'estimate_areas' | 'estimate_area_materials' | 'estimate_line_items' | 'estimate_installments';
  id: string;
  row: Record<string, unknown>;
  client_updated_at: string;
  attempts: number;
  status: 'pending' | 'error';
  lastError?: string;
  // Backoff gate (prompt 48): do not retry before this ISO time. OPTIONAL and
  // absent-means-due, so ops queued by builds older than this field still
  // drain unchanged. Set on failure (production/outbox-drain.cjs schedule),
  // ignored entirely by a manual "Retry now".
  nextAttemptAt?: string;
  // When the op first entered the queue (ISO). Optional for the same
  // backward-compat reason; the UI falls back to the opId's timestamp prefix.
  queuedAt?: string;
};

let _seq = 0;
function nextOpId(): string {
  const iso = new Date().toISOString();
  const seq = String(_seq++).padStart(6, '0');
  const rand = Math.random().toString(16).slice(2, 6);
  return `${iso}_${seq}_${rand}`;
}

export async function enqueue(op: {
  table: OutboxOp['table'];
  id: string;
  row: Record<string, unknown>;
  client_updated_at: string;
}): Promise<void> {
  const full: OutboxOp = { opId: nextOpId(), attempts: 0, status: 'pending', queuedAt: new Date().toISOString(), ...op };
  await idbPut('outbox', full);
}

// FIFO by opId (chronological), so parents land before children.
export async function listOps(): Promise<OutboxOp[]> {
  const ops = await idbGetAll<OutboxOp>('outbox');
  return ops.sort((a, b) => a.opId.localeCompare(b.opId));
}

export const markError = (op: OutboxOp, message: string, nextAttemptAt?: string) =>
  idbPut('outbox', { ...op, attempts: op.attempts + 1, status: 'error' as const, lastError: message, nextAttemptAt });

export const removeOp = (opId: string) => idbDelete('outbox', opId);
