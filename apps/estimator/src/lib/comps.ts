import { supabase } from './supabase';
import {
  buildComps as _buildComps,
  compsRuleLabel as _compsRuleLabel,
  compsGpCaveat as _compsGpCaveat,
  joinCompsSources,
} from '../../../../production/comps.js';
import { buildCostAggregates } from '../../../../production/costing.js';

// Comps for the pricing intelligence panel. The RULES live in the canonical
// repo-root production/comps.js (pure, test-covered); this module only fetches
// the source tables and joins them. Comps render instantly from these rows
// with NO model call, so the numbers are never gated behind an API.
//
// public.jobs and pec_prod_jobs are sibling tables (CLAUDE.md); actual GP only
// exists for jobs that bridge via dripjobs_deal_id. GP% comes from the ONE
// canonical formula (production/costing.js computeCostingRow), fed by the same
// child tables the Job Costing tab reads: material lines (used materials),
// bonuses, BusyBusy/manual crew hours, and crew wages. All five are readable
// by every logged-in rep (RLS is is_admin_staff() with no permission gate) and
// tiny at current volume (a few hundred rows total); bound these reads by date
// if the tables ever grow past a few thousand rows.

export type CompCandidate = ReturnType<typeof joinCompsSources>[number];
export type CompsResult = ReturnType<typeof _buildComps>;

export const buildComps = _buildComps;
export const compsRuleLabel = _compsRuleLabel;
export const compsGpCaveat: (comps: CompsResult) => string | null = _compsGpCaveat;

// A failed costing-detail read must never blank the comps table: each of the
// five aggregate sources degrades independently to an empty list (that job's
// GP% just renders as a dash), same posture as the dashboard's Metrics tab.
const rowsOrEmpty = async (q: PromiseLike<{ data: unknown[] | null; error: unknown }>): Promise<unknown[]> => {
  try {
    const res = await q;
    return res.error ? [] : (res.data ?? []);
  } catch {
    return [];
  }
};

export async function loadCompCandidates(): Promise<CompCandidate[]> {
  const [jobsRes, prodRes, costRes, materialLines, bonuses, timeEntries, crewMembers, manualLabor] = await Promise.all([
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
    rowsOrEmpty(supabase.from('pec_prod_material_lines').select('job_id,line_cost,actual_used_qty,unit_cost_snapshot')),
    rowsOrEmpty(supabase.from('pec_prod_job_bonuses').select('job_id,amount')),
    rowsOrEmpty(supabase.from('pec_prod_busybusy_time_entries').select('job_id,crew_member_id,hours,wage_type,is_overhead')),
    rowsOrEmpty(supabase.from('pec_prod_crew_members').select('id,hourly_wage')),
    rowsOrEmpty(supabase.from('pec_prod_job_manual_labor').select('job_id,crew_member_id,hours,ot_hours')),
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
  const aggregates = buildCostAggregates({
    materialLines,
    bonuses,
    timeEntries,
    crewMembers,
    manualLabor,
    costings: costRes.data ?? [],
  });
  return joinCompsSources(jobs, prodRes.data ?? [], costRes.data ?? [], aggregates);
}
