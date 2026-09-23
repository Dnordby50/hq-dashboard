const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fetchSalesMetrics,salesWeek,canonicalLeads,reconcileInquiries,recoverFirstSends,allRows}=require('./sales-metrics.cjs');
const token='11111111-1111-4111-8111-111111111111';
const estimate={id:'proposal',public_token:token,estimate_number:101,created_at:'2026-09-14T15:00:00Z',sent_at:'2026-09-22T15:00:00Z'};
const email=(id,time,extra={})=>({id,sent_at:time,status:'delivered',resend_id:id,body_html:`<a href="https://example.invalid/e/${token}">Open</a>`,...extra});
const text=(id,time,extra={})=>({id,created_at:time,status:'sent',direction:'out',quo_message_id:id,body:`Quote https://example.invalid/e/${token}`, ...extra});
function sourceDb(sources={},failure){
  return async path=>{
    const url=new URL(`https://fixture.invalid${path}`),name=url.pathname.slice(1);
    if(name===failure)throw new Error('source unavailable');
    const rows=sources[name]||[],offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||1000);
    return rows.slice(offset,offset+limit);
  };
}
const base=()=>({leads:[{id:'lead0',created_at:'2026-08-01T15:00:00Z'},{id:'lead',customer_id:'customer',created_at:'2026-09-14T15:00:00Z'}],customers:[{id:'customer',name:'Synthetic contact',created_at:'2026-09-14T15:00:00Z'}],estimates:[{...estimate},{id:'old',created_at:'2026-08-01T12:00:00Z'}],pec_estimate_first_sends:[{estimate_id:'old',first_sent_at:'2026-08-01T15:00:00Z',channel:'email'}],pec_email_log:[email('first','2026-09-14T15:30:00Z')],pec_sms_log:[],pec_estimate_send_attempts:[]});
const load=(data=base(),failure)=>fetchSalesMetrics({db:sourceDb(data,failure),start:'2026-01-01',until:'2026-09-23T07:00:00Z'});
test('first send is across all history before date filtering; email/text/resends count once',()=>{
  const recovered=recoverFirstSends({estimates:[estimate],firstSends:[],emails:[email('first','2026-09-14T15:30:00Z'),email('resend','2026-09-22T15:00:00Z')],sms:[text('both','2026-09-14T15:31:00Z')]});
  assert.equal(recovered.records.length,1);assert.equal(recovered.records[0].first_sent_at,'2026-09-14T15:30:00Z');
  assert.equal(recovered.unresolved.length,0);assert.ok(!JSON.stringify(recovered).includes(token));
});
test('failed/queued/inbound messages and token substrings cannot become evidence; delivered and bounced sends do',()=>{
  const recovered=recoverFirstSends({estimates:[estimate],firstSends:[],emails:[email('failed','2026-09-14T10:00:00Z',{status:'failed'}),email('queue','2026-09-14T11:00:00Z',{status:'queued'}),email('wrong','2026-09-14T12:00:00Z',{body_html:`/e/${token}-other`}),email('bounced','2026-09-14T15:30:00Z',{status:'bounced'})],sms:[text('in','2026-09-14T09:00:00Z',{direction:'in'})]});
  assert.equal(recovered.records[0].first_sent_at,'2026-09-14T15:30:00Z');
});
test('actual SMS punctuation before STOP line still matches the exact proposal',()=>{
  const result=recoverFirstSends({estimates:[estimate],firstSends:[],emails:[],sms:[text('sms','2026-09-14T15:30:00Z',{body:`Your estimate EST-101 is ready: https://example.invalid/e/${token}. Reply STOP to opt out.`})]});
  assert.equal(result.records.length,1);assert.equal(result.records[0].channel,'sms');
});
test('first-send ledger survives current status, deletion, missing current proposal, and later receipts',()=>{
  const recovered=recoverFirstSends({estimates:[{...estimate,status:'accepted',deleted_at:'2026-09-21T15:00:00Z'}],firstSends:[{estimate_id:estimate.id,first_sent_at:'2026-09-14T15:00:00Z',channel:'sms'},{estimate_id:'removed',first_sent_at:'2026-09-15T15:00:00Z',channel:'email'}],emails:[email('later','2026-09-22T15:00:00Z')],sms:[]});
  assert.equal(recovered.records.length,2);assert.equal(recovered.records[0].first_sent_at,'2026-09-14T15:00:00Z');
});
test('separate inquiries from the same customer count independently regardless of later stage',()=>{
  const rows=canonicalLeads([{id:'a',customer_id:'c',created_at:'2026-09-01T15:00:00Z',stage:'accepted'},{id:'b',customer_id:'c',created_at:'2026-09-15T15:00:00Z'},{id:'deleted',created_at:'2026-09-15T15:00:00Z',deleted_at:'2026-09-16T15:00:00Z'}]);
  assert.deepEqual(rows.map(r=>r.id),['a','b']);
});
test('unmapped new contact blocks a falsely low lead count, while estimates still report',async()=>{
  const data=base();data.customers.push({id:'missing',created_at:'2026-09-16T15:00:00Z'});
  const source=await load(data),week=salesWeek(source,'2026-09-14','2026-09-20');
  assert.equal(week.available.leads,false);assert.equal(week.missingLeads.length,1);assert.equal(week.available.estimates,true);assert.equal(week.estimates.length,1);
});
test('Phoenix boundary assigns Saturday night and Sunday morning to separate weeks',async()=>{
  const data=base();data.pec_email_log=[email('late','2026-09-20T06:59:59Z')];
  let source=await load(data);assert.equal(salesWeek(source,'2026-09-13','2026-09-19').estimates.length,1);
  data.pec_email_log=[email('next','2026-09-20T07:00:00Z')];source=await load(data);
  assert.equal(salesWeek(source,'2026-09-13','2026-09-19').estimates.length,0);assert.equal(salesWeek(source,'2026-09-20','2026-09-26').estimates.length,1);
});
test('uncertain first delivery blocks counts, but pending resend after known first delivery does not',async()=>{
  const data=base();data.pec_estimate_send_attempts=[{id:'attempt',estimate_id:estimate.id,started_at:'2026-09-22T15:00:00Z',status:'pending'}];
  let source=await load(data);assert.equal(salesWeek(source,'2026-09-14','2026-09-20').available.estimates,true);
  data.pec_estimate_send_attempts[0].started_at='2026-09-10T15:00:00Z';source=await load(data);
  assert.equal(salesWeek(source,'2026-09-07','2026-09-13').available.estimates,false);
  assert.equal(salesWeek(source,'2026-09-14','2026-09-20').available.estimates,false);
  assert.equal(salesWeek(source,'2026-09-21','2026-09-27').available.estimates,true);
});
test('missing source/migration yields unavailable, never a fabricated zero',async()=>{
  for(const table of ['estimates','pec_estimate_first_sends','pec_email_log','pec_sms_log','pec_estimate_send_attempts']){
    const source=await load(base(),table),week=salesWeek(source,'2026-09-14','2026-09-20');assert.equal(week.available.estimates,false,table);assert.equal(week.available.leads,true);
  }
});
test('unknown historical sent timestamp blocks only weeks it could have first been sent',async()=>{
  const data=base();data.estimates.push({id:'unverified',created_at:'2026-08-01T15:00:00Z',sent_at:'2026-08-20T15:00:00Z'});
  const source=await load(data);assert.equal(salesWeek(source,'2026-08-17','2026-08-23').available.estimates,false);assert.equal(salesWeek(source,'2026-09-14','2026-09-20').available.estimates,true);
});
test('historical earliest available receipt across weeks is not falsely certified as the first send',async()=>{
  const data=base();data.estimates[0].created_at='2026-09-01T15:00:00Z';
  let source=await load(data);
  assert.equal(salesWeek(source,'2026-08-31','2026-09-06').available.estimates,false);
  assert.equal(salesWeek(source,'2026-09-14','2026-09-20').available.estimates,false);
  assert.equal(salesWeek(source,'2026-09-21','2026-09-27').available.estimates,true);
  // Recording a legacy resend in the new ledger does not certify the old history.
  data.pec_estimate_first_sends.push({estimate_id:estimate.id,first_sent_at:'2026-09-14T15:30:00Z',channel:'email'});
  data.pec_estimate_send_attempts.push({id:'cutover',estimate_id:estimate.id,started_at:'2026-09-14T15:00:00Z',status:'sent'});
  source=await load(data);assert.equal(salesWeek(source,'2026-09-14','2026-09-20').available.estimates,false);
});
test('new proposal created after durable tracking began can first send in a later week',async()=>{
  const data=base();data.estimates[0].created_at='2026-09-01T15:00:00Z';
  data.pec_estimate_first_sends.push({estimate_id:estimate.id,first_sent_at:'2026-09-14T15:30:00Z',channel:'email'});
  data.pec_estimate_send_attempts.push({id:'cutover',estimate_id:'old',started_at:'2026-08-31T15:00:00Z',status:'failed'});
  const source=await load(data);assert.equal(salesWeek(source,'2026-09-14','2026-09-20').available.estimates,true);
});
test('pagination reads all records and rejects truncation',async()=>{
  const rows=Array.from({length:1001},(_,id)=>({id}));assert.equal((await allRows(sourceDb({rows}),'/rows?select=id')).length,1001);
  await assert.rejects(()=>allRows(async()=>Array(1000).fill({}),'/rows?select=id'),/limit reached/);
});
test('source adapter reads actual communication company keys and does not filter current proposal stage',async()=>{
  const paths=[];const db=sourceDb(base());
  await fetchSalesMetrics({db:async path=>{paths.push(path);return db(path);},start:'2026-01-01',until:'2026-09-23T07:00:00Z'});
  for(const source of ['pec_email_log','pec_sms_log'])assert.match(paths.find(p=>p.startsWith(`/${source}?`)),/brand=in\.\(PEC,prescott-epoxy\)/);
  const estimates=paths.find(p=>p.startsWith('/estimates?'));assert.doesNotMatch(estimates,/status=|deleted_at=/);
});
test('owner-confirmed legacy dates count once without inventing timestamps or channels',async()=>{
 const data=base();data.estimates[0].created_at='2026-08-01T15:00:00Z';
 data.pec_estimate_first_send_confirmations=[{estimate_id:estimate.id,first_sent_on:'2026-08-08'}];
 const source=await load(data),row=source.firstSends.find(r=>r.estimate_id===estimate.id);
 assert.equal(row.first_sent_at,null);assert.equal(row.channel,null);assert.equal(row.evidence,'owner_confirmation');
 assert.equal(source.unresolved.length,0);
 assert.equal(salesWeek(source,'2026-08-02','2026-08-08').estimates.length,1);
 assert.equal(salesWeek(source,'2026-08-09','2026-08-15').estimates.length,0);
 assert.equal(salesWeek(source,'2026-09-13','2026-09-19').estimates.length,0);
});
test('confirmation clears missing receipt and deleted proposal history; future resends cannot move it',async()=>{
 const data=base();data.pec_email_log=[];data.estimates[0].created_at='2026-08-01T15:00:00Z';data.estimates[0].deleted_at='2026-09-22T15:00:00Z';
 data.pec_estimate_first_send_confirmations=[{estimate_id:estimate.id,first_sent_on:'2026-08-10'}];
 data.pec_estimate_send_attempts=[{id:'resend',estimate_id:estimate.id,started_at:'2026-09-14T15:00:00Z',status:'pending'}];
 const source=await load(data);assert.equal(source.unresolved.length,0);
 assert.equal(salesWeek(source,'2026-08-09','2026-08-15').available.estimates,true);
 assert.equal(salesWeek(source,'2026-08-09','2026-08-15').estimates.length,1);
 assert.equal(salesWeek(source,'2026-09-13','2026-09-19').pending.length,0);
});
test('confirmation conflicting with earlier delivery or proposal creation remains unresolved',async()=>{
 for(const day of ['2026-09-15','2026-09-01']){
  const data=base();data.pec_estimate_first_send_confirmations=[{estimate_id:estimate.id,first_sent_on:day}];
  const source=await load(data);assert.ok(source.unresolved.length);assert.equal(salesWeek(source,'2026-09-13','2026-09-19').available.estimates,false);
 }
 const source=await load(base(),'pec_estimate_first_send_confirmations');assert.equal(source.estimatesAvailable,false);
});

