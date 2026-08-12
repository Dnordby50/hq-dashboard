// Birthday reminder tick (prompt 54, Part E). Daily on a Netlify schedule
// (netlify.toml, 14:30 UTC = 07:30 MST, after the drift check). Raises ONE
// pec_notifications bell per person per year when their birthday is within
// birthday_reminder_lead_days (default 7). Notifications are global rows, so
// one insert reaches every user's bell; the dashboard banner is the client-
// side leg of the same reminder and reads people directly.
//
// WHY "within lead days" and not "exactly lead days out": a run that fails or
// a function that deploys mid-window would silently skip that year's reminder
// if we matched a single day. Instead every day in the window is a candidate
// and the 60-day dedupe (any prior birthday bell for the same person, read or
// unread) keeps it to one bell per year. 60 days safely exceeds the max lead
// while staying far under the 365-day cadence.
//
// In-app only by design (locked decision): no email, no SMS.
// Birthdays are month/day only; no year is stored and no age is computed,
// anywhere, including here.

const { sb, json, requireStaff } = require('./_pec-supabase.cjs');

// Phoenix "today" as YYYY-MM-DD (single-timezone project, no DST in AZ).
function phxToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
}
// Days until the next occurrence of month/day. Feb 29 rolls to Mar 1 in
// non-leap years via Date.UTC overflow (celebrate, never skip).
function daysToBirthday(m, d, todayStr) {
  const ty = Number(todayStr.slice(0, 4));
  const mk = (yy) => new Date(Date.UTC(yy, m - 1, d)).toISOString().slice(0, 10);
  let cand = mk(ty);
  if (cand < todayStr) cand = mk(ty + 1);
  return Math.round((Date.parse(cand) - Date.parse(todayStr)) / 86400000);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

exports.handler = async (event) => {
  try {
    // Scheduled runs arrive with a { next_run } body and no HTTP caller; any
    // other invocation must present a staff JWT (same gate as the drift check).
    let isScheduled = false;
    try { isScheduled = !!JSON.parse(event.body || '{}').next_run; } catch (_) { isScheduled = false; }
    if (!isScheduled) {
      const auth = await requireStaff(event);
      if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });
    }

    let settings = {};
    try {
      const rows = await sb('GET', '/settings?key=in.(birthday_reminder_enabled,birthday_reminder_lead_days)&select=key,value');
      settings = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
    } catch (_) { /* defaults below */ }
    if (String(settings.birthday_reminder_enabled || 'true') === 'false') {
      return json(200, { ok: true, skipped: 'birthday_reminder_enabled is false' });
    }
    const lead = Math.max(0, parseInt(settings.birthday_reminder_lead_days, 10) || 7);

    // Before the people-model migration the table is missing; a scheduled run
    // is then a silent no-op, same convention as the appointment runner.
    let people;
    try {
      people = await sb('GET', '/people?select=id,full_name,display_name,birth_month,birth_day&active=eq.true&birth_month=not.is.null');
    } catch (e) {
      if (/does not exist|relation/i.test(String(e.message || ''))) return json(200, { ok: true, skipped: 'people table not migrated yet' });
      throw e;
    }

    const today = phxToday();
    const due = (people || []).filter((p) => {
      const du = daysToBirthday(p.birth_month, p.birth_day, today);
      return du <= lead;
    });

    let created = 0;
    for (const p of due) {
      // One bell per person per year: any birthday bell for this person in the
      // last 60 days, read or not, suppresses a new one.
      const since = new Date(Date.now() - 60 * 86400000).toISOString();
      const dupes = await sb('GET', `/pec_notifications?type=eq.birthday&target_id=eq.${p.id}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=1`);
      if ((dupes || []).length) continue;
      const du = daysToBirthday(p.birth_month, p.birth_day, today);
      const name = p.display_name || p.full_name;
      const when = du === 0 ? 'is today 🎉' : du === 1 ? 'is tomorrow' : `is ${MONTHS[p.birth_month - 1]} ${p.birth_day} (in ${du} days)`;
      await sb('POST', '/pec_notifications', {
        type: 'birthday',
        body: `🎂 ${name}'s birthday ${when}`,
        priority: 'normal',
        target_view: 'people',
        target_id: p.id,
      });
      created += 1;
    }
    return json(200, { ok: true, candidates: due.length, created, lead });
  } catch (err) {
    console.error('[pec-birthday-reminders]', err);
    return json(500, { ok: false, error: String((err && err.message) || err) });
  }
};

// Heartbeat (prompt 90 Task A): stamp AFTER a successful run by wrapping the
// handler, so every ok exit path stamps (including gated no-ops: the
// SCHEDULE firing is what the monitor watches, not the feature toggle)
// without touching each return site. Best-effort by contract; a heartbeat
// failure never fails the job.
{
  const { writeHeartbeat } = require('./_pec-supabase.cjs');
  const _handler = exports.handler;
  exports.handler = async (event, context) => {
    const res = await _handler(event, context);
    try {
      if (res && res.statusCode === 200 && JSON.parse(res.body || '{}').ok === true) await writeHeartbeat('pec-birthday-reminders');
    } catch (_) { /* best-effort */ }
    return res;
  };
}
