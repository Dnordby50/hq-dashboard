// Prompt 45: invoice-installment fixture tests. Drives the REAL module
// (netlify/functions/_pec-installments.cjs) -- the current-amount-due
// resolver, the deposit-prepare precedence, the milestone trigger runner with
// its approval gate and auto-send branch, the approve-time void predicate,
// the Stripe server-side amount computation, and the post-payment settle --
// against the shared mini-PostgREST.
// Run: node production/installments.test.cjs
'use strict';

const {
  resolveCurrentAsk, computeInstallmentCharge, computeInstallmentAmount,
  installmentVoidReason, prepareDepositInstallment, runInstallmentTriggers,
  settleInstallments,
} = require('../netlify/functions/_pec-installments.cjs');
const { makeDb, makeChecker } = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();

// --- fixture helpers --------------------------------------------------------
let seq = 0;
const inst = (over = {}) => ({
  id: 'inst' + (++seq), job_id: 'job1', seq: over.seq != null ? over.seq : seq,
  label: '', amount_kind: 'fixed', amount_value: 0, computed_amount: 0,
  trigger_kind: 'manual', due_date: null, status: 'planned',
  is_deposit: false, standalone: false, note: null,
  queued_at: null, sent_at: null, paid_at: null, payment_id: null,
  created_at: '2026-07-22T00:00:0' + (seq % 10) + 'Z',
  ...over,
});
const job = (over = {}) => ({
  id: 'job1', status: 'signed', price: 10000, customer_id: 'cust1',
  voided_at: null, archived_at: null, deposit_amount: null,
  deposit_collected: false, deposit_waived: false, system_type_id: null,
  hq_invoice_number: 'INV-100', dripjobs_deal_id: null,
  public_token: '11111111-1111-4111-8111-111111111111',
  invoice_first_sent_at: null,
  ...over,
});
const pay = (amount) => ({ amount });

function tables(over = {}) {
  return {
    settings: [], jobs: [], customers: [], pec_payments: [],
    pec_invoice_installments: [], pec_prod_system_types: [],
    pec_sms_log: [], pec_email_log: [],
    pec_drip_campaigns: [], pec_drip_enrollments: [], pec_drip_sends: [],
    ...over,
  };
}
function stubProviders(log = { sms: [], email: [], enrolls: [] }) {
  return {
    log,
    providers: {
      sendSms: async (m) => { log.sms.push(m); return { ok: true, id: 'q' + log.sms.length }; },
      sendEmail: async (m) => { log.email.push(m); return { ok: true, id: 'r' + log.email.length }; },
      getSmsSender: async () => ({ from_number: '+15550001111' }),
      getEmailSender: async () => ({ from_name: 'PEC', from_email: 'billing@pec.test', reply_to: null }),
      dripEmailHtml: (t) => '<div>' + t + '</div>',
      enrollInvoiceDrip: async (sb, jobId) => { log.enrolls.push(jobId); return { enrolled: true }; },
      STOP_LINE: ' Reply STOP to opt out.',
      SITE_URL: 'https://pec.test',
    },
  };
}

