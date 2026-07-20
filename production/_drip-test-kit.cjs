// Shared harness for the drip-engine fixture tests (drip-runner.test.cjs =
// Phase 2 lead behavior, drip-phase3.test.cjs = subjects/estimate/invoice/
// blast). Extracted so both suites drive the REAL engine code against the
// same mini-PostgREST; the stub enforces the SAME constraints prod does
// (Phase 3 shape: one active enrollment per subject per campaign).
'use strict';

// ---------------------------------------------------------------------------
// Mini PostgREST over in-memory tables: supports the operators the engine
// uses (eq, lte, gt, in.(...), is.null, ilike.*suffix, or=(...)), plus
// order/limit/select and conditional PATCH (the atomicity the claim relies
// on: filter + apply happen synchronously in one call).
// ---------------------------------------------------------------------------
function makeDb(tables) {
  const db = JSON.parse(JSON.stringify(tables));
  let idSeq = 1000;
  const calls = { patch: [], post: [] };

  function matches(row, key, val) {
    if (val.startsWith('eq.')) return String(row[key]) === val.slice(3);
    if (val.startsWith('lte.')) return row[key] != null && String(row[key]) <= decodeURIComponent(val.slice(4));
    if (val.startsWith('gte.')) return row[key] != null && String(row[key]) >= decodeURIComponent(val.slice(4));
    if (val.startsWith('gt.')) return row[key] != null && String(row[key]) > decodeURIComponent(val.slice(3));
    if (val.startsWith('neq.')) return String(row[key]) !== val.slice(4);
    if (val === 'is.null') return row[key] == null;
    if (val === 'not.is.null') return row[key] != null;
    if (val.startsWith('in.(')) return val.slice(4, -1).split(',').includes(String(row[key]));
    if (val.startsWith('ilike.')) {
      const pat = decodeURIComponent(val.slice(6));
      const s = String(row[key] || '').toLowerCase();
      if (pat.startsWith('*')) return s.endsWith(pat.slice(1).toLowerCase());
      return s === pat.toLowerCase();
    }
    throw new Error(`stub: unsupported op ${key}=${val}`);
  }
  function matchesOr(row, orExpr) {
    // (a.eq.b,c.ilike.*d)
    const parts = decodeURIComponent(orExpr).slice(1, -1).split(',');
    return parts.some(p => {
      const i1 = p.indexOf('.');
      const key = p.slice(0, i1);
      return matches(row, key, p.slice(i1 + 1));
    });
  }
  function query(table, params) {
    let rows = db[table].filter(row => {
      for (const [k, v] of params) {
        if (['select', 'order', 'limit'].includes(k)) continue;
        if (k === 'or') { if (!matchesOr(row, v)) return false; continue; }
        if (!matches(row, k, v)) return false;
      }
      return true;
    });
    const order = params.find(([k]) => k === 'order');
    if (order) {
      const [col, dir] = order[1].split('.');
      rows = rows.slice().sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')) * (dir === 'desc' ? -1 : 1));
    }
    const limit = params.find(([k]) => k === 'limit');
    if (limit) rows = rows.slice(0, Number(limit[1]));
    return rows;
  }

  async function sb(method, path, payload, returnRow) {
    const [p, qs = ''] = path.split('?');
    const table = p.replace(/^\//, '');
    const params = qs ? qs.split('&').map(kv => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    }) : [];
    if (!db[table]) throw new Error(`stub: no table ${table}`);
    if (method === 'GET') return JSON.parse(JSON.stringify(query(table, params)));
    if (method === 'PATCH') {
      const rows = query(table, params);
      rows.forEach(r => Object.assign(r, payload));
      calls.patch.push({ table, params, payload, matched: rows.length });
      return returnRow ? JSON.parse(JSON.stringify(rows)) : null;
    }
    if (method === 'POST') {
      // Enforce the Phase 3 partial unique index: one ACTIVE enrollment per
      // (subject_type, subject_id, campaign_id). Legacy inserts without
      // subject columns are treated as lead subjects, like the backfill does.
      if (table === 'pec_drip_enrollments' && payload.status === 'active') {
        const st = payload.subject_type || 'lead';
        const sid = payload.subject_id || payload.lead_id;
        if (db[table].some(r => (r.subject_type || 'lead') === st
          && String(r.subject_id || r.lead_id) === String(sid)
          && String(r.campaign_id) === String(payload.campaign_id)
          && r.status === 'active')) {
          throw new Error(`Supabase POST /${table} failed (409): duplicate key value violates unique constraint "idx_pec_drip_enroll_one_active_subj"`);
        }
      }
      // Enforce the prompt-37 reminder-ledger unique index, the claim the
      // appointment engine's exactly-once guarantee rides on.
      if (table === 'pec_appointment_reminder_sends') {
        if (db[table].some(r => String(r.appointment_id) === String(payload.appointment_id)
          && String(r.rule_id) === String(payload.rule_id)
          && String(r.channel) === String(payload.channel))) {
          throw new Error(`Supabase POST /${table} failed (409): duplicate key value violates unique constraint "uq_pec_appt_reminder_send"`);
        }
      }
      const row = { id: 'row' + (idSeq++), created_at: new Date().toISOString(), ...payload };
      db[table].push(row);
      calls.post.push({ table, payload });
      return returnRow ? [JSON.parse(JSON.stringify(row))] : null;
    }
    throw new Error(`stub: method ${method}`);
  }
  return { db, sb, calls };
}

