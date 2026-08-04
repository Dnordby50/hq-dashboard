// Self-asserting Node script for the canonical GP formula. No framework. Run
// with `npm test` or `node production/costing.test.js`. Exits non-zero on any
// failure.
//
// computeCostingRow here is the SOURCE of truth; index.html carries a
// byte-identical mirror (checked by hand at review time, same convention as
// the calculator.js mirrors). These fixtures pin the numeric behavior the
// prompt-66 extraction was required NOT to change: the Job Costing tab and
// Metrics both call this math.

import { computeCostingRow, buildCostAggregates } from './costing.js';

let passed = 0;
let failed = 0;

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
    console.error(`       expected: ${e}`);
    console.error(`       actual:   ${a}`);
  }
}

// --- No costing row at all ----------------------------------------------------
{
  const r = computeCostingRow({ revenue: 8000 }, null, null, undefined, undefined, undefined, {});
  assertEq(r.totalVar, 0, 'no costing row: zero tracked cost');
  assertEq(r.gp, 8000, 'no costing row: GP equals revenue (caller must gate on a cost signal)');
  assertEq(r.gpPct, 1, 'no costing row: GP% is 100 (why comps show a dash without a signal)');
  assertEq(r.buckets.materials_used_cost, 0, 'no costing row: empty used bucket');
  assertEq(r.buckets.salary_wages_cost, 0, 'no costing row: empty labor bucket');
}

// --- Wages only -----------------------------------------------------------------
{
  const r = computeCostingRow({ revenue: 10000 }, { salary_wages_cost: 1000 }, null, undefined, undefined, undefined, {});
  assertEq(r.totalVar, 1000, 'wages only: labor is the whole tracked cost');
  assertEq(r.gpPct, 0.9, 'wages only: (10000-1000)/10000');
}

// --- Materials only (derived used beats the zero stored column) -----------------
{
  const r = computeCostingRow({ revenue: 10000 }, { materials_used_cost: 0 }, null, 1800, 1500, undefined, {});
  assertEq(r.buckets.materials_used_cost, 1500, 'derived used (1500) wins over the zero stored column');
  assertEq(r.buckets.materials_ordered_cost, 1800, 'derived ordered carried for display');
  assertEq(r.totalVar, 1500, 'totalVar counts USED, never ordered (no double-count)');
  assertEq(r.gpPct, 0.85, 'materials only: (10000-1500)/10000');
}

// --- Materials + labor (derived labor beats typed wages) -------------------------
{
  const r = computeCostingRow({ revenue: 10000 }, { salary_wages_cost: 700 }, null, undefined, 2500, undefined, { laborCost: 1500, actHrs: 30 });
  assertEq(r.buckets.salary_wages_cost, 1500, 'derived loaded labor (BusyBusy/manual) beats the typed value');
  assertEq(r.totalVar, 4000, 'materials + labor sum');
  assertEq(r.gpPct, 0.6, '(10000-4000)/10000');
  assertEq(r.actHrs, 30, 'derived hours win');
  assertEq(r.gpHr, 200, 'GP per hour from derived hours');
}

// --- Zero-revenue job -------------------------------------------------------------
{
  const r = computeCostingRow({ revenue: 0 }, { salary_wages_cost: 500 }, null, undefined, undefined, undefined, {});
  assertEq(r.gp, -500, 'zero revenue: GP is the negative cost');
  assertEq(r.gpPct, null, 'zero revenue: GP% is null, never a division by zero');
  assertEq(r.pct(250), null, 'zero revenue: pct() is null too');
}

// --- Negative GP -------------------------------------------------------------------
{
  const r = computeCostingRow({ revenue: 3000 }, { subcontractor_cost: 2000, misc_cost: 1500 }, null, undefined, undefined, undefined, {});
  assertEq(r.totalVar, 3500, 'subs + misc tracked');
  assertEq(r.gp, -500, 'over-cost job: negative GP survives (no clamping)');
  assertEq(r.gpPct, -500 / 3000, 'negative GP%');
}

// --- Bonus ledger + pending pool are additive, ledger beats stored column ----------
{
  const r = computeCostingRow({ revenue: 10000 }, { bonus_cost: 999 }, null, undefined, undefined, 400, { pendingBonus: 100 });
  assertEq(r.buckets.bonus_cost, 500, 'ledger sum (400) beats stored bonus_cost, pending (100) adds on top');
  assertEq(r.pendingBonus, 100, 'pending pool reported');
}

