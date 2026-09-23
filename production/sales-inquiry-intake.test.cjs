'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const {originalInquiryDate,stageInquiryReview}=require('../netlify/functions/_pec-sales-inquiry.cjs');
function fixture(){
 const rows={leads:[],reviews:[]},requests=new Map(),calls=[];
 const db=async(method,path,body)=>{
  calls.push({method,path,body});
  if(method==='GET'&&path.startsWith('/leads?source=')){const q=new URLSearchParams(path.split('?')[1]);return rows.leads.filter(r=>r.source===q.get('source').slice(3)&&r.source_ref===q.get('source_ref').slice(3));}
  if(path==='/rpc/resolve_sales_customer') return 'customer-one';
  if(path==='/rpc/record_sales_inquiry'){
   if(requests.has(body.p_request_key))return requests.get(body.p_request_key);
   const id='lead-'+(rows.leads.length+1);requests.set(body.p_request_key,id);rows.leads.push({...body.p_details,id,customer_id:body.p_customer_id,inquiry_date:body.p_inquiry_date,stage:'new'});return id;
  }
  if(method==='PATCH'&&path.startsWith('/leads?id=')){const row=rows.leads.find(r=>r.id===path.split('eq.')[1]);Object.assign(row,body);return [row];}
  if(path==='/pec_sales_integrity_exceptions'){rows.reviews.push(body);return [];}
  if(path==='/lead_events'||path.startsWith('/pec_sales_integrity_exceptions?'))return [];
  throw new Error('Unexpected test DB call '+method+' '+path);
 };
 const stubs={
  './_pec-supabase.cjs':{sb:db,json:(statusCode,body)=>({statusCode,body}),badSecret:()=>false,logIngest:async()=>{}},
  './_pec-drip.cjs':{enrollLead:async()=>({enrolled:false}),sendInstantTouch:async()=>({sent:[]})},
  './_pec-lead-match.cjs':{normPhone:require('../netlify/functions/_pec-lead-match.cjs').normPhone,resolveOrCreateCustomer:require('../netlify/functions/_pec-lead-match.cjs').resolveOrCreateCustomer},
  './_pec-sales-inquiry.cjs':require('../netlify/functions/_pec-sales-inquiry.cjs'),
  './_pec-lead-source.cjs':{resolveLeadSourceName:async(_,source)=>source},
  './_pec-lead-notify.cjs':{notifyLeadSlack:async()=>{},notifyLeadBell:async()=>{}},
 };
 const context={exports:{},require:name=>{if(!(name in stubs))throw Error(name);return stubs[name];},console,process:{env:{}},fetch:async()=>({ok:true}),setTimeout:()=>{},Date};
 vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../netlify/functions/pec-lead-intake.cjs'),'utf8'),context);
 const invoke=body=>context.exports.handler({httpMethod:'POST',body:JSON.stringify(body)});
 return {rows,calls,invoke};
}
const lead={source:'Google',source_ref:'request-1',full_name:'Synthetic Person',email:'person@example.invalid',phone:'9285550101',submitted_at:'2026-09-20T06:59:59Z'};
test('separate submissions by one person become separate inquiries; exact source retry preserves original',async()=>{
 const f=fixture();assert.equal((await f.invoke(lead)).statusCode,200);
 f.rows.leads[0].stage='accepted';assert.equal((await f.invoke(lead)).body.deduped,true);
 assert.equal((await f.invoke({...lead,source_ref:'request-2',submitted_at:'2026-09-20T07:00:00Z'})).statusCode,200);
 assert.equal(f.rows.leads.length,2);assert.equal(f.rows.leads[0].stage,'accepted');
 assert.equal(f.rows.leads[0].customer_id,f.rows.leads[1].customer_id);
 assert.equal(f.rows.leads[0].inquiry_date,'2026-09-19');assert.equal(f.rows.leads[1].inquiry_date,'2026-09-20');
});
test('undated or unidentified external inquiry is retained for review before lead or communications',async()=>{
 for(const body of [{...lead,submitted_at:null},{...lead,source_ref:null}]){
  const f=fixture();const result=await f.invoke(body);assert.equal(result.statusCode,202);assert.equal(result.body.review_required,true);assert.equal(f.rows.reviews.length,1);assert.equal(f.rows.leads.length,0);
 }
});
test('invalid calendar dates and timezone-free source timestamps cannot silently become today',()=>{
 for(const value of ['2026-02-30','2026-02-30T12:00:00Z','2026-09-19T12:00:00','infinity','2999-01-01'])assert.equal(originalInquiryDate(value),null);
 assert.equal(originalInquiryDate('2026-08-12'),'2026-08-12');
});
test('exception retry preserves original evidence and storage failures are surfaced',async()=>{
 let original;
 await stageInquiryReview(async(_m,_p,row)=>{original=row;},{key:'one',endpoint:'test',reason:'missing',payload:{field:'original'}});
 await stageInquiryReview(async()=>{throw Error('23505 duplicate key');},{key:'one',endpoint:'test',reason:'missing',payload:{field:'other'}});
 assert.deepEqual(original.payload,{field:'original'});
 await assert.rejects(()=>stageInquiryReview(async()=>{throw Error('storage unavailable');},{key:'one',endpoint:'test',reason:'missing',payload:{}}),/storage unavailable/);
});
