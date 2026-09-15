const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const section = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const authSource = section('function wireAuthListener()', '\nconst portalBase') + section('let _pecAuthEpoch =', '\n// ============================================================\n// Two-factor authentication') + section('async function pecReadMfaState()', '\nfunction renderAuthUI()');
const helpSource = html.slice(html.indexOf('<script>', html.indexOf('HELP WIDGET LOGIC')) + 8, html.indexOf('</script>', html.indexOf('HELP WIDGET LOGIC')));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { await new Promise(resolve => setTimeout(resolve, 5)); for (let i = 0; i < 8; i++) await tick(); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function session(uid = 'staff-a', id = 'session-a', aal = 'aal1') { return { user: { id: uid }, access_token: 'e30.' + Buffer.from(JSON.stringify({ session_id: id, aal })).toString('base64url') + '.synthetic' }; }
const factor = { id: 'synthetic-totp', status: 'verified', factor_type: 'totp' };
class Element {
  constructor(id) { this.id = id; this.value = ''; this.style = {}; this.children = []; this.handlers = {}; this.disabled = false; this.textContent = ''; this.className = ''; this.classList = { contains: n => (this._classes || new Set()).has(n), add: n => (this._classes ||= new Set()).add(n), remove: n => this._classes?.delete(n) }; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  async click() { if (!this.disabled) return this.handlers.click?.({}); }
  appendChild(child) { child.parent = this; this.children.push(child); }
  replaceChildren() { this.children = []; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
  focus() {}
}
function baseDom() {
  const elements = new Map(); const get = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const listeners = new Map(); const frameMessages = [];
  const document = { getElementById: get, createElement: tag => new Element(tag), body: get('body'), querySelectorAll: () => [{ contentWindow: { postMessage: data => frameMessages.push(data.type) } }] };
  const window = { addEventListener: (name, fn) => listeners.set(name, fn), dispatchEvent: event => listeners.get(event.type)?.() };
  return { elements, get, document, window, frameMessages };
}
function authFixture(options = {}) {
  const dom = baseDom(); let modal = null; let callback; let current = options.session || session(); let aal = options.aal || 'aal1';
  const reads = [], gates = [], audits = []; const state = { session: null, adminUser: null };
  const auth = {
    onAuthStateChange(fn) { callback = fn; return { data: { subscription: { unsubscribe() {} } } }; },
    getSession: async () => options.getSession ? options.getSession() : { data: { session: current }, error: null },
    signInWithPassword: async () => { callback?.('SIGNED_IN', current); return { data: { session: current }, error: null }; },
    signOut: async () => { current = null; callback?.('SIGNED_OUT', null); if (options.signOut) await options.signOut(); return { error: null }; },
    mfa: {
      getAuthenticatorAssuranceLevel: async () => options.assurance ? options.assurance() : { data: { currentLevel: aal, nextLevel: options.enrolled === false ? 'aal1' : 'aal2' }, error: null },
      listFactors: async () => options.factors ? options.factors() : { data: { all: options.enrolled === false ? [] : [factor], totp: options.enrolled === false ? [] : [factor] }, error: null },
      challengeAndVerify: async args => {
        if (options.verify) return options.verify(args);
        aal = 'aal2'; current = session(current.user.id, JSON.parse(Buffer.from(current.access_token.split('.')[1], 'base64url')).session_id, aal);
        callback?.('MFA_CHALLENGE_VERIFIED', current);
        return { data: { access_token: current.access_token }, error: null };
      },
    },
  };
  const ctx = vm.createContext({ ...dom, state, console: { error() {} }, Event: class { constructor(type) { this.type = type; } }, atob: s => Buffer.from(s, 'base64').toString(), setTimeout, clearTimeout, location: { origin: 'https://synthetic.example' }, _pecAuthSub: null,
    supabase: { auth, from: table => { reads.push(table); const chain = { select() { return chain; }, eq() { return chain; }, maybeSingle: async () => options.row ? options.row(table) : { data: table === 'admin_users' ? { id: 'row-' + current.user.id, auth_user_id: current.user.id, role: 'staff' } : {}, error: null } }; return chain; } },
    $: dom.get, syncWhatsNewSession() {}, ownerStudio: { sessionChanged() {} }, runScheduleStatusSync() {}, renderGlobalAuthGate: () => gates.push(!!state.session),
    fetch: async (...args) => { audits.push(args); return {}; },
    openModal(markup, options) { const nodes = new Map([...markup.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element(m[1])])); modal = { markup, options, nodes }; options.onMount({ querySelector: sel => nodes.get(sel.slice(1)) }); },
    closeModal() { modal = null; },
  });
  vm.runInContext(authSource, ctx, { filename: 'dashboard-auth-fixture.js' });
  return { ctx, state, reads, gates, audits, ...dom, auth, get modal() { return modal; }, setSession(s) { current = s; }, setAal(a) { aal = a; }, emit: (ev, s) => callback(ev, s), evaluate: code => vm.runInContext(code, ctx) };
}
function helpFixture({ loadSOPs = async () => {}, fetch: sendRequest, sops = [] } = {}) {
  const dom = baseDom(); const requests = []; const scope = [];
  dom.get('authGate').style.display = 'none'; dom.window.pecState = { session: session(), adminUser: { id: 'staff-row-a', role: 'staff', company: null }, view: 'dashboard', openJobId: 'PRIVATE-JOB-ID' };
  const ctx = vm.createContext({ ...dom, AbortController, MutationObserver: class { observe() {} }, setTimeout, CONFIG: { SOP_CHAT_ENDPOINT: '/synthetic-help' }, loadSOPs,
    getAccessibleSOPs: staff => { scope.push(staff); return sops; },
    fetch: async (url, args) => { requests.push({ ...args, body: JSON.parse(args.body) }); return sendRequest ? sendRequest(url, args) : { ok: true, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'Synthetic reply.' }] }) }; },
  });
  vm.runInContext(helpSource, ctx, { filename: 'dashboard-help-fixture.js' });
  return { ...dom, requests, scope, ctx, async send(text) { dom.get('pecHelpInput').value = text; return dom.get('pecHelpSend').click(); }, changeAccount(uid) { dom.window.pecState.session = uid ? session(uid, 'session-' + uid) : null; dom.window.pecState.adminUser = uid ? { id: 'staff-row-' + uid, role: 'staff', company: 'PEC' } : null; dom.window.dispatchEvent({ type: 'pec-auth-changed' }); } };
}

