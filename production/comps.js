// PEC comps engine: comparable completed jobs for pricing an estimate.
// Pure functions, no I/O, same posture as calculator.js: the estimator PWA
// imports these directly and the test harness drives the same code, so the
// comps a rep sees are exactly the rule set written here.
//
// Data model (all inputs are plain rows the caller fetched):
//   jobs      public.jobs rows: { id, customer_name, system_type_id, sqft (TEXT),
//             price, completed_date, dripjobs_deal_id }
//   prodJobs  pec_prod_jobs rows: { id, dripjobs_deal_id }
//   costings  pec_prod_job_costing rows: { job_id (-> pec_prod_jobs.id),
//             materials_ordered_cost, materials_used_cost, equipment_rental_cost,
//             salary_wages_cost, subcontractor_cost, misc_cost, bonus_cost,
//             commission_cost }
// public.jobs and pec_prod_jobs are SIBLING tables (see CLAUDE.md); the only
// bridge between them is dripjobs_deal_id, so actual GP is only available for
// jobs that flowed through the DripJobs webhook AND have a costing row.

// jobs.sqft is a TEXT column. Parse it the same way jobEffectiveSqft does
// client-side and the SQL rule does server-side: strip everything but digits
// and dots; 0 or unparseable means UNKNOWN, never zero square feet.
export function parseSqft(text) {
  if (text == null) return null;
  const cleaned = String(text).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Median, not mean: with ~35 completed jobs total, one commercial outlier
// would wreck a mean.
export function median(nums) {
  const xs = (nums || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// Actual GP fraction from a costing row: (price - all cost buckets) / price.
// null when there is no costing row, no positive price, or the row's costs sum
// to zero (an untouched costing row would otherwise read as a 100% GP job).
export function actualGpPct(price, costing) {
  const p = Number(price);
  if (!costing || !(p > 0)) return null;
  const buckets = [
    'materials_ordered_cost', 'materials_used_cost', 'equipment_rental_cost',
    'salary_wages_cost', 'subcontractor_cost', 'misc_cost', 'bonus_cost',
    'commission_cost',
  ];
  const total = buckets.reduce((s, k) => s + (Number(costing[k]) || 0), 0);
  if (!(total > 0)) return null;
  return (p - total) / p;
}

// Join the three sources into comp candidates. Kept here (not in UI code) so
// the dripjobs_deal_id bridge is covered by the same tests as the rules.
export function joinCompsSources(jobs, prodJobs, costings) {
  const prodByDeal = new Map();
  for (const pj of prodJobs || []) {
    if (pj && pj.dripjobs_deal_id != null) prodByDeal.set(String(pj.dripjobs_deal_id), pj.id);
  }
  const costingByProdJob = new Map();
  for (const c of costings || []) {
    if (c && c.job_id != null) costingByProdJob.set(c.job_id, c);
  }
  return (jobs || []).map((j) => {
    const prodJobId = j.dripjobs_deal_id != null ? prodByDeal.get(String(j.dripjobs_deal_id)) : undefined;
    const costing = prodJobId != null ? (costingByProdJob.get(prodJobId) || null) : null;
    const sqft = parseSqft(j.sqft);
    const price = Number(j.price) > 0 ? Number(j.price) : null;
    return {
      id: j.id,
      customer_name: j.customer_name || null,
      system_type_id: j.system_type_id || null,
      completed_date: j.completed_date || null,
      sqft,
      price,
      ppsf: sqft != null && price != null ? price / sqft : null,
      gp_pct: actualGpPct(price, costing),
    };
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 365;
const SQFT_BAND = 0.25; // plus or minus 25%
const MIN_SAMPLE = 3;

// The widen ladder, in the order Dylan locked: exact rule first, then drop the
// size filter, then drop the system filter, then everything completed in the
// window. First level with >= MIN_SAMPLE wins; if none reaches it, the level
// with the most rows wins (earlier level on ties). The result always names the
// rule that produced it, so a thin or widened set is never silently presented
// as an exact match.
export function buildComps({ candidates, systemTypeId, sqft, now }) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const cutoff = nowMs - WINDOW_DAYS * DAY_MS;
  const target = Number(sqft) > 0 ? Number(sqft) : null;

  const inWindow = (candidates || []).filter((c) => {
    if (!c.completed_date) return false;
    const t = Date.parse(c.completed_date);
    return Number.isFinite(t) && t >= cutoff && t <= nowMs + DAY_MS; // small future slack for timezone-day rows
  });

  const sameSystem = (c) => systemTypeId != null && c.system_type_id === systemTypeId;
  const similarSize = (c) =>
    target != null && c.sqft != null &&
    c.sqft >= target * (1 - SQFT_BAND) && c.sqft <= target * (1 + SQFT_BAND);

  const levels = [
    { rule: 'exact',        filter: (c) => sameSystem(c) && similarSize(c) },
    { rule: 'same_system',  filter: sameSystem },
    { rule: 'similar_size', filter: similarSize },
    { rule: 'any',          filter: () => true },
  ];

  const sets = levels.map((l) => ({ rule: l.rule, rows: inWindow.filter(l.filter) }));
  const exactCount = sets[0].rows.length;
  let chosen = sets.find((s) => s.rows.length >= MIN_SAMPLE);
  if (!chosen) {
    chosen = sets.reduce((best, s) => (s.rows.length > best.rows.length ? s : best), sets[0]);
  }

  // Closest square footage first (most comparable at the top); unknown-sqft
  // rows sink to the bottom, newest first among themselves.
  const rows = chosen.rows.slice().sort((a, b) => {
    const da = target != null && a.sqft != null ? Math.abs(a.sqft - target) : Infinity;
    const db = target != null && b.sqft != null ? Math.abs(b.sqft - target) : Infinity;
    if (da !== db) return da - db;
    return String(b.completed_date || '').localeCompare(String(a.completed_date || ''));
  });

  return {
    rule: rows.length ? chosen.rule : 'none',
    sample_size: rows.length,
    exact_count: exactCount,
    median_ppsf: median(rows.map((r) => r.ppsf)),
    rows,
    target_sqft: target,
  };
}

// Honest, human-readable statement of which rule produced the set. This string
// is shown to the rep AND fed to the AI, so the two can never disagree about
// how wide the net was.
export function compsRuleLabel(comps, systemName) {
  const n = comps.sample_size;
  const sys = systemName || 'this system';
  const size = comps.target_sqft != null
    ? `${Math.round(comps.target_sqft * (1 - SQFT_BAND))} to ${Math.round(comps.target_sqft * (1 + SQFT_BAND))} sqft`
    : 'similar size';
  const jobs = `${n} job${n === 1 ? '' : 's'}`;
  const exactNote = ` (${comps.exact_count} exact-size match${comps.exact_count === 1 ? '' : 'es'} found)`;
  switch (comps.rule) {
    case 'exact':
      return `${jobs}, same system (${sys}), ${size}, last 12 months`;
    case 'same_system':
      return `widened: same system (${sys}), any size, last 12 months${exactNote}`;
    case 'similar_size':
      return `widened: any system, ${size}, last 12 months${exactNote}`;
    case 'any':
      return `widened: any completed job, last 12 months${exactNote}`;
    default:
      return 'no completed jobs in the last 12 months to compare against';
  }
}
