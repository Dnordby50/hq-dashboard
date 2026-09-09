import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerStudio } from './owner-studio.js';
import { ownerFixture } from './owner-test-fixture.js';
import { ownerConfig, routineStatus } from './owner-routine.js';
import { applyMbpLive, applyMbpEdits } from './owner-mbp-inputs.js';
const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function rootFixture() {
  let markup = '', inputs = [], drawCount = 0;
  const notice = { textContent: '' }, nav = { clientWidth: 900, scrollLeft: 0, querySelector: () => ({ offsetLeft: 0, offsetWidth: 100 }) };
  const scroll = { scrollTop: 0, scrollLeft: 0 };
  const root = {
    isConnected: true, oninput: null, onchange: null, onclick: null,
    set innerHTML(value) {
      markup = value; drawCount++;
      inputs = [...value.matchAll(/<input\b[^>]*data-mbp-key="([^"]+)"[^>]*>/g)].map(match => {
        const val = decode(/\bvalue="([^"]*)"/.exec(match[0])?.[1] || '');
        const source = { textContent: '' }, classes = new Set();
        const entry = { dataset: { savedManual: 'false' }, classList: { toggle: (key, set) => set ? classes.add(key) : classes.delete(key) }, querySelector: () => source };
        return { value: val, defaultValue: val, disabled: false, dataset: { mbpKey: decode(match[1]) }, closest: () => entry, focus() {} };
      });
    },
    get innerHTML() { return markup; },
    get inputs() { return inputs; },
    get drawCount() { return drawCount; },
    querySelector(selector) { return selector === '.tc-nav' ? nav : selector === '.tc-mbp-scroll' ? scroll : selector === '.tc-save-status' ? notice : null; },
    querySelectorAll(selector) { return selector === '[data-mbp-key]' || selector === 'button,input,textarea,select' ? inputs : selector === '.tc-save-status,.tc-focus-save-status' ? [notice] : []; },
    setAttribute() {}, removeAttribute() {}, replaceChildren() { markup = ''; inputs = []; }, contains: element => inputs.includes(element),
  };
  return root;
}
async function harness({ failFirstSave = false, deferredRefresh = false } = {}) {
  let clock = new Date('2026-01-12T18:00:00.000Z'), feeds = 0, resolveRefresh;
  const config = ownerConfig([]), root = rootFixture(), posts = [], source = { mbp: ownerFixture(), status: 'draft' };
  let saved = { doc_key: 'mbp:2026', revision: 4, body: structuredClone(source) }, recordedRequest;
  const feed = () => ({ queriedAt: clock.toISOString(), throughWeek: '2026-01-18', warnings: [], weeks: [{ weekEnding: '2026-01-11', actual: { leads: feeds > 1 ? 10 : 8 }, available: { leads: true } }] });
  const response = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });
  const studio = createOwnerStudio({
    getSession: () => ({ user: { id: 'synthetic-owner' }, access_token: 'synthetic-token' }), openOwner() {}, now: () => clock,
    fetchImpl: async (url, request) => {
      const query = new URL(url, 'https://example.invalid').searchParams, action = query.get('action');
      if (action === 'status') return response({ config, routine: routineStatus(clock, config) });
      if (action === 'document') return response({ document: query.get('key') === 'mbp:2026' ? saved : query.get('key') === 'source:2026' ? { doc_key: 'source:2026', revision: 1, body: source } : null });
      if (action === 'mbp-live') { feeds++; if (deferredRefresh && feeds > 1) await new Promise(resolve => { resolveRefresh = resolve; }); return response(feed()); }
      if (action === 'mbp-inputs') {
        const payload = JSON.parse(request.body); posts.push(payload);
        if (recordedRequest === payload.requestId) return response({ document: saved, replayed: true });
        saved = { ...saved, revision: saved.revision + 1, body: applyMbpEdits(applyMbpLive(saved.body, feed()), payload.edits, clock.toISOString()) };
        recordedRequest = payload.requestId;
        if (failFirstSave && posts.length === 1) throw new Error('Response interrupted after saving');
        return response({ document: saved });
      }
      throw new Error(`Unexpected test action: ${action}`);
    },
  });
  await studio.bootstrap(); await studio.render(root);
  async function click(dataset) {
    const target = { tagName: 'BUTTON', textContent: 'Action', dataset, disabled: false }; target.closest = () => target;
    await root.onclick({ target });
  }
  function edit(key, value) {
    const input = root.inputs.find(input => input.dataset.mbpKey === key);
    assert.ok(input, `Expected editable ${key}`); input.value = value; root.oninput({ target: input }); return input;
  }
  return { root, studio, click, edit, posts, source, saved: () => saved, feeds: () => feeds, advance: minutes => { clock = new Date(clock.getTime() + minutes * 60000); }, finishRefresh: () => resolveRefresh(), refreshPending: () => Boolean(resolveRefresh) };
}
const leadKey = 'epoxy/sales/2026-01-11/leads';

