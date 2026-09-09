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
    else if(url.includes('/settings?')) data=overrides.settings??[{key:'owner_studio_enabled',value:'true'}];
    else if(url.includes('/pec_owner_documents?')) {
      const params=new URL(url).searchParams,key=params.get('doc_key'),owner=params.get('auth_user_id')?.slice(3);
      const rows=overrides.docMap ? Object.entries(overrides.docMap).map(([doc_key,doc])=>({doc_key,...doc})) : overrides.documents??[];
      data=rows.filter(row=>(!row.auth_user_id||row.auth_user_id===owner)&&(key.startsWith('eq.')?row.doc_key===key.slice(3):row.doc_key.startsWith(key.slice(5,-1))));
      if(params.get('order')==='doc_key.desc')data.sort((a,b)=>b.doc_key.localeCompare(a.doc_key));
    }
    else if(url.startsWith('https://api.anthropic.com/')) data={content:[{type:'text',text:'Synthetic analysis'}]};
    else if(url.includes('/leads?')||url.includes('/jobs?')) {
      const isLead=url.includes('/leads?'),source=isLead?overrides.liveLeads:overrides.liveJobs,params=new URL(url).searchParams;
      if(source) {
        data=source.filter(row=>isLead?(!row.brand||row.brand==='PEC')&&!row.deleted_at:(!row.company||row.company==='prescott-epoxy')&&!row.archived_at&&!row.voided_at);
        const order=params.get('order');
        if(order?.endsWith('.asc')){const field=order.slice(0,-4);data=data.filter(row=>row[field]).sort((a,b)=>a[field].localeCompare(b[field])).slice(0,1);}
        else {
          if(isLead)for(const filter of params.getAll('created_at'))data=data.filter(row=>filter.startsWith('gte.')?row.created_at>=filter.slice(4):row.created_at<filter.slice(3));
          else {const range=params.get('or')||'',start=range.match(/signed_date\.gte\.([\d-]+)/)?.[1],end=range.match(/signed_date\.lt\.([\d-]+)/)?.[1];if(start&&end)data=data.filter(row=>[row.signed_date,row.completed_date].some(date=>date&&date>=start&&date<end));}
          const offset=Number(params.get('offset')||0);data=data.sort((a,b)=>a.id.localeCompare(b.id)).slice(offset,offset+Number(params.get('limit')||1000));
        }
      } else data=isLead?[{id:'lead-one'}]:overrides.jobs??[{id:'job-one',price:2500,dripjobs_deal_id:'deal-one'}];
    }
    else if(url.includes('/pec_owner_revisions?')) {
      const params=new URL(url).searchParams;
      data=(overrides.revisions??[]).filter(row=>(!row.auth_user_id||row.auth_user_id===params.get('auth_user_id')?.slice(3))&&(!params.has('doc_key')||row.doc_key===params.get('doc_key').slice(3))&&(!params.has('revision')||row.revision===Number(params.get('revision').slice(3)))&&(!params.has('request_id')||row.request_id===params.get('request_id').slice(3)));
    }
    else if(url.endsWith('/rpc/pec_owner_save_document')) data=typeof overrides.save==='function'?await overrides.save({url,opts}):overrides.save??{ok:true,revision:1,replayed:false};
    else throw new Error('Unexpected network request');
    if(overrides.fail && url.includes(overrides.fail)) return {ok:false,status:500};
    return {ok:true,status:200,json:async()=>data};
  };
  return {calls,handler:createHandler({fetchImpl,env:{...env,...overrides.env},now:overrides.now??(()=>new Date('2026-09-07T15:00:00Z'))})};
}
const event=(action='status',body)=>({httpMethod:body===undefined?'GET':'POST',headers:{authorization:'Bearer user-test-token'},queryStringParameters:{action},...(body===undefined?{}:{body:JSON.stringify(body)})});
const draft={key:'focus:2026-09-07',revision:0,requestId,body:{status:'draft',answers:{commitment:'Plan tomorrow'}}};
const financeFixture=()=>({schemaVersion:1,year:2026,source:{name:'Synthetic'},sheets:[
  {id:'budget',name:'Budget - 2',kind:'budget',rows:10,cols:10,cells:{A1:{v:100,editable:true,role:'plan'},B1:{v:null,f:'=A1*2'}}},
  {id:'income',name:'Income Statement - 2',kind:'income',rows:10,cols:10,cells:{A1:{v:null,f:"='Budget - 2'!B1"},B1:{v:75,editable:true,role:'actual'}}},
]});
const keyedEvent=(action,key)=>({...event(action),queryStringParameters:{action,key}});
const liveEvent=year=>({...event('mbp-live'),queryStringParameters:{action:'mbp-live',year:String(year)}});
async function mbpFixture(overrides={}){
  const {ownerFixture}=await import('./owner-test-fixture.js');
  const body={status:'draft',source:{file:'Synthetic workbook'},mbp:ownerFixture()};
  const docMap={'mbp:2026':{revision:3,body}},revisions=[];
  const liveLeads=[{id:'lead-start',created_at:'2026-07-11T12:00:00Z'},{id:'lead-sunday',created_at:'2026-09-07T06:59:59Z'},{id:'lead-monday',created_at:'2026-09-07T07:00:00Z'},{id:'lead-future',created_at:'2026-09-08T12:00:00Z'},{id:'lead-ftp',brand:'FTP',created_at:'2026-09-07T08:00:00Z'}];
  const liveJobs=[{id:'job-start',signed_date:'2026-05-06',completed_date:'2026-05-22',price:100,dripjobs_deal_id:'first'},{id:'job-prior',signed_date:'2026-09-03',completed_date:'2026-09-04',price:1100,dripjobs_deal_id:'prior'},{id:'job-current',signed_date:'2026-09-07',completed_date:null,price:1200,dripjobs_deal_id:'current'},{id:'job-future',signed_date:'2026-09-08',completed_date:null,price:1300,dripjobs_deal_id:'future'},{id:'job-ftp',company:'finishing-touch',signed_date:'2026-09-07',price:9000}];
  const save=async({opts})=>{const row=JSON.parse(opts.body),doc={doc_key:row.p_doc_key,revision:row.p_expected_revision+1,body:row.p_body};docMap[row.p_doc_key]=doc;revisions.push({...doc,auth_user_id:row.p_auth_user_id,request_id:row.p_request_id});return {ok:true,revision:doc.revision,replayed:false};};
  return {body,docMap,revisions,...fixture({docMap,revisions,liveLeads,liveJobs,save,...overrides})};
}

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
test('finance document and history reads accept bounded yearly keys while keeping legacy keys',async()=>{
  for(const key of ['finance:2020','finance:2026','finance:2100','source:finance:2026','mbp:2026','source:2026']) {
    const body={marker:'SYNTHETIC PRIVATE RECORD'},f=fixture({docMap:{[key]:{revision:1,body}}});
    const r=await f.handler(keyedEvent('document',key));
    assert.equal(r.statusCode,200,key);assert.deepEqual(JSON.parse(r.body).document.body,body);
    assert.equal((await f.handler(keyedEvent('history',key))).statusCode,200,key);
    for(const call of f.calls.filter(c=>c.url.includes('/pec_owner_documents?')||c.url.includes('/pec_owner_revisions?'))) {
      const params=new URL(call.url).searchParams;
      assert.equal(params.get('auth_user_id'),`eq.${uid}`);assert.equal(params.get('doc_key'),`eq.${key}`);
    }
  }
  for(const key of ['finance:2019','finance:2101','source:finance:2019','source:finance:2101','finance:2026&auth_user_id=eq.other']) {
    const f=fixture();
    assert.equal((await f.handler(keyedEvent('document',key))).statusCode,400,key);
    assert.equal((await f.handler(keyedEvent('history',key))).statusCode,400,key);
    assert.ok(!f.calls.some(c=>c.url.includes('/pec_owner_documents?')||c.url.includes('/pec_owner_revisions?')));
  }
});
test('finance year picker returns only current owner metadata and never source snapshots or private bodies',async()=>{
  const row=(doc_key,auth_user_id=uid)=>({doc_key,auth_user_id,revision:2,updated_at:'2026-09-07T15:00:00Z',body:{secret:'PRIVATE'}});
  const f=fixture({documents:[row('finance:2026'),row('finance:2027'),row('source:finance:2026'),row('finance:2019'),row('finance:2028','someone-else')]});
  const e=event('finance-years');e.queryStringParameters.auth_user_id='someone-else';
  const r=await f.handler(e);
  assert.equal(r.statusCode,200);assert.match(r.headers['Cache-Control'],/private.*no-store/);assert.equal(r.headers.Vary,'Authorization');
  assert.deepEqual(JSON.parse(r.body).documents,['finance:2027','finance:2026'].map(doc_key=>({doc_key,revision:2,updated_at:'2026-09-07T15:00:00Z'})));
  assert.ok(!r.body.includes('PRIVATE'));assert.ok(!r.body.includes('someone-else'));
  const params=new URL(f.calls.at(-1).url).searchParams;
  assert.equal(params.get('auth_user_id'),`eq.${uid}`);assert.equal(params.get('select'),'doc_key,revision,updated_at');
  const denied=fixture({allowed:false});
  assert.equal((await denied.handler(event('finance-years'))).statusCode,403);
  assert.ok(!denied.calls.some(c=>c.url.includes('/pec_owner_documents?')));
});
test('finance reads and history cannot be redirected to a different owner',async()=>{
  const other={auth_user_id:'someone-else',doc_key:'finance:2026',revision:1,body:{private:'OTHER OWNER'}};
  const f=fixture({documents:[other],revisions:[other]});
  for(const action of ['document','history']) {
    const e=keyedEvent(action,'finance:2026');e.queryStringParameters.auth_user_id='someone-else';
    const r=await f.handler(e);assert.equal(r.statusCode,200);assert.ok(!r.body.includes('OTHER OWNER'));
    assert.deepEqual(JSON.parse(r.body),action==='document'?{document:null}:{revisions:[]});
  }
});
test('finance saves budgets and linked income statement together under the verified owner with revision protection',async()=>{
  const body=financeFixture(),f=fixture({docMap:{'finance:2026':{revision:4,body}}});
  const r=await f.handler(event('save',{key:'finance:2026',revision:3,requestId,body,auth_user_id:'someone-else'}));
  assert.equal(r.statusCode,200);assert.deepEqual(JSON.parse(r.body).document.body,body);
  const calls=f.calls.filter(c=>c.url.endsWith('/rpc/pec_owner_save_document'));assert.equal(calls.length,1);
  const write=JSON.parse(calls[0].opts.body);
  assert.deepEqual(write,{p_auth_user_id:uid,p_doc_key:'finance:2026',p_expected_revision:3,p_request_id:requestId,p_body:body});
  const conflict=fixture({save:{ok:false,conflict:true,revision:5}}),result=await conflict.handler(event('save',{key:'finance:2026',revision:3,requestId,body}));
  assert.equal(result.statusCode,409);assert.equal(JSON.parse(result.body).conflict,true);
  assert.equal(conflict.calls.filter(c=>c.url.endsWith('/rpc/pec_owner_save_document')).length,1);
});
test('finance source imports are immutable and invalid years or models never reach storage',async()=>{
  const body=financeFixture();
  for(const change of [{key:'source:finance:2026'},{key:'finance:2025'},{key:'finance:2019'},{key:'finance:2101'},{body:{...body,year:'2026'}},{body:{...body,sheets:[]}},{body:{...body,schemaVersion:99}}]) {
    const f=fixture(),r=await f.handler(event('save',{key:'finance:2026',revision:0,requestId,body,...change}));
    assert.equal(r.statusCode,400,JSON.stringify(change));
    assert.ok(!f.calls.some(c=>c.url.endsWith('/rpc/pec_owner_save_document')));
  }
});
test('new budget year uses an immutable source revision, clears actuals, and creates without overwriting history',async()=>{
  const original=financeFixture(),f=fixture({revisions:[{auth_user_id:uid,doc_key:'finance:2026',revision:3,body:original}],save:{ok:true,replayed:true}});
  const r=await f.handler(event('finance-create-year',{fromYear:2026,fromRevision:3,year:2027,requestId,auth_user_id:'someone-else'}));
  assert.equal(r.statusCode,200);assert.equal(JSON.parse(r.body).replayed,true);
  const query=new URL(f.calls.find(c=>c.url.includes('/pec_owner_revisions?')).url).searchParams;
  assert.equal(query.get('auth_user_id'),`eq.${uid}`);assert.equal(query.get('doc_key'),'eq.finance:2026');assert.equal(query.get('revision'),'eq.3');
  const writes=f.calls.filter(c=>c.url.endsWith('/rpc/pec_owner_save_document'));assert.equal(writes.length,1);
  const write=JSON.parse(writes[0].opts.body);
  assert.equal(write.p_auth_user_id,uid);assert.equal(write.p_doc_key,'finance:2027');assert.equal(write.p_expected_revision,0);assert.equal(write.p_request_id,requestId);
  assert.equal(write.p_body.year,2027);assert.equal(write.p_body.sheets[0].cells.A1.v,100);
  assert.equal(write.p_body.sheets[1].cells.B1.v,null);assert.equal(write.p_body.sheets[1].cells.A1.f,"='Budget - 2'!B1");
  assert.equal(original.year,2026);assert.equal(original.sheets[1].cells.B1.v,75);
  assert.ok(!f.calls.some(c=>c.opts.method==='PATCH'));
});
test('new budget year refuses invalid requests, missing owner source revisions, and existing target conflicts',async()=>{
  const create={fromYear:2026,fromRevision:3,year:2027,requestId};
  for(const change of [{fromYear:2019},{year:2101},{year:2026},{year:2025},{year:2028},{year:'2027'},{fromRevision:0},{fromRevision:undefined},{requestId:'invalid'}]) {
    const f=fixture();assert.equal((await f.handler(event('finance-create-year',{...create,...change}))).statusCode,400);
    assert.ok(!f.calls.some(c=>c.url.includes('/pec_owner_revisions?')||c.url.endsWith('/rpc/pec_owner_save_document')));
  }
  const otherSource={auth_user_id:'someone-else',doc_key:'finance:2026',revision:3,body:financeFixture()};
  const missing=fixture({revisions:[otherSource]});assert.equal((await missing.handler(event('finance-create-year',create))).statusCode,404);
  assert.ok(!missing.calls.some(c=>c.url.endsWith('/rpc/pec_owner_save_document')));
  const conflict=fixture({revisions:[{...otherSource,auth_user_id:uid}],save:{ok:false,conflict:true,revision:2}});
  const result=await conflict.handler(event('finance-create-year',create));assert.equal(result.statusCode,409);
  assert.equal(conflict.calls.filter(c=>c.url.endsWith('/rpc/pec_owner_save_document')).length,1);
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

test('MBP live feed batches source reads, uses Phoenix weeks, and never fills uncovered history or future weeks with zero',async()=>{
  const f=await mbpFixture(),r=await f.handler(liveEvent(2026)),feed=JSON.parse(r.body);
  assert.equal(r.statusCode,200);assert.equal(feed.throughWeek,'2026-09-13');assert.match(r.headers['Cache-Control'],/private.*no-store/);
  const prior=feed.weeks.find(w=>w.weekEnding==='2026-09-06'),current=feed.weeks.find(w=>w.weekEnding==='2026-09-13');
  assert.deepEqual(prior.actual,{leads:1,estimates:null,jobsBooked:1,bookedDollars:1100,producedDollars:1100,laborHours:null});
  assert.equal(prior.partial,false);assert.equal(current.partial,true);assert.equal(current.actual.leads,1);assert.equal(current.actual.bookedDollars,1200);
  assert.equal(feed.weeks.find(w=>w.weekEnding==='2026-07-12').available.leads,false);
  assert.equal(feed.weeks.find(w=>w.weekEnding==='2026-07-12').actual.leads,null);
  assert.equal(feed.weeks.find(w=>w.weekEnding==='2026-07-19').actual.leads,0);
  assert.equal(feed.coverageStarts.leads,'2026-07-13');assert.equal(feed.coverageStarts.jobsBooked,'2026-05-11');assert.equal(feed.coverageStarts.producedDollars,'2026-05-25');
  assert.ok(feed.weeks.every(w=>w.weekEnding<='2026-09-13'&&!w.available.estimates&&!w.available.laborHours));
  assert.equal(f.calls.filter(c=>c.url.includes('/leads?')||c.url.includes('/jobs?')).length,5);
  assert.ok(f.calls.some(c=>c.url.includes('created_at=gte.2025-12-29T07:00:00Z')));
  assert.ok(!f.calls.some(c=>c.url.endsWith('/rpc/pec_owner_save_document')));
});

test('MBP live source failures and incomplete prices remain unavailable while successful sources refresh',async()=>{
  const f=await mbpFixture({fail:'/leads?'}),feed=JSON.parse((await f.handler(liveEvent(2026))).body),current=feed.weeks.at(-1);
  assert.equal(current.actual.leads,null);assert.equal(current.available.leads,false);assert.equal(current.actual.bookedDollars,1200);
  assert.match(feed.warnings.join(' '),/could not be refreshed/);
  const bad=await mbpFixture({liveJobs:[{id:'first',signed_date:'2026-05-06',completed_date:'2026-05-22',price:100},{id:'missing',signed_date:'2026-09-07',completed_date:'2026-09-07',price:null}]});
  const missing=JSON.parse((await bad.handler(liveEvent(2026))).body).weeks.at(-1);
  assert.equal(missing.actual.jobsBooked,1);assert.equal(missing.available.jobsBooked,true);
  assert.equal(missing.actual.bookedDollars,null);assert.equal(missing.actual.producedDollars,null);
  const repeated=await mbpFixture({liveJobs:[{id:'first',signed_date:'2026-05-06',price:100},{id:'a',signed_date:'2026-09-03',price:100,dripjobs_deal_id:'same'},{id:'b',signed_date:'2026-09-07',price:200,dripjobs_deal_id:'same'}]});
  const duplicate=JSON.parse((await repeated.handler(liveEvent(2026))).body);
  assert.equal(duplicate.weeks.at(-1).available.jobsBooked,false);assert.equal(duplicate.weeks.at(-2).available.bookedDollars,false);
});

test('MBP source pagination includes all rows and cannot disclose another owner or run while disabled',async()=>{
  const liveLeads=Array.from({length:1001},(_,i)=>({id:`lead-${String(i).padStart(4,'0')}`,created_at:'2026-09-01T12:00:00Z'}));
  liveLeads.push({id:'lead-earliest',created_at:'2026-07-11T12:00:00Z'});
  const f=await mbpFixture({liveLeads}),feed=JSON.parse((await f.handler(liveEvent(2026))).body);
  assert.equal(feed.weeks.find(w=>w.weekEnding==='2026-09-06').actual.leads,1001);
  assert.ok(f.calls.some(c=>c.url.includes('/leads?')&&c.url.includes('offset=1000')));
  const disabled=await mbpFixture({settings:[{key:'owner_mbp_live_enabled',value:'false'}]}),off=await disabled.handler(liveEvent(2026));
  assert.equal(JSON.parse(off.body).disabled,true);assert.ok(!disabled.calls.some(c=>c.url.includes('/leads?')||c.url.includes('/jobs?')));
  const denied=await mbpFixture({allowed:false});assert.equal((await denied.handler(liveEvent(2026))).statusCode,403);
  assert.ok(!denied.calls.some(c=>c.url.includes('/leads?')||c.url.includes('/jobs?')||c.url.includes('/pec_owner_documents?')));
  for(const year of ['bad',2019,2101])assert.equal((await (await mbpFixture()).handler(liveEvent(year))).statusCode,400);
});

test('MBP patch saves server-derived sources and explicit manual overrides together, preserving imported and FTP values',async()=>{
  const f=await mbpFixture();
  f.body.mbp.lines[1].sales.weekly.find(w=>w.weekEnding==='2026-08-30').actual.leads=8;
  const patch={year:2026,revision:3,requestId,edits:[{key:'epoxy/sales/2026-09-06/leads',value:7},{key:'painting/revenue/2026-09-06/laborHours',value:3.5}],plan:{status:'active',asOfWeekEnding:'2026-09-06'}};
  const r=await f.handler(event('mbp-inputs',patch));assert.equal(r.statusCode,200,r.body);
  const saved=JSON.parse(r.body).document.body;
  assert.equal(saved.status,'active');assert.equal(saved.mbp.asOfWeekEnding,'2026-09-06');
  assert.equal(saved.mbp.lines[1].sales.weekly.find(w=>w.weekEnding==='2026-08-30').actual.leads,8);
  assert.equal(saved.mbp.lines[0].revenue.weekly.find(w=>w.weekEnding==='2026-09-06').actual.laborHours,3.5);
  assert.equal(saved.mbp.lines[0].sales.weekly.find(w=>w.weekEnding==='2026-09-06').actual.leads,undefined);
  assert.equal(saved.mbpCellState['epoxy/sales/2026-09-06/leads'].origin,'manual');
  assert.equal(saved.mbpCellState['epoxy/sales/2026-09-06/leads'].sourceValue,1);
  const writes=f.calls.filter(c=>c.url.endsWith('/rpc/pec_owner_save_document'));assert.equal(writes.length,1);
  assert.equal(JSON.parse(writes[0].opts.body).p_auth_user_id,uid);
});

test('MBP patch retries confirm the immutable request before reading changed sources or attempting another write',async()=>{
  const f=await mbpFixture(),patch={year:2026,revision:3,requestId,edits:[{key:'epoxy/sales/2026-09-06/leads',value:7}]};
  assert.equal((await f.handler(event('mbp-inputs',patch))).statusCode,200);
  const before=f.calls.length,replayed=await f.handler(event('mbp-inputs',patch));
  assert.equal(replayed.statusCode,200);assert.equal(JSON.parse(replayed.body).replayed,true);
  assert.ok(!f.calls.slice(before).some(c=>c.url.includes('/leads?')||c.url.includes('/jobs?')||c.url.endsWith('/rpc/pec_owner_save_document')));
  const mismatch=await f.handler(event('mbp-inputs',{...patch,edits:[{key:patch.edits[0].key,value:9}]}));assert.equal(mismatch.statusCode,409);
  const replayRead=f.calls.find(c=>c.url.includes('/pec_owner_revisions?')&&c.url.includes('request_id='));
  assert.equal(new URL(replayRead.url).searchParams.get('auth_user_id'),`eq.${uid}`);
});

test('MBP uncertain saves confirm the committed request without repeating the write',async()=>{
  const f=await mbpFixture({fail:'/rpc/pec_owner_save_document'}),patch={year:2026,revision:3,requestId,edits:[{key:'epoxy/sales/2026-09-06/leads',value:7}]};
  const response=await f.handler(event('mbp-inputs',patch));
  assert.equal(response.statusCode,200,response.body);assert.equal(JSON.parse(response.body).replayed,true);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/rpc/pec_owner_save_document')).length,1);
  assert.equal(f.calls.filter(c=>c.url.includes('/pec_owner_revisions?')&&c.url.includes('request_id=')).length,2);
});

test('MBP use-TopCoat resets use a freshly available server value and reject unsupported sources',async()=>{
  const f=await mbpFixture(),key='epoxy/sales/2026-09-06/leads';
  f.body.mbp.lines[1].sales.weekly.find(w=>w.weekEnding==='2026-09-06').actual.leads=7;
  f.body.mbpCellState={[key]:{origin:'manual',updatedAt:'2026-09-01T15:00:00Z',sourceValue:99,sourceUpdatedAt:'2026-09-01T15:00:00Z',sourceAvailable:true}};
  const response=await f.handler(event('mbp-inputs',{year:2026,revision:3,requestId,edits:[{key,mode:'topcoat'}]}));
  assert.equal(response.statusCode,200,response.body);
  const saved=JSON.parse(response.body).document.body;
  assert.equal(saved.mbp.lines[1].sales.weekly.find(w=>w.weekEnding==='2026-09-06').actual.leads,1);
  assert.equal(saved.mbpCellState[key].origin,'topcoat');
  for(const sourceKey of ['epoxy/sales/2026-09-06/estimates','epoxy/revenue/2026-09-06/laborHours','painting/sales/2026-09-06/leads']){
    const unavailable=await mbpFixture(),r=await unavailable.handler(event('mbp-inputs',{year:2026,revision:3,requestId,edits:[{key:sourceKey,mode:'topcoat'}]}));
    assert.equal(r.statusCode,400);assert.ok(!unavailable.calls.some(c=>c.url.endsWith('/rpc/pec_owner_save_document')));
  }
});

test('MBP patches reject stale revisions, invalid fields and plan settings, and legacy whole-document saves',async()=>{
  const base={year:2026,revision:3,requestId,edits:[]};
  for(const change of [{revision:2},{requestId:'invalid'},{edits:[{key:'total/sales/2026-09-06/leads',value:5}]},{edits:[{key:'epoxy/sales/2026-09-06/leads',value:-1}]},{plan:{status:'wrong'}},{plan:{asOfWeekEnding:'2026-09-07'}},{plan:{unknown:'value'}}]){
    const f=await mbpFixture(),r=await f.handler(event('mbp-inputs',{...base,...change}));
    assert.ok([400,409].includes(r.statusCode),r.body);assert.ok(!f.calls.some(c=>c.url.endsWith('/rpc/pec_owner_save_document')));
  }
  const legacy=await mbpFixture(),old=await legacy.handler(event('save',{key:'mbp:2026',revision:3,requestId,body:legacy.body}));
  assert.equal(old.statusCode,400);assert.match(old.body,/Reload Growth and Development/);
  assert.ok(!legacy.calls.some(c=>c.url.endsWith('/rpc/pec_owner_save_document')));
});

test('disabled automatic updates still allow manual MBP patches but reject use-TopCoat resets',async()=>{
  const settings=[{key:'owner_mbp_live_enabled',value:'false'}],base={year:2026,revision:3,requestId,edits:[{key:'epoxy/sales/2026-09-06/leads',value:5}]};
  const manual=await mbpFixture({settings});assert.equal((await manual.handler(event('mbp-inputs',base))).statusCode,200);
  assert.ok(!manual.calls.some(c=>c.url.includes('/leads?')||c.url.includes('/jobs?')));
  const reset=await mbpFixture({settings});assert.equal((await reset.handler(event('mbp-inputs',{...base,edits:[{key:base.edits[0].key,mode:'topcoat'}]}))).statusCode,400);
});

test('MBP source settings accept only a boolean switch and bounded refresh minutes',async()=>{
  const f=fixture(),r=await f.handler(event('settings',{values:{owner_mbp_live_enabled:'false',owner_mbp_refresh_minutes:'10'}}));
  assert.equal(r.statusCode,200,r.body);
  const patches=f.calls.filter(c=>c.opts.method==='PATCH');assert.equal(patches.length,2);
  assert.ok(patches.every(c=>c.opts.headers.Authorization==='Bearer user-test-token'));
  for(const values of [{owner_mbp_live_enabled:'yes'},{owner_mbp_refresh_minutes:'0'},{owner_mbp_refresh_minutes:'61'},{owner_mbp_refresh_minutes:'1.5'}]){
    const invalid=fixture();assert.equal((await invalid.handler(event('settings',{values}))).statusCode,400);
    assert.ok(!invalid.calls.some(c=>c.opts.method==='PATCH'));
  }
});
