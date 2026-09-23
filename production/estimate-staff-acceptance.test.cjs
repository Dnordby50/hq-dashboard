'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const file = require.resolve('../netlify/functions/pec-public-estimate.cjs');
const nativeRequire = createRequire(file);
const clone = value => JSON.parse(JSON.stringify(value));
const E = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';
function fixture(opts = {}) {
  const tables = {
    estimates: [{ id:E, customer_id:C, customer_name:'Fixture Company', customer_is_commercial:true, customer_company:'Fixture Company', brand:'PEC', status:'sent', sent_at:'2026-09-01T12:00:00Z', rev:2, price:5000, is_custom:true, ...opts.estimate }],
    customers: [{id:C,name:'Fixture Company',company:'prescott-epoxy'}],
    estimate_line_items: [
      {id:'base',estimate_id:E,label:'Base work',description:'Prepare and coat the floor.',total:5000,is_optional:false},
      {id:'extra',estimate_id:E,label:'Extra work',description:'Coat the extra room.',total:1000,is_optional:true,selected_by_customer:false},
    ],
    estimate_installments:[{estimate_id:E,seq:0,label:'Deposit',amount_kind:'percent',amount_value:50,trigger_kind:'acceptance',is_deposit:true},{estimate_id:E,seq:1,label:'Balance',amount_kind:'percent',amount_value:50,trigger_kind:'completion',is_deposit:false}],
  };
  const writes=[]; let fail=opts.failOnce; let authorized=opts.authorized !== false;
  async function db(method,path,body) {
    const url = new URL(path,'https://fixture.test'),table=url.pathname.slice(1);
    const rows=tables[table] ||= [];
    const matches=row=>[...url.searchParams].every(([key,value])=>{
      if(value.startsWith('eq.')) return String(row[key])===value.slice(3);
      if(value==='is.null') return row[key]==null;
      if(value.startsWith('in.(')) return value.slice(4,-1).split(',').includes(row[key]);
      return true;
    });
    if(method==='GET') return clone(rows.filter(matches));
    if(fail===table) { fail=null; throw new Error('fixture interrupted write'); }
    writes.push({method,table,body:clone(body)});
    if(method==='PATCH') { const changed=rows.filter(matches); changed.forEach(row=>Object.assign(row,clone(body))); return clone(changed); }
    if(method==='POST') {const added=(Array.isArray(body)?body:[body]).map((row,i)=>({id:row.id || table+'-'+(rows.length+i),...clone(row)}));rows.push(...added);return clone(added);}
    throw new Error('Unexpected write '+method+' '+path);
  }
  const exported={};
  const context={exports:exported,process:{env:{}},console:{warn(){},error(){}},Buffer,URL,Intl,Date,setTimeout,clearTimeout,
    require(name) {
      if(name==='./_pec-supabase.cjs') return {sb:db,json:(statusCode,body)=>({statusCode,body:JSON.stringify(body)}),requireStaff:async()=>authorized?{ok:true,user:{id:U,email:'staff@example.test'},staff:{name:'Fixture Staff'}}:{ok:false,status:401,error:'Not authenticated'},epoxyStages:['Accepted','Production'],randomToken:()=> 'fixture-token'};
      if(name==='./_pec-busybusy.cjs') return {maybeCreateBusybusyProject:async()=>{}};
      return nativeRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
  const payload={action:'accept_staff',estimate_id:E,expected_rev:2,expected_total:6000,selected_optional_ids:['extra'],accepted_date:'2026-09-20',contract_reference:'Customer contract / PO 42'};
  return {tables,writes,api:exported,async call(overrides={}) {const r=await exported.handler({httpMethod:'POST',headers:{},body:JSON.stringify({...payload,...overrides})});return {status:r.statusCode,...JSON.parse(r.body)};}};
}
test('staff acceptance freezes the contract, creates both jobs and installments, and never fabricates a signature',async()=>{
  const f=fixture(); const r=await f.call();assert.equal(r.status,200,r.error);
  const est=f.tables.estimates[0];assert.equal(est.status,'accepted');assert.equal(est.price,6000);
  assert.equal(est.signed_at,null);assert.equal(est.signed_name,null);assert.equal(est.signed_ip,null);
  assert.equal(est.signature.via,'staff_external_contract');assert.equal(est.signature.accepted_by,U);assert.equal(est.signature.contract_reference,'Customer contract / PO 42');
  assert.equal(est.signature.typed_name,undefined);assert.equal(est.accepted_at,'2026-09-20T07:00:00.000Z');
  assert.equal(f.tables.jobs.length,1);assert.equal(f.tables.pec_prod_jobs.length,1);assert.equal(f.tables.jobs[0].signed_date,'2026-09-20');assert.equal(f.tables.jobs[0].price,6000);
  assert.equal(f.tables.pec_prod_jobs[0].crm_job_id,r.job_id);assert.equal(f.tables.job_areas.length,2);
  assert.equal(f.tables.pec_invoice_installments.reduce((n,row)=>n+row.computed_amount,0),6000);
  const retry=await f.call({accepted_date:'2026-09-22',contract_reference:'DO NOT OVERWRITE',expected_total:1});assert.equal(retry.status,200);assert.equal(retry.already,true);
  assert.equal(f.tables.jobs.length,1);assert.equal(f.tables.pec_prod_jobs.length,1);assert.equal(f.tables.pec_invoice_installments.length,2);assert.equal(est.signature.contract_reference,'Customer contract / PO 42');
});
test('interruption after acceptance heals the frozen selection and same job IDs on explicit retry',async()=>{
  const f=fixture({failOnce:'estimate_line_items'});assert.equal((await f.call()).status,500);assert.equal(f.tables.estimates[0].status,'accepted');
  assert.equal((await f.call({selected_optional_ids:[],expected_total:5000})).status,200);
  assert.equal(f.tables.estimate_line_items[1].selected_by_customer,true);assert.equal(f.tables.jobs.length,1);assert.equal(f.tables.jobs[0].price,6000);assert.equal(f.tables.job_areas.length,2);
});
test('unauthenticated callers, invalid dates, stale totals, changed revisions and missing evidence cannot mutate',async()=>{
  for(const [opts,body,status] of [[{authorized:false},{},401],[{},{accepted_date:'2099-01-01'},400],[{},{accepted_date:'2026-02-30'},400],[{},{contract_reference:' '},400],[{},{expected_total:1},409],[{},{expected_rev:1},409],[{estimate:{status:'lost'}},{},409],[{estimate:{deleted_at:'2026-09-22'}},{},404]]) {
    const f=fixture(opts);assert.equal((await f.call(body)).status,status);assert.equal(f.writes.length,0);
  }
});
test('choice and optional lines carry only the agreed work into the job',async()=>{
  const f=fixture();f.tables.estimate_line_items[0].choice_group='project';f.tables.estimate_line_items.push({id:'choice-b',estimate_id:E,label:'Other project',description:'Other work',total:8000,choice_group:'project'});
  assert.equal((await f.call()).status,400);assert.equal(f.writes.length,0);
  assert.equal((await f.call({choice:'choice-b',selected_optional_ids:[],expected_total:8000})).status,200);
  assert.equal(f.tables.estimates[0].choice_picked_source,'staff');assert.equal(f.tables.estimates[0].choice_picked_by,U);assert.equal(f.tables.jobs[0].price,8000);assert.equal(f.tables.job_areas.length,1);assert.equal(f.tables.job_areas[0].name,'Other project');
});
test('pricing, scope, and payment schedule checks run before accepting',async()=>{
  const scope=fixture();scope.tables.estimate_line_items[0].description='';assert.equal((await scope.call()).status,409);assert.equal(scope.writes.length,0);
  const price=fixture({estimate:{is_custom:false,gp_pct:.1}});price.tables.estimate_line_items=price.tables.estimate_line_items.slice(0,1);assert.equal((await price.call({expected_total:5000,selected_optional_ids:[]})).status,409);assert.equal(price.writes.length,0);
  const schedule=fixture();schedule.tables.estimate_installments[1].amount_value=60;assert.equal((await schedule.call()).status,409);assert.equal(schedule.writes.length,0);
});
test('public accept ignores forged staff metadata and still requires the customer signature',async()=>{
  const f=fixture();f.tables.estimates[0].public_token=E;
  assert.equal((await f.call({action:'accept',token:E,via:'staff_external_contract',accepted_by:U})).status,400);assert.equal(f.writes.length,0);
  const r=await f.call({action:'accept',token:E,name:'Actual Customer'});assert.equal(r.status,200);assert.equal(f.tables.estimates[0].signature.via,'public_estimate_page');assert.equal(f.tables.estimates[0].signed_name,'Actual Customer');
});
test('accepted page describes the contract without signature claims or private staff evidence',async()=>{
  const f=fixture();await f.call();const est=f.tables.estimates[0];est.line_items=f.tables.estimate_line_items;
  const page=f.api._internals.estimatePage(est,{}).body;
  assert.match(page,/Accepted under your contract/);assert.doesNotMatch(page,/Accepted and signed|<h3 class="sec">Signed|PO 42|staff@example|Fixture Staff/);
});

test('staff acceptance settles margin from the included priced lines when costs are available',async()=>{
 const f=fixture();Object.assign(f.tables.estimate_line_items[0],{unit_cost:2000,qty:1});Object.assign(f.tables.estimate_line_items[1],{unit_cost:500,qty:1});
 assert.equal((await f.call()).status,200);assert.equal(f.tables.estimates[0].gp_dollars,3500);assert.equal(f.tables.estimates[0].gp_pct,3500/6000);
});
test('payment-copy interruption stays recoverable and never reports a completed setup',async()=>{
 const f=fixture({failOnce:'pec_invoice_installments'});assert.equal((await f.call()).status,500);assert.equal(f.tables.estimates[0].job_id,undefined);
 assert.equal((await f.call()).status,200);assert.equal(f.tables.jobs.length,1);assert.equal(f.tables.pec_prod_jobs.length,1);assert.equal(f.tables.pec_invoice_installments.length,2);
});
