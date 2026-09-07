import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateMbp } from './owner-mbp.js';
import { ownerFixture } from './owner-test-fixture.js';
import { ownerConfig, routineStatus } from './owner-routine.js';
import { renderMbpGrid, mbpGroups, escapeHtml, createOwnerStudio, checkinSaveMessage, showCheckinSaving } from './owner-studio.js';
test('six rendered grids retain original source groups, 52 weeks, quarter filters and missing markers',()=>{
  for(const sheet of calculateMbp(ownerFixture()).sheets){const html=renderMbpGrid(sheet);assert.equal((html.match(/data-action="edit-week"/g)||[]).length,52);assert.equal((renderMbpGrid(sheet,'4').match(/data-action="edit-week"/g)||[]).length,13);assert.ok(html.includes('Missing inputs'));assert.ok(html.includes(sheet.sourceTabName));}
  assert.equal(mbpGroups('sales').flatMap(g=>g.cols).length,28);
  assert.equal(mbpGroups('revenue').flatMap(g=>g.cols).length,18);
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
    const target={textContent:'Original button',disabled:false},answer={value:'Unsaved answer',disabled:false},alreadyDisabled={disabled:true};
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
