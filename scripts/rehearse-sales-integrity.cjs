'use strict';
// Reuses the inquiry rehearsal's realistic RLS fixture and assertions, applying
// both new migrations in release order inside the same isolated PostgreSQL DB.
const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
let source=fs.readFileSync(path.join(__dirname,'rehearse-sales-inquiries.cjs'),'utf8');
const jobFixture=`
create schema topcoat_security_private;
create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('role',current_setting('role',true))$$;
create function public.is_admin_role() returns boolean language sql as $$select public.is_admin_staff()$$;
create table public.jobs(id uuid primary key default gen_random_uuid(),customer_id uuid references public.customers,type text,status text default 'signed',archived_at timestamptz,voided_at timestamptz,signed_date date,completed_date date,price numeric,status_manual_at timestamptz,invoice_due_date date,invoice_terms text,source text default 'native',address text,package text,scope text,sqft text,monthly_payment numeric,warranty text,dripjobs_url text,dripjobs_deal_id text,salesperson text,line_items jsonb);
create table public.pec_prod_jobs(id uuid primary key default gen_random_uuid(),crm_job_id uuid references public.jobs,customer_id uuid references public.customers,archived_at timestamptz,is_callback boolean default false,status text default 'unscheduled',completed_at timestamptz,install_date date,dripjobs_deal_id text,proposal_number text,customer_name text,address text,revenue numeric,sync_status text,sales_team text,notes text);
create table public.timeline_stages(id uuid primary key default gen_random_uuid(),job_id uuid references public.jobs,stage_name text,status text,completed_at timestamptz,sort_order integer);
create table public.pec_prod_job_schedule_days(job_id uuid,scheduled_date date);
create table public.pec_change_order_signatures(id uuid primary key default gen_random_uuid(),job_id uuid references public.jobs,amount numeric not null,status text default 'pending',signed_at timestamptz);
grant select,insert,update on public.jobs,public.pec_prod_jobs,public.timeline_stages,public.pec_prod_job_schedule_days to authenticated,service_role;
`;
source=source.replace(/await db\.exec\(`create table public\.pec_prod_jobs[^]*?`\);/,()=>`await db.exec(${JSON.stringify(jobFixture)}); await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20260923163510_job_event_integrity.sql'),'utf8'));`);
// Existing inquiry assertions also verify all auth/trigger interactions after
// both migrations. Add a complete inquiry -> booking -> completion transaction.
source=source.replace("pass('inquiry migration installs after current sales truth');",`pass('both event and inquiry migrations install in release order');
  const integratedCustomer=await customer(800);
  const integratedLead=await staff(()=>one("select public.record_sales_inquiry($1,'integrated-request','PEC','new',null,null,'staff_live',null) id",[integratedCustomer]));
  const integratedJob=await staff(()=>one("insert into public.jobs(customer_id,type,signed_date,price) values($1,'epoxy','2026-01-01',500) returning id",[integratedCustomer]));
  await staff(()=>one("select public.pec_complete_job($1,null,'2026-01-02','integrated-completion',null,'Crew recorded completion') result",[integratedJob.id]));
  assert.equal((await rows('select * from public.pec_job_business_events where job_id=$1',[integratedJob.id])).length,2);
  assert.equal((await rows('select * from public.leads where customer_id=$1',[integratedCustomer])).length,1);
  pass('combined inquiry, immutable booking and atomic completion preserve one inquiry identity');`);
vm.runInNewContext(source,{require,__dirname,console,process,Buffer},{filename:path.join(__dirname,'rehearse-sales-integrity.cjs')});
