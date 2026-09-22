'use strict';

// Isolated PostgreSQL rehearsal; no network or production records.
// PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite node scripts/rehearse-sales-truth.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260922162337_sales_pipeline_and_first_send_truth.sql'), 'utf8');
const dryRun = fs.readFileSync(path.join(root, 'docs/sales/first-send-evidence-dry-run.sql'), 'utf8');
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
    create table public.customers(id uuid primary key, name text not null, company text not null,
      first_name text,last_name text,company_name text,email text,phone text,lead_source text,
      billing_address_line1 text,billing_city text,billing_state text,billing_zip text,
      created_at timestamptz not null default now(),archived_at timestamptz);
    create table public.leads(id uuid primary key default gen_random_uuid(),customer_id uuid references public.customers,
      brand text not null default 'PEC',source text,first_name text,last_name text,full_name text,business_name text,
      email text,phone text,address text,city text,state text,zip text,
      stage text not null default 'new' check(stage in ('new','contacted','estimate_scheduled','estimate_sent','presented','accepted','lost')),
      contacted_at timestamptz,estimate_scheduled_at timestamptz,estimate_sent_at timestamptz,created_by uuid,created_at timestamptz not null default now(),
      deleted_at timestamptz,archived_at timestamptz,sms_consent boolean not null default false);
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
  await db.exec(migration);
  pass('exact migration installs and replays on isolated PostgreSQL');
  const perms = await one(`select prosecdef,proconfig,
    has_function_privilege('anon',oid,'EXECUTE') anon,
    has_function_privilege('authenticated',oid,'EXECUTE') staff,
    has_function_privilege('service_role',oid,'EXECUTE') service
    from pg_proc where oid='public.ensure_sales_lead(uuid,text,text,timestamptz)'::regprocedure`);
  assert.deepEqual(perms,{prosecdef:false,proconfig:['search_path=""'],anon:false,staff:true,service:true});
  pass('RPC retains invoker security, empty search_path and staff/service-only execution');

  const a = await customer(1);
  const b = await customer(2);
  const ftp = await customer(3,{company:'finishing-touch'});
  await assert.rejects(()=>role('anon',()=>rpc(a)),/permission denied/);
  await assert.rejects(()=>role('authenticated',()=>rpc(a),false),/Staff session required/);
  assert.equal((await one('select count(*)::int n from public.leads')).n,0);
  pass('anonymous and nonstaff intake cannot mutate leads');
  const lead = await staff(()=>rpc(a,'PEC','new','2026-09-13T16:00:00Z'));
  const initial = await one('select * from public.leads where id=$1',[lead]);
  assert.equal(initial.source,'Phone Call'); assert.equal(initial.sms_consent,false);
  assert.equal(initial.created_at.toISOString(),'2026-09-13T16:00:00.000Z');
  const duplicateIds = await staff(()=>Promise.all(Array.from({length:8},()=>rpc(a))));
  assert.ok(duplicateIds.every(value=>value === lead));
  assert.equal((await one('select count(*)::int n from public.leads where customer_id=$1',[a])).n,1);
  assert.equal((await one('select count(*)::int n from public.lead_events where lead_id=$1',[lead])).n,1);
  pass('repeat intake returns one canonical lead and one creation event without changing occurrence');
  await assert.rejects(()=>staff(()=>rpc(a,'FTP')),/does not belong/);
  await assert.rejects(()=>staff(()=>rpc(a,'PEC','accepted')),/Invalid sales/);
  await assert.rejects(()=>staff(()=>rpc(a,'PEC','new','2999-01-01')),/future/);
  await assert.rejects(()=>staff(()=>rpc(a,'PEC','new','infinity')),/future/);
  pass('brand, stage and invalid/future occurrence are rejected');
  await staff(()=>rpc(a,'PEC','estimate_scheduled','2026-09-21T16:00:00Z'));
  assert.equal((await one('select stage from public.leads where id=$1',[lead])).stage,'estimate_scheduled');
  assert.equal((await one('select count(*)::int n from public.lead_events where lead_id=$1',[lead])).n,2);
  pass('scheduled intake atomically advances initial stage with one event');
  for (const stage of ['estimate_sent','presented','accepted','lost']) {
    await db.query('update public.leads set stage=$2 where id=$1',[lead,stage]);
    await staff(()=>rpc(a,'PEC','estimate_scheduled'));
    assert.equal((await one('select stage from public.leads where id=$1',[lead])).stage,stage);
  }
  pass('later and terminal stages never regress');
  await db.query("update public.leads set stage='new',archived_at=now() where id=$1",[lead]);
  assert.equal(await staff(()=>rpc(a,'PEC','estimate_scheduled')),lead);
  assert.equal((await one('select stage from public.leads where id=$1',[lead])).stage,'new');
  pass('archived contact reuses original lead without reopening or advancing');

  const booked = await service(()=>appointment(100,b));
  const bookedLead = await one('select * from public.leads where id=$1',[booked.lead_id]);
  assert.equal(bookedLead.customer_id,b); assert.equal(bookedLead.stage,'estimate_scheduled');
  assert.equal(bookedLead.created_at.toISOString(),'2026-09-19T16:00:00.000Z');
  pass('native appointment creates and links scheduled lead in the same statement');
  const c = await customer(4);
  assert.equal((await service(()=>appointment(101,c,{source:'google'}))).lead_id,null);
  assert.equal((await one('select count(*)::int n from public.leads where customer_id=$1',[c])).n,0);
  const completed = await service(()=>appointment(102,c,{status:'completed'}));
  assert.equal((await one('select stage from public.leads where id=$1',[completed.lead_id])).stage,'new');
  pass('Google import skipped and completed appointment does not imply scheduled stage');
  const d = await customer(5);
  const e = await service(()=>estimate(200,d));
  const linked = await one('select lead_id,status from public.estimates where id=$1',[e]);
  assert.equal(linked.status,'draft');
  assert.equal((await one('select stage from public.leads where id=$1',[linked.lead_id])).stage,'new');
  pass('estimate customer automatically maps to pipeline without changing estimate status');
  await assert.rejects(()=>service(()=>estimate(201,d,{lead})),/different customer/);
  await assert.rejects(()=>service(()=>estimate(202,ftp,{lead:linked.lead_id,brand:'FTP'})),/sales brand/);
  await assert.rejects(()=>service(()=>estimate(205,null,{lead:linked.lead_id,brand:'FTP'})),/sales brand/);
  pass('explicit cross-customer and cross-brand links fail atomically');
  await db.query(`insert into public.leads(id,brand,email) values($1,'PEC',' TEST5@EXAMPLE.INVALID '),($2,'PEC','unmatched@example.invalid')`,[id(300),id(301)]);
  await service(()=>estimate(203,d,{lead:id(300)}));
  assert.equal((await one('select customer_id from public.leads where id=$1',[id(300)])).customer_id,d);
  await assert.rejects(()=>service(()=>estimate(204,d,{lead:id(301)})),/matching customer/);
  assert.equal((await one('select customer_id from public.leads where id=$1',[id(301)])).customer_id,null);
  pass('legacy null-customer lead links only with normalized exact contact evidence');
  await db.exec(`create function public.synthetic_booking(c uuid) returns uuid language plpgsql security definer set search_path='' as $$
    declare result uuid; begin insert into public.pec_appointments(id,customer_id) values(gen_random_uuid(),c) returning lead_id into result; return result; end $$;
    revoke all on function public.synthetic_booking(uuid) from public;
    grant execute on function public.synthetic_booking(uuid) to service_role;`);
  const definerLead = await service(()=>one('select public.synthetic_booking($1) as id',[ftp]));
  assert.equal((await one('select brand from public.leads where id=$1',[definerLead.id])).brand,'FTP');
  pass('existing definer booking write retains authorized service role through invoker trigger');

  await service(()=>attempt(400,e));
  assert.equal((await one('select count(*)::int n from public.pec_estimate_first_sends')).n,0);
  await assert.rejects(()=>service(()=>attempt(401,e)),/duplicate key/);
  await service(()=>attempt(402,e,'sms'));
  pass('pending send is visible but uncounted and duplicate channel is blocked');
  await service(()=>complete(402,'failed'));
  assert.equal((await one('select count(*)::int n from public.pec_estimate_first_sends')).n,0);
  await assert.rejects(()=>service(()=>db.query("update public.pec_estimate_send_attempts set status='sent',provider_id='x' where id=$1",[id(400)])),/completion_check/);
  await assert.rejects(()=>service(()=>db.query("update public.pec_estimate_send_attempts set status='sent',completed_at=now() where id=$1",[id(400)])),/completion_check/);
  pass('failed sends are uncounted and successful completion requires provider ID and timestamp');
  await db.exec('revoke insert on public.pec_estimate_first_sends from service_role');
  await assert.rejects(()=>service(()=>complete(400)),/permission denied/);
  assert.equal((await one('select status from public.pec_estimate_send_attempts where id=$1',[id(400)])).status,'pending');
  await db.exec('grant insert on public.pec_estimate_first_sends to service_role');
  pass('attempt completion rolls back if first-send insertion cannot commit');
  await service(()=>complete(400));
  const first = await one('select * from public.pec_estimate_first_sends where estimate_id=$1',[e]);
  assert.equal(first.first_sent_at.toISOString(),'2026-09-21T16:00:05.000Z');
  assert.equal(first.evidence_ref,'attempt:'+id(400));
  await service(()=>attempt(403,e)); await service(()=>complete(403,'sent','2026-09-22T16:00:05Z'));
  await service(()=>attempt(404,e,'sms')); await service(()=>complete(404));
  assert.deepEqual(await one('select * from public.pec_estimate_first_sends where estimate_id=$1',[e]),first);
  assert.equal((await one('select status from public.estimates where id=$1',[e])).status,'sent');
  assert.equal((await one('select stage from public.leads where id=$1',[linked.lead_id])).stage,'estimate_sent');
  assert.equal((await one("select count(*)::int n from public.lead_events where lead_id=$1 and event_type='estimate_sent'",[linked.lead_id])).n,1);
  pass('email/SMS resends count once; lifecycle advances server-side with one first-send event');
  await service(()=>attempt(407,e,'sms'));
  await service(()=>complete(407,'sent','2026-09-21T16:00:01Z'));
  const recovered = await one('select * from public.pec_estimate_first_sends where estimate_id=$1',[e]);
  assert.equal(recovered.first_sent_at.toISOString(),'2026-09-21T16:00:01.000Z');
  assert.equal(recovered.channel,'sms'); assert.equal(recovered.evidence_ref,'attempt:'+id(407));
  assert.equal((await one('select sent_at from public.estimates where id=$1',[e])).sent_at.toISOString(),'2026-09-22T16:00:05.000Z');
  assert.equal((await one("select count(*)::int n from public.lead_events where lead_id=$1 and event_type='estimate_sent'",[linked.lead_id])).n,1);
  pass('earlier cross-channel recovery corrects first evidence once without moving latest sent_at backward');
  await db.query("update public.estimates set status='accepted' where id=$1",[e]);
  await db.query("update public.leads set stage='accepted' where id=$1",[linked.lead_id]);
  await service(()=>attempt(408,e)); await service(()=>complete(408));
  assert.equal((await one('select status from public.estimates where id=$1',[e])).status,'accepted');
  assert.equal((await one('select stage from public.leads where id=$1',[linked.lead_id])).stage,'accepted');
  pass('provider completion preserves accepted estimate and lead under actual status guard');
  await assert.rejects(()=>service(()=>db.query("update public.pec_estimate_send_attempts set status='pending',completed_at=null,provider_id=null where id=$1",[id(400)])),/immutable/);
  await assert.rejects(()=>service(()=>attempt(405,e,'email','FTP')),/brand must match/);
  await assert.rejects(()=>staff(()=>attempt(406,e)),/permission denied/);
  await assert.rejects(()=>staff(()=>db.query('delete from public.pec_estimate_first_sends')),/permission denied/);
  await assert.rejects(()=>service(()=>db.query('update public.pec_estimate_first_sends set first_sent_at=now()')),/earlier verified/);
  await assert.rejects(()=>role('anon',()=>rows('select * from public.pec_estimate_first_sends')),/permission denied/);
  assert.equal((await role('authenticated',()=>rows('select * from public.pec_estimate_first_sends'),false)).length,0);
  assert.equal((await staff(()=>rows('select * from public.pec_estimate_first_sends'))).length,1);
  pass('ledger role boundaries, RLS visibility and terminal evidence immutability hold');

  await service(()=>estimate(210,null,{token:'exact-token',created_at:'2026-08-30T18:00:00Z'}));
  await service(()=>estimate(211,null,{token:'complained-token',created_at:'2026-09-06T23:50:00Z'}));
  await db.query(`insert into public.pec_email_log(id,brand,sent_at,resend_id,body_html,status) values
    ($1,'prescott-epoxy','2026-09-01','provider-first','<a href="https://topcoat.example/e/exact-token">Review</a>','delivered'),
    ($2,'prescott-epoxy','2026-09-20','provider-again','https://topcoat.example/e/exact-token','sent'),
    ($3,'prescott-epoxy','2026-08-01','provider-prefix','https://topcoat.example/e/exact-token-suffix','sent'),
    ($4,'prescott-epoxy','2026-08-02','provider-queued','https://topcoat.example/e/exact-token','queued'),
    ($5,'prescott-epoxy','2026-08-03',null,'https://topcoat.example/e/exact-token','sent'),
    ($6,'finishing-touch','2026-08-04','provider-wrong-brand','https://topcoat.example/e/exact-token','sent')`,
  [id(501),id(502),id(503),id(504),id(505),id(506)]);
  await db.query(`insert into public.pec_email_log(id,brand,sent_at,resend_id,body_html,status,template_key) values
    ($1,'prescott-epoxy','2026-09-07T01:00:00Z','provider-complained','https://topcoat.example/e/complained-token','complained','estimate'),
    ($2,'prescott-epoxy','2026-08-01','provider-compose','https://topcoat.example/e/complained-token','sent','compose')`,[id(507),id(508)]);
  await db.query(`insert into public.pec_sms_log values
    ($1,'prescott-epoxy','2026-09-10','provider-sms','https://topcoat.example/e/exact-token. STOP','sent','out','estimate'),
    ($2,'prescott-epoxy','2026-08-01','provider-inbound','https://topcoat.example/e/exact-token','sent','in','estimate'),
    ($3,'prescott-epoxy','2026-08-02','provider-failed','https://topcoat.example/e/exact-token','failed','out','estimate')`,[id(510),id(511),id(512)]);
  const evidence = await rows(dryRun);
  assert.equal(evidence.length,2); assert.equal(evidence[0].estimate_id,id(210));
  assert.equal(evidence[0].first_sent_at.toISOString(),'2026-09-01T00:00:00.000Z');
  assert.equal(evidence[0].matching_success_messages,3);
  assert.equal(evidence[0].first_send_week_reconciliation_required,true);
  assert.equal(evidence[1].first_sent_at.toISOString(),'2026-09-07T01:00:00.000Z');
  assert.equal(evidence[1].creation_receipt_same_phoenix_week,true);
  assert.equal(evidence[1].first_send_week_reconciliation_required,false);
  pass('read-only historical review uses exact tokens and earliest all-history accepted send evidence');
  pass('estimate-only email receipts include complaints and flag ambiguous Phoenix-week first sends');
  const missingSql = fs.readFileSync(path.join(root,'docs/sales/missing-pipeline-leads-dry-run.sql'),'utf8');
  assert.deepEqual(await rows(missingSql),[]);
  const reviewContact = await customer(12);
  const reviewed = await rows(missingSql.replace('null::timestamptz as native_intake_from',"'2026-07-13'::timestamptz as native_intake_from")
    .replace('null::timestamptz as selected_from',"'2026-09-01'::timestamptz as selected_from")
    .replace('null::timestamptz as selected_until',"'2026-10-01'::timestamptz as selected_until"));
  assert.equal(reviewed.length,1); assert.equal(reviewed[0].customer_id,reviewContact);
  assert.equal(reviewed[0].in_selected_period,true);
  pass('missing-pipeline review requires explicit dates and returns only customer-only candidates');
  console.log(`\n${checks} isolated PostgreSQL checks passed. PGlite serializes queries; multi-session advisory-lock contention was not exercised.`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>db.close());
