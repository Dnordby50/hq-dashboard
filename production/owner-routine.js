// Pure shared schedule and saved-response validation. Ten minutes is a target,
// not an idle-time requirement. Only a successfully saved response closes a day.
export const FOCUS_FIELDS = Object.freeze([
  ['alignment', 'What goal or quarterly rock needs your attention today?'],
  ['yesterday', 'What happened with your last workday\'s commitments and calendar blocks?'],
  ['signals', 'What do the numbers say, and what information is still missing?'],
  ['difficulty', 'What difficulty or repeating problem will you address?'],
  ['experiment', 'What will you change or test to address it?'],
  ['commitment', 'What is today\'s most important action?'],
  ['definitionOfDone', 'What will done look like?'],
  ['timeBlock', 'When will you protect time for this action?'],
]);

export function ownerConfig(rows = []) {
  const map = Object.fromEntries(rows.map(row => [row.key, row.value]));
  let days;
  try { days = JSON.parse(map.owner_morning_days ?? '[1,2,3,4,5]'); } catch { throw new Error('Morning days setting is invalid.'); }
  if (!Array.isArray(days) || !days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('Morning days setting is invalid.');
  const time = (key, fallback) => {
    const value = map[key] ?? fallback;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Review time setting is invalid.');
    return value;
  };
  const duration = (key, fallback) => {
    const value = Number(map[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 180) throw new Error('Review duration setting is invalid.');
    return value;
  };
  const weeklyDay = Number(map.owner_weekly_day ?? 1);
  if (!Number.isInteger(weeklyDay) || weeklyDay < 0 || weeklyDay > 6) throw new Error('Weekly review day setting is invalid.');
  const timezone = map.owner_timezone ?? 'America/Phoenix';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { throw new Error('Review timezone setting is invalid.'); }
  return {
    enabled: map.owner_studio_enabled === 'true', timezone, morningDays: [...new Set(days)],
    morningTime: time('owner_morning_time', '06:20'), morningMinutes: duration('owner_morning_target_minutes', 10),
    weeklyDay, weeklyTime: time('owner_weekly_time', '08:00'), weeklyMinutes: duration('owner_weekly_target_minutes', 30),
  };
}

export function localClock(now, timezone = 'America/Phoenix') {
  const parsed = new Date(now);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid current time.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(parsed).map(part => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const sunday = new Date(`${day}T00:00:00Z`);
  // Weekly review covers the prior completed Monday-Sunday period.
  sunday.setUTCDate(sunday.getUTCDate() - (weekday === 0 ? 7 : weekday));
  return { day, weekday, time: `${parts.hour}:${parts.minute}`, priorWeekEnding: sunday.toISOString().slice(0, 10) };
}

export function routineStatus(now, config, focus = null) {
  const clock = localClock(now, config.timezone);
  const sameDay = focus?.doc_key === `focus:${clock.day}`;
  const status = sameDay ? focus.body?.status : null;
  const finished = status === 'completed' || status === 'bypassed';
  return { ...clock, status: status ?? 'not_started', due: config.enabled && config.morningDays.includes(clock.weekday) && clock.time >= config.morningTime && !finished };
}

export function validateFocus(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Check-in answers are missing.');
  if (!['draft', 'completed', 'bypassed'].includes(body.status)) throw new Error('Choose a valid check-in status.');
  const answers = {};
  for (const [key, label] of FOCUS_FIELDS) {
    const value = body.answers?.[key];
    if (value != null && typeof value !== 'string') throw new Error(`${label} Use text.`);
    answers[key] = (value ?? '').trim();
    if (answers[key].length > 6000) throw new Error('Keep each response under 6,000 characters.');
    if (body.status === 'completed' && !answers[key]) throw new Error(label);
  }
  const bypassReason = typeof body.bypassReason === 'string' ? body.bypassReason.trim() : '';
  if (body.status === 'bypassed' && !bypassReason) throw new Error('Record a reason for the emergency bypass.');
  if (bypassReason.length > 2000) throw new Error('Keep the bypass reason under 2,000 characters.');
  return { status: body.status, answers, bypassReason };
}
