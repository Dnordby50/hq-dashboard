// Shared new-lead office alerts (Slack + staff bell), extracted verbatim from
// pec-lead-intake.cjs (prompt 73 Parts E1/E2) so the web-form intake and the
// Instant Pricing funnel share ONE implementation. Behavior-identical move;
// only the log prefix changed (the caller is no longer always the intake).

const { SITE_URL } = require('./_pec-drip.cjs');

// Slack alert for every new online lead. New channel via SLACK_LEADS_WEBHOOK,
// falling back to SLACK_OFFICE_WEBHOOK, clean logged no-op when neither is
// set (the pec-notify-costing-sendback pattern). Fire-and-forget contract:
// nothing here can fail the caller's response.
async function notifyLeadSlack(lead, projectNotes, instant) {
  const hook = process.env.SLACK_LEADS_WEBHOOK || process.env.SLACK_OFFICE_WEBHOOK;
  if (!hook) {
    console.log('lead-notify: no Slack webhook set (SLACK_LEADS_WEBHOOK / SLACK_OFFICE_WEBHOOK); lead alert skipped');
    return;
  }
  const instantLine = instant && Array.isArray(instant.sent) && instant.sent.length
    ? `Instant reply sent (${instant.sent.join(' + ')})${instant.skipped && instant.skipped.length ? `; skipped ${instant.skipped.join(', ')}` : ''}`
    : `Instant reply NOT sent (${(instant && instant.reason) || 'unknown'})`;
  const lines = [
    `:large_green_circle: *New lead: ${lead.full_name || 'Unknown'}*`,
    `Source: ${lead.source || 'unknown'}`,
    lead.phone ? `Phone: <tel:+1${lead.phone}|${lead.phone}>` : null,
    lead.email ? `Email: ${lead.email}` : null,
    projectNotes ? `Project: ${projectNotes}` : null,
    instantLine,
    `<${SITE_URL}/#leads|Open TopCoat leads>`,
  ].filter(Boolean);
  try {
    const res = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
    });
    if (!res.ok) console.warn(`lead-notify: Slack lead alert failed (${res.status})`);
  } catch (err) {
    console.warn('lead-notify: Slack lead alert failed:', err && err.message);
  }
}

// Staff bell row. Web-form leads arrive unassigned, so the bell is the
// office-wide alert (the same global pec_notifications feed the booking bell
// uses); when rep assignment at intake exists someday, target it here.
// Best-effort like everything after the insert.
async function notifyLeadBell(db, lead, instant) {
  await db('POST', '/pec_notifications', {
    type: 'lead_created',
    body: `New ${lead.source || 'online'} lead: ${lead.full_name || 'Unknown'}`
      + (instant && instant.sent && instant.sent.length ? ` (instant ${instant.sent.join(' + ')} reply sent)` : ''),
    target_view: 'leads',
    target_id: lead.id,
  }).catch(e => console.warn('lead-notify: lead bell failed (non-fatal):', e && e.message));
}

module.exports = { notifyLeadSlack, notifyLeadBell };
