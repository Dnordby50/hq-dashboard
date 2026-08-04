// PEC canonical job-costing GP formula (prompt 66 Part C). Pure functions, no
// Supabase, no DOM, same posture as calculator.js: the estimator PWA imports
// this directly, index.html carries a byte-identical mirror of
// computeCostingRow (no bundler on the dashboard), and the test harness
// drives the same code. This is the ONE GP formula for the whole product: the
// Job Costing tab, Metrics' GP-by-crew card, and the estimator's comps panel
// all derive GP from computeCostingRow, so they can never disagree.
//
// Inputs:
//   job      { revenue } (plus id/actual_hours on the dashboard)
//   cost     the pec_prod_job_costing row (or null)
//   derivedOrderedCost  sum(pec_prod_material_lines.line_cost) for the job
//   derivedUsedCost     sum(actual_used_qty * unit_cost_snapshot) for the job
//   derivedBonusCost    sum(pec_prod_job_bonuses.amount) for the job
//   derived  { laborCost, actHrs, pendingBonus, estimate } - loaded crew labor
//            (computeCrewBonus's actualLabor incl. burden), actual hours, the
//            suggested-but-unapproved bonus pool, and the shared job estimate
//            ({ budgetedHours, laborBudget }); all optional.

// Keep byte-identical with the computeCostingRow mirror in index.html (the
// dashboard loads over file:// in some paths and cannot import ESM from
// production/, so it carries a hand-mirrored copy, same convention as the
// production/calculator.js mirrors).
export function computeCostingRow(job, cost, sysName, derivedOrderedCost, derivedUsedCost, derivedBonusCost, derived = {}) {
  const c = cost || {};
  const revenue = Number(job.revenue || 0);
  // Estimated hours + labor budget come from the ONE shared estimate (the same
  // window.computeJobEstimate the front-end Budget card uses). The formula is
  // pure (mirrored from production/costing.js), so the estimate arrives via
  // derived.estimate instead of a state lookup; callers with no estimate pass
  // nothing and the estimate-derived fields stay zero/null. GP below still
  // uses the prod job's actual revenue.
  const est = derived.estimate || {};
  const estHrs = Number(est.budgetedHours || 0);
  const estLaborBudget = est.laborBudget == null ? null : Number(est.laborBudget);
  // Crew hours (prompt 56): the derived per-member sum (BusyBusy, else manual
  // per-member entry, via crewLaborForJob) wins over the typed actual_hours
  // fallback, same > 0 precedence shape as the buckets below.
  const actHrs = derived.actHrs > 0 ? Number(derived.actHrs) : Number(job.actual_hours ?? c.actual_hours ?? 0);
  const overUnder = (actHrs && estHrs) ? (actHrs - estHrs) : null;
  const hoursVarPct = (actHrs && estHrs) ? ((actHrs - estHrs) / estHrs) : null;
  // Materials ordered, materials used, bonus, and labor are all derived from
  // child rows when present, falling back to legacy stored values on the
  // costing row for jobs that pre-date the per-line / per-crew-member capture.
  //   - ordered: sum(pec_prod_material_lines.line_cost)
  //   - used:    sum(pec_prod_material_lines.actual_used_qty * unit_cost_snapshot)
  //   - bonus:   sum(pec_prod_job_bonuses.amount)
  //   - labor:   crewLaborForJob(...).laborCost (computeCrewBonus's loaded
  //     actual labor incl. burden), via derived.laborCost
  const orderedCost = derivedOrderedCost != null && derivedOrderedCost > 0
    ? Number(derivedOrderedCost)
    : Number(c.materials_ordered_cost || 0);
  const usedCost = derivedUsedCost != null && derivedUsedCost > 0
    ? Number(derivedUsedCost)
    : Number(c.materials_used_cost || 0);
  // derivedBonusCost is the pec_prod_job_bonuses ledger sum (approved money,
  // incl. any crew-lead bonus). derived.pendingBonus is the SUGGESTED
  // labor-savings pool on a job that has not approved one yet. They are
  // additive and mutually exclusive for labor savings: the caller
  // (pendingBonusForJob) passes pendingBonus = 0 as soon as a 'Labor-savings
  // bonus' ledger row exists, so approving cannot double-count.
  const pendingBonus = derived.pendingBonus > 0 ? Number(derived.pendingBonus) : 0;
  const bonusCost = (derivedBonusCost != null && derivedBonusCost > 0
    ? Number(derivedBonusCost)
    : Number(c.bonus_cost || 0)) + pendingBonus;
  const laborCost = derived.laborCost > 0 ? Number(derived.laborCost) : Number(c.salary_wages_cost || 0);
  const buckets = {
    equipment_rental_cost: Number(c.equipment_rental_cost || 0),
    materials_ordered_cost: orderedCost,
    materials_used_cost: usedCost,
    salary_wages_cost: laborCost,
    subcontractor_cost: Number(c.subcontractor_cost || 0),
    bonus_cost: bonusCost,
    commission_cost: Number(c.commission_cost || 0),
    misc_cost: Number(c.misc_cost || 0),
  };
  // Total Var Expense uses materials_used (not ordered) so we don't double-count
  const totalVar = buckets.equipment_rental_cost + buckets.materials_used_cost + buckets.salary_wages_cost + buckets.subcontractor_cost + buckets.bonus_cost + buckets.commission_cost + buckets.misc_cost;
  const gp = revenue - totalVar;
  const gpPct = revenue > 0 ? gp / revenue : null;
  const gpHr = actHrs > 0 ? gp / actHrs : null;
  const revHr = actHrs > 0 ? revenue / actHrs : null;
  const pct = (n) => revenue > 0 ? n / revenue : null;
  return { c, revenue, estHrs, estLaborBudget, actHrs, overUnder, hoursVarPct, buckets, totalVar, gp, gpPct, gpHr, revHr, pct, pendingBonus };
}

