// Full-screen workbook editing: autosave, replay, conflicts and Use TopCoat, driven
// through createOwnerStudio with a minimal element stub. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerStudio } from './owner-studio.js';
import { ownerFixture } from './owner-test-fixture.js';
import { ownerConfig, routineStatus } from './owner-routine.js';
import { applyMbpEdits, applyMbpLive } from './owner-mbp-inputs.js';

const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag, name) => { const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return match ? decode(match[1]) : undefined; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function elementStub(className = '') {
  const handlers = new Map();
  let html = '', inputs = [];
  const status = { textContent: '', title: '', classList: { add() {} } };
  const surface = { scrollTop: 0, scrollLeft: 0, addEventListener() {} };
  const element = {
    className, dataset: {}, removed: false,
    setAttribute() {}, removeAttribute() {}, remove() { element.removed = true; },
    addEventListener(type, fn) { handlers.set(type, fn); },
    fire(type, event) { return handlers.get(type)?.(event); },
    get handlers() { return handlers; },
    set innerHTML(value) {
      html = value;
      inputs = [...value.matchAll(/<input\b[^>]*class="wb-input"[^>]*>/g)].map(match => {
        const tag = match[0], current = attr(tag, 'value') ?? '';
        const input = {
          tagName: 'INPUT', value: current, defaultValue: current, disabled: false,
          dataset: { cell: attr(tag, 'data-cell'), mbpKey: attr(tag, 'data-mbp-key'), mbpReset: attr(tag, 'data-mbp-reset'), financeCell: attr(tag, 'data-finance-cell') },
          classList: { contains: name => name === 'wb-input' },
          focus() {}, blur() {}, setSelectionRange() {},
        };
        input.closest = selector => (selector.includes('data-mbp-reset') ? (input.dataset.mbpReset ? input : null) : input);
        return input;
      });
    },
    get innerHTML() { return html; },
    get inputs() { return inputs; },
    querySelector(selector) {
      if (selector === '.tc-wb-status') return status;
      if (selector === '.tc-wb-surface') return surface;
      const cell = /^\.wb-input\[data-cell="([^"]+)"\]$/.exec(selector);
      if (cell) return inputs.find(input => input.dataset.cell === cell[1]) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.wb-input' || selector === '[data-mbp-key]') return inputs;
      if (selector === '[data-finance-cell]' || selector === '[data-finance-label]') return [];
      if (selector === 'button,input,textarea,select') return inputs;
      return [];
    },
    get status() { return status; },
  };
  return element;
}

function shellStub() {
  let html = '';
  const notice = { textContent: '' };
  const nav = { clientWidth: 900, scrollLeft: 0, querySelector: () => ({ offsetLeft: 0, offsetWidth: 100 }) };
  return {
    isConnected: true, oninput: null, onchange: null, onclick: null,
    set innerHTML(value) { html = value; }, get innerHTML() { return html; },
    querySelector: selector => (selector === '.tc-nav' ? nav : selector === '.tc-save-status' ? notice : null),
    querySelectorAll: selector => (selector === '.tc-save-status,.tc-focus-save-status' ? [notice] : []),
    setAttribute() {}, removeAttribute() {}, replaceChildren() { html = ''; }, contains: () => false,
  };
}

