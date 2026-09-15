const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const requireEstimator = createRequire(path.resolve(__dirname, '../apps/estimator/package.json'));
const ts = requireEstimator('typescript');
const { IDBFactory } = requireEstimator('fake-indexeddb');
const root = path.resolve(__dirname, '../apps/estimator/src');
const session = (id, sid = id + '-session', aal = 'aal1') => ({ user: { id }, access_token: 'hdr.' + Buffer.from(JSON.stringify({ sub: id, session_id: sid, aal })).toString('base64url') + '.sig' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(overrides = {}) {
  const indexedDB = new IDBFactory();
  let current = session('A');
  let factors = { data: { all: [], totp: [] }, error: null };
  let assurance = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
  let response = async (_url, _init) => ({ ok: true, status: 200, text: async () => JSON.stringify({ auth_user_id: current.user.id, role: 'office' }) });
  const calls = [];
  const modules = new Map();
  const supabase = { auth: {
    getSession: async () => ({ data: { session: current }, error: null }),
    mfa: { listFactors: async () => { if (factors instanceof Error) throw factors; return factors; }, getAuthenticatorAssuranceLevel: async () => assurance },
  } };
  const mocks = { 'lib/supabase': { supabase, SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'public-fixture' }, ...overrides };
  const context = vm.createContext({ console, indexedDB, AbortController, AbortSignal, atob, structuredClone, setTimeout, clearTimeout, URL,
    navigator: { onLine: true }, fetch: async (url, init) => { calls.push({ url, init }); return response(url, init); } });
  function load(relative) {
    const filename = path.resolve(root, relative);
    const stem = path.relative(root, filename).replace(/\.(tsx?|js)$/, '');
    if (mocks[stem]) return mocks[stem];
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const localRequire = name => {
      if (!name.startsWith('.')) return requireEstimator(name);
      const base = path.resolve(path.dirname(filename), name);
      if (base.endsWith('.cjs')) return require(base);
      const file = [base, base + '.ts', base + '.tsx'].find(fs.existsSync);
      assert.ok(file, name); return load(file);
    };
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename })(localRequire, module, module.exports);
    return module.exports;
  }
  const account = load('offline/account.ts');
  return { indexedDB, load, account, calls, context, supabase, mocks,
    login(id, sid, aal) { current = id ? session(id, sid, aal) : null; return account.setAccount(current); },
    setSession(value) { current = value; },
    setResponse(value) { response = value; },
    setFactors(value) { factors = value; }, setAssurance(value) { assurance = value; },
  };
}

test('separate accounts cannot load one another’s drafts, templates, catalog or queue; same owner retains them', async () => {
  const h = harness(), db = h.load('offline/idb.ts'), outbox = h.load('offline/outbox.ts');
  const a = h.login('A');
  await db.idbPut('catalog', { customer: 'A private catalog' }, 'catalog');
  await db.idbPut('catalog', ['A private template'], 'description-templates');
  await db.idbPut('estimates', { id: 'draft', customer: 'A private draft' });
  await outbox.enqueue({ table: 'estimates', id: 'draft', row: { id: 'draft' }, client_updated_at: 'now' });
  h.login('B');
  assert.equal(await db.idbGet('catalog', 'catalog'), undefined);
  assert.equal(await db.idbGet('catalog', 'description-templates'), undefined);
  assert.equal(await db.idbGet('estimates', 'draft'), undefined);
  assert.equal((await outbox.listOps()).length, 0);
  assert.throws(() => h.account.assertAccount(a), /account changed/);
  h.login('A');
  assert.equal((await db.idbGet('estimates', 'draft')).customer, 'A private draft');
  assert.equal((await outbox.listOps()).length, 1);
  h.login(null);
  assert.throws(() => db.idbGet('estimates', 'draft'), /Sign in again/);
});