// Per-job cost aggregates from raw child rows, in the exact shape
// computeCostingRow's derived* arguments want. This mirrors how the dashboard
// builds them (renderMetrics / loadCostingData): ordered = sum(line_cost),
// used = sum(actual_used_qty * unit_cost_snapshot when both > 0), bonus =
// sum(amount), and labor = the loaded crew-labor cost (base wages + OT premium
// + burden, computeCrewBonus's actualLabor math) from BusyBusy hours, falling
// back to manual per-member hours ONLY when the job has no hand-typed Salary &
// Wages (Dylan's prompt-56 option C ruling; BusyBusy hours still beat a typed
// value).
//
// opts carries the labor knobs. The estimator does not read the settings table
// for these, so the shipped defaults apply there (bonus_labor_burden_pct 25,
// bonus_ot_multiplier 1.5, default_labor_hourly_rate 35); pass overrides if a
// caller has live settings. Comps are advisory, so a knob drifting from
// Settings shades an advisory GP% slightly, never money.
export function buildCostAggregates({ materialLines, bonuses, timeEntries, crewMembers, manualLabor, costings }, opts = {}) {
  const burden = Number(opts.burden) >= 0 && Number.isFinite(Number(opts.burden)) ? Number(opts.burden) : 0.25;
  const otMultiplier = Number(opts.otMultiplier) > 0 ? Number(opts.otMultiplier) : 1.5;
  const defaultRate = Number(opts.defaultRate) > 0 ? Number(opts.defaultRate) : 35;

  const orderedByJob = {}, usedByJob = {}, bonusByJob = {};
  for (const l of materialLines || []) {
    if (!l || l.job_id == null) continue;
    orderedByJob[l.job_id] = (orderedByJob[l.job_id] || 0) + (Number(l.line_cost) || 0);
    const q = Number(l.actual_used_qty || 0), u = Number(l.unit_cost_snapshot || 0);
    if (q > 0 && u > 0) usedByJob[l.job_id] = (usedByJob[l.job_id] || 0) + q * u;
  }
  for (const b of bonuses || []) {
    if (!b || b.job_id == null) continue;
    bonusByJob[b.job_id] = (bonusByJob[b.job_id] || 0) + (Number(b.amount) || 0);
  }

  // BusyBusy hours per job per member (rows with no job, no mapped member,
  // overhead, or non-positive hours never reach costing; OT is the OT1 slice).
  const bbMap = {};
  for (const e of timeEntries || []) {
    if (!e || !e.job_id || !e.crew_member_id || e.is_overhead) continue;
    const h = Number(e.hours || 0);
    if (!(h > 0)) continue;
    const cur = ((bbMap[e.job_id] ||= {})[e.crew_member_id] ||= { total: 0, ot: 0 });
    cur.total += h;
    if (e.wage_type === 'OT1') cur.ot += h;
  }
  const manualMap = {};
  for (const m of manualLabor || []) {
    if (!m || !m.job_id || !m.crew_member_id) continue;
    const cur = ((manualMap[m.job_id] ||= {})[m.crew_member_id] ||= { total: 0, ot: 0 });
    cur.total += Number(m.hours || 0);
    cur.ot += Number(m.ot_hours || 0);
  }
  const typedLaborByJob = {};
  for (const c of costings || []) {
    if (c && c.job_id != null) typedLaborByJob[c.job_id] = Number(c.salary_wages_cost || 0);
  }
  const wageById = {};
  for (const m of crewMembers || []) {
    if (m && m.id != null) wageById[m.id] = m.hourly_wage;
  }

  const laborByJob = {};
  for (const jid of new Set([...Object.keys(bbMap), ...Object.keys(manualMap)])) {
    const hoursByKey = (bbMap[jid] && Object.keys(bbMap[jid]).length)
      ? bbMap[jid]
      : (typedLaborByJob[jid] > 0 ? null : manualMap[jid]);
    if (!hoursByKey) continue;
    let laborCost = 0, actHrs = 0;
    for (const key of Object.keys(hoursByKey)) {
      const total = Number(hoursByKey[key].total) || 0;
      let ot = Number(hoursByKey[key].ot) || 0;
      if (ot < 0) ot = 0;
      if (ot > total) ot = total;
      const wage = Number(wageById[key]) > 0 ? Number(wageById[key]) : defaultRate;
      // Same loaded-labor shape as computeCrewBonus: base on all hours, plus
      // the OT premium, with burden stacked on top of both.
      laborCost += ((total * wage) + (ot * wage * (otMultiplier - 1))) * (1 + burden);
      actHrs += total;
    }
    if (laborCost > 0) laborByJob[jid] = { laborCost, actHrs };
  }

  return { orderedByJob, usedByJob, bonusByJob, laborByJob };
}
