'use strict';
// Executable draft contract. Not imported by production code; no database writes.
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const instant=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
const phoenixDay=value=>new Date(Date.parse(value)-7*3600000).toISOString().slice(0,10);
const review=reason=>({action:'review',reason});

function planInquiry({customerId,brand='PEC',mode,requestKey,leadId,existing=[]}){
  if(!customerId||!['PEC','FTP'].includes(brand))return review('A verified customer and company are required.');
  const related=existing.filter(r=>r.customer_id===customerId&&r.brand===brand&&!r.deleted_at);
  if(requestKey){
    const retries=existing.filter(r=>r.request_key===requestKey&&r.brand===brand);
    if(retries.length>1||retries.some(r=>r.customer_id!==customerId||r.deleted_at))return review('The request identifier conflicts with an existing record.');
    if(retries.length===1)return {action:'link',leadId:retries[0].id,reason:'same_request'};
  }
  if(mode==='new'){
    if(!requestKey)return review('A stable request identifier is required before saving.');
    return {action:'create',customerId,brand,requestKey};
  }
  if(mode!=='followup')return review('Classify this as a new request or a follow-up.');
  if(leadId){
    const match=related.find(r=>r.id===leadId);
    return match?{action:'link',leadId:match.id,reason:'explicit_request'}:review('The selected request belongs to another customer or company, or is unavailable.');
  }
  const active=related.filter(r=>!r.archived_at&&!['accepted','lost'].includes(r.stage));
  if(active.length===1)return {action:'link',leadId:active[0].id,reason:'only_active_request'};
  return review(active.length?'Choose which existing request this follows.':'Choose an existing request or start a new one.');
}

function businessDate({origin,occurredAt,occurredOn,confirmedOn,receivedAt}){
  if(!instant(receivedAt))return review('A server receipt timestamp is required.');
  const today=phoenixDay(receivedAt);
  if(occurredAt&&!instant(occurredAt))return review('The source timestamp requires an explicit time zone.');
  if(occurredOn&&!day(occurredOn)||confirmedOn&&!day(confirmedOn))return review('The source calendar date is invalid.');
  if(occurredAt&&occurredOn&&phoenixDay(occurredAt)!==occurredOn)return review('Source date and timestamp disagree.');
  const date=confirmedOn||occurredOn||(occurredAt?phoenixDay(occurredAt):origin==='staff_live'?today:null);
  if(!date)return review('Recover the original business-event date; receipt or import time is not evidence.');
  if(date>today)return review('The event cannot have happened in the future.');
  return {action:'record',occurredOn:date,occurredAt:confirmedOn||occurredOn?null:occurredAt||receivedAt,
    evidence:confirmedOn?'owner_confirmation':origin==='staff_live'?'staff_action':'source_event'};
}

function completionPlan({crmJobId,productionJob,job,completedOn,receivedAt}){
  if(!crmJobId||!job||job.id!==crmJobId||!productionJob||productionJob.crm_job_id!==crmJobId)return review('Resolve the explicit CRM-to-production job link before completion.');
  if(job.voided_at||job.archived_at)return review('The linked job is unavailable for completion.');
  if(job.completed_date&&job.status==='completed'&&productionJob.status==='completed'&&(!completedOn||job.completed_date===completedOn))return {action:'no_op'};
  const date=businessDate({origin:'staff_live',occurredOn:completedOn,receivedAt});
  if(date.action==='review')return date;
  if(job.completed_date&&job.completed_date!==date.occurredOn)return review('Correct the existing completion through an audited amendment.');
  if(job.completed_date===date.occurredOn&&job.status==='completed'&&productionJob.status==='completed')return {action:'no_op'};
  return {action:'atomic_completion',crmJobId,productionJobId:productionJob.id,completedOn:date.occurredOn};
}

function weekOf(value){
  if(!day(value))throw new Error('A calendar date is required.');
  const stamp=Date.parse(value+'T00:00:00Z'),start=stamp-new Date(stamp).getUTCDay()*86400000;
  return {start:new Date(start).toISOString().slice(0,10),end:new Date(start+6*86400000).toISOString().slice(0,10)};
}
module.exports={planInquiry,businessDate,completionPlan,weekOf};
