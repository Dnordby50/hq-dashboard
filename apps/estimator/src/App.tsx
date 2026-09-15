import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import { assertAccount, captureAccount, onAccountChange, setAccount, type AccountScope } from './offline/account';
import { hasLegacyOfflineWork } from './offline/idb';
import { verifyOfflineAccess, verifyOnlineAccess } from './offline/access';
import type { Session } from '@supabase/supabase-js';
import { getCachedCatalog, loadCatalog, type Catalog } from './lib/catalog';
import { drainOutbox } from './offline/sync';
import { embedFromUrl, estimateIdFromUrl, focusLineFromUrl, leadIdFromUrl, loadLeadLink, type LeadLink } from './lib/lead';
import { loadEstimateForEdit, type LoadedEstimate } from './lib/estimateLoad';
import EstimatorScreen from './features/estimator/EstimatorScreen';

type State =
  | { phase: 'loading' }
  | { phase: 'signed-out' }
  | { phase: 'error'; message: string }
  | {
      phase: 'ready';
      account: AccountScope;
      legacyWork: boolean;
      catalog: Catalog;
      createdBy: string | null;
      viewerIsAdmin: boolean;
      fromCache: boolean;
      leadLink: LeadLink | null;
      editing: LoadedEstimate | null;
    };

export default function App() {
  const [state, setState] = useState<State>({ phase: 'loading' });
  // ?embed=1: opened inside the dashboard's iframe modal. Constant for the
  // page's lifetime, so read once.
  const embed = embedFromUrl();

  useEffect(() => {
    let alive = true;
    let loading: AccountScope | null = null;
    let authRevision = 0;
    let parentBlocked = false;
    const changed = onAccountChange(() => {
      if (alive) setState({ phase: 'signed-out' });
    });
    const load = async (account: AccountScope) => {
      const current = () => { assertAccount(account); if (!alive) throw new Error('Estimator closed'); };
      setState({ phase: 'loading' });
      let viewerIsAdmin = false;
      try {
        if (navigator.onLine) viewerIsAdmin = (await verifyOnlineAccess(account)).role === 'admin';
        else await verifyOfflineAccess(account);
      } catch (error) {
        // A server denial clears the scope. A network outage can use only
        // this account's previously loaded catalog, with admin controls locked.
        current();
        await verifyOfflineAccess(account);
      }
      current();
      let catalog: Catalog | undefined;
      let fromCache = false;
      try {
        if (!navigator.onLine) throw new Error('Reconnect once to load this account’s estimator catalog.');
        catalog = await loadCatalog();
      } catch (error) {
        current();
        catalog = await getCachedCatalog();
        fromCache = true;
        if (!catalog) throw error;
      }
      current();
      let editing: LoadedEstimate | null = null;
      const editId = estimateIdFromUrl();
      if (editId) {
        editing = await loadEstimateForEdit(editId);
        current();
        if (!editing) throw new Error('Estimate not found (it may have been deleted or not synced yet).');
      }
      const leadLink = await loadLeadLink(editing?.leadId ?? leadIdFromUrl());
      current();
      const legacyWork = await hasLegacyOfflineWork().catch(() => false);
      current();
      setState({ phase: 'ready', account, legacyWork, catalog, createdBy: account.ownerId, viewerIsAdmin, fromCache, leadLink, editing });
      if (navigator.onLine) drainOutbox({ account }).catch(() => {});
    };
    const acceptSession = (session: Session | null) => {
      if (!alive || parentBlocked) return;
      // Synchronous invalidation matters: do not leave the old screen/drain
      // authorized while waiting for the auth callback's lock to be released.
      const account = setAccount(session);
      if (!account) { loading = null; setState({ phase: 'signed-out' }); return; }
      if (loading === account) return;
      loading = account;
      // Auth callbacks must not await Supabase calls under the auth lock.
      setTimeout(() => {
        if (!alive) return;
        try { assertAccount(account); } catch { return; }
        load(account).catch(error => {
          if (!alive) return;
          try { assertAccount(account); } catch { return; }
          setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
        });
      }, 0);
    };
    const subscription = supabase.auth.onAuthStateChange((_event, session) => { authRevision++; acceptSession(session); });
    const initialRevision = authRevision;
    supabase.auth.getSession().then(({ data, error }) => {
      if (authRevision !== initialRevision) return;
      if (error) acceptSession(null);
      else acceptSession(data.session);
    }).catch(() => { if (authRevision === initialRevision) acceptSession(null); });
    const recheck = () => {
      if (!navigator.onLine) return;
      let account: AccountScope;
      try { account = captureAccount(); } catch { return; }
      verifyOnlineAccess(account).catch(() => {});
    };
    const parentCleared = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      if (event.data?.type === 'pec-auth-cleared') {
        parentBlocked = true;
        authRevision++;
        loading = null;
        setAccount(null);
      } else if (event.data?.type === 'pec-auth-ready') {
        parentBlocked = false;
        const revision = ++authRevision;
        supabase.auth.getSession().then(({ data }) => {
          if (revision === authRevision) acceptSession(data.session);
        }).catch(() => {});
      }
    };
    window.addEventListener('message', parentCleared);
    window.addEventListener('online', recheck);
    window.addEventListener('focus', recheck);
    const interval = window.setInterval(recheck, 60000);
    return () => {
      alive = false;
      subscription.data.subscription.unsubscribe();
      changed();
      window.removeEventListener('message', parentCleared);
      window.removeEventListener('online', recheck);
      window.removeEventListener('focus', recheck);
      window.clearInterval(interval);
      setAccount(null);
    };
  }, []);

  if (state.phase === 'loading') return <Centered>Loading…</Centered>;
  if (state.phase === 'signed-out')
    return (
      <Centered>
        <p>Please sign in on the dashboard first, then reopen the estimator.</p>
        {!embed && (
          <p>
            <a href="/">Go to dashboard</a>
          </p>
        )}
      </Centered>
    );
  if (state.phase === 'error')
    return (
      <Centered>
        <p>Could not load the estimator.</p>
        <p className="muted">{state.message}</p>
        {!embed && (
          <p>
            <a href="/">Back to dashboard</a>
          </p>
        )}
      </Centered>
    );
  return (
    <>
    {state.legacyWork && <p className="muted" role="status">Older offline drafts are preserved on this device. Ask Dylan to verify their owner before recovery. Keep this browser’s saved data until they are recovered.</p>}
    <EstimatorScreen
      key={state.account.generation}
      account={state.account}
      catalog={state.catalog}
      createdBy={state.createdBy}
      viewerIsAdmin={state.viewerIsAdmin}
      catalogFromCache={state.fromCache}
      leadLink={state.leadLink}
      embed={embed}
      editing={state.editing}
      focusLine={focusLineFromUrl()}
    />
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="centered">{children}</div>;
}
