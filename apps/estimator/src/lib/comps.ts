import { supabase } from './supabase';
import {
  buildComps as _buildComps,
  compsRuleLabel as _compsRuleLabel,
  joinCompsSources,
} from '../../../../production/comps.js';

// Comps for the pricing intelligence panel. The RULES live in the canonical
// repo-root production/comps.js (pure, test-covered); this module only fetches
// the three source tables and joins them. Comps render instantly from these
// rows with NO model call, so the numbers are never gated behind an API.
//
// public.jobs and pec_prod_jobs are sibling tables (CLAUDE.md); actual GP only
// exists for jobs that bridge via dripjobs_deal_id to a costing row. ~35 rows
// total, so fetching all three sources once per session is trivial.

export type CompCandidate = ReturnType<typeof joinCompsSources>[number];
export type CompsResult = ReturnType<typeof _buildComps>;

export const buildComps = _buildComps;
export const compsRuleLabel = _compsRuleLabel;

export async function loadCompCandidates(): Promise<CompCandidate[]> {
  const [jobsRes, prodRes, costRes] = await Promise.all([
    supabase
      .from('jobs')
      .select('id,system_type_id,sqft,price,completed_date,dripjobs_deal_id,customers(name)')
      .not('completed_date', 'is', null)
      .is('archived_at', null)
      .is('voided_at', null),
    supabase.from('pec_prod_jobs').select('id,dripjobs_deal_id').not('dripjobs_deal_id', 'is', null),
    supabase
      .from('pec_prod_job_costing')
      .select('job_id,materials_ordered_cost,materials_used_cost,equipment_rental_cost,salary_wages_cost,subcontractor_cost,misc_cost,bonus_cost,commission_cost'),
  ]);
  const firstError = jobsRes.error || prodRes.error || costRes.error;
  if (firstError) throw firstError;

  // Flatten the embedded customers(name) into the customer_name field the
  // comps engine expects.
  const jobs = (jobsRes.data ?? []).map((j) => {
    const row = j as Record<string, unknown>;
    const cust = row.customers as { name?: string | null } | { name?: string | null }[] | null;
    const name = Array.isArray(cust) ? cust[0]?.name : cust?.name;
    return { ...row, customer_name: name ?? null };
  });
  return joinCompsSources(jobs, prodRes.data ?? [], costRes.data ?? []);
}
