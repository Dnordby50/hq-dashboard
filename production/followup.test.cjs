// Fixture test for the prompt-98 build: the follow-up queue's deterministic
// rules (production/followup-rules.cjs), the rank engine and Slack digest
// (netlify/functions/_pec-followup.cjs) against the shared mini-PostgREST
// with a fake Anthropic fetch, and matcher parity with the REAL
// leadContactStats extracted from index.html source (so the "Contacted Nx"
// chip and the follow-up clock can never silently disagree on the same
// logs). Run: node production/followup.test.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const rules = require('./followup-rules.cjs');
const { runFollowupRank, runFollowupDigest } = require('../netlify/functions/_pec-followup.cjs');
const { makeDb, makeChecker } = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

const NOW = new Date('2026-08-18T17:00:00Z'); // 10:00 Phoenix
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();
const SETTINGS = rules.parseFollowupSettings({}); // seeded defaults: 3 / 21 / 60

function est(over = {}) {
  return {
    id: over.id || 'est1', estimate_number: 102001, customer_id: 'cust1', lead_id: 'lead1',
    brand: 'PEC', status: 'sent', deleted_at: null, price: 3500,
    sent_at: daysAgo(5), created_at: daysAgo(6),
    customer_name: 'Tom Bechtel', customer_email: 'tom@example.com', customer_phone: '9285551234',
    customer_address: null, change_request_note: null, company_notes: null, scope_of_work: null,
    followup_snoozed_until: null, followup_snooze_reason: null,
    ...over,
  };
}
function lead(over = {}) {
  return {
    id: 'lead1', customer_id: 'cust1', first_name: 'Tom', full_name: 'Tom Bechtel',
    phone: '9285551234', phone_norm: '9285551234', email: 'tom@example.com',
    stage: 'estimate_sent', archived_at: null, score: 62, scored_at: daysAgo(1),
    notes: null, ai_analysis: null, deleted_at: null,
    ...over,
  };
}

// ---- membership: every exit condition -------------------------------------
{
  const quiet = null; // no human touch
  const cases = [
    [est(), 'due', 'a sent estimate 5 days quiet is due (threshold 3)'],
    [est({ status: 'accepted' }), 'out', 'accepting exits immediately'],
    [est({ status: 'lost' }), 'out', 'marking lost exits immediately'],
    [est({ status: 'draft' }), 'out', 'a draft is never a subject'],
    [est({ deleted_at: daysAgo(1) }), 'out', 'an archived estimate exits'],
    [est({ followup_snoozed_until: daysAgo(-10) }), 'out', 'a future snooze exits (snoozed)'],
    [est({ followup_snoozed_until: daysAgo(1) }), 'due', 'a PAST snooze date puts it straight back in the queue'],
    [est({ sent_at: daysAgo(30) }), 'cold', 'quiet past 21 days lands in the Cold tail, not the live list'],
    [est({ sent_at: daysAgo(1) }), 'not_due', 'a freshly sent estimate is not due yet'],
  ];
  for (const [e, want, label] of cases) {
    const m = rules.membershipState(e, lead(), quiet, SETTINGS, NOW);
    ok(m.state === want, `${label} (got ${m.state})`);
  }
  ok(rules.membershipState(est(), lead({ archived_at: daysAgo(1) }), quiet, SETTINGS, NOW).state === 'out', 'an archived lead takes its estimate out');
  ok(rules.membershipState(est(), lead({ stage: 'lost' }), quiet, SETTINGS, NOW).state === 'out', 'a lost lead takes its estimate out');
  ok(rules.membershipState(est(), null, quiet, SETTINGS, NOW).state === 'due', 'a lead-less estimate (they exist live) still queues');
}

