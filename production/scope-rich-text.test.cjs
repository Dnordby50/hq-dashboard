'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const estimatorRoot = path.resolve(__dirname, '../apps/estimator');
const localRequire = createRequire(path.join(estimatorRoot, 'package.json'));
const ts = localRequire('typescript');
const { JSDOM } = localRequire('jsdom');
const { EditorView } = localRequire('prosemirror-view');
const { TextSelection } = localRequire('prosemirror-state');
const { toggleMark } = localRequire('prosemirror-commands');
const { undo, redo } = localRequire('prosemirror-history');
const { mdToSafeHtml, scopePlainText } = require('./estimate-formatting.cjs');

function loadSource(file, mocks = {}) {
  const absolute = path.join(estimatorRoot, 'src', file);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    fileName: absolute, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const requireAtFile = createRequire(absolute);
  new Function('require', 'module', 'exports', compiled)(name => mocks[name] || requireAtFile(name), module, module.exports);
  return module.exports;
}
const rich = loadSource('lib/scopeRichText.ts');

function withDom(run) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'https://fixture.invalid', pretendToBeVisual: true });
  const keys = ['window', 'document', 'navigator', 'MutationObserver', 'HTMLElement', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key]?.bind && ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? dom.window[key].bind(dom.window) : dom.window[key] });
  const rect = () => ({ left: 0, right: 10, top: 0, bottom: 10, width: 10, height: 10 });
  dom.window.Range.prototype.getClientRects = () => [rect()];
  dom.window.Range.prototype.getBoundingClientRect = rect;
  dom.window.scrollBy = () => {};
  const cleanup = () => {
    dom.window.close();
    for (const [key, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  };
  try {
    const result = run(dom.window.document, dom.window);
    if (result && typeof result.then === 'function') return result.finally(cleanup);
    cleanup(); return result;
  } catch (error) { cleanup(); throw error; }
}

test('formatted footage, multiple spans, combined marks and multiline lists reopen losslessly', () => withDom(document => {
  for (const markdown of [
    '**970 sqft**', '**Prep** and **coat** the floor.', '***Bold and italic*** with *italic* and **bold**.',
    '- **Prepare** the floor\n- Apply *basecoat*\n- Protect the finish',
    '3. **Prepare**\n4. Coat\n5. Protect', 'First line\nSecond line\nThird line',
    '## Preparation\n***Keep dry***\n---\n### Curing\nWait for cure.',
  ]) {
    const doc = rich.markdownToScopeDoc(markdown, document);
    const serialized = rich.scopeDocToMarkdown(doc);
    assert.ok(doc.eq(rich.markdownToScopeDoc(serialized, document)), `${markdown} -> ${serialized}`);
    assert.equal(scopePlainText(serialized), scopePlainText(markdown));
    assert.doesNotMatch(serialized, /\n\n/);
  }
  assert.equal(rich.scopeDocToMarkdown(rich.markdownToScopeDoc('**970 sqft**', document)), '**970 sqft**');
}));

test('all adjacent bold/italic mark combinations survive markdown storage', () => withDom(document => {
  const schema = rich.scopeSchema;
  const marks = [[], [schema.marks.strong.create()], [schema.marks.em.create()], [schema.marks.strong.create(), schema.marks.em.create()]];
  for (const first of marks) for (const second of marks) for (const third of marks) {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [
      schema.text('Prep', first), schema.text(' and '), schema.text('coat', second), schema.text(' then '), schema.text('cure', third),
    ])]);
    const markdown = rich.scopeDocToMarkdown(doc);
    assert.ok(doc.eq(rich.markdownToScopeDoc(markdown, document)), markdown);
  }
}));

test('typing literal markup punctuation does not silently become formatting after reload', () => withDom(document => {
  const text = '# literal heading [reference] _name_ *stars* `code` <script>alert(1)</script>';
  const doc = rich.scopeSchema.node('doc', null, [rich.scopeSchema.node('paragraph', null, [rich.scopeSchema.text(text)])]);
  const markdown = rich.scopeDocToMarkdown(doc);
  assert.ok(doc.eq(rich.markdownToScopeDoc(markdown, document)));
  const html = mdToSafeHtml(markdown);
  assert.doesNotMatch(html, /<script>|<strong>|<em>|font-weight:800/);
  assert.equal(scopePlainText(markdown), text);
}));

