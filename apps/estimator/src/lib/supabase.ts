import { createClient } from '@supabase/supabase-js';

// Same Supabase project and the same DEFAULT storageKey as the dashboard
// (sb-<ref>-auth-token). Because the estimator is served from the SAME origin,
// a user already signed into the dashboard is authenticated here with no second
// login, and the same is_admin_staff() RLS applies. The URL + anon key are
// public by design (RLS-protected); they are the same values the dashboard
// hardcodes. Netlify build env can override them via VITE_SUPABASE_*.
const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || 'https://zdfpzmmrgotynrwkeakd.supabase.co';
const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpkZnB6bW1yZ290eW5yd2tlYWtkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2NjA0NTEsImV4cCI6MjA5MjIzNjQ1MX0.kpZvbMhFEU8MtPa78k2xEbSdrdaW52NE6r9FLwDtn2I';

// 8s abort on auth requests, mirroring the dashboard's timedFetch, so a stalled
// /auth/v1 refresh can never hang the app. The estimator is a SEPARATE page from
// the dashboard, so there is no concurrent auth client to wedge against; per
// CLAUDE.md we use the default navigator.locks lock + auto-refresh here.
const timedFetch: typeof fetch = (input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (!/\/auth\/v1\//.test(url)) return fetch(input, init);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  global: { fetch: timedFetch },
});