// Fixed clock: 2026-07-20 17:00:00 UTC = 10:00 Phoenix (inside quiet window).
const NOW_IN_WINDOW = new Date('2026-07-20T17:00:00Z');
// 10:00 UTC = 03:00 Phoenix (outside window, before open).
const NOW_BEFORE_OPEN = new Date('2026-07-20T10:00:00Z');
// 04:00 UTC = 21:00 Phoenix previous evening (outside, after close).
const NOW_AFTER_CLOSE = new Date('2026-07-21T04:00:00Z');

const CAMP = { id: 'camp1', name: 'Lead follow-up', kind: 'lead', status: 'active', mode: 'dry_run', max_touches: 8 };
const STEPS = [
  { id: 's0', campaign_id: 'camp1', step_index: 0, day_offset: 1, channel: 'both', ai_guidance: 'first touch', email_subject: 'Your epoxy floor project', active: true },
  { id: 's1', campaign_id: 'camp1', step_index: 1, day_offset: 2, channel: 'sms', ai_guidance: 'nudge', email_subject: null, active: true },
  { id: 's2', campaign_id: 'camp1', step_index: 2, day_offset: 4, channel: 'email', ai_guidance: 'value', email_subject: 'What makes it last', active: true },
];
function baseTables(over = {}) {
  return {
    settings: [{ id: 'set1', key: 'drip_sending_enabled', value: 'true' }],
    pec_drip_campaigns: [{ ...CAMP }],
    pec_drip_steps: STEPS.map(s => ({ ...s })),
    pec_drip_enrollments: [{
      id: 'enr1', subject_type: 'lead', subject_id: 'lead1', lead_id: 'lead1',
      campaign_id: 'camp1', status: 'active',
      next_step_index: 0, next_send_at: '2026-07-20T16:00:00Z',
      enrolled_at: '2026-07-19T16:00:00Z', stop_reason: null, stopped_at: null,
    }],
    leads: [{
      id: 'lead1', full_name: 'Jane Doe', first_name: 'Jane', phone: '9285551234',
      phone_norm: '9285551234', email: 'jane@example.com', stage: 'new',
      sms_consent: true, opted_out: false, customer_id: null, contacted_at: null,
      deleted_at: null, source: 'meta', campaign: null, city: 'Prescott', notes: 'garage floor',
      created_at: '2026-07-19T15:00:00Z',
    }],
    estimates: [], jobs: [], customers: [], pec_payments: [], pec_blasts: [],
    pec_sms_log: [], pec_call_log: [], pec_email_log: [], pec_drip_sends: [],
    pec_sms_senders: [{ brand: 'prescott-epoxy', from_number: '+19280001111', active: true }],
    pec_email_senders: [{ brand: 'prescott-epoxy', from_name: 'Prescott Epoxy', from_email: 'hello@prescottepoxy.com', reply_to: 'dylan@prescottepoxy.com' }],
    ...over,
  };
}

function stubDeps(fx, opts = {}) {
  const providers = { sms: [], email: [], ai: [] };
  return {
    providers,
    deps: {
      sb: fx.sb,
      now: () => opts.now || NOW_IN_WINDOW,
      // Real signature is (ctx, step, campaign, needs) where ctx is the
      // resolveRecipient result; ctx.lead is the lead row for lead subjects.
      renderCopy: async (ctx, step, campaign, needs) => {
        providers.ai.push({ step: step.step_index, needs, kind: campaign.kind });
        if (opts.aiThrows) throw new Error('model exploded');
        const first = ctx.first_name || (ctx.lead && ctx.lead.first_name) || 'there';
        return {
          sms: needs.sms ? `Hi ${first}, this is Prescott Epoxy checking in about your floor.` : null,
          email_subject: needs.email ? (step.email_subject || 'Hello') : null,
          email_body: needs.email ? `Hi ${first},\n\nStill happy to help with your floor.\n\nthe Prescott Epoxy team` : null,
        };
      },
      sendSms: async (p) => { providers.sms.push(p); return opts.smsFails ? { ok: false, id: null, error: 'quo 500' } : { ok: true, id: 'quo-msg-' + providers.sms.length, error: null }; },
      sendEmail: async (p) => { providers.email.push(p); return { ok: true, id: 'resend-' + providers.email.length, error: null }; },
    },
  };
}

function makeChecker() {
  const state = { passed: 0, failed: 0 };
  const ok = (cond, msg) => {
    if (cond) { state.passed++; console.log('  ok  ', msg); }
    else { state.failed++; console.error('  FAIL', msg); }
  };
  return { state, ok };
}

module.exports = {
  makeDb, baseTables, stubDeps, makeChecker,
  NOW_IN_WINDOW, NOW_BEFORE_OPEN, NOW_AFTER_CLOSE, CAMP, STEPS,
};
