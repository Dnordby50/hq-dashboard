// Follow-up queue engine (prompt 98): the shared core behind the nightly
// pec-followup-rank.cjs, the manual pec-followup-rank-run.cjs, and the
// pec-followup-digest.cjs Slack ticker. Membership and ordering RULES live
// in production/followup-rules.cjs (pure, mirrored in index.html); this file
// owns the I/O: gather, model call, rank upsert, digest post.
//
// The model orders and words; it NEVER decides membership, and its score can
// never remove a row. Any AI failure falls back to fallbackPriority +
// fallbackOpener so the table is never empty (prompt 49, still binding).
// Every model suggestion passes the deterministic reject list
// (rejectListViolation) and the drip scrubber (no em dashes, no invented
// links) IN CODE: "checking in on your proposal" is a build failure, not a
// wording nit. A violating batch gets ONE regenerate with the violations
// named; stragglers get the deterministic fallback copy.
//
// The AI never contacts a customer. This writes rows a human reads
// (pec_followup_ranks); Call/Text/copy actions are all human-initiated.
'use strict';

const { sb } = require('./_pec-supabase.cjs');
const { scrubCopy, capSms } = require('./_pec-drip.cjs');
const { PLAYBOOK } = require('./_pec-sales-playbook.cjs');
const rules = require('../../production/followup-rules.cjs');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.PEC_FOLLOWUP_MODEL || process.env.PEC_LEAD_AI_MODEL || 'claude-sonnet-5';
const SITE = process.env.URL || 'https://prescottepoxy.netlify.app';
// Prompt 49's cost decision: batch, never one call per subject. Sized DOWN
// from ~25 after Cowork's 2026-08-18 finding that synchronous invocations
// die at ~26s: one batch is one model call, and 8 subjects' worth of copy
// (~200 tokens each) completes inside the ceiling where 25 would not. Cost
// is unchanged (fewer subjects per call, same total tokens).
const BATCH_SIZE = 8;

async function loadSettingsMap(db) {
  try {
    const rows = await db('GET', '/settings?key=in.(followup_enabled,followup_overdue_days_estimate_sent,followup_cold_days,followup_snooze_max_days,followup_ai_rank_enabled,followup_ai_rank_limit,followup_slack_digest_enabled,followup_digest_top_n,followup_digest_time)&select=key,value');
    return Object.fromEntries((Array.isArray(rows) ? rows : []).map(r => [r.key, r.value]));
  } catch (e) {
    console.warn('_pec-followup: settings read failed, using defaults:', e && e.message);
    return {};
  }
}

// Gather everything the rules and the model need, in plain queries. The
// tables are small (hundreds of rows); per-subject queries would be more
// round trips for no gain, so the logs load whole, exactly like the client's
// loadOutboundTouchLogs().
async function gatherQueueData(db) {
  const [estimates, callsOut, callsIn, texts, textsIn, emails, notes, views, salesask] = await Promise.all([
    db('GET', '/estimates?status=eq.sent&deleted_at=is.null&select='
      + 'id,estimate_number,customer_id,lead_id,brand,price,sent_at,created_at,'
      + 'customer_name,customer_email,customer_phone,customer_address,'
      + 'change_request_note,company_notes,scope_of_work,'
      + 'followup_snoozed_until,followup_snooze_reason&limit=500'),
    db('GET', '/pec_call_log?direction=eq.out&select=customer_id,to_number,occurred_at,created_at&limit=3000'),
    db('GET', '/pec_call_log?direction=eq.in&select=customer_id,from_number,occurred_at,created_at&limit=3000'),
    db('GET', '/pec_sms_log?direction=eq.out&status=neq.failed&select=customer_id,to_number,created_at,kind&limit=3000'),
    db('GET', '/pec_sms_log?direction=eq.in&select=customer_id,from_number,created_at&limit=3000'),
    db('GET', '/pec_email_log?status=neq.failed&select=customer_id,to_email,sent_at,template_key&limit=3000'),
    db('GET', '/pec_customer_notes?select=customer_id,lead_id,estimate_id,counts_as_touch,created_at&limit=3000')
      .catch(() => []), // pre-migration tolerance
    db('GET', '/pec_estimate_views?select=estimate_id,viewed_at&order=viewed_at.desc&limit=3000'),
    db('GET', '/pec_salesask_recordings?select=customer_id,lead_id,occurred_at,title,summary&order=occurred_at.desc&limit=200'),
  ]);
  const leadIds = [...new Set((estimates || []).map(e => e.lead_id).filter(Boolean))];
  const leads = leadIds.length
    ? await db('GET', `/leads?id=in.(${leadIds.map(encodeURIComponent).join(',')})&select=id,customer_id,first_name,full_name,phone,phone_norm,email,stage,archived_at,score,scored_at,notes,ai_analysis`)
    : [];
  return {
    estimates: estimates || [],
    leadsById: Object.fromEntries((leads || []).map(l => [l.id, l])),
    logs: { calls: callsOut || [], texts: texts || [], emails: emails || [], notes: notes || [] },
    inbound: { calls: callsIn || [], texts: textsIn || [] },
    views: views || [],
    salesask: salesask || [],
  };
}

