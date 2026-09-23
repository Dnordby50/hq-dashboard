'use strict';
const fs=require('node:fs');const assert=require('node:assert/strict');
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const {buildSql}=require('./reconcile-historical-first-sends.cjs');
const plan=[{estimate_id:'00000000-0000-4000-8000-000000000001',estimate_number:100001,first_sent_on:'2026-08-10'}];
(async()=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table estimates(id uuid primary key,estimate_number integer,brand text,created_at timestamptz,sent_at timestamptz,deleted_at timestamptz);
 create table audit_log(action text,entity_type text,entity_id uuid,before_json jsonb,after_json jsonb);
 grant select,update on estimates to service_role;grant select,insert on audit_log to service_role;
 insert into estimates values('${plan[0].estimate_id}',100001,'PEC','2026-08-06T20:00:00Z','2026-08-14T20:00:00Z',null);`);
 await db.exec(fs.readFileSync(process.argv[2],'utf8'));
 const before=(await db.query('select * from estimates')).rows;
 await db.exec(buildSql(plan));assert.equal((await db.query('select count(*)::int n from pec_estimate_first_send_confirmations')).rows[0].n,0);
 await db.exec(buildSql(plan,true));await db.exec(buildSql(plan,true));
 assert.equal((await db.query('select count(*)::int n from pec_estimate_first_send_confirmations')).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from audit_log')).rows[0].n,1);
 assert.deepEqual((await db.query('select * from estimates')).rows,before);
 console.log('PASS dry-run, idempotent insertion, one audit, no proposal mutations');
 for(const role of ['anon','authenticated'])for(const query of ['select * from pec_estimate_first_send_confirmations',`insert into pec_estimate_first_send_confirmations select * from pec_estimate_first_send_confirmations`,'update pec_estimate_first_send_confirmations set brand=brand','delete from pec_estimate_first_send_confirmations']){
  await assert.rejects(()=>db.exec(`begin;set local role ${role};${query};commit;`),/permission denied/);await db.exec('rollback');
 }
 for(const query of ['update pec_estimate_first_send_confirmations set brand=brand','delete from pec_estimate_first_send_confirmations']){
  await assert.rejects(()=>db.exec(`begin;set local role service_role;${query};commit;`),/permission denied/);await db.exec('rollback');
 }
 console.log('PASS client access denied; service cannot rewrite or delete confirmations');
 await assert.rejects(()=>db.exec(buildSql([{...plan[0],first_sent_on:'2026-08-11'}],true)),/Conflicting confirmation/);await db.exec('rollback');
 await assert.rejects(()=>db.exec(buildSql([{...plan[0],estimate_number:999}],true)),/Reviewed proposal changed/);await db.exec('rollback');
 console.log('PASS contradictory replay and identity drift rejected');
 await db.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