// --- Estimate rides in via derived.estimate (pure module, no state) -----------------
{
  const r = computeCostingRow({ revenue: 10000, actual_hours: 42 }, null, null, undefined, undefined, undefined, { estimate: { budgetedHours: 40, laborBudget: 1800 } });
  assertEq(r.estHrs, 40, 'estimate hours from derived.estimate');
  assertEq(r.estLaborBudget, 1800, 'labor budget from derived.estimate');
  assertEq(r.actHrs, 42, 'typed actual_hours used when no derived hours');
  assertEq(r.overUnder, 2, 'over/under from the pair');
}

// --- buildCostAggregates: lines, bonuses, and loaded labor ---------------------------
{
  const agg = buildCostAggregates({
    materialLines: [
      { job_id: 'p1', line_cost: 800, actual_used_qty: 2, unit_cost_snapshot: 300 },
      { job_id: 'p1', line_cost: 200, actual_used_qty: 0, unit_cost_snapshot: 50 }, // no used qty: ordered only
      { job_id: 'p2', line_cost: 100, actual_used_qty: 1, unit_cost_snapshot: 0 },  // no cost snapshot: ordered only
    ],
    bonuses: [ { job_id: 'p1', amount: 150 }, { job_id: 'p1', amount: 50 } ],
    timeEntries: [
      { job_id: 'p1', crew_member_id: 'm1', hours: 10, wage_type: 'REG', is_overhead: false },
      { job_id: 'p1', crew_member_id: 'm1', hours: 2, wage_type: 'OT1', is_overhead: false },
      { job_id: 'p1', crew_member_id: 'zz', hours: 9, wage_type: 'REG', is_overhead: true },  // overhead: never costing
      { job_id: 'p1', crew_member_id: null, hours: 9, wage_type: 'REG', is_overhead: false }, // unmapped: never costing
    ],
    crewMembers: [ { id: 'm1', hourly_wage: 20 } ],
    manualLabor: [ { job_id: 'p3', crew_member_id: 'm1', hours: 8, ot_hours: 0 } ],
    costings: [ { job_id: 'p3', salary_wages_cost: 640 } ],
  });
  assertEq(agg.orderedByJob.p1, 1000, 'ordered sums line_cost');
  assertEq(agg.usedByJob.p1, 600, 'used sums qty x snapshot only when both are positive');
  assertEq(agg.usedByJob.p2, undefined, 'no used cost without a positive snapshot');
  assertEq(agg.bonusByJob.p1, 200, 'bonus ledger sums');
  // m1 on p1: 12 total hours (2 OT). Loaded = (12x20 + 2x20x0.5) x 1.25 = (240+20)x1.25 = 325.
  assertEq(agg.laborByJob.p1, { laborCost: 325, actHrs: 12 }, 'BusyBusy loaded labor: base + OT premium, burden on top');
  // p3 has manual hours BUT typed Salary & Wages: manual is skipped (Dylan's
  // prompt-56 option C), so the typed value flows through the formula fallback.
  assertEq(agg.laborByJob.p3, undefined, 'manual hours skipped when Salary & Wages was hand-typed');
}

// --- One formula, two feeders: aggregates through the row match hand math -------------
{
  const agg = buildCostAggregates({
    materialLines: [ { job_id: 'p9', line_cost: 500, actual_used_qty: 5, unit_cost_snapshot: 90 } ],
    bonuses: [],
    timeEntries: [ { job_id: 'p9', crew_member_id: 'm2', hours: 10, wage_type: 'REG', is_overhead: false } ],
    crewMembers: [ { id: 'm2', hourly_wage: 24 } ],
    manualLabor: [],
    costings: [],
  });
  const r = computeCostingRow({ revenue: 6000 }, null, null, agg.orderedByJob.p9, agg.usedByJob.p9, agg.bonusByJob.p9, { laborCost: agg.laborByJob.p9.laborCost, actHrs: agg.laborByJob.p9.actHrs });
  // used 450 + labor 10x24x1.25=300 -> totalVar 750, GP 5250, GP% 0.875.
  assertEq(r.totalVar, 750, 'aggregates feed the row exactly');
  assertEq(r.gpPct, 0.875, 'GP% matches hand math to the cent');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
