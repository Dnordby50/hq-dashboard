'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
const helper=require('../netlify/functions/_pec-job-events.cjs');
const now=new Date('2026-09-23T18:00:00Z');
test('late original acceptance preserves Saturday Arizona instead of receipt Sunday',()=>{
 const e=helper.sourceEvent({deal_id:'1',accepted_at:'2026-09-20T06:59:59Z'},'booked',now);
 assert.equal(e.businessDate,'2026-09-19');assert.equal(e.occurredAt,'2026-09-20T06:59:59Z');
 assert.equal(helper.sourceEvent({deal_id:'1',accepted_at:'2026-09-20T07:00:00Z'},'booked',now).businessDate,'2026-09-20');
});
test('date-only evidence remains date-only; delivery timestamps never substituted',()=>{
 assert.deepEqual(helper.sourceEvent({deal_id:'1',completed_date:'2026-09-19'},'completed',now),{ok:true,eventKey:'completed:1',businessDate:'2026-09-19',occurredAt:null});
 assert.equal(helper.sourceEvent({deal_id:'1',received_at:'2026-09-23T01:00:00Z'},'completed',now).ok,false);
});
test('missing identities, invalid dates, missing zones, contradictions and future dates require review',()=>{
 for(const body of [{completed_date:'2026-09-01'},{deal_id:'1',completed_date:'2026-13-01'},{deal_id:'1',completed_date:'2026-02-30'},{deal_id:'1',completed_at:'2026-09-20T10:00:00'},{deal_id:'1',completed_date:'2026-09-01',completed_at:'2026-09-20T10:00:00Z'},{deal_id:'1',completed_date:'2026-09-24'}]) assert.equal(helper.sourceEvent(body,'completed',now).ok,false);
});
function loadHandler(name,sb){
 const exports={};const base=path.resolve('netlify/functions');
 const context={exports,console,require(id){
  if(id==='./_pec-supabase.cjs')return {sb,badSecret:()=>false,json:(statusCode,body)=>({statusCode,body:JSON.stringify(body)}),logIngest:async()=>{}};
  if(id==='./_pec-installments.cjs')return {prepareDepositInstallment:async()=>{}};
  return require(path.resolve(base,id));
 }};
 vm.runInNewContext(fs.readFileSync(path.join(base,name),'utf8'),context);return exports.handler;
}
test('undated acceptance is saved for review before any customer/job mutation',async()=>{
 const calls=[]; const h=loadHandler('pec-webhook-proposal-accepted.cjs',async(method,url,body)=>{calls.push({method,url,body});return [];});
 const out=await h({httpMethod:'POST',body:JSON.stringify({deal_id:'1',customer_name:'Test'})});
 assert.equal(out.statusCode,202);assert.ok(JSON.parse(out.body).review_required);
 assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(calls[1].url,'/pec_sales_integrity_exceptions');
});
test('dated acceptance uses single atomic RPC and preserves original date',async()=>{
 const calls=[];const h=loadHandler('pec-webhook-proposal-accepted.cjs',async(method,url,body)=>{calls.push({method,url,body});return url==='/rpc/pec_accept_external_job'?{job_id:'job',prod_job_id:'prod',customer_token:'token',created:true}:[];});
 const out=await h({httpMethod:'POST',body:JSON.stringify({deal_id:'1',customer_name:'Test',accepted_date:'2026-01-02'})});
 assert.equal(out.statusCode,200);const rpc=calls.find(c=>c.url==='/rpc/pec_accept_external_job');assert.equal(rpc.body.p_payload.signed_date,'2026-01-02');assert.equal(rpc.body.p_payload.occurred_at,null);
 assert.equal(calls.filter(c=>c.method==='POST').length,1);
});
test('completion refuses ambiguous proposal match rather than taking first row',async()=>{
 const calls=[];const h=loadHandler('pec-webhook-project-completed.cjs',async(method,url,body)=>{calls.push({method,url,body});return url.startsWith('/jobs?')?[{id:'one'},{id:'two'}]:[];});
 const out=await h({httpMethod:'POST',body:JSON.stringify({deal_id:'1',completed_date:'2026-01-02'})});
 assert.equal(out.statusCode,202);assert.ok(calls.some(c=>c.url==='/pec_sales_integrity_exceptions'));assert.ok(!calls.some(c=>c.url==='/rpc/pec_complete_job'));
});
test('completion invokes transaction with source occurrence; no direct table patches',async()=>{
 const calls=[];const h=loadHandler('pec-webhook-project-completed.cjs',async(method,url,body)=>{calls.push({method,url,body});return url.startsWith('/jobs?')?[{id:'one'}]:url==='/rpc/pec_complete_job'?{job_id:'one'}:[];});
 const out=await h({httpMethod:'POST',body:JSON.stringify({deal_id:'1',completed_date:'2026-01-02'})});
 assert.equal(out.statusCode,200);const rpc=calls.find(c=>c.url==='/rpc/pec_complete_job');assert.equal(rpc.body.p_completed_date,'2026-01-02');assert.equal(rpc.body.p_occurred_at,null);
 assert.ok(!calls.some(c=>c.method==='PATCH' && /^\/(jobs|pec_prod_jobs|timeline_stages)/.test(c.url)));
});
test('native acceptance recovery uses actual stored signature date',()=>{
 const source=fs.readFileSync('netlify/functions/pec-public-estimate.cjs','utf8');assert.match(source,/signed_date: require\('\.\/_pec-job-events\.cjs'\)\.dateOfInstant\(est\.signed_at \|\| est\.accepted_at\)/);
});
