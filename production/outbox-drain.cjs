'use strict';
// Outbox drain policy (prompt 48, Part B). ONE source of truth for the
// estimator's retry backoff and the skip-children-of-a-failed-parent rule,
// required by BOTH the estimator PWA (apps/estimator/src/offline/sync.ts, via
// Vite's CJS interop, the estimate-draft.cjs sharing pattern) and the fixture
// tests, so what the tests prove is literally the code the app runs.
//
// Policy (Dylan's locked decisions, 2026-07-25):
//  - KEEP RETRYING FOREVER. There is deliberately NO maximum-attempts cap:
//    the 2026-07 crew_notes incident self-healed only because the stranded
//    ops (including a real $4,950 estimate) were still retrying when the
//    missing column finally landed. A cap would have left them dead.
//  - But back off: 1m, 5m, 30m, then hourly. An op that is not yet due is
//    DEFERRED (skipped, attempts untouched), never failed.
//  - Within one pass, skip every op whose row references the id of an op
//    that failed or was skipped earlier in the pass (transitively, so a
//    stuck estimate blocks its areas AND the areas' materials). One root
//    cause reads as ONE problem, and children never accrue phantom attempt
//    counts for a parent's failure.
//  - A manual retry ({ force: true }) ignores every backoff timer so a rep
//    who knows the problem is fixed does not wait out an hour.

// Milliseconds to wait after the Nth consecutive failure. Grows 1m -> 5m ->
// 30m and caps at ONE HOUR forever after; the cap keeps a weeks-stuck op
// retrying hourly rather than parking it.
function backoffMs(attempts) {
  if (attempts <= 1) return 60 * 1000;
  if (attempts === 2) return 5 * 60 * 1000;
  if (attempts === 3) return 30 * 60 * 1000;
  return 60 * 60 * 1000;
}

// ISO time before which an op that just failed for the Nth time should not be
// retried.
function nextAttemptAfterFailure(attempts, nowMs) {
  return new Date(nowMs + backoffMs(attempts)).toISOString();
}

// Absent nextAttemptAt means DUE: ops queued by builds older than this code
// carry no backoff field and must keep draining unchanged.
function isDue(op, nowMs, force) {
  if (force) return true;
  if (!op.nextAttemptAt) return true;
  const t = Date.parse(op.nextAttemptAt);
  return !Number.isFinite(t) || t <= nowMs;
}

// Does this op's row reference (top-level FK value, e.g. estimate_id or
// area_id) any id that failed or was skipped earlier in the pass? The scan is
// generic over row values so new child tables need no table-specific wiring.
// An op whose row.id itself is unavailable is also blocked: a second queued
// save of the same stuck row would only fail identically and inflate its
// attempt count.
function referencesUnavailable(op, unavailableIds) {
  if (!unavailableIds.size) return false;
  for (const v of Object.values(op.row || {})) {
    if (typeof v === 'string' && unavailableIds.has(v)) return true;
  }
  return false;
}

// One drain pass over the FIFO-ordered ops. I/O is injected so the estimator
// passes supabase/IndexedDB and the tests pass fakes:
//   deps.upsert(op)   -> resolves to an error message string, or null on success
//   deps.markError(op, message, nextAttemptAt) -> persist the failure
//   deps.removeOp(opId)                        -> delete the synced op
//   deps.now()                                 -> ms epoch
// Returns { synced, failed, blocked, deferred }: blocked = skipped because a
// parent is unavailable this pass, deferred = skipped waiting out backoff.
// The caller's UI can then tell "waiting" apart from "broken".
async function drainPass(ops, deps, opts) {
  const force = !!(opts && opts.force);
  let synced = 0;
  let failed = 0;
  let blocked = 0;
  let deferred = 0;
  const unavailable = new Set();
  for (const op of ops) {
    if (referencesUnavailable(op, unavailable)) {
      blocked++;
      unavailable.add(op.id);
      continue;
    }
    if (!isDue(op, deps.now(), force)) {
      deferred++;
      unavailable.add(op.id);
      continue;
    }
    let errMsg = null;
    try {
      errMsg = await deps.upsert(op);
    } catch (e) {
      errMsg = e && e.message ? e.message : String(e);
    }
    if (errMsg) {
      const attempts = (op.attempts || 0) + 1;
      await deps.markError(op, errMsg, nextAttemptAfterFailure(attempts, deps.now()));
      failed++;
      unavailable.add(op.id);
    } else {
      await deps.removeOp(op.opId);
      synced++;
    }
  }
  return { synced, failed, blocked, deferred };
}

module.exports = { backoffMs, nextAttemptAfterFailure, isDue, referencesUnavailable, drainPass };