async function harness({ failFirstSave = false, conflict = false, autosave = '300' } = {}) {
  const previousDocument = globalThis.document, previousLocation = globalThis.location, previousConfirm = globalThis.confirm;
  const overlays = [];
  globalThis.document = {
    hidden: false, activeElement: null, fullscreenElement: null, getElementById: () => null,
    addEventListener() {}, exitFullscreen() {},
    createElement: () => { const element = elementStub(); overlays.push(element); return element; },
    body: { appendChild() {} },
  };
  globalThis.location = { search: '?v=owner-studio&mbp=workbook-preview' };
  globalThis.confirm = () => true;
  const clock = new Date('2026-06-15T18:00:00.000Z');
  const config = ownerConfig([{ key: 'owner_mbp_autosave_ms', value: autosave }]);
  const root = shellStub(), posts = [];
  let saved = { doc_key: 'mbp:2026', revision: 4, body: { mbp: ownerFixture(), status: 'draft' } };
  let recordedRequest = null, dropped = 0;
  // One available PEC week, so a saved manual edit is eligible for Use TopCoat.
  const feed = () => ({ queriedAt: clock.toISOString(), throughWeek: '2026-06-14', warnings: [], weeks: [{ weekEnding: '2026-01-11', actual: { leads: 8 }, available: { leads: true } }] });
  const response = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });
  const studio = createOwnerStudio({
    getSession: () => ({ user: { id: 'synthetic-owner' }, access_token: 'synthetic-token' }),
    openOwner() {}, now: () => clock,
    fetchImpl: async (url, request) => {
      const query = new URL(url, 'https://example.invalid').searchParams, action = query.get('action');
      if (action === 'status') return response({ config, routine: routineStatus(clock, config) });
      if (action === 'document') return response({ document: query.get('key') === 'mbp:2026' ? saved : null });
      if (action === 'finance-years') return response({ documents: [] });
      if (action === 'mbp-live') return response(feed());
      if (action === 'mbp-inputs') {
        const payload = JSON.parse(request.body); posts.push(payload);
        if (conflict) return { ok: false, status: 409, json: async () => ({ error: 'This plan changed in another place. Your typed values are still here.' }) };
        if (recordedRequest === payload.requestId) return response({ document: saved, replayed: true });
        saved = { ...saved, revision: saved.revision + 1, body: applyMbpEdits(applyMbpLive(saved.body, feed()), payload.edits, clock.toISOString()) };
        recordedRequest = payload.requestId;
        if (failFirstSave && ++dropped === 1) throw new Error('Response interrupted after saving');
        return response({ document: saved });
      }
      throw new Error(`Unexpected test action: ${action}`);
    },
  });
  await studio.bootstrap();
  await studio.render(root);
  const clickShell = async dataset => {
    const target = { tagName: 'BUTTON', textContent: 'Action', dataset, disabled: false };
    target.closest = () => target;
    await root.onclick({ target });
  };
  const overlay = () => overlays.at(-1);
  const clickOverlay = async dataset => {
    const target = { tagName: 'BUTTON', textContent: 'Action', dataset, disabled: false };
    target.closest = () => target;
    await overlay().fire('click', { target });
    await settle();
  };
  const cell = address => overlay().inputs.find(input => input.dataset.cell === address);
  const type = (address, value) => {
    const input = cell(address);
    assert.ok(input, `Expected an editable cell at ${address}`);
    input.value = value;
    overlay().fire('input', { target: input });
    return input;
  };
  return {
    studio, root, posts, overlay, cell, type, clickShell, clickOverlay,
    saved: () => saved,
    keydown: (address, key, shiftKey = false) => overlay().fire('keydown', { target: cell(address), key, shiftKey, preventDefault() {} }),
    restore() { globalThis.document = previousDocument; globalThis.location = previousLocation; globalThis.confirm = previousConfirm; },
  };
}

const leadKey = 'epoxy/sales/2026-01-11/leads';

test('the preview gate opens the workbook without removing the existing tabs', async () => {
  const h = await harness();
  try {
    await h.clickShell({ page: 'sales' });
    assert.match(h.root.innerHTML, /MBP summary preview/);
    assert.match(h.root.innerHTML, /data-action="workbook-open"/);
    assert.match(h.root.innerHTML, /data-action="save-mbp-inputs"/, 'the existing working plan is untouched');
    await h.clickShell({ action: 'workbook-open', sheet: 'sales_epoxy' });
    assert.match(h.overlay().innerHTML, /SP - \(Wk\) Epoxy/);
    assert.match(h.overlay().innerHTML, /data-action="workbook-sheet" data-sheet="budget"/, 'all eight sheet tabs are present');
    assert.ok(h.overlay().inputs.length > 100, 'weekly actuals are editable in place');
  } finally { h.restore(); }
});

test('rapid typing coalesces into one changed-field save after the idle delay', async () => {
  const h = await harness();
  try {
    await h.clickShell({ page: 'sales' });
    await h.clickShell({ action: 'workbook-open', sheet: 'sales_epoxy' });
    h.type('D13', '9');
    h.type('D13', '11');
    h.type('D13', '12');
    assert.equal(h.posts.length, 0, 'nothing is sent while typing continues');
    await wait(450);
    await settle();
    assert.equal(h.posts.length, 1, 'one save, not three');
    assert.deepEqual(h.posts[0].edits, [{ key: leadKey, value: 12 }]);
    assert.equal(h.posts[0].revision, 4);
    assert.equal(h.saved().revision, 5);
    assert.equal(h.saved().body.mbpCellState[leadKey].origin, 'manual');
  } finally { h.restore(); }
});

test('Delete leaves a blank override, which is not a zero', async () => {
  const h = await harness();
  try {
    await h.clickShell({ page: 'sales' });
    await h.clickShell({ action: 'workbook-open', sheet: 'sales_epoxy' });
    h.type('D13', '4');
    await wait(450); await settle();
    assert.equal(h.saved().body.mbp.lines.find(line => line.id === 'epoxy').sales.weekly[1].actual.leads, 4);
    h.type('D13', '');
    await wait(450); await settle();
    assert.deepEqual(h.posts.at(-1).edits, [{ key: leadKey, value: null }]);
    assert.equal(h.saved().body.mbp.lines.find(line => line.id === 'epoxy').sales.weekly[1].actual.leads, null);
    assert.notEqual(h.saved().body.mbp.lines.find(line => line.id === 'epoxy').sales.weekly[1].actual.leads, 0);
  } finally { h.restore(); }
});

