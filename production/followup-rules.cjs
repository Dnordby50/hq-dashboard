// Follow-up queue rules (prompt 98). PURE module, no I/O: the single source
// of truth for WHO is in the queue, what the clock says, and the
// deterministic fallback order. Required by netlify/functions/
// pec-followup-rank.cjs and pec-followup-digest.cjs; index.html carries a
// MIRROR of these functions for the client render (function pecFollowupRules,
// the pecInstallmentAsk precedent). Keep the two in lockstep: any change here
// must land in the mirror in the same commit, and production/followup.test.cjs
// asserts the numbers.
//
// Design rules (locked, prompts 49 + 98):
//   - Deterministic staleness decides membership; the AI only orders and
//     words. Its score can never remove a row.
//   - The clock answers "when did a PERSON last reach out": outbound calls,
//     outbound non-drip texts/emails, and pec_customer_notes rows with
//     counts_as_touch. Drip ledger sends NEVER reset it.
//   - Matching is customer_id first, then normalized phone, then email,
//     exactly the way leadContactStats() attributes rows (each log row
//     counted at most once). A lead-less, customer-less estimate (they
//     exist: est 102030) matches through its own customer_phone/email.
'use strict';

// Mirrors _pec-lead-match normPhone / index.html contactPhoneNorm: last 10
// digits, or null when too short to be a real number.
function normPhone(s) {
  const d = String(s == null ? '' : s).replace(/\D+/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

// Settings with the seeded defaults (missing row = default, the repo-wide
// convention). Accepts the raw {key: value} map.
function parseFollowupSettings(map) {
  const m = map || {};
  const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    enabled: m.followup_enabled !== 'false',
    overdueDays: num(m.followup_overdue_days_estimate_sent, 3),
    coldDays: num(m.followup_cold_days, 21),
    snoozeMaxDays: num(m.followup_snooze_max_days, 60),
    aiEnabled: m.followup_ai_rank_enabled !== 'false',
    aiLimit: num(m.followup_ai_rank_limit, 60),
    digestEnabled: m.followup_slack_digest_enabled !== 'false',
    digestTopN: num(m.followup_digest_top_n, 10),
    digestTime: /^\d{1,2}:\d{2}$/.test(String(m.followup_digest_time || '')) ? m.followup_digest_time : '07:30',
  };
}

// The identity keys a subject can be matched on. Customer id comes from the
// estimate first, then its lead; phone/email prefer the LEAD record (kept
// current) and fall back to the values frozen on the estimate.
function subjectKeys(est, lead) {
  return {
    customerId: est.customer_id || (lead && lead.customer_id) || null,
    phoneNorm: (lead && (lead.phone_norm || normPhone(lead.phone))) || normPhone(est.customer_phone),
    email: String((lead && lead.email) || est.customer_email || '').trim().toLowerCase() || null,
  };
}

// Human-touch stats for ONE subject from pre-fetched OUTBOUND logs.
// logs = { calls, texts, emails, notes } where calls/texts/emails are the
// same row shapes loadOutboundTouchLogs() returns (direction already
// filtered to 'out' by the loader) and notes are pec_customer_notes rows.
// Drip mirror rows (pec_sms_log.kind / pec_email_log.template_key in
// {drip, blast}) are excluded: automated sends do not reset the clock.
// Notes count only with counts_as_touch (a "walked in and paid" note logged
// as counts_as_touch=false is context, not outreach); a note matches by
// customer_id, by this estimate's id, or by lead_id.
function humanTouchesFor(keys, estId, leadId, logs) {
  const stats = { calls: 0, texts: 0, emails: 0, logged: 0, humanTotal: 0, humanLastAt: null };
  const bump = (kind, ts) => {
    stats[kind]++; stats.humanTotal++;
    if (ts && (!stats.humanLastAt || ts > stats.humanLastAt)) stats.humanLastAt = ts;
  };
  const matches = (r, phoneField, emailField) => {
    if (keys.customerId && r.customer_id === keys.customerId) return true;
    if (phoneField && keys.phoneNorm && normPhone(r[phoneField]) === keys.phoneNorm) return true;
    if (emailField && keys.email && String(r[emailField] || '').trim().toLowerCase() === keys.email) return true;
    return false;
  };
  for (const r of (logs.calls || [])) {
    if (matches(r, 'to_number', null)) bump('calls', r.occurred_at || r.created_at);
  }
  for (const r of (logs.texts || [])) {
    if (r.kind === 'drip' || r.kind === 'blast') continue;
    if (matches(r, 'to_number', null)) bump('texts', r.created_at);
  }
  for (const r of (logs.emails || [])) {
    if (r.template_key === 'drip' || r.template_key === 'blast') continue;
    if (matches(r, null, 'to_email')) bump('emails', r.sent_at);
  }
  for (const r of (logs.notes || [])) {
    if (r.counts_as_touch === false) continue;
    const hit = (keys.customerId && r.customer_id === keys.customerId)
      || (estId && r.estimate_id === estId)
      || (leadId && r.lead_id === leadId);
    if (hit) bump('logged', r.created_at);
  }
  return stats;
}

// Membership, deterministically. Returns one of:
//   'out'     not a queue subject at all (wrong status, deleted, dead lead,
//             snoozed) -> exits remove a row IMMEDIATELY, no nightly needed
//   'not_due' a live subject whose clock has not hit the threshold yet
//   'due'     in the Needs-contact list
//   'cold'    past the cold cutoff, collapsed Cold section
// The clock base is the last human touch, falling back to sent_at for a
// never-touched estimate (days since send IS the honest quiet time).
function membershipState(est, lead, humanLastAt, settings, now) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (est.status !== 'sent' || est.deleted_at) return { state: 'out', reason: est.deleted_at ? 'deleted' : `status ${est.status}` };
  if (lead && lead.archived_at) return { state: 'out', reason: 'lead archived' };
  if (lead && lead.stage === 'lost') return { state: 'out', reason: 'lead lost' };
  if (est.followup_snoozed_until && new Date(est.followup_snoozed_until).getTime() > nowMs) {
    return { state: 'out', reason: 'snoozed', snoozedUntil: est.followup_snoozed_until };
  }
  const clockBase = humanLastAt || est.sent_at || est.created_at;
  const daysQuiet = Math.floor((nowMs - new Date(clockBase).getTime()) / 86400000);
  const neverTouched = !humanLastAt;
  if (daysQuiet >= settings.coldDays) return { state: 'cold', daysQuiet, clockBase, neverTouched };
  if (daysQuiet >= settings.overdueDays) return { state: 'due', daysQuiet, clockBase, neverTouched };
  return { state: 'not_due', daysQuiet, clockBase, neverTouched };
}

