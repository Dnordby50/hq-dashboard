// Private owner endpoint adapter. Public code only, no company data or caches.
const {fetchSalesMetrics,salesWeek}=require('./sales-metrics.cjs');
const DAY=86400000;
const FIELDS=['leads','estimates','jobsBooked','bookedDollars','producedDollars','laborHours'];
const day=value=>new Date(value).toISOString().slice(0,10);
const addDays=(value,n)=>day(Date.parse(`${value}T00:00:00Z`)+n*DAY);
const phoenixDay=value=>day(new Date(value).getTime()-7*3600000);
const weekEnding=value=>addDays(value,7-new Date(`${value}T00:00:00Z`).getUTCDay());
const firstFullSunday=value=>value?addDays(value,(7-new Date(`${value}T00:00:00Z`).getUTCDay())%7):null;
const jobsBase='customers!inner(company)&customers.company=eq.prescott-epoxy&archived_at=is.null&voided_at=is.null';
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
function dollars(rows){return rows.some(row=>row.price==null||!Number.isFinite(Number(row.price)))?null:rows.reduce((sum,row)=>sum+Number(row.price),0);}

async function fetchMbpLive({db,weekEndings,now=new Date(),enabled=true}){
  const queriedAt=new Date(now).toISOString(),today=phoenixDay(now),currentSunday=weekEnding(today);
  const calendar=weekEndings.filter(week=>week<=currentSunday),throughWeek=calendar.at(-1)||null;
  const warnings=[
    'Reporting weeks run Sunday through Saturday in Arizona time. Dates show the Saturday close.',
    'Leads count each new contact once from its pipeline inquiry date. Estimates count each proposal once on its first successful email or text send; resends and status changes do not add another.',
    'Labor hours remain manual: some time is unassigned and legacy manual hours have no work date.',
    'Booked and produced dollars use current contract prices, so later contract changes can restate prior weeks. Produced means completed work, not cash collected.',
  ];
  const result={weeks:[],queriedAt,throughWeek,warnings,coverageStarts:{leads:null,estimates:null,jobsBooked:null,bookedDollars:null,producedDollars:null,laborHours:null}};
  if(!enabled)return {...result,disabled:true,warnings:['Automatic PEC updates are turned off. Enter values manually.']};
  if(!calendar.length)return result;
  const start=addDays(calendar[0],-7),after=throughWeek<=today?throughWeek:addDays(today,1);
  const until=queriedAt<`${after}T07:00:00.000Z`?queriedAt:`${after}T07:00:00.000Z`;
  // One paged yearly read per table, plus narrow earliest-date metadata reads.
  // A failed source remains unavailable; it must never turn into a confirmed 0.
  const responses=await Promise.allSettled([
    fetchSalesMetrics({db,start,until}),
    allRows(db,`/jobs?select=id,price,signed_date,completed_date,dripjobs_deal_id,${jobsBase}&or=(and(signed_date.gte.${start},signed_date.lt.${after}),and(completed_date.gte.${start},completed_date.lt.${after}))`),
    db(`/jobs?select=signed_date,${jobsBase}&signed_date=not.is.null&order=signed_date.asc&limit=1`),
    db(`/jobs?select=completed_date,${jobsBase}&completed_date=not.is.null&order=completed_date.asc&limit=1`),
    allRows(db,`/jobs?select=id,signed_date,completed_date,status,${jobsBase}&or=(signed_date.is.null,and(status.eq.completed,completed_date.is.null))`),
  ]);
  const ok=index=>responses[index].status==='fulfilled'&&(index===0||Array.isArray(responses[index].value));
  const rows=index=>ok(index)?responses[index].value:[];
  const sales=ok(0)?responses[0].value:null,jobs=uniqueRows(rows(1)),duplicates=repeatedDeals(jobs);
  const coverageStarts={...result.coverageStarts,...sales?.coverageStarts,
    jobsBooked:firstFullSunday(sourceDate(rows(2)[0]?.signed_date)),
    bookedDollars:firstFullSunday(sourceDate(rows(2)[0]?.signed_date)),
    producedDollars:firstFullSunday(sourceDate(rows(3)[0]?.completed_date)),
  };
  const undated=rows(4),missingBookings=undated.filter(row=>!sourceDate(row.signed_date)),missingCompletions=undated.filter(row=>row.status==='completed'&&!sourceDate(row.completed_date));
  if(!ok(4))warnings.push('Job date completeness could not be checked. Booking and completion totals remain unverified.');
  if(missingBookings.length)warnings.push(`${missingBookings.length} job(s) have no verified booking date. Historical booking totals remain unverified until those dates are reconciled.`);
  if(missingCompletions.length)warnings.push(`${missingCompletions.length} completed job(s) have no verified completion date. Historical produced totals remain unverified until those dates are reconciled.`);
  warnings.push(...(sales?.warnings||['PEC sales sources could not be refreshed. Existing entries were retained.']));
  if(!ok(1)||!ok(2)||!ok(3))warnings.push('Some PEC booking or completion data could not be refreshed. Existing entries were retained.');
  if(duplicates.size)warnings.push('Repeated DripJobs deal IDs need review; affected booking and revenue weeks are unavailable.');
  if(jobs.some(row=>row.price==null||!Number.isFinite(Number(row.price))))warnings.push('Some jobs have no valid contract price; affected dollar totals are unavailable.');
  warnings.push('Automatic coverage starts with the first full week after the earliest recorded activity for each source. Earlier blank weeks remain unknown.');
  const weeks=calendar.map(week=>{
    const sunday=addDays(week,-7),saturday=addDays(week,-1),bucket=date=>date&&date>=sunday&&date<=saturday&&date<=today;
    const booked=jobs.filter(row=>bucket(sourceDate(row.signed_date))),produced=jobs.filter(row=>bucket(sourceDate(row.completed_date)));
    const containsDuplicate=rows=>rows.some(row=>duplicates.has(row.dripjobs_deal_id));
    const available=Object.fromEntries(FIELDS.map(field=>[field,false]));
    const counted=sales?salesWeek(sales,sunday,saturday):null;
    available.leads=counted?.available.leads===true;
    available.estimates=counted?.available.estimates===true;
    available.jobsBooked=ok(4)&&!missingBookings.length&&ok(1)&&ok(2)&&!!coverageStarts.jobsBooked&&sunday>=coverageStarts.jobsBooked&&!containsDuplicate(booked);
    available.bookedDollars=available.jobsBooked&&dollars(booked)!==null;
    available.producedDollars=ok(4)&&!missingCompletions.length&&ok(1)&&ok(3)&&!!coverageStarts.producedDollars&&sunday>=coverageStarts.producedDollars&&!containsDuplicate(produced)&&dollars(produced)!==null;
    const measured={leads:counted?.leads.length??null,estimates:counted?.estimates.length??null,jobsBooked:booked.length,bookedDollars:dollars(booked),producedDollars:dollars(produced),laborHours:null};
    return {weekEnding:week,start:sunday,end:saturday,partial:week>today,actual:Object.fromEntries(FIELDS.map(field=>[field,available[field]?measured[field]:null])),available};
  });
  if(weeks.some(row=>row.partial))warnings.push('The current week is in progress; its values reflect activity recorded so far.');
  return {...result,weeks,coverageStarts};
}
module.exports={fetchMbpLive};
