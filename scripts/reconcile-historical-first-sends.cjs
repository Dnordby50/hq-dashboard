'use strict';
const fs=require('node:fs');
const KEY='owner-confirmed-first-sends-2026-09-22';
const quote=v=>"'"+String(v).replace(/'/g,"''")+"'";
function buildSql(plan,apply=false){
  if(!Array.isArray(plan)||!plan.length||new Set(plan.map(r=>r.estimate_id)).size!==plan.length)throw Error('Invalid reviewed plan');
  for(const r of plan)if(!/^[a-f0-9-]{36}$/.test(r.estimate_id)||!Number.isInteger(r.estimate_number)||!/^\d{4}-\d{2}-\d{2}$/.test(r.first_sent_on))throw Error('Invalid reviewed proposal');
  const reviewed=`with reviewed(id,number,day) as (values ${plan.map(r=>`(${quote(r.estimate_id)}::uuid,${r.estimate_number},${quote(r.first_sent_on)}::date)`).join(',')})`;
  if(!apply)return `${reviewed} select r.*,e.brand,e.created_at,e.sent_at,e.deleted_at from reviewed r left join estimates e on e.id=r.id;`;
  return `begin;
set local role service_role;
set local lock_timeout='8s';
do $repair$
declare r record; e public.estimates%rowtype; prior date;
begin
 perform pg_advisory_xact_lock(hashtextextended(${quote(KEY)},0));
 for r in ${reviewed} select * from reviewed order by id loop
  select * into e from public.estimates where id=r.id for update;
  if not found or e.estimate_number is distinct from r.number or e.brand is distinct from 'PEC'
    or e.sent_at is null or r.day < (e.created_at at time zone 'America/Phoenix')::date
    or r.day > (e.sent_at at time zone 'America/Phoenix')::date then raise exception 'Reviewed proposal changed: %',r.id; end if;
  select first_sent_on into prior from public.pec_estimate_first_send_confirmations where estimate_id=r.id;
  if found then
   if prior is distinct from r.day then raise exception 'Conflicting confirmation: %',r.id; end if;
   continue;
  end if;
  insert into public.pec_estimate_first_send_confirmations(estimate_id,brand,first_sent_on,confirmed_by,evidence_ref)
  values(r.id,'PEC',r.day,'Dylan Nordby',${quote(KEY)});
  insert into public.audit_log(action,entity_type,entity_id,before_json,after_json)
  values('historical_first_send_confirmed','estimates',r.id,to_jsonb(e),jsonb_build_object('reconciliation_key',${quote(KEY)},'first_sent_on',r.day,'confirmed_by','Dylan Nordby','evidence_source','Explicit owner confirmation in Codex on 2026-09-22','estimate_number',r.number));
 end loop;
end;
$repair$;
select estimate_id,first_sent_on,confirmed_by from public.pec_estimate_first_send_confirmations where evidence_ref=${quote(KEY)};
commit;`;
}
module.exports={buildSql,KEY};
if(require.main===module){const args=process.argv.slice(2),file=args.find(x=>!x.startsWith('--'));if(!file)throw Error('Private reviewed JSON required; default is dry-run');process.stdout.write(buildSql(JSON.parse(fs.readFileSync(file,'utf8')),args.includes('--apply'))+'\n');}
