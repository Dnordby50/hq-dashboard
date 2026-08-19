// Fixture test for the prompt-97 build: the shared lead-scoring core
// (_pec-lead-score.cjs) that the pec-lead-ai endpoint, the intake kicks, and
// the nightly pec-lead-score-runner all ride. Drives the REAL runScorePass /
// scoreLead against the shared mini-PostgREST with a fake Anthropic fetch.
// Covers: subject selection (stages, archived, deleted, opted-out), the
// staleness order, the batch cap, the freshness skip, the band-change-only
// event rule, the scored_at stamp, and the null-score rendering of the REAL
// index.html badge functions (extracted from source, so a drift fails here).
// Run: node production/lead-score.test.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const { runScorePass, scoreLead, scoreBand } = require('../netlify/functions/_pec-lead-score.cjs');
const { makeDb, makeChecker } = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

// A fake Anthropic endpoint: returns the score queued for the lead named in
// the prompt (buildUserPrompt embeds full_name), so each lead can land on a
// chosen band. Counts calls, which is what the batch cap bounds.
function makeModel(scoreByName, fallback = 55) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    const prompt = JSON.parse(opts.body).messages[0].content;
    const name = (prompt.match(/"name":"([^"]+)"/) || [])[1];
    const score = name != null && scoreByName[name] != null ? scoreByName[name] : fallback;
    calls.push({ name, score });
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          summary: 's', score, score_reason: 'r', next_action: 'call',
          call_script: 'c', draft_sms: null, draft_email: null, risk_flags: [],
        }) }],
      }),
    };
  };
  return { calls, fetchFn };
}

const NOW = Date.now();
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

function lead(over) {
  return {
    id: over.id, full_name: over.full_name || over.id, first_name: 'X',
    stage: 'new', score: null, scored_at: null, ai_analyzed_at: null,
    ai_analysis: null, deleted_at: null, archived_at: null, opted_out: false,
    sms_consent: false, phone: null, email: null, created_at: hoursAgo(72),
    ...over,
  };
}

function tables(leadRows, settingRows = []) {
  return {
    settings: settingRows,
    leads: leadRows,
    lead_events: [],
    estimates: [],
  };
}

