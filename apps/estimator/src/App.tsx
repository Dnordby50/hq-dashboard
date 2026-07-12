import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import { getCachedCatalog, loadCatalog, type Catalog } from './lib/catalog';
import { drainOutbox } from './offline/sync';
import { embedFromUrl, estimateIdFromUrl, leadIdFromUrl, loadLeadLink, type LeadLink } from './lib/lead';
import { loadEstimateForEdit, type LoadedEstimate } from './lib/estimateLoad';
import EstimatorScreen from './features/estimator/EstimatorScreen';

type State =
  | { phase: 'loading' }
  | { phase: 'signed-out' }
  | { phase: 'error'; message: string }
  | {
      phase: 'ready';
      catalog: Catalog;
      createdBy: string | null;
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

      // ?estimate_id=<uuid>: the estimate page's Edit button. Loading the row
      // is a hard requirement for edit mode (unlike the lead link below), so a
      // failure surfaces instead of silently opening a blank new estimate.
      let editing: LoadedEstimate | null = null;
      const editId = estimateIdFromUrl();
      if (editId) {
        try {
          editing = await loadEstimateForEdit(editId);
          if (!editing) {
            if (!alive) return;
            setState({ phase: 'error', message: 'Estimate not found (it may have been deleted or not synced yet).' });
            return;
          }
        } catch (e) {
          if (!alive) return;
          setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
          return;
        }
      }

      // The dashboard's lead detail "Start estimate" button lands here as
      // /estimator/?lead_id=<uuid>. Resolving the contact block is best effort
      // (see lib/lead.ts); a failed lookup still attaches the estimate.
      const leadLink = await loadLeadLink(editing?.leadId ?? leadIdFromUrl());

      if (!alive || !catalog) return;
      setState({ phase: 'ready', catalog, createdBy, fromCache, leadLink, editing });

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
    <EstimatorScreen
      catalog={state.catalog}
      createdBy={state.createdBy}
      catalogFromCache={state.fromCache}
      leadLink={state.leadLink}
      embed={embed}
      editing={state.editing}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="centered">{children}</div>;
}
