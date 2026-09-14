const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Actual React components and hooks, with only network/permission adapters
// replaced. No customer records or production requests are involved.
const root = path.join(__dirname, '..');
const srcRoot = path.join(root, 'apps/estimator/src');
const estimatorRequire = createRequire(path.join(root, 'apps/estimator/package.json'));
const React = estimatorRequire('react');
const { create, act } = estimatorRequire('react-test-renderer');
const ts = estimatorRequire('typescript');
const compiled = new Map();

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node?.children || []).map(textOf).join('');
}

function componentLoader(mocks, globals = {}) {
  const modules = new Map();
  const context = vm.createContext({ console, ...globals });
  function load(filename) {
    const stem = path.relative(srcRoot, filename).replace(/\.(tsx?|js)$/, '');
    if (mocks[stem]) return mocks[stem];
    if (filename.endsWith('.cjs')) return require(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    if (!compiled.has(filename)) {
      const source = fs.readFileSync(filename, 'utf8').replace(/import\.meta\.url/g, '"https://fixture.invalid/screen.js"');
      compiled.set(filename, ts.transpileModule(source, {
        fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
      }).outputText);
    }
    const localRequire = spec => {
      if (!spec.startsWith('.')) return estimatorRequire(spec);
      const resolved = path.resolve(path.dirname(filename), spec);
      const found = [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`]
        .find(file => fs.existsSync(file));
      assert.ok(found, `Resolve component import ${spec}`);
      return load(found);
    };
    vm.runInContext(`(function(require,module,exports) {\n${compiled.get(filename)}\n})`, context,
      { filename })(localRequire, module, module.exports);
    return module.exports;
  }
  return relative => load(path.join(srcRoot, relative));
}

function controls(renderer) {
  return {
    get root() { return renderer.root; },
    text: () => textOf(renderer.toJSON()),
    button(label) {
      const matches = renderer.root.findAll(node => node.type === 'button' && textOf(node) === label);
      assert.equal(matches.length, 1, `Find one ${label} button`);
      return matches[0];
    },
    async click(label) {
      const button = this.button(label);
      assert.notEqual(button.props.disabled, true, `${label} must be available`);
      await act(async () => { button.props.onClick(); });
    },
    async change(label, value) {
      const byAria = renderer.root.findAll(node => ['input', 'select', 'textarea'].includes(node.type)
        && node.props['aria-label'] === label);
      const labels = renderer.root.findAll(node => node.type === 'label' && textOf(node).startsWith(label));
      const field = byAria.length === 1 ? byAria[0]
        : labels.length === 1 ? labels[0].find(node => ['input', 'select', 'textarea'].includes(node.type)) : null;
      assert.ok(field, `Find ${label} input`);
      await act(async () => { field.props.onChange({ target: { value } }); });
    },
    async dispose() { await act(async () => { renderer.unmount(); }); },
  };
}

const savedTemplate = {
  id: 'template-coating', name: 'Garage coating',
  description: '**Prepare the floor.**\n\n- Apply {{system}}.\n- Protect adjacent surfaces.',
  active: true, created_by: 'fixture-user', created_at: '2026-09-14T12:00:00Z',
};

async function templateHarness(options = {}) {
  const saves = [], applications = [], confirmations = [], savedCallbacks = [];
  let uuid = 0;
  const api = {
    async canSaveLineTemplates() { return options.permission ? options.permission() : true; },
    async loadLineTemplates() { return options.load ? options.load() : [savedTemplate]; },
    async getCachedLineTemplates() { return options.cached ? options.cached() : [savedTemplate]; },
    async saveLineTemplate(payload) {
      saves.push(JSON.parse(JSON.stringify(payload)));
      if (options.save) return options.save(payload, saves.length);
      return { ...savedTemplate, id: payload.id, name: payload.name,
        description: payload.description, created_by: payload.createdBy };
    },
  };
  const load = componentLoader({
    'lib/lineTemplates': api,
    'offline/uuid': { uuid: () => `fixture-template-${++uuid}` },
  }, {
    window: { confirm(message) { confirmations.push(message); return options.confirm === true; } },
  });
  const Component = load('features/estimator/DescriptionTemplates.tsx').default;
  let props = {
    value: 'Existing custom description.', onApply: value => applications.push(value),
    defaultName: 'Fixture coating', createdBy: 'fixture-user',
    initialTemplates: [savedTemplate], online: true, onSaved: template => savedCallbacks.push(template), ...options.props,
  };
  let renderer;
  await act(async () => { renderer = create(React.createElement(Component, props)); });
  return {
    ...controls(renderer), saves, applications, confirmations, savedCallbacks,
    get root() { return renderer.root; },
    async update(patch) {
      props = { ...props, ...patch };
      await act(async () => { renderer.update(React.createElement(Component, props)); });
    },
    async switchEditor(key, patch) {
      props = { ...props, ...patch };
      await act(async () => { renderer.update(React.createElement(Component, { ...props, key })); });
    },
  };
}

test('saving a description template captures formatted text and no line pricing or quantities', async t => {
  const description = '**Fixture preparation**\n\n- Coat {{system}}.\n- Exclude stem walls.';
  const h = await templateHarness({ props: { value: description } }); t.after(() => h.dispose());
  await h.click('Save as template');
  assert.equal(h.root.findByProps({ 'aria-label': 'Template name' }).props.value, 'Fixture coating');
  await h.change('Template name', 'Reusable garage scope');
  await h.click('Save template');
  assert.equal(h.saves.length, 1);
  assert.deepEqual(Object.keys(h.saves[0]).sort(), ['createdBy', 'description', 'id', 'name']);
  assert.equal(h.saves[0].description, description);
  assert.equal(h.saves[0].name, 'Reusable garage scope');
  assert.equal(h.savedCallbacks.length, 1);
  assert.deepEqual(h.applications, [], 'Saving a template never rewrites the current estimate');
  assert.match(h.text(), /Saved.*Reusable garage scope/);
});

test('canceling the name form creates no template', async t => {
  const h = await templateHarness(); t.after(() => h.dispose());
  await h.click('Save as template');
  await h.change('Template name', 'Do not save this');
  await h.click('Cancel');
  assert.deepEqual(h.saves, []);
  assert.equal(h.root.findAllByProps({ 'aria-label': 'Template name' }).length, 0);
});

test('empty and formatting-only descriptions cannot be saved as templates', async t => {
  for (const value of ['', '   ', '** **', '- ']) {
    const h = await templateHarness({ props: { value } });
    t.after(() => h.dispose());
    assert.equal(h.button('Save as template').props.disabled, true, `No visible description in ${JSON.stringify(value)}`);
    assert.deepEqual(h.saves, []);
  }
});

test('template save is unavailable without catalog permission or a signed-in user', async t => {
  for (const options of [{ permission: () => false }, { props: { createdBy: null } }]) {
    const h = await templateHarness(options); t.after(() => h.dispose());
    assert.equal(h.button('Save as template').props.disabled, true);
    assert.notEqual(h.button('Use template').props.disabled, true, 'Readers may reuse existing templates');
  }
});

test('a permission lookup failure keeps template creation unavailable', async t => {
  const h = await templateHarness({ permission: () => { throw new Error('fixture permission failure'); } });
  t.after(() => h.dispose());
  assert.equal(h.button('Save as template').props.disabled, true);
  assert.deepEqual(h.saves, []);
});

test('a delayed permission response cannot authorize a different signed-out context', async t => {
  const hold = deferred();
  const h = await templateHarness({ permission: () => hold.promise });
  t.after(async () => { hold.resolve(true); await h.dispose(); });
  assert.equal(h.button('Save as template').props.disabled, true);
  await h.update({ createdBy: null });
  await act(async () => { hold.resolve(true); });
  assert.equal(h.button('Save as template').props.disabled, true);
});

test('template saving snapshots the reviewed description while typing continues', async t => {
  const h = await templateHarness({ props: { value: 'Description being reviewed.' } }); t.after(() => h.dispose());
  await h.click('Save as template');
  await h.update({ value: 'A later estimate edit.' });
  await h.click('Save template');
  assert.equal(h.saves[0].description, 'Description being reviewed.');
  assert.deepEqual(h.applications, []);
});

test('a failed template save retains its name and stable id for retry', async t => {
  const h = await templateHarness({ save: (payload, attempt) => {
    if (attempt === 1) throw new Error('fixture save failure');
    return { ...savedTemplate, ...payload };
  } });
  t.after(() => h.dispose());
  await h.click('Save as template');
  await h.change('Template name', 'Retry fixture');
  await h.click('Save template');
  assert.equal(h.root.findByProps({ 'aria-label': 'Template name' }).props.value, 'Retry fixture');
  assert.equal(h.root.findAllByProps({ role: 'alert' }).length, 1);
  assert.equal(h.savedCallbacks.length, 0);
  await h.click('Save template');
  assert.equal(h.saves.length, 2);
  assert.equal(h.saves[1].id, h.saves[0].id, 'Retry cannot mint a duplicate template');
  assert.deepEqual(h.saves[1], h.saves[0]);
  assert.equal(h.savedCallbacks.length, 1);
});

test('rapid repeated save actions run only one template write', async t => {
  const hold = deferred();
  const h = await templateHarness({ save: () => hold.promise });
  t.after(async () => { hold.resolve(savedTemplate); await h.dispose(); });
  await h.click('Save as template');
  const handler = h.button('Save template').props.onClick;
  await act(async () => { handler(); handler(); });
  assert.equal(h.saves.length, 1);
  assert.equal(h.button('Saving…').props.disabled, true);
  await act(async () => { hold.resolve(savedTemplate); });
  assert.equal(h.savedCallbacks.length, 1);
});

test('choosing a template previews formatting and applies only its description', async t => {
  const h = await templateHarness({ props: { value: '' } }); t.after(() => h.dispose());
  await h.click('Use template');
  assert.equal(h.button('Use description').props.disabled, true);
  await h.change('Saved description templates', savedTemplate.id);
  const preview = h.root.findByProps({ 'aria-label': 'Selected template preview' });
  assert.match(preview.props.dangerouslySetInnerHTML.__html, /<strong>Prepare the floor\.<\/strong>/);
  assert.match(preview.props.dangerouslySetInnerHTML.__html, /\{\{system\}\}/);
  await h.click('Use description');
  assert.deepEqual(h.applications, [savedTemplate.description]);
  assert.equal(typeof h.applications[0], 'string');
  assert.deepEqual(h.saves, []);
  assert.deepEqual(h.confirmations, []);
});

test('replacing nonempty description text requires accepted confirmation', async t => {
  for (const accepted of [false, true]) {
    const h = await templateHarness({ confirm: accepted }); t.after(() => h.dispose());
    await h.click('Use template');
    await h.change('Saved description templates', savedTemplate.id);
    await h.click('Use description');
    assert.equal(h.confirmations.length, 1);
    assert.deepEqual(h.applications, accepted ? [savedTemplate.description] : []);
  }
});

test('applying identical description text does not ask to overwrite it', async t => {
  const h = await templateHarness({ props: { value: savedTemplate.description } }); t.after(() => h.dispose());
  await h.click('Use template');
  await h.change('Saved description templates', savedTemplate.id);
  await h.click('Use description');
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.applications, [savedTemplate.description]);
});

test('offline staff can apply a cached template but cannot save a new one', async t => {
  const h = await templateHarness({ props: { online: false, value: '' },
    load: () => { throw new Error('Offline chooser must not request the network'); } });
  t.after(() => h.dispose());
  assert.equal(h.button('Save as template').props.disabled, true);
  await h.click('Use template');
  assert.match(h.text(), /saved on this device/);
  await h.change('Saved description templates', savedTemplate.id);
  await h.click('Use description');
  assert.deepEqual(h.applications, [savedTemplate.description]);
});

test('a template lookup failure blocks stale application until a successful retry', async t => {
  let attempts = 0;
  const h = await templateHarness({ props: { value: '' }, load: () => {
    if (++attempts === 1) throw new Error('fixture lookup failure');
    return [savedTemplate];
  } });
  t.after(() => h.dispose());
  await h.click('Use template');
  assert.equal(h.button('Use description').props.disabled, true);
  assert.equal(h.root.findByProps({ 'aria-label': 'Saved description templates' }).props.disabled, true);
  await h.click('Try again');
  await h.change('Saved description templates', savedTemplate.id);
  await h.click('Use description');
  assert.deepEqual(h.applications, [savedTemplate.description]);
});

test('a canceled template lookup cannot reopen or overwrite a later save form', async t => {
  const hold = deferred();
  const h = await templateHarness({ load: () => hold.promise });
  t.after(async () => { hold.resolve([savedTemplate]); await h.dispose(); });
  await h.click('Use template');
  await h.click('Cancel');
  await h.click('Save as template');
  await h.change('Template name', 'New form is current');
  await act(async () => { hold.resolve([savedTemplate]); });
  assert.equal(h.root.findByProps({ 'aria-label': 'Template name' }).props.value, 'New form is current');
  assert.equal(h.root.findAllByProps({ 'aria-label': 'Saved description templates' }).length, 0);
});

test('a late template save cannot alter the next line editor after switching lines', async t => {
  const hold = deferred();
  const h = await templateHarness({ save: () => hold.promise });
  t.after(async () => { hold.resolve(savedTemplate); await h.dispose(); });
  await h.click('Save as template');
  await h.click('Save template');
  await h.switchEditor('area-2', { value: 'Second line description.', defaultName: 'Second line' });
  await h.click('Save as template');
  await h.change('Template name', 'Second line remains current');
  await act(async () => { hold.resolve(savedTemplate); });
  assert.equal(h.root.findByProps({ 'aria-label': 'Template name' }).props.value, 'Second line remains current');
  assert.deepEqual(h.applications, []);
  assert.equal(h.savedCallbacks.length, 0, 'Unmounted editor does not update parent state');
  assert.doesNotMatch(h.text(), /Saved “Garage coating”/);
});

// ProseMirror owns the editable DOM, so these two integration cases mount
// ReactDOM into JSDOM instead of replacing the document with a fake textarea.
async function richEditorHarness(options = {}) {
  const { JSDOM } = estimatorRequire('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><main id="fixture-root"></main></body></html>', {
    url: 'https://fixture.invalid', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.confirm = () => true;
  window.scrollBy = () => {};
  const rectangle = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  window.Range.prototype.getClientRects = () => [];
  window.Range.prototype.getBoundingClientRect = () => rectangle;
  window.document.elementFromPoint = () => null;
  const bindings = {
    window, document: window.document, navigator: window.navigator,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver, DOMParser: window.DOMParser,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    innerHeight: 800, innerWidth: 1200, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(bindings)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const changes = [], saves = [];
  const load = componentLoader({
    'lib/lineTemplates': {
      canSaveLineTemplates: async () => true,
      loadLineTemplates: async () => [savedTemplate],
      getCachedLineTemplates: async () => [savedTemplate],
      saveLineTemplate: async payload => { saves.push(JSON.parse(JSON.stringify(payload))); return { ...savedTemplate, ...payload }; },
    },
    'offline/uuid': { uuid: () => 'fixture-scope-template' },
  }, bindings);
  const ScopeEditor = load('features/estimator/ScopeEditor.tsx').default;
  function Fixture() {
    const [description, setDescription] = React.useState(options.value || '');
    return React.createElement(ScopeEditor, {
      value: description, onChange: value => { changes.push(value); setDescription(value); },
      placeholder: 'Describe the work', label: 'Line description',
      ...(options.templates === false ? {} : {
        templateOptions: { defaultName: 'Fixture line', createdBy: 'fixture-user',
          initialTemplates: [savedTemplate], online: true, onSaved() {} },
      }),
    });
  }
  const { createRoot } = estimatorRequire('react-dom/client');
  const reactRoot = createRoot(window.document.getElementById('fixture-root'));
  await act(async () => { reactRoot.render(React.createElement(Fixture)); });
  const h = {
    changes, saves, document: window.document,
    editor() {
      const editable = window.document.querySelector('[role="textbox"][aria-label="Line description"][contenteditable="true"]');
      assert.ok(editable, 'One live formatted description editor exists');
      return editable;
    },
    async click(label) {
      const matches = [...window.document.querySelectorAll('button')].filter(button => button.textContent === label);
      assert.equal(matches.length, 1, `Find one ${label} button`);
      assert.equal(matches[0].disabled, false, `${label} must be available`);
      await act(async () => { matches[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    },
    async chooseTemplate() {
      await h.click('Use template');
      const select = window.document.querySelector('select[aria-label="Saved description templates"]');
      assert.ok(select);
      await act(async () => {
        select.value = savedTemplate.id;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
      await h.click('Use description');
    },
    async appendParagraph(text) {
      await act(async () => {
        const paragraph = window.document.createElement('p');
        paragraph.textContent = text;
        h.editor().appendChild(paragraph);
        h.editor().dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        await new Promise(resolve => setTimeout(resolve, 10));
      });
    },
    async dispose() {
      await act(async () => { reactRoot.unmount(); });
      window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
  return h;
}

test('the real formatted ScopeEditor applies a template and saves later typing as the latest description', async t => {
  const h = await richEditorHarness(); t.after(() => h.dispose());
  await h.chooseTemplate();
  assert.equal(h.changes[0], savedTemplate.description, 'Reuse follows the existing description onChange path');
  assert.match(h.editor().innerHTML, /<strong>Prepare the floor\.<\/strong>/);
  assert.match(h.editor().innerHTML, /<ul>/);
  assert.match(h.editor().textContent, /\{\{system\}\}/);
  assert.equal(h.document.querySelectorAll('textarea').length, 0, 'Formatted editing replaces the raw textarea');
  assert.equal(h.document.querySelectorAll('[aria-label="Line description preview"]').length, 0, 'There is no second description preview');
  await h.appendParagraph('Customer-specific exclusion.');
  assert.match(h.editor().textContent, /Customer-specific exclusion\./);
  assert.ok(h.changes.some(value => value.includes('Customer-specific exclusion.')), 'DOM typing reaches the persisted description state');
  const editsBeforeTemplateSave = h.changes.length;
  await h.click('Save as template');
  await h.click('Save template');
  assert.equal(h.saves.length, 1);
  assert.match(h.saves[0].description, /Customer-specific exclusion\./);
  assert.match(h.saves[0].description, /\*\*Prepare the floor\.\*\*/);
  assert.match(h.saves[0].description, /\{\{system\}\}/);
  assert.deepEqual(Object.keys(h.saves[0]).sort(), ['createdBy', 'description', 'id', 'name']);
  assert.equal(h.changes.length, editsBeforeTemplateSave, 'Saving a template does not produce another estimate edit');
});

test('ScopeEditor remains editable without template controls', async t => {
  const h = await richEditorHarness({ value: '**Ordinary scope text.**', templates: false });
  t.after(() => h.dispose());
  assert.equal([...h.document.querySelectorAll('button')].filter(button => /template/.test(button.textContent)).length, 0);
  assert.match(h.editor().innerHTML, /<strong>Ordinary scope text\.<\/strong>/);
  await h.appendParagraph('Edited scope text.');
  assert.ok(h.changes.some(value => value.includes('Edited scope text.')));
});