// One queue row per LIVE subject (due or cold), with the deterministic
// inputs the model will see and the fallback priority already computed.
function computeQueue(data, settings, now) {
  const nowMs = now.getTime();
  const viewsByEst = {};
  for (const v of data.views) {
    const b = (viewsByEst[v.estimate_id] ||= { count: 0, lastAt: null });
    b.count++;
    if (!b.lastAt || v.viewed_at > b.lastAt) b.lastAt = v.viewed_at;
  }
  const rows = [];
  for (const est of data.estimates) {
    const lead = est.lead_id ? data.leadsById[est.lead_id] || null : null;
    const keys = rules.subjectKeys(est, lead);
    const touch = rules.humanTouchesFor(keys, est.id, est.lead_id, data.logs);
    const m = rules.membershipState(est, lead, touch.humanLastAt, settings, now);
    if (m.state === 'out' || m.state === 'not_due') continue;

    // Inbound engagement since the estimate went out: a customer reaching IN
    // is the warmest signal the queue has.
    const sentMs = new Date(est.sent_at || est.created_at).getTime();
    let inCalls = 0, inTexts = 0, lastInboundAt = null;
    const inMatch = (r) => (keys.customerId && r.customer_id === keys.customerId)
      || (keys.phoneNorm && rules.normPhone(r.from_number) === keys.phoneNorm);
    for (const r of data.inbound.calls) {
      const ts = r.occurred_at || r.created_at;
      if (ts && new Date(ts).getTime() >= sentMs && inMatch(r)) { inCalls++; if (!lastInboundAt || ts > lastInboundAt) lastInboundAt = ts; }
    }
    for (const r of data.inbound.texts) {
      if (r.created_at && new Date(r.created_at).getTime() >= sentMs && inMatch(r)) { inTexts++; if (!lastInboundAt || r.created_at > lastInboundAt) lastInboundAt = r.created_at; }
    }

    const v = viewsByEst[est.id] || { count: 0, lastAt: null };
    const rec = data.salesask.find(r => (keys.customerId && r.customer_id === keys.customerId)
      || (est.lead_id && r.lead_id === est.lead_id)) || null;

    const signals = {
      daysQuiet: m.daysQuiet,
      neverTouched: m.neverTouched,
      humanTouches: touch,
      price: est.price != null ? Number(est.price) : null,
      daysSinceSent: Math.floor((nowMs - sentMs) / 86400000),
      viewCount: v.count,
      lastViewedAt: v.lastAt,
      inboundCalls: inCalls,
      inboundTexts: inTexts,
      lastInboundAt,
      hasChangeRequest: !!est.change_request_note,
      changeRequestNote: est.change_request_note ? String(est.change_request_note).slice(0, 300) : null,
      leadScore: lead ? lead.score : null,
      leadBand: lead && lead.score != null ? (lead.score >= 70 ? 'hot' : lead.score >= 40 ? 'warm' : 'cold') : null,
      salesaskSummary: rec && rec.summary ? String(rec.summary).slice(0, 1200) : null,
      salesaskAt: rec ? rec.occurred_at : null,
      firstName: (lead && lead.first_name) || String(est.customer_name || '').split(' ')[0] || null,
    };
    rows.push({
      subject_type: 'estimate',
      subject_id: est.id,
      est, lead, keys, state: m.state, signals,
      fallback: rules.fallbackPriority(signals, now),
    });
  }
  // Cold after live, both fallback-ordered for now; the AI reorders live rows.
  rows.sort((a, b) => (a.state === b.state ? b.fallback - a.fallback : a.state === 'due' ? -1 : 1));
  return rows;
}

