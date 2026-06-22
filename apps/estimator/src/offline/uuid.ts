// Client-minted UUID for offline-created rows, so the SAME id round-trips
// through the sync outbox and makes the upsert idempotent.
export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Fallback for very old engines. Uniqueness, not cryptographic quality, is
  // what matters here (it is only a row id).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
