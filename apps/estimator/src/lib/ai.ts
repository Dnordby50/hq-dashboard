import { supabase } from './supabase';
import type { CompsResult } from './comps';

// Client half of the AI price recommendation (netlify/functions/
// pec-estimate-ai.cjs). The AI NEVER sets the price; it returns a recommended
// range plus a why, and the rep decides. Called automatically (debounced in
// EstimatorScreen) once system type and sqft are both present.

// One line's recommendation (prompt 70). confidence is a SERVER-computed fact
// (comps sample vs comps_min_sample), never model-claimed; a custom line is
// always no_comps and its why carries an explicit no-comparables statement.
export type AiLineRecommendation = {
  line_key: string;
  label: string | null;
  kind: 'calc' | 'custom';
  recommended_low: number;
  recommended_high: number;
  why: string;
  confidence: 'comps_backed' | 'thin_sample' | 'no_comps';
  confidence_label: string;
};

export type AiRecommendation = {
  // Per-line mode: the top-level range is the SUM of the line ranges
  // (server-derived) and `why` is the short job-level roll-up.
  recommended_low: number;
  recommended_high: number;
  why: string;
  lines?: AiLineRecommendation[];
  // Customer-intent read from Quo (OpenPhone) history: calls, transcripts,
  // texts. Null when there is no history; history_available is set SERVER-SIDE
  // (never model-claimed) so "no call history on file" is a fact, not a vibe.
  intent_read?: string | null;
  history_available?: boolean;
  model?: string;
  generated_at?: string;
  inputs_key?: string;
};

// One line of the per-line request (production/ai-lines.cjs shape). comps is
// null on custom lines BY DEFINITION (no system to hard-filter on).
export type AiLineInput = {
  line_key: string;
  kind: 'calc' | 'custom';
  label: string;
  system_type_id?: string | null;
  system_type_name?: string | null;
  sqft: number | null;
  mvb?: boolean;
  calc_price: number;
  target_gp_pct?: number | null;
  scope_text?: string | null;
  comps: AiRequest['comps'] | null;
};

export type AiRequest = {
  estimate_id: string | null; // set when editing: lets the server serve/refresh the row cache
  // The lead behind this estimate (null for a walk-up): the server pulls its
  // Quo call/text history as intent signal for the price read.
  lead_id: string | null;
  inputs_key: string;
  // Per-line mode (prompt 70): one entry per estimate line; sqft/calc_price
  // become the estimate totals and the legacy single-comps field is unused.
  lines?: AiLineInput[];
  system_type_name?: string;
  sqft: number;
  mvb?: 'none' | 'addon' | 'standalone';
  calc_price: number;
  target_gp_pct?: number;
  comps?: {
    rule: string;
    rule_label: string;
    sample_size: number;
    median_ppsf: number | null;
    rows: Array<{ sqft: number | null; price: number | null; ppsf: number | null; gp_pct: number | null }>;
  };
};

export function compsForAi(comps: CompsResult, ruleLabel: string): NonNullable<AiRequest['comps']> {
  return {
    rule: comps.rule,
    rule_label: ruleLabel,
    sample_size: comps.sample_size,
    median_ppsf: comps.median_ppsf,
    // Strip customer names before the payload leaves the client; the model
    // only needs the numbers.
    rows: comps.rows.map((r) => ({ sqft: r.sqft, price: r.price, ppsf: r.ppsf, gp_pct: r.gp_pct })),
  };
}

// Returns null when the read is turned off in Settings (estimate_ai_enabled):
// a clean disabled state, not an error.
export async function fetchAiRecommendation(req: AiRequest): Promise<AiRecommendation | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');
  const res = await fetch('/.netlify/functions/pec-estimate-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(req),
  });
  let body: { success?: boolean; disabled?: boolean; error?: string; recommendation?: AiRecommendation } = {};
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  if (res.ok && body.success && body.disabled) return null;
  if (!res.ok || !body.success || !body.recommendation) {
    throw new Error(body.error || `AI request failed (${res.status})`);
  }
  return body.recommendation;
}
