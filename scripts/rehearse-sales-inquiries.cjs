'use strict';

// Isolated PostgreSQL rehearsal; no network or production records.
// PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite node scripts/rehearse-sales-truth.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260922162337_sales_pipeline_and_first_send_truth.sql'), 'utf8');
const inquiryMigration=fs.readFileSync(path.join(root,'supabase/migrations/20260923163602_sales_inquiry_identity.sql'),'utf8');
const db = new PGlite();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let checks = 0;
const pass = label => { checks++; console.log('PASS ' + label); };
async function role(name, fn, staff = name === 'authenticated') {
  await db.exec(`set role ${name}; set app.staff = '${staff ? 'yes' : 'no'}'`);
  try { return await fn(); } finally { await db.exec('reset role; reset app.staff'); }
}
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await rows(sql, params))[0];
const staff = fn => role('authenticated', fn);
const service = fn => role('service_role', fn);
const rpc = (customer, brand = 'PEC', stage = 'new', at = null) =>
  one('select public.ensure_sales_lead($1,$2,$3,$4) as id', [customer, brand, stage, at]).then(x => x.id);
async function customer(n, extra = {}) {
  await db.query(`insert into public.customers(id,name,company,email,phone,first_name,last_name,lead_source,created_at)
    values($1,$2,$3,$4,$5,'Synthetic','Customer','Phone Call',$6)`,
  [id(n), 'Synthetic Customer '+n, extra.company || 'prescott-epoxy', extra.email || `test${n}@example.invalid`, extra.phone || '9285550100', extra.created_at || '2026-09-01T16:00:00Z']);
  return id(n);
}
async function estimate(n, customerId = null, extra = {}) {
  await db.query(`insert into public.estimates(id,customer_id,lead_id,brand,created_at,public_token)
    values($1,$2,$3,$4,$5,$6)`, [id(n), customerId, extra.lead || null, extra.brand || 'PEC', extra.created_at || '2026-09-20T16:00:00Z', extra.token || `token-${n}`]);
  return id(n);
}
async function appointment(n, customerId, extra = {}) {
  return one(`insert into public.pec_appointments(id,customer_id,lead_id,source,appt_type,status,created_at)
    values($1,$2,$3,$4,$5,$6,$7) returning *`,
  [id(n),customerId,extra.lead || null,extra.source || 'topcoat',extra.type || 'on_site_estimate',extra.status || 'scheduled',extra.created_at || '2026-09-19T16:00:00Z']);
}
async function attempt(n, estimateId, channel = 'email', brand = 'PEC') {
  return one(`insert into public.pec_estimate_send_attempts(id,estimate_id,brand,channel,recipient,started_at)
    values($1,$2,$3,$4,'synthetic@example.invalid','2026-09-21T16:00:00Z') returning *`,[id(n),estimateId,brand,channel]);
}
async function complete(n, status = 'sent', at = '2026-09-21T16:00:05Z') {
  return db.query(`update public.pec_estimate_send_attempts set status=$2,provider_id=$3,completed_at=$4 where id=$1`,
    [id(n),status,status === 'sent' ? 'provider-'+n : null,at]);
}