test('a lost MBP save response preserves typed input and reuses exactly the same request on retry', async () => {
  const h = await harness({ failFirstSave: true });
  await h.click({ page: 'sales' }); await h.click({ action: 'brand', brand: 'epoxy' });
  const input = h.edit(leadKey, '12');
  await h.click({ action: 'save-mbp-inputs' });
  assert.equal(input.value, '12'); assert.equal(input.disabled, false);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0].edits, [{ key: leadKey, value: 12 }]);
  await h.click({ action: 'save-mbp-inputs' });
  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.posts[1], h.posts[0]);
  assert.equal(h.saved().revision, 5);
  assert.equal(h.saved().body.mbpCellState[leadKey].origin, 'manual');
  assert.equal(h.root.inputs.find(input => input.dataset.mbpKey === leadKey).value, '12');
});

test('original MBP snapshots expose no editable inputs or weekly actions and never request live values', async () => {
  const h = await harness();
  await h.click({ page: 'sales' }); await h.click({ action: 'brand', brand: 'epoxy' });
  const before = structuredClone(h.source), feeds = h.feeds();
  await h.click({ action: 'source' });
  assert.equal(h.root.inputs.length, 0);
  assert.doesNotMatch(h.root.innerHTML, /data-action="edit-week"|data-action="save-mbp-inputs"|data-action="mbp-refresh"/);
  assert.equal(h.feeds(), feeds);
  assert.deepEqual(h.source, before);
});

test('TOTAL revenue custom values edit independently without exposing calculated total cells', async () => {
  const h = await harness();
  await h.click({ page: 'revenue' });
  assert.equal(h.root.inputs.length, 104);
  assert.ok(h.root.inputs.every(input => /^total\/revenue\/\d{4}-\d{2}-\d{2}\/(plan|actual)$/.test(input.dataset.mbpKey)));
  const before = structuredClone(h.saved().body.mbp.lines);
  h.edit('total/revenue/2026-01-11/actual', '19.75');
  await h.click({ action: 'save-mbp-inputs' });
  assert.deepEqual(h.posts[0].edits, [{ key: 'total/revenue/2026-01-11/actual', value: 19.75 }]);
  assert.equal(h.saved().body.mbp.totalRevenueCustom[1].actual, 19.75);
  assert.deepEqual(h.saved().body.mbp.lines.find(line => line.id === 'painting'), before.find(line => line.id === 'painting'));
});

test('typing during a background refresh is not redrawn or lost when the newer feed arrives', async () => {
  const previous = globalThis.document;
  globalThis.document = { hidden: false, activeElement: null, getElementById: () => ({}) };
  try {
    const h = await harness({ deferredRefresh: true });
    await h.click({ page: 'sales' }); await h.click({ action: 'brand', brand: 'epoxy' });
    h.advance(6); const draws = h.root.drawCount;
    h.studio.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(h.refreshPending());
    const input = h.edit(leadKey, '12');
    h.finishRefresh(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(input.value, '12'); assert.equal(h.root.drawCount, draws);
    await h.click({ action: 'save-mbp-inputs' });
    assert.deepEqual(h.posts[0].edits, [{ key: leadKey, value: 12 }]);
    assert.equal(h.saved().body.mbpCellState[leadKey].origin, 'manual');
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});
