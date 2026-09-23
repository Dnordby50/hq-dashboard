// Private owner endpoint adapter. Public code only, no company data or caches.
const {fetchSalesMetrics,salesWeek}=require('./sales-metrics.cjs');
const DAY=86400000;
const FIELDS=['leads','estimates','jobsBooked','bookedDollars','producedDollars','laborHours'];
const day=value=>new Date(value).toISOString().slice(0,10);
const addDays=(value,n)=>day(Date.parse(`${value}T00:00:00Z`)+n*DAY);
const phoenixDay=value=>day(new Date(value).getTime()-7*3600000);
const weekEnding=value=>addDays(value,7-new Date(`${value}T00:00:00Z`).getUTCDay());
const firstFullSunday=value=>value?addDays(value,(7-new Date(`${value}T00:00:00Z`).getUTCDay())%7):null;
const jobsBase='customers!inner(company,name)&customers.company=eq.prescott-epoxy&archived_at=is.null&voided_at=is.null';
async function allRows(db,path){
  const rows=[];
  for(let offset=0;offset<10000;offset+=1000){
    const batch=await db(`${path}&order=id&limit=1000&offset=${offset}`);
    if(!Array.isArray(batch))throw new Error('Invalid source response.');
    rows.push(...batch);if(batch.length<1000)return rows;
  }
  throw new Error('Source row limit reached.');
}
function sourceDate(value,timestamp=false){
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))return null;
  const date=timestamp?phoenixDay(value):value.slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date)?date:null;
}
function uniqueRows(rows){return [...new Map(rows.map(row=>[row.id,row])).values()];}
function repeatedDeals(rows){
  const seen=new Set(),duplicate=new Set();
  for(const row of rows)if(row.dripjobs_deal_id){if(seen.has(row.dripjobs_deal_id))duplicate.add(row.dripjobs_deal_id);seen.add(row.dripjobs_deal_id);}
  return duplicate;
}

