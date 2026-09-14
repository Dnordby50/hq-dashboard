// Serialize child replacement and outbox drains. A drain holds an operation
// snapshot, so replacing the queue alone cannot cancel an older upload.
let pending: Promise<void> = Promise.resolve();

// Callers must release this lock before starting a drain; it is not reentrant.
export function withEstimateWriteLock<T>(work: () => Promise<T>): Promise<T> {
  const result = pending.then(work);
  pending = result.then(() => undefined, () => undefined);
  return result;
}
