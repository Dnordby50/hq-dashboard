const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Render the shipped screen with React's actual hooks and effects. Only the
// browser, storage/network adapters and unrelated child widgets are replaced.
// The real calculator and scope helpers still produce the captured save rows.
const root = path.join(__dirname, '..');
const estimatorRequire = createRequire(path.join(root, 'apps/estimator/package.json'));
const React = estimatorRequire('react');
const { create, act } = estimatorRequire('react-test-renderer');
const ts = estimatorRequire('typescript');
const screenPath = path.join(root, 'apps/estimator/src/features/estimator/EstimatorScreen.tsx');
const compiled = new Map();

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node?.children || []).map(textOf).join('');
}

const customer = {
  isCommercial: false, firstName: 'Fixture', lastName: 'Customer', company: '',
  phone: '9285550142', email: 'fixture@example.invalid', address1: '123 Fixture Way',
  address2: '', city: 'Prescott', state: 'AZ', zip: '86301',
};

function existingEstimate() {
  return {
    id: 'fixture-estimate', estimateNumber: 999999, status: 'draft', sentAt: null,
    systemTypeId: null, mvb: 'none', flakeColor: null, leadId: 'fixture-lead',
    leadSource: 'Google', createdBy: 'fixture-user', customer: { ...customer },
    intake: { salesperson_id: 'fixture-salesperson' }, pricingSnapshot: null,
    scopeEditedAt: null, hasScope: true, scopeOfWork: 'Prepare and coat the fixture area.',
    scopeStale: false, scopeAnswers: {}, priceOverrideReason: null,
    areas: [{
      name: 'Fixture coating', sqft: '100', systemTypeId: null, mvb: false,
      slotValues: {}, isCustom: true, customLabel: 'Fixture coating',
      customScope: 'Prepare and coat the fixture area.', customMaterialCost: '100',
      customLaborHours: '1', notes: '', priceOverride: '1000', isOptional: false,
      preselected: true, lineDescription: '',
    }],
    addonLines: [], installments: [], isCustom: false, customScope: '',
    customPrice: '', customSqft: '', crewNotes: '', clientNotes: '', companyNotes: '',
  };
}

function catalog() {
  return {
    systemTypes: [], productsById: {}, recipeSlotsBySystemType: {}, addons: [],
    leadSources: ['Google', 'Referral', 'Home Show'],
    salespeople: [{ id: 'fixture-salesperson', name: 'Fixture Rep', commission_pct: 0,
      active: true, auth_user_id: 'fixture-user' }],
    config: {
      laborRate: 30, standardCommissionPct: 0, targetGpPct: 50, priceIncrement: 1,
      charmThreshold: 0, charmBand: 0, sundriesPct: 0, floorGpPct: 40,
      linePricingGpFloorPct: 40, linePricingBlockBelowFloor: true,
      linePricingCustomLabelDefault: 'Custom work', linePricingReasonThresholdPct: 2,
      linePricingReasonThresholdDollars: 100, estimateAiEnabled: false, compsMinSample: 3,
      optionalLinesEnabled: true, optionalLinesPreselectDefault: true,
      optionalLinesGpWarnPct: 40, estimateScheduleEnabled: true,
      estimateScheduleAutoseed: false, defaultDepositPct: 50, hideMaterialQty: false,
      commissionConfigured: true, customerSearchEnabled: false,
      estimateLineGenerateEnabled: false, estimateLinePolishEnabled: false,
      lineSheetBreakpointPx: 700, syncStuckThreshold: 2, syncStuckEscalationEnabled: false,
      estimateAutosaveEnabled: true,
    },
  };
}