// ---- the clock: drips never reset it, human touches do --------------------
{
  const keys = rules.subjectKeys(est(), lead());
  const logs = {
    calls: [], texts: [
      { customer_id: 'cust1', to_number: '9285551234', created_at: daysAgo(1), kind: 'drip' },
      { customer_id: 'cust1', to_number: '9285551234', created_at: daysAgo(4), kind: null },
    ],
    emails: [{ customer_id: 'cust1', to_email: 'tom@example.com', sent_at: daysAgo(2), template_key: 'blast' }],
    notes: [],
  };
  const t = rules.humanTouchesFor(keys, 'est1', 'lead1', logs);
  ok(t.humanTotal === 1 && t.texts === 1, 'drip and blast mirror rows are excluded from the human count');
  ok(t.humanLastAt === daysAgo(4), 'the clock reads the manual text, not yesterday\'s drip');
  const m = rules.membershipState(est(), lead(), t.humanLastAt, SETTINGS, NOW);
  ok(m.state === 'due' && m.daysQuiet === 4, 'a drip going out did NOT reset the 4-day clock');

  // A logged touch (counts_as_touch) resets it; a walk-in note flagged
  // counts_as_touch=false records without resetting.
  const withNote = { ...logs, notes: [{ customer_id: 'cust1', estimate_id: null, lead_id: null, counts_as_touch: true, created_at: daysAgo(1) }] };
  const t2 = rules.humanTouchesFor(keys, 'est1', 'lead1', withNote);
  ok(rules.membershipState(est(), lead(), t2.humanLastAt, SETTINGS, NOW).state === 'not_due', 'logging a touch resets the clock and removes the row');
  const noTouch = { ...logs, notes: [{ customer_id: 'cust1', counts_as_touch: false, created_at: daysAgo(1) }] };
  const t3 = rules.humanTouchesFor(keys, 'est1', 'lead1', noTouch);
  ok(t3.humanLastAt === daysAgo(4), 'a counts_as_touch=false note records WITHOUT resetting the clock');
  // Estimate-linked and lead-linked notes count even without a customer id.
  const estNote = { calls: [], texts: [], emails: [], notes: [{ customer_id: null, estimate_id: 'est1', lead_id: null, counts_as_touch: true, created_at: daysAgo(2) }] };
  ok(rules.humanTouchesFor(rules.subjectKeys(est({ customer_id: null }), null), 'est1', null, estNote).logged === 1, 'a note matches through estimate_id when no customer is linked');
}

// ---- matcher parity with the REAL leadContactStats ------------------------
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const grab = (name) => {
    const m = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    if (!m) throw new Error(`could not extract ${name} from index.html`);
    return m[0];
  };
  const contactPhoneNorm = eval(`(${grab('contactPhoneNorm')})`);
  const leadContactStats = eval(`(${grab('leadContactStats')})`);
  const leads = [lead()];
  const logs = {
    calls: [
      { customer_id: 'cust1', to_number: '+1 (928) 555-1234', occurred_at: daysAgo(3), created_at: daysAgo(3) },
      { customer_id: null, to_number: '9285551234', occurred_at: daysAgo(8), created_at: daysAgo(8) },
      { customer_id: null, to_number: '5550000000', occurred_at: daysAgo(1), created_at: daysAgo(1) }, // someone else
    ],
    texts: [
      { customer_id: 'cust1', to_number: '9285551234', created_at: daysAgo(2), kind: null },
      { customer_id: 'cust1', to_number: '9285551234', created_at: daysAgo(1), kind: 'drip' },
    ],
    emails: [{ customer_id: null, to_email: 'TOM@example.com', sent_at: daysAgo(6), template_key: null }],
    drips: [],
  };
  const chip = leadContactStats(leads, logs)['lead1'];
  const t = rules.humanTouchesFor(rules.subjectKeys(est(), lead()), 'est1', 'lead1', { ...logs, notes: [] });
  ok(chip.calls === t.calls && chip.texts === t.texts && chip.emails === t.emails,
    `follow-up matcher agrees with the Contacted Nx chip on the same logs (chip ${chip.calls}/${chip.texts}/${chip.emails} vs ${t.calls}/${t.texts}/${t.emails})`);
  ok(t.calls === 2 && t.texts === 1 && t.emails === 1, 'customer_id, normalized-phone, and case-folded email matching all attribute');
  ok(chip.total === 4, 'the kanban chip keeps ITS meaning (drips excluded here only because the ledger row carries them)');
}

