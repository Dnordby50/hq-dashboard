const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Use the same actual-screen adapter as the autosave regressions. Only the
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
  let storedOps = [];
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
  const queryFor = table => {
    const query = new Proxy({}, {
    get(_target, key) {
      const rows = () => storedOps.filter(op => op.table === table).map(op => op.row);
      if (key === 'then') return (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
      if (key === 'maybeSingle' || key === 'single') return async () => ({ data: rows()[0] || null, error: null });
      return () => query;
    },
    });
    return query;
  };
  const saveEstimateOffline = async payload => {
    // Clone at the persistence boundary so later edits cannot alter evidence.
    saves.push(JSON.parse(JSON.stringify(payload)));
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    try {
      if (options.onSave) await options.onSave(payload, saves.length);
      if (options.persistRows) return await load(path.join(root, 'apps/estimator/src/offline/estimates.ts'), true).saveEstimateOffline(payload);
      return { id: payload.estimateId, areaIds: ['fixture-area'] };
    } finally { activeWrites -= 1; }
  };
  const mocks = {
    'lib/useOnline': { useOnline: () => options.online !== false },
    'offline/estimates': { CUSTOM_LINE_LABEL: 'Custom estimate', saveEstimateOffline },
    'lib/estimateLoad': { deleteEstimateChildren: async id => { deletes.push(id); } },
    'offline/idb': { idbPut: async () => {} },
    'offline/outbox': {
      listOps: async () => options.persistRows ? storedOps : options.listOps ? options.listOps() : [],
      enqueue: async op => { storedOps.push({ ...JSON.parse(JSON.stringify(op)), opId: `fixture-op-${++uuidId}` }); },
      removeOp: async id => { storedOps = storedOps.filter(op => op.opId !== id); },
    },
    'offline/sync': { drainOutbox: async () => { if (options.drainOutbox) await options.drainOutbox(); } },
    'lib/comps': { loadCompCandidates: async () => [], buildComps: () => null,
      compsGpCaveat: () => '', compsRuleLabel: () => '' },
    'lib/ai': { compsForAi: () => null, fetchAiRecommendation: async () => null },
    'lib/supabase': { supabase: { from: queryFor, auth: { getSession: async () => ({ data: { session: null } }) } } },
    'lib/customerSearch': { searchCustomersAndLeads: async () => [], ensureLeadForCustomer: async () => 'fixture-lead' },
    'offline/uuid': { uuid: () => `fixture-uuid-${++uuidId}` },
    'features/estimator/AddressAutocomplete': { __esModule: true, default: 'address-autocomplete' },
    'features/estimator/BottomSheet': { __esModule: true, default: ({ children, footer }) => React.createElement('bottom-sheet', null, children, footer) },
    'features/estimator/ScopeEditor': { __esModule: true, default: 'scope-editor' },
  };
  const context = vm.createContext({
    console, window, document, navigator: { onLine: options.online !== false }, URL, setTimeout, clearTimeout,
    fetch: async url => {
      assert.equal(url, '/estimator/index.html', 'No fixture request may reach production');
      return { ok: false };
    },
  });
  const modules = new Map();
  function load(filename, actual = false) {
    const stem = path.relative(path.join(root, 'apps/estimator/src'), filename).replace(/\.(tsx?|js)$/, '');
    if (mocks[stem] && !actual) return mocks[stem];
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
  const Screen = load(screenPath).default;
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(Screen, {
      catalog: catalog(), createdBy: 'fixture-user', viewerIsAdmin: false,
      catalogFromCache: false, leadLink: null, embed: false,
      editing: existingEstimate(), ...options.props,
    }));
  });
  const h = {
    saves, deletes, confirms, messages,
    storedOps: () => storedOps,
    removeStoredRow: id => { storedOps = storedOps.filter(op => op.id !== id); },
    loadStoredEstimate: id => load(path.join(root, 'apps/estimator/src/lib/estimateLoad.ts'), true).loadEstimateForEdit(id),
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

function pricedCatalog() {
  const result = catalog();
  result.config.standardCommissionPct = 6;
  result.config.sundriesPct = 5;
  result.systemTypes = [
    { id: 'fixture-standard-system', name: 'Standard Flake', labor_budget_pct: 25,
      target_gp_pct: 50, active: true, scope_template: 'Prepare and coat the standard floor.' },
    { id: 'fixture-custom-system', name: 'Custom System', labor_budget_pct: 25,
      target_gp_pct: 50, active: true, scope_template: 'Perform the custom work described here.' },
  ];
  result.productsById = {
    'fixture-basecoat': { id: 'fixture-basecoat', name: 'Fixture basecoat', material_type: 'basecoat',
      spread_rate: 100, kit_size: 1, unit_cost: 100, active: true },
  };
  result.recipeSlotsBySystemType = {
    'fixture-standard-system': [{ id: 'fixture-base-slot', system_type_id: 'fixture-standard-system',
      order_index: 0, material_type: 'basecoat', slot_kind: 'product', label: 'Basecoat',
      default_product_id: 'fixture-basecoat', required: true }],
    'fixture-custom-system': [{ id: 'fixture-description-slot', system_type_id: 'fixture-custom-system',
      order_index: 0, material_type: 'other', slot_kind: 'text', label: 'Custom work notes', required: false }],
  };
  return result;
}

function catalogEstimate(systemId = 'fixture-custom-system', sqft = '100') {
  const estimate = existingEstimate();
  estimate.systemTypeId = systemId;
  estimate.areas = [{
    ...estimate.areas[0], name: systemId === 'fixture-custom-system' ? 'Legacy custom work' : 'Standard garage',
    systemTypeId: systemId, sqft, isCustom: false, customLabel: '', customScope: '',
    customMaterialCost: '', customLaborHours: '', priceOverride: '1500',
    lineDescription: 'Prepare and coat the fixture area.',
    slotValues: systemId === 'fixture-custom-system'
      ? { 'fixture-description-slot': 'Preserve these custom notes.' }
      : { 'fixture-base-slot': 'fixture-basecoat' },
  }];
  return estimate;
}

async function openLine(h, name) {
  const line = h.root.findByProps({ 'aria-label': `Edit line ${name}` });
  await act(async () => { line.props.onClick(); });
}

function squareFootageField(h) {
  const labels = h.root.findAll(node => node.type === 'label' && /^(Square footage|Sq ft)/.test(textOf(node)));
  assert.equal(labels.length, 1, 'The line has one square-footage control');
  return labels[0].findByType('input');
}

async function setSquareFootage(h, value) {
  const input = squareFootageField(h);
  await act(async () => { input.props.onChange({ target: { value } }); });
}

function saveButton(h) {
  return h.root.find(node => node.type === 'button' && node.props.className === 'save');
}

async function saveNow(h) {
  const button = saveButton(h);
  assert.notEqual(button.props.disabled, true, `Estimate is ready to save: ${h.text()}`);
  await act(async () => { button.props.onClick(); });
}

const fullSaves = h => h.saves.filter(save => save.totals.price != null);
const lineButtons = h => h.root.findAll(node => node.type === 'button' && node.props.className === 'line-row');

test('clearing legacy Custom System square footage preserves its sold price and cost-based GP', async t => {
  const h = await harness({ props: { catalog: pricedCatalog(), editing: catalogEstimate() } });
  t.after(() => h.dispose());
  await saveNow(h);
  const before = fullSaves(h).at(-1);
  assert.equal(before.totals.price, 1500);
  assert.equal(before.totals.laborBudget, 375, 'The fixture uses the catalog 25 percent labor budget');
  assert.equal(before.totals.commissionDollars, 90);
  assert.equal(before.totals.gpDollars, 1011.75, 'The fixture includes labor, commission and sundries costs');
  await openLine(h, 'Legacy custom work');
  await setSquareFootage(h, '');
  await h.advance(2500);
  assert.equal(fullSaves(h).length, 2, 'Clearing optional footage triggers a full autosave');
  const after = fullSaves(h).at(-1);
  assert.equal(after.areas[0].sqft, null, 'An omitted measurement is saved as null');
  assert.deepEqual(after.totals, before.totals, 'Removing optional footage must not recalculate money assumptions');
  assert.equal(after.lineItems[0].total, before.lineItems[0].total);
  assert.equal(after.lineItems[0].unitCost, before.lineItems[0].unitCost);
  assert.deepEqual(after.areas[0].answers, before.areas[0].answers, 'Existing custom notes survive');
  assert.equal(after.lineItems[0].description, before.lineItems[0].description);
});

test('legacy Custom System can save without ever entering square footage', async t => {
  const h = await harness({ props: { catalog: pricedCatalog(), editing: catalogEstimate('fixture-custom-system', '') } });
  t.after(() => h.dispose());
  await saveNow(h);
  const saved = fullSaves(h).at(-1);
  assert.equal(saved.areas[0].sqft, null);
  assert.equal(saved.totals.price, 1500);
  assert.equal(saved.totals.laborBudget, 375);
  assert.equal(saved.totals.gpDollars, 1011.75);
});

test('blank custom-system footage stays blank after reopening and resaving', async t => {
  const first = await harness({ persistRows: true, props: { catalog: pricedCatalog(), editing: catalogEstimate('fixture-custom-system', '') } });
  t.after(() => first.dispose());
  await saveNow(first);
  const firstSave = fullSaves(first).at(-1);
  const loaded = await first.loadStoredEstimate(firstSave.estimateId);
  assert.equal(first.storedOps().find(op => op.table === 'estimate_areas').row.sqft, null, 'The actual outbox row stores null');
  assert.equal(loaded.areas[0].sqft, '', 'The actual estimate loader restores an empty field');
  const reopened = await harness({ props: { catalog: pricedCatalog(), editing: loaded } });
  t.after(() => reopened.dispose());
  await openLine(reopened, 'Legacy custom work');
  assert.equal(squareFootageField(reopened).props.value, '');
  await saveNow(reopened);
  const nextSave = fullSaves(reopened).at(-1);
  assert.equal(nextSave.areas[0].sqft, null);
  assert.deepEqual(nextSave.totals, firstSave.totals);
});

test('a native custom line saves blank square footage without changing its typed cost basis', async t => {
  const h = await harness({ props: { catalog: pricedCatalog() } }); t.after(() => h.dispose());
  await saveNow(h);
  const before = fullSaves(h).at(-1);
  await openLine(h, 'Fixture coating');
  await setSquareFootage(h, '');
  await h.advance(2500);
  const after = fullSaves(h).at(-1);
  assert.equal(after.areas[0].sqft, null);
  assert.equal(after.areas[0].customMaterialCost, 100);
  assert.equal(after.areas[0].customLaborHours, 1);
  assert.deepEqual(after.totals, before.totals);
});

test('a standard material-priced line still requires square footage', async t => {
  const h = await harness({ props: { catalog: pricedCatalog(), editing: catalogEstimate('fixture-standard-system') } });
  t.after(() => h.dispose());
  await saveNow(h);
  await openLine(h, 'Standard garage');
  await setSquareFootage(h, '');
  assert.equal(saveButton(h).props.disabled, true);
  assert.match(h.text(), /Enter the square footage/);
  await h.advance(3500);
  assert.equal(fullSaves(h).length, 1, 'Removing required footage cannot produce a priced standard save');
});

function freshProps() {
  return {
    catalog: pricedCatalog(), editing: null,
    leadLink: { id: 'fixture-lead', name: 'Fixture Customer', phone: customer.phone,
      email: customer.email, address1: customer.address1, city: customer.city,
      state: customer.state, zip: customer.zip, source: 'Google' },
  };
}

test('adding the first custom line replaces only an untouched new Main starter', async t => {
  const h = await harness({ props: freshProps() }); t.after(() => h.dispose());
  assert.equal(lineButtons(h).length, 1);
  await h.clickLabel('+ Add custom line');
  assert.equal(lineButtons(h).length, 1, 'The empty auto-seeded Main line does not block a custom-only estimate');
  await h.change('Price $ (you set it', '1200');
  await h.advance(3500);
  const saved = fullSaves(h).at(-1);
  assert.ok(saved, 'The custom-only estimate autosaves');
  assert.equal(saved.areas.length, 1);
  assert.equal(saved.areas[0].isCustom, true);
  assert.equal(saved.areas[0].sqft, null);
  assert.equal(saved.totals.price, 1200);
});

test('adding a custom line preserves an edited standard starter even when its footage is blank', async t => {
  const h = await harness({ props: freshProps() }); t.after(() => h.dispose());
  await openLine(h, 'Main');
  await h.change('Area name', 'Keep this patio');
  await h.clickLabel('Done');
  await h.clickLabel('+ Add custom line');
  assert.equal(lineButtons(h).length, 2);
  assert.ok(h.root.findByProps({ 'aria-label': 'Edit line Keep this patio' }));
  await h.change('Price $ (you set it', '1200');
  assert.equal(saveButton(h).props.disabled, true, 'The intentionally kept standard line still needs its real measurement');
  await h.advance(3500);
  assert.equal(fullSaves(h).length, 0);
});

test('adding a custom line never removes a persisted blank standard line', async t => {
  const editing = catalogEstimate('fixture-standard-system', '');
  editing.areas[0].name = 'Main';
  editing.areas[0].priceOverride = '';
  const h = await harness({ props: { catalog: pricedCatalog(), editing } }); t.after(() => h.dispose());
  await h.clickLabel('+ Add custom line');
  assert.equal(lineButtons(h).length, 2);
  assert.ok(h.root.findByProps({ 'aria-label': 'Edit line Main' }));
});

test('adding a custom line preserves multiple deliberately added standard lines', async t => {
  const h = await harness({ props: freshProps() }); t.after(() => h.dispose());
  await h.clickLabel('+ Add item');
  await h.clickLabel('Done');
  await h.clickLabel('+ Add custom line');
  assert.equal(lineButtons(h).length, 3);
  assert.ok(h.root.findByProps({ 'aria-label': 'Edit line Main' }));
  assert.ok(h.root.findByProps({ 'aria-label': 'Edit line Area 2' }));
});

test('the first custom line can replace the unpersisted starter in a CRM-created empty draft', async t => {
  const editing = catalogEstimate('fixture-standard-system', '');
  editing.areas = [];
  const h = await harness({ props: { catalog: pricedCatalog(), editing } }); t.after(() => h.dispose());
  await h.clickLabel('+ Add custom line');
  assert.equal(lineButtons(h).length, 1, 'A saved parent row does not turn its unsaved starter into real work');
  await h.change('Price $ (you set it', '1200');
  await h.advance(3500);
  assert.equal(fullSaves(h).at(-1).areas[0].sqft, null);
  assert.equal(fullSaves(h).at(-1).totals.price, 1200);
});

for (const variant of ['product recipe', 'hidden product recipe', 'different system name', 'MVB']) {
  test(`blank footage stays required for a custom-looking line with ${variant}`, async t => {
    const c = pricedCatalog();
    const editing = catalogEstimate('fixture-custom-system', '');
    if (variant.includes('product recipe')) {
      c.recipeSlotsBySystemType['fixture-custom-system'].push({
        ...c.recipeSlotsBySystemType['fixture-standard-system'][0],
        id: 'custom-product-slot', system_type_id: 'fixture-custom-system',
        editor_hidden: variant.startsWith('hidden'),
      });
    } else if (variant === 'different system name') {
      c.systemTypes.find(system => system.id === 'fixture-custom-system').name = 'Custom Patio Finish';
    } else {
      editing.areas[0].mvb = true;
      c.productsById['fixture-mvb'] = { id: 'fixture-mvb', name: 'Simiron MVB - Standalone',
        material_type: 'MVB', spread_rate: 100, kit_size: 1, unit_cost: 50 };
    }
    const h = await harness({ props: { catalog: c, editing } }); t.after(() => h.dispose());
    assert.equal(saveButton(h).props.disabled, true);
    assert.match(h.text(), /square footage/);
    await h.advance(3500);
    assert.equal(fullSaves(h).length, 0);
  });
}

test('a blank-footage Custom System still needs an explicit price choice', async t => {
  const editing = catalogEstimate('fixture-custom-system', '');
  editing.areas[0].priceOverride = '';
  const h = await harness({ props: { catalog: pricedCatalog(), editing } }); t.after(() => h.dispose());
  assert.equal(saveButton(h).props.disabled, true);
  await openLine(h, 'Legacy custom work');
  const prices = h.root.findAll(node => node.type === 'label' && /^(Line price \$|Price \$)/.test(textOf(node)));
  assert.equal(prices.length, 1, 'A typed price control is available before footage exists');
  await act(async () => { prices[0].findByType('input').props.onChange({ target: { value: '900' } }); });
  await h.advance(2500);
  assert.equal(fullSaves(h).at(-1).totals.price, 900);
  assert.equal(fullSaves(h).at(-1).areas[0].sqft, null);
});

test('a job-level sold price survives clearing custom footage and a complete storage reload', async t => {
  const h = await harness({ persistRows: true, props: { catalog: pricedCatalog(), editing: catalogEstimate() } });
  t.after(() => h.dispose());
  await h.change('Sell price $ (system)', '1200');
  await h.advance(2500);
  const before = fullSaves(h).at(-1);
  assert.equal(before.totals.price, 1200);
  assert.equal(before.areas[0].priceOverride, 1500, 'Fixture has a distinct global sell override to preserve');
  await openLine(h, 'Legacy custom work');
  await setSquareFootage(h, '');
  await h.advance(2500);
  const after = fullSaves(h).at(-1);
  assert.deepEqual(after.totals, before.totals);
  const loaded = await h.loadStoredEstimate(after.estimateId);
  assert.equal(loaded.savedAreaSellTotal, 1200);
  assert.equal(loaded.areas[0].sqft, '');
  const reopened = await harness({ props: { catalog: pricedCatalog(), editing: loaded } });
  t.after(() => reopened.dispose());
  await reopened.advance(3500);
  assert.equal(reopened.saves.length, 0, 'Restoring the saved sell override is hydration, not an edit');
  await saveNow(reopened);
  const resaved = fullSaves(reopened).at(-1);
  assert.equal(resaved.areas[0].sqft, null);
  assert.deepEqual(resaved.totals, before.totals, 'Cold reopening must retain the sold total and matching GP/cost basis');
});

test('sold-price hydration includes all area lines and quantities while excluding add-ons', async t => {
  const editing = catalogEstimate();
  editing.areas.push({ ...editing.areas[0], name: 'Optional custom work',
    slotValues: { ...editing.areas[0].slotValues }, isOptional: true, preselected: false });
  editing.addonLines = [{ addonId: 'fixture-addon', label: 'Separate add-on', description: 'Add-on work',
    qty: 2, unitPrice: 100, unitCost: 10, estHours: null, sqft: null,
    isOptional: false, selectedByCustomer: true }];
  const h = await harness({ persistRows: true, props: { catalog: pricedCatalog(), editing } });
  t.after(() => h.dispose());
  await h.change('Sell price $ (system)', '2400');
  await h.advance(2500);
  const saved = fullSaves(h).at(-1);
  assert.equal(saved.totals.price, 1400, 'Required area1200 plus add-on200');
  assert.equal(saved.priceAllOptions, 2600);
  const linked = h.storedOps().filter(op => op.table === 'estimate_line_items' && op.row.estimate_area_id);
  assert.equal(linked.length, 2);
  // Stored legacy lines can express their sold amount as quantity times a
  // rate, rather than quantity1. Hydration must use the complete amount.
  linked[0].row.qty = 2;
  linked[0].row.unit_price = 600;
  const loaded = await h.loadStoredEstimate(saved.estimateId);
  assert.equal(loaded.savedAreaSellTotal, 2400, 'Includes the unselected optional area and excludes the200 add-on');
  const reopened = await harness({ props: { catalog: pricedCatalog(), editing: loaded } });
  t.after(() => reopened.dispose());
  await saveNow(reopened);
  assert.equal(fullSaves(reopened).at(-1).totals.price, 1400);
  assert.equal(fullSaves(reopened).at(-1).priceAllOptions, 2600);
  h.removeStoredRow(linked[1].id);
  const incomplete = await h.loadStoredEstimate(saved.estimateId);
  assert.equal(incomplete.savedAreaSellTotal ?? null, null, 'An incomplete area-line set never invents a sold total');
});

test('a global-only Custom System price survives blank footage and cold reopening', async t => {
  const editing = catalogEstimate();
  editing.areas[0].priceOverride = '';
  const h = await harness({ persistRows: true, props: { catalog: pricedCatalog(), editing } });
  t.after(() => h.dispose());
  await h.change('Sell price $ (system)', '1800');
  await h.advance(2500);
  const before = fullSaves(h).at(-1);
  assert.equal(before.totals.price, 1800);
  assert.equal(before.areas[0].priceOverride, null);
  await openLine(h, 'Legacy custom work');
  await setSquareFootage(h, '');
  await h.advance(2500);
  const after = fullSaves(h).at(-1);
  assert.equal(after.areas[0].sqft, null);
  assert.deepEqual(after.totals, before.totals);
  const loaded = await h.loadStoredEstimate(after.estimateId);
  const reopened = await harness({ props: { catalog: pricedCatalog(), editing: loaded } });
  t.after(() => reopened.dispose());
  await reopened.advance(3500);
  assert.equal(reopened.saves.length, 0, 'Opening the override cannot trigger an automatic rewrite');
  await saveNow(reopened);
  assert.deepEqual(fullSaves(reopened).at(-1).totals, before.totals);
});

test('adding a custom line retains a standard starter saved earlier in the current session', async t => {
  const h = await harness({ props: freshProps() }); t.after(() => h.dispose());
  await openLine(h, 'Main');
  await setSquareFootage(h, '100');
  await h.advance(3500);
  assert.equal(fullSaves(h).length, 1);
  await setSquareFootage(h, '');
  await h.clickLabel('Done');
  await h.clickLabel('+ Add custom line');
  assert.equal(lineButtons(h).length, 2, 'Clearing a saved line does not make it an untouched starter again');
  assert.ok(h.root.findByProps({ 'aria-label': 'Edit line Main' }));
});

test('blank custom footage is ready for send preparation while scope safeguards still apply', async t => {
  const { estimatePricingSendBlockers } = require('./estimate-send-readiness.cjs');
  const { scopeSendBlockers } = require('./optional-lines.cjs');
  const h = await harness({ persistRows: true, props: {
    catalog: pricedCatalog(), editing: catalogEstimate('fixture-custom-system', ''),
  } });
  t.after(() => h.dispose());
  await saveNow(h);
  const rows = h.storedOps();
  const estimate = rows.find(op => op.table === 'estimates').row;
  const items = rows.filter(op => op.table === 'estimate_line_items').map(op => op.row);
  const areas = rows.filter(op => op.table === 'estimate_areas').map(op => op.row);
  const stored = { ...estimate, estimate_line_items: items };
  assert.equal(areas[0].sqft, null);
  assert.deepEqual(estimatePricingSendBlockers(stored, {
    estimator_floor_gp_pct: 40, line_pricing_gp_floor_pct: 40, line_pricing_block_below_floor: true,
  }), [], 'Valid sold price and GP remain eligible for sending without a measurement');
  const scopeArgs = { scopeStale: false, items, customAreaIds: new Set(), scopeOfWork: estimate.scope_of_work };
  assert.deepEqual(scopeSendBlockers(scopeArgs), []);
  assert.ok(scopeSendBlockers({ ...scopeArgs, items: [{ ...items[0], description: '' }] }).length > 0,
    'Legacy Custom System still requires a real line scope');
  assert.ok(scopeSendBlockers({ ...scopeArgs, items: [{ ...items[0], description: 'Coat {{system}}.' }] }).length > 0,
    'Removing the footage requirement cannot bypass unfilled description fields');
  const loaded = await h.loadStoredEstimate(estimate.id);
  const reopened = await harness({ props: { catalog: pricedCatalog(), editing: loaded, embed: true } });
  t.after(() => reopened.dispose());
  await reopened.flush();
  assert.equal(reopened.flushReplies().length, 1);
  assert.equal(reopened.flushReplies()[0].ok, true, 'The parent can complete send preparation for the saved blank-footage line');
});

test('a 100 percent discount saves and reopens at zero without accidental autosave or sending', async t => {
  const { emptySendError } = require('./optional-lines.cjs');
  const editing = existingEstimate();
  editing.areas[0].priceOverride = '1500';
  const h = await harness({ persistRows: true, props: { catalog: pricedCatalog(), editing } });
  t.after(() => h.dispose());
  await h.change('Discount %', '100');
  await h.advance(2500);
  const saved = fullSaves(h).at(-1);
  assert.ok(saved, 'Zero is a saved draft price, not a missing value');
  assert.equal(saved.totals.price, 0);
  assert.equal(saved.areas[0].priceOverride, 1500);
  const items = h.storedOps().filter(op => op.table === 'estimate_line_items').map(op => op.row);
  assert.ok(emptySendError(items), 'The zero opening-total send gate still blocks this draft');
  const loaded = await h.loadStoredEstimate(saved.estimateId);
  assert.equal(loaded.savedAreaSellTotal, 0, 'The loader preserves a complete zero sold total');
  const reopened = await harness({ props: { catalog: pricedCatalog(), editing: loaded } });
  t.after(() => reopened.dispose());
  await reopened.advance(3500);
  assert.equal(reopened.saves.length, 0, 'Hydrating zero is not an edit');
  await reopened.editCustomer();
  await reopened.change('First name', 'Updated');
  await reopened.advance(2500);
  assert.equal(fullSaves(reopened).at(-1).totals.price, 0, 'An unrelated customer edit keeps the zero discount');
  await openLine(reopened, 'Fixture coating');
  await reopened.change('Price $ (you set it', '1600');
  await reopened.advance(2500);
  assert.equal(fullSaves(reopened).at(-1).totals.price, 1600, 'An actual line-price change still resets the previous global discount');
});

test('a manually priced blank-footage Custom System can retain a zero discounted draft through reload', async t => {
  const { emptySendError } = require('./optional-lines.cjs');
  const h = await harness({ persistRows: true, props: {
    catalog: pricedCatalog(), editing: catalogEstimate('fixture-custom-system', ''),
  } });
  t.after(() => h.dispose());
  await h.change('Discount %', '100');
  await h.advance(2500);
  const saved = fullSaves(h).at(-1);
  assert.ok(saved, 'A positive typed baseline permits saving its zero discounted draft');
  assert.equal(saved.totals.price, 0);
  assert.equal(saved.areas[0].priceOverride, 1500);
  assert.equal(saved.areas[0].sqft, null);
  assert.ok(emptySendError(h.storedOps().filter(op => op.table === 'estimate_line_items').map(op => op.row)));
  const loaded = await h.loadStoredEstimate(saved.estimateId);
  assert.equal(loaded.savedAreaSellTotal, 0);
  const reopened = await harness({ props: { catalog: pricedCatalog(), editing: loaded } });
  t.after(() => reopened.dispose());
  await reopened.advance(3500);
  assert.equal(reopened.saves.length, 0);
  await saveNow(reopened);
  assert.equal(fullSaves(reopened).at(-1).totals.price, 0);
  assert.equal(fullSaves(reopened).at(-1).areas[0].sqft, null);
});

test('zero area sell hydration excludes a paid add-on and retains optional area pricing', async t => {
  const { estimatePricingSendBlockers } = require('./estimate-send-readiness.cjs');
  const editing = existingEstimate();
  editing.areas[0].priceOverride = '1500';
  editing.areas.push({ ...editing.areas[0], name: 'Optional custom line', isOptional: true, preselected: false });
  editing.addonLines = [{ addonId: 'fixture-addon', label: 'Separate paid add-on', description: 'Add-on work',
    qty: 2, unitPrice: 100, unitCost: 10, estHours: null, sqft: null,
    isOptional: false, selectedByCustomer: true }];
  const h = await harness({ persistRows: true, props: { catalog: pricedCatalog(), editing } });
  t.after(() => h.dispose());
  await h.change('Discount %', '100');
  await h.advance(2500);
  const saved = fullSaves(h).at(-1);
  assert.equal(saved.totals.price, 200);
  assert.equal(saved.priceAllOptions, 200);
  assert.deepEqual(saved.lineItems.filter(line => line.areaIndex != null).map(line => line.total), [0, 0]);
  const storedEstimate = h.storedOps().find(op => op.table === 'estimates').row;
  const pricingBlockers = estimatePricingSendBlockers({ ...storedEstimate,
    price_override_reason: 'Fixture reason supplied',
    estimate_line_items: h.storedOps().filter(op => op.table === 'estimate_line_items').map(op => op.row),
  });
  assert.ok(pricingBlockers.some(blocker => /above \$0/.test(blocker.msg)),
    'A paid add-on and written override reason cannot bypass the zero area-price send gate');
  const loaded = await h.loadStoredEstimate(saved.estimateId);
  assert.equal(loaded.savedAreaSellTotal, 0, 'The separate paid add-on cannot replace a legitimate zero area total');
  const reopened = await harness({ props: { catalog: pricedCatalog(), editing: loaded } });
  t.after(() => reopened.dispose());
  await reopened.advance(3500);
  assert.equal(reopened.saves.length, 0);
  await saveNow(reopened);
  const resaved = fullSaves(reopened).at(-1);
  assert.equal(resaved.totals.price, 200);
  assert.equal(resaved.priceAllOptions, 200);
  assert.deepEqual(resaved.lineItems.filter(line => line.areaIndex != null).map(line => line.total), [0, 0]);
});

test('an explicit global zero on an otherwise unpriced Custom System survives storage and reopening', async t => {
  const { estimatePricingSendBlockers } = require('./estimate-send-readiness.cjs');
  const editing = catalogEstimate('fixture-custom-system', '');
  editing.areas[0].priceOverride = '';
  const h = await harness({ persistRows: true, props: { catalog: pricedCatalog(), editing } });
  t.after(() => h.dispose());
  assert.equal(saveButton(h).props.disabled, true, 'Untouched missing price is still incomplete');
  await h.change('Sell price $ (system)', '0');
  await h.advance(2500);
  const saved = fullSaves(h).at(-1);
  assert.ok(saved, 'Explicitly entering zero is different from leaving the price untouched');
  assert.equal(saved.totals.price, 0);
  assert.equal(saved.calcPrice, 0, 'The saved zero equals the zero engine baseline in this case');
  assert.equal(saved.areas[0].priceOverride, null);
  assert.equal(saved.areas[0].sqft, null);
  const stored = h.storedOps().find(op => op.table === 'estimates').row;
  assert.ok(estimatePricingSendBlockers({ ...stored,
    estimate_line_items: h.storedOps().filter(op => op.table === 'estimate_line_items').map(op => op.row),
  }).some(blocker => /above \$0/.test(blocker.msg)));
  const loaded = await h.loadStoredEstimate(saved.estimateId);
  assert.equal(loaded.savedAreaSellTotal, 0);
  const reopened = await harness({ props: { catalog: pricedCatalog(), editing: loaded } });
  t.after(() => reopened.dispose());
  await reopened.advance(3500);
  assert.equal(reopened.saves.length, 0, 'Zero restoration does not automatically rewrite the estimate');
  await saveNow(reopened);
  const resaved = fullSaves(reopened).at(-1);
  assert.equal(resaved.totals.price, 0);
  assert.equal(resaved.areas[0].priceOverride, null);
  assert.equal(resaved.areas[0].sqft, null);
  await reopened.change('Sell price $ (system)', '');
  assert.equal(saveButton(reopened).props.disabled, true, 'Clearing the explicit zero returns to an unpriced draft');
  await reopened.advance(3500);
  assert.equal(fullSaves(reopened).length, 1, 'An empty price input is never silently resaved as another zero');
});