// Deterministic ranking for when the model has not run or failed: the queue
// must never be empty or unordered (prompt 49, still binding). Order per
// prompt 98 decision 10: days since touch first, then engagement recency,
// then dollar value. Formula (documented so a surprising order is checkable
// by hand):
//   quiet   min(50, daysQuiet * 4)          the clock dominates
//   engage  viewed <=2d ago +25, <=7d +15;  a customer reading the proposal
//           inbound call/text <=7d +15      or reaching in is warm NOW
//           change request pending +10
//   value   price >= 10k +15, >= 5k +10, >= 2k +5
// Clamped to 1-100.
function fallbackPriority(sig, now) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const daysAgo = (iso) => iso ? (nowMs - new Date(iso).getTime()) / 86400000 : Infinity;
  let p = Math.min(50, (sig.daysQuiet || 0) * 4);
  const viewAge = daysAgo(sig.lastViewedAt);
  if (viewAge <= 2) p += 25; else if (viewAge <= 7) p += 15;
  if (daysAgo(sig.lastInboundAt) <= 7) p += 15;
  if (sig.hasChangeRequest) p += 10;
  const price = Number(sig.price) || 0;
  if (price >= 10000) p += 15; else if (price >= 5000) p += 10; else if (price >= 2000) p += 5;
  return Math.max(1, Math.min(100, Math.round(p)));
}

// The coaching-grade reject list (prompt 98 Part D3, an acceptance
// criterion, not a style note): openers that do not advance a decision are
// a build failure. Checked in CODE after every model call; a violating
// suggestion is regenerated, and the deterministic fallback copy must pass
// this list too. Returns the offending phrase or null.
const REJECT_PATTERNS = [
  [/check(?:ing)?\s+in\b/i, 'checking in'],
  [/follow(?:ing)?\s+up\b/i, 'following up'],
  [/touch(?:ing)?\s+base\b/i, 'touching base'],
  [/let me know if you have any questions/i, 'let me know if you have any questions'],
  [/just wanted to reach out\b/i, 'just wanted to reach out'],
];
function rejectListViolation(text) {
  const s = String(text || '');
  for (const [re, label] of REJECT_PATTERNS) if (re.test(s)) return label;
  return null;
}

// Deterministic fallback copy when the model is unavailable. Grounded in the
// playbook's only always-true value reasons (schedule position and a live
// question), asks for a decision, and passes the reject list by
// construction. Customer-facing: no em dashes.
function fallbackOpener(sig) {
  const first = String(sig.firstName || '').trim();
  const hi = first ? `Hi ${first}, ` : 'Hi, ';
  const amount = Number(sig.price) > 0 ? ` for ${'$' + Math.round(Number(sig.price)).toLocaleString('en-US')}` : '';
  return {
    opener: `${hi}this is ${sig.repName || 'Prescott Epoxy'}. We are setting the install schedule for the next couple of weeks and I want to know whether to hold a spot for your floor${amount}. Are you ready to pick a date, or is something still in the way I can help with?`,
    text: `${hi}we are locking in install dates for the next two weeks and I can hold one for your floor. Want me to save you a spot, or is there a question I can answer first?`,
    channel: 'call',
  };
}

module.exports = {
  normPhone, parseFollowupSettings, subjectKeys, humanTouchesFor,
  membershipState, fallbackPriority, rejectListViolation, fallbackOpener,
  REJECT_PATTERNS,
};
