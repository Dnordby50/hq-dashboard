// Fixture tests for the outbox drain policy (prompt 48, Part B), driving the
// SAME production/outbox-drain.cjs module the estimator's sync loop imports,
// so what passes here is literally what runs in the app:
//   - backoff schedule 1m -> 5m -> 30m -> hourly, capped at ONE HOUR forever
//     (deliberately NO maximum-attempts cap: the crew_notes incident
//     self-healed only because the stranded ops were still retrying);
//   - children of a failed parent are SKIPPED for the pass, transitively,
//     with their attempt counts untouched;
//   - children of a SUCCESSFUL parent sync normally in the same pass;
//   - a manual retry (force) ignores every backoff timer;
//   - an op queued by a pre-backoff build (no nextAttemptAt) is due;
//   - the Chris Lopez case: an op failed for days recovers the moment the
//     upsert starts succeeding, children following in the same pass.
// Run: node production/outbox-backoff.test.cjs
'use strict';
const { backoffMs, nextAttemptAfterFailure, isDue, drainPass } = require('./outbox-drain.cjs');
const { makeChecker } = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

const MIN = 60 * 1000;
const NOW = Date.parse('2026-07-25T17:00:00Z');

// A fake outbox + supabase: failFor lists op ids whose upsert errors.
function makeWorld(ops, { failIds = new Set(), now = NOW } = {}) {
  const world = {
    ops: ops.map((o) => ({ ...o })),
    removed: [],
    errored: [], // { opId, message, nextAttemptAt }
    upserts: [],
  };
  world.deps = {
    upsert: async (op) => {
      world.upserts.push(op.opId);
      return failIds.has(op.id) ? `Could not find the 'crew_notes' column of 'estimates' in the schema cache` : null;
    },
    markError: (op, message, nextAttemptAt) => {
      world.errored.push({ opId: op.opId, message, nextAttemptAt });
    },
    removeOp: (opId) => {
      world.removed.push(opId);
    },
    now: () => now,
  };
  return world;
}

// The incident shape: one estimate, its area, the area's material, and a line
// item. FIFO order guarantees the parent comes first.
const EST = 'e1000';
const AREA = 'a2000';
const ops = () => [
  { opId: '01_est', table: 'estimates', id: EST, row: { id: EST, status: 'draft', crew_notes: 'x' }, attempts: 0 },
  { opId: '02_area', table: 'estimate_areas', id: AREA, row: { id: AREA, estimate_id: EST }, attempts: 0 },
  { opId: '03_mat', table: 'estimate_area_materials', id: 'm3000', row: { id: 'm3000', area_id: AREA }, attempts: 0 },
  { opId: '04_li', table: 'estimate_line_items', id: 'l4000', row: { id: 'l4000', estimate_id: EST }, attempts: 0 },
];