test('an account switch during an atomic replacement preserves the entire prior draft and queue', async () => {
  const h = harness(), db = h.load('offline/idb.ts');
  const a = h.login('A');
  await db.replaceEstimateQueue({ id: 'draft', value: 'old' }, [{ opId: 'old', ownerId: 'A' }], [], a);
  const pending = db.replaceEstimateQueue({ id: 'draft', value: 'new' }, [{ opId: 'new', ownerId: 'A' }], ['old'], a);
  h.login('B');
  await assert.rejects(pending, /account changed/);
  h.login('A');
  assert.equal((await db.idbGet('estimates', 'draft')).value, 'old');
  assert.deepEqual(Array.from(await db.idbGetAll('outbox'), op => op.opId), ['old']);
});

test('late IndexedDB reads and cached writes cannot complete into a newly signed-in account', async () => {
  const h = harness(), db = h.load('offline/idb.ts');
  const a = h.login('A');
  await db.idbPut('catalog', 'A', 'catalog');
  const read = db.idbGet('catalog', 'catalog', a);
  const write = db.idbPut('catalog', 'late A', 'catalog', a);
  h.login('B');
  await assert.rejects(read, /account changed/);
  await assert.rejects(write, /account changed/);
  assert.equal(await db.idbGet('catalog', 'catalog'), undefined);
});

