// Shared invoice-installment core (prompt 45: partial invoicing, required
// deposits, payment schedules). ONE invoice per job, unchanged; this module
// owns the job's schedule of installments and the single definition of "the
// current amount due" that the public pay page, Stripe checkout, the reminder
// drip, and the staff UI all resolve through. index.html carries a client
// mirror of resolveCurrentAsk (pecInstallmentAsk) for display; THIS file is
// the fixture-tested authority -- keep the two in lockstep.
//
// Dependency direction: this module requires NOTHING from _pec-drip.cjs.
// _pec-drip.cjs requires this module (the invoice reminder adapter resolves
// the current ask), and runInstallmentTriggers takes its provider helpers via
// injected deps (pec-drip-runner.cjs wires the real Quo/Resend helpers), so
// there is no circular require and the fixture tests can stub every provider.
'use strict';

const EPS = 0.005;                 // same money epsilon as the AR predicates
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const usd = (n) => '$' + Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
// America/Phoenix is UTC-7 year round (no DST); date-only, for 'date' triggers.
const phoenixTodayIso = (now = new Date()) => new Date(now.getTime() - 7 * 3600 * 1000).toISOString().slice(0, 10);

// Dollar amount of one installment line at the current job total.
function computeInstallmentAmount(kind, value, jobTotal) {
  const v = Number(value) || 0;
  if (kind === 'percent') return round2((Number(jobTotal) || 0) * v / 100);
  return round2(v);
}

// Ask-chain order: the deposit line first (locked decision: the deposit is
// always the first money in, whether it is schedule line #1 or standalone),
// then seq, then created_at/id as stable tiebreaks.
function orderInstallments(installments) {
  return [...(installments || [])].sort((a, b) =>
    ((b.is_deposit ? 1 : 0) - (a.is_deposit ? 1 : 0))
    || ((Number(a.seq) || 0) - (Number(b.seq) || 0))
    || String(a.created_at || '').localeCompare(String(b.created_at || ''))
    || String(a.id || '').localeCompare(String(b.id || '')));
}

// Has this installment's trigger fired, for the ASK chain? Job milestones are
// read off jobs.status, which the unified status machine (client
// deriveJobStatus + the DB trigger) keeps in lockstep with the schedule:
//   on_acceptance -> always (the job row only exists because an acceptance /
//                    job creation happened; signed_date is stamped then)
//   on_start      -> status in_progress or completed (deriveJobStatus rule 3:
//                    first scheduled day <= today flips to in_progress)
//   on_completion -> status completed (manual completion is the source of
//                    truth since prompt 40; markJobComplete stamps it)
//   date          -> due_date has arrived (schema headroom; no UI yet)
//   manual        -> only once staff have pushed it (queued/sent), never on
//                    its own
// A row already sent or held for approval counts as fired regardless: the ask
// was (or is about to be) communicated.
function askTriggerFired(inst, job, todayIso) {
  if (inst.status === 'sent' || inst.status === 'pending_approval' || inst.status === 'queued') return true;
  const st = (job && job.status) || '';
  switch (inst.trigger_kind) {
    case 'on_acceptance': return true;
    case 'on_start': return st === 'in_progress' || st === 'completed';
    case 'on_completion': return st === 'completed';
    case 'date': return !!inst.due_date && String(inst.due_date) <= String(todayIso);
    default: return false;               // 'manual' and unknowns wait for staff
  }
}

// Should the milestone RUNNER queue this planned installment? Same milestone
// predicates as the ask chain, minus the status short-circuits (the runner
// only ever looks at 'planned' rows) and minus 'manual' (never auto-queues).
function queueTriggerFired(inst, job, todayIso) {
  const st = (job && job.status) || '';
  switch (inst.trigger_kind) {
    case 'on_acceptance': return true;
    case 'on_start': return st === 'in_progress' || st === 'completed';
    case 'on_completion': return st === 'completed';
    case 'date': return !!inst.due_date && String(inst.due_date) <= String(todayIso);
    default: return false;
  }
}