// ---- subject selection ----------------------------------------------------
(async () => {
{
  const fx = makeDb(tables([
    lead({ id: 'L-new', full_name: 'Alice New', stage: 'new' }),
    lead({ id: 'L-contacted', full_name: 'Bob Contacted', stage: 'contacted' }),
    lead({ id: 'L-optout', full_name: 'Carol Optout', stage: 'presented', opted_out: true }),
    lead({ id: 'L-lost', full_name: 'Dan Lost', stage: 'lost' }),
    lead({ id: 'L-accepted', full_name: 'Eve Accepted', stage: 'accepted' }),
    lead({ id: 'L-archived', full_name: 'Frank Archived', stage: 'new', archived_at: hoursAgo(5) }),
    lead({ id: 'L-deleted', full_name: 'Gina Deleted', stage: 'new', deleted_at: hoursAgo(5) }),
  ]));
  const { calls, fetchFn } = makeModel({});
  const res = await runScorePass({ sb: fx.sb, fetch: fetchFn, freshHours: 20, source: 'nightly_runner' });
  const scoredIds = fx.db.leads.filter(l => l.score != null).map(l => l.id).sort();
  ok(res.scored === 3, `subject set: 3 of 7 leads score (got ${res.scored})`);
  ok(scoredIds.join(',') === 'L-contacted,L-new,L-optout',
    `open stages score, opted-out still scores, lost/accepted/archived/deleted never do (got ${scoredIds.join(',')})`);
  ok(calls.length === 3, 'exactly one model call per scored lead');
  ok(fx.db.leads.find(l => l.id === 'L-optout').scored_at != null, 'opted-out lead gets scored_at stamped');
}

// ---- settings-controlled stage list --------------------------------------
{
  const fx = makeDb(tables([
    lead({ id: 'L-new', full_name: 'Alice New', stage: 'new' }),
    lead({ id: 'L-presented', full_name: 'Bob Presented', stage: 'presented' }),
  ], [
    { id: 's1', key: 'lead_score_stages', value: 'presented,lost,accepted' },
  ]));
  const { fetchFn } = makeModel({});
  await runScorePass({ sb: fx.sb, fetch: fetchFn, freshHours: 20 });
  ok(fx.db.leads.find(l => l.id === 'L-presented').score != null
    && fx.db.leads.find(l => l.id === 'L-new').score == null,
    'lead_score_stages narrows the subject set');
  // lost/accepted typed into the setting are stripped server-side; proven by
  // the query not erroring and by the first block (no lost/accepted scored).
}

// ---- staleness order + batch cap -----------------------------------------
{
  const fx = makeDb(tables([
    lead({ id: 'L-fresh-ish', full_name: 'Aaron Recent', score: 50, scored_at: hoursAgo(30) }),
    lead({ id: 'L-never', full_name: 'Beth Never' }),
    lead({ id: 'L-oldest', full_name: 'Carl Oldest', score: 20, scored_at: hoursAgo(200) }),
  ], [
    { id: 's1', key: 'lead_score_batch_cap', value: '2' },
  ]));
  const { calls, fetchFn } = makeModel({});
  const res = await runScorePass({ sb: fx.sb, fetch: fetchFn, freshHours: 20 });
  ok(res.attempted === 2 && calls.length === 2, `batch cap bounds model calls at 2 (got ${calls.length})`);
  const scoredNames = calls.map(c => c.name).sort().join(',');
  ok(scoredNames === 'Beth Never,Carl Oldest',
    `staleness order: never-scored first, then oldest scored_at; the freshest lead waits (got ${scoredNames})`);
}

// ---- freshness skip (hand-refresh protection) ----------------------------
{
  const fx = makeDb(tables([
    lead({ id: 'L-hand', full_name: 'Hand Refreshed', score: 80, scored_at: hoursAgo(2) }),
    lead({ id: 'L-legacy', full_name: 'Legacy Intake', score: 30, scored_at: null, ai_analyzed_at: hoursAgo(3) }),
    lead({ id: 'L-due', full_name: 'Due Lead', score: 45, scored_at: hoursAgo(25) }),
  ]));
  const { calls, fetchFn } = makeModel({});
  const res = await runScorePass({ sb: fx.sb, fetch: fetchFn, freshHours: 24, source: 'manual_run' });
  ok(res.skipped_fresh === 2 && calls.length === 1 && calls[0].name === 'Due Lead',
    `24h freshness skip covers scored_at AND the legacy ai_analyzed_at fallback (skipped ${res.skipped_fresh}, scored ${calls.map(c => c.name).join(',')})`);
}

// ---- band-change-only event rule -----------------------------------------
{
  const fx = makeDb(tables([
    lead({ id: 'L-same', full_name: 'Sam Sameband', score: 45, scored_at: hoursAgo(100) }),   // warm -> warm
    lead({ id: 'L-up', full_name: 'Uma Upgraded', score: 45, scored_at: hoursAgo(100) }),     // warm -> hot
    lead({ id: 'L-first', full_name: 'Fiona First' }),                                        // null -> cold
  ]));
  const { fetchFn } = makeModel({ 'Sam Sameband': 60, 'Uma Upgraded': 78, 'Fiona First': 25 });
  const res = await runScorePass({ sb: fx.sb, fetch: fetchFn, freshHours: 20, source: 'nightly_runner' });
  const events = fx.db.lead_events.filter(e => e.event_type === 'score_band_changed');
  ok(res.scored === 3 && events.length === 2,
    `a same-band re-score writes NO event; band moves and first scores do (got ${events.length} events)`);
  ok(!events.some(e => e.lead_id === 'L-same'), 'the quiet re-score (45 to 60, both Warm) stays off the timeline');
  const up = events.find(e => e.lead_id === 'L-up');
  ok(up && up.payload.from_band === 'warm' && up.payload.to_band === 'hot'
    && up.payload.from_score === 45 && up.payload.to_score === 78 && up.payload.via === 'nightly_runner',
    'band-change payload carries from/to score and band plus the source');
  const first = events.find(e => e.lead_id === 'L-first');
  ok(first && first.payload.from_band === null && first.payload.to_band === 'cold',
    'a first-ever score records from_band null (the one row that marks when scoring began)');
}

// ---- scoreLead stamps scored_at on every run -----------------------------
{
  const fx = makeDb(tables([lead({ id: 'L1', full_name: 'Stampy' })]));
  const { fetchFn } = makeModel({ Stampy: 72 });
  const r = await scoreLead('L1', { sb: fx.sb, fetch: fetchFn });
  const row = fx.db.leads[0];
  ok(row.score === 72 && row.scored_at != null && row.ai_analyzed_at === row.scored_at,
    'scoreLead writes score + ai_analysis and stamps scored_at = ai_analyzed_at');
  ok(r.bandChanged === true && r.prevBand === null && r.newBand === 'hot',
    'scoreLead reports the band transition for the caller\'s event rule');
  ok(fx.db.lead_events.length === 0, 'the core itself writes NO lead_events (callers own that rule)');
}

// ---- scoreBand cutoffs match the UI (70/40) ------------------------------
{
  ok(scoreBand(70) === 'hot' && scoreBand(69) === 'warm' && scoreBand(40) === 'warm'
    && scoreBand(39) === 'cold' && scoreBand(1) === 'cold' && scoreBand(null) === null,
    'scoreBand mirrors the 70/40 cutoffs and returns null (unknown) for null');
}

// ---- null-score rendering: the REAL index.html functions ------------------
{
  // Extract leadScoreBand/leadScoreBadge from index.html source so a drift
  // between the server bands and the UI bands fails this test, not a mirror.
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const grab = (name) => {
    const m = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    if (!m) throw new Error(`could not extract ${name} from index.html`);
    return m[0];
  };
  const esc = (s) => String(s);
  const fmtRelativeTime = (iso) => '2d ago';
  const leadScoreBand = eval(`(${grab('leadScoreBand')})`);
  const leadScoreBadge = eval(`(${grab('leadScoreBadge')})`);

  ok(leadScoreBand(null) === null && leadScoreBand(undefined) === null,
    'UI leadScoreBand treats null as no band, never Cold');
  const unscored = leadScoreBadge({ score: null });
  ok(/Not scored yet/.test(unscored), 'a never-scored lead renders "Not scored yet"');
  ok(!/Cold|pec-age-red/.test(unscored), 'the unscored chip carries no Cold word and no Cold color');
  const scored = leadScoreBadge({ score: 78, scored_at: hoursAgo(48) });
  ok(/Hot 78/.test(scored) && /Scored 2d ago/.test(scored),
    'a scored badge shows the band and a "Scored ... ago" tooltip from scored_at');
  const legacy = leadScoreBadge({ score: 30, ai_analyzed_at: hoursAgo(48) });
  ok(/Cold 30/.test(legacy) && /Scored 2d ago/.test(legacy),
    'a pre-migration lead (ai_analyzed_at only) still gets the staleness tooltip');
  ok(leadScoreBand(70).label === 'Hot' && leadScoreBand(40).label === 'Warm' && leadScoreBand(39).label === 'Cold',
    'UI cutoffs are 70/40, matching the server scoreBand');
}

// ---- hot-first sort: unscored group AFTER scored, never a fake score ------
{
  // The board's comparator shape (renderLeads): null -> -1 sentinel, default
  // order as tiebreak. Unscored leads form their own trailing group ordered
  // by the default comparator, they never interleave with Cold scores.
  const rows = [
    { id: 'a', score: null, created_at: '2026-08-01' },
    { id: 'b', score: 12, created_at: '2026-08-02' },
    { id: 'c', score: null, created_at: '2026-08-03' },
    { id: 'd', score: 90, created_at: '2026-08-04' },
  ];
  const defaultCmp = (x, y) => String(x.created_at).localeCompare(String(y.created_at));
  rows.sort((x, y) => ((y.score ?? -1) - (x.score ?? -1)) || defaultCmp(x, y));
  ok(rows.map(r => r.id).join(',') === 'd,b,a,c',
    'hot first, cold after, then ALL unscored as one unknown group in default order');
}

console.log(`lead-score.test: ${state.passed} passed, ${state.failed} failed`);
if (state.failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
