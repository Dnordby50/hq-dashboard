'use strict';
// Exact migration against an isolated PostgreSQL runtime and synthetic identities.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PGLITE_MODULE || '/Users/dylannordby/.npm/_npx/da5c1b6ea715e8b4/node_modules/@electric-sql/pglite');
const root = path.resolve(__dirname,'..');
const migration = fs.readFileSync(path.join(root,'supabase/migrations/20260923213545_advertiser_read_only_access.sql'),'utf8');
const baseline = fs.readFileSync(path.join(root,'supabase/migrations/20260915022840_security_staff_boundaries.sql'),'utf8');
const db = new PGlite();
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let checks=0;
const pass = label => {checks++; console.log('PASS '+label);};
async function identity(n, role='authenticated', session=n+100) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:uid(n),session_id:uid(session),role})]);
  await db.exec('set role '+role);
}
const report = (brand='PEC',from='2026-09-01',to='2026-09-30',page=0) => db.query('select public.pec_advertiser_report($1,$2,$3,$4) as data',[from,to,brand,page]).then(r=>r.rows[0].data);
(async()=>{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema topcoat_security_private;create schema topcoat_owner_private;
 create function auth.jwt() returns jsonb language sql stable as $$select nullif(current_setting('request.jwt.claims',true),'')::jsonb$$;
 create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
 grant usage on schema auth,public,topcoat_security_private to anon,authenticated,service_role;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create table public.admin_users(id uuid primary key,auth_user_id uuid,email text,name text,role text not null,company text,login_revoked_at timestamptz,
 constraint admin_users_role_check check(role in ('admin','office','pm','crew','sales')));
 create table public.user_permissions(admin_user_id uuid,can_move_pipeline boolean default true,can_view_job_costing boolean default true,can_override_status boolean default true,can_view_commission boolean default true,can_edit_catalog boolean default true,can_manage_team boolean default true,can_manage_settings boolean default true,can_finalize_costing boolean default true);
 create table public.leads(id uuid primary key,brand text,customer_id uuid,full_name text,first_name text,last_name text,source text,campaign text,stage text,inquiry_date date,inquiry_origin text,intake_request_key text,created_at timestamptz,deleted_at timestamptz,duplicate_of uuid,reporting_excluded_at timestamptz,notes text);
 create table public.customers(id uuid primary key,name text,company text,lead_source text,reporting_excluded_at timestamptz,token text);
 create table public.jobs(id uuid primary key,customer_id uuid,signed_date date,price numeric,voided_at timestamptz,archived_at timestamptz,signature_data text);
 create table public.estimates(id uuid primary key,job_id uuid,brand text,customer_id uuid,lead_id uuid,lead_source text,deleted_at timestamptz,status text,accepted_at timestamptz,public_token text);
 create table public.settings(key text,value text);
 create table public.pec_user_todos(id uuid,admin_user_id uuid,secret text);
 create table public.pec_whats_new_acks(id uuid,admin_user_id uuid);
 create table public.pec_owner_access(auth_user_id uuid,enabled boolean);
 grant usage on schema topcoat_owner_private to authenticated;

 `);
 await db.exec(baseline.slice(baseline.indexOf('create or replace function topcoat_security_private.staff_session_valid()'),baseline.indexOf('-- WITH CHECK does not apply')));
 for(const table of ['admin_users','user_permissions','leads','customers','jobs','estimates','settings','pec_user_todos','pec_whats_new_acks']) {
   await db.exec(`alter table public.${table} enable row level security;grant select,insert,update,delete on public.${table} to authenticated,service_role;create policy staff on public.${table} for all to authenticated using(public.is_admin_staff()) with check(public.is_admin_staff());`);
 }
 for(let n=1;n<=4;n++) {
   await db.query('insert into auth.users values($1,now(),null)',[uid(n)]);
   await db.query('insert into auth.sessions values($1,$2,null)',[uid(n+100),uid(n)]);
   await db.query('insert into public.admin_users values($1,$1,$2,$2,$3,$4,null)',[uid(n),'synthetic-'+n,n===1?'admin':'office',n===3?'FTP':n===4?'both':'PEC']);
   await db.query('insert into public.user_permissions(admin_user_id) values($1)',[uid(n)]);
 }
 await db.query('insert into public.pec_owner_access values($1,true),($2,true)',[uid(1),uid(2)]);
 await db.query('insert into public.pec_user_todos values($1,$1,$2)',[uid(2),'PRIVATE OWNER TASK']);
 await db.exec("create policy own_todos on public.pec_user_todos for all to authenticated using(admin_user_id=auth.uid()) with check(admin_user_id=auth.uid());");
 await identity(1); assert.equal((await db.query('select public.is_admin_staff() as ok')).rows[0].ok,true);
 await db.exec('reset role');await db.exec(migration);
 await db.exec("update public.admin_users set role='advertiser' where role='office'");
 await identity(1);assert.equal((await db.query('select public.is_admin_staff() as staff,public.is_admin_role() as admin')).rows[0].admin,true);assert.equal((await db.query('select topcoat_owner_private.allowed() as ok')).rows[0].ok,true);pass('existing admin and owner session retained');
 await db.exec('reset role');
 for(let n=1;n<=102;n++) {
   await db.query("insert into public.leads(id,brand,customer_id,full_name,source,campaign,stage,inquiry_date,created_at,notes) values($1,'PEC',$2,$3,'Meta','Fall','new','2026-09-10',now(),'SECRET')",[uid(n+1000),uid(501),'Fixture '+n]);
 }
 await db.query("insert into public.leads(id,brand,full_name,stage,inquiry_date,created_at) values($1,'FTP','FTP only','accepted','2026-09-11',now())",[uid(4000)]);
 await db.query("insert into public.leads(id,brand,full_name,stage,inquiry_origin,created_at) values($1,'PEC','Undated','new','import',now())",[uid(4001)]);
 await db.query("insert into public.customers values($1,'PEC client','prescott-epoxy','Referral',null,'SECRET'),($2,'FTP client','finishing-touch','Organic',null,'SECRET')",[uid(501),uid(502)]);
 await db.query("insert into public.jobs values($1,$2,'2026-09-10',5000,null,null,'SECRET'),($3,$4,'2026-09-11',9000,null,null,'SECRET')",[uid(601),uid(501),uid(602),uid(502)]);
 await db.query("insert into public.estimates values($1,$2,'PEC',$3,$4,'Google',null,'accepted',now(),'SECRET')",[uid(701),uid(601),uid(501),uid(1001)]);
 await identity(2);
 assert.deepEqual((await db.query("select public.is_admin_staff() as staff,public.is_admin_role() as admin,public.has_permission('can_manage_settings') as permission,public.pec_staff_session() as session")).rows[0],{staff:false,admin:false,permission:false,session:null});assert.equal((await db.query('select topcoat_owner_private.allowed() as ok')).rows[0].ok,false);pass('advertiser denied all staff and owner helpers even with old grants');
 assert.equal((await db.query('select id from public.admin_users')).rows.length,1);pass('advertiser can read only own login');
 for(const table of ['leads','customers','jobs','estimates','settings','user_permissions','pec_user_todos','pec_whats_new_acks']) {
   assert.equal((await db.query('select * from public.'+table)).rows.length,0);
   assert.equal((await db.query('delete from public.'+table)).affectedRows,0);
 }
 await assert.rejects(()=>db.query("insert into public.settings values('bad','bad')"),/row-level security/);
 await assert.rejects(()=>db.query("insert into public.leads(id) values($1)",[uid(9999)]),/row-level security/);
 assert.equal((await db.query("update public.admin_users set role='admin'")).affectedRows,0);pass('raw reads, writes and self-promotion denied');
 const data=await report();assert.equal(data.lead_count,102);assert.equal(data.leads.length,100);assert.equal(data.sale_count,1);assert.equal(data.sales_value,5000);assert.equal(data.sales[0].source,'Meta');assert.equal(data.undated_leads,1);assert.equal(JSON.stringify(data).includes('SECRET'),false);assert.equal(JSON.stringify(data).includes('FTP only'),false);pass('scoped reporting, attribution, unknown dates and safe projection');
 assert.equal((await report('PEC',undefined,undefined,1)).leads.length,2);pass('pagination retains full counts');
 for(const args of [['FTP'],['both'],[null],['PEC','2026-09-30','2026-09-01'],['PEC','2020-01-01','2026-09-30'],['PEC',undefined,undefined,-1]]) await assert.rejects(()=>report(...args));pass('forged company, dates and page rejected');
 await identity(3);assert.equal((await report('FTP')).sale_count,1);await assert.rejects(()=>report('PEC'));await identity(4);assert.equal((await report('FTP')).sale_count,1);assert.equal((await report()).sale_count,1);pass('FTP-only and both-company entitlements');
 await identity(1);await assert.rejects(()=>report(),/Advertiser session required/);await identity(2,'anon');await assert.rejects(()=>report(),/permission denied/);pass('report unavailable to anonymous and ordinary staff');
 await identity(2,'authenticated',999);await assert.rejects(()=>report());await identity(99);await assert.rejects(()=>report());pass('missing membership and stale session rejected');
 for(const [sql,undo] of [
   ["update public.admin_users set login_revoked_at=now() where id=$1","update public.admin_users set login_revoked_at=null where id=$1"],
   ["update auth.users set banned_until=now()+interval '1 day' where id=$1","update auth.users set banned_until=null where id=$1"],
   ["update auth.users set email_confirmed_at=null where id=$1","update auth.users set email_confirmed_at=now() where id=$1"]
 ]) {await db.exec('reset role');await db.query(sql,[uid(2)]);await identity(2);await assert.rejects(()=>report());assert.equal((await db.query('select * from public.admin_users')).rows.length,0);await db.exec('reset role');await db.query(undo,[uid(2)]);}
 pass('revoked, banned and unconfirmed advertiser lose report and identity access');
 await db.exec("update public.admin_users set company=null where id='"+uid(2)+"'");await identity(2);await assert.rejects(()=>report());pass('missing company fails closed');
 await db.exec('reset role');
 const funcs=(await db.query("select proname,proconfig,has_function_privilege('anon',oid,'execute') as anon from pg_proc where proname in ('pec_advertiser_report','advertiser_session_valid')")).rows;
 assert.ok(funcs.every(f=>f.proconfig.includes('search_path=""')&&!f.anon));pass('fixed search paths and least privilege grants');
 console.log(`${checks} advertiser migration rehearsal groups passed`);
 await db.close();
})().catch(async error=>{console.error(error);await db.close();process.exitCode=1;});