// ---- the model call -------------------------------------------------------

const SYSTEM_PROMPT = `You are the sales follow-up coach for Prescott Epoxy Company (PEC), an epoxy floor coating company in Prescott, Arizona. You rank sent estimates that are overdue for a HUMAN follow-up touch and write the exact follow-up the rep should make, at the standard a top coach (Chuck Thokey, Tommy Mello) would hold them to.

THE COMPANY'S OWN PLAYBOOK (ground every suggestion in it):
${PLAYBOOK}

For EACH subject you receive, return:
- "score": 1-100, how urgently a human should contact them TODAY (engagement recency, dollars at stake, and staleness all matter).
- "why_now": one internal sentence citing SPECIFIC facts from the supplied data (views, inbound contact, days quiet, value). Never invent a fact.
- "opener": ONE spoken line to open a phone call. Customer-facing.
- "text": a ready-to-send SMS under 280 characters. Customer-facing.
- "channel": "call", "text", or "email", your recommended first move.

HARD RULES for opener and text (violations are rejected by code and cost a retry):
- Ground each one in what actually happened: when a sales visit summary is supplied, reference something concrete from THAT conversation; otherwise use the estimate's own facts (what was viewed, what was asked, the space, the price).
- Every suggestion must advance a decision: ask for a yes, a no, or a specific next step with a date.
- State a reason for the call that serves the CUSTOMER (a scheduling window, a price validity, an open question from the visit, a material lead time you were given in the data), never the rep's pipeline.
- BANNED phrases: "checking in", "following up", "follow up", "touching base", "touch base", "let me know if you have any questions", "just wanted to reach out".
- No em dashes anywhere. No links. No prices that were not in the supplied data. No invented promises, discounts, or dates.
- The rep sends these by hand; you never contact anyone.

Respond with ONLY a JSON array, no markdown fences: [{"subject_id": "...", "score": <int>, "why_now": "...", "opener": "...", "text": "...", "channel": "call|text|email"}] with exactly one entry per supplied subject.`;

function subjectPromptBlock(row) {
  const s = row.signals;
  return JSON.stringify({
    subject_id: row.subject_id,
    customer: row.est.customer_name || (row.lead && row.lead.full_name) || null,
    first_name: s.firstName,
    estimate_number: row.est.estimate_number,
    price: s.price,
    days_since_sent: s.daysSinceSent,
    days_since_last_human_touch: s.daysQuiet,
    never_touched_by_human: s.neverTouched,
    human_touches_so_far: { calls: s.humanTouches.calls, texts: s.humanTouches.texts, emails: s.humanTouches.emails, logged: s.humanTouches.logged },
    estimate_views: { count: s.viewCount, last_viewed_at: s.lastViewedAt },
    inbound_since_sent: { calls: s.inboundCalls, texts: s.inboundTexts, last_at: s.lastInboundAt },
    portal_change_request: s.changeRequestNote,
    lead_ai_score: s.leadScore, lead_band: s.leadBand,
    sales_visit_summary: s.salesaskSummary,
    sales_visit_at: s.salesaskAt,
    scope_excerpt: row.est.scope_of_work ? String(row.est.scope_of_work).slice(0, 400) : null,
    internal_notes: [row.est.company_notes, row.lead && row.lead.notes].filter(Boolean).join(' | ').slice(0, 400) || null,
  });
}

function textFromMessage(out) {
  const blocks = (out && Array.isArray(out.content)) ? out.content : [];
  const text = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
  if (!text) throw new Error(`no text block in model response (stop_reason=${out && out.stop_reason})`);
  return text;
}

