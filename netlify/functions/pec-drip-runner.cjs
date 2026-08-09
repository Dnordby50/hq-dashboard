// Scheduled function: the lead drip engine's tick. All logic lives in
// _pec-drip.cjs (runDrips) with injectable deps so the fixture test drives
// the same code. Runs every 15 minutes (netlify.toml); the taper is
// day-grained, so cadence is forgiving and overlapping runs are safe (the
// claim-first conditional advance in runDrips makes a double-send
// impossible).
//
// Also callable on-demand (curl / browser) for manual ticks and verification,
// same posture as pec-auto-progress: an outside call can only trigger an
// ordinary run, and with the master switch OFF (settings key
// 'drip_sending_enabled', seeded 'false') a run is a no-op.

const { sb, json } = require('./_pec-supabase.cjs');
const {
  runDrips, drainBlasts, flushApprovedDrips, enrollJobInvoiceDrip,
  sendQuoSmsReal, sendResendEmailReal, getSmsSender, getEmailSender,
  dripEmailHtml, getBrandAccent, STOP_LINE, SITE_URL,
} = require('./_pec-drip.cjs');
const { runInstallmentTriggers } = require('./_pec-installments.cjs');

exports.handler = async () => {
  try {
    const summary = await runDrips({ sb });
    // Prompt 45: the invoice-installment milestone pass rides the same tick.
    // Fired milestones queue into the approval gate (or auto-send when the
    // gate is off); the module is settings-gated and every failure is its own,
    // never the drip run's. Providers are injected here so _pec-installments
    // stays require-free of the drip engine (no circular require) and the
    // fixture tests can stub them.
    let installments = null;
    try {
      // Prompt 81: the injected renderer carries the brand accent so the
      // installment reminder's pay tail renders as the accent button too.
      const accent = await getBrandAccent(sb);
      installments = await runInstallmentTriggers({
        sb,
        providers: {
          sendSms: sendQuoSmsReal, sendEmail: sendResendEmailReal,
          getSmsSender, getEmailSender, dripEmailHtml: (t) => dripEmailHtml(t, { accent }),
          enrollInvoiceDrip: enrollJobInvoiceDrip, STOP_LINE, SITE_URL,
        },
      });
    } catch (err) { console.error('pec-drip-runner: installment pass failed:', err && err.message || err); }
    // Prompt 42: flush drip sends a human approved during quiet hours (they
    // sit as 'queued' with the edited copy until the window opens; consent
    // and kill-switches are re-checked in the flush before sending).
    let approved = null;
    try { approved = await flushApprovedDrips({ sb }); }
    catch (err) { console.error('pec-drip-runner: approved flush failed:', err && err.message || err); }
    // Phase 3: the same tick also drains any in-flight blasts (the safety net
    // behind pec-blast-run's immediate kick; resumes after crashes, quiet
    // hours, or the master switch turning on later). One pass per tick keeps
    // the combined work inside the function time limit; big blasts finish
    // over successive ticks or via pec-blast-run.
    let blasts = null;
    try { blasts = await drainBlasts({ sb }); }
    catch (err) { console.error('pec-drip-runner: blast drain failed:', err && err.message || err); }
    console.log('pec-drip-runner:', JSON.stringify({ ...summary, approved, blasts, installments }));
    return json(200, { ok: true, ...summary, approved, blasts, installments });
  } catch (err) {
    console.error('pec-drip-runner failed:', err && err.message || err);
    return json(500, { ok: false, error: String(err && err.message || err) });
  }
};