test('a dropped save response replays the same request id instead of creating a second revision', async () => {
  const h = await harness({ failFirstSave: true });
  try {
    await h.clickShell({ page: 'sales' });
    await h.clickShell({ action: 'workbook-open', sheet: 'sales_epoxy' });
    const input = h.type('D13', '12');
    await wait(450); await settle();
    assert.equal(h.posts.length, 1);
    assert.equal(h.overlay().status.textContent, 'Conflict', 'the interrupted save is reported, not assumed');
    assert.equal(input.value, '12', 'the typed value is still on the screen');
    assert.equal(h.saved().revision, 5);
    h.type('D13', '12');
    await wait(450); await settle();
    assert.equal(h.posts.length, 2);
    assert.equal(h.posts[1].requestId, h.posts[0].requestId, 'the same request is retried');
    assert.equal(h.saved().revision, 5, 'the replay does not add a revision');
  } finally { h.restore(); }
});

test('a revision conflict keeps every typed value and never overwrites silently', async () => {
  const h = await harness({ conflict: true });
  try {
    await h.clickShell({ page: 'sales' });
    await h.clickShell({ action: 'workbook-open', sheet: 'sales_epoxy' });
    const input = h.type('D13', '7');
    await wait(450); await settle();
    assert.equal(h.overlay().status.textContent, 'Conflict');
    assert.match(h.overlay().status.title, /typed values are still here/);
    assert.equal(input.value, '7');
    assert.equal(h.saved().revision, 4, 'nothing was written');
  } finally { h.restore(); }
});

test('Escape restores the cell, and Enter moves down the same column', async () => {
  const h = await harness();
  try {
    await h.clickShell({ page: 'sales' });
    await h.clickShell({ action: 'workbook-open', sheet: 'sales_epoxy' });
    const input = h.cell('D13');
    input.value = '99';
    h.keydown('D13', 'Escape');
    assert.equal(input.value, input.defaultValue);
    let focused = null;
    h.cell('D14').focus = () => { focused = 'D14'; };
    h.keydown('D13', 'Enter');
    assert.equal(focused, 'D14');
  } finally { h.restore(); }
});

test('Use TopCoat from the cell menu resets only an eligible PEC override', async () => {
  const h = await harness();
  try {
    await h.clickShell({ page: 'sales' });
    await h.clickShell({ action: 'workbook-open', sheet: 'sales_epoxy' });
    h.type('D13', '12');
    await wait(450); await settle();
    const marked = h.cell('D13');
    assert.ok(marked.dataset.mbpReset, 'a saved manual override offers the reset');
    await h.overlay().fire('contextmenu', { target: marked, preventDefault() {} });
    await settle();
    assert.deepEqual(h.posts.at(-1).edits, [{ key: leadKey, mode: 'topcoat' }]);
    await h.clickShell({ action: 'workbook-open', sheet: 'sales_painting' });
    assert.ok(h.overlay().inputs.every(input => !input.dataset.mbpReset), 'FTP cells never offer it');
  } finally { h.restore(); }
});

test('switching sheet tabs saves pending edits before the grid changes', async () => {
  const h = await harness({ autosave: '5000' });
  try {
    await h.clickShell({ page: 'sales' });
    await h.clickShell({ action: 'workbook-open', sheet: 'sales_epoxy' });
    h.type('D13', '15');
    assert.equal(h.posts.length, 0, 'the long idle delay has not elapsed');
    await h.clickOverlay({ action: 'workbook-sheet', sheet: 'revenue_epoxy' });
    assert.equal(h.posts.length, 1, 'the pending edit is flushed, not dropped');
    assert.deepEqual(h.posts[0].edits, [{ key: leadKey, value: 15 }]);
    assert.match(h.overlay().innerHTML, /RP - \(Wk\) Epoxy/);
  } finally { h.restore(); }
});

test('Exit leaves the workbook and returns to the page behind it', async () => {
  const h = await harness();
  try {
    await h.clickShell({ page: 'sales' });
    await h.clickShell({ action: 'workbook-open', sheet: 'sales_epoxy' });
    const overlay = h.overlay();
    await h.clickOverlay({ action: 'workbook-exit' });
    assert.equal(overlay.removed, true);
    assert.match(h.root.innerHTML, /MBP summary preview/);
  } finally { h.restore(); }
});
