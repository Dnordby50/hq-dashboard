const {test}=require('node:test');
const assert=require('node:assert/strict');
const {planInquiry,businessDate,completionPlan,weekOf}=require('./policy.cjs');
const existing=[{id:'old',customer_id:'customer',brand:'PEC',request_key:'form:old',stage:'accepted'}];
test('a returning customer with a distinct new request creates another lead',()=>{
 assert.equal(planInquiry({customerId:'customer',mode:'new',requestKey:'form:new',existing}).action,'create');
 assert.equal(planInquiry({customerId:'customer',mode:'new',requestKey:'form:old',existing}).leadId,'old');
});
test('two open requests stay separate; an ambiguous appointment cannot choose the oldest',()=>{
 const rows=[{...existing[0],id:'one',stage:'new'},{...existing[0],id:'two',stage:'estimate_sent'}];
 assert.equal(planInquiry({customerId:'customer',mode:'followup',existing:rows}).action,'review');
 assert.equal(planInquiry({customerId:'customer',mode:'followup',leadId:'two',existing:rows}).leadId,'two');
 assert.equal(planInquiry({customerId:'customer',mode:'new',requestKey:'form:new',existing:rows}).action,'create');
});
test('reschedules and follow-ups retain their original request even after acceptance',()=>{
 assert.equal(planInquiry({customerId:'customer',mode:'followup',leadId:'old',existing}).action,'link');
 assert.equal(planInquiry({customerId:'customer',mode:'followup',existing}).action,'review');
});
test('retries require identity and cannot cross customers or brands',()=>{
 assert.equal(planInquiry({customerId:'other',mode:'new',requestKey:'form:old',existing}).action,'review');
 assert.equal(planInquiry({customerId:'customer',brand:'FTP',mode:'followup',leadId:'old',existing}).action,'review');
 assert.equal(planInquiry({customerId:'customer',mode:'new',existing}).action,'review');
});
test('late webhook uses the original occurrence, not the receipt week',()=>{
 const event=businessDate({origin:'webhook',occurredAt:'2026-09-20T06:59:59Z',receivedAt:'2026-09-23T16:00:00Z'});
 assert.equal(event.occurredOn,'2026-09-19');assert.deepEqual(weekOf(event.occurredOn),{start:'2026-09-13',end:'2026-09-19'});
 const next=businessDate({origin:'webhook',occurredAt:'2026-09-20T07:00:00Z',receivedAt:'2026-09-23T16:00:00Z'});
 assert.equal(weekOf(next.occurredOn).start,'2026-09-20');
});
test('import and missing webhook date never become today; date-only history stays date-only',()=>{
 for(const origin of ['import','webhook'])assert.equal(businessDate({origin,receivedAt:'2026-09-23T16:00:00Z'}).action,'review');
 const event=businessDate({origin:'import',occurredOn:'2026-05-18',receivedAt:'2026-09-23T16:00:00Z'});
 assert.equal(event.occurredOn,'2026-05-18');assert.equal(event.occurredAt,null);
});
test('invalid, timezone-free, future and contradictory evidence is not silently normalized',()=>{
 for(const extra of [{occurredOn:'2026-02-30'},{occurredOn:'2026-09-24'},{occurredAt:'2026-09-22T23:00:00'},{occurredOn:'2026-09-20',occurredAt:'2026-09-20T06:00:00Z'}])assert.equal(businessDate({origin:'webhook',receivedAt:'2026-09-23T16:00:00Z',...extra}).action,'review');
});
test('manual completion resolves by CRM identity even without a DripJobs ID',()=>{
 const plan=completionPlan({crmJobId:'job',job:{id:'job',status:'in_progress'},productionJob:{id:'production',crm_job_id:'job'},completedOn:'2026-09-22',receivedAt:'2026-09-23T16:00:00Z'});
 assert.deepEqual(plan,{action:'atomic_completion',crmJobId:'job',productionJobId:'production',completedOn:'2026-09-22'});
});
test('completion cannot report success for an unlinked job or overwrite its original date',()=>{
 const base={crmJobId:'job',job:{id:'job',status:'completed',completed_date:'2026-09-20'},productionJob:{id:'production',crm_job_id:'job',status:'completed'},receivedAt:'2026-09-23T16:00:00Z'};
 assert.equal(completionPlan({...base,crmJobId:null}).action,'review');
 assert.equal(completionPlan({...base,completedOn:'2026-09-22'}).action,'review');
 assert.equal(completionPlan(base).action,'no_op');
});
