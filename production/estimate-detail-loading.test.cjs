const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the shipped renderer across its real awaits. No database, browser
// session, or estimate records are involved. Stop current renders at the first
// toolbar assignment: everything after that point is outside this race.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('async function renderEstimateDetail(estimateId) {');
const end = html.indexOf('\nasync function ensureEstimateToken(', start);
assert.ok(start >= 0 && end > start, 'Estimate-detail source boundaries exist');
const source = html.slice(start, end);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(pauseAt) {
  const entered = deferred(), release = deferred();
  const reachedToolbar = new Error('current render reached toolbar');
  const ids = new Map(), toolbarWrites = [];
  let paused = false;
  const gate = async name => {
    if (name === pauseAt && !paused) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
  };
  const root = {
    contains(element) { return element === root || [...ids.values()].includes(element); },
    set innerHTML(_value) { replaceShell(); },
  };
  ids.set('pecViewRoot', root);
  function replaceShell(clear = false) {
    for (const id of ['estDetailChrome', 'estInlineHost', 'estDetailBody']) {
      const old = ids.get(id);
      if (old) old.isConnected = false;
      ids.delete(id);
      if (clear) continue;
      const element = {
        id, isConnected: true, writes: [],
        set innerHTML(value) {
          this.writes.push(value);
          if (id === 'estDetailChrome') {
            toolbarWrites.push(this);
            throw reachedToolbar;
          }
        },
      };
      ids.set(id, element);
    }
  }
  const estimate = {
    id: 'synthetic-estimate', status: 'draft', intake: {},
    estimate_areas: [], estimate_line_items: [], pricing_snapshot: {},
  };
  const query = table => {
    const result = new Proxy({}, {
      get(_target, key) {
        if (key === 'then') return (resolve, reject) => (async () => {
          await gate('views');
          return { data: [], error: null, count: 0 };
        })().then(resolve, reject);
        if (key === 'maybeSingle') return async () => {
          assert.equal(table, 'estimates');
          await gate('estimate');
          return { data: estimate, error: null };
        };
        return () => result;
      },
    });
    return result;
  };
  const context = vm.createContext({
    console, Promise, Set,
    $: id => ids.get(id) || null,
    document: { getElementById: id => ids.get(id) || null },
    state: { openEstimateId: estimate.id, view: 'estimates' },
    pecEstInline: { estimateId: null, iframe: null },
    pecInlineEstimatorAlive: () => false,
    unmountInlineEstimator() {},
    pecEstDetailPinned: null,
    withFreshSession: callback => callback(),
    supabase: { from: query },
    pecEstimateHotSettings: async () => {
      await gate('settings');
      return { minViews: 3, windowHours: 48 };
    },
    estLineOptional: line => line.is_optional === true,
    esc: value => String(value ?? ''),
    fmtMoney: value => String(value ?? ''),
    estimateEffectiveStatus: value => value.status,
    pecSplitSendHtml: () => '<button>Send to customer</button>',
  });
  vm.runInContext(source, context);
  return {
    entered: entered.promise,
    resume: () => release.resolve(),
    render: () => context.renderEstimateDetail(estimate.id),
    replaceShell, toolbarWrites, reachedToolbar,
    shell: () => ['estDetailChrome', 'estInlineHost', 'estDetailBody'].map(id => ids.get(id)),
  };
}

for (const pauseAt of ['estimate', 'views', 'settings']) {
  test(`estimate detail ignores replaced or cleared views while ${pauseAt} is pending`, async () => {
    for (const change of ['replace', 'clear']) {
      const h = harness(pauseAt);
      const pending = h.render();
      await h.entered;
      const oldShell = h.shell();
      h.replaceShell(change === 'clear');
      const nextShell = h.shell();
      h.resume();
      await assert.doesNotReject(pending);
      assert.deepEqual(h.toolbarWrites, [], 'stale render never paints a toolbar');
      for (const element of [...oldShell, ...nextShell].filter(Boolean)) {
        assert.deepEqual(element.writes, [], 'neither detached nor replacement nodes are mutated');
      }
    }
  });
}

test('estimate detail continues after pending reads when its view is still current', async () => {
  const h = harness('settings');
  const pending = h.render();
  await h.entered;
  const currentChrome = h.shell()[0];
  h.resume();
  await assert.rejects(pending, error => error === h.reachedToolbar);
  assert.deepEqual(h.toolbarWrites, [currentChrome]);
});

test('a newer estimate render owns the view when an older initial fetch finishes later', async () => {
  const h = harness('estimate');
  const older = h.render();
  await h.entered;
  const oldChrome = h.shell()[0];
  await assert.rejects(h.render(), error => error === h.reachedToolbar);
  const currentChrome = h.shell()[0];
  assert.notEqual(currentChrome, oldChrome);
  h.resume();
  await assert.doesNotReject(older);
  assert.deepEqual(h.toolbarWrites, [currentChrome], 'only the newer render paints the current view');
  assert.deepEqual(oldChrome.writes, [], 'older render leaves its detached shell untouched');
});