test('real editing commands support lists, bold, caret placement, undo and redo', () => withDom(document => {
  const view = new EditorView(document.getElementById('host'), {
    state: rich.createScopeEditorState('Prepare\nCoat', document),
    dispatchTransaction(transaction) { view.updateState(view.state.apply(transaction)); },
  });
  try {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 8)));
    toggleMark(rich.scopeSchema.marks.strong)(view.state, view.dispatch);
    assert.match(view.dom.innerHTML, /<strong>Prepare<\/strong>/);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, view.state.doc.content.size - 1)));
    rich.toggleScopeList('bullet_list')(view.state, view.dispatch);
    assert.equal(view.dom.querySelectorAll('ul > li').length, 2);
    rich.toggleScopeList('ordered_list')(view.state, view.dispatch);
    assert.equal(view.dom.querySelectorAll('ol > li').length, 2);
    assert.match(rich.scopeDocToMarkdown(view.state.doc), /^1\. \*\*Prepare\*\*\n2\. Coat$/);
    assert.equal(undo(view.state, view.dispatch), true);
    assert.equal(redo(view.state, view.dispatch), true);
    assert.equal(view.dom.querySelectorAll('ol > li').length, 2);
    rich.toggleScopeList('ordered_list')(view.state, view.dispatch);
    assert.equal(view.dom.querySelectorAll('ol').length, 0);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4)));
    view.dispatch(view.state.tr.insertText('X'));
    assert.equal(view.state.selection.from, 5);
    assert.match(view.state.doc.textContent, /PreXpare/);
  } finally { view.destroy(); }
}));

test('real paste strips scripts, event handlers, images and links while preserving allowed formatting', () => withDom((document, window) => {
  const view = new EditorView(document.getElementById('host'), {
    state: rich.createScopeEditorState('', document),
    dispatchTransaction(transaction) { view.updateState(view.state.apply(transaction)); },
  });
  try {
    view.pasteHTML('<script>window.injected=true</script><p onclick="alert(1)"><strong>Prepare</strong> &amp; <em>coat</em><img src=x onerror="window.injected=true"></p><ul><li>Clean</li><li><a href="javascript:alert(1)">Protect</a></li></ul>', new window.Event('paste', { bubbles: true }));
    const markdown = rich.scopeDocToMarkdown(view.state.doc);
    assert.equal(window.injected, undefined);
    assert.equal(view.dom.querySelector('script,img,a,[onclick],[onerror]'), null);
    assert.match(markdown, /\*\*Prepare\*\* & \*coat\*/);
    assert.match(markdown, /- Clean\n- Protect/);
    assert.doesNotMatch(markdown, /injected|javascript|onerror|<p|<strong/);
    assert.ok(view.state.doc.eq(rich.markdownToScopeDoc(markdown, document)));
  } finally { view.destroy(); }
}));

test('controlled parent echoes preserve editor node, caret and undo; external replacements remain undoable', async () => withDom(async (document, window) => {
  const React = localRequire('react');
  const { createRoot } = localRequire('react-dom/client');
  const { act } = React;
  const ScopeEditor = loadSource('features/estimator/ScopeEditor.tsx', {
    '../../lib/scopeRichText': rich,
    './DescriptionTemplates': { __esModule: true, default: () => null },
  }).default;
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.getElementById('host');
  const root = createRoot(host);
  let replace, latest;
  function Harness() {
    const [value, setValue] = React.useState('**970 sqft**');
    replace = setValue;
    return React.createElement(ScopeEditor, { value, onChange: next => { latest = next; setValue(next); }, placeholder: 'Describe work', sheetDescription: true });
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const editable = host.querySelector('[contenteditable="true"]');
    assert.ok(editable);
    assert.equal(editable.getAttribute('data-sheet-desc'), '1');
    assert.equal(editable.tabIndex, 0);
    assert.equal(host.querySelector('textarea,.scope-editor-preview'), null);
    const text = editable.querySelector('strong').firstChild;
    const range = document.createRange(); range.setStart(text, 3); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    editable.focus();
    await act(async () => {
      text.nodeValue = '970X sqft';
      const typed = document.createRange(); typed.setStart(text, 4); typed.collapse(true);
      selection.removeAllRanges(); selection.addRange(typed);
      editable.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'X' }));
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    assert.equal(latest, '**970X sqft**');
    assert.equal(host.querySelector('[contenteditable="true"]'), editable);
    assert.equal(selection.anchorOffset, 4);
    assert.equal(selection.anchorNode.textContent, '970X sqft');
    await act(async () => replace('- **New template**\n- Next step'));
    assert.equal(editable.querySelectorAll('ul > li').length, 2);
    const undoButton = [...host.querySelectorAll('button')].find(button => button.textContent === 'Undo');
    await act(async () => undoButton.click());
    assert.equal(latest, '**970X sqft**');
    assert.equal(editable.querySelector('strong').textContent, '970X sqft');
  } finally {
    await act(async () => root.unmount());
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
}));