async function fetchMbpLive({db,weekEndings,now=new Date(),enabled=true}){
  const queriedAt=new Date(now).toISOString(),today=phoenixDay(now),currentSunday=weekEnding(today);
  const calendar=weekEndings.filter(week=>week<=currentSunday),throughWeek=calendar.at(-1)||null;
  const warnings=[
    'Reporting weeks run Sunday through Saturday in Arizona time. Dates show the Saturday close.',
    'Leads count each separate quote request on its original inquiry date, including returning customers. Estimates count each proposal once on its first successful email or text send; resends and status changes do not add another.',
    'Labor hours remain manual: some time is unassigned and legacy manual hours have no work date.',
    'New booked and completed values use preserved event amounts. Later adjustments appear on their recorded business date. Legacy jobs without events still use current contract prices and need historical verification. Produced means completed work, not cash collected.',
  ];
  const result={weeks:[],exceptions:[],queriedAt,throughWeek,warnings,coverageStarts:{leads:null,estimates:null,jobsBooked:null,bookedDollars:null,producedDollars:null,laborHours:null}};
  if(!enabled)return {...result,disabled:true,warnings:['Automatic PEC updates are turned off. Enter values manually.']};
  if(!calendar.length)return result;
  const start=addDays(calendar[0],-7),after=throughWeek<=today?throughWeek:addDays(today,1);
  const until=queriedAt<`${after}T07:00:00.000Z`?queriedAt:`${after}T07:00:00.000Z`;
  // One paged yearly read per table, plus narrow earliest-date metadata reads.
  // A failed source remains unavailable; it must never turn into a confirmed 0.
  const responses=await Promise.allSettled([
    fetchSalesMetrics({db,start,until}),
    allRows(db,`/jobs?select=id,customer_id,price,signed_date,completed_date,dripjobs_deal_id,${jobsBase}&or=(and(signed_date.gte.${start},signed_date.lt.${after}),and(completed_date.gte.${start},completed_date.lt.${after}))`),
    db(`/jobs?select=signed_date,${jobsBase}&signed_date=not.is.null&order=signed_date.asc&limit=1`),
    db(`/jobs?select=completed_date,${jobsBase}&completed_date=not.is.null&order=completed_date.asc&limit=1`),
    allRows(db,`/jobs?select=id,customer_id,signed_date,completed_date,status,${jobsBase}&or=(signed_date.is.null,and(status.eq.completed,completed_date.is.null))`),
    allRows(db,`/pec_job_business_events?select=id,job_id,event_type,business_date,amount_snapshot,source,evidence_ref,recorded_at,supersedes_event_id,jobs!inner(customer_id,archived_at,voided_at,customers!inner(name,company))&brand=eq.PEC&jobs.customers.company=eq.prescott-epoxy`),
    allRows(db,'/pec_sales_integrity_exceptions?select=id,source,source_event_key,event_type,entity_ref,reason,recorded_at&brand=eq.PEC&state=eq.open'),
    allRows(db,'/pec_prod_jobs?select=id,customer_id,customer_name,proposal_number,status,install_date,completed_date,created_at,crm_job_id,archived_at,is_callback,reporting_excluded_at,reporting_exclusion_reason,customers(company)&archived_at=is.null&is_callback=eq.false&crm_job_id=is.null&reporting_excluded_at=is.null'),
  ]);
  const ok=index=>responses[index].status==='fulfilled'&&(index===0||Array.isArray(responses[index].value));
  const rows=index=>ok(index)?responses[index].value:[];
  const sales=ok(0)?responses[0].value:null,jobs=uniqueRows(rows(1)),duplicates=repeatedDeals(jobs);
  const events=rows(5),superseded=new Set(events.map(row=>row.supersedes_event_id).filter(Boolean)),activeEvents=events.filter(row=>!superseded.has(row.id));
  const bookingEvents=activeEvents.filter(row=>row.event_type==='booked'),completionEvents=activeEvents.filter(row=>['completed','completion_amended'].includes(row.event_type));
  const bookedEventIds=new Set(bookingEvents.map(row=>row.job_id)),completedEventIds=new Set(completionEvents.map(row=>row.job_id));
  const earliest=(legacy,items)=>[sourceDate(legacy),...items.map(row=>sourceDate(row.business_date))].filter(Boolean).sort()[0]||null;
  const coverageStarts={...result.coverageStarts,...sales?.coverageStarts,
    jobsBooked:firstFullSunday(earliest(rows(2)[0]?.signed_date,bookingEvents)),
    bookedDollars:firstFullSunday(earliest(rows(2)[0]?.signed_date,bookingEvents)),
    producedDollars:firstFullSunday(earliest(rows(3)[0]?.completed_date,completionEvents)),
  };
  const undated=rows(4),missingBookings=undated.filter(row=>!sourceDate(row.signed_date)),missingCompletions=undated.filter(row=>row.status==='completed'&&!sourceDate(row.completed_date));
  if(!ok(5)||!ok(6))warnings.push('Business-event history or the exception queue could not be refreshed. Booking and completion totals remain unverified.');
  if(rows(6).length)warnings.push(`${rows(6).length} source event(s) need a verified date or record link before affected totals can be confirmed.`);
  if(!ok(4))warnings.push('Job date completeness could not be checked. Booking and completion totals remain unverified.');
  if(missingBookings.length)warnings.push(`${missingBookings.length} job(s) have no verified booking date. Historical booking totals remain unverified until those dates are reconciled.`);
  if(missingCompletions.length)warnings.push(`${missingCompletions.length} completed job(s) have no verified completion date. Historical produced totals remain unverified until those dates are reconciled.`);
  warnings.push(...(sales?.warnings||['PEC sales sources could not be refreshed. Existing entries were retained.']));
  if(!ok(1)||!ok(2)||!ok(3))warnings.push('Some PEC booking or completion data could not be refreshed. Existing entries were retained.');
  if(duplicates.size)warnings.push('Repeated DripJobs deal IDs need review; affected booking and revenue weeks are unavailable.');
  if(jobs.some(row=>row.price==null||!Number.isFinite(Number(row.price))))warnings.push('Some jobs have no valid contract price; affected dollar totals are unavailable.');
  warnings.push('Automatic coverage starts with the first full week after the earliest recorded activity for each source. Earlier blank weeks remain unknown.');
  const issue=(id,metric,recordId,label,reason,action,extra={})=>({id,metric,recordId,label,reason,action,from:null,through:null,...extra});
  // This is the PEC production table; retain legacy rows without a customer,
  // while an explicitly FTP-owned row cannot affect the PEC sales plan.
  const orphanProduction=rows(7).filter(row=>!row.crm_job_id&&!row.archived_at&&!row.is_callback&&!row.reporting_excluded_at&&(!row.customers?.company||row.customers.company==='prescott-epoxy'));
  const productionIssues=orphanProduction.flatMap(row=>{
    const completed=sourceDate(row.completed_date),label=`${row.customer_name||'Production job'}${row.proposal_number?` · #${row.proposal_number}`:''}`;
    const active=['scheduled','in_progress','completed'].includes(row.status);
    const detail=row.install_date?` Planned install: ${row.install_date}; this is not an acceptance or completion date.`:'';
    const action='Review the exact customer, proposal and scope, then link the existing job card or classify this as a separate non-sales production record. Do not match by name alone.';
    const tasks=[issue(`production-booking:${row.id}`,'jobsBooked',row.id,label,`${active?'Production work has no explicit sales job link.':'Unscheduled production record needs sales classification.'}${detail}`,action,{through:completed,blocksTotal:active})];
    if(row.status==='completed')tasks.push(issue(`production-completion:${row.id}`,'producedDollars',row.id,label,'Completed production work has no explicit sales job link.',action,{from:completed,through:completed,blocksTotal:true}));
    return tasks;
  });
  if(!ok(7))warnings.push('Production job links could not be checked. Booking and completed-work totals remain unverified.');
  if(orphanProduction.length)warnings.push(`${orphanProduction.length} production record(s) need an explicit sales job link or a reviewed non-sales classification. Unscheduled records do not become assumed sales.`);
  const exceptions=[
    ...productionIssues,
    ...(sales?.missingLeads||[]).map(row=>issue(`contact:${row.id}`,'leads',row.id,row.name||'Customer','No pipeline inquiry is linked.','Find the original quote request and link or create its inquiry with evidence; explicitly classify a non-sales contact.')),
    ...(sales?.inquiryIssues||[]).map(row=>issue(`inquiry:${row.id}`,'leads',row.id,row.name||'Inquiry',row.reason,'Verify the original date and canonical inquiry; record the supporting source.')),
    ...(sales?.unresolved||[]).map(row=>issue(`send:${row.estimate_id}`,'estimates',row.estimate_id,`Proposal ${row.estimate_number||row.estimate_id}`,'The original first-send date is not verified.','Find the earliest successful delivery receipt or obtain an owner-confirmed original date.',{from:row.from,through:row.through})),
    ...(sales?.pending||[]).filter(row=>!sales.firstSends.some(first=>first.estimate_id===row.estimate_id&&(first.first_sent_on?first.first_sent_on<=sourceDate(row.started_at,true):Date.parse(first.first_sent_at)<=Date.parse(row.started_at)))).map(row=>issue(`pending:${row.id}`,'estimates',row.estimate_id,'Proposal send','Delivery outcome is uncertain.','Verify the provider receipt before retrying the send.')),
    ...missingBookings.map(row=>issue(`booking:${row.id}`,'jobsBooked',row.id,row.customers?.name||'Job','Original acceptance date is missing.','Match the exact proposal and its acceptance history; record the original accepted date.')),
    ...missingCompletions.map(row=>issue(`completion:${row.id}`,'producedDollars',row.id,row.customers?.name||'Completed job','Actual completion date is missing.','Verify the completion confirmation or approved schedule end date.')),
    ...jobs.filter(row=>duplicates.has(row.dripjobs_deal_id)).map(row=>issue(`duplicate:${row.id}`,'jobsBooked',row.id,row.customers?.name||'Job','Multiple jobs share one external proposal ID.','Review the exact source proposals and correct the link without deleting legitimate work.')),
    ...jobs.filter(row=>row.price==null||!Number.isFinite(Number(row.price))).map(row=>issue(`price:${row.id}`,'bookedDollars',row.id,row.customers?.name||'Job','Contract price is missing or invalid.','Verify the accepted scope and amount before changing the price.')),
    ...activeEvents.filter(row=>row.amount_snapshot==null||!Number.isFinite(Number(row.amount_snapshot))).map(row=>issue(`event-amount:${row.id}`,/complet/.test(row.event_type)?'producedDollars':'bookedDollars',row.job_id,row.jobs?.customers?.name||'Business event','The preserved event amount is missing or invalid.','Verify the original event amount and record an audited correction; do not substitute the current price.',{from:row.business_date,through:row.business_date})),
    ...rows(6).map(row=>issue(`event:${row.id}`,/complet/.test(row.event_type)?'producedDollars':/book|accept/.test(row.event_type)?'jobsBooked':/estimate|send/.test(row.event_type)?'estimates':'leads',row.entity_ref,`${row.source} ${row.entity_ref||row.source_event_key}`,row.reason,'Review the source event, verify its original date and exact record link, then resolve the exception.')),
  ];
  const safeJob=(row,date,amount,basis)=>({id:row.id,customerId:row.customer_id,label:row.customers?.name||'Job',date,amount,basis});
  const safeEvent=row=>({id:row.job_id,eventId:row.id,customerId:row.jobs?.customer_id,label:row.jobs?.customers?.name||'Job',date:row.business_date,amount:row.amount_snapshot==null?null:Number(row.amount_snapshot),basis:row.event_type,source:row.source,evidence:row.evidence_ref});
  const sumAmounts=rows=>rows.some(row=>row.amount==null||!Number.isFinite(row.amount))?null:rows.reduce((sum,row)=>sum+row.amount,0);
  const weeks=calendar.map(week=>{
    const sunday=addDays(week,-7),saturday=addDays(week,-1),bucket=date=>date&&date>=sunday&&date<=saturday&&date<=today;
    const booked=jobs.filter(row=>bucket(sourceDate(row.signed_date))),produced=jobs.filter(row=>bucket(sourceDate(row.completed_date)));
    const bookingSources=[...booked.filter(row=>!bookedEventIds.has(row.id)).map(row=>safeJob(row,row.signed_date,row.price==null?null:Number(row.price),'legacy_current_contract')),...bookingEvents.filter(row=>bucket(row.business_date)).map(safeEvent)];
    const bookedMoney=[...booked.filter(row=>!bookedEventIds.has(row.id)).map(row=>safeJob(row,row.signed_date,row.price==null?null:Number(row.price),'legacy_current_contract')),...activeEvents.filter(row=>['booked','booked_adjusted'].includes(row.event_type)&&bucket(row.business_date)).map(safeEvent)];
    const producedMoney=[...produced.filter(row=>!completedEventIds.has(row.id)).map(row=>safeJob(row,row.completed_date,row.price==null?null:Number(row.price),'legacy_current_contract')),...activeEvents.filter(row=>['completed','completion_amended','completed_adjusted'].includes(row.event_type)&&bucket(row.business_date)).map(safeEvent)];
    const containsDuplicate=rows=>rows.some(row=>duplicates.has(row.dripjobs_deal_id));
    const available=Object.fromEntries(FIELDS.map(field=>[field,false]));
    const counted=sales?salesWeek(sales,sunday,saturday):null;
    const missingProductionLink=metric=>productionIssues.some(row=>row.blocksTotal&&row.metric===metric&&(!row.from||row.from<=saturday)&&(!row.through||row.through>=sunday));
    available.leads=ok(6)&&counted?.available.leads===true&&!rows(6).some(row=>!/book|accept|complet|estimate|send/.test(row.event_type));
    available.estimates=ok(6)&&counted?.available.estimates===true&&!rows(6).some(row=>/estimate|send/.test(row.event_type));
    available.jobsBooked=ok(7)&&!missingProductionLink('jobsBooked')&&ok(5)&&ok(6)&&!rows(6).some(row=>/book|accept/.test(row.event_type))&&ok(4)&&!missingBookings.length&&ok(1)&&ok(2)&&!!coverageStarts.jobsBooked&&sunday>=coverageStarts.jobsBooked&&!containsDuplicate(booked);
    available.bookedDollars=available.jobsBooked&&sumAmounts(bookedMoney)!==null;
    available.producedDollars=ok(7)&&!missingProductionLink('producedDollars')&&ok(5)&&ok(6)&&!rows(6).some(row=>/complet/.test(row.event_type))&&ok(4)&&!missingCompletions.length&&ok(1)&&ok(3)&&!!coverageStarts.producedDollars&&sunday>=coverageStarts.producedDollars&&!containsDuplicate(produced)&&sumAmounts(producedMoney)!==null;
    const measured={leads:counted?.leads.length??null,estimates:counted?.estimates.length??null,jobsBooked:bookingSources.length,bookedDollars:sumAmounts(bookedMoney),producedDollars:sumAmounts(producedMoney),laborHours:null};
    const sources={leads:(counted?.leads||[]).map(row=>({id:row.id,customerId:row.customer_id,label:row.full_name||'Inquiry',date:row.inquiry_day,source:row.source,basis:row.date_evidence,evidence:row.inquiry_evidence})),estimates:(counted?.estimates||[]).map(row=>({id:row.estimate_id,label:`Proposal ${row.estimate_number||row.estimate_id}`,date:row.first_sent_on||sourceDate(row.first_sent_at,true),source:row.channel,basis:row.evidence})),jobsBooked:bookingSources,bookedDollars:bookedMoney,producedDollars:producedMoney};
    const exceptionIds=exceptions.filter(row=>(!row.from||row.from<=saturday)&&(!row.through||row.through>=sunday)).map(row=>row.id);
    return {sources,exceptionIds,weekEnding:week,start:sunday,end:saturday,partial:week>today,actual:Object.fromEntries(FIELDS.map(field=>[field,available[field]?measured[field]:null])),available};
  });
  if(weeks.some(row=>row.partial))warnings.push('The current week is in progress; its values reflect activity recorded so far.');
  return {...result,weeks,coverageStarts,exceptions};
}
module.exports={fetchMbpLive};