async function harness(options = {}) {
  let now = 0, timerId = 0, uuidId = 0, activeWrites = 0, maxActiveWrites = 0;
  const timers = new Map(), listeners = new Map(), saves = [], deletes = [], confirms = [], messages = [];
  const addEventListener = (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
  };
  const removeEventListener = (name, fn) => listeners.get(name)?.delete(fn);
  const setTimeout = (fn, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { fn, at: now + delay });
    return id;
  };
  const clearTimeout = id => timers.delete(id);
  const document = {
    hidden: false, addEventListener, removeEventListener, referrer: '',
    getElementById: () => null, querySelector: () => null,
    documentElement: { dataset: {} }, body: { classList: { add() {} } },
  };
  const window = {
    setTimeout, clearTimeout, addEventListener, removeEventListener,
    location: { origin: 'https://fixture.invalid', href: '' },
    history: { length: 1 }, parent: { postMessage(message) { messages.push(JSON.parse(JSON.stringify(message))); } },
    confirm(message) { confirms.push(message); return false; },
  };
  const query = new Proxy({}, {
    get(_target, key) {
      if (key === 'then') return (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject);
      if (key === 'maybeSingle' || key === 'single') return async () => ({ data: null, error: null });
      return () => query;
    },
  });
  const saveEstimateOffline = async payload => {
    // Clone at the persistence boundary so later edits cannot alter evidence.
    saves.push(JSON.parse(JSON.stringify(payload)));
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    try {
      if (options.onSave) await options.onSave(payload, saves.length);
      return { id: payload.estimateId, areaIds: ['fixture-area'] };
    } finally { activeWrites -= 1; }
  };
  const mocks = {
    'lib/useOnline': { useOnline: () => options.online !== false },
    'offline/estimates': { CUSTOM_LINE_LABEL: 'Custom estimate', saveEstimateOffline },
    'lib/estimateLoad': { deleteEstimateChildren: async id => { deletes.push(id); } },
    'offline/outbox': { listOps: async () => options.listOps ? options.listOps() : [] },
    'offline/sync': { drainOutbox: async () => { if (options.drainOutbox) await options.drainOutbox(); } },
    'lib/comps': { loadCompCandidates: async () => [], buildComps: () => null,
      compsGpCaveat: () => '', compsRuleLabel: () => '' },
    'lib/ai': { compsForAi: () => null, fetchAiRecommendation: async () => null },
    'lib/supabase': { scopedSupabase: () => ({ from: () => query, auth: { getSession: async () => ({ data: { session: null } }) } }) },
    'lib/customerSearch': { searchCustomersAndLeads: async () => [], ensureLeadForCustomer: async () => 'fixture-lead' },
    'offline/uuid': { uuid: () => `fixture-uuid-${++uuidId}` },
    'features/estimator/AddressAutocomplete': { __esModule: true, default: 'address-autocomplete' },
    'features/estimator/BottomSheet': { __esModule: true, default: ({ children, footer }) => React.createElement('bottom-sheet', null, children, footer) },
    'features/estimator/ScopeEditor': { __esModule: true, default: 'scope-editor' },
  };
  const context = vm.createContext({
    console, window, document, AbortController, atob, navigator: { onLine: options.online !== false }, URL, setTimeout, clearTimeout,
    fetch: async url => {
      assert.equal(url, '/estimator/index.html', 'No fixture request may reach production');
      return { ok: false };
    },
  });
  const modules = new Map();
  function load(filename) {
    const stem = path.relative(path.join(root, 'apps/estimator/src'), filename).replace(/\.(tsx?|js)$/, '');
    if (mocks[stem]) return mocks[stem];
    if (filename.endsWith('.cjs')) return require(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    if (!compiled.has(filename)) {
      const source = fs.readFileSync(filename, 'utf8').replace(/import\.meta\.url/g, '"https://fixture.invalid/screen.js"');
      compiled.set(filename, ts.transpileModule(source, {
        fileName: filename, compilerOptions: {
          target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
        },
      }).outputText);
    }
    const localRequire = spec => {
      if (!spec.startsWith('.')) return estimatorRequire(spec);
      const resolved = path.resolve(path.dirname(filename), spec);
      const found = [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`].find(file => fs.existsSync(file));
      assert.ok(found, `Resolve screen import ${spec}`);
      return load(found);
    };
    vm.runInContext(`(function(require,module,exports) {\n${compiled.get(filename)}\n})`, context,
      { filename })(localRequire, module, module.exports);
    return module.exports;
  }
  const accountApi = load(path.join(root, 'apps/estimator/src/offline/account.ts'));
  const account = accountApi.setAccount({ user: { id: 'fixture-user' }, access_token: 'header.' + Buffer.from(JSON.stringify({ session_id: 'fixture-session' })).toString('base64url') + '.signature' });
  const Screen = load(screenPath).default;
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(Screen, {
      account, catalog: catalog(), createdBy: 'fixture-user', viewerIsAdmin: false,
      catalogFromCache: false, leadLink: null, embed: false,
      editing: existingEstimate(), ...options.props,
    }));
  });
  const h = {
    saves, deletes, confirms, messages,
    get root() { return renderer.root; },
    get maxActiveWrites() { return maxActiveWrites; },
    text: () => textOf(renderer.toJSON()),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        await act(async () => { next[1].fn(); });
      }
      now = end;
      await act(async () => {});
    },
    async change(label, value) {
      const labels = renderer.root.findAll(node => node.type === 'label' && textOf(node).startsWith(label));
      assert.equal(labels.length, 1, `Find one ${label} field`);
      const control = labels[0].find(node => ['input', 'select', 'textarea'].includes(node.type));
      await act(async () => { control.props.onChange({ target: { value } }); });
    },
    async clickLabel(label) {
      const button = renderer.root.findAll(node => node.type === 'button' && textOf(node) === label);
      assert.equal(button.length, 1, `Find one ${label} button`);
      await act(async () => { button[0].props.onClick(); });
    },
    async editLinePrice(value) {
      const line = renderer.root.findByProps({ 'aria-label': 'Edit line Fixture coating' });
      await act(async () => { line.props.onClick(); });
      await h.change('Price $ (you set it', value);
      await h.clickLabel('Done');
    },
    async addDiscount(amount) {
      await h.clickLabel('+ Discount');
      await h.change('Discount amount $', amount);
      await h.clickLabel('Done');
    },
    async editCustomer() {
      const summary = renderer.root.findAll(node => node.props['aria-label'] === 'Customer info, click to edit');
      if (summary.length) await act(async () => { summary[0].props.onClick(); });
    },
    async event(name, payload = {}) {
      if (name === 'visibilitychange') document.hidden = true;
      await act(async () => { for (const fn of listeners.get(name) || []) fn(payload); });
    },
    async flush(overrides = {}) {
      await h.event('message', {
        origin: window.location.origin, source: window.parent,
        data: { type: 'pec-estimator-flush', request_id: 'fixture-request', estimate_id: 'fixture-estimate' },
        ...overrides,
      });
    },
    flushReplies: () => messages.filter(message => message.type === 'pec-estimator-flushed'),
    async dispose() { await act(async () => { renderer.unmount(); }); },
  };
  return h;
}

test('reading an existing estimate does not create an autosave', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.advance(6000);
  assert.equal(h.saves.length, 0);
});

for (const [label, edit, expected] of [
  ['Per-line price', async h => h.editLinePrice('990'), 990],
  ['Discount line', async h => h.addDiscount('50'), 950],
]) {
  test(`${label} alone marks the estimate dirty and autosaves the new total`, async t => {
    const h = await harness(); t.after(() => h.dispose());
    await edit(h);
    await h.advance(2500);
    assert.equal(h.saves.length, 1);
    assert.equal(h.saves[0].totals.price, expected);
    assert.equal(h.saves[0].status, undefined, 'An edit never rewrites estimate status');
    assert.match(h.text(), /All changes saved/);
  });
}

test('a lead source-only edit autosaves the selected source', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.editCustomer();
  await h.change('Lead source', 'Referral');
  await h.advance(2500);
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].leadSource, 'Referral');
  assert.equal(h.saves[0].leadId, 'fixture-lead');
});

test('a below-floor price with no override reason still autosaves without confirmation', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.addDiscount('850');
  await h.advance(2500);
  assert.equal(h.saves.length, 1, 'The incomplete price approval must not prevent persistence');
  assert.equal(h.saves[0].totals.price, 150);
  assert.ok(h.saves[0].totals.gpPct < 0.4, 'Fixture actually crosses the configured GP floor');
  assert.equal(h.saves[0].priceOverride, null, 'The fixture has no price override reason');
  assert.deepEqual(h.confirms, []);
  assert.match(h.text(), /All changes saved/);
  assert.match(h.text(), /before sending|required to send/);
});

test('edits during saving queue behind the active writer and preserve the latest price and source', async t => {
  const hold = deferred();
  const h = await harness({ onSave: (_payload, index) => index === 1 ? hold.promise : undefined });
  t.after(async () => { hold.resolve(); await h.dispose(); });
  await h.editLinePrice('990');
  await h.advance(2500);
  assert.equal(h.saves.length, 1);
  await h.editLinePrice('950');
  await h.editCustomer();
  await h.change('Lead source', 'Referral');
  await h.event('visibilitychange');
  await h.event('pagehide');
  await h.advance(3000);
  assert.equal(h.saves.length, 1, 'No overlapping save while the first writer is pending');
  assert.equal(h.maxActiveWrites, 1);
  await act(async () => { hold.resolve(); });
  await h.advance(3000);
  assert.equal(h.saves.length, 2, 'The latest pending snapshot is saved once');
  assert.equal(h.saves[0].totals.price, 990);
  assert.equal(h.saves[1].totals.price, 950);
  assert.equal(h.saves[1].leadSource, 'Referral');
  assert.equal(h.maxActiveWrites, 1);
  assert.match(h.text(), /All changes saved/);
});

test('the first new estimate draft and later full save retain the newly selected source', async t => {
  const h = await harness({ props: {
    editing: null,
    leadLink: { id: 'fixture-lead', name: 'Fixture Customer', phone: customer.phone,
      email: customer.email, address1: customer.address1, city: customer.city,
      state: customer.state, zip: customer.zip, source: 'Google' },
  } });
  t.after(() => h.dispose());
  await h.editCustomer();
  await h.clickLabel('Job details');
  await h.clickLabel('Custom');
  await h.clickLabel('Estimate');
  const editor = h.root.findByType('scope-editor');
  await act(async () => { editor.props.onChange('Prepare and coat the fixture area.'); });
  await h.change('Price $', '1000');
  // Change attribution last, after the early-draft callback already captured
  // all other inputs. This catches a missing leadSource callback dependency.
  await h.change('Lead source', 'Home Show');
  await h.advance(800);
  assert.ok(h.saves.length >= 1, 'A new draft exists once it has estimate content');
  assert.equal(h.saves[0].leadSource, 'Home Show');
  await h.advance(2500);
  assert.equal(h.saves.at(-1).leadSource, 'Home Show');
  assert.equal(h.saves.at(-1).totals.price, 1000);
  assert.equal(new Set(h.saves.map(save => save.estimateId)).size, 1, 'Draft and full save share one estimate');
});

test('a delayed initial draft finishes before the full autosave writes priced children', async t => {
  const hold = deferred();
  const h = await harness({
    onSave: (_payload, index) => index === 1 ? hold.promise : undefined,
    props: {
      editing: null,
      leadLink: { id: 'fixture-lead', name: 'Fixture Customer', phone: customer.phone,
        email: customer.email, address1: customer.address1, source: 'Google' },
    },
  });
  t.after(async () => { hold.resolve(); await h.dispose(); });
  await h.clickLabel('Job details');
  await h.clickLabel('Custom');
  await h.clickLabel('Estimate');
  await act(async () => { h.root.findByType('scope-editor').props.onChange('Prepare and coat the fixture area.'); });
  await h.change('Price $', '1000');
  await h.advance(800);
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].totals.price, null, 'The pending write is the initial lightweight draft');
  await h.advance(2500);
  assert.equal(h.saves.length, 1, 'Full autosave waits for the initial draft to finish');
  await act(async () => { hold.resolve(); });
  await h.advance(2500);
  assert.equal(h.saves.length, 2);
  assert.equal(h.saves[1].totals.price, 1000);
  assert.equal(h.maxActiveWrites, 1);
});

test('the parent send flush waits for a below-floor draft to finish saving', async t => {
  const hold = deferred();
  const h = await harness({ props: { embed: true }, onSave: () => hold.promise });
  t.after(async () => { hold.resolve(); await h.dispose(); });
  await h.editLinePrice('150');
  await h.flush();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].totals.price, 150);
  assert.deepEqual(h.flushReplies(), [], 'Do not authorize sending an unsaved edit');
  await act(async () => { hold.resolve(); });
  assert.equal(h.flushReplies().length, 1);
  assert.equal(h.flushReplies()[0].ok, true);
  assert.deepEqual(h.confirms, []);
});

test('the parent send flush includes a newer edit arriving during an older save', async t => {
  const hold = deferred();
  const h = await harness({ props: { embed: true }, onSave: (_payload, index) => index === 1 ? hold.promise : undefined });
  t.after(async () => { hold.resolve(); await h.dispose(); });
  await h.editLinePrice('990');
  await h.advance(2500);
  await h.editLinePrice('150');
  await h.flush();
  assert.deepEqual(h.flushReplies(), []);
  await act(async () => { hold.resolve(); });
  assert.equal(h.saves.length, 2);
  assert.equal(h.saves[1].totals.price, 150);
  assert.equal(h.flushReplies().length, 1);
  assert.equal(h.flushReplies()[0].ok, true);
  assert.equal(h.maxActiveWrites, 1);
});

test('the parent send flush refuses an offline estimate', async t => {
  const h = await harness({ props: { embed: true }, online: false }); t.after(() => h.dispose());
  await h.flush();
  assert.equal(h.saves.length, 0);
  assert.equal(h.flushReplies().length, 1);
  assert.equal(h.flushReplies()[0].ok, false);
  assert.match(h.flushReplies()[0].error, /Reconnect/);
});

for (const [table, row, id] of [
  ['estimates', {}, 'fixture-estimate'],
  ['estimate_line_items', { estimate_id: 'fixture-estimate' }, 'fixture-line'],
  ['estimate_area_materials', { estimate_area_id: 'fixture-area' }, 'fixture-material'],
]) {
  test(`the parent send flush refuses queued ${table} writes belonging to this estimate`, async t => {
    const h = await harness({ props: { embed: true }, listOps: () => [{ table, row, id }] });
    t.after(() => h.dispose());
    await h.editLinePrice('990');
    await h.flush();
    assert.equal(h.saves.length, 1, 'Local save completes before checking remaining sync work');
    assert.equal(h.flushReplies().length, 1);
    assert.equal(h.flushReplies()[0].ok, false);
    assert.match(h.flushReplies()[0].error, /still need to sync/);
  });
}

test('the parent send flush does not block on an unrelated estimate in the outbox', async t => {
  const h = await harness({ props: { embed: true }, listOps: () => [
    { table: 'estimates', id: 'unrelated-estimate', row: {} },
    { table: 'estimate_line_items', id: 'unrelated-line', row: { estimate_id: 'unrelated-estimate' } },
  ] });
  t.after(() => h.dispose());
  await h.flush();
  assert.equal(h.flushReplies().length, 1);
  assert.equal(h.flushReplies()[0].ok, true);
});

test('the parent send flush reports a failed save without claiming success', async t => {
  const h = await harness({ props: { embed: true }, onSave: () => { throw new Error('fixture write failed'); } });
  t.after(() => h.dispose());
  await h.editLinePrice('990');
  await h.flush();
  assert.equal(h.flushReplies().length, 1);
  assert.equal(h.flushReplies()[0].ok, false);
  assert.match(h.flushReplies()[0].error, /could not save/);
});

test('the parent send flush ignores wrong origin, source and estimate identity', async t => {
  const h = await harness({ props: { embed: true } }); t.after(() => h.dispose());
  await h.editLinePrice('990');
  await h.flush({ origin: 'https://unrelated.invalid' });
  await h.flush({ source: {} });
  await h.flush({ data: { type: 'pec-estimator-flush', request_id: 'wrong-estimate', estimate_id: 'unrelated-estimate' } });
  assert.deepEqual(h.flushReplies(), []);
  assert.equal(h.saves.length, 0);
});
