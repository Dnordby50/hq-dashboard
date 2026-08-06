#!/usr/bin/env node
// One-time (but RE-RUNNABLE and idempotent) backlog enrollment of still-open
// non-appointment leads into the lead-nurture drip (prompt 73 Part F4, Dylan
// decision 13: auto-enroll, with the test-row guardrail Cowork flagged).
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/enroll-lead-backlog.cjs --dry-run
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/enroll-lead-backlog.cjs
//
// ALWAYS run --dry-run first and SHOW DYLAN THE LIST before the real run
// (prompt 73 housekeeping: his explicit yes gates the live run).
//
// Exclusions, every one required (a lead is skipped if ANY hits):
//   - archived (archived_at set) or deleted (deleted_at set)
//   - opted out (opted_out true): do-not-contact is global
//   - stage accepted or lost: the sequence is over
//   - stage estimate_scheduled / estimate_sent / presented: not in the
//     prompt's literal list, but the engine's own kill-switch stops these as
//     stage_advanced on the FIRST tick, so enrolling them only manufactures
//     enroll-then-stop churn rows. Backlog nurture is for new/contacted.
//   - any non-canceled appointment: booked is its own track (decision 2)
//   - ANY enrollment on the lead campaign, in any status: a stopped
//     enrollment means a human or a rule already ended it; never resurrect
//   - obvious test names: 'ZZ %', '%Smoke Test%', '%test lead%'
//
// THE ANCHORING RULE (same as backfill-review-asks): next_send_at anchors to
// ENROLLMENT time, never lead creation. Anchor a 30-day-old lead to its
// creation date and six steps are instantly overdue on one tick.
// enrollSubject computes from NOW, so every backlog lead starts fresh.
//
// Backlog leads START AT STEP 1, never step 0: the day-0 instant touch is a
// fresh-inquiry auto-reply, and "thanks for reaching out" three weeks late
// reads as broken (prompt 73 Part F4, explicit).
//
// Every enrolled step still goes through the approval gate like any other
// touch, so the practical output of a live run is pending approvals for a
// human to read, never a stack of sent texts.

const { enrollLead } = require('../netlify/functions/_pec-drip.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.argv.includes('--dry-run');

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

const TEST_NAME_RE = /^zz |smoke test|test lead/i;

async function main() {
  console.log(`enroll-lead-backlog (prompt 73 Part F4) ${DRY ? '[DRY RUN]' : '[LIVE]'}`);

  // The active lead campaign; its enrollments (any status) are the
  // never-resurrect set.
  const camps = await sb('GET', `/pec_drip_campaigns?kind=eq.lead&status=eq.active&select=id,name&order=created_at.asc&limit=1`);
  const camp = Array.isArray(camps) && camps[0];
  if (!camp) { console.error('No active lead campaign; nothing to do.'); process.exit(1); }
  console.log(`Campaign: ${camp.name} (${camp.id})`);

  const [leads, enrollments, appts] = await Promise.all([
    sb('GET', `/leads?deleted_at=is.null&select=id,full_name,source,stage,created_at,archived_at,opted_out,email,phone`),
    sb('GET', `/pec_drip_enrollments?campaign_id=eq.${encodeURIComponent(camp.id)}&select=lead_id,status`),
    sb('GET', `/pec_appointments?status=neq.canceled&lead_id=not.is.null&select=lead_id`),
  ]);
  const enrolledEver = new Set((enrollments || []).map(e => e.lead_id).filter(Boolean));
  const hasAppt = new Set((appts || []).map(a => a.lead_id));

  const enroll = [], skipped = [];
  for (const l of (leads || [])) {
    const why =
      l.archived_at ? 'archived'
      : l.opted_out ? 'opted_out'
      : ['accepted', 'lost'].includes(l.stage) ? `stage_${l.stage}`
      : ['estimate_scheduled', 'estimate_sent', 'presented'].includes(l.stage) ? `stage_${l.stage} (engine would stop it as stage_advanced on tick 1)`
      : hasAppt.has(l.id) ? 'has_live_appointment'
      : enrolledEver.has(l.id) ? 'already_has_enrollment (any status; never resurrected)'
      : TEST_NAME_RE.test(String(l.full_name || '')) ? 'test_name_pattern'
      : (!l.email && !l.phone) ? 'no_contact_info'
      : null;
    if (why) skipped.push({ l, why });
    else enroll.push(l);
  }

  console.log(`\n${leads.length} live leads: ${enroll.length} to enroll, ${skipped.length} excluded.\n`);
  console.log('WOULD ENROLL (from step 1, anchored to now):');
  if (!enroll.length) console.log('  (none)');
  for (const l of enroll) console.log(`  - ${l.full_name} [${l.source} / ${l.stage} / created ${String(l.created_at).slice(0, 10)}]`);
  console.log('\nEXCLUDED:');
  for (const { l, why } of skipped) console.log(`  - ${l.full_name} [${l.stage}]: ${why}`);

  if (DRY) { console.log('\nDry run: nothing written. Show Dylan this list, then re-run without --dry-run.'); return; }

  let ok = 0, failed = 0;
  for (const l of enroll) {
    const r = await enrollLead(sb, l.id, new Date(), { minStepIndex: 1 });
    if (r.enrolled) { ok++; console.log(`  enrolled ${l.full_name}`); }
    else { failed++; console.log(`  SKIPPED ${l.full_name}: ${r.reason || r.error}`); }
  }
  console.log(`\nDone: ${ok} enrolled, ${failed} refused by the engine.`);
}

main().catch(err => { console.error(err); process.exit(1); });
