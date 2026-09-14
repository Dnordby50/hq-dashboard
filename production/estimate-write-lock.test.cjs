const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../apps/estimator/node_modules/typescript');
const drainPolicy = require('./outbox-drain.cjs');

function loadModule(file, imports = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'apps/estimator/src/offline', file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require(name) { assert.ok(name in imports, `known import ${name}`); return imports[name]; },
  });
  return exports;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const operation = (id, table = 'estimate_line_items') => ({
  opId: 'op-' + id, table, id, row: { id, estimate_id: 'estimate-1' },
  attempts: 0, status: 'pending', client_updated_at: '2026-09-14T12:00:00Z',
});

// Run the real drain and lock with a controllable network and durable queue.
function harness(initial = []) {
  const queue = [...initial], live = new Map(), events = [];
  let beforeUpload = async () => {}, failRead = false;
  const lock = loadModule('writeLock.ts');
  const sync = loadModule('sync.ts', {
    './writeLock': lock,
    '../../../../production/outbox-drain.cjs': drainPolicy,
    '../lib/supabase': { supabase: { from: table => ({ upsert: async row => {
      events.push('upload-start:' + row.id);
      await beforeUpload(row);
      live.set(row.id, { table, ...row });
      events.push('upload-end:' + row.id);
      return { error: null };
    } }) } },
    './outbox': {
      listOps: async () => {
        events.push('queue-read');
        if (failRead) { failRead = false; throw new Error('queue read failed'); }
        return [...queue];
      },
      removeOp: async opId => {
        const index = queue.findIndex(op => op.opId === opId);
        if (index >= 0) queue.splice(index, 1);
      },
      markError: async () => { throw new Error('unexpected upload error'); },
    },
  });
  return {
    ...lock, ...sync, queue, live, events,
    beforeUpload(callback) { beforeUpload = callback; },
    failNextRead() { failRead = true; },
  };
}

test('replacement waits for the entire old drain snapshot before removing old children', async () => {
  const h = harness([operation('old-area', 'estimate_areas'), operation('old-line')]);
  const entered = deferred(), release = deferred();
  h.beforeUpload(async row => {
    if (row.id === 'old-area') { entered.resolve(); await release.promise; }
  });
  const oldDrain = h.drainOutbox();
  await entered.promise;
  const replacement = h.withEstimateWriteLock(async () => {
    h.events.push('replace');
    h.live.clear();
    h.queue.splice(0, h.queue.length, operation('new-area', 'estimate_areas'), operation('new-line'));
  });
  await tick();
  assert.equal(h.events.includes('replace'), false, 'no deletes while old uploads are pending');
  release.resolve();
  await Promise.all([oldDrain, replacement]);
  assert.ok(h.events.indexOf('replace') > h.events.indexOf('upload-end:old-line'));
  await h.drainOutbox();
  assert.deepEqual([...h.live.keys()], ['new-area', 'new-line'], 'old snapshot cannot restore stale children');
  assert.equal(h.queue.length, 0);
});

test('background and manual drains wait for a complete replacement and share one pass', async () => {
  const h = harness();
  const entered = deferred(), release = deferred();
  const replacement = h.withEstimateWriteLock(async () => {
    h.queue.push(operation('new-area', 'estimate_areas'));
    entered.resolve();
    await release.promise;
    h.queue.push(operation('new-line'));
  });
  await entered.promise;
  const background = h.drainOutbox();
  const manual = h.drainOutbox({ force: true });
  await tick();
  assert.equal(h.events.includes('queue-read'), false, 'the drain does not snapshot a partial replacement');
  release.resolve();
  await replacement;
  const results = await Promise.all([background, manual]);
  assert.equal(results[0].synced, 2);
  assert.equal(results[1].synced, 2);
  assert.deepEqual([...h.live.keys()], ['new-area', 'new-line']);
  assert.equal(h.events.filter(event => event.startsWith('upload-start:')).length, 2, 'concurrent drain requests do not duplicate uploads');
});

test('a rejected write releases the lock for the next write and drain', async () => {
  const h = harness();
  const entered = deferred(), release = deferred();
  const failed = h.withEstimateWriteLock(async () => {
    entered.resolve();
    await release.promise;
    throw new Error('replacement failed');
  });
  const rejection = assert.rejects(failed, /replacement failed/);
  await entered.promise;
  const next = h.withEstimateWriteLock(async () => {
    h.events.push('next-write');
    h.queue.push(operation('recovered-line'));
    return 'saved';
  });
  const drain = h.drainOutbox();
  await tick();
  assert.equal(h.events.includes('next-write'), false);
  release.resolve();
  await rejection;
  assert.equal(await next, 'saved');
  assert.equal((await drain).synced, 1);
  assert.equal(h.live.has('recovered-line'), true);
});

test('a rejected drain releases both the write lock and drain single-flight state', async () => {
  const h = harness();
  h.failNextRead();
  await assert.rejects(h.drainOutbox(), /queue read failed/);
  await h.withEstimateWriteLock(async () => { h.queue.push(operation('after-retry')); });
  assert.equal((await h.drainOutbox()).synced, 1);
  assert.equal(h.queue.length, 0);
  assert.equal(h.live.has('after-retry'), true);
});

test('synchronous callback errors do not poison later work', async () => {
  const h = harness();
  await assert.rejects(h.withEstimateWriteLock(() => { throw new Error('before first await'); }), /before first await/);
  assert.equal(await h.withEstimateWriteLock(async () => 7), 7);
});
