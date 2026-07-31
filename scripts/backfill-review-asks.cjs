#!/usr/bin/env node
// One-time (but RE-RUNNABLE and idempotent) backfill of review asks for PEC
// epoxy jobs completed in the last 30 days that have no pec_review_requests
// row yet (prompt 60, Part H).
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-review-asks.cjs --dry-run
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-review-asks.cjs
//
// ALWAYS run --dry-run first and SKIM THE LIST: it prints every job it would
// enroll. Some jobs that completed three weeks ago went badly, and those
// customers should not get a cheerful review ask. Delete-proof: skipping a
// job is as simple as inserting a 'skipped' pec_review_requests row for it
// (from the job's close-out flow or SQL) before the real run.
//
// THE ANCHORING RULE (the whole reason this file exists as more than a loop):
// day offsets anchor to ENROLLMENT time, never completed_date. The campaign
// steps are day 1/3/7/14; anchor a 25-day-old completion to completed_date
// and steps 0, 1 and 2 are all instantly overdue, so the runner renders
// three messages for one customer on the same tick. enrollReviewDrip ->
// enrollSubject computes next_send_at from NOW, so every backfilled customer
// starts at step 0 and walks the normal cadence from today. asked_at is
// stamped now; the REAL completion date is preserved on the request row
// (job_completed_date) so the Reviews view can show "completed 25 days ago,
// asked today".
//
// Every backfilled message still goes through the approval gate like any
// other, so the practical output of this script is a stack of pending
// approvals for Dylan to read, never a stack of sent texts. enrollReviewDrip
// itself refuses if the gate is off and the campaign has never sent.
//
// Idempotency: a job with ANY pec_review_requests row (asked, clicked,
// reviewed, skipped, stopped) is skipped and counted. Re-running is safe.

