const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHandler } = require('../netlify/functions/pec-owner-studio.cjs');
const uid='00000000-0000-4000-8000-000000000001';
const requestId='00000000-0000-4000-8000-000000000002';
const env={SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'server-test-only'};
function fixture(overrides={}) {
  const calls=[];
  const fetchImpl=async (url,opts)=>{
    calls.push({url,opts});
    let data;
    if(url.endsWith('/auth/v1/user')) data=overrides.user??{id:uid};
    else if(url.endsWith('/rpc/pec_owner_authorized')) data=overrides.allowed??true;
    else if(url.includes('/settings?')) data=[{key:'owner_studio_enabled',value:'true'}];
    else if(url.includes('/pec_owner_documents?')) data=overrides.docMap ? [overrides.docMap[new URL(url).searchParams.get('doc_key').slice(3)]].filter(Boolean) : overrides.documents??[];
    else if(url.startsWith('https://api.anthropic.com/')) data={content:[{type:'text',text:'Synthetic analysis'}]};
    else if(url.includes('/leads?')) data=[{id:'lead-one'}];
    else if(url.includes('/jobs?')) data=overrides.jobs??[{id:'job-one',price:2500,dripjobs_deal_id:'deal-one'}];
    else if(url.includes('/pec_owner_revisions?')) data=[];
    else if(url.endsWith('/rpc/pec_owner_save_document')) data=overrides.save??{ok:true,revision:1,replayed:false};
    else throw new Error('Unexpected network request');
    if(overrides.fail && url.includes(overrides.fail)) return {ok:false,status:500};
    return {ok:true,status:200,json:async()=>data};
  };
  return {calls,handler:createHandler({fetchImpl,env:{...env,...overrides.env},now:()=>new Date('2026-09-07T15:00:00Z')})};
}
const event=(action='status',body)=>({httpMethod:body===undefined?'GET':'POST',headers:{authorization:'Bearer user-test-token'},queryStringParameters:{action},...(body===undefined?{}:{body:JSON.stringify(body)})});
const draft={key:'focus:2026-09-07',revision:0,requestId,body:{status:'draft',answers:{commitment:'Plan tomorrow'}}};