async function callModel(fetchFn, messages) {
  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2500, system: SYSTEM_PROMPT, messages }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const raw = textFromMessage(await res.json()).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error('model did not return an array');
  return arr;
}

// Validate + scrub one model suggestion; returns null when it must be
// regenerated. The reject list and the em-dash scrub are enforced HERE, in
// code, not in the prompt wording alone.
function cleanSuggestion(item) {
  if (!item || typeof item !== 'object') return null;
  const score = Math.max(1, Math.min(100, Math.round(Number(item.score) || 0)));
  const opener = scrubCopy(item.opener);
  const text = capSms(scrubCopy(item.text), 480);
  const why = String(item.why_now || '').slice(0, 500);
  if (!opener || !text || !why || !score) return null;
  if (rules.rejectListViolation(opener) || rules.rejectListViolation(text)) return null;
  return {
    score, why_now: why, opener, text,
    channel: ['call', 'text', 'email'].includes(item.channel) ? item.channel : 'call',
  };
}

// Rank the live (due) rows with the model in batches; cold rows keep the
// fallback. Returns per-subject results keyed by subject_id, each with
// source 'ai' or 'fallback'.
async function aiRank(liveRows, settings, fetchFn) {
  const results = {};
  const capped = liveRows.slice(0, settings.aiLimit);
  for (let i = 0; i < capped.length; i += BATCH_SIZE) {
    const batch = capped.slice(i, i + BATCH_SIZE);
    const userMsg = `SUBJECTS (${batch.length}):\n` + batch.map(subjectPromptBlock).join('\n')
      + `\nCURRENT TIME: ${new Date().toISOString()}`;
    let byId = {};
    try {
      const first = await callModel(fetchFn, [{ role: 'user', content: userMsg }]);
      for (const item of first) byId[item && item.subject_id] = cleanSuggestion(item);
      // One regenerate for the rejects, with the violations named, the same
      // way the drip scrubber loops. Anything still dirty falls back.
      const bad = batch.filter(r => !byId[r.subject_id]);
      if (bad.length) {
        const feedback = bad.map(r => {
          const raw = first.find(it => it && it.subject_id === r.subject_id);
          const v = raw ? (rules.rejectListViolation(String(raw.opener || '')) || rules.rejectListViolation(String(raw.text || '')) || 'missing or invalid fields') : 'missing entry';
          return `${r.subject_id}: ${v}`;
        }).join('; ');
        const retry = await callModel(fetchFn, [
          { role: 'user', content: userMsg },
          { role: 'assistant', content: JSON.stringify(first) },
          { role: 'user', content: `These entries were REJECTED (${feedback}). Banned-phrase or missing-field violations. Regenerate ONLY those subjects, same JSON array format, obeying every hard rule.` },
        ]);
        for (const item of retry) {
          const c = cleanSuggestion(item);
          if (c && !byId[item.subject_id]) byId[item.subject_id] = c;
        }
      }
    } catch (err) {
      console.warn('_pec-followup: model batch failed, falling back:', err && err.message);
      byId = {};
    }
    for (const row of batch) {
      const c = byId[row.subject_id];
      results[row.subject_id] = c
        ? { ...c, source: 'ai' }
        : { ...fallbackCopyFor(row), score: row.fallback, source: 'fallback' };
    }
  }
  return results;
}

function fallbackCopyFor(row) {
  const fb = rules.fallbackOpener({ firstName: row.signals.firstName, price: row.signals.price, repName: null });
  return {
    why_now: `${row.signals.daysQuiet} days since a human touch on a ${row.signals.price != null ? '$' + Math.round(row.signals.price).toLocaleString('en-US') : 'priceless'} estimate (deterministic ranking; the AI run did not cover this row).`,
    opener: fb.opener, text: fb.text, channel: fb.channel,
  };
}