test('legacy shared drafts are detected by count, never imported, changed or replayed', async () => {
  const h = harness(), db = h.load('offline/idb.ts');
  const legacy = await new Promise((resolve, reject) => {
    const req = h.indexedDB.open('pec-estimator', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('outbox', { keyPath: 'opId' });
    req.onsuccess = () => resolve(req.result); req.onerror = reject;
  });
  const original = { opId: 'legacy', row: { customer_name: 'Unassigned private draft' }, created_by: 'A' };
  await new Promise(resolve => { const t = legacy.transaction('outbox', 'readwrite'); t.objectStore('outbox').put(original); t.oncomplete = resolve; });
  h.login('A');
  assert.equal(await db.hasLegacyOfflineWork(), true);
  assert.equal((await h.load('offline/outbox.ts').listOps()).length, 0);
  const value = await new Promise(resolve => { const q = legacy.transaction('outbox').objectStore('outbox').get('legacy'); q.onsuccess = () => resolve(q.result); });
  assert.deepEqual(value, original); legacy.close();
});

test('switching accounts during a running upload aborts it and retains original queue; no B token is used', async () => {
  const h = harness(), outbox = h.load('offline/outbox.ts');
  const a = h.login('A');
  await outbox.enqueue({ table: 'estimates', id: 'draft', row: { id: 'draft' }, client_updated_at: 'now' });
  const entered = deferred(), release = deferred();
  h.setResponse(async (url, init) => {
    if (url.includes('/rpc/pec_staff_session')) return { ok: true, status: 200, text: async () => JSON.stringify({ auth_user_id: 'A', role: 'office' }) };
    entered.resolve(init); await release.promise;
    return { ok: true, status: 204, text: async () => '' };
  });
  const running = h.load('offline/sync.ts').drainOutbox({ account: a });
  const request = await entered.promise;
  h.login('B');
  assert.equal(request.signal.aborted, true);
  release.resolve();
  await assert.rejects(running, /account changed/);
  assert.equal((await outbox.listOps()).length, 0);
  h.login('A');
  assert.equal((await outbox.listOps()).length, 1, 'ambiguous response never deletes preserved queued work');
  assert.equal(h.calls.filter(call => call.url.includes('/estimates?')).length, 1);
  assert.equal(request.headers.Authorization, 'Bearer ' + session('A').access_token);
});

test('server revocation stops draining before any mutation while preserving drafts', async () => {
  const h = harness(), outbox = h.load('offline/outbox.ts');
  const before = h.login('A');
  await h.load('offline/access.ts').verifyOnlineAccess(before);
  h.calls.length = 0;
  await outbox.enqueue({ table: 'estimates', id: 'draft', row: { id: 'draft' }, client_updated_at: 'now' });
  h.setResponse(async () => ({ ok: true, status: 200, text: async () => 'null' }));
  await assert.rejects(h.load('offline/sync.ts').drainOutbox(), /current staff session/);
  assert.throws(() => h.account.captureAccount(), /Sign in again/);
  assert.equal(h.calls.length, 1);
  const reopened = h.login('A'); assert.equal((await outbox.listOps()).length, 1);
  await assert.rejects(h.load('offline/access.ts').verifyOfflineAccess(reopened), /Reconnect/);
});

test('MFA failure cannot fall back to an older offline proof, and late failure cannot clear a newer account', async () => {
  for (const bad of [new Error('network'), { data: null, error: null }, { data: { all: [null], totp: [] }, error: null }, { data: { all: [{ id: 'factor', status: ['verified'], factor_type: ['totp'] }], totp: [] }, error: null }, { data: { all: [], totp: [{ id: 'factor', factor_type: 'totp', status: 'verified' }] }, error: null }]) {
    const h = harness(), access = h.load('offline/access.ts'), a = h.login('A');
    await access.verifyOnlineAccess(a);
    h.setFactors(bad);
    await assert.rejects(access.verifyOnlineAccess(a));
    assert.throws(() => h.account.captureAccount(), /Sign in again/);
  }
  const h = harness(), access = h.load('offline/access.ts'), a = h.login('A');
  const wait = deferred();
  h.supabase.auth.mfa.listFactors = () => wait.promise;
  const running = access.verifyOnlineAccess(a);
  await tick(); h.login('B'); wait.resolve({ data: null, error: 'unavailable' });
  await assert.rejects(running, /account changed/);
  assert.equal(h.account.captureAccount().ownerId, 'B');
});

test('only already verified same-session offline access is allowed; enrolled aal1 is blocked', async () => {
  const h = harness(), access = h.load('offline/access.ts'), a = h.login('A');
  await assert.rejects(access.verifyOfflineAccess(a), /Reconnect/);
  await access.verifyOnlineAccess(a); await access.verifyOfflineAccess(a);
  const changedSession = h.login('A', 'new-session');
  await assert.rejects(access.verifyOfflineAccess(changedSession), /Reconnect/);
  const factor = { id: 'factor', factor_type: 'totp', status: 'verified' };
  h.setFactors({ data: { all: [factor], totp: [factor] }, error: null });
  await assert.rejects(access.verifyOnlineAccess(changedSession), /two-step verification/);
  const aal2 = h.login('A', undefined, 'aal2'); h.setAssurance({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null });
  await access.verifyOnlineAccess(aal2); await access.verifyOfflineAccess(aal2);
  const downgraded = h.login('A', undefined, 'aal1');
  await assert.rejects(access.verifyOfflineAccess(downgraded), /Reconnect/);
});

async function appHarness() {
  const React = requireEstimator('react');
  const { create, act } = requireEstimator('react-test-renderer');
  const firstSession = deferred();
  const listeners = new Map();
  const loaded = [], rendered = [];
  let authCallback, sessionReads = 0, nextSession = session('A');
  let catalogLoader = async () => ({ config: {} });
  const h = harness();
  h.supabase.auth.getSession = () => ++sessionReads === 1 ? firstSession.promise : Promise.resolve({ data: { session: nextSession }, error: null });
  h.supabase.auth.onAuthStateChange = callback => { authCallback = callback; return { data: { subscription: { unsubscribe() {} } } }; };
  Object.assign(h.mocks, {
    'lib/catalog': { loadCatalog: async () => { const owner = h.account.captureAccount().ownerId; loaded.push(owner); return catalogLoader(owner); }, getCachedCatalog: async () => undefined },
    'offline/access': { verifyOnlineAccess: async () => ({ role: 'office' }), verifyOfflineAccess: async () => {} },
    'offline/sync': { drainOutbox: async () => {} },
    'lib/lead': { embedFromUrl: () => true, estimateIdFromUrl: () => null, focusLineFromUrl: () => null, leadIdFromUrl: () => null, loadLeadLink: async () => null },
    'lib/estimateLoad': { loadEstimateForEdit: async () => null },
    'features/estimator/EstimatorScreen': { __esModule: true, default: props => { rendered.push(props.createdBy); return React.createElement('div', null, 'Account ' + props.createdBy); } },
  });
  const parent = {};
  h.context.window = { location: { origin: 'https://fixture.invalid' }, parent,
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: type => listeners.delete(type), setInterval: () => 1, clearInterval() {},
  };
  const App = h.load('App.tsx').default;
  let renderer;
  await act(async () => { renderer = create(React.createElement(App)); });
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); };
  return { ...h, loaded, rendered, firstSession, flush,
    catalog(callback) { catalogLoader = callback; },
    async auth(id, event = 'SIGNED_IN') { nextSession = id ? session(id) : null; await act(async () => { authCallback(event, nextSession); }); await flush(); },
    async message(type, valid = true) { await act(async () => { listeners.get('message')?.({ origin: valid ? 'https://fixture.invalid' : 'https://other.invalid', source: parent, data: { type } }); }); await flush(); },
    text: () => JSON.stringify(renderer.toJSON()),
    async close() { await act(async () => renderer.unmount()); },
  };
}

