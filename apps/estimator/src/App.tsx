import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import { getCachedCatalog, loadCatalog, type Catalog } from './lib/catalog';
import { drainOutbox } from './offline/sync';
import EstimatorScreen from './features/estimator/EstimatorScreen';

type State =
  | { phase: 'loading' }
  | { phase: 'signed-out' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; catalog: Catalog; createdBy: string | null; fromCache: boolean };

export default function App() {
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: sess } = await supabase.auth.getSession();
      if (!alive) return;
      if (!sess.session) {
        setState({ phase: 'signed-out' });
        return;
      }
      const createdBy = sess.session.user?.id ?? null;

      let catalog: Catalog | undefined;
      let fromCache = false;
      try {
        // Online path also refreshes the offline cache.
        catalog = await loadCatalog();
      } catch (e) {
        // Offline or query failed: fall back to the last cached catalog so the
        // estimator still works at a job site with no signal.
        const cached = await getCachedCatalog();
        if (cached) {
          catalog = cached;
          fromCache = true;
        } else {
          if (!alive) return;
          const message = e instanceof Error ? e.message : String(e);
          setState({ phase: 'error', message });
          return;
        }
      }
      if (!alive || !catalog) return;
      setState({ phase: 'ready', catalog, createdBy, fromCache });

      // Best-effort: push anything queued from a previous offline session.
      if (navigator.onLine) drainOutbox().catch(() => {});
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (state.phase === 'loading') return <Centered>Loading…</Centered>;
  if (state.phase === 'signed-out')
    return (
      <Centered>
        <p>Please sign in on the dashboard first, then reopen the estimator.</p>
        <p>
          <a href="/">Go to dashboard</a>
        </p>
      </Centered>
    );
  if (state.phase === 'error')
    return (
      <Centered>
        <p>Could not load the catalog. Open it once online to enable offline use.</p>
        <p className="muted">{state.message}</p>
        <p>
          <a href="/">Back to dashboard</a>
        </p>
      </Centered>
    );
  return <EstimatorScreen catalog={state.catalog} createdBy={state.createdBy} catalogFromCache={state.fromCache} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="centered">{children}</div>;
}