(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select case when current_setting('app.staff',true)='yes' then '${id(999)}'::uuid end $$;
    create function public.is_admin_staff() returns boolean language sql stable as $$
      select coalesce(current_setting('app.staff',true)='yes',false) $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create table public.customers(id uuid primary key default gen_random_uuid(), token text, name text not null, company text not null,
      first_name text,last_name text,company_name text,email text,phone text,lead_source text,
      billing_address_line1 text,billing_city text,billing_state text,billing_zip text,
      created_at timestamptz not null default now(),archived_at timestamptz,sms_opt_out boolean not null default false);
    create table public.leads(id uuid primary key default gen_random_uuid(),customer_id uuid references public.customers,
      brand text not null default 'PEC',source text,first_name text,last_name text,full_name text,business_name text,
      email text,phone text,address text,city text,state text,zip text,
      stage text not null default 'new' check(stage in ('new','contacted','estimate_scheduled','estimate_sent','presented','accepted','lost')),
      contacted_at timestamptz,estimate_scheduled_at timestamptz,estimate_sent_at timestamptz,created_by uuid,created_at timestamptz not null default now(),
      deleted_at timestamptz,archived_at timestamptz,sms_consent boolean not null default false,
      source_ref text,campaign text,ad_meta jsonb,notes text,opted_out boolean not null default false,sms_consent_source text,sms_consent_at timestamptz);
    create table public.lead_events(id uuid primary key default gen_random_uuid(),lead_id uuid not null references public.leads,
      event_type text not null,from_stage text,to_stage text,payload jsonb,actor_user_id uuid,created_at timestamptz not null default now());
    create table public.pec_appointments(id uuid primary key,customer_id uuid references public.customers,lead_id uuid,
      source text not null default 'topcoat',appt_type text not null default 'on_site_estimate',
      status text not null default 'scheduled',created_at timestamptz not null default now(),start_at timestamptz not null default now());
    create table public.estimates(id uuid primary key,customer_id uuid references public.customers,lead_id uuid references public.leads,
      brand text not null default 'PEC',status text not null default 'draft',sent_at timestamptz,estimate_number integer,created_at timestamptz not null default now(),public_token text,deleted_at timestamptz);
    create table public.pec_email_log(id uuid primary key,brand text,sent_at timestamptz,resend_id text,body_html text,status text,template_key text default 'estimate');
    create table public.pec_sms_log(id uuid primary key,brand text,created_at timestamptz,quo_message_id text,body text,status text,direction text,kind text);
    grant select,insert,update,delete on all tables in schema public to authenticated,service_role;
    do $$ declare t text; begin
      foreach t in array array['customers','leads','lead_events','pec_appointments','estimates'] loop
        execute format('alter table public.%I enable row level security',t);
        execute format('create policy staff on public.%I for all to authenticated using(public.is_admin_staff()) with check(public.is_admin_staff())',t);
      end loop;
    end $$;
  `);
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/2026-08-19_prompt84_estimate_status_guard.sql'),'utf8'));
  await db.exec(migration);
  await db.exec(`create table public.audit_log(id uuid default gen_random_uuid(),auth_user_id uuid,action text,entity_type text,entity_id uuid,before_json jsonb,after_json jsonb); grant select,insert on public.audit_log to authenticated,service_role;`);
  // The standalone rehearsal needs only the fields used by the generic audit trigger.
  // The combined rehearsal replaces this fixture with the full production schema.
  await db.exec(`create table public.pec_prod_jobs(id uuid primary key default gen_random_uuid(),reporting_excluded_at timestamptz,reporting_exclusion_reason text); grant select,insert,update on public.pec_prod_jobs to authenticated,service_role;`);
  await db.exec(inquiryMigration);
  pass('inquiry migration installs after current sales truth');
  const a=await customer(1), b=await customer(2);
  const inquiry=(customer,key,mode='new',lead=null,date=null,origin='staff_live',evidence=null,details={})=>one("select public.record_sales_inquiry($1,$2,'PEC',$3,$4,$5,$6,$7,'new',$8::jsonb) id",[customer,key,mode,lead,date,origin,evidence,JSON.stringify(details)]).then(r=>r.id);
  const first=await staff(()=>inquiry(a,'one'));
  assert.equal(await staff(()=>inquiry(a,'one')),first);
  await db.query("update public.leads set stage='accepted' where id=$1",[first]);
  assert.equal(await staff(()=>inquiry(a,'one')),first);
  const second=await staff(()=>inquiry(a,'two'));
  assert.notEqual(first,second);
  assert.equal(await staff(()=>inquiry(a,'follow','followup',first)),first);
  assert.equal(await staff(()=>inquiry(a,'book','auto')),second);
  await db.query("update public.leads set stage='accepted' where id=$1",[second]);
  assert.equal(await staff(()=>inquiry(a,'book','auto')),second);
  pass('distinct repeat work, terminal follow-up and late retries retain correct identity');
  await staff(()=>inquiry(a,'three')); await staff(()=>inquiry(a,'four'));
  await assert.rejects(()=>staff(()=>inquiry(a,'ambiguous','auto')),/several open/);
  await assert.rejects(()=>staff(()=>inquiry(b,'one')),/conflicts/);
  await assert.rejects(()=>staff(()=>inquiry(b,'wrong','followup',first)),/different customer/);
  pass('multiple requests and cross-customer keys fail closed');
  await assert.rejects(()=>role('anon',()=>inquiry(a,'anon')),/permission denied/);
  await assert.rejects(()=>role('authenticated',()=>inquiry(a,'nonstaff'),false),/Staff session/);
  await assert.rejects(()=>staff(()=>inquiry(b,'no-date','new',null,null,'source_event')),/Original inquiry date/);
  await assert.rejects(()=>staff(()=>inquiry(b,'no-evidence','new',null,'2026-08-01','source_event')),/evidence/);
  const historical=await service(()=>inquiry(b,'dated','new',null,'2026-08-01','historical_review','original message ref'));
  assert.equal((await one('select inquiry_date::text d from public.leads where id=$1',[historical])).d,'2026-08-01');
  await assert.rejects(()=>staff(()=>db.query("update public.leads set inquiry_date='2026-08-02',inquiry_evidence=null where id=$1",[historical])),/evidence/);
  pass('permissions and original-date provenance enforced');
  await assert.rejects(()=>staff(()=>db.query("update public.leads set duplicate_of=id,inquiry_evidence='review' where id=$1",[historical])),/canonical/);
  await assert.rejects(()=>staff(()=>db.query('update public.customers set reporting_excluded_at=now() where id=$1',[a])),/reason/);
  await staff(()=>db.query("update public.customers set reporting_excluded_at=now(),reporting_exclusion_reason='Owner reviewed synthetic exclusion' where id=$1",[a]));
  assert.equal((await one("select auth_user_id from public.audit_log where action='sales_reporting_classification' limit 1")).auth_user_id,id(999));
  await assert.rejects(()=>staff(()=>db.query("update public.leads set intake_request_key='changed' where id=$1",[first])),/identity cannot/);
  pass('duplicate and reporting exclusion guards preserve review evidence and actor');
  const profile={name:'Synthetic Separate',phone:'9285559999',email:'separate@example.invalid',company:'prescott-epoxy'};
  const resolve=()=>one('select public.resolve_sales_customer($1::jsonb) id',[JSON.stringify(profile)]).then(r=>r.id);
  assert.equal(await service(resolve),await service(resolve));
  pass('customer identity resolution is repeatable without rewriting profile');
  const ownProfile={...profile,phone:'9285559998',email:'own@example.invalid',_new_customer_id:id(601)};
  assert.equal((await staff(()=>one('select public.resolve_sales_customer($1::jsonb) id',[JSON.stringify(ownProfile)]))).id,id(601));
  assert.equal((await staff(()=>one('select public.resolve_sales_customer($1::jsonb) id',[JSON.stringify({...ownProfile,name:'Do not overwrite',_new_customer_id:id(602)})]))).id,id(601));
  assert.equal((await one('select name from public.customers where id=$1',[id(601)])).name,profile.name);
  pass('stable proposed customer UUID identifies only the inserted profile; matches stay untouched');
  const live=await customer(610), liveLead=await staff(()=>inquiry(live,'guard-live'));
  await staff(()=>appointment(611,live,{lead:liveLead}));
  await staff(()=>estimate(612,live,{lead:liveLead}));
  await db.query('update public.customers set archived_at=now() where id=$1',[live]);
  await assert.rejects(()=>staff(()=>rpc(live)),/live customer/);
  await assert.rejects(()=>staff(()=>appointment(613,live,{lead:liveLead})),/live customer/);
  await assert.rejects(()=>staff(()=>estimate(614,live,{lead:liveLead})),/live customer/);
  await staff(()=>db.query("update public.pec_appointments set status='canceled',customer_id=customer_id where id=$1",[id(611)]));
  await staff(()=>db.query("update public.estimates set brand=brand where id=$1",[id(612)]));
  await assert.rejects(()=>staff(()=>rpc(a)),/live customer/);
  await db.query('update public.customers set archived_at=null where id=$1',[live]);
  await db.query('update public.leads set archived_at=now() where id=$1',[liveLead]);
  await assert.rejects(()=>staff(()=>estimate(615,live,{lead:liveLead})),/does not belong/);
  await staff(()=>db.query('update public.estimates set lead_id=lead_id where id=$1',[id(612)]));
  pass('archived or excluded contacts cannot gain new links while unchanged historical links remain editable');
  const detailCustomer=await customer(620);
  const detailInput={source:'Facebook',source_ref:'native-123',notes:'Original request',full_name:'Original Customer',sms_consent:true,sms_consent_source:'web checkbox',sms_consent_at:'2026-09-01T16:00:00Z',stage:'accepted',customer_id:id(999)};
  const detailLead=await staff(()=>inquiry(detailCustomer,'atomic-details','new',null,'2026-09-01','source_event','form timestamp',detailInput));
  const detailRow=await one('select * from public.leads where id=$1',[detailLead]);
  assert.equal(detailRow.source_ref,'native-123'); assert.equal(detailRow.sms_consent,true); assert.equal(detailRow.stage,'new'); assert.equal(detailRow.customer_id,detailCustomer);
  const createdEvent=await one("select payload from public.lead_events where lead_id=$1 and event_type='created'",[detailLead]);
  assert.equal(createdEvent.payload.details.notes,'Original request'); assert.equal(createdEvent.payload.details.stage,undefined);
  await db.query("update public.leads set notes='Staff corrected',stage='accepted',sms_consent=false,opted_out=true where id=$1",[detailLead]);
  const beforeRetry=await one('select * from public.leads where id=$1',[detailLead]);
  assert.equal(await staff(()=>inquiry(detailCustomer,'atomic-details','new',null,'2026-09-01','source_event','replayed',{...detailInput,notes:'Overwrite'})),detailLead);
  assert.deepEqual(await one('select * from public.leads where id=$1',[detailLead]),beforeRetry);
  assert.equal((await rows("select id from public.lead_events where lead_id=$1 and event_type='created'",[detailLead])).length,1);
  await assert.rejects(()=>staff(()=>inquiry(detailCustomer,'atomic-details','new',null,'2026-09-02','source_event','contradiction')),/conflicts/);
  assert.equal(await staff(()=>inquiry(detailCustomer,'atomic-details')),detailLead);
  pass('atomic intake metadata is whitelisted, recorded once and never overwritten by retry; contradictory dates fail');
  const optOutCustomer=await customer(621); await db.query('update public.customers set sms_opt_out=true where id=$1',[optOutCustomer]);
  const optOutLead=await staff(()=>inquiry(optOutCustomer,'opt-out','new',null,null,'staff_live',null,detailInput));
  const optOut=await one('select sms_consent,opted_out,sms_consent_at from public.leads where id=$1',[optOutLead]);
  assert.equal(optOut.sms_consent,false); assert.equal(optOut.opted_out,true); assert.equal(optOut.sms_consent_at,null);
  await assert.rejects(()=>staff(()=>inquiry(detailCustomer,'bad-details','new',null,null,'staff_live',null,{sms_consent:true,sms_consent_at:'invalid-date'})),/timestamp/);
  assert.equal((await rows("select id from public.leads where intake_request_key='bad-details'")).length,0);
  await staff(()=>inquiry(detailCustomer,'bad-details','new',null,null,'staff_live',null,{notes:'Corrected retry'}));
  assert.equal((await rows("select id from public.leads where intake_request_key='bad-details'")).length,1);
  pass('customer opt-out wins over form consent and invalid metadata rolls back the entire inquiry');
  await db.query('insert into public.pec_prod_jobs(id) values($1)',[id(630)]);
  await assert.rejects(()=>staff(()=>db.query('update public.pec_prod_jobs set reporting_excluded_at=now() where id=$1',[id(630)])),/reason/);
  await staff(()=>db.query("update public.pec_prod_jobs set reporting_excluded_at=now(),reporting_exclusion_reason='Owner reviewed non-job record' where id=$1",[id(630)]));
  assert.equal((await one("select auth_user_id from public.audit_log where entity_type='pec_prod_jobs' and entity_id=$1",[id(630)])).auth_user_id,id(999));
  pass('production reporting exclusions require a reason and record the reviewing actor');
  console.log(checks+' inquiry SQL checks passed (single-session PGlite; concurrent locking still requires integration validation)');
  await db.close();
})().catch(async e=>{console.error(e);await db.close();process.exitCode=1;});