// ---- fallback ranking order (decision 10: quiet, then engagement, then $) --
{
  const mk = (daysQuiet, lastViewedAt, price) => rules.fallbackPriority({ daysQuiet, lastViewedAt, price }, NOW);
  ok(mk(10, null, 1000) > mk(4, null, 1000), 'more days quiet ranks higher');
  ok(mk(5, daysAgo(1), 1000) > mk(5, null, 1000), 'a fresh proposal view ranks higher at equal staleness');
  ok(mk(5, null, 12000) > mk(5, null, 1000), 'dollar value breaks the remaining tie');
  const p = rules.fallbackPriority({ daysQuiet: 100, lastViewedAt: daysAgo(1), lastInboundAt: daysAgo(1), hasChangeRequest: true, price: 50000 }, NOW);
  ok(p <= 100 && p >= 1, 'priority clamps to 1-100');
}

// ---- the coaching-grade reject list ---------------------------------------
{
  ok(rules.rejectListViolation('Just checking in on your proposal!') === 'checking in', '"checking in" is a build failure');
  ok(rules.rejectListViolation('Wanted to follow up about the floor') === 'following up', '"follow up" rejected');
  ok(rules.rejectListViolation('Following up on our quote') === 'following up', '"following up" rejected');
  ok(rules.rejectListViolation('Quick note to touch base') === 'touching base', '"touch base" rejected');
  ok(rules.rejectListViolation('Let me know if you have any questions.') != null, 'the classic non-ask rejected');
  ok(rules.rejectListViolation('Hi Tom, we can hold next Tuesday for your garage. Want the spot?') === null, 'a decision-advancing opener passes');
  const fb = rules.fallbackOpener({ firstName: 'Tom', price: 3500 });
  ok(rules.rejectListViolation(fb.opener) === null && rules.rejectListViolation(fb.text) === null, 'the deterministic fallback copy passes its own reject list');
  ok(!/[—–]/.test(fb.opener + fb.text), 'fallback copy carries no em or en dashes');
}

// ---- the rank engine over the mini-PostgREST ------------------------------
function tables(over = {}) {
  return {
    settings: [],
    estimates: [est()],
    leads: [lead()],
    pec_call_log: [], pec_sms_log: [], pec_email_log: [], pec_customer_notes: [],
    pec_estimate_views: [{ estimate_id: 'est1', viewed_at: daysAgo(1) }],
    pec_salesask_recordings: [{ customer_id: 'cust1', lead_id: 'lead1', occurred_at: daysAgo(6), title: 'Visit', summary: 'Wife worried about hot tire pickup; they mentioned the RV pad and a Labor Day deadline.' }],
    pec_followup_ranks: [],
    pec_webhook_ingest_log: [],
    ...over,
  };
}
const modelReply = (items) => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(items) }] }) });

