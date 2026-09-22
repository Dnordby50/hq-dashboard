// Owner-only reporting. No tokens, message bodies, or recipient details leave this adapter.
const DAY=86400000;
const phoenixDay=value=>new Date(Date.parse(value)-7*3600000).toISOString().slice(0,10);
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
async function allRows(db,path,order='id'){
  const result=[];
  for(let offset=0;offset<10000;offset+=1000){
    const rows=await db(`${path}&order=${order}&limit=1000&offset=${offset}`);
    if(!Array.isArray(rows))throw new Error('Invalid sales source response.');
    result.push(...rows);if(rows.length<1000)return result;
  }
  throw new Error('Sales source limit reached; no partial counts were returned.');
}
function firstFullMonday(value){
  if(!validTime(value))return null;
  const date=phoenixDay(value),stamp=Date.parse(`${date}T00:00:00Z`);
  return new Date(stamp+(8-new Date(stamp).getUTCDay())%7*DAY).toISOString().slice(0,10);
}
function canonicalLeads(rows){
  const contacts=new Map();
  for(const row of rows){
    if(row.deleted_at||!validTime(row.created_at))continue;
    const key=row.customer_id?`customer:${row.customer_id}`:`lead:${row.id}`;
    if(!contacts.has(key)||Date.parse(row.created_at)<Date.parse(contacts.get(key).created_at))contacts.set(key,row);
  }
  return [...contacts.values()];
}
// Match only the exact proposal URL token. Subject lines and customer names are editable.
function messageEstimateIds(body,byToken){
  const ids=new Set();
  for(const match of String(body||'').matchAll(/\/e\/([a-z0-9-]+)(?=$|[?&#\s"'<>.,)!])/gi)){
    const id=byToken.get(match[1]);if(id)ids.add(id);
  }
  return ids;
}
function recoverFirstSends({estimates,firstSends,emails,sms,trackingStartedAt=null}){
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
  // A sent stamp without a receipt can be an on-site presentation or missing history.
  // Never silently substitute the mutable most-recent-send date for the first send.
  const unresolved=estimates.filter(row=>row.sent_at&&!records.has(row.id)).map(row=>({
    estimate_id:row.id,estimate_number:row.estimate_number,
    from:validTime(row.created_at)?phoenixDay(row.created_at):'0000-01-01',
    through:validTime(row.sent_at)?phoenixDay(row.sent_at):'9999-12-31',
  }));
  const sunday=value=>{const date=phoenixDay(value),stamp=Date.parse(`${date}T00:00:00Z`);return new Date(stamp+(7-new Date(stamp).getUTCDay())%7*DAY).toISOString().slice(0,10);};
  for(const record of records.values()){
    const estimate=byId.get(record.estimate_id);
    const created=estimate?.created_at;
    const fullyTracked=record.evidence==='first_send_record'&&validTime(created)&&validTime(trackingStartedAt)&&Date.parse(created)>=Date.parse(trackingStartedAt);
    // Historical logs were best-effort. If creation and earliest receipt span
    // weeks, a missing older receipt could move this proposal to another week.
    if(!fullyTracked&&(!validTime(created)||sunday(created)!==sunday(record.first_sent_at)))unresolved.push({
      estimate_id:record.estimate_id,estimate_number:record.estimate_number,
      from:validTime(created)?phoenixDay(created):'0000-01-01',through:phoenixDay(record.first_sent_at),
    });
  }
  return {records:[...records.values()],unresolved};
}
async function fetchSalesMetrics({db,start,until}){
  const results=await Promise.allSettled([
    // Read prior contacts too: a duplicate/re-linked lead must not become a new contact this year.
    allRows(db,`/leads?select=id,customer_id,full_name,created_at,deleted_at&brand=eq.PEC&created_at=lt.${until}`),
    allRows(db,`/customers?select=id,name,created_at&company=eq.prescott-epoxy&created_at=gte.${start}T07:00:00Z&created_at=lt.${until}`),
    allRows(db,`/estimates?select=id,estimate_number,public_token,created_at,sent_at&brand=eq.PEC&created_at=lt.${until}`),
    allRows(db,`/pec_estimate_first_sends?select=estimate_id,first_sent_at,channel&brand=eq.PEC&first_sent_at=lt.${until}`,'estimate_id'),
    allRows(db,`/pec_email_log?select=id,sent_at,status,resend_id,body_html&brand=in.(PEC,prescott-epoxy)&template_key=eq.estimate&resend_id=not.is.null&sent_at=lt.${until}`),
    allRows(db,`/pec_sms_log?select=id,created_at,status,direction,quo_message_id,body&brand=in.(PEC,prescott-epoxy)&kind=eq.estimate&direction=eq.out&quo_message_id=not.is.null&created_at=lt.${until}`),
    allRows(db,`/pec_estimate_send_attempts?select=id,estimate_id,started_at,status&brand=eq.PEC&started_at=lt.${until}`),
  ]);
  const ok=index=>results[index].status==='fulfilled';
  const rows=index=>ok(index)?results[index].value:[];
  const leads=canonicalLeads(rows(0)),linked=new Set(rows(0).filter(r=>r.customer_id&&!r.deleted_at).map(r=>r.customer_id));
  const missingLeads=rows(1).filter(row=>!linked.has(row.id));
  const estimatesAvailable=[2,3,4,5,6].every(ok);
  const trackingStartedAt=rows(6).map(row=>row.started_at).filter(validTime).sort()[0]||null;
  const recovered=recoverFirstSends({estimates:rows(2),firstSends:rows(3),emails:rows(4),sms:rows(5),trackingStartedAt});
  const pending=rows(6).filter(row=>row.status==='pending');
  const warnings=[];
  if(!ok(0)||!ok(1))warnings.push('PEC lead data could not be refreshed. Existing entries were retained.');
  if(missingLeads.length)warnings.push(`${missingLeads.length} new contact record(s) have no pipeline lead. Affected lead totals need reconciliation, including checking for historical imports.`);
  if(!estimatesAvailable)warnings.push('PEC first-send history could not be refreshed. Estimate totals are unavailable; no zero was substituted.');
  if(pending.length)warnings.push(`${pending.length} proposal send(s) need delivery verification. Affected estimate totals are unavailable until their outcome is recorded.`);
  if(recovered.unresolved.length)warnings.push(`${recovered.unresolved.length} older proposal(s) lack complete first-send evidence. Affected historical weeks remain unverified.`);
  return {leads,missingLeads,firstSends:recovered.records,unresolved:recovered.unresolved,pending,
    leadsAvailable:ok(0)&&ok(1),estimatesAvailable,warnings,
    coverageStarts:{leads:firstFullMonday(leads.map(r=>r.created_at).sort()[0]),estimates:firstFullMonday(recovered.records.map(r=>r.first_sent_at).sort()[0])}};
}
function salesWeek(source,monday,sunday){
  const within=value=>validTime(value)&&phoenixDay(value)>=monday&&phoenixDay(value)<=sunday;
  const leads=source.leads.filter(row=>within(row.created_at));
  const estimates=source.firstSends.filter(row=>within(row.first_sent_at));
  const missingLeads=source.missingLeads.filter(row=>within(row.created_at));
  const unresolved=source.unresolved.filter(row=>row.from<=sunday&&row.through>=monday);
  // Pending sends for an already counted proposal are resends, so cannot add a new proposal.
  const known=new Map(source.firstSends.map(row=>[row.estimate_id,row.first_sent_at]));
  const pending=source.pending.filter(row=>{
    const first=known.get(row.estimate_id);
    if(first&&validTime(row.started_at)&&Date.parse(first)<=Date.parse(row.started_at))return false;
    return (!validTime(row.started_at)||phoenixDay(row.started_at)<=sunday)&&(!first||phoenixDay(first)>=monday);
  });
  return {leads,estimates,missingLeads,unresolved,pending,available:{
    leads:source.leadsAvailable&&!!source.coverageStarts.leads&&monday>=source.coverageStarts.leads&&!missingLeads.length,
    estimates:source.estimatesAvailable&&!!source.coverageStarts.estimates&&monday>=source.coverageStarts.estimates&&!unresolved.length&&!pending.length,
  }};
}
module.exports={fetchSalesMetrics,salesWeek,canonicalLeads,recoverFirstSends,messageEstimateIds,allRows};
