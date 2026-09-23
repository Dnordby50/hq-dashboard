'use strict';
// Private input only. Emits SQL; does not connect or send customer messages.
const fs=require('node:fs');
const {createHash}=require('node:crypto');
const KEY='historical-completion-dates-2026-09-22';
const quote=value=>value==null?'null':"'"+String(value).replace(/'/g,"''")+"'";
function buildSql(plan,sourceHash,apply=false){
  if(!Array.isArray(plan)||!plan.length||plan.length>200||!/^[a-f0-9]{64}$/.test(sourceHash))throw new Error('Invalid reviewed evidence');
  const ids=new Set();
  for(const r of plan){
    if(!/^[a-f0-9-]{36}$/.test(r.job_id)||!/^[a-f0-9-]{36}$/.test(r.customer_id)||ids.has(r.job_id)||!/^\d{4}-\d{2}-\d{2}$/.test(r.source_date)||r.old_date!=null&&!/^\d{4}-\d{2}-\d{2}$/.test(r.old_date)||!Number.isFinite(r.price))throw new Error('Invalid reviewed row');
    ids.add(r.job_id);
  }
  const values=plan.map(r=>`(${quote(r.job_id)}::uuid,${quote(r.customer_id)}::uuid,${quote(r.old_date)}::date,${quote(r.source_date)}::date,${r.price}::numeric,${quote(r.external_deal)}::text)`).join(',\n');
  const reviewed=`with reviewed(id,customer_id,old_date,source_date,price,external_deal) as (values ${values})`;
  const read=`${reviewed} select r.*,j.completed_date current_date,j.price current_price,j.customer_id current_customer,j.source,j.archived_at,j.voided_at,j.dripjobs_deal_id from reviewed r left join public.jobs j on j.id=r.id order by r.id`;
  if(!apply)return '-- READ ONLY: verify every row against the private source export.\n'+read+';';
  return `begin;
set local role service_role;
set local lock_timeout='8s';
set local statement_timeout='60s';
do $repair$
declare r record; before_row public.jobs%rowtype; after_row public.jobs%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(${quote(KEY)},0));
  for r in ${reviewed} select * from reviewed order by id loop
    select * into before_row from public.jobs where id=r.id for update;
    if not found or before_row.customer_id is distinct from r.customer_id or before_row.price is distinct from r.price
      or before_row.dripjobs_deal_id is distinct from r.external_deal or before_row.source not in ('native','dripjobs')
      or before_row.status is distinct from 'completed'
      or before_row.archived_at is not null or before_row.voided_at is not null then
      raise exception 'Reviewed completion evidence changed for %',r.id;
    end if;
    if exists(select 1 from public.audit_log where entity_id=r.id and action='historical_completion_date' and after_json->>'reconciliation_key'=${quote(KEY)}) then
      if before_row.completed_date is distinct from r.source_date then raise exception 'Reconciled date changed for %',r.id; end if;
      continue;
    end if;
    if before_row.completed_date is distinct from r.old_date then raise exception 'Completion date changed for %',r.id; end if;
    update public.jobs set completed_date=r.source_date where id=r.id returning * into after_row;
    insert into public.audit_log(action,entity_type,entity_id,before_json,after_json)
    values('historical_completion_date','jobs',r.id,to_jsonb(before_row),to_jsonb(after_row)||jsonb_build_object(
      'reconciliation_key',${quote(KEY)},'evidence_source','PEC DripJobs schedule end dates accepted by Dylan on 2026-09-22',
      'source_sha256',${quote(sourceHash)},'match','Schedule customer and exact contract amount; owner-approved schedule end date'));
  end loop;
end;
$repair$;
select count(*) as repaired_records from public.audit_log where action='historical_completion_date' and after_json->>'reconciliation_key'=${quote(KEY)};
commit;`;
}
module.exports={buildSql,KEY};
if(require.main===module){
  const args=process.argv.slice(2),file=args.find(v=>!v.startsWith('--')),source=args.find(v=>v.startsWith('--source='))?.slice(9);
  if(!file||!source)throw new Error('Usage: node scripts/reconcile-historical-completion-dates.cjs PRIVATE_PLAN.json --source=PRIVATE_SCHEDULE_EVIDENCE.md [--dry-run|--apply]');
  process.stdout.write(buildSql(JSON.parse(fs.readFileSync(file,'utf8')),createHash('sha256').update(fs.readFileSync(source)).digest('hex'),args.includes('--apply'))+'\n');
}