test('MFA error fields, exceptions and malformed responses never mean unenrolled', async () => {
  const invalid = [null, {}, { data: null }, { error: { message: 'offline' } }, { data: { currentLevel: 'aal1' } }, { data: { currentLevel: 'aal0', nextLevel: 'aal1' } }];
  for (const value of invalid) await assert.rejects(authFixture({ assurance: async () => value }).ctx.pecReadMfaState());
  for (const value of [null, {}, { data: {} }, { error: { message: 'offline' } }, { data: { all: [], totp: [{}] } }, { data: { all: [null], totp: [] } }]) await assert.rejects(authFixture({ factors: async () => value }).ctx.pecReadMfaState());
  await assert.rejects(authFixture({ assurance: async () => { throw new Error('offline'); } }).ctx.pecReadMfaState());
  await assert.rejects(authFixture({ factors: async () => { throw new Error('offline'); } }).ctx.pecReadMfaState());
});
test('valid unenrolled/disabled factors pass; inconsistent required factor fails closed', async () => {
  assert.equal(await authFixture({ enrolled: false }).ctx.pecMfaLoginChallenge(), true);
  const unverified = { ...factor, status: 'unverified' };
  assert.equal(await authFixture({ enrolled: false, factors: async () => ({ data: { all: [unverified], totp: [] } }) }).ctx.pecMfaLoginChallenge(), true);
  await assert.rejects(authFixture({ factors: async () => ({ data: { all: [], totp: [] } }) }).ctx.pecReadMfaState());
});
test('verification status failure stays locked and offers working retry/cancel', async () => {
  let failed = true;
  const x = authFixture({ enrolled: false, assurance: async () => failed ? { error: 'offline' } : { data: { currentLevel: 'aal1', nextLevel: 'aal1' } } });
  const result = x.ctx.pecMfaLoginChallenge(); await settle();
  assert.ok(x.modal.nodes.has('mfaRetry')); assert.equal(x.modal.options.closeButton, false); assert.equal(x.state.session, null);
  failed = false; await x.modal.nodes.get('mfaRetry').click(); assert.equal(await result, true);
  failed = true; const cancelled = x.ctx.pecMfaLoginChallenge(); await settle(); await x.modal.nodes.get('mfaRetryCancel').click(); assert.equal(await cancelled, false);
});
test('native sign-in event cannot render/read staff data before the enrolled factor succeeds', async () => {
  const x = authFixture(); x.ctx.wireAuthListener();
  const login = x.ctx.passwordSignIn('synthetic@example.test', 'synthetic-password'); await settle();
  assert.equal(x.state.session, null); assert.equal(x.reads.length, 0); assert.ok(x.modal.nodes.has('mfaChalVerify'));
  x.modal.nodes.get('mfaChalCode').value = '123456'; await x.modal.nodes.get('mfaChalVerify').click(); await login;
  assert.equal(x.state.session.user.id, 'staff-a'); assert.equal(x.state.adminUser.id, 'row-staff-a');
  assert.ok(x.frameMessages.includes('pec-auth-ready')); assert.equal(x.audits.length, 1);
});
test('restored enrolled sessions are gated before staff reads and cancel signs out locally', async () => {
  const x = authFixture(); const boot = x.ctx.initAuth(); await settle();
  assert.equal(x.reads.length, 0); assert.equal(x.state.session, null);
  await x.modal.nodes.get('mfaChalCancel').click(); await boot;
  assert.equal(x.state.session, null); assert.equal(x.reads.length, 0); assert.match(x.get('authGateError').textContent, /sign in again/);
});
test('challenge errors/exceptions/malformed success support retry without granting access', async () => {
  let result = { error: { message: 'bad code' } };
  const x = authFixture({ verify: async () => { if (result instanceof Error) throw result; return result; } });
  const challenge = x.ctx.pecMfaLoginChallenge(); await settle();
  const modal = x.modal; modal.nodes.get('mfaChalCode').value = '123456';
  for (const bad of [result, new Error('offline'), {}, { data: {} }, { data: { access_token: 'synthetic' } }]) {
    result = bad; await modal.nodes.get('mfaChalVerify').click(); assert.ok(modal.nodes.get('mfaChalMsg').textContent); assert.equal(modal.nodes.get('mfaChalVerify').disabled, false); assert.equal(x.state.session, null);
  }
  await modal.nodes.get('mfaChalCancel').click(); assert.equal(await challenge, false);
});
test('same-session token refresh preserves the active UI, but same-user new session/downgrade rechecks', async () => {
  const x = authFixture({ aal: 'aal2', session: session('staff-a', 'session-a', 'aal2') });
  x.ctx.wireAuthListener(); x.state.session = session('staff-a', 'session-a', 'aal2'); x.state.adminUser = { id: 'row-a' };
  assert.equal(x.emit('TOKEN_REFRESHED', session('staff-a', 'session-a', 'aal2')), undefined); assert.equal(x.gates.length, 0);
  const next = session('staff-a', 'session-b', 'aal1'); x.setSession(next); x.setAal('aal1');
  x.emit('SIGNED_IN', next); assert.equal(x.state.session, null); assert.equal(x.state.adminUser, null); await settle();
  assert.ok(x.modal.nodes.has('mfaChalVerify')); assert.equal(x.reads.length, 0); await x.modal.nodes.get('mfaChalCancel').click(); await settle();
});
test('late assurance and role lookup cannot restore a cleared/account-changed identity', async () => {
  const wait = deferred(); const x = authFixture({ assurance: () => wait.promise });
  const epoch = x.ctx.pecClearAuthIdentity(); const pending = x.ctx.pecAcceptAuthSession(session(), epoch); x.ctx.pecClearAuthIdentity();
  wait.resolve({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } }); await pending;
  assert.equal(x.state.session, null); assert.equal(x.reads.length, 0); assert.equal(x.modal, null);
  const row = deferred(); const y = authFixture({ enrolled: false, row: () => row.promise });
  const accepted = y.ctx.pecAcceptAuthSession(session(), y.ctx.pecClearAuthIdentity()); await settle(); y.ctx.pecClearAuthIdentity();
  row.resolve({ data: { id: 'old-row' }, error: null }); await accepted; assert.equal(y.state.adminUser, null); assert.equal(y.state.session, null);
});
test('same-user replacement during assurance validation cannot reuse an old proof', async () => {
  const wait = deferred(); const x = authFixture({ session: session('staff-a', 'old', 'aal2'), assurance: () => wait.promise });
  const pending = x.ctx.pecAcceptAuthSession(session('staff-a', 'old', 'aal2'), x.ctx.pecClearAuthIdentity());
  x.setSession(session('staff-a', 'new', 'aal1')); wait.resolve({ data: { currentLevel: 'aal2', nextLevel: 'aal2' } }); await pending;
  assert.equal(x.state.session, null); assert.equal(x.reads.length, 0);
});
test('signout clears iframe identity and staff UI synchronously before signOut resolves', async () => {
  const wait = deferred(); const x = authFixture({ signOut: () => wait.promise }); x.state.session = session(); x.state.adminUser = { id: 'row-a' };
  const pending = x.ctx.signOut(); assert.equal(x.frameMessages[0], 'pec-auth-cleared'); assert.equal(x.state.session, null); assert.equal(x.state.adminUser, null);
  wait.resolve(); await pending;
});
test('Help follows navigation on every request, preserves follow-ups, omits raw record identifiers and full prompts', async () => {
  const x = helpFixture({ sops: [{ id: 'PEC-OPS-001', title: 'Grinding', company: 'PEC', department: 'Ops', content: 'Use the grinder for preparation.' }] });
  await x.send('How do I use the grinder?'); x.window.pecState.view = 'invoices'; await x.send('Where do I find this page?');
  assert.equal(x.requests[0].body.page.view, 'dashboard'); assert.equal(x.requests[1].body.page.view, 'invoices'); assert.equal(x.requests[1].body.messages.length, 3);
  assert.equal(x.requests[0].body.sops[0].id, 'PEC-OPS-001'); assert.equal(x.scope[0].company, 'both');
  assert.doesNotMatch(JSON.stringify(x.requests[0].body), /PRIVATE-JOB-ID|staff-a|staff-row-a|model|max_tokens|system/);
});
test('Help captures page after slow library load and ignores concurrent Enter/send', async () => {
  const wait = deferred(); const x = helpFixture({ loadSOPs: () => wait.promise }); const pending = x.send('Where am I?');
  x.window.pecState.view = 'calendar'; x.get('pecHelpInput').value = 'duplicate'; x.get('pecHelpInput').handlers.keydown({ key: 'Enter', preventDefault() {} });
  wait.resolve(); await pending; assert.equal(x.requests.length, 1); assert.equal(x.requests[0].body.page.view, 'calendar');
});
test('Help account switch clears history/DOM and aborts/ignores the previous late reply', async () => {
  const wait = deferred(); let count = 0; const x = helpFixture({ fetch: async () => ++count === 1 ? wait.promise : { ok: true, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'New account reply' }] }) } });
  const old = x.send('Private old account question'); await settle(); x.changeAccount('staff-b'); assert.equal(x.requests[0].signal.aborted, true); assert.equal(x.get('pecHelpMessages').children.length, 0);
  await x.send('New account question'); wait.resolve({ ok: true, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'Private late reply' }] }) }); await old;
  assert.equal(x.requests[1].body.messages.length, 1); assert.doesNotMatch(x.get('pecHelpMessages').children.map(x => x.textContent).join(' '), /Private/);
});
test('Help bounds history/SOP data and permits retry after malformed provider replies', async () => {
  const sops = Array.from({ length: 20 }, (_, i) => ({ id: `PEC-${i}`, title: 'Grinding', content: 'grinder '.repeat(5000) }));
  const x = helpFixture({ sops }); for (let i = 0; i < 18; i++) await x.send('How do I use the grinder? ' + 'x'.repeat(1000));
  const body = x.requests.at(-1).body; assert.ok(body.messages.length <= 12); assert.ok(body.messages.reduce((n, m) => n + m.content.length, 0) <= 16000); assert.ok(JSON.stringify(body.sops).length < 7100);
  let ok = false; const y = helpFixture({ fetch: async () => ({ ok: true, text: async () => ok ? JSON.stringify({ content: [{ type: 'text', text: 'Fixed reply' }] }) : 'invalid' }) });
  await y.send('First question'); ok = true; await y.send('Retry question'); assert.equal(y.requests[1].body.messages.length, 1); assert.equal(y.get('pecHelpSend').disabled, false);
});
test('legacy SOP chat resets identity, uses current permissions and ignores old replies', async () => {
  const dom = baseDom(), wait = deferred(), requests = [], profiles = [];
  dom.window.pecState = { session: session(), adminUser: { role: 'admin', company: 'both' } };
  const ctx = vm.createContext({ ...dom, AbortController, $: dom.get, CONFIG: { SOP_CHAT_ENDPOINT: '/synthetic-help' },
    getAccessibleSOPs(profile) { profiles.push(profile); return profile ? [{ id: 'PEC-001', title: 'Grinding', content: 'Use grinder', company: 'PEC' }] : [{ id: 'OWNER-001', title: 'Owner grinder', content: 'Owner grinder reference' }]; },
    fetch: async (url, args) => { requests.push({ ...args, body: JSON.parse(args.body) }); return requests.length === 1 ? wait.promise : { ok: true, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'New staff reply' }] }) }; },
  });
  vm.runInContext('let sopChatHistory = [], sopSystemPrompt = "";\n' + section('let sopChatIdentity =', '\nfunction renderSOPChatWelcome'), ctx);
  dom.window.dispatchEvent({ type: 'pec-auth-changed' });
  dom.get('sopChatInputOwner').value = 'Old account grinder question'; const old = ctx.sendSOPChat('owner'); await settle();
  dom.window.pecState = { session: session('staff-b', 'session-b'), adminUser: { role: 'staff', company: null } }; dom.window.dispatchEvent({ type: 'pec-auth-changed' });
  assert.equal(requests[0].signal.aborted, true); assert.equal(dom.get('sopChatMessagesOwner').children.length, 0);
  dom.get('sopChatInputOwner').value = 'New account grinder question'; await ctx.sendSOPChat('owner');
  assert.equal(profiles[1].role, 'staff'); assert.equal(profiles[1].company, 'both'); assert.equal(requests[1].body.messages.length, 1);
  assert.match(requests[1].body.system, /=== AVAILABLE SOPs ===/); assert.match(requests[1].body.system, /PEC-001/); assert.doesNotMatch(requests[1].body.system, /OWNER-001/);
  wait.resolve({ ok: true, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'Old private reply' }] }) }); await old;
  assert.doesNotMatch(dom.get('sopChatMessagesOwner').children.map(x => x.textContent).join(' '), /Old private reply/);
});