// Upsert one pec_followup_ranks row per subject. GET-then-write (the
// writeHeartbeat pattern): sb()'s headers are fixed, and the nightly run
// never races itself. Also delete rank rows for subjects that left the
// queue so the table mirrors reality.
async function upsertRanks(db, ranked, settings, extra) {
  let rank = 0;
  const keptIds = [];
  for (const row of ranked) {
    rank++;
    keptIds.push(row.subject_id);
    const r = row.result;
    const payload = {
      subject_type: 'estimate',
      subject_id: row.subject_id,
      rank,
      score: r.score,
      why_now: r.why_now,
      suggested_opener: r.opener,
      suggested_text: r.text,
      suggested_channel: r.channel,
      source: r.source,
      model: r.source === 'ai' ? MODEL : null,
      inputs: row.signals,
      ranked_at: new Date().toISOString(),
    };
    const existing = await db('GET', `/pec_followup_ranks?subject_type=eq.estimate&subject_id=eq.${encodeURIComponent(row.subject_id)}&select=id&limit=1`);
    if (Array.isArray(existing) && existing.length) {
      await db('PATCH', `/pec_followup_ranks?subject_type=eq.estimate&subject_id=eq.${encodeURIComponent(row.subject_id)}`, payload);
    } else {
      await db('POST', '/pec_followup_ranks', payload);
    }
  }
  // Stale rows: subjects no longer in the queue (decided, snoozed, lost).
  try {
    const all = await db('GET', '/pec_followup_ranks?subject_type=eq.estimate&select=subject_id');
    const stale = (all || []).map(r => r.subject_id).filter(id => !keptIds.includes(id));
    if (stale.length) {
      await db('DELETE', `/pec_followup_ranks?subject_type=eq.estimate&subject_id=in.(${stale.map(encodeURIComponent).join(',')})`);
    }
  } catch (e) { console.warn('_pec-followup: stale rank cleanup failed (non-fatal):', e && e.message); }
  return { written: keptIds.length };
}

// The whole rank pass. deps: { sb, fetch, now } injectable for tests.
async function runFollowupRank(deps = {}) {
  const db = deps.sb || sb;
  const fetchFn = deps.fetch || fetch;
  const now = deps.now ? deps.now() : new Date();
  const settings = rules.parseFollowupSettings(await loadSettingsMap(db));
  if (!settings.enabled) return { ok: true, skipped: 'followup_enabled is false' };

  const data = await gatherQueueData(db);
  const queue = computeQueue(data, settings, now);
  const live = queue.filter(r => r.state === 'due');
  const cold = queue.filter(r => r.state === 'cold');

  let results = {};
  if (settings.aiEnabled && (ANTHROPIC_API_KEY || deps.fetch) && live.length) {
    results = await aiRank(live, settings, fetchFn);
  }
  // Rank rows are written for DUE subjects only: the Cold section is a
  // collapsed tail the client renders with fallback ordering, and keeping
  // the table due-only makes the nav badge an honest one-line head count.
  const withResults = live.map(row => ({
    ...row,
    result: results[row.subject_id]
      || { ...fallbackCopyFor(row), score: row.fallback, source: 'fallback' },
  }));
  // Final order: model score, fallbackPriority as the tiebreak.
  withResults.sort((a, b) => (b.result.score - a.result.score) || (b.fallback - a.fallback));
  const up = await upsertRanks(db, withResults, settings);
  const aiCount = withResults.filter(r => r.result.source === 'ai').length;
  return { ok: true, live: live.length, cold: cold.length, written: up.written, ai: aiCount, fallback: withResults.length - aiCount };
}

// ---- Slack digest ---------------------------------------------------------

// Phoenix wall clock (UTC-7 fixed, no DST; repo convention).
function phoenixParts(now) {
  const p = new Date(now.getTime() - 7 * 3600 * 1000);
  return {
    dayStr: p.toISOString().slice(0, 10),
    minutes: p.getUTCHours() * 60 + p.getUTCMinutes(),
  };
}

