'use strict';
const assert=require('node:assert/strict');
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const {buildSql}=require('./reconcile-historical-booking-dates.cjs');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const plan=[{job_id:id(1),customer_id:id(10),old_date:null,source_date:'2026-03-02',price:1200,external_deal:'d1'},
  {job_id:id(2),customer_id:id(11),old_date:'2026-05-18',source_date:'2026-04-12',price:2300,external_deal:null}];
const sql=buildSql(plan,'a'.repeat(64),true);
(async()=>{
  const db=new PGlite();
  await db.exec(`create role service_role; create table jobs(id uuid primary key,customer_id uuid,price numeric,signed_date date,dripjobs_deal_id text,source text,archived_at timestamptz,voided_at timestamptz,completed_date date);
    create table audit_log(action text,entity_type text,entity_id uuid,before_json jsonb,after_json jsonb);
    grant select,insert,update on jobs,audit_log to service_role;`);
  for(const r of plan)await db.query(`insert into jobs values($1,$2,$3,$4,$5,'native',null,null,'2026-08-01')`,[r.job_id,r.customer_id,r.price,r.old_date,r.external_deal]);
  const before=(await db.query('select * from jobs order by id')).rows;
  await db.exec(buildSql(plan,'a'.repeat(64)));assert.deepEqual((await db.query('select * from jobs order by id')).rows,before);console.log('PASS dry-run makes no changes');
  await db.exec(sql);assert.equal((await db.query('select * from audit_log')).rows.length,2);console.log('PASS exact reviewed repairs and audit trail');
  const after=(await db.query('select * from jobs order by id')).rows;
  assert.deepEqual(after.map(({signed_date,...r})=>r),before.map(({signed_date,...r})=>r));console.log('PASS all non-date fields preserved');
  await db.exec(sql);assert.equal((await db.query('select * from audit_log')).rows.length,2);console.log('PASS replay is idempotent');
  await db.exec('delete from audit_log');for(const r of plan)await db.query('update jobs set signed_date=$1 where id=$2',[r.old_date,r.job_id]);
  await db.query('update jobs set price=9999 where id=$1',[id(2)]);
  await assert.rejects(()=>db.exec(sql),/evidence changed/);await db.exec('rollback');
  assert.equal((await db.query('select * from audit_log')).rows.length,0);assert.equal((await db.query('select signed_date from jobs where id=$1',[id(1)])).rows[0].signed_date,null);console.log('PASS concurrent drift rolls back every change');
  assert.throws(()=>buildSql([plan[0],plan[0]],'a'.repeat(64)));console.log('PASS duplicate reviewed IDs rejected');
  await db.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
