'use strict';

// Isolated PostgreSQL rehearsal. No network, production writes, or customer data.
// Uses reviewed IDs/dates with synthetic contact details and provider evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const { REVIEWED, KEY, buildSql } = require('./reconcile-sales-week-2026-09-14.cjs');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260922162337_sales_pipeline_and_first_send_truth.sql');
const statusGuard = read('supabase/migrations/2026-08-19_prompt84_estimate_status_guard.sql');
// Share the existing migration rehearsal's table shape without running its tests.
const commonRehearsal = read('scripts/rehearse-sales-truth.cjs');
const bootstrap = commonRehearsal.match(/\(async \(\) => \{\s*await db\.exec\(`([\s\S]*?)`\);/)[1]
  .replaceAll('${id(999)}', '00000000-0000-4000-8000-000000000999');
const SENT = ['2026-09-16T01:06:55.955556Z','2026-09-16T17:56:32.461728Z',null,null,'2026-09-14T21:46:53.150212Z','2026-09-14T22:12:24.895306Z','2026-09-15T19:19:02.275450Z'];
const ACCEPTED = {1:'2026-09-17T20:56:01.602Z',6:'2026-09-15T19:24:09.239Z'};
const APPT = ['2026-09-14T16:09:25.385609Z','2026-09-14T18:29:25.359087Z','2026-09-14T18:33:13.314474Z'];
let checks = 0;
const pass = label => { checks++; console.log('PASS '+label); };
const row = async (db,sql,params=[]) => (await db.query(sql,params)).rows[0];
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function fixture() {
  const db = new PGlite();
  await db.exec(bootstrap);
  await db.exec(`alter table public.leads add column accepted_at timestamptz;
    alter table public.estimates add column accepted_at timestamptz,add column signed_at timestamptz;
    create table public.pec_drip_enrollments(id uuid primary key);
    grant select,insert,update,delete on public.pec_drip_enrollments to service_role;`);
  for (let i=0;i<REVIEWED.length;i++) {
    const [id,at,source,stage,appointments,estimates]=REVIEWED[i];
    await db.query(`insert into public.customers(id,name,company,email,phone,first_name,last_name,lead_source,created_at)
      values($1,$2,'prescott-epoxy',$3,$4,'Synthetic',$5,$6,$7)`,
    [id,'Synthetic reviewed '+i,`reviewed${i}@example.invalid`,'92855501'+String(i).padStart(2,'0'),String(i),source,at]);
    for (const appt of appointments) await db.query(`insert into public.pec_appointments(id,customer_id,source,appt_type,status,created_at)
      values($1,$2,'topcoat',$3,'scheduled',$4)`,[appt,id,i===2?'site_visit':'on_site_estimate',APPT[i]]);
    for (let j=0;j<estimates.length;j++) {
      const estimate=estimates[j];
      const token=`synthetic-${i}-${j}`;
      const sent=j===1?'2026-09-14T23:07:19.801290Z':SENT[i];
      await db.query(`insert into public.estimates(id,customer_id,brand,status,created_at,public_token,sent_at,accepted_at,signed_at)
        values($1,$2,'PEC',$3,$4,$5,$6,$7,$7)`,[estimate,id,stage==='accepted'?'accepted':'sent',at,token,sent,ACCEPTED[i]||null]);
      await db.query(`insert into public.pec_email_log(id,brand,sent_at,resend_id,body_html,status,template_key)
        values($1,'PEC',$2,$3,$4,'sent','estimate')`,[uuid(i*10+j+1),sent,'synthetic-provider-'+i+'-'+j,`<a href="https://example.invalid/e/${token}">Proposal</a>`]);
    }
  }
  // Legacy rows predate both triggers, exactly as in the reviewed repair.
  await db.exec(statusGuard);
  await db.exec(migration);
  return db;
}
async function snapshot(db) {
  return (await db.query(`select jsonb_build_object(
    'customers',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.customers t),
    'leads',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.leads t),
    'events',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.lead_events t),
    'estimates',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.estimates t),
    'appointments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.pec_appointments t),
    'email',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.pec_email_log t),
    'sms',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.pec_sms_log t),
    'drips',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.pec_drip_enrollments t),
    'attempts',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.pec_estimate_send_attempts t),
    'first_sends',(select coalesce(jsonb_agg(to_jsonb(t) order by estimate_id),'[]') from public.pec_estimate_first_sends t)
  ) as state`)).rows[0].state;
}
async function rejectUnchanged(db,pattern) {
  const before=await snapshot(db);
  await assert.rejects(()=>db.exec(buildSql(true)),pattern);
  await db.exec('rollback');
  assert.deepEqual(await snapshot(db),before);
}
(async()=>{
  const db=await fixture();
  try {
    const before=await snapshot(db);
    const preview=(await db.query(buildSql())).rows;
    assert.equal(preview.length,7);
    assert.deepEqual(preview.map(x=>x.proposed_stage),REVIEWED.map(x=>x[3]));
    assert.ok(preview.every(x=>Number(x.existing_leads)===0 && Number(x.other_customer_matches)===0 && Number(x.other_lead_matches)===0));
    assert.deepEqual(await snapshot(db),before);
    pass('default dry-run is read only and seven-row evidence matches reviewed stages');
    assert.ok(buildSql(true).indexOf("'sales-lead:PEC:'")<buildSql(true).indexOf('for v_record in with reviewed'));
    await db.exec(buildSql(true));
    const after=await snapshot(db);
    assert.equal(after.leads.length,7); assert.equal(after.events.length,14);
    assert.ok(after.events.filter(x=>x.event_type==='note').every(x=>x.payload.reconciliation_key===KEY));
    for (const [id,at,,stage,appts,estimates] of REVIEWED) {
      const lead=after.leads.find(x=>x.customer_id===id);
      assert.equal(lead.stage,stage);
      assert.equal(Date.parse(lead.created_at),Date.parse(at));
      assert.equal(lead.sms_consent,false);
      assert.equal((await row(db,'select created_at=$2::timestamptz as exact from public.leads where id=$1',[lead.id,at])).exact,true);
      assert.ok(after.appointments.filter(x=>appts.includes(x.id)).every(x=>x.lead_id===lead.id));
      assert.ok(after.estimates.filter(x=>estimates.includes(x.id)).every(x=>x.lead_id===lead.id));
    }
    assert.equal(after.estimates.filter(x=>x.lead_id).length,6);
    assert.equal(after.appointments.filter(x=>x.lead_id).length,3);
    pass('service-role transaction creates seven exact-dated leads and links six proposals plus three appointments');
    const becky=after.leads.find(x=>x.customer_id===REVIEWED[2][0]);
    assert.equal(becky.stage,'new'); assert.equal(becky.estimate_scheduled_at,null);
    assert.equal(becky.estimate_sent_at,null); assert.equal(becky.accepted_at,null);
    for (const i of [1,6]) {
      assert.equal(Date.parse(after.leads.find(x=>x.customer_id===REVIEWED[i][0]).accepted_at),Date.parse(ACCEPTED[i]));
      assert.equal(after.estimates.find(x=>x.customer_id===REVIEWED[i][0]).status,'accepted');
    }
    pass('site visit remains new while verified acceptance timestamps and accepted proposal status survive real guard');
    assert.deepEqual(after.customers,before.customers);
    for (const k of ['email','sms','drips','attempts','first_sends']) assert.deepEqual(after[k],before[k]);
    for (const k of ['estimates','appointments']) assert.deepEqual(after[k].map(({lead_id,...x})=>x),before[k].map(({lead_id,...x})=>x));
    pass('customer/proposal/appointment history and all communications, nurture and send evidence remain unchanged');
    await db.exec(buildSql(true));
    assert.deepEqual(await snapshot(db),after);
    pass('second apply makes zero changes including no repeated audit events');
    await db.query("update public.leads set stage='lost',archived_at=now() where customer_id=$1",[REVIEWED[0][0]]);
    const advanced=await snapshot(db);
    await db.exec(buildSql(true));
    assert.deepEqual(await snapshot(db),advanced);
    pass('replay preserves a subsequently closed and archived lead without restating dates');
  } finally { await db.close(); }
  for (const [label,mutate,pattern] of [
    ['changed source aborts entire repair', db=>db.query("update public.customers set lead_source='Import' where id=$1",[REVIEWED[6][0]]),/evidence changed/],
    ['accepted status without acceptance time aborts', db=>db.query('update public.estimates set accepted_at=null,signed_at=null where customer_id=$1',[REVIEWED[6][0]]),/evidence changed/],
    ['unreviewed canonical lead is preserved', db=>db.query("insert into public.leads(customer_id,brand,stage,created_at) values($1,'PEC','accepted',$2)",[REVIEWED[6][0],REVIEWED[6][1]]),/unreviewed lead/],
    ['new unreviewed native appointment aborts', db=>db.query("insert into public.pec_appointments(id,customer_id,appt_type) values($1,$2,'site_visit')",[uuid(999),REVIEWED[6][0]]),/evidence changed/],
    ['existing site-visit lead link is preserved', async db=>{
      await db.query("insert into public.leads(id,brand,stage) values($1,'PEC','accepted')",[uuid(998)]);
      await db.query('update public.pec_appointments set lead_id=$1 where id=$2',[uuid(998),REVIEWED[2][4][0]]);
    },/Existing record lead link/],
    ['missing verified send evidence aborts', db=>db.query('delete from public.pec_email_log where id=$1',[uuid(1)]),/evidence changed/],
    ['duplicate matching legacy contact aborts', db=>db.query("insert into public.customers(id,name,company,email) values($1,'Other','prescott-epoxy','reviewed6@example.invalid')",[uuid(999)]),/evidence changed/]
  ]) {
    const test=await fixture();
    try { await mutate(test); await rejectUnchanged(test,pattern); pass(label+' with complete rollback'); }
    finally { await test.close(); }
  }
  console.log(`Passed ${checks} isolated historical reconciliation checks.`);
})().catch(error=>{ console.error(error); process.exitCode=1; });