test('reviewed duplicate chains count canonical inquiry once without changing its date',()=>{
 const rows=[{id:'a',customer_id:'c',inquiry_date:'2026-08-20',inquiry_origin:'staff',created_at:'2026-09-01T15:00:00Z'}, {id:'b',customer_id:'c',duplicate_of:'a'}, {id:'c',customer_id:'c',duplicate_of:'b'}];
 const result=reconcileInquiries(rows);assert.equal(result.issues.length,0);assert.equal(result.leads.length,1);assert.equal(result.leads[0].inquiry_day,'2026-08-20');
});
test('broken, cyclic, deleted, and cross-customer duplicate links require review',()=>{
 for(const rows of [
  [{id:'a',duplicate_of:'missing'}],
  [{id:'a',duplicate_of:'b'},{id:'b',duplicate_of:'a'}],
  [{id:'a',duplicate_of:'b'},{id:'b',deleted_at:'2026-09-20'}],
  [{id:'a',customer_id:'one',duplicate_of:'b'},{id:'b',customer_id:'two',inquiry_date:'2026-09-20'}],
  [{id:'a',brand:'PEC',duplicate_of:'b'},{id:'b',brand:'FTP',inquiry_date:'2026-09-20'}],
 ]) assert.ok(reconcileInquiries(rows).issues.length);
});
test('new and imported inquiry dates never silently fall back to import day',async()=>{
 const data=base();data.leads.push({id:'import',inquiry_origin:'import',created_at:'2026-09-22T15:00:00Z'});
 let source=await load(data);assert.equal(salesWeek(source,'2026-09-13','2026-09-19').available.leads,false);assert.equal(source.inquiryIssues.length,1);
 data.leads.at(-1).inquiry_date='2026-08-22';source=await load(data);
 assert.equal(source.inquiryIssues.length,0);assert.equal(salesWeek(source,'2026-08-16','2026-08-22').leads.length,1);
 assert.equal(salesWeek(source,'2026-09-20','2026-09-26').leads.length,0);
 data.leads.at(-1).inquiry_date='2026-02-31';assert.equal((await load(data)).inquiryIssues.length,1);
});
test('only explicit exclusions suppress sales records, and excluded canonical chains stay excluded',async()=>{
 const data=base();data.leads.push({id:'test-name',full_name:'Test Example',created_at:'2026-09-14T15:00:00Z'},{id:'excluded',customer_id:'e',inquiry_date:'2026-09-14',reporting_excluded_at:'2026-09-15',reporting_excluded_reason:'Reviewed administrative contact'},{id:'duplicate',customer_id:'e',duplicate_of:'excluded'});
 data.customers.push({id:'admin',created_at:'2026-09-14T15:00:00Z',reporting_excluded_at:'2026-09-15',reporting_excluded_reason:'Reviewed administrative contact'});
 const source=await load(data),week=salesWeek(source,'2026-09-13','2026-09-19');assert.equal(week.leads.length,2);assert.equal(week.missingLeads.length,0);assert.equal(week.available.leads,true);
});
test('undated contact exceptions remain visible after their import week',async()=>{
 const data=base();data.customers.push({id:'unknown',created_at:'2026-08-02T15:00:00Z'});
 const source=await load(data);assert.equal(salesWeek(source,'2026-09-13','2026-09-19').available.leads,false);
});

test('a contact imported after an earlier reporting period cannot certify that earlier period',async()=>{
 const data=base();data.customers.push({id:'late-import',created_at:'2026-09-22T15:00:00Z'});
 const source=await load(data);assert.equal(salesWeek(source,'2026-08-02','2026-08-08').available.leads,false);
});
