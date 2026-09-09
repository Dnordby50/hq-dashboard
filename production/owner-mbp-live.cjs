// Private owner endpoint adapter. Public code only, no company data or caches.
const DAY=86400000;
const FIELDS=['leads','estimates','jobsBooked','bookedDollars','producedDollars','laborHours'];
const day=value=>new Date(value).toISOString().slice(0,10);
const addDays=(value,n)=>day(Date.parse(`${value}T00:00:00Z`)+n*DAY);
const phoenixDay=value=>day(new Date(value).getTime()-7*3600000);
const weekEnding=value=>addDays(value,(7-new Date(`${value}T00:00:00Z`).getUTCDay())%7);
const firstFullMonday=value=>value?addDays(value,(8-new Date(`${value}T00:00:00Z`).getUTCDay())%7):null;
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
    'Estimates remain manual: first-send history is incomplete and re-sends change the estimate sent date.',
    'Labor hours remain manual: some time is unassigned and legacy manual hours have no work date.',
    'Booked and produced dollars use current contract prices, so later contract changes can restate prior weeks. Produced means completed work, not cash collected.',
  ];
  const result={weeks:[],queriedAt,throughWeek,warnings,coverageStarts:{leads:null,estimates:null,jobsBooked:null,bookedDollars:null,producedDollars:null,laborHours:null}};
  if(!enabled)return {...result,disabled:true,warnings:['Automatic PEC updates are turned off. Enter values manually.']};
  if(!calendar.length)return result;
  const start=addDays(calendar[0],-6),after=addDays(throughWeek<today?throughWeek:today,1);
  const until=queriedAt<`${after}T07:00:00.000Z`?queriedAt:`${after}T07:00:00.000Z`;
  // One paged yearly read per table, plus narrow earliest-date metadata reads.
  // A failed source remains unavailable; it must never turn into a confirmed 0.
  const responses=await Promise.allSettled([
    allRows(db,`/leads?select=id,created_at&brand=eq.PEC&deleted_at=is.null&created_at=gte.${start}T07:00:00Z&created_at=lt.${until}`),
    allRows(db,`/jobs?select=id,price,signed_date,completed_date,dripjobs_deal_id,${jobsBase}&or=(and(signed_date.gte.${start},signed_date.lt.${after}),and(completed_date.gte.${start},completed_date.lt.${after}))`),
    db('/leads?select=created_at&brand=eq.PEC&deleted_at=is.null&order=created_at.asc&limit=1'),
    db(`/jobs?select=signed_date,${jobsBase}&signed_date=not.is.null&order=signed_date.asc&limit=1`),
    db(`/jobs?select=completed_date,${jobsBase}&completed_date=not.is.null&order=completed_date.asc&limit=1`),
  ]);
  const ok=index=>responses[index].status==='fulfilled'&&Array.isArray(responses[index].value);
  const rows=index=>ok(index)?responses[index].value:[];
  const leads=uniqueRows(rows(0)),jobs=uniqueRows(rows(1)),duplicates=repeatedDeals(jobs);
  const coverageStarts={...result.coverageStarts,
    leads:firstFullMonday(sourceDate(rows(2)[0]?.created_at,true)),
    jobsBooked:firstFullMonday(sourceDate(rows(3)[0]?.signed_date)),
    bookedDollars:firstFullMonday(sourceDate(rows(3)[0]?.signed_date)),
    producedDollars:firstFullMonday(sourceDate(rows(4)[0]?.completed_date)),
  };
  if(!ok(0)||!ok(2))warnings.push('PEC lead data could not be refreshed. Existing entries were retained.');
  if(!ok(1)||!ok(3)||!ok(4))warnings.push('Some PEC booking or completion data could not be refreshed. Existing entries were retained.');
  if(duplicates.size)warnings.push('Repeated DripJobs deal IDs need review; affected booking and revenue weeks are unavailable.');
  if(jobs.some(row=>row.price==null||!Number.isFinite(Number(row.price))))warnings.push('Some jobs have no valid contract price; affected dollar totals are unavailable.');
  warnings.push('Automatic coverage starts with the first full week after the earliest recorded activity for each source. Earlier blank weeks remain unknown.');
  const weeks=calendar.map(week=>{
    const monday=addDays(week,-6),bucket=date=>date&&date>=monday&&date<=week&&date<=today;
    const booked=jobs.filter(row=>bucket(sourceDate(row.signed_date))),produced=jobs.filter(row=>bucket(sourceDate(row.completed_date)));
    const containsDuplicate=rows=>rows.some(row=>duplicates.has(row.dripjobs_deal_id));
    const available=Object.fromEntries(FIELDS.map(field=>[field,false]));
    available.leads=ok(0)&&ok(2)&&!!coverageStarts.leads&&monday>=coverageStarts.leads;
    available.jobsBooked=ok(1)&&ok(3)&&!!coverageStarts.jobsBooked&&monday>=coverageStarts.jobsBooked&&!containsDuplicate(booked);
    available.bookedDollars=available.jobsBooked&&dollars(booked)!==null;
    available.producedDollars=ok(1)&&ok(4)&&!!coverageStarts.producedDollars&&monday>=coverageStarts.producedDollars&&!containsDuplicate(produced)&&dollars(produced)!==null;
    const measured={leads:leads.filter(row=>bucket(sourceDate(row.created_at,true))).length,estimates:null,jobsBooked:booked.length,bookedDollars:dollars(booked),producedDollars:dollars(produced),laborHours:null};
    return {weekEnding:week,partial:week>=today,actual:Object.fromEntries(FIELDS.map(field=>[field,available[field]?measured[field]:null])),available};
  });
  if(weeks.some(row=>row.partial))warnings.push('The current week is in progress; its values reflect activity recorded so far.');
  return {...result,weeks,coverageStarts};
}
module.exports={fetchMbpLive};
