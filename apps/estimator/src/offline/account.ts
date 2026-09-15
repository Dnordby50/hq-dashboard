// A browser account boundary, not a replacement for server authorization.
// Every asynchronous operation captures a scope before its first await. A new
// login/session invalidates that scope even if the same user signs in again.
export type AccountScope = { readonly ownerId: string; readonly sessionId: string; readonly assurance: string; readonly generation: number; readonly signal: AbortSignal };
type LocalSession = { user: { id: string }; access_token: string };
let active: AccountScope | null = null;
let controller: AbortController | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function claims(token: string): { session_id?: string; aal?: string } {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); }
  catch { return {}; }
}
function sessionId(token: string): string { return String(claims(token).session_id || ''); }
export function setAccount(session: LocalSession | null): AccountScope | null {
  const ownerId = session?.user.id;
  const id = session ? sessionId(session.access_token) : '';
  const assurance = session ? String(claims(session.access_token).aal || '') : '';
  if (ownerId && id && active?.ownerId === ownerId && active.sessionId === id && active.assurance === assurance) return active;
  controller?.abort();
  controller = null;
  active = null;
  generation++;
  if (ownerId && id) {
    controller = new AbortController();
    active = Object.freeze({ ownerId, sessionId: id, assurance, generation, signal: controller.signal });
  }
  for (const listener of listeners) listener();
  return active;
}
export function captureAccount(): AccountScope {
  if (!active || active.signal.aborted) throw new Error('Sign in again to continue. Your offline work has been kept.');
  return active;
}
export function assertAccount(scope: AccountScope): void {
  if (scope !== active || scope.signal.aborted) throw new Error('The account changed. Your offline work has been kept with its original account.');
}
export function matchesSession(scope: AccountScope, session: LocalSession | null): boolean {
  return !!session && session.user.id === scope.ownerId && sessionId(session.access_token) === scope.sessionId && String(claims(session.access_token).aal || '') === scope.assurance;
}
export function onAccountChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function accountDatabaseName(ownerId: string): string {
  return `pec-estimator-account-${encodeURIComponent(ownerId)}`;
}

// Remember observed denials even if this page is reopened without a network.
// This stores only a UID/session marker, never customer data or a credential.
const denied = new Set<string>();
function denialKey(scope: AccountScope) { return `pec-estimator-denied:${encodeURIComponent(scope.ownerId)}:${encodeURIComponent(scope.sessionId)}`; }
export function offlineAccessDenied(scope: AccountScope): boolean {
  const key = denialKey(scope);
  try { return denied.has(key) || localStorage.getItem(key) === '1'; } catch { return denied.has(key); }
}
export function blockAccount(scope: AccountScope): void {
  assertAccount(scope);
  const key = denialKey(scope);
  denied.add(key);
  try { localStorage.setItem(key, '1'); } catch { /* memory still blocks this page */ }
  setAccount(null);
}
export function clearAccountDenial(scope: AccountScope): void {
  assertAccount(scope);
  const key = denialKey(scope);
  denied.delete(key);
  try { localStorage.removeItem(key); } catch { /* an old persisted denial safely keeps offline access blocked */ }
}
