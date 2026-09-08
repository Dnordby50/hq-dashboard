import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateMbp } from './owner-mbp.js';
import { ownerFixture } from './owner-test-fixture.js';
import { ownerConfig, routineStatus } from './owner-routine.js';
import { renderMbpGrid, mbpGroups, escapeHtml, createOwnerStudio, checkinSaveMessage, showCheckinSaving, renderOwnerHeader, renderMbpPeriodFilter, rockMilestones, renderRockMilestones, rockWeekStart, weeklyRockFocus } from './owner-studio.js';
test('existing checkpoint becomes one milestone without changing the stored record or resurrecting removals',()=>{
  const item={checkpoint:'First line\nSecond line'},before=structuredClone(item);
  assert.deepEqual(rockMilestones(item),[{id:'legacy-checkpoint',title:item.checkpoint,done:false}]);
  assert.deepEqual(item,before);
  assert.deepEqual(rockMilestones({...item,milestones:[]}),[]);
  assert.deepEqual(rockMilestones({checkpoint:'  '}),[]);
  const saved={milestones:[{id:'a',title:'Done step',done:true}]};
  const copy=rockMilestones(saved);copy[0].done=false;assert.equal(saved.milestones[0].done,true);
});
test('rock checklist renders safe editable milestones, completion and weekly focus controls',()=>{
  const html=renderRockMilestones({milestones:[{id:'a',title:'<script>unsafe</script>',done:true,focusWeek:'2026-09-07'}]},0,'2026-09-07');
  assert.ok(html.includes('1 of 1 completed')&&html.includes('Add milestone'));
  assert.ok(html.includes('name="milestone-done-0-0"')&&html.includes('name="milestone-focus-0-0"'));
  assert.ok(html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
  assert.doesNotMatch(html,/<script>|This week’s checkpoint/);
});
test('weekly rock focus stays Monday-Sunday and carries unfinished milestones until completed',()=>{
  assert.equal(rockWeekStart('2026-09-07'),'2026-09-07');
  assert.equal(rockWeekStart('2026-09-13'),'2026-09-07');
  assert.equal(rockWeekStart('2026-09-14'),'2026-09-14');
  assert.equal(rockWeekStart('2027-01-01'),'2026-12-28');
  const items=[{title:'Rock',milestones:[
    {id:'current',title:'Current',done:false,focusWeek:'2026-09-07'},
    {id:'overdue',title:'Carry',done:false,focusWeek:'2026-08-31'},
    {id:'finished',title:'Finished',done:true,focusWeek:'2026-08-31',completedWeek:'2026-09-07'},
    {id:'past',title:'Past',done:true,focusWeek:'2026-08-31',completedWeek:'2026-08-31'},
    {id:'future',title:'Future',done:false,focusWeek:'2026-09-21'},
    {id:'unselected',title:'Unselected',done:false},
  ]}];
  assert.deepEqual(weeklyRockFocus(items,'2026-09-07').map(m=>m.id),['current','overdue','finished']);
  assert.deepEqual(weeklyRockFocus(items,'2026-09-14').map(m=>m.id),['current','overdue']);
  assert.equal(weeklyRockFocus(items,'2026-09-07')[1].milestoneIndex,1);
});
test('top navigation retains every owner destination and marks only the selected tab',()=>{
  const pages=['focus','sales','revenue','budget','income','review','rocks','problems','insights','settings'];
  for(const page of pages) {
    const html=renderOwnerHeader(page,'2026-09-07');
    assert.ok(html.startsWith('<header class="tc-owner-header">'));
    assert.doesNotMatch(html,/<aside|tc-sidebar/);
    assert.equal((html.match(/aria-current="page"/g)||[]).length,1);
    assert.ok(html.includes(`data-page="${page}" aria-current="page"`));
    assert.deepEqual([...html.matchAll(/data-page="([^"]+)"/g)].map(m=>m[1]),pages);
  }
  assert.ok(renderOwnerHeader('sales','<test>').includes('&lt;test&gt;'));
});
test('six rendered grids retain original source groups, 52 weeks, quarter filters and missing markers',()=>{
  for(const sheet of calculateMbp(ownerFixture()).sheets){const html=renderMbpGrid(sheet);assert.equal((html.match(/data-action="edit-week"/g)||[]).length,52);assert.equal((renderMbpGrid(sheet,'4').match(/data-action="edit-week"/g)||[]).length,13);assert.ok(html.includes('Missing inputs'));assert.ok(html.includes(sheet.sourceTabName));}
  assert.equal(mbpGroups('sales').flatMap(g=>g.cols).length,26);
  assert.equal(mbpGroups('revenue').flatMap(g=>g.cols).length,18);
});
test('sales grids omit both override columns without changing source calculations or header alignment',()=>{
  const input=ownerFixture();
  input.lines[0].sales.weekly[0].leadConversionOverride=.75;
  input.lines[0].sales.weekly[0].salesRatioOverride=.65;
  const computed=calculateMbp(input), before=structuredClone(computed);
  for(const sheet of computed.sheets.filter(s=>s.kind==='sales')) {
    const html=renderMbpGrid(sheet), groups=mbpGroups(sheet.kind);
    assert.doesNotMatch(html,/Weekly override|!AL\d|!AO\d/);
    assert.ok(html.includes('LEAD CONVERSION')&&html.includes('SALES RATIO'));
    for(const g of groups) {assert.equal(g.cols.length,g.heads.length);assert.equal(g.cols.length,g.sub.reduce((n,s)=>n+s[1],0));}
  }
  assert.deepEqual(computed,before);
  assert.equal(input.lines[0].sales.weekly[0].leadConversionOverride,.75);
  assert.equal(input.lines[0].sales.weekly[0].salesRatioOverride,.65);
});
test('period picker offers the full year, all four quarters and all twelve months',()=>{
  for(const value of ['all','1','2','3','4',...Array.from({length:12},(_,i)=>`month:${String(i+1).padStart(2,'0')}`)]) {
    const html=renderMbpPeriodFilter(value);
    assert.equal((html.match(/<option /g)||[]).length,17);
    assert.equal((html.match(/ selected/g)||[]).length,1);
    assert.ok(html.includes(`value="${value}" selected`));
    assert.ok(html.includes('<optgroup label="Quarters">')&&html.includes('<optgroup label="Months">'));
  }
});
test('month filtering partitions every sheet by week-ending date and leaves cumulative data intact',()=>{
  for(const sheet of calculateMbp(ownerFixture()).sheets) {
    const before=structuredClone(sheet), shown=[];
    for(let month=1;month<=12;month++) {
      const mm=String(month).padStart(2,'0'), html=renderMbpGrid(sheet,`month:${mm}`);
      const dates=[...html.matchAll(/data-week="([^"]+)"/g)].map(m=>m[1]);
      assert.deepEqual(dates,sheet.rows.filter(r=>r.weekEnding.slice(5,7)===mm).map(r=>r.weekEnding));
      assert.ok(html.includes('Month uses the week-ending date.')&&html.includes('Summary and footer remain full-year.'));
      if(month===3) {assert.ok(!dates.includes('2026-04-05'));assert.ok(dates.includes('2026-03-29'));}
      shown.push(...dates);
    }
    assert.deepEqual(shown,sheet.rows.map(r=>r.weekEnding));
    assert.deepEqual(sheet,before);
  }
});
test('owner and AI text is escaped, never injected as markup',()=>{assert.equal(escapeHtml('<script>"x" & \'y\'</script>'),'&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;');});
test('check-in feedback distinguishes draft, completed and bypassed results beside the action',()=>{
  assert.match(checkinSaveMessage(null),/Save before leaving/);
  assert.match(checkinSaveMessage('draft'),/Draft saved.*Complete every answer/);
  assert.match(checkinSaveMessage('completed'),/completed and saved/);
  assert.match(checkinSaveMessage('bypassed'),/bypass saved/);
});
test('pending check-ins show immediate progress, block duplicate clicks, and preserve answers on release',()=>{
  for(const action of ['save-focus','complete-focus','bypass-focus']) {
    const target={tagName:'BUTTON',textContent:'Original button',disabled:false},answer={value:'Unsaved answer',disabled:false},alreadyDisabled={disabled:true};
    const notices=[{textContent:''},{textContent:''}],attributes=new Map();
    const root={querySelectorAll:selector=>selector==='button,input,textarea,select'?[target,answer,alreadyDisabled]:notices,setAttribute:(k,v)=>attributes.set(k,v),removeAttribute:k=>attributes.delete(k)};
    const release=showCheckinSaving(root,target,action);
    assert.equal(attributes.get('aria-busy'),'true');assert.ok(target.disabled&&answer.disabled);
    assert.equal(notices[0].textContent,target.textContent);assert.equal(notices[1].textContent,target.textContent);
    assert.match(target.textContent,/Saving|Completing|Recording/);assert.equal(answer.value,'Unsaved answer');
    release();assert.equal(attributes.has('aria-busy'),false);assert.equal(target.disabled,false);assert.equal(answer.disabled,false);assert.equal(alreadyDisabled.disabled,true);assert.equal(answer.value,'Unsaved answer');assert.equal(target.textContent,'Original button');
  }
});
test('identity changes invalidate in-flight owner responses and clear access',async()=>{
  let session={user:{id:'one'},access_token:'one'},finish;
  const studio=createOwnerStudio({getSession:()=>session,openOwner:()=>{},fetchImpl:()=>new Promise(resolve=>{finish=resolve;})});
  const loading=studio.bootstrap();session={user:{id:'two'},access_token:'two'};studio.sessionChanged();
  finish({ok:true,status:200,json:async()=>({allowed:true,userId:'one'})});
  assert.equal(await loading,false);assert.equal(studio.isAllowed(),false);
});
test('temporary discovery failures show retry access and recover with bounded read-only backoff',async()=>{
  let clock=new Date('2026-09-07T15:00:00Z'),calls=0,access=[];
  const config=ownerConfig([{key:'owner_studio_enabled',value:'true'}]);
  const studio=createOwnerStudio({getSession:()=>({user:{id:'one'},access_token:'one'}),openOwner:()=>{},now:()=>clock,onAccess:v=>access.push(v),fetchImpl:async()=>{
    calls++;return calls===1?{ok:false,status:503,json:async()=>({error:'Temporary outage'})}:{ok:true,status:200,json:async()=>({config,routine:routineStatus(clock,config)})};
  }});
  assert.equal(await studio.bootstrap(),false);assert.equal(access.at(-1),null);
  studio.tick();assert.equal(calls,1);
  clock=new Date(clock.getTime()+31000);studio.tick();await studio.bootstrap();
  assert.equal(calls,2);assert.equal(studio.isAllowed(),true);assert.equal(studio.due(),true);
});
