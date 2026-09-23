'use strict';
// Isolated PostgreSQL rehearsal; no production connection or network access.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db=new PGlite();
let checks=0;
const check=(value,label)=>{assert.ok(value,label); checks++; console.log('ok',label);};
const scalar=async sql=>(await db.query(sql)).rows[0];
async function rejects(sql,pattern,label){ await assert.rejects(db.exec(sql),pattern);checks++;console.log('ok',label);}
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',J='33333333-3333-4333-8333-333333333333',P='44444444-4444-4444-8444-444444444444';
(async()=>{
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth;create schema topcoat_security_private;
create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
create function auth.uid() returns uuid language sql as $$select nullif(auth.jwt()->>'sub','')::uuid$$;
create function public.is_admin_staff() returns boolean language sql as $$select coalesce(auth.jwt()->>'staff','')='true'$$;
create function public.is_admin_role() returns boolean language sql as $$select coalesce(auth.jwt()->>'admin','')='true'$$;
create table public.customers(id uuid primary key default gen_random_uuid(),token text,name text,email text,phone text,company text,archived_at timestamptz);
create table public.jobs(id uuid primary key default gen_random_uuid(),customer_id uuid references public.customers,type text,status text default 'signed',archived_at timestamptz,voided_at timestamptz,signed_date date,completed_date date,price numeric,status_manual_at timestamptz,invoice_due_date date,invoice_terms text,source text default 'native',address text,package text,scope text,sqft text,monthly_payment numeric,warranty text,dripjobs_url text,dripjobs_deal_id text,salesperson text,line_items jsonb);
create table public.pec_prod_jobs(id uuid primary key default gen_random_uuid(),crm_job_id uuid references public.jobs,customer_id uuid references public.customers,archived_at timestamptz,is_callback boolean default false,status text default 'unscheduled',completed_at timestamptz,install_date date,dripjobs_deal_id text,proposal_number text,customer_name text,address text,revenue numeric,sync_status text,sales_team text,notes text);
create table public.timeline_stages(id uuid primary key default gen_random_uuid(),job_id uuid references public.jobs,stage_name text,status text,completed_at timestamptz,sort_order integer);
create table public.pec_prod_job_schedule_days(job_id uuid,scheduled_date date);
create table public.pec_change_order_signatures(id uuid primary key default gen_random_uuid(),job_id uuid references public.jobs,amount numeric not null,status text default 'pending',signed_at timestamptz);
insert into customers(id,name,company) values('${A}','Alpha','prescott-epoxy'),('${B}','Beta','prescott-epoxy');
-- Legacy gap exists before prospective safeguards.
insert into jobs(id,customer_id,type) values('${J}','${A}','epoxy');
`);
await db.exec(fs.readFileSync('supabase/migrations/20260923163510_job_event_integrity.sql','utf8'));
check(true,'migration compiles in isolated PostgreSQL');
await rejects(`insert into jobs(customer_id,type) values('${A}','epoxy')`,/Date accepted/,'new booked job requires accepted date');
await db.exec(`update jobs set scope='legacy unrelated edit allowed' where id='${J}'`);
check((await scalar(`select scope from jobs where id='${J}'`)).scope.includes('allowed'),'legacy unrelated edits preserved');
await rejects(`update jobs set status='completed',completed_date='2026-01-01' where id='${J}'`,/pec_complete_job/,'raw CRM completion refused');
await db.exec(`insert into pec_prod_jobs(id,crm_job_id,customer_id) values('${P}','${J}','${A}')`);
await rejects(`update pec_prod_jobs set status='completed' where id='${P}'`,/pec_complete_job/,'raw production completion refused');
await rejects(`select pec_complete_job('${J}','${P}','2026-01-10','request-complete-1',null,'crew confirmation')`,/staff access/,'nonstaff completion refused');
await db.exec(`set request.jwt.claims='{"role":"authenticated","staff":"true","admin":"true","sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'`);
await db.exec(`select pec_complete_job('${J}','${P}','2026-01-10','request-complete-1',null,'crew confirmation')`);
check((await scalar(`select status,completed_date::text from jobs where id='${J}'`)).completed_date==='2026-01-10','CRM completion date stored');
check((await scalar(`select status,completed_date::text,completed_at from pec_prod_jobs where id='${P}'`)).completed_at===null,'date-only completion does not fabricate time');
check((await scalar(`select status from pec_prod_jobs where id='${P}'`)).status==='completed','paired production committed');
await db.exec(`select pec_complete_job('${J}','${P}','2026-01-10','request-complete-1',null,'crew confirmation')`);
check(Number((await scalar(`select count(*) as n from pec_job_business_events`)).n)===1,'retry creates one immutable event');
const beforeRepeat=(await scalar(`select status_manual_at::text from jobs where id='${J}'`)).status_manual_at;
check((await scalar(`select pec_complete_job('${J}','${P}','2026-01-10','request-complete-fresh-key',null,'crew reconfirms') as result`)).result.already===true,'fresh form key for same completion returns already true');
check((await scalar(`select status_manual_at::text from jobs where id='${J}'`)).status_manual_at===beforeRepeat,'different-key repeat does not write CRM again');
check(Number((await scalar(`select count(*) as n from pec_job_business_events`)).n)===1,'different-key repeat preserves one event');

await rejects(`select pec_complete_job('${J}','${P}','2026-01-11','request-complete-1',null,'changed')`,/conflicts/,'same key different date rejected');
await rejects(`select pec_complete_job('${J}','${P}','2026-01-11','request-complete-2',null,'changed')`,/amendment/,'new key cannot rewrite original date');
await db.exec(`select pec_amend_job_completion('${J}','2026-01-11','request-amend-1','Reviewed source schedule correction')`);
check((await scalar(`select completed_date::text from jobs where id='${J}'`)).completed_date==='2026-01-11','admin amendment updates CRM date');
check(Number((await scalar(`select count(*) as n from pec_job_business_events where supersedes_event_id is not null`)).n)===1,'amendment preserves original evidence');
const afterAmend=(await scalar(`select pec_complete_job('${J}','${P}','2026-01-11','request-after-amendment',null,'crew reconfirms') as result`)).result;
check(afterAmend.already===true && afterAmend.completed_date==='2026-01-11','fresh key after amendment reuses amended event and date');
check(Number((await scalar(`select count(*) as n from pec_job_business_events where job_id='${J}'`)).n)===2,'amended replay creates no third event');
const wrongProd='aaaaaaaa-1111-4111-8111-111111111111';
await db.exec(`insert into pec_prod_jobs(id,crm_job_id,customer_id) values('${wrongProd}','${J}','${A}')`);
await rejects(`select pec_complete_job('${J}','${wrongProd}','2026-01-11','request-conflicting-link',null,'crew reconfirms')`,/link conflicts/,'fresh key cannot switch recorded production pairing');
await rejects(`select pec_amend_job_completion('${J}','2026-01-12','request-ambiguous-amend','Owner verified date')`,/Multiple production/,'amendment refuses ambiguous production pair');
await db.exec(`update pec_prod_jobs set archived_at=now() where id='${wrongProd}'`);
await db.exec(`insert into pec_prod_jobs(id,crm_job_id,customer_id) values('aaaaaaaa-2222-4222-8222-222222222222','${J}','${B}');update pec_prod_jobs set archived_at=now() where id='${P}'`);
await rejects(`select pec_amend_job_completion('${J}','2026-01-12','request-wrong-customer-amend','Owner verified date')`,/same CRM customer/,'amendment rejects wrong-customer production link');
await db.exec(`update pec_prod_jobs set archived_at=now() where id='aaaaaaaa-2222-4222-8222-222222222222';update pec_prod_jobs set archived_at=null where id='${P}'`);

const crmonly='55555555-5555-4555-8555-555555555555';
await db.exec(`insert into jobs(id,customer_id,type,signed_date,price) values('${crmonly}','${A}','epoxy','2026-01-01',1000)`);
await db.exec(`select pec_complete_job('${crmonly}',null,'2026-01-12','request-crm-only',null,'crew confirmation')`);
check((await scalar(`select status from jobs where id='${crmonly}'`)).status==='completed','native CRM-only completion supported');
await rejects(`select pec_complete_job('${crmonly}','${P}','2026-01-12','request-wrong-pair',null,'crew confirmation')`,/explicitly linked/,'wrong pair rejected');
await db.exec(`update jobs set price=1100 where id='${crmonly}'`);
check(Number((await scalar(`select amount_snapshot from pec_job_business_events where job_id='${crmonly}' and event_type='booked'`)).amount_snapshot)===1000,'original booked amount immutable');
check(Number((await scalar(`select sum(amount_snapshot) as n from pec_job_business_events where job_id='${crmonly}' and event_type like '%adjusted'`)).n)===200,'booked and completed corrections captured as separate deltas');
await rejects(`update jobs set signed_date='2026-01-02' where id='${crmonly}'`,/locked/,'original booking date immutable');
await db.exec(`select pec_amend_job_completion('${crmonly}','2026-01-13','request-amend-after-price','Reviewed exact completion schedule');`);
check(Number((await scalar(`select amount_snapshot from pec_job_business_events where job_id='${crmonly}' and event_type='completion_amended'`)).amount_snapshot)===1000,'date amendment preserves base amount before corrections');
await db.exec(`update jobs set voided_at=now() where id='${crmonly}'`);
check(Number((await scalar(`select sum(amount_snapshot) as n from pec_job_business_events where job_id='${crmonly}' and event_type='booked_adjusted'`)).n)===-1000,'void reverses adjusted contract without erasing original booking');
await db.exec(`update jobs set voided_at=null where id='${crmonly}'`);
check(Number((await scalar(`select sum(amount_snapshot) as n from pec_job_business_events where job_id='${crmonly}' and event_type='booked_adjusted'`)).n)===100,'unvoid restores only current value once');
await rejects(`insert into jobs(customer_id,type,signed_date,reporting_state) values('${A}','epoxy','2026-01-01','historical_pending')`,/reviewed service import/,'staff cannot bypass verified booking with historical flag');

// Inject a production write failure after CRM/event changes: PostgreSQL rolls back all.
const atomic='66666666-6666-4666-8666-666666666666',prod='77777777-7777-4777-8777-777777777777';
await db.exec(`insert into jobs(id,customer_id,type,signed_date,price) values('${atomic}','${A}','epoxy','2026-01-01',100);insert into pec_prod_jobs(id,crm_job_id,customer_id) values('${prod}','${atomic}','${A}');create function public.fail_completion_test() returns trigger language plpgsql as $$begin if new.status='completed' then raise exception 'Injected production failure';end if;return new;end$$;create trigger fail_test before update on pec_prod_jobs for each row execute function fail_completion_test();`);
await rejects(`select pec_complete_job('${atomic}','${prod}','2026-01-12','request-atomic-fail',null,'crew confirmation')`,/Injected production failure/,'injected second write failure rejected');
check((await scalar(`select completed_date from jobs where id='${atomic}'`)).completed_date===null,'failed production write rolls CRM completion back');
check(Number((await scalar(`select count(*) as n from pec_job_business_events where request_key='request-atomic-fail'`)).n)===0,'failed transaction rolls event back');
await db.exec(`drop trigger fail_test on pec_prod_jobs;set request.jwt.claims='{"role":"service_role"}'`);
await rejects(`select pec_complete_job('${atomic}','${prod}',null,'request-external-undated',null,'source event')`,/original business date/,'external completion cannot default to receipt day');
const payload=JSON.stringify({deal_id:'external-test-1',customer_name:'External',customer_email:'external@example.test',signed_date:'2026-01-02',price:500,company:'prescott-epoxy'});
await db.exec(`select pec_accept_external_job('${payload}'::jsonb);select pec_accept_external_job('${payload}'::jsonb)`);
check(Number((await scalar(`select count(*) as n from jobs where dripjobs_deal_id='external-test-1'`)).n)===1,'external acceptance replay creates one CRM job');
check(Number((await scalar(`select count(*) as n from pec_prod_jobs where dripjobs_deal_id='external-test-1'`)).n)===1,'external acceptance replay creates one production job');
check(Number((await scalar(`select count(*) as n from timeline_stages where job_id=(select id from jobs where dripjobs_deal_id='external-test-1')`)).n)===7,'external acceptance timeline inserted once');
await rejects(`select pec_accept_external_job('${payload.replace('2026-01-02','2026-01-03')}'::jsonb)`,/conflicts/,'external acceptance conflict rejected');
await rejects(`select pec_accept_external_job('${payload.replace('500','501')}'::jsonb)`,/conflicts/,'external acceptance different original amount rejected');
await rejects(`select pec_complete_job('${atomic}','${prod}','-infinity','request-invalid-infinity',null,'source event')`,/future/,'nonfinite completion date rejected');
await rejects(`select pec_amend_job_completion('${J}','-infinity','request-invalid-amend','Reviewed source evidence')`,/required/,'nonfinite amendment date rejected');
await rejects(`insert into jobs(customer_id,type,signed_date,price) values('${A}','epoxy','2026-01-01','NaN')`,/finite/,'nonfinite booking amount rejected');


// CO UI increases invoice price before minting/signing the proposal. Verify
// that interim, edit and cancel states never manufacture booked dollars.
const cojob='88888888-8888-4888-8888-888888888888',co='99999999-9999-4999-8999-999999999999';
await db.exec(`insert into jobs(id,customer_id,type,signed_date,price,line_items) values('${cojob}','${A}','epoxy','2026-01-01',1000,'[]');update jobs set price=1100,line_items='[{"name":"Extra scope","price":100,"is_change_order":true}]' where id='${cojob}';insert into pec_change_order_signatures(id,job_id,amount) values('${co}','${cojob}',100)`);
check(Number((await scalar(`select count(*) as n from pec_job_business_events where job_id='${cojob}' and event_type='booked_adjusted'`)).n)===0,'pending CO price increase does not book revenue');
await db.exec(`update pec_change_order_signatures set amount=150 where id='${co}';update jobs set price=1150,line_items='[{"name":"Extra scope","price":150,"is_change_order":true}]' where id='${cojob}'`);
check(Number((await scalar(`select count(*) as n from pec_job_business_events where job_id='${cojob}' and event_type='booked_adjusted'`)).n)===0,'editing pending CO does not book revenue');
await db.exec(`delete from pec_change_order_signatures where id='${co}';update jobs set price=1000,line_items='[]' where id='${cojob}'`);
check(Number((await scalar(`select count(*) as n from pec_job_business_events where job_id='${cojob}' and event_type='booked_adjusted'`)).n)===0,'cancelling pending CO does not book or reverse revenue');
await db.exec(`update jobs set price=1150,line_items='[{"name":"Extra scope","price":150,"is_change_order":true}]' where id='${cojob}';insert into pec_change_order_signatures(id,job_id,amount) values('${co}','${cojob}',150);select pec_complete_job('${cojob}',null,'2026-01-10','co-job-completed',null,'Crew confirmed completion')`);
check(Number((await scalar(`select amount_snapshot from pec_job_business_events where job_id='${cojob}' and event_type='completed'`)).amount_snapshot)===1000,'completion excludes unsigned CO value');
await db.exec(`update pec_change_order_signatures set status='signed',signed_at='2026-01-11T06:59:59Z' where id='${co}';update pec_change_order_signatures set status='signed',signed_at='2026-01-11T06:59:59Z' where id='${co}'`);
check(Number((await scalar(`select count(*) as n from pec_job_business_events where job_id='${cojob}' and source='signed_change_order'`)).n)===2,'one signed CO adds booked and completed delta exactly once');
check((await scalar(`select min(business_date)::text as d from pec_job_business_events where job_id='${cojob}' and source='signed_change_order'`)).d==='2026-01-10','signed CO uses original approval instant in Arizona');
check(Number((await scalar(`select sum(amount_snapshot) as n from pec_job_business_events where job_id='${cojob}' and event_type in ('booked','booked_adjusted')`)).n)===1150,'signed CO total has no duplicate draft increment');
await rejects(`update pec_change_order_signatures set amount=200 where id='${co}'`,/immutable/,'signed CO amount immutable');
await rejects(`delete from pec_change_order_signatures where id='${co}'`,/immutable/,'signed CO evidence cannot be deleted');
await db.exec(`update jobs set voided_at=now() where id='${cojob}'`);
check(Number((await scalar(`select sum(amount_snapshot) as n from pec_job_business_events where job_id='${cojob}' and event_type in ('booked','booked_adjusted')`)).n)===0,'void reverses approved CO plus base only');
await db.exec(`set request.jwt.claims='{}';set role anon`);
await rejects(`select pec_complete_job('${J}',null,'2026-01-10','anonymous-attempt',null,'evidence')`,/permission denied/,'anon has no RPC execute');
await rejects(`select * from pec_job_business_events`,/permission denied/,'anon cannot read evidence');
await db.exec(`reset role;set role service_role`);
await rejects(`update pec_job_business_events set amount_snapshot=0`,/permission denied/,'service cannot mutate immutable evidence');
await db.exec(`reset role`);
console.log(`\n${checks} isolated PostgreSQL checks passed. Multi-session lock contention not simulated by PGlite.`);
await db.close();
})().catch(async e=>{console.error(e);await db.close();process.exitCode=1;});