// Once-a-day digest at the settings-controlled Phoenix time. Runs on a
// 15-minute schedule; the "already sent today" marker is an ingest-log row
// (endpoint 'followup-digest'), reusing existing observability instead of a
// state table (state is not a setting, rule 12). Skips ENTIRELY when the
// queue is empty: no "nothing to do today" noise.
async function runFollowupDigest(deps = {}) {
  const db = deps.sb || sb;
  const fetchFn = deps.fetch || fetch;
  const now = deps.now ? deps.now() : new Date();
  const settings = rules.parseFollowupSettings(await loadSettingsMap(db));
  if (!settings.enabled || !settings.digestEnabled) return { ok: true, skipped: 'digest disabled' };

  const { dayStr, minutes } = phoenixParts(now);
  const [hh, mm] = settings.digestTime.split(':').map(Number);
  if (minutes < hh * 60 + mm) return { ok: true, skipped: 'before digest time' };

  // Already sent today? (ingest-log dedupe; the log write below is the marker)
  const since = new Date(now.getTime() - 7 * 3600 * 1000);
  since.setUTCHours(0, 0, 0, 0);
  const sinceUtc = new Date(since.getTime() + 7 * 3600 * 1000).toISOString();
  try {
    const sent = await db('GET', `/pec_webhook_ingest_log?endpoint=eq.followup-digest&outcome=eq.ok&created_at=gte.${encodeURIComponent(sinceUtc)}&select=id&limit=1`);
    if (Array.isArray(sent) && sent.length) return { ok: true, skipped: 'already sent today' };
  } catch (e) { console.warn('_pec-followup: digest dedupe read failed:', e && e.message); }

  const data = await gatherQueueData(db);
  const queue = computeQueue(data, settings, now).filter(r => r.state === 'due');
  if (!queue.length) return { ok: true, skipped: 'queue empty' };

  // Order by the stored ranks where present.
  let ranks = [];
  try { ranks = await db('GET', '/pec_followup_ranks?subject_type=eq.estimate&select=subject_id,rank,why_now') || []; } catch (_) {}
  const rankBy = Object.fromEntries(ranks.map(r => [r.subject_id, r]));
  queue.sort((a, b) => ((rankBy[a.subject_id] || {}).rank || 999) - ((rankBy[b.subject_id] || {}).rank || 999) || b.fallback - a.fallback);

  const hook = process.env.SLACK_OFFICE_WEBHOOK || process.env.SLACK_LEADS_WEBHOOK;
  if (!hook) { console.log('_pec-followup: no Slack webhook set (SLACK_OFFICE_WEBHOOK / SLACK_LEADS_WEBHOOK); digest skipped'); return { ok: true, skipped: 'no webhook' }; }

  const top = queue.slice(0, settings.digestTopN);
  const lines = [
    `:telephone_receiver: *Follow-up queue: ${queue.length} estimate${queue.length === 1 ? '' : 's'} need a human touch*`,
    ...top.map((r, i) => {
      const price = r.signals.price != null ? ` $${Math.round(r.signals.price).toLocaleString('en-US')}` : '';
      const why = (rankBy[r.subject_id] || {}).why_now || `${r.signals.daysQuiet} days quiet`;
      return `${i + 1}. *${r.est.customer_name || 'Unknown'}*${price}, ${r.signals.daysQuiet}d quiet: ${why}`;
    }),
    `<${SITE}/#followups|Open the Follow-ups queue>`,
  ];
  const res = await fetchFn(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: lines.join('\n') }),
  });
  if (!res.ok) throw new Error(`Slack webhook ${res.status}`);
  // The marker row that makes tomorrow's dedupe work.
  const { logIngest } = require('./_pec-supabase.cjs');
  if (deps.logIngest) await deps.logIngest({ endpoint: 'followup-digest', outcome: 'ok', status_code: 200, message: `digest sent: ${queue.length} due, top ${top.length}` });
  else await logIngest({ endpoint: 'followup-digest', outcome: 'ok', status_code: 200, message: `digest sent: ${queue.length} due, top ${top.length}` });
  return { ok: true, sent: top.length, due: queue.length, day: dayStr };
}

module.exports = {
  runFollowupRank, runFollowupDigest, gatherQueueData, computeQueue,
  loadSettingsMap, aiRank, cleanSuggestion, upsertRanks, SYSTEM_PROMPT, MODEL,
};
