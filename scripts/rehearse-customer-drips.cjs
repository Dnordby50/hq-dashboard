'use strict';
// Runs the exact migration against an isolated PostgreSQL database with synthetic records.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { PGlite } = require(process.env.PGLITE_MODULE || '/Users/dylannordby/.npm/_npx/da5c1b6ea715e8b4/node_modules/@electric-sql/pglite');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
(async () => {
 const db = new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role; create role advertiser;
 create schema topcoat_security_private;
 create table customers(id uuid primary key);
 create table leads(id uuid primary key, customer_id uuid references customers);
 create table jobs(id uuid primary key, customer_id uuid references customers);
 create table pec_drip_enrollments(id uuid primary key,subject_type text,subject_id uuid,status text,stop_reason text,stopped_at timestamptz,updated_at timestamptz,next_send_at timestamptz);
 create table pec_drip_sends(id uuid primary key,enrollment_id uuid references pec_drip_enrollments,blast_id uuid,status text,error_message text);
 insert into customers values('${uuid(1)}'),('${uuid(2)}');
 insert into leads values('${uuid(11)}','${uuid(1)}'),('${uuid(12)}','${uuid(2)}');
 insert into jobs values('${uuid(21)}','${uuid(1)}');
 insert into pec_drip_enrollments(id,subject_type,subject_id,status,next_send_at) values
 ('${uuid(31)}','lead','${uuid(11)}','active',now()),('${uuid(32)}','lead','${uuid(12)}','active',now()),('${uuid(33)}','job','${uuid(21)}','completed',null),('${uuid(34)}','job','${uuid(21)}','active',now());
 insert into pec_drip_sends(id,enrollment_id,status) values
 ('${uuid(41)}','${uuid(31)}','pending'),('${uuid(42)}','${uuid(32)}','pending'),('${uuid(43)}','${uuid(33)}','queued'),('${uuid(44)}','${uuid(31)}','sent'),('${uuid(45)}','${uuid(31)}','sending');
 insert into pec_drip_sends(id,blast_id,status) values('${uuid(46)}','${uuid(50)}','queued');
 alter table customers enable row level security;
 grant select, update on customers to authenticated, advertiser;
 create policy staff_only on customers to authenticated using(true) with check(true);`);
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260924175618_customer_drip_preferences.sql'),'utf8'));
 assert.deepEqual((await db.query('select distinct drips_enabled from customers')).rows, [{drips_enabled:true}]);
 await db.exec(`set role advertiser; update customers set drips_enabled=false; reset role;`);
 assert.equal((await db.query('select count(*)::int n from customers where not drips_enabled')).rows[0].n,0);
 await db.exec(`set role authenticated; update customers set drips_enabled=false where id='${uuid(1)}'; reset role;`);
 const enrs=(await db.query('select * from pec_drip_enrollments order by id')).rows;
 assert.equal(enrs[0].status,'stopped'); assert.equal(enrs[0].stop_reason,'customer_drips_disabled'); assert.equal(enrs[0].next_send_at,null);
 assert.equal(enrs[1].status,'active'); assert.equal(enrs[2].status,'completed'); assert.equal(enrs[3].status,'stopped');
 assert.deepEqual((await db.query('select status from pec_drip_sends order by id')).rows.map(r=>r.status),['skipped','pending','skipped','sent','sending','queued']);
 for (const [type,id] of [['lead',11],['job',21]]) {
  await assert.rejects(()=>db.exec(`insert into pec_drip_enrollments(id,subject_type,subject_id,status) values('${uuid(60)}','${type}','${uuid(id)}','active')`),/customer_drips_disabled/);
 }
 await assert.rejects(()=>db.exec(`update pec_drip_enrollments set status='active' where id='${uuid(31)}'`),/customer_drips_disabled/);
 await db.exec(`update customers set drips_enabled=true where id='${uuid(1)}'`);
 assert.equal((await db.query(`select status from pec_drip_enrollments where id='${uuid(31)}'`)).rows[0].status,'stopped');
 assert.equal((await db.query(`select status from pec_drip_sends where id='${uuid(41)}'`)).rows[0].status,'skipped');
 await db.exec(`insert into pec_drip_enrollments(id,subject_type,subject_id,status) values('${uuid(61)}','lead','${uuid(11)}','active')`);
 const functions=(await db.query(`select p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') staff,has_function_privilege('service_role',p.oid,'execute') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='topcoat_security_private'`)).rows;
 assert.equal(functions.length,2);
 for(const f of functions){assert.equal(f.prosecdef,true);assert.deepEqual(f.proconfig,['search_path=""']);assert.equal(f.anon,false);assert.equal(f.staff,false);assert.equal(f.service,false);}
 await db.close(); console.log('PASS: defaults, staff/RLS, lead/job enrollment guards, queued/pending cancellation including completed sequences, customer isolation, history/blast preservation, future-only re-enable, and trigger-only function grants.');
})().catch(err=>{console.error(err);process.exitCode=1;});