(async () => {
  // ==========================================================================
  console.log('resolver: no installments -> null (legacy full-balance path untouched)');
  {
    ok(resolveCurrentAsk({ job: job(), installments: [], payments: [pay(1000)] }) === null, 'empty schedule resolves to null');
    ok(resolveCurrentAsk({ job: job(), installments: [inst({ status: 'canceled' }), inst({ status: 'skipped' })], payments: [] }) === null, 'only canceled/skipped rows also resolve to null');
  }

  // ==========================================================================
  console.log('resolver: dollar vs percent amounts');
  {
    ok(computeInstallmentAmount('fixed', 1234.567, 10000) === 1234.57, 'fixed rounds to cents');
    ok(computeInstallmentAmount('percent', 25, 10000) === 2500, 'percent of the job total');
    ok(computeInstallmentAmount('percent', 33.33, 999.99) === 333.30, 'percent rounds to cents');
  }

  // ==========================================================================
  console.log('resolver: one outstanding ask at a time (decision 8)');
  {
    const installments = [
      inst({ seq: 1, label: 'Start', computed_amount: 4000, trigger_kind: 'on_start' }),
      inst({ seq: 2, label: 'Final', computed_amount: 6000, trigger_kind: 'on_completion' }),
    ];
    // Job completed: BOTH triggers have fired, but only the first unsettled is current.
    const a = resolveCurrentAsk({ job: job({ status: 'completed' }), installments, payments: [] });
    ok(a.mode === 'installment' && a.label === 'Start' && a.amount === 4000, 'first unsettled installment is the current ask even when later milestones fired');
    ok(a.schedule.filter(s => s.isCurrent).length === 1, 'exactly one line is current');
    // Pay the first: the second becomes current.
    const b = resolveCurrentAsk({ job: job({ status: 'completed' }), installments, payments: [pay(4000)] });
    ok(b.mode === 'installment' && b.label === 'Final' && b.amount === 6000, 'settling the prior advances the ask');
    ok(b.schedule[0].settled === true && b.schedule[0].isCurrent === false, 'settled line is marked paid and not current');
  }

  // ==========================================================================
  console.log('resolver: milestone gating (mode none, never jump the queue)');
  {
    const installments = [
      inst({ seq: 1, label: 'Start', computed_amount: 4000, trigger_kind: 'on_completion' }),
      inst({ seq: 2, label: 'Extra', computed_amount: 6000, trigger_kind: 'on_acceptance' }),
    ];
    const a = resolveCurrentAsk({ job: job({ status: 'in_progress' }), installments, payments: [] });
    ok(a.mode === 'none' && a.amount === 0, 'unfired milestone on the next line = nothing due right now');
    ok(a.installmentId === installments[0].id, "the waiting line is the FIRST unsettled one; the fired later line never jumps");
  }

  // ==========================================================================
  console.log('resolver: settled threshold + partial payments');
  {
    const installments = [inst({ seq: 1, label: 'Deposit-ish', computed_amount: 3000, trigger_kind: 'on_acceptance' })];
    const partial = resolveCurrentAsk({ job: job(), installments, payments: [pay(1000)] });
    ok(partial.mode === 'installment' && partial.amount === 2000, 'partial payment reduces the current ask to the remainder');
    const exact = resolveCurrentAsk({ job: job(), installments, payments: [pay(3000)] });
    ok(exact.mode === 'balance' && exact.amount === 7000, 'covering the schedule with total left -> remaining-balance ask (never strand AR)');
    const done = resolveCurrentAsk({ job: job({ price: 3000 }), installments, payments: [pay(3000)] });
    ok(done.mode === 'paid' && done.amount === 0, 'schedule covered and balance zero -> paid');
  }

  // ==========================================================================
  console.log('resolver: deposit first, both as-line and standalone (decision 4)');
  {
    for (const standalone of [false, true]) {
      const installments = [
        inst({ seq: 3, label: 'Final', computed_amount: 5000, trigger_kind: 'on_completion' }),
        inst({ seq: 0, label: 'Deposit', computed_amount: 5000, trigger_kind: 'on_acceptance', is_deposit: true, standalone }),
      ];
      const a = resolveCurrentAsk({ job: job(), installments, payments: [] });
      ok(a.mode === 'installment' && a.isDeposit === true && a.amount === 5000, `deposit (standalone=${standalone}) is the current ask while unpaid`);
      const b = resolveCurrentAsk({ job: job({ status: 'completed' }), installments, payments: [pay(5000)] });
      ok(b.mode === 'installment' && b.label === 'Final', `deposit (standalone=${standalone}) settles first from money in the door`);
    }
    // Flag-only settle paths (legacy coherence).
    const installments = [
      inst({ seq: 0, label: 'Deposit', computed_amount: 5000, trigger_kind: 'on_acceptance', is_deposit: true }),
      inst({ seq: 1, label: 'Final', computed_amount: 5000, trigger_kind: 'on_completion' }),
    ];
    const c = resolveCurrentAsk({ job: job({ deposit_collected: true, status: 'completed' }), installments, payments: [] });
    ok(c.mode === 'installment' && c.label === 'Final', 'jobs.deposit_collected settles the deposit line without a payment row');
    const d = resolveCurrentAsk({ job: job({ deposit_waived: true, status: 'completed' }), installments, payments: [] });
    ok(d.mode === 'installment' && d.label === 'Final', 'jobs.deposit_waived removes the deposit from the chain');
  }

  // ==========================================================================
  console.log('resolver: ask never exceeds the remaining balance');
  {
    const partial = resolveCurrentAsk({ job: job({ price: 10000 }), installments: [inst({ seq: 1, computed_amount: 9000, trigger_kind: 'on_acceptance' })], payments: [pay(8000)] });
    ok(partial.mode === 'installment' && partial.amount === 1000, 'ask is the line remainder (9000 line, 8000 applied -> 1000)');
    const over = resolveCurrentAsk({ job: job({ price: 3000 }), installments: [inst({ seq: 1, computed_amount: 5000, trigger_kind: 'on_acceptance' })], payments: [] });
    ok(over.mode === 'installment' && over.amount === 3000, 'a line bigger than the job total clamps to the remaining balance');
  }

  // ==========================================================================
  console.log('Stripe: server-side installment charge computation (decision 9)');
  {
    const installments = [inst({ seq: 1, label: 'Start', computed_amount: 4000, trigger_kind: 'on_acceptance' })];
    const a = computeInstallmentCharge({ job: job(), installments, payments: [], pendingSum: 0 });
    ok(a && a.amount === 4000 && a.installmentId === installments[0].id, 'charge = the current installment amount');
    const b = computeInstallmentCharge({ job: job(), installments, payments: [], pendingSum: 3500 });
    ok(b && b.amount === 500, 'in-flight ACH clamps the charge (double-pay guard)');
    const c = computeInstallmentCharge({ job: job(), installments, payments: [], pendingSum: 3999.8 });
    ok(c === null, 'below the Stripe $0.50 minimum -> nothing chargeable');
    const d = computeInstallmentCharge({ job: job({ status: 'signed' }), installments: [inst({ computed_amount: 4000, trigger_kind: 'on_completion' })], payments: [], pendingSum: 0 });
    ok(d === null, 'mode none (milestone not fired) -> nothing chargeable');
    ok(computeInstallmentCharge({ job: job(), installments: [], payments: [], pendingSum: 0 }) === null, 'no schedule -> null (kind=balance path handles it)');
  }

  // ==========================================================================
  console.log('void predicate: approve-time re-check (decision 5)');
  {
    const installments = [inst({ seq: 1, computed_amount: 4000, trigger_kind: 'on_acceptance', status: 'pending_approval' })];
    ok(installmentVoidReason({ job: job({ voided_at: '2026-07-22T00:00:00Z' }), installments, payments: [], installmentId: installments[0].id }) === 'job_voided', 'voided job voids the send');
    ok(installmentVoidReason({ job: job({ archived_at: '2026-07-22T00:00:00Z' }), installments, payments: [], installmentId: installments[0].id }) === 'job_archived', 'archived job voids the send');
    ok(installmentVoidReason({ job: job({ price: 4000 }), installments, payments: [pay(4000)], installmentId: installments[0].id }) === 'paid', 'paid-in-full voids the send');
    ok(installmentVoidReason({ job: job(), installments, payments: [pay(4000)], installmentId: installments[0].id }) === 'already_covered', 'an installment covered by payments voids its own send');
    ok(installmentVoidReason({ job: job(), installments, payments: [], installmentId: installments[0].id }) === null, 'a live unpaid installment is clear to send');
  }

  // ==========================================================================
  console.log('deposit prepare: precedence a) manual jobs.deposit_amount');
  {
    const fx = makeDb(tables({ jobs: [job({ deposit_amount: 1200 })] }));
    const out = await prepareDepositInstallment(fx.sb, 'job1');
    const row = fx.db.pec_invoice_installments[0];
    ok(out.prepared && out.source === 'job_manual' && out.amount === 1200, 'manual per-job override wins');
    ok(row && row.is_deposit && row.amount_kind === 'fixed' && row.computed_amount === 1200 && row.status === 'planned', 'deposit row: fixed, planned, unsent');
    ok(fx.db.jobs[0].deposit_amount === 1200, 'existing manual deposit_amount untouched');
  }

  // ==========================================================================
  console.log('deposit prepare: precedence b) system type deposit_pct');
  {
    const fx = makeDb(tables({
      jobs: [job({ system_type_id: 'sys1' })],
      pec_prod_system_types: [{ id: 'sys1', deposit_pct: 30 }],
      settings: [{ id: 's1', key: 'default_deposit_pct', value: '50' }],
    }));
    const out = await prepareDepositInstallment(fx.sb, 'job1');
    ok(out.prepared && out.source === 'system_type' && out.amount === 3000, 'system-type percent beats the company default');
    ok(fx.db.pec_invoice_installments[0].amount_kind === 'percent' && fx.db.pec_invoice_installments[0].amount_value === 30, 'stores the percent kind + value');
    ok(fx.db.jobs[0].deposit_amount === 3000, 'mirrors the computed dollars onto jobs.deposit_amount (was null)');
  }

  // ==========================================================================
  console.log('deposit prepare: precedence c) settings default + idempotency + guards');
  {
    const fx = makeDb(tables({
      jobs: [job()],
      settings: [{ id: 's1', key: 'default_deposit_pct', value: '25' }],
    }));
    const out = await prepareDepositInstallment(fx.sb, 'job1');
    ok(out.prepared && out.source === 'company_default' && out.amount === 2500, 'company default percent used last');
    const again = await prepareDepositInstallment(fx.sb, 'job1');
    ok(again.prepared === false && again.reason === 'exists' && fx.db.pec_invoice_installments.length === 1, 'second prepare is a no-op (accept retries are safe)');

    const fx2 = makeDb(tables({ jobs: [job({ deposit_collected: true })] }));
    const o2 = await prepareDepositInstallment(fx2.sb, 'job1');
    ok(o2.prepared === false && o2.reason === 'deposit_collected', 'collected deposit -> no prepare');
    const fx3 = makeDb(tables({ jobs: [job({ deposit_waived: true })] }));
    const o3 = await prepareDepositInstallment(fx3.sb, 'job1');
    ok(o3.prepared === false && o3.reason === 'deposit_waived', 'waived deposit -> no prepare');
    const fx4 = makeDb(tables({ jobs: [job()] }));
    const o4 = await prepareDepositInstallment(fx4.sb, 'job1');
    ok(o4.prepared && o4.source === 'company_default' && o4.amount === 5000, 'missing settings row -> the long-standing 50% fallback');
  }

  // ==========================================================================
  console.log('trigger runner: gate ON queues fired milestones, deposit never queues');
  {
    const fx = makeDb(tables({
      jobs: [job({ status: 'in_progress' })],
      settings: [
        { id: 's1', key: 'payment_schedules_enabled', value: 'true' },
        { id: 's2', key: 'installment_approval_required', value: 'true' },
        { id: 's3', key: 'drip_sending_enabled', value: 'true' },
      ],
      pec_invoice_installments: [
        inst({ id: 'dep', seq: 0, is_deposit: true, computed_amount: 2000, trigger_kind: 'on_acceptance' }),
        inst({ id: 'i1', seq: 1, computed_amount: 3000, trigger_kind: 'on_start' }),
        inst({ id: 'i2', seq: 2, computed_amount: 5000, trigger_kind: 'on_completion' }),
      ],
    }));
    const s = await runInstallmentTriggers({ sb: fx.sb });
    const byId = Object.fromEntries(fx.db.pec_invoice_installments.map(r => [r.id, r]));
    ok(s.queued === 1 && byId.i1.status === 'pending_approval' && byId.i1.queued_at, 'fired on_start installment held for approval');
    ok(byId.i2.status === 'planned', 'unfired on_completion installment stays planned');
    ok(byId.dep.status === 'planned', 'the deposit NEVER auto-queues (staff send it manually)');
    // Milestone firing while the prior (deposit) is unpaid still queues (decision 8).
    ok(byId.i1.status === 'pending_approval', 'fired-behind-an-unpaid-prior still queues (it is just not current yet)');
    const s2 = await runInstallmentTriggers({ sb: fx.sb });
    ok(s2.queued === 0, 'second tick is a no-op (conditional status=planned claim)');
  }

  // ==========================================================================
  console.log('trigger runner: module off / master off / closed or paid jobs');
  {
    const base = () => tables({
      jobs: [job({ status: 'completed' })],
      pec_invoice_installments: [inst({ id: 'i1', seq: 1, computed_amount: 4000, trigger_kind: 'on_completion' })],
      settings: [
        { id: 's1', key: 'payment_schedules_enabled', value: 'true' },
        { id: 's2', key: 'installment_approval_required', value: 'false' },
        { id: 's3', key: 'drip_sending_enabled', value: 'false' },
      ],
    });
    const off = makeDb(base());
    off.db.settings.find(r => r.key === 'payment_schedules_enabled').value = 'false';
    const so = await runInstallmentTriggers({ sb: off.sb });
    ok(so.disabled && off.db.pec_invoice_installments[0].status === 'planned', 'payment_schedules_enabled=false -> the runner does nothing');

    const held = makeDb(base());
    const sh = await runInstallmentTriggers({ sb: held.sb, ...stubProviders() });
    ok(sh.held === 1 && held.db.pec_invoice_installments[0].status === 'pending_approval' && /master switch off/.test(held.db.pec_invoice_installments[0].note || ''), 'gate off but master off -> held for a human, never dropped');

    const closed = makeDb(base());
    closed.db.jobs[0].voided_at = '2026-07-22T00:00:00Z';
    const sc = await runInstallmentTriggers({ sb: closed.sb });
    ok(sc.canceled === 1 && closed.db.pec_invoice_installments[0].status === 'canceled', 'voided job -> installment canceled with the reason noted');

    const paid = makeDb(base());
    paid.db.settings.find(r => r.key === 'installment_approval_required').value = 'true';
    paid.db.pec_payments.push({ id: 'p1', job_id: 'job1', amount: 10000 });
    const sp = await runInstallmentTriggers({ sb: paid.sb });
    ok(sp.marked_paid === 1 && paid.db.pec_invoice_installments[0].status === 'paid', 'already covered by payments -> marked paid, never queued');
  }

  // ==========================================================================
  console.log('trigger runner: gate OFF auto-sends the CURRENT ask only');
  {
    const fx = makeDb(tables({
      jobs: [job({ status: 'completed' })],
      customers: [{ id: 'cust1', name: 'Jane Doe', phone: '+15551234567', email: 'jane@example.com', sms_opt_out: false }],
      settings: [
        { id: 's1', key: 'payment_schedules_enabled', value: 'true' },
        { id: 's2', key: 'installment_approval_required', value: 'false' },
        { id: 's3', key: 'drip_sending_enabled', value: 'true' },
      ],
      pec_invoice_installments: [
        inst({ id: 'i1', seq: 1, label: 'Job start', computed_amount: 4000, trigger_kind: 'on_start' }),
        inst({ id: 'i2', seq: 2, label: 'Completion', computed_amount: 6000, trigger_kind: 'on_completion' }),
      ],
    }));
    const { providers, log } = stubProviders();
    const s = await runInstallmentTriggers({ sb: fx.sb, providers });
    const byId = Object.fromEntries(fx.db.pec_invoice_installments.map(r => [r.id, r]));
    ok(s.auto_sent === 1 && byId.i1.status === 'sent' && byId.i1.sent_at, 'the current installment auto-sent and stamped');
    ok(byId.i2.status === 'planned', 'the fired-but-not-current later installment stays planned (decision 8)');
    ok(log.sms.length === 1 && /4,000\.00/.test(log.sms[0].content) && /\/pay\//.test(log.sms[0].content) && /Reply STOP/.test(log.sms[0].content), 'SMS states the CURRENT ask with the pay link + STOP line');
    ok(!/—|–/.test(log.sms[0].content), 'no em dashes in the customer-facing SMS');
    ok(log.email.length === 1 && /4,000\.00/.test(log.email[0].subject), 'email subject states the current ask');
    ok(fx.db.pec_sms_log.length === 1 && fx.db.pec_sms_log[0].kind === 'invoice', 'SMS mirrored into pec_sms_log kind=invoice (comm history + last-invoiced)');
    ok(fx.db.jobs[0].invoice_first_sent_at != null, 'first auto-send stamps invoice_first_sent_at');
    ok(log.enrolls.length === 1 && log.enrolls[0] === 'job1', 'reminder drip enrolled off the send');

    // Pay installment 1: next tick auto-sends installment 2 exactly once.
    fx.db.pec_payments.push({ id: 'p1', job_id: 'job1', amount: 4000 });
    const s2 = await runInstallmentTriggers({ sb: fx.sb, providers });
    ok(s2.auto_sent === 1 && fx.db.pec_invoice_installments.find(r => r.id === 'i2').status === 'sent', 'settling the prior lets the next installment send on the following tick');
    ok(log.sms.length === 2 && /6,000\.00/.test(log.sms[1].content), 'second notice states the SECOND ask');
    const s3 = await runInstallmentTriggers({ sb: fx.sb, providers });
    ok(s3.auto_sent === 0 && log.sms.length === 2, 'no re-send once everything is sent');
  }

  // ==========================================================================
  console.log('trigger runner: auto-send failure parks in the approval queue');
  {
    const fx = makeDb(tables({
      jobs: [job({ status: 'completed' })],
      customers: [{ id: 'cust1', name: 'Jane Doe', phone: '+15551234567', email: null, sms_opt_out: false }],
      settings: [
        { id: 's1', key: 'payment_schedules_enabled', value: 'true' },
        { id: 's2', key: 'installment_approval_required', value: 'false' },
        { id: 's3', key: 'drip_sending_enabled', value: 'true' },
      ],
      pec_invoice_installments: [inst({ id: 'i1', seq: 1, computed_amount: 4000, trigger_kind: 'on_completion' })],
    }));
    const { providers } = stubProviders();
    providers.sendSms = async () => ({ ok: false, id: null, error: 'quo down' });
    const s = await runInstallmentTriggers({ sb: fx.sb, providers });
    const row = fx.db.pec_invoice_installments[0];
    ok(s.failed === 1 && row.status === 'pending_approval' && /auto-send failed/.test(row.note || ''), 'provider failure -> held for a human with the error noted');

    const fx2 = makeDb(tables({
      jobs: [job({ status: 'completed', customer_id: 'cust1' })],
      customers: [{ id: 'cust1', name: 'Jane Doe', phone: null, email: null, sms_opt_out: false }],
      settings: fx.db.settings.map(r => ({ ...r })),
      pec_invoice_installments: [inst({ id: 'i1', seq: 1, computed_amount: 4000, trigger_kind: 'on_completion' })],
    }));
    const s2 = await runInstallmentTriggers({ sb: fx2.sb, ...stubProviders() });
    ok(s2.held === 1 && fx2.db.pec_invoice_installments[0].status === 'pending_approval', 'no reachable channel -> held, never dropped');
  }

  // ==========================================================================
  console.log('settle: payments stamp covered installments paid');
  {
    const fx = makeDb(tables({
      jobs: [job()],
      pec_payments: [{ id: 'p1', job_id: 'job1', amount: 5000 }],
      pec_invoice_installments: [
        inst({ id: 'dep', seq: 0, is_deposit: true, computed_amount: 2000, trigger_kind: 'on_acceptance', status: 'sent' }),
        inst({ id: 'i1', seq: 1, computed_amount: 3000, trigger_kind: 'on_start', status: 'sent' }),
        inst({ id: 'i2', seq: 2, computed_amount: 5000, trigger_kind: 'on_completion' }),
      ],
    }));
    const out = await settleInstallments(fx.sb, 'job1', { paymentId: 'p1' });
    const byId = Object.fromEntries(fx.db.pec_invoice_installments.map(r => [r.id, r]));
    ok(out.settled === 2 && byId.dep.status === 'paid' && byId.i1.status === 'paid', 'deposit + first installment settled by the $5000');
    ok(byId.dep.payment_id === 'p1' && byId.dep.paid_at, 'settling payment recorded on the row');
    ok(byId.i2.status === 'planned', 'uncovered installment untouched');
    const again = await settleInstallments(fx.sb, 'job1', { paymentId: 'p2' });
    ok(again.settled === 0 && byId.dep.payment_id === 'p1', 'settle is idempotent (paid rows never restamped)');
  }

  // ==========================================================================
  console.log('reminders: the invoice drip nudges on the CURRENT ask (decision 10)');
  {
    const { resolveRecipient, checkKillSwitches } = require('../netlify/functions/_pec-drip.cjs');
    const campaign = { kind: 'invoice', max_touches: 4, name: 'Invoice reminders' };
    const enr = { id: 'enr1', subject_type: 'job', subject_id: 'job1', enrolled_at: '2026-07-22T00:00:00Z', next_step_index: 0 };
    const mk = (over = {}) => makeDb(tables({
      jobs: [job({ status: 'in_progress' })],
      customers: [{ id: 'cust1', name: 'Jane Doe', first_name: 'Jane', phone: '+15551234567', phone_norm: '5551234567', email: 'jane@example.com', sms_opt_out: false }],
      pec_sms_log: [], pec_call_log: [],
      ...over,
    }));

    // Schedule with a fired current ask: the reminder amount IS the ask.
    const a = mk({
      pec_invoice_installments: [
        inst({ seq: 1, label: 'Job start', computed_amount: 4000, trigger_kind: 'on_start' }),
        inst({ seq: 2, label: 'Completion', computed_amount: 6000, trigger_kind: 'on_completion' }),
      ],
    });
    const rcptA = await resolveRecipient(a.sb, 'job', 'job1');
    const outA = await checkKillSwitches(a.sb, enr, campaign, rcptA);
    ok(outA === null && rcptA.balance === 4000 && rcptA.askLabel === 'Job start' && rcptA.askIsSchedule === true, 'reminder states the current installment amount + label, not the full balance');

    // Nothing currently due (next milestone unfired after a paid installment):
    // the enrollment stops as not_due instead of nagging about $0 or the balance.
    const b = mk({
      pec_invoice_installments: [
        inst({ seq: 1, label: 'Job start', computed_amount: 4000, trigger_kind: 'on_start' }),
        inst({ seq: 2, label: 'Completion', computed_amount: 6000, trigger_kind: 'on_completion' }),
      ],
      pec_payments: [{ id: 'p1', job_id: 'job1', amount: 4000 }],
    });
    const rcptB = await resolveRecipient(b.sb, 'job', 'job1');
    const outB = await checkKillSwitches(b.sb, enr, campaign, rcptB);
    ok(outB && outB.action === 'stopped' && outB.reason === 'not_due', 'nothing currently due -> the reminder drip stops as not_due');

    // No schedule: exact legacy behavior (full remaining balance).
    const c = mk({ pec_payments: [{ id: 'p1', job_id: 'job1', amount: 1500 }] });
    const rcptC = await resolveRecipient(c.sb, 'job', 'job1');
    const outC = await checkKillSwitches(c.sb, enr, campaign, rcptC);
    ok(outC === null && rcptC.balance === 8500 && !rcptC.askIsSchedule, 'no schedule -> legacy full-balance reminder, untouched');

    // Fully paid stops regardless of schedule shape.
    const d = mk({
      pec_invoice_installments: [inst({ seq: 1, computed_amount: 10000, trigger_kind: 'on_start' })],
      pec_payments: [{ id: 'p1', job_id: 'job1', amount: 10000 }],
    });
    const rcptD = await resolveRecipient(d.sb, 'job', 'job1');
    const outD = await checkKillSwitches(d.sb, enr, campaign, rcptD);
    ok(outD && outD.action === 'stopped' && outD.reason === 'paid', 'paid in full still stops the drip');
  }

  // ==========================================================================
  // Request-a-payment (2026-08-27): the manual-trigger row semantics the new
  // dashboard "Request payment" flow depends on. These pin behavior that was
  // schema headroom until now, so a resolver change that would silently break
  // requests fails here first.
  {
    // A queued manual row placed BEFORE an unfired milestone IS the ask.
    const j = job({ status: 'signed', price: 10000 });
    const rows = [
      inst({ seq: 1, computed_amount: 2000, trigger_kind: 'manual', status: 'queued', label: 'Progress payment' }),
      inst({ seq: 2, computed_amount: 8000, trigger_kind: 'on_completion', status: 'planned' }),
    ];
    const ask = resolveCurrentAsk({ job: j, installments: rows, payments: [] });
    ok(ask && ask.mode === 'installment' && ask.amount === 2000 && ask.label === 'Progress payment',
      'request: queued manual row ahead of an unfired milestone is the current ask');
    const charge = computeInstallmentCharge({ job: j, installments: rows, payments: [], pendingSum: 0 });
    ok(charge && charge.amount === 2000, 'request: Stripe kind=installment charges exactly the requested amount');
  }
  {
    // Behind an unfired milestone the manual row does NOT jump the queue --
    // the documented reason the UI renumbers rows around the insertion point.
    const j = job({ status: 'signed', price: 10000 });
    const rows = [
      inst({ seq: 1, computed_amount: 8000, trigger_kind: 'on_completion', status: 'planned' }),
      inst({ seq: 2, computed_amount: 2000, trigger_kind: 'manual', status: 'queued' }),
    ];
    const ask = resolveCurrentAsk({ job: j, installments: rows, payments: [] });
    ok(ask && ask.mode === 'none', 'request: a manual row behind an unfired milestone never jumps the queue');
  }
  {
    // Placement after settled rows preserves history: the paid deposit stays
    // settled, the request is the ask, the remainder asks last (mode balance
    // after both settle).
    const j = job({ status: 'signed', price: 10000, deposit_collected: true });
    const rows = [
      inst({ seq: 0, computed_amount: 5000, is_deposit: true, trigger_kind: 'on_acceptance', status: 'paid' }),
      inst({ seq: 1, computed_amount: 2000, trigger_kind: 'manual', status: 'sent', label: 'Progress payment' }),
    ];
    const ask = resolveCurrentAsk({ job: j, installments: rows, payments: [pay(5000)] });
    ok(ask && ask.mode === 'installment' && ask.amount === 2000, 'request: lands after the settled deposit and asks its own amount');
    ok(ask.schedule[0].settled === true && ask.schedule[0].isDeposit === true, 'request: the paid deposit stays settled');
    const askAfter = resolveCurrentAsk({ job: j, installments: rows, payments: [pay(5000), pay(2000)] });
    ok(askAfter && askAfter.mode === 'balance' && askAfter.amount === 3000, 'request: once paid, the uncovered remainder asks as the balance');
  }
  {
    // Withdrawn (canceled) requests drop out of the resolver entirely.
    const j = job({ status: 'signed', price: 10000 });
    const rows = [inst({ seq: 1, computed_amount: 2000, trigger_kind: 'manual', status: 'canceled' })];
    ok(resolveCurrentAsk({ job: j, installments: rows, payments: [] }) === null,
      'request: a canceled request leaves the invoice on legacy full-balance behavior');
  }
  {
    // The ask is clamped to the real balance: an over-sized request can never
    // over-charge (Stripe additionally nets pending ACH).
    const j = job({ status: 'signed', price: 10000 });
    const rows = [inst({ seq: 1, computed_amount: 9000, trigger_kind: 'manual', status: 'queued' })];
    const ask = resolveCurrentAsk({ job: j, installments: rows, payments: [pay(8000)] });
    ok(ask && ask.amount === 1000, 'request: payments allocate to the request first; the ask is its remaining');
    const charge = computeInstallmentCharge({ job: j, installments: rows, payments: [pay(8000)], pendingSum: 600 });
    ok(charge && charge.amount === 400, 'request: pending ACH nets against the requested ask');
    const noCharge = computeInstallmentCharge({ job: j, installments: rows, payments: [pay(8000)], pendingSum: 999.9 });
    ok(noCharge === null, 'request: an ask fully covered by pending ACH is not chargeable');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
