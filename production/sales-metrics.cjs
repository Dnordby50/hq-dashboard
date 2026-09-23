// Owner-only reporting. No tokens, message bodies, or recipient details leave this adapter.
const DAY=86400000;
const phoenixDay=value=>new Date(Date.parse(value)-7*3600000).toISOString().slice(0,10);
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&validTime(value)&&new Date(value).toISOString().slice(0,10)===value;
const sendDay=row=>row.first_sent_on||(validTime(row.first_sent_at)?phoenixDay(row.first_sent_at):null);
async function allRows(db,path,order='id'){
  const result=[];
  for(let offset=0;offset<10000;offset+=1000){
    const rows=await db(`${path}&order=${order}&limit=1000&offset=${offset}`);
    if(!Array.isArray(rows))throw new Error('Invalid sales source response.');
    result.push(...rows);if(rows.length<1000)return result;
  }
  throw new Error('Sales source limit reached; no partial counts were returned.');
}
function firstFullSunday(value){
  if(!validTime(value))return null;
  const date=phoenixDay(value),stamp=Date.parse(`${date}T00:00:00Z`);
  return new Date(stamp+(7-new Date(stamp).getUTCDay())%7*DAY).toISOString().slice(0,10);
}
function inquiryDay(row){
  if(validDay(row.inquiry_date))return row.inquiry_date;
  // Preserve pre-migration behavior only. New/imported records need their original date.
  return !row.inquiry_date&&!row.inquiry_origin&&!row.intake_request_key&&validTime(row.created_at)?phoenixDay(row.created_at):null;
}
function reconcileInquiries(rows){
  const byId=new Map(rows.filter(row=>row.id).map(row=>[row.id,row])),canonical=new Map(),issues=[];
  for(const row of byId.values()){
    if(row.deleted_at||row.reporting_excluded_at)continue;
    let current=row,problem=null;const seen=new Set();
    while(current.duplicate_of){
      if(seen.has(current.id)){problem='Duplicate inquiry links contain a cycle.';break;}
      seen.add(current.id);
      const next=byId.get(current.duplicate_of);
      if(!next||next.deleted_at){problem='The canonical inquiry is missing or deleted.';break;}
      if((next.brand||'PEC')!==(row.brand||'PEC')||next.customer_id!==row.customer_id){problem='The duplicate link points to a different customer or company.';break;}
      current=next;
    }
    if(problem){issues.push({id:row.id,customer_id:row.customer_id,name:row.full_name,reason:problem,from:'0000-01-01',through:'9999-12-31'});continue;}
    if(current.reporting_excluded_at)continue;
    const date=inquiryDay(current);
    if(!date){if(!issues.some(issue=>issue.id===current.id))issues.push({id:current.id,customer_id:current.customer_id,name:current.full_name,reason:'Original inquiry date is missing.',from:'0000-01-01',through:'9999-12-31'});continue;}
    canonical.set(current.id,{...current,inquiry_day:date,date_evidence:validDay(current.inquiry_date)?(current.inquiry_origin||'recorded_inquiry'):'legacy_record_created'});
  }
  return {leads:[...canonical.values()],issues};
}
function canonicalLeads(rows){return reconcileInquiries(rows).leads;}
// Match only the exact proposal URL token. Subject lines and customer names are editable.
function messageEstimateIds(body,byToken){
  const ids=new Set();
  for(const match of String(body||'').matchAll(/\/e\/([a-z0-9-]+)(?=$|[?&#\s"'<>.,)!])/gi)){
    const id=byToken.get(match[1]);if(id)ids.add(id);
  }
  return ids;
}
function recoverFirstSends({estimates,firstSends,emails,sms,confirmations=[],trackingStartedAt=null}){
  const byId=new Map(estimates.map(row=>[row.id,row]));
  const byToken=new Map(estimates.filter(row=>row.public_token).map(row=>[row.public_token,row.id]));
  const records=new Map();
  const add=(id,time,channel,evidence)=>{
    if(!validTime(time))return;
    const prior=records.get(id);
    if(!prior||Date.parse(time)<Date.parse(prior.first_sent_at))records.set(id,{estimate_id:id,estimate_number:byId.get(id)?.estimate_number??null,first_sent_at:time,channel,evidence});
  };
  for(const row of firstSends)add(row.estimate_id,row.first_sent_at,row.channel,'first_send_record');
  for(const row of emails)if(row.resend_id&&!['failed','queued'].includes(row.status)){
    for(const id of messageEstimateIds(row.body_html,byToken))add(id,row.sent_at,'email','email_receipt');
  }
  for(const row of sms)if(row.quo_message_id&&row.direction==='out'&&!['failed','queued','received'].includes(row.status)){
    for(const id of messageEstimateIds(row.body,byToken))add(id,row.created_at,'sms','sms_receipt');
  }
  const conflicts=[];
  for(const row of confirmations){
    const estimate=byId.get(row.estimate_id),receipt=records.get(row.estimate_id);
    if(!estimate||!validDay(row.first_sent_on))continue;
    const created=validTime(estimate.created_at)?phoenixDay(estimate.created_at):null;
    const receiptDay=receipt?sendDay(receipt):null;
    // Contradictory earlier delivery evidence must remain visible for reconciliation.
    if((created&&row.first_sent_on<created)||(receiptDay&&receiptDay<row.first_sent_on)){
      conflicts.push({estimate_id:row.estimate_id,estimate_number:estimate.estimate_number,
        from:[created,receiptDay,row.first_sent_on].filter(Boolean).sort()[0],
        through:[created,receiptDay,row.first_sent_on].filter(Boolean).sort().at(-1)});
      continue;
    }
    records.set(row.estimate_id,{estimate_id:row.estimate_id,estimate_number:estimate.estimate_number,
      first_sent_on:row.first_sent_on,first_sent_at:null,channel:null,evidence:'owner_confirmation'});
  }
  // A sent stamp without a receipt can be an on-site presentation or missing history.
  // Never silently substitute the mutable most-recent-send date for the first send.
  const unresolved=conflicts.concat(estimates.filter(row=>row.sent_at&&!records.has(row.id)).map(row=>({
    estimate_id:row.id,estimate_number:row.estimate_number,
    from:validTime(row.created_at)?phoenixDay(row.created_at):'0000-01-01',
    through:validTime(row.sent_at)?phoenixDay(row.sent_at):'9999-12-31',
  })));
  const weekStart=value=>{const date=phoenixDay(value),stamp=Date.parse(`${date}T00:00:00Z`);return new Date(stamp-new Date(stamp).getUTCDay()*DAY).toISOString().slice(0,10);};
  for(const record of records.values()){
    if(record.evidence==='owner_confirmation')continue;
    const estimate=byId.get(record.estimate_id);
    const created=estimate?.created_at;
    const fullyTracked=record.evidence==='first_send_record'&&validTime(created)&&validTime(trackingStartedAt)&&Date.parse(created)>=Date.parse(trackingStartedAt);
    // Historical logs were best-effort. If creation and earliest receipt span
    // weeks, a missing older receipt could move this proposal to another week.
    if(!fullyTracked&&(!validTime(created)||weekStart(created)!==weekStart(record.first_sent_at)))unresolved.push({
      estimate_id:record.estimate_id,estimate_number:record.estimate_number,
      from:validTime(created)?phoenixDay(created):'0000-01-01',through:phoenixDay(record.first_sent_at),
    });
  }
  return {records:[...records.values()],unresolved};
}
async function fetchSalesMetrics({db,start,until}){
  const results=await Promise.allSettled([
    // Read every inquiry so explicit canonical links and backdated imports resolve across years.
    allRows(db,`/leads?select=id,brand,customer_id,full_name,source,created_at,deleted_at,inquiry_date,inquiry_origin,inquiry_evidence,intake_request_key,duplicate_of,reporting_excluded_at,reporting_exclusion_reason&brand=eq.PEC`),
    allRows(db,`/customers?select=id,name,created_at,reporting_excluded_at,reporting_exclusion_reason&company=eq.prescott-epoxy`),
    allRows(db,`/estimates?select=id,estimate_number,public_token,created_at,sent_at&brand=eq.PEC&created_at=lt.${until}`),
    allRows(db,`/pec_estimate_first_sends?select=estimate_id,first_sent_at,channel&brand=eq.PEC&first_sent_at=lt.${until}`,'estimate_id'),
    allRows(db,`/pec_email_log?select=id,sent_at,status,resend_id,body_html&brand=in.(PEC,prescott-epoxy)&template_key=eq.estimate&resend_id=not.is.null&sent_at=lt.${until}`),
    allRows(db,`/pec_sms_log?select=id,created_at,status,direction,quo_message_id,body&brand=in.(PEC,prescott-epoxy)&kind=eq.estimate&direction=eq.out&quo_message_id=not.is.null&created_at=lt.${until}`),
    allRows(db,`/pec_estimate_send_attempts?select=id,estimate_id,started_at,status&brand=eq.PEC&started_at=lt.${until}`),
    allRows(db,`/pec_estimate_first_send_confirmations?select=estimate_id,first_sent_on&brand=eq.PEC`,'estimate_id'),
  ]);
  const ok=index=>results[index].status==='fulfilled';
  const rows=index=>ok(index)?results[index].value:[];
  const reconciled=reconcileInquiries(rows(0)),leads=reconciled.leads.filter(row=>row.inquiry_day<=phoenixDay(new Date(Date.parse(until)-1).toISOString())&&(validDay(row.inquiry_date)||Date.parse(row.created_at)<Date.parse(until))),linked=new Set(rows(0).filter(r=>r.customer_id&&!r.deleted_at).map(r=>r.customer_id));
  const missingLeads=rows(1).filter(row=>!row.reporting_excluded_at&&!linked.has(row.id));
  const estimatesAvailable=[2,3,4,5,6,7].every(ok);
  const trackingStartedAt=rows(6).map(row=>row.started_at).filter(validTime).sort()[0]||null;
  const recovered=recoverFirstSends({estimates:rows(2),firstSends:rows(3),emails:rows(4),sms:rows(5),confirmations:rows(7),trackingStartedAt});
  const pending=rows(6).filter(row=>row.status==='pending');
  const warnings=[];
  if(!ok(0)||!ok(1))warnings.push('PEC lead data could not be refreshed. Existing entries were retained.');
  if(missingLeads.length)warnings.push(`${missingLeads.length} customer record(s) have no pipeline lead. Confirm original request dates or classify non-sales contacts; import dates do not establish inquiry dates.`);
  if(reconciled.issues.length)warnings.push(`${reconciled.issues.length} inquiry date or duplicate-link exception(s) need review before lead totals can be verified.`);
  if(!estimatesAvailable)warnings.push('PEC first-send history could not be refreshed. Estimate totals are unavailable; no zero was substituted.');
  if(pending.length)warnings.push(`${pending.length} proposal send(s) need delivery verification. Affected estimate totals are unavailable until their outcome is recorded.`);
  if(recovered.unresolved.length)warnings.push(`${recovered.unresolved.length} older proposal(s) lack complete first-send evidence. Affected historical weeks remain unverified.`);
  return {leads,missingLeads,inquiryIssues:reconciled.issues,firstSends:recovered.records,unresolved:recovered.unresolved,pending,
    leadsAvailable:ok(0)&&ok(1),estimatesAvailable,warnings,
    coverageStarts:{leads:firstFullSunday(leads.map(r=>r.inquiry_day+'T07:00:00Z').sort()[0]),estimates:firstFullSunday(recovered.records.map(r=>sendDay(r)+'T07:00:00Z').sort()[0])}};
}
function salesWeek(source,start,end){
  const leads=source.leads.filter(row=>inquiryDay(row)>=start&&inquiryDay(row)<=end);
  const inquiryIssues=(source.inquiryIssues||[]).filter(row=>row.from<=end&&row.through>=start);
  const estimates=source.firstSends.filter(row=>sendDay(row)>=start&&sendDay(row)<=end);
  // An unclassified import has no known original request date, so its affected range is unknown.
  const missingLeads=source.missingLeads;
  const unresolved=source.unresolved.filter(row=>row.from<=end&&row.through>=start);
  // Pending sends for an already counted proposal are resends, so cannot add a new proposal.
  const known=new Map(source.firstSends.map(row=>[row.estimate_id,row]));
  const pending=source.pending.filter(row=>{
    const first=known.get(row.estimate_id);
    if(first&&validTime(row.started_at)&&(first.first_sent_on?first.first_sent_on<=phoenixDay(row.started_at):Date.parse(first.first_sent_at)<=Date.parse(row.started_at)))return false;
    return (!validTime(row.started_at)||phoenixDay(row.started_at)<=end)&&(!first||sendDay(first)>=start);
  });
  return {leads,estimates,missingLeads,inquiryIssues,unresolved,pending,available:{
    leads:source.leadsAvailable&&!!source.coverageStarts.leads&&start>=source.coverageStarts.leads&&!missingLeads.length&&!inquiryIssues.length,
    estimates:source.estimatesAvailable&&!!source.coverageStarts.estimates&&start>=source.coverageStarts.estimates&&!unresolved.length&&!pending.length,
  }};
}
module.exports={fetchSalesMetrics,salesWeek,canonicalLeads,reconcileInquiries,inquiryDay,recoverFirstSends,messageEstimateIds,allRows};
