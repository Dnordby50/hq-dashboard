import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import { loadCatalog, type Catalog } from './lib/catalog';
import EstimatorScreen from './features/estimator/EstimatorScreen';

type State =
  | { phase: 'loading' }
  | { phase: 'signed-out' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; catalog: Catalog };

export default function App() {
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    let alive = true;
    (async () => {
      // SSO: the session is shared with the dashboard (same origin + storageKey).
      const { data: sess } = await supabase.auth.getSession();
      if (!alive) return;
      if (!sess.session) {
        setState({ phase: 'signed-out' });
        return;
      }
      try {
        const catalog = await loadCatalog();
        if (!alive) return;
        setState({ phase: 'ready', catalog });
      } catch (e) {
        if (!alive) return;
        const message = e instanceof Error ? e.message : String(e);
        setState({ phase: 'error', message });
      }
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
        <p><a href="/">Go to dashboard</a></p>
      </Centered>
    );
  if (state.phase === 'error')
    return (
      <Centered>
        <p>Could not load the catalog.</p>
        <p className="muted">{state.message}</p>
        <p><a href="/">Back to dashboard</a></p>
      </Centered>
    );
  return <EstimatorScreen catalog={state.catalog} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="centered">{children}</div>;
}