// Sequential payment allocation: the job's TOTAL received payments fill the
// ordered installments front to back (money is fungible; the deposit is first
// in line by construction). An installment is SETTLED when the cumulative
// applied payments cover its snapshot amount (>= computed_amount - EPS).
// jobs.deposit_collected also settles the deposit line (a flag-only "mark
// collected" has no payment row to allocate), and deposit_waived removes it
// from the chain entirely, matching the legacy deposit semantics.
function allocatePayments(ordered, paidTotal, job) {
  let cum = 0;
  return ordered.map(inst => {
    const amt = round2(inst.computed_amount);
    let applied = round2(Math.min(Math.max(paidTotal - cum, 0), amt));
    cum = round2(cum + amt);
    let settled = applied >= amt - EPS;
    if (inst.is_deposit) {
      if (job && job.deposit_waived) settled = true;       // waived: never ask
      else if (job && job.deposit_collected) settled = true;
      if (settled && applied < amt - EPS) applied = amt;   // flag-settled: show as covered
    }
    return { inst, amount: amt, applied, settled };
  });
}

// ---------------------------------------------------------------------------
// THE resolver (locked decisions 7 + 8). Given the job row, its installment
// rows, and its pec_payments rows, return the current outstanding ask:
//
//   null                         no active installments -> callers keep the
//                                exact legacy full-balance behavior
//   { mode:'installment', ... }  one installment is the current amount due
//   { mode:'none', ... }         schedule exists but the next unsettled
//                                installment's milestone has not fired yet
//                                (nothing is due right now; later lines NEVER
//                                jump the queue, decision 8)
//   { mode:'balance', ... }      every installment settled but the job total
//                                exceeds the schedule total -> the remainder
//                                is the ask (never strand receivable money)
//   { mode:'paid', ... }         nothing left to collect
//
// Every mode >= schedule also carries { schedule, totals } for display.
// ---------------------------------------------------------------------------
function resolveCurrentAsk({ job, installments, payments, today }) {
  const active = (installments || []).filter(i => i.status !== 'skipped' && i.status !== 'canceled');
  if (!active.length) return null;
  const todayIso = today || phoenixTodayIso();
  const paidTotal = round2((payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const price = round2(job && job.price);
  const balance = round2(price - paidTotal);
  const ordered = orderInstallments(active);
  const alloc = allocatePayments(ordered, paidTotal, job);

  const totals = { price, paid: paidTotal, balance: Math.max(balance, 0) };
  const currentRow = alloc.find(a => !a.settled) || null;
  const schedule = alloc.map(a => ({
    id: a.inst.id, seq: a.inst.seq, label: a.inst.label || (a.inst.is_deposit ? 'Deposit' : 'Installment'),
    amount: a.amount, applied: a.applied, settled: a.settled,
    isCurrent: !!(currentRow && a.inst.id === currentRow.inst.id),
    isDeposit: !!a.inst.is_deposit, standalone: !!a.inst.standalone,
    trigger_kind: a.inst.trigger_kind, status: a.inst.status,
    sent_at: a.inst.sent_at || null, paid_at: a.inst.paid_at || null,
  }));

  if (!currentRow) {
    if (balance > EPS) {
      return { mode: 'balance', amount: balance, label: 'Remaining balance', installmentId: null, isDeposit: false, trigger: null, schedule, totals };
    }
    return { mode: 'paid', amount: 0, label: null, installmentId: null, isDeposit: false, trigger: null, schedule, totals };
  }
  if (balance <= EPS) {
    // Paid past the schedule math (rounding, overpay): nothing to ask.
    return { mode: 'paid', amount: 0, label: null, installmentId: null, isDeposit: false, trigger: null, schedule, totals };
  }
  const inst = currentRow.inst;
  if (!askTriggerFired(inst, job, todayIso)) {
    return { mode: 'none', amount: 0, label: inst.label || null, installmentId: inst.id, isDeposit: !!inst.is_deposit, trigger: inst.trigger_kind, schedule, totals };
  }
  const remaining = round2(currentRow.amount - currentRow.applied);
  const amount = round2(Math.min(remaining, balance));
  if (amount <= EPS) {
    return { mode: 'paid', amount: 0, label: null, installmentId: null, isDeposit: false, trigger: null, schedule, totals };
  }
  return {
    mode: 'installment', amount,
    label: inst.label || (inst.is_deposit ? 'Deposit' : 'Installment'),
    installmentId: inst.id, isDeposit: !!inst.is_deposit,
    trigger: inst.trigger_kind, status: inst.status, schedule, totals,
  };
}

// Stripe amount (locked decision 9): computed here, server-side, from the
// token-resolved rows -- never from anything the client sent. Returns null
// when there is nothing chargeable (checkout redirects back to the invoice).
// pendingSum = in-flight ACH total; the same double-pay clamp as kind=balance.
function computeInstallmentCharge({ job, installments, payments, pendingSum }) {
  const ask = resolveCurrentAsk({ job, installments, payments });
  if (!ask || (ask.mode !== 'installment' && ask.mode !== 'balance')) return null;
  // Net in-flight ACH against the CURRENT ask (not just the total balance):
  // a pending transfer was almost certainly initiated for this ask, and even
  // when it wasn't, netting here only ever charges LESS -- the safe direction
  // for the double-pay guard. ask.amount is already clamped to the balance.
  const pend = round2(pendingSum);
  const chargeable = round2(ask.amount - pend);
  if (!(chargeable >= 0.5)) return null;   // Stripe minimum
  return { amount: chargeable, installmentId: ask.installmentId, label: ask.label, isDeposit: ask.isDeposit, mode: ask.mode };
}

// Why an installment must NOT be sent (approve-time and auto-send re-check).
// Returns a reason string or null (clear to send). Mirrored by the client's
// approve flow in index.html; keep in lockstep.
function installmentVoidReason({ job, installments, payments, installmentId }) {
  if (!job) return 'job_missing';
  if (job.voided_at) return 'job_voided';
  if (job.archived_at) return 'job_archived';
  const ask = resolveCurrentAsk({ job, installments, payments });
  if (!ask) return 'no_schedule';
  if (ask.mode === 'paid') return 'paid';
  const row = (ask.schedule || []).find(s => s.id === installmentId);
  if (!row) return 'installment_missing';
  if (row.settled) return 'already_covered';
  return null;
}

// ---------------------------------------------------------------------------
// Deposit prepare (locked decision 3): on estimate acceptance the system
// PREPARES a deposit installment at the resolved default; staff SEND it
// manually (it never enters the approval gate and never auto-sends).
// Precedence, first hit wins:
//   a) jobs.deposit_amount already set  -> manual per-job override (dollars)
//   b) the job's system type's pec_prod_system_types.deposit_pct
//   c) settings.default_deposit_pct     -> company-wide default
// Idempotent: an existing deposit line (or a collected/waived deposit) makes
// this a no-op, and uq_pec_invoice_installments_deposit backstops races.
// Best-effort by contract: callers wrap it so acceptance never fails on it.
// ---------------------------------------------------------------------------
async function prepareDepositInstallment(sb, jobId, opts = {}) {
  const jr = await sb('GET', `/jobs?id=eq.${encodeURIComponent(jobId)}&select=id,price,deposit_amount,deposit_collected,deposit_waived,system_type_id,voided_at,archived_at&limit=1`);
  const job = Array.isArray(jr) ? jr[0] : null;
  if (!job) return { prepared: false, reason: 'job_missing' };
  if (job.voided_at || job.archived_at) return { prepared: false, reason: 'job_closed' };
  if (job.deposit_collected) return { prepared: false, reason: 'deposit_collected' };
  if (job.deposit_waived) return { prepared: false, reason: 'deposit_waived' };
  const existing = await sb('GET', `/pec_invoice_installments?job_id=eq.${encodeURIComponent(jobId)}&is_deposit=eq.true&select=id&limit=1`);
  if (Array.isArray(existing) && existing.length) return { prepared: false, reason: 'exists' };

  const price = round2(job.price);
  let kind, value, computed, source;
  if (job.deposit_amount != null && round2(job.deposit_amount) > EPS) {
    kind = 'fixed'; value = round2(job.deposit_amount); computed = value; source = 'job_manual';
  } else {
    let pct = null;
    const sysId = opts.systemTypeId || job.system_type_id;
    if (sysId) {
      try {
        const sr = await sb('GET', `/pec_prod_system_types?id=eq.${encodeURIComponent(sysId)}&select=deposit_pct&limit=1`);
        const st = Array.isArray(sr) ? sr[0] : null;
        if (st && st.deposit_pct != null && Number(st.deposit_pct) > 0) { pct = Number(st.deposit_pct); source = 'system_type'; }
      } catch (err) { console.warn('prepareDeposit: system type read failed:', String(err && err.message || err)); }
    }
    if (pct == null) {
      let v = null;
      try {
        const rows = await sb('GET', `/settings?key=eq.default_deposit_pct&select=value&limit=1`);
        v = Array.isArray(rows) && rows[0] ? Number(rows[0].value) : null;
      } catch (err) { console.warn('prepareDeposit: settings read failed:', String(err && err.message || err)); }
      pct = (v != null && Number.isFinite(v) && v > 0) ? v : 50;   // 50 = the code's long-standing fallback
      source = 'company_default';
    }
    if (!(price > 0)) return { prepared: false, reason: 'no_price' };
    kind = 'percent'; value = pct; computed = computeInstallmentAmount('percent', pct, price);
  }
  if (!(computed > EPS)) return { prepared: false, reason: 'zero_amount' };

  try {
    await sb('POST', '/pec_invoice_installments', {
      job_id: jobId, seq: 0, label: 'Deposit',
      amount_kind: kind, amount_value: value, computed_amount: computed,
      trigger_kind: 'on_acceptance', status: 'planned',
      is_deposit: true, standalone: true,
    });
  } catch (err) {
    if (/duplicate key|unique/i.test(err.message || '')) return { prepared: false, reason: 'exists' };
    throw err;
  }
  // Keep the legacy deposit fields coherent: the pay page's no-schedule
  // deposit button and the Stripe webhook's deposit auto-flip both read
  // jobs.deposit_amount. Only fill it when null (never clobber a manual value).
  if (job.deposit_amount == null) {
    await sb('PATCH', `/jobs?id=eq.${encodeURIComponent(jobId)}&deposit_amount=is.null`, { deposit_amount: computed })
      .catch(err => console.warn('prepareDeposit: deposit_amount mirror failed:', String(err && err.message || err)));
  }
  return { prepared: true, source, amount: computed, kind, value };
}

// ---------------------------------------------------------------------------
// Milestone trigger runner (locked decision 5), one pass per drip-runner tick.
// planned non-deposit installments whose milestone has fired either:
//   gate ON  (installment_approval_required != 'false'): flip to
//            'pending_approval' -- held for a human in the Approvals view;
//            staff approve and it sends through the normal invoice send path.
//   gate OFF: the runner AUTO-SENDS the installment notice (SMS + email with
//            the pay link) itself, but ONLY when the installment is the
//            current ask (decision 8: a milestone firing while a prior
//            installment is unpaid just queues -- here that means it stays
//            planned until it becomes current) and ONLY while the master
//            outbound switch (drip_sending_enabled) is on; master off falls
//            back to the held queue so nothing is ever silently dropped.
// The deposit NEVER queues or auto-sends (decision 3: staff send it by hand);
// the is_deposit=eq.false filter enforces that structurally.
//
// deps: { sb, now?, providers? } where providers (injected by
// pec-drip-runner.cjs from _pec-drip.cjs; stubbed in tests) =
//   { sendSms, sendEmail, getSmsSender, getEmailSender, dripEmailHtml,
//     enrollInvoiceDrip, STOP_LINE, SITE_URL }
// ---------------------------------------------------------------------------
async function runInstallmentTriggers(deps) {
  const sb = deps.sb;
  const now = deps.now || (() => new Date());
  const summary = { disabled: false, scanned: 0, queued: 0, auto_sent: 0, canceled: 0, marked_paid: 0, held: 0, failed: 0 };

  let settingRows = [];
  try {
    settingRows = await sb('GET', `/settings?key=in.(payment_schedules_enabled,installment_approval_required,drip_sending_enabled)&select=key,value`);
  } catch (err) {
    console.warn('installments: settings read failed, holding everything:', String(err && err.message || err));
  }
  const smap = Object.fromEntries((Array.isArray(settingRows) ? settingRows : []).map(r => [r.key, r.value]));
  if (smap.payment_schedules_enabled === 'false') { summary.disabled = true; return summary; }
  const gateOn = smap.installment_approval_required !== 'false';
  const masterOn = smap.drip_sending_enabled === 'true';

  const planned = await sb('GET', `/pec_invoice_installments?status=eq.planned&is_deposit=eq.false&select=*&order=created_at.asc&limit=200`);
  const list = Array.isArray(planned) ? planned : [];
  if (!list.length) return summary;
  const todayIso = phoenixTodayIso(now());

  const jobIds = [...new Set(list.map(i => i.job_id))];
  const jobs = await sb('GET', `/jobs?id=in.(${jobIds.map(encodeURIComponent).join(',')})&select=id,status,price,voided_at,archived_at,customer_id,hq_invoice_number,dripjobs_deal_id,public_token,invoice_first_sent_at,deposit_collected,deposit_waived`);
  const jobById = Object.fromEntries((Array.isArray(jobs) ? jobs : []).map(j => [j.id, j]));
  const pays = await sb('GET', `/pec_payments?job_id=in.(${jobIds.map(encodeURIComponent).join(',')})&select=job_id,amount`);
  const paysByJob = {};
  for (const p of (Array.isArray(pays) ? pays : [])) (paysByJob[p.job_id] ||= []).push(p);
  const instByJob = {};
  // The chain needs EVERY installment of a touched job, not just planned ones.
  const allInst = await sb('GET', `/pec_invoice_installments?job_id=in.(${jobIds.map(encodeURIComponent).join(',')})&select=*`);
  for (const i of (Array.isArray(allInst) ? allInst : [])) (instByJob[i.job_id] ||= []).push(i);

  for (const inst of list) {
    summary.scanned++;
    try {
      const job = jobById[inst.job_id];
      if (!job || job.voided_at || job.archived_at) {
        await sb('PATCH', `/pec_invoice_installments?id=eq.${encodeURIComponent(inst.id)}&status=eq.planned`, { status: 'canceled', note: 'voided: job_closed' });
        summary.canceled++;
        continue;
      }
      if (!queueTriggerFired(inst, job, todayIso)) continue;

      const ask = resolveCurrentAsk({ job, installments: instByJob[inst.job_id] || [inst], payments: paysByJob[inst.job_id] || [], today: todayIso });
      const mine = ask && (ask.schedule || []).find(s => s.id === inst.id);
      if (mine && mine.settled) {
        // Already covered by money in the door before it ever queued.
        await sb('PATCH', `/pec_invoice_installments?id=eq.${encodeURIComponent(inst.id)}&status=eq.planned`, { status: 'paid', paid_at: now().toISOString() });
        summary.marked_paid++;
        continue;
      }
      if (ask && ask.mode === 'paid') {
        await sb('PATCH', `/pec_invoice_installments?id=eq.${encodeURIComponent(inst.id)}&status=eq.planned`, { status: 'canceled', note: 'voided: paid' });
        summary.canceled++;
        continue;
      }

      if (gateOn || !masterOn) {
        // Held for a human. With the gate off but the master switch off, hold
        // too (never silently drop): the note says why it parked.
        const patch = { status: 'pending_approval', queued_at: now().toISOString() };
        if (!gateOn && !masterOn) patch.note = 'held: master switch off';
        await sb('PATCH', `/pec_invoice_installments?id=eq.${encodeURIComponent(inst.id)}&status=eq.planned`, patch);
        if (!gateOn && !masterOn) summary.held++; else summary.queued++;
        continue;
      }

      // Gate OFF + master ON: auto-send, but only the CURRENT ask (decision 8).
      if (!(ask && ask.mode === 'installment' && ask.installmentId === inst.id)) continue;   // stays planned; a later tick sends it once current
      const out = await autoSendInstallment(deps, { inst, job, ask, nowIso: now().toISOString() });
      if (out.sent) summary.auto_sent++;
      else if (out.held) summary.held++;
      else if (out.failed) summary.failed++;
    } catch (err) {
      console.error('installments: trigger pass failed for', inst.id, String(err && err.message || err));
      summary.failed++;
    }
  }
  return summary;
}

// One auto-sent installment notice through the shared Quo/Resend provider
// path (same helpers the drip engine sends with, injected via deps.providers).
// Claim-first on the row (planned -> queued) so overlapping ticks cannot
// double-text; a provider failure parks the row in the approval queue with
// the error noted instead of retry-looping against a broken provider.
async function autoSendInstallment(deps, { inst, job, ask, nowIso }) {
  const sb = deps.sb;
  const P = deps.providers || {};
  if (!P.sendSms || !P.getSmsSender || !P.sendEmail || !P.getEmailSender) {
    // No providers wired (defensive): hold for a human instead of dropping.
    await sb('PATCH', `/pec_invoice_installments?id=eq.${encodeURIComponent(inst.id)}&status=eq.planned`, { status: 'pending_approval', queued_at: nowIso, note: 'held: no send providers' });
    return { held: true };
  }
  const custs = job.customer_id
    ? await sb('GET', `/customers?id=eq.${encodeURIComponent(job.customer_id)}&select=id,name,phone,email,sms_opt_out&limit=1`)
    : [];
  const customer = (Array.isArray(custs) && custs[0]) || null;
  const smsOk = !!(customer && customer.phone && !customer.sms_opt_out && job.public_token);
  const emailOk = !!(customer && customer.email && job.public_token);
  if (!smsOk && !emailOk) {
    await sb('PATCH', `/pec_invoice_installments?id=eq.${encodeURIComponent(inst.id)}&status=eq.planned`, { status: 'pending_approval', queued_at: nowIso, note: 'held: no reachable channel' });
    return { held: true };
  }

  // Claim before any provider call (conditional PATCH; zero matches = another
  // tick owns it). return=representation via the returnRow flag.
  const claimed = await sb('PATCH', `/pec_invoice_installments?id=eq.${encodeURIComponent(inst.id)}&status=eq.planned`, { status: 'queued', queued_at: nowIso }, true);
  if (!Array.isArray(claimed) || !claimed.length) return { held: false };

  const invNo = job.hq_invoice_number || job.dripjobs_deal_id || String(job.id || '').slice(0, 8);
  const payUrl = `${P.SITE_URL || 'https://prescottepoxy.netlify.app'}/pay/${job.public_token}`;
  const labelPart = inst.label ? ` (${inst.label})` : '';
  // Customer-facing copy: no em dashes (standing rule 6).
  const smsBody = `Prescott Epoxy Company: A payment of ${usd(ask.amount)} is now due on invoice ${invNo}${labelPart}. View and pay: ${payUrl}.${P.STOP_LINE || ' Reply STOP to opt out.'}`;
  const emailSubject = `Invoice ${invNo}: a payment of ${usd(ask.amount)} is due`;
  const emailText = `A payment of ${usd(ask.amount)}${labelPart} is now due on your invoice ${invNo} with Prescott Epoxy Company.\n\nYour project total is ${usd(ask.totals.price)} with ${usd(ask.totals.paid)} paid so far.\n\nView your invoice and pay online here: ${payUrl}`;

  const caches = { sms: {}, email: {} };
  let anySent = false, lastError = null;
  if (smsOk) {
    const sender = await P.getSmsSender(sb, caches.sms);
    if (sender && sender.from_number) {
      let out;
      try { out = await P.sendSms({ from: sender.from_number, to: customer.phone, content: smsBody }); }
      catch (err) { out = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
      await sb('POST', '/pec_sms_log', {
        direction: 'out', brand: 'prescott-epoxy', from_number: sender.from_number, to_number: customer.phone,
        customer_id: customer.id, job_id: job.id, body: smsBody, kind: 'invoice',
        status: out.ok ? 'sent' : 'failed', quo_message_id: out.id, error_message: out.error,
      }).catch(e => console.error('installments: sms log failed', e.message));
      if (out.ok) anySent = true; else lastError = out.error;
    } else lastError = 'no active SMS sender';
  }
  if (emailOk) {
    const sender = await P.getEmailSender(sb, caches.email);
    if (sender && sender.from_email) {
      let out;
      try {
        out = await P.sendEmail({
          from: `${sender.from_name || 'Prescott Epoxy Company'} <${sender.from_email}>`, to: customer.email,
          subject: emailSubject, html: P.dripEmailHtml ? P.dripEmailHtml(emailText) : emailText,
          reply_to: sender.reply_to || undefined,
        });
      } catch (err) { out = { ok: false, id: null, error: 'transport: ' + String(err && err.message || err).slice(0, 400) }; }
      await sb('POST', '/pec_email_log', {
        customer_id: customer.id, job_id: job.id, brand: 'prescott-epoxy', template_key: 'invoice',
        to_email: customer.email, from_email: sender.from_email, subject: emailSubject,
        status: out.ok ? 'sent' : 'failed', resend_id: out.id, error_message: out.error,
      }).catch(e => console.error('installments: email log failed', e.message));
      if (out.ok) anySent = true; else if (!anySent) lastError = out.error;
    } else if (!anySent) lastError = 'no email sender';
  }

  if (!anySent) {
    await sb('PATCH', `/pec_invoice_installments?id=eq.${encodeURIComponent(inst.id)}&status=eq.queued`, { status: 'pending_approval', note: 'auto-send failed: ' + String(lastError || 'unknown').slice(0, 300) });
    return { failed: true };
  }
  await sb('PATCH', `/pec_invoice_installments?id=eq.${encodeURIComponent(inst.id)}&status=eq.queued`, { status: 'sent', sent_at: nowIso });
  // First-send stamp (first-send-wins, same rule as the staff send paths) and
  // the reminder-drip enrollment anchored to it.
  if (!job.invoice_first_sent_at) {
    await sb('PATCH', `/jobs?id=eq.${encodeURIComponent(job.id)}&invoice_first_sent_at=is.null`, { invoice_first_sent_at: nowIso })
      .catch(e => console.error('installments: first-sent stamp failed', e.message));
  }
  if (P.enrollInvoiceDrip) {
    try { await P.enrollInvoiceDrip(sb, job.id, new Date(nowIso)); }
    catch (err) { console.warn('installments: reminder enroll skipped:', String(err && err.message || err)); }
  }
  return { sent: true };
}

// ---------------------------------------------------------------------------
// Post-payment settle: recompute the allocation and stamp any newly covered
// installment 'paid'. Called by the Stripe webhook after recordPayment (best
// effort; the pec_payments row is the source of truth and the resolver
// derives settlement from money, so a missed stamp self-heals on the next
// call). paymentId (optional) is written onto rows settled by this payment.
// ---------------------------------------------------------------------------
async function settleInstallments(sb, jobId, opts = {}) {
  const [instRows, payRows, jobRows] = await Promise.all([
    sb('GET', `/pec_invoice_installments?job_id=eq.${encodeURIComponent(jobId)}&select=*`),
    sb('GET', `/pec_payments?job_id=eq.${encodeURIComponent(jobId)}&select=amount`),
    sb('GET', `/jobs?id=eq.${encodeURIComponent(jobId)}&select=id,price,status,deposit_collected,deposit_waived&limit=1`),
  ]);
  const installments = Array.isArray(instRows) ? instRows : [];
  const job = (Array.isArray(jobRows) && jobRows[0]) || null;
  if (!installments.length || !job) return { settled: 0 };
  const active = installments.filter(i => i.status !== 'skipped' && i.status !== 'canceled');
  const paidTotal = round2((Array.isArray(payRows) ? payRows : []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const alloc = allocatePayments(orderInstallments(active), paidTotal, job);
  const nowIso = new Date().toISOString();
  let settled = 0;
  for (const a of alloc) {
    if (!a.settled || a.inst.status === 'paid') continue;
    await sb('PATCH', `/pec_invoice_installments?id=eq.${encodeURIComponent(a.inst.id)}&status=in.(planned,queued,pending_approval,sent)`, {
      status: 'paid', paid_at: nowIso, payment_id: opts.paymentId || null,
    });
    settled++;
  }
  return { settled };
}

module.exports = {
  EPS, round2, usd, phoenixTodayIso,
  computeInstallmentAmount, orderInstallments, allocatePayments,
  askTriggerFired, queueTriggerFired,
  resolveCurrentAsk, computeInstallmentCharge, installmentVoidReason,
  prepareDepositInstallment, runInstallmentTriggers, autoSendInstallment,
  settleInstallments,
};