(async () => {
  console.log('# backoff schedule: 1m, 5m, 30m, then hourly forever (no cap)');
  {
    ok(backoffMs(1) === 1 * MIN, '1st failure -> 1 minute');
    ok(backoffMs(2) === 5 * MIN, '2nd failure -> 5 minutes');
    ok(backoffMs(3) === 30 * MIN, '3rd failure -> 30 minutes');
    ok(backoffMs(4) === 60 * MIN, '4th failure -> 1 hour');
    ok(backoffMs(500) === 60 * MIN, '500th failure -> STILL 1 hour, never parked');
    ok(nextAttemptAfterFailure(1, NOW) === new Date(NOW + MIN).toISOString(), 'next-attempt time is now + schedule');
  }

  console.log('# due check: absent-means-due (pre-backoff builds keep draining)');
  {
    ok(isDue({ attempts: 4 }, NOW), 'op with no nextAttemptAt is due');
    ok(!isDue({ nextAttemptAt: new Date(NOW + MIN).toISOString() }, NOW), 'op inside its backoff window is not due');
    ok(isDue({ nextAttemptAt: new Date(NOW - 1).toISOString() }, NOW), 'op past its backoff window is due');
    ok(isDue({ nextAttemptAt: 'garbage' }, NOW), 'unparseable timestamp fails open (due)');
    ok(isDue({ nextAttemptAt: new Date(NOW + MIN).toISOString() }, NOW, true), 'force (manual Retry now) ignores the timer');
  }

  console.log('# one bad parent = one problem: children skipped, transitively');
  {
    const w = makeWorld(ops(), { failIds: new Set([EST]) });
    const r = await drainPass(w.ops, w.deps);
    ok(r.failed === 1 && r.blocked === 3 && r.synced === 0, 'estimate fails once; area, material, line item all blocked');
    ok(w.upserts.length === 1 && w.upserts[0] === '01_est', 'only the parent was actually tried');
    ok(w.errored.length === 1 && w.errored[0].opId === '01_est', 'only the parent accrues an attempt');
    ok(w.errored[0].nextAttemptAt === new Date(NOW + MIN).toISOString(), 'first failure backs off 1 minute');
  }

  console.log('# mid-chain failure: material blocked by its AREA, line item by the estimate');
  {
    const w = makeWorld(ops(), { failIds: new Set([AREA]) });
    const r = await drainPass(w.ops, w.deps);
    ok(r.synced === 2 && r.failed === 1 && r.blocked === 1, 'estimate + line item sync; area fails; material blocked');
    ok(!w.upserts.includes('03_mat'), 'the material (child of the failed area) was never tried');
  }

  console.log('# healthy chain: children NOT skipped when the parent succeeds');
  {
    const w = makeWorld(ops());
    const r = await drainPass(w.ops, w.deps);
    ok(r.synced === 4 && r.failed === 0 && r.blocked === 0 && r.deferred === 0, 'all four ops sync in one pass');
    ok(w.removed.length === 4, 'all four removed from the queue');
  }

  console.log('# backoff defers without failing, and defers the children too');
  {
    const later = new Date(NOW + 30 * MIN).toISOString();
    const w = makeWorld(ops().map((o) => (o.id === EST ? { ...o, attempts: 2, nextAttemptAt: later } : o)));
    const r = await drainPass(w.ops, w.deps);
    ok(r.deferred === 1 && r.blocked === 3 && r.failed === 0, 'parent deferred; children wait with it, nothing counted failed');
    ok(w.errored.length === 0, 'a deferred pass accrues zero attempts');
  }

  console.log('# manual retry: force drains a backed-off op immediately');
  {
    const later = new Date(NOW + 30 * MIN).toISOString();
    const w = makeWorld(ops().map((o) => ({ ...o, attempts: 3, nextAttemptAt: later })));
    const r = await drainPass(w.ops, w.deps, { force: true });
    ok(r.synced === 4 && r.deferred === 0, 'force ignores every timer and syncs the lot');
  }

  console.log('# the Chris Lopez case: a long-stuck op recovers when the schema catches up');
  {
    // 4 failed attempts over a week, backoff long expired; the crew_notes
    // column finally exists so the upsert now succeeds.
    const stuck = ops().map((o) => (o.id === EST
      ? { ...o, attempts: 4, status: 'error', lastError: 'crew_notes missing', nextAttemptAt: new Date(NOW - 2 * MIN).toISOString() }
      : o));
    const w = makeWorld(stuck);
    const r = await drainPass(w.ops, w.deps);
    ok(r.synced === 4 && r.failed === 0, 'estimate and all three children drain in the same pass');
  }

  console.log('# no cap: a due op is ALWAYS tried, whatever its attempt count');
  {
    const w = makeWorld([{ opId: '01', table: 'estimates', id: EST, row: { id: EST }, attempts: 9999 }], { failIds: new Set([EST]) });
    const r = await drainPass(w.ops, w.deps);
    ok(w.upserts.length === 1 && r.failed === 1, 'attempt 10000 still happens');
    ok(w.errored[0].nextAttemptAt === new Date(NOW + 60 * MIN).toISOString(), 'and re-arms at the hourly cap, not parked');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  if (state.failed) process.exit(1);
})();
