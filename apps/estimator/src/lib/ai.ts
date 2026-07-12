import { supabase } from './supabase';
import type { CompsResult } from './comps';

// Client half of the AI price recommendation (netlify/functions/
// pec-estimate-ai.cjs). The AI NEVER sets the price; it returns a recommended
// range plus a why, and the rep decides. Called automatically (debounced in
// EstimatorScreen) once system type and sqft are both present.

export type AiRecommendation = {
  recommended_low: number;
  recommended_high: number;
  why: string;
  // Customer-intent read from Quo (OpenPhone) history: calls, transcripts,
  // texts. Null when there is no history; history_available is set SERVER-SIDE
  // (never model-claimed) so "no call history on file" is a fact, not a vibe.
  intent_read?: string | null;
  history_available?: boolean;
  model?: string;
  generated_at?: string;
  inputs_key?: string;
};

export type AiRequest = {
  estimate_id: string | null; // set when editing: lets the server serve/refresh the row cache
  // The lead behind this estimate (null for a walk-up): the server pulls its
  // Quo call/text history as intent signal for the price read.
  lead_id: string | null;
  inputs_key: string;
  system_type_name: string;
  sqft: number;
  mvb: 'none' | 'addon' | 'standalone';
  calc_price: number;
  target_gp_pct: number;
  comps: {
    rule: string;
    rule_label: string;
    sample_size: number;
    median_ppsf: number | null;
    rows: Array<{ sqft: number | null; price: number | null; ppsf: number | null; gp_pct: number | null }>;
  };
};

export function compsForAi(comps: CompsResult, ruleLabel: string): AiRequest['comps'] {
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

export async function fetchAiRecommendation(req: AiRequest): Promise<AiRecommendation> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');
  const res = await fetch('/.netlify/functions/pec-estimate-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(req),
  });
  let body: { success?: boolean; error?: string; recommendation?: AiRecommendation } = {};
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok || !body.success || !body.recommendation) {
    throw new Error(body.error || `AI request failed (${res.status})`);
  }
  return body.recommendation;
}