(async () => {
{
  // AI path: first answer violates the reject list, the regenerate fixes it.
  let calls = 0;
  const fetchFn = async (url, opts) => {
    if (!/anthropic/.test(url)) throw new Error('unexpected fetch ' + url);
    calls++;
    if (calls === 1) return modelReply([{ subject_id: 'est1', score: 88, why_now: 'Viewed yesterday, 5 days quiet, $3,500 at stake.', opener: 'Hi Tom, just checking in on your proposal.', text: 'Hi Tom, we can hold an install date for the garage. Want me to save next week?', channel: 'call' }]);
    return modelReply([{ subject_id: 'est1', score: 88, why_now: 'Viewed yesterday, 5 days quiet, $3,500 at stake.', opener: 'Hi Tom, you mentioned the RV pad and the hot tire worry on our visit. We can hold an install date before Labor Day. Want me to lock one in?', text: 'Hi Tom, we can get the garage done before Labor Day like you wanted. Want me to hold a date?', channel: 'call' }]);
  };
  const fx = makeDb(tables());
  const res = await runFollowupRank({ sb: fx.sb, fetch: fetchFn, now: () => NOW });
  ok(res.ok && res.live === 1 && res.written === 1 && res.ai === 1, `rank run writes one AI row (got ${JSON.stringify({ live: res.live, written: res.written, ai: res.ai })})`);
  ok(calls === 2, 'the banned "checking in" opener cost exactly one regenerate call');
  const row = fx.db.pec_followup_ranks[0];
  ok(row && row.source === 'ai' && rules.rejectListViolation(row.suggested_opener) === null, 'the stored opener passed the reject list in code');
  ok(row.suggested_text && row.suggested_opener && row.why_now, 'both lengths (opener + text) and the why-now line are stored');
  ok(row.inputs && row.inputs.daysQuiet === 5 && row.inputs.viewCount === 1, 'the deterministic inputs snapshot rides the row (debuggability)');
}

{
  // Model down: the queue still ranks (fallback), never empty.
  const fetchFn = async () => { throw new Error('anthropic down'); };
  const fx = makeDb(tables());
  const res = await runFollowupRank({ sb: fx.sb, fetch: fetchFn, now: () => NOW });
  ok(res.ok && res.written === 1 && res.fallback === 1, 'a dead model still writes a fallback-ranked row');
  const row = fx.db.pec_followup_ranks[0];
  ok(row.source === 'fallback' && rules.rejectListViolation(row.suggested_opener) === null, 'fallback row is marked fallback and its copy passes the reject list');
}

{
  // followup_enabled=false: the whole run is a gated no-op.
  const fx = makeDb(tables({ settings: [{ id: 's1', key: 'followup_enabled', value: 'false' }] }));
  const res = await runFollowupRank({ sb: fx.sb, fetch: async () => { throw new Error('should not be called'); }, now: () => NOW });
  ok(res.ok && res.skipped && fx.db.pec_followup_ranks.length === 0, 'master switch off = no-op, no rows');
}

{
  // AI off: deterministic-only run, still fully ordered.
  const fx = makeDb(tables({
    settings: [{ id: 's1', key: 'followup_ai_rank_enabled', value: 'false' }],
    estimates: [est(), est({ id: 'est2', customer_id: null, lead_id: null, customer_name: 'Gary Kuehn', customer_phone: '5551112222', customer_email: null, price: 1950, sent_at: daysAgo(33), created_at: daysAgo(34) })],
  }));
  const res = await runFollowupRank({ sb: fx.sb, fetch: async () => { throw new Error('should not be called'); }, now: () => NOW });
  ok(res.ok && res.ai === 0 && res.written === 1 && res.cold === 1, 'AI toggle off: fallback ranks the due row; the 33-day-quiet lead-less estimate lands in Cold (not written)');
}

// ---- the digest -----------------------------------------------------------
process.env.SLACK_OFFICE_WEBHOOK = 'https://hooks.example.test/T000/B000';
{
  // Empty queue: skip entirely, nothing posted, no marker row.
  const posts = [];
  const fetchFn = async (url, opts) => { posts.push(url); return { ok: true, text: async () => '' }; };
  const fx = makeDb(tables({ estimates: [est({ sent_at: daysAgo(1), created_at: daysAgo(1) })] })); // not due yet
  const res = await runFollowupDigest({ sb: fx.sb, fetch: fetchFn, now: () => NOW, logIngest: async (f) => fx.db.pec_webhook_ingest_log.push({ ...f, created_at: NOW.toISOString() }) });
  ok(res.ok && res.skipped === 'queue empty' && posts.length === 0 && fx.db.pec_webhook_ingest_log.length === 0,
    'empty queue: no Slack post, no marker, honest skip');
}
{
  // Due rows: one post at/after the digest time, then a same-day rerun dedupes.
  const posts = [];
  const fetchFn = async (url, opts) => { posts.push(JSON.parse(opts.body)); return { ok: true, text: async () => '' }; };
  const fx = makeDb(tables());
  const deps = { sb: fx.sb, fetch: fetchFn, now: () => NOW, logIngest: async (f) => fx.db.pec_webhook_ingest_log.push({ ...f, created_at: NOW.toISOString() }) };
  const res1 = await runFollowupDigest(deps);
  ok(res1.ok && res1.sent === 1 && posts.length === 1 && /Follow-up queue/.test(posts[0].text) && /Tom Bechtel/.test(posts[0].text),
    'digest posts the due row with name and days quiet');
  const res2 = await runFollowupDigest(deps);
  ok(res2.ok && res2.skipped === 'already sent today' && posts.length === 1, 'a second tick the same day is deduped by the marker row');
}
{
  // Before the digest time: waits.
  const early = new Date('2026-08-18T13:00:00Z'); // 06:00 Phoenix < 07:30
  const fx = makeDb(tables());
  const res = await runFollowupDigest({ sb: fx.sb, fetch: async () => { throw new Error('no post'); }, now: () => early });
  ok(res.ok && res.skipped === 'before digest time', 'the ticker waits for the settings-controlled Phoenix time');
}

console.log(`followup.test: ${state.passed} passed, ${state.failed} failed`);
if (state.failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
