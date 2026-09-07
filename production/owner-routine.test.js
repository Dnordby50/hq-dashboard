import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownerConfig, routineStatus, localClock, validateFocus, FOCUS_FIELDS } from './owner-routine.js';
const enabled = ownerConfig([{key:'owner_studio_enabled',value:'true'}]);
test('weekday Phoenix 6:20 gate has precise boundaries and no daylight-saving drift', () => {
  assert.equal(routineStatus('2026-09-07T13:19:59Z',enabled).due,false);
  assert.equal(routineStatus('2026-09-07T13:20:00Z',enabled).due,true);
  assert.equal(routineStatus('2026-09-07T22:00:00Z',enabled).due,true);
  assert.equal(routineStatus('2026-09-12T15:00:00Z',enabled).due,false);
  assert.equal(routineStatus('2026-12-07T13:20:00Z',enabled).due,true);
  assert.equal(routineStatus('2026-09-07T15:00:00Z',ownerConfig()).due,false);
});
test('saved completion and reasoned bypass close only their own day', () => {
  for (const status of ['completed','bypassed']) {
    const focus={doc_key:'focus:2026-09-07',body:{status}};
    assert.equal(routineStatus('2026-09-07T15:00:00Z',enabled,focus).due,false);
    assert.equal(routineStatus('2026-09-08T15:00:00Z',enabled,focus).due,true);
  }
  assert.equal(routineStatus('2026-09-07T15:00:00Z',enabled,{doc_key:'focus:2026-09-07',body:{status:'draft'}}).due,true);
});
test('weekly review covers the last completed Sunday and does not replace Monday morning', () => {
  assert.equal(localClock('2026-09-07T15:00:00Z').priorWeekEnding,'2026-09-06');
  assert.equal(localClock('2026-09-13T15:00:00Z').priorWeekEnding,'2026-09-06');
  assert.equal(localClock('2026-09-14T15:00:00Z').priorWeekEnding,'2026-09-13');
  assert.equal(routineStatus('2026-09-07T15:00:00Z',enabled).due,true);
});
test('completion requires every response, not ten elapsed minutes', () => {
  const answers=Object.fromEntries(FOCUS_FIELDS.map(([key])=>[key,'A considered response']));
  assert.equal(validateFocus({status:'completed',answers}).status,'completed');
  for (const [key] of FOCUS_FIELDS) assert.throws(()=>validateFocus({status:'completed',answers:{...answers,[key]:'  '}}));
  assert.equal(validateFocus({status:'draft',answers:{}}).status,'draft');
  assert.throws(()=>validateFocus({status:'bypassed',bypassReason:'  '}));
  assert.equal(validateFocus({status:'bypassed',bypassReason:'Site emergency'}).bypassReason,'Site emergency');
});
test('settings reject malformed schedules and retain explicit valid custom timing', () => {
  for (const [key,value] of [['owner_morning_days','bad'],['owner_morning_days','[]'],['owner_morning_time','25:00'],['owner_weekly_day','7'],['owner_timezone','Mars'],['owner_morning_target_minutes','0']]) {
    assert.throws(()=>ownerConfig([{key,value}]));
  }
  const config=ownerConfig([{key:'owner_morning_time',value:'07:15'}]);
  assert.equal(config.morningTime,'07:15');
  assert.equal(config.morningMinutes,10);
});
