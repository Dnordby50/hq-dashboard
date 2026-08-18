// Per-member Google calendar list management (prompt 96). Two POST actions,
// staff JWT required (same gate as the OAuth start endpoint):
//
//   { member_id, refresh: true }            re-pull Google's calendarList and
//                                           upsert pec_sales_member_google_calendars
//                                           (summary + accessRole refreshed;
//                                           sync_enabled NEVER changed here)
//   { member_id, calendar_id, sync_enabled } flip one calendar's toggle
//
// Reads happen in the browser through the pec_member_google_calendars_v view
// (sync_token excluded); writes come through here because the table is
// default-deny (RLS on, zero policies) and the sync token must stay
// service-role territory. The member's dedicated TopCoat calendar can never
// be toggled: it is the push target, not a pull source.

const { sb, json } = require('./_pec-supabase.cjs');
const { googleConfigured, getFreshAccessToken, gcalFetch, getStaffUser } = require('./_pec-google.cjs');

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
const jc = (statusCode, body) => ({ statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function getMember(memberId) {
  const rows = await sb('GET', `/pec_sales_team_members?id=eq.${encodeURIComponent(memberId)}&select=id,google_connected,google_calendar_id&limit=1`);
  return (Array.isArray(rows) && rows[0]) || null;
}

async function getCalRow(memberId, calendarId) {
  const rows = await sb('GET', `/pec_sales_member_google_calendars?member_id=eq.${encodeURIComponent(memberId)}&calendar_id=eq.${encodeURIComponent(calendarId)}&select=*&limit=1`);
  return (Array.isArray(rows) && rows[0]) || null;
}

async function refreshCalendarList(member) {
  const token = await getFreshAccessToken(sb, member.id);
  if (!token) return { ok: false, error: 'Google token refresh failed; the member may need to reconnect.' };
  const list = await gcalFetch(token, 'GET', '/users/me/calendarList?maxResults=250');
  if (!list.ok || !list.body || !Array.isArray(list.body.items)) {
    return { ok: false, error: `Google calendarList failed (${list.status})` };
  }
  let upserted = 0;
  for (const c of list.body.items) {
    if (!c || !c.id) continue;
    const patch = {
      summary: c.summaryOverride || c.summary || c.id,
      access_role: c.accessRole || null,
      updated_at: new Date().toISOString(),
    };
    const existing = await getCalRow(member.id, c.id);
    if (existing) {
      await sb('PATCH', `/pec_sales_member_google_calendars?id=eq.${encodeURIComponent(existing.id)}`, patch);
    } else {
      // New calendars arrive with sync OFF; ticking them is a human act.
      await sb('POST', '/pec_sales_member_google_calendars', {
        member_id: member.id, calendar_id: c.id, sync_enabled: false, ...patch,
      });
    }
    upserted++;
  }
  return { ok: true, calendars: upserted };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return jc(405, { ok: false, error: 'Method not allowed' });

  const user = await getStaffUser(event);
  if (!user) return jc(401, { ok: false, error: 'Not authenticated' });
  if (!googleConfigured()) return jc(200, { ok: false, error: 'Google sync is not configured.' });

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return jc(400, { ok: false, error: 'Invalid JSON' }); }
  if (!input.member_id) return jc(400, { ok: false, error: 'member_id is required' });

  try {
    const member = await getMember(String(input.member_id));
    if (!member) return jc(404, { ok: false, error: 'Unknown sales team member' });
    if (!member.google_connected) return jc(200, { ok: false, error: 'This member is not connected to Google.' });

    if (input.refresh) {
      const out = await refreshCalendarList(member);
      return jc(200, out);
    }

    if (input.calendar_id && typeof input.sync_enabled === 'boolean') {
      if (input.calendar_id === member.google_calendar_id) {
        return jc(200, { ok: false, error: 'The TopCoat calendar is the push target and always stays as it is.' });
      }
      const row = await getCalRow(member.id, String(input.calendar_id));
      if (!row) return jc(404, { ok: false, error: 'Unknown calendar; refresh the list first.' });
      // Enabling clears the sync token so the first pull is a fresh FULL
      // sync under the current settings window (a stale token from an
      // earlier enable would sidestep the window). Disabling leaves
      // imported rows in place; they simply stop updating.
      const patch = input.sync_enabled
        ? { sync_enabled: true, sync_token: null, last_error: null }
        : { sync_enabled: false };
      await sb('PATCH', `/pec_sales_member_google_calendars?id=eq.${encodeURIComponent(row.id)}`, patch);
      return jc(200, { ok: true, calendar_id: input.calendar_id, sync_enabled: input.sync_enabled });
    }

    return jc(400, { ok: false, error: 'Nothing to do: pass refresh or a calendar toggle.' });
  } catch (err) {
    console.error('pec-google-calendars failed:', err && err.message || err);
    return jc(500, { ok: false, error: String(err && err.message || err) });
  }
};
