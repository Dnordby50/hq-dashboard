const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the shipped inline functions, with synthetic users and changelog data.
// The tiny DOM implements only the selectors/events used by those functions;
// no browser package or application data is required for this regression suite.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function between(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing inline source boundary: ${start}`);
  return html.slice(from, to);
}
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = new Map();
    this.disabled = false; this.textContent = ''; this._markup = '';
  }
  set id(value) { this.attributes.id = value; }
  get id() { return this.attributes.id || ''; }
  set className(value) { this.attributes.class = value; }
  get className() { return this.attributes.class || ''; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const attribute = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(selector);
    if (attribute) return attribute[1] in this.attributes && (attribute[2] === undefined || this.attributes[attribute[1]] === attribute[2]);
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim()), result = [];
    const walk = element => { for (const child of element.children) { if (selectors.some(item => child.matches(item))) result.push(child); walk(child); } };
    walk(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null;
  }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); for (const child of children) this.appendChild(child); }
  get parentElement() { return this.parentNode; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get isConnected() { return this.tagName === 'BODY' || Boolean(this.parentNode?.isConnected); }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== callback)); }
  async dispatch(type, options = {}) {
    const event = { target: this, key: '', preventDefault() {}, stopPropagation() {}, ...options };
    await Promise.all((this.listeners.get(type) || []).map(callback => callback(event)));
  }
  focus() {}
  set innerHTML(value) {
    this.replaceChildren(); this._markup = value;
    const stack = [this];
    for (const match of value.matchAll(/<(\/?)([a-z][\w-]*)(\s[^>]*?)?\s*\/?\s*>/gi)) {
      const [, closing, tag, attributes = ''] = match;
      if (closing) { if (stack.length > 1) stack.pop(); continue; }
      const node = new Element(tag);
      for (const attribute of attributes.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) node.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
      stack.at(-1).appendChild(node);
      if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag.toLowerCase())) stack.push(node);
    }
  }
  get innerHTML() { return this.children.length ? this._markup || '<synthetic-child>' : ''; }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness() {
  const body = new Element('body'), document = new Element('document'), events = new Element('window');
  const ids = ['pecModalRoot', 'prodModalRoot', 'pecWhatsNewRoot'];
  for (const id of ids) { const root = new Element(); root.id = id; body.appendChild(root); }
  document.body = body; document.createElement = tag => new Element(tag);
  document.getElementById = id => body.querySelector(`#${id}`);
  const state = { session: { user: { id: 'auth-a' } }, adminUser: { id: 'staff-a', role: 'admin' } };
  const writes = [], navigation = [], counters = { fetches: 0, reads: 0, reloads: 0, recoveries: 0 };
  const gates = { fetch: null, read: null, write: null };
  const window = {
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    applyAuthShell() {},
  };
  const context = vm.createContext({
    document, window, state, console, Set, Promise,
    $: id => document.getElementById(id), esc: value => String(value ?? ''),
    location: { reload() { counters.reloads++; } }, recoverWedgedClient() { counters.recoveries++; },
    ownerStudio: { sessionChanged() {}, bootstrap: async () => {} },
    deriveAuthShell: () => ({}), setAuthGateState() {}, renderAuthUI() {},
    switchView: view => navigation.push(view),
    fetch: async () => { counters.fetches++; if (gates.fetch) await gates.fetch; return { ok: true, json: async () => [{ id: 'synthetic-update', title: 'A readable update', summary: 'Synthetic regression content.' }] }; },
    supabase: { from: () => ({
      select: () => ({ eq: async () => { counters.reads++; if (gates.read) await gates.read; return { data: [], error: null }; } }),
      upsert: async rows => { writes.push(JSON.parse(JSON.stringify(rows))); if (gates.write) await gates.write; return { error: null }; },
    }) },
  });
  const auth = between('function renderGlobalAuthGate()', '// ============================================================\n// What\'s New');
  const whatsNew = between('function wnEntryHtml(e)', '// Internal staff debug shim.');
  const modal = between('function openModal(html,', '// Prompt 71 Part E2:');
  const cleanup = between('function clearAllModalRoots()', '// Backstop for rejections');
  const prod = between('window.prodSwitchView = async function (crmView) {', '    const r = root();').replace('window.prodSwitchView = async function (crmView) {', 'function prodNavigationCleanup() {') + '\n}';
  const wedge = between('let _pecReloadingForWedge = false;', 'async function withFreshSession(');
  vm.runInContext([auth, whatsNew, modal, cleanup, prod, wedge].join('\n'), context);
  return {
    context, state, gates, writes, navigation, counters,
    root: id => document.getElementById(id),
    whatsNew: () => document.getElementById('pecWhatsNewRoot').lastElementChild,
    run: code => vm.runInContext(code, context),
    event: type => events.dispatch(type),
    account: id => { state.session = id ? { user: { id: `auth-${id}` } } : null; state.adminUser = id ? { id: `staff-${id}`, role: 'admin' } : null; vm.runInContext('renderGlobalAuthGate()', context); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('unseen updates survive ordinary modal cleanup, background errors, and production navigation', async () => {
  const h = harness(); await h.run('maybeShowWhatsNew()');
  const popup = h.whatsNew(); assert.ok(popup, 'unseen update should open in its own root');
  h.run('openModal("<p>Ordinary info</p>"); clearAllModalRoots()');
  assert.equal(h.root('pecModalRoot').children.length, 0); assert.equal(h.whatsNew(), popup);
  h.run('openModal("<input>"); clearAllModalRoots()');
  assert.equal(h.root('pecModalRoot').children.length, 1, 'ordinary data-entry protection stays intact');
  h.run('closeModal(); prodNavigationCleanup()');
  assert.equal(h.root('pecModalRoot').children.length, 0); assert.equal(h.whatsNew(), popup);
  await h.event('error'); await h.event('unhandledrejection');
  assert.equal(h.whatsNew(), popup); assert.equal(h.writes.length, 0);
  await h.run('maybeShowWhatsNew()'); assert.equal(h.counters.fetches, 1, 'no duplicate popup during the same sign-in');
});

test('backdrop clicks leave updates open and explicit X closes only that update without acknowledging it', async () => {
  const h = harness(); await h.run('maybeShowWhatsNew()');
  const popup = h.whatsNew(); await popup.dispatch('click'); assert.equal(h.whatsNew(), popup);
  h.run('openModal("<p>Other modal</p>")');
  await popup.querySelector('[data-pec-modal-x]').dispatch('click');
  assert.equal(h.whatsNew(), null); assert.equal(h.root('pecModalRoot').children.length, 1); assert.equal(h.writes.length, 0);
});

test('Got it acknowledges shown entries and closes only the update', async () => {
  const h = harness(); await h.run('maybeShowWhatsNew()'); h.run('openModal("<p>Other modal</p>")');
  await h.whatsNew().querySelector('#wnGotIt').dispatch('click');
  assert.equal(h.whatsNew(), null); assert.equal(h.root('pecModalRoot').children.length, 1);
  assert.deepEqual(h.writes, [[{ admin_user_id: 'staff-a', entry_id: 'synthetic-update' }]]); assert.deepEqual(h.navigation, []);
});

test('Help acknowledges shown entries and opens the updates page', async () => {
  const h = harness(); await h.run('maybeShowWhatsNew()');
  await h.whatsNew().querySelector('#wnHelpLink').dispatch('click');
  assert.equal(h.whatsNew(), null); assert.equal(h.writes.length, 1); assert.deepEqual(h.navigation, ['docs']);
});

test('sign-out during a delayed update lookup cannot open an old account popup', async () => {
  const h = harness(), read = deferred(); h.gates.read = read.promise;
  const loading = h.run('maybeShowWhatsNew()'); await flush(); assert.equal(h.counters.reads, 1);
  h.account(null); read.resolve(); await loading;
  assert.equal(h.whatsNew(), null); assert.equal(h.writes.length, 0);
});

test('same-account auth rendering preserves the open update without querying or acknowledging it again', async () => {
  const h = harness(); await h.run('maybeShowWhatsNew()'); const popup = h.whatsNew();
  h.account('a'); await flush();
  assert.equal(h.whatsNew(), popup); assert.equal(h.counters.fetches, 1); assert.equal(h.counters.reads, 1); assert.equal(h.writes.length, 0);
});

test('a delayed old account lookup cannot replace the new account update', async () => {
  const h = harness(), read = deferred(); h.gates.read = read.promise;
  const loading = h.run('maybeShowWhatsNew()'); await flush();
  h.gates.read = null; h.account('b'); await flush(); const newPopup = h.whatsNew(); assert.ok(newPopup);
  read.resolve(); await loading;
  assert.equal(h.whatsNew(), newPopup); assert.equal(h.root('pecWhatsNewRoot').children.length, 1); assert.equal(h.writes.length, 0);
});

test('a late acknowledgment from an old account cannot close a new popup or navigate its session', async () => {
  const h = harness(); await h.run('maybeShowWhatsNew()');
  const write = deferred(); h.gates.write = write.promise;
  const closing = h.whatsNew().querySelector('#wnHelpLink').dispatch('click');
  h.account('b'); await flush(); const newPopup = h.whatsNew(); assert.ok(newPopup);
  write.resolve(); await closing;
  assert.equal(h.whatsNew(), newPopup); assert.deepEqual(h.navigation, []);
  assert.deepEqual(h.writes, [[{ admin_user_id: 'staff-a', entry_id: 'synthetic-update' }]]);
});

test('repeat acknowledgment clicks write once and a dismissed dialog cannot later navigate', async () => {
  const h = harness(); await h.run('maybeShowWhatsNew()'); const popup = h.whatsNew();
  const write = deferred(); h.gates.write = write.promise;
  const pending = popup.querySelector('#wnHelpLink').dispatch('click');
  await popup.querySelector('#wnGotIt').dispatch('click'); assert.equal(h.writes.length, 1);
  await popup.querySelector('[data-pec-modal-x]').dispatch('click');
  h.run('openModal("<p>Other modal</p>")'); write.resolve(); await pending;
  assert.equal(h.whatsNew(), null); assert.equal(h.root('pecModalRoot').children.length, 1); assert.deepEqual(h.navigation, []);
});

test('a session recovery keeps the updates visible instead of reloading the page', async () => {
  const h = harness(); await h.run('maybeShowWhatsNew()'); const popup = h.whatsNew();
  h.run('_pecWedgeReload("synthetic timeout")');
  assert.equal(h.counters.reloads, 0); assert.equal(h.counters.recoveries, 1); assert.equal(h.whatsNew(), popup);
});
