'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const names = ['recordJobCompletion', 'openJobCompletionModal', 'markJobComplete', 'openStatusChangeModal', 'openPipelineMoveModal', 'completeActiveJob', 'openNewJobForm'];
const source = names.map(name => {
  const match = html.match(new RegExp('^( *)(?:async )?function ' + name + '\\(' ,'m'));
  return html.slice(match.index).match(new RegExp('^[^]*?\\n' + match[1] + '\\}'))[0];
}).join('\n');
function fixture({fail = false, already = false, activeJob = {id:'prod',crm_job_id:'crm',customer_name:'Synthetic job'}}={}) {
 const calls={rpc:[],raw:[],review:[],closed:0,refresh:0,modal:[],toasts:[]},elements=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',style:{},handlers:{},addEventListener(type,fn){this.handlers[type]=fn;},focus(){},querySelectorAll(){return [];}});return elements.get(id);};
 const context=vm.createContext({console,Date,crypto:require('node:crypto'),window:{},mstTodayIso:()=> '2026-09-23',state:{activeJob},$:element,
   esc:value=>String(value||''),supabase:{async rpc(name,args){calls.rpc.push({name,args});if(fail){fail=false;return {error:new Error('transaction rolled back')};}return {data:{job_id:args.p_job_id,prod_job_id:args.p_prod_job_id,completed_date:args.p_completed_date,already}};},from(table){calls.raw.push(table);throw new Error('Unexpected raw write');}},
   openModal(body,options){const wrap={body,options};calls.modal.push(wrap);const date=body.match(/id="jobCompletionDate"[^>]*value="([^"]*)"/);if(date)element('#jobCompletionDate').value=date[1];options.onMount({querySelector:element});return wrap;},
   pecCloseModalWrap(){calls.closed++;},openReviewAskModal:async id=>calls.review.push(id),showToast:text=>calls.toasts.push(text),renderInvoicing(){calls.refresh++;},closeJobDetail(){calls.closed++;},loadJobs:async()=>{calls.refresh++;},render(){calls.refresh++;},
 });
 vm.runInContext(source,context);context.window.pecOpenJobCompletionModal=context.openJobCompletionModal;
 return {context,calls,element};
}
test('CRM completion performs one transaction and only then refreshes and offers review',async()=>{
 const f=fixture();await f.context.markJobComplete({id:'crm',customer_name:'Synthetic'});
 assert.equal(f.calls.rpc.length,0);assert.equal(f.element('#jobCompletionDate').value,'2026-09-23');
 await f.element('#jobCompletionSave').handlers.click();
 assert.equal(f.calls.rpc.length,1);assert.equal(f.calls.rpc[0].name,'pec_complete_job');assert.equal(f.calls.rpc[0].args.p_prod_job_id,null);assert.equal(f.calls.rpc[0].args.p_occurred_at,null);assert.equal(f.calls.raw.length,0);assert.equal(f.calls.refresh,1);assert.deepEqual(f.calls.review,['crm']);
});
test('failed completion preserves the form and its retry key without partial writes or review',async()=>{
 const f=fixture({fail:true});f.context.openJobCompletionModal({jobId:'crm'});
 await f.element('#jobCompletionSave').handlers.click();assert.match(f.element('#jobCompletionError').textContent,/transaction rolled back/);assert.equal(f.calls.closed,0);assert.equal(f.calls.review.length,0);assert.equal(f.calls.raw.length,0);assert.equal(f.element('#jobCompletionSave').disabled,false);
 await f.element('#jobCompletionSave').handlers.click();assert.equal(f.calls.rpc[0].args.p_request_key,f.calls.rpc[1].args.p_request_key);assert.equal(f.calls.review.length,1);
});
test('duplicate completion result does not repeat the review ask',async()=>{
 const f=fixture({already:true});f.context.openJobCompletionModal({jobId:'crm'});await f.element('#jobCompletionSave').handlers.click();assert.equal(f.calls.review.length,0);assert.match(f.calls.toasts[0],/already recorded/);
});
test('historical date requires evidence and amendments use the audited RPC without customer follow-up',async()=>{
 const f=fixture();f.context.openJobCompletionModal({jobId:'crm',amend:true});f.element('#jobCompletionDate').value='2026-08-12';
 await f.element('#jobCompletionSave').handlers.click();assert.equal(f.calls.rpc.length,0);assert.match(f.element('#jobCompletionError').textContent,/confirmation/);
 f.element('#jobCompletionEvidence').value='Verified original schedule end date';await f.element('#jobCompletionSave').handlers.click();assert.equal(f.calls.rpc[0].name,'pec_amend_job_completion');assert.equal(f.calls.rpc[0].args.p_completed_date,'2026-08-12');assert.equal(f.calls.review.length,0);assert.equal(f.calls.raw.length,0);
});
test('invalid and future completion dates are rejected before any transaction',async()=>{
 const f=fixture();for(const date of ['2026-02-31','2026-09-24',''])await assert.rejects(()=>f.context.recordJobCompletion({jobId:'crm',date,requestKey:'test-request',evidence:'test'}),/valid completion date/);assert.equal(f.calls.rpc.length,0);
});
test('production completion uses explicit native CRM link and the production modal root',async()=>{
 const f=fixture();await f.context.completeActiveJob();assert.equal(f.calls.modal[0].options.root,f.element('prodModalRoot'));
 await f.element('#jobCompletionSave').handlers.click();assert.equal(f.calls.rpc[0].args.p_job_id,'crm');assert.equal(f.calls.rpc[0].args.p_prod_job_id,'prod');assert.equal(f.calls.raw.length,0);assert.equal(f.calls.refresh,2);assert.deepEqual(f.calls.review,['crm']);
 const missing=fixture({activeJob:{id:'prod',dripjobs_deal_id:'external'}});await missing.context.completeActiveJob();assert.equal(missing.calls.modal.length,0);assert.equal(missing.calls.rpc.length,0);assert.match(missing.element('prodDetailError').textContent,/Link this production job/);
});
test('status picker and completion drag enter the shared transaction form, never raw status writes',async()=>{
 for(const route of ['status','pipeline']){const f=fixture();if(route==='status')f.context.openStatusChangeModal('crm','scheduled','completed');else f.context.openPipelineMoveModal({id:'crm',status:'scheduled'},{status:'completed',colors:null,title:'Project Complete'});await f.element('#jobCompletionSave').handlers.click();assert.equal(f.calls.rpc[0].name,'pec_complete_job');assert.equal(f.calls.raw.length,0);}
});
test('cancelling completion leaves both job records and review requests untouched',()=>{
 const f=fixture();f.context.openJobCompletionModal({jobId:'crm'});f.element('#jobCompletionCancel').handlers.click();assert.equal(f.calls.closed,1);assert.equal(f.calls.rpc.length,0);assert.equal(f.calls.review.length,0);
});
test('manual booked-job form requires an actual accepted date before inserting',async()=>{
 const f=fixture();f.context.supabase.from=table=>({select(){return this;},is(){return this;},order(){return Promise.resolve({data:[]});}});
 f.context.FormData=class { [Symbol.iterator](){return [['customer_id','customer'],['signed_date','2026-02-31'],['price','100']][Symbol.iterator]();} };
 await f.context.openNewJobForm();assert.match(f.calls.modal[0].body,/name="signed_date" type="date" required/);
 await f.element('#pecJobForm').handlers.submit({preventDefault(){},target:{}});assert.match(f.element('#pecJobFormError').textContent,/original Date accepted/);assert.equal(f.calls.rpc.length,0);
});