test('no token, invalid user, anonymous account, and other admin never reach private records',async()=>{
  const f=fixture();
  assert.equal((await f.handler({...event(),headers:{}})).statusCode,401); assert.equal(f.calls.length,0);
  for(const options of [{allowed:false},{user:{id:uid,is_anonymous:true}},{fail:'/auth/v1/user'}]) {
    const f=fixture(options), result=await f.handler(event());
    assert.ok([401,403].includes(result.statusCode));
    assert.ok(f.calls.every(call=>!call.url.includes('/settings?')&&!call.url.includes('/pec_owner_documents')));
  }
});
test('entitlement check uses the same verified user JWT and responses cannot be cached',async()=>{
  const f=fixture(),r=await f.handler(event());
  assert.equal(r.statusCode,200); assert.equal(JSON.parse(r.body).routine.due,true);
  assert.match(r.headers['Cache-Control'],/no-store/); assert.equal(r.headers.Vary,'Authorization');
  assert.equal(f.calls[1].opts.headers.Authorization,'Bearer user-test-token');
  assert.ok(f.calls.find(call=>call.url.includes(`auth_user_id=eq.${uid}`)));
});
test('server derives owner identity, validates answers, and preserves request id for atomic saves',async()=>{
  const f=fixture(),r=await f.handler(event('save',{...draft,auth_user_id:'someone-else'}));
  assert.equal(r.statusCode,200);
  const payload=JSON.parse(f.calls.find(call=>call.url.endsWith('/rpc/pec_owner_save_document')).opts.body);
  assert.equal(payload.p_auth_user_id,uid); assert.equal(payload.p_request_id,requestId);
  assert.equal(payload.p_body.answers.commitment,'Plan tomorrow');
  assert.equal(payload.p_body.status,'draft');
  const bad=fixture();
  assert.equal((await bad.handler(event('save',{...draft,body:{status:'completed',answers:{}}}))).statusCode,400);
  assert.ok(!bad.calls.some(call=>call.url.endsWith('/rpc/pec_owner_save_document')));
});
test('bypass requires a reason and cannot mark a future day complete',async()=>{
  for(const change of [{body:{status:'bypassed',bypassReason:' '}},{key:'focus:2026-09-08'},{key:'source:2026'},{requestId:'bad'},{revision:-1},{key:'focus:2026-09-07&auth_user_id=eq.other'}]) {
    const f=fixture(); assert.equal((await f.handler(event('save',{...draft,...change}))).statusCode,400);
    assert.ok(!f.calls.some(call=>call.url.endsWith('/rpc/pec_owner_save_document')));
  }
  assert.equal((await fixture().handler(event('save',{...draft,body:{status:'bypassed',bypassReason:'Client emergency'}}))).statusCode,200);
});
test('stale revision conflicts are surfaced without automatic retry',async()=>{
  const f=fixture({save:{ok:false,conflict:true,revision:2}}),r=await f.handler(event('save',draft));
  assert.equal(r.statusCode,409); assert.equal(JSON.parse(r.body).conflict,true);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/rpc/pec_owner_save_document')).length,1);
});
test('rock milestone checkboxes and weekly assignments save with original notes and revision protection',async()=>{
  const body={items:[{id:'rock',title:'Synthetic rock',checkpoint:'Original checkpoint',notes:'Keep this note',milestones:[{id:'legacy-checkpoint',title:'Original checkpoint',done:true,focusWeek:'2026-09-07',completedWeek:'2026-09-07'}]}]};
  const f=fixture({docMap:{'plan:2026-q4':{revision:4,body}}});
  const r=await f.handler(event('save',{key:'plan:2026-q4',revision:3,requestId,body}));
  assert.equal(r.statusCode,200);
  assert.deepEqual(JSON.parse(r.body).document.body,body);
  const write=JSON.parse(f.calls.find(c=>c.url.endsWith('/rpc/pec_owner_save_document')).opts.body);
  assert.deepEqual(write.p_body,body);assert.equal(write.p_expected_revision,3);assert.equal(write.p_request_id,requestId);
  assert.equal((await fixture().handler(event('save',{key:'plan:2026-q4',revision:0,requestId,body:{items:[{checkpoint:'Legacy, no milestones yet'}]}}))).statusCode,200);
});
test('malformed milestones and invalid weekly assignments never reach the save RPC',async()=>{
  const valid={id:'a',title:'A step',done:false,focusWeek:'2026-09-07'};
  for(const milestones of ['bad',[null],[{...valid,done:'true'}],[{...valid,title:' '}],[valid,valid],Array.from({length:101},(_,i)=>({...valid,id:String(i)})),[{...valid,focusWeek:'2026-09-08'}],[{...valid,completedWeek:'bad'}]]) {
    const f=fixture();
    assert.equal((await f.handler(event('save',{key:'plan:2026-q4',revision:0,requestId,body:{items:[{title:'Rock',milestones}]}}))).statusCode,400);
    assert.ok(!f.calls.some(c=>c.url.endsWith('/rpc/pec_owner_save_document')));
  }
});
test('settings are allowlisted, validated, and written under the owner JWT',async()=>{
  const f=fixture();
  assert.equal((await f.handler(event('settings',{values:{owner_morning_time:'07:00'}}))).statusCode,200);
  const write=f.calls.find(call=>call.opts.method==='PATCH');
  assert.equal(write.opts.headers.Authorization,'Bearer user-test-token');
  for(const values of [{unrelated_setting:'changed'},{owner_morning_time:'26:00'},{owner_studio_enabled:'yes'}]) assert.equal((await fixture().handler(event('settings',{values}))).statusCode,400);
});
test('history reads are owner-scoped and incomplete AI consent does not call a provider',async()=>{
  const f=fixture(),e=event('history');e.queryStringParameters.key='mbp:2026';
  assert.equal((await f.handler(e)).statusCode,200);
  assert.ok(f.calls.at(-1).url.includes(`auth_user_id=eq.${uid}`));
  const r=await f.handler(event('insights',{year:2026}));assert.equal(r.statusCode,400);
  assert.ok(f.calls.every(call=>call.url.startsWith(env.SUPABASE_URL)));
});
test('AI sends only saved goals, KPI summaries and explicitly selected notes to Anthropic',async()=>{
  const {ownerFixture}=await import('./owner-test-fixture.js');
  const docMap={'mbp:2026':{revision:1,body:{status:'draft',mbp:ownerFixture()}},'plan:2026-q4':{body:{items:[{title:'Synthetic goal'}]}},'focus:2026-09-07':{body:{answers:{difficulty:'FOCUS PRIVATE'}}},problems:{body:{items:[{title:'PROBLEM PRIVATE'}]}}};
  for(const selected of [false,true]) {
    const f=fixture({docMap,env:{ANTHROPIC_API_KEY:'test-only'}});
    const r=await f.handler(event('insights',{year:2026,requested:true,includeFocus:selected,includeProblems:selected}));
    assert.equal(r.statusCode,200);
    const requests=f.calls.filter(c=>c.url.startsWith('https://api.anthropic.com/'));
    assert.equal(requests.length,1);
    const prompt=JSON.parse(requests[0].opts.body).messages[0].content;
    assert.equal(prompt.includes('FOCUS PRIVATE'),selected);assert.equal(prompt.includes('PROBLEM PRIVATE'),selected);
    assert.ok(prompt.includes('Synthetic goal'));assert.ok(prompt.includes('coverage'));
    assert.ok(!f.calls.some(c=>c.opts.method==='PATCH'||c.url.endsWith('/pec_owner_save_document')));
  }
  const denied=fixture({allowed:false,docMap,env:{ANTHROPIC_API_KEY:'test-only'}});
  assert.equal((await denied.handler(event('insights',{year:2026,requested:true,includeFocus:true,includeProblems:true}))).statusCode,403);
  assert.ok(!denied.calls.some(c=>c.url.includes('anthropic')));
});
test('PEC CRM preview uses Phoenix weeks and distinct date definitions, leaves unsupported metrics unknown',async()=>{
  const f=fixture(),e=event('crm-week');e.queryStringParameters.week='2026-09-06';
  const r=await f.handler(e),body=JSON.parse(r.body);assert.equal(r.statusCode,200);
  assert.equal(body.actual.leads,1);assert.equal(body.actual.bookedDollars,2500);assert.equal(body.actual.producedDollars,2500);
  assert.equal(body.actual.estimates,null);assert.equal(body.actual.laborHours,null);
  assert.ok(f.calls.some(c=>c.url.includes('2026-08-31T07:00:00Z')));
  assert.ok(f.calls.some(c=>c.url.includes('signed_date=gte.2026-08-31')));
  assert.ok(f.calls.some(c=>c.url.includes('completed_date=gte.2026-08-31')));
  assert.ok(f.calls.every(c=>c.opts.method!=='PATCH'&&!c.url.includes('pec_owner_save_document')));
  const missing=await fixture({jobs:[{id:'job',price:null}]}).handler(e);assert.equal(JSON.parse(missing.body).actual.bookedDollars,null);
  for(const week of ['2026-09-13','2026-09-05','2026-02-30','bad']){e.queryStringParameters.week=week;assert.equal((await fixture().handler(e)).statusCode,400);}
});