test('a slow initial session read cannot restore account A after a newer account B auth event', async () => {
  const h = await appHarness();
  await h.auth('B');
  h.firstSession.resolve({ data: { session: session('A') }, error: null });
  await h.flush();
  assert.equal(h.account.captureAccount().ownerId, 'B');
  assert.ok(h.text().includes('Account B'));
  assert.ok(!h.rendered.includes('A'));
  await h.close();
});

test('parent clear latches through token refresh, rejects wrong-origin events, and discards late load results', async () => {
  const h = await appHarness(), oldLoad = deferred();
  let calls = 0;
  h.catalog(() => ++calls === 1 ? oldLoad.promise : Promise.resolve({ config: {} }));
  h.firstSession.resolve({ data: { session: session('A') }, error: null });
  await h.flush();
  assert.equal(h.loaded.length, 1);
  await h.message('pec-auth-cleared', false);
  assert.equal(h.account.captureAccount().ownerId, 'A');
  await h.message('pec-auth-cleared');
  await h.auth('A', 'TOKEN_REFRESHED');
  assert.throws(() => h.account.captureAccount(), /Sign in again/);
  oldLoad.resolve({ config: {} }); await h.flush();
  assert.ok(!h.text().includes('Account A'));
  assert.equal(h.rendered.length, 0, 'old catalog cannot remount cleared account');
  await h.message('pec-auth-ready');
  assert.ok(h.text().includes('Account A'));
  await h.auth(null, 'SIGNED_OUT');
  assert.ok(!h.text().includes('Account A'));
  await h.close();
});

test('an in-progress IndexedDB commit rolls back both stores on sign-out', async () => {
  const h = harness(), db = h.load('offline/idb.ts'), a = h.login('A');
  await db.replaceEstimateQueue({ id: 'draft', value: 'old' }, [{ opId: 'old', ownerId: 'A' }], [], a);
  const opened = await new Promise(resolve => { const q = h.indexedDB.open(h.account.accountDatabaseName('A')); q.onsuccess = () => resolve(q.result); });
  const prototype = Object.getPrototypeOf(opened), original = prototype.transaction;
  prototype.transaction = function (...args) {
    const tx = original.apply(this, args);
    if (args[1] === 'readwrite' && Array.isArray(args[0])) queueMicrotask(() => h.login(null));
    return tx;
  };
  try {
    await assert.rejects(db.replaceEstimateQueue({ id: 'draft', value: 'new' }, [{ opId: 'new', ownerId: 'A' }], ['old'], a), /paused|Abort/);
  } finally { prototype.transaction = original; opened.close(); }
  h.login('A');
  assert.equal((await db.idbGet('estimates', 'draft')).value, 'old');
  assert.deepEqual(Array.from(await db.idbGetAll('outbox'), op => op.opId), ['old']);
});