const { enrollReviewDrip } = require('../netlify/functions/_pec-drip.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.argv.includes('--dry-run');
const WINDOW_DAYS = 30;

if (!SUPABASE_URL || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment first.');
  process.exit(1);
}

// Same REST shape as netlify/functions/_pec-supabase.cjs sb().
async function sb(method, path, payload, returnRow) {
  const headers = {
    apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
  };
  if (returnRow) headers.Prefer = 'return=representation';
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method, headers, body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${await res.text()}`);
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// Same normalized name+address bridge the dashboard uses for manual prod rows.
const normKey = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const nameAddrKey = (name, addr) => {
  const n = normKey(name), a = normKey(addr);
  return (n && a) ? n + '|' + a : '';
};

// The same guard enrollReviewDrip applies per-job, checked ONCE up front so a
// refused run writes NOTHING (a request row without an enrollment would make
// the re-run skip that job forever as "already has a request").
async function gateAllowsEnrollment() {
  const camps = await sb('GET', `/pec_drip_campaigns?kind=eq.review&status=eq.active&select=id,mode&limit=1`);
  const camp = Array.isArray(camps) ? camps[0] : null;
  if (!camp || camp.mode !== 'live') return true;
  const rows = await sb('GET', `/settings?key=eq.drip_approval_required&select=value&limit=1`);
  if (Array.isArray(rows) && rows[0] && rows[0].value === 'true') return true;
  const sent = await sb('GET', `/pec_drip_sends?campaign_id=eq.${encodeURIComponent(camp.id)}&status=eq.sent&select=id&limit=1`);
  return Array.isArray(sent) && sent.length > 0;
}

async function main() {
  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  console.log(`${DRY ? '[DRY RUN] ' : ''}Backfilling review asks for PEC epoxy jobs completed since ${sinceIso}...`);

  if (!DRY && !(await gateAllowsEnrollment())) {
    console.error('REFUSED before writing anything: the review campaign is live, drip_approval_required is not \'true\', and no send has ever been approved. Turn on Drip approvals in Settings, then re-run.');
    process.exit(2);
  }

  const [jobs, prodJobs, existing] = await Promise.all([
    sb('GET', `/jobs?completed_date=gte.${sinceIso}&voided_at=is.null&archived_at=is.null&select=id,address,completed_date,customer_id,dripjobs_deal_id,customers!inner(name,phone,email,company)&customers.company=eq.prescott-epoxy`),
    sb('GET', `/pec_prod_jobs?select=id,dripjobs_deal_id,customer_name,address,crew_lead,crew_id`),
    sb('GET', `/pec_review_requests?select=job_id`),
  ]);
  const hasRequest = new Set((existing || []).map(r => r.job_id));
  const prodByDeal = new Map(), prodByNA = new Map();
  for (const p of (prodJobs || [])) {
    if (p.dripjobs_deal_id && !prodByDeal.has(p.dripjobs_deal_id)) prodByDeal.set(p.dripjobs_deal_id, p);
    const k = nameAddrKey(p.customer_name, p.address);
    if (k && !prodByNA.has(k)) prodByNA.set(k, p);
  }

  let enrolled = 0, skippedExisting = 0, refused = 0, failed = 0;
  for (const job of (jobs || [])) {
    const name = job.customers && job.customers.name;
    const label = `${name || 'unknown'} · ${job.address || 'no address'} · completed ${job.completed_date}`;
    if (hasRequest.has(job.id)) { skippedExisting++; console.log(`  skip (already has a request): ${label}`); continue; }
    const prod = prodByDeal.get(job.dripjobs_deal_id) || prodByNA.get(nameAddrKey(name, job.address)) || null;
    if (DRY) { enrolled++; console.log(`  WOULD enroll: ${label} · crew lead ${prod && prod.crew_lead || '(none)'}`); continue; }
    try {
      await sb('POST', '/pec_review_requests', {
        job_id: job.id,
        prod_job_id: prod ? prod.id : null,
        customer_id: job.customer_id,
        crew_lead: prod ? prod.crew_lead : null,   // SNAPSHOT at ask time
        crew_id: prod ? prod.crew_id : null,
        brand: 'epoxy',
        status: 'asked',
        asked_at: new Date().toISOString(),        // asked NOW, not backdated
        job_completed_date: job.completed_date,    // the real completion date
      });
      const enr = await enrollReviewDrip(sb, job.id);   // anchors to NOW by construction
      if (enr.enrolled) {
        enrolled++;
        console.log(`  enrolled: ${label} · crew lead ${prod && prod.crew_lead || '(none)'}`);
      } else if (enr.reason === 'approval_gate_off' || enr.reason === 'gate_check_failed') {
        // The up-front gate check should make this unreachable; if the gate
        // flipped mid-run, say so loudly (the request row IS written).
        refused++;
        console.log(`  REFUSED mid-run (${enr.reason}): ${label} -- request row written but NOT enrolled; delete that pec_review_requests row and re-run after fixing the gate.`);
      } else {
        // Request row exists either way; 'already_active' etc. still count it.
        enrolled++;
        console.log(`  request written, enrollment ${enr.reason}: ${label}`);
      }
    } catch (err) {
      failed++;
      console.error(`  FAILED: ${label}: ${err.message}`);
    }
  }
  // No-silent-caps rule: say exactly what was and was not done.
  console.log(`\n${DRY ? '[DRY RUN] ' : ''}Done. ${enrolled} enrolled, ${skippedExisting} skipped (already had a request), ${refused} refused by the approval-gate guard, ${failed} failed, of ${(jobs || []).length} completed jobs in the window.`);
  if (refused) console.log('Mid-run refusals mean the gate flipped while this ran. Those jobs have a request row but no enrollment; delete those pec_review_requests rows and re-run after turning the gate back on.');
  if (!DRY && enrolled) console.log('Every message lands in Drip Approvals for a human read before anything sends.');
}

main().catch(err => { console.error(err); process.exit(1); });
