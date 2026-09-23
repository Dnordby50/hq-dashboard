'use strict';

// Isolated PostgreSQL rehearsal. No network, live customer data or app dependency.
// Run with node; PGLITE_MODULE can override the installed local PGlite runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require(process.env.PGLITE_MODULE || '/Users/dylannordby/.npm/_npx/da5c1b6ea715e8b4/node_modules/@electric-sql/pglite');
const repo = require('node:path').resolve(__dirname, '..');
const migrationPath = repo + '/supabase/migrations/20260923204034_staff_contract_acceptance_portal_guard.sql';
const baseline = fs.readFileSync(repo + '/supabase/migrations/20260915023131_security_portal_bounds.sql', 'utf8');
const oldWrapper = baseline.match(/create or replace function public\.portal_confirm_job\([\s\S]*?\n\$\$;/i)[0];
const migration = fs.readFileSync(migrationPath, 'utf8');
const db = new PGlite();
const token = 'synthetic-portal-customer-token-one';
const otherToken = 'synthetic-portal-customer-token-two';
const signature = 'data:image/png;base64,c3ludGhldGlj';
const otherSignature = 'data:image/png;base64,ZGlmZmVyZW50';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let checks = 0;
const pass = label => { checks++; console.log('PASS ' + label); };

async function asRole(role, fn) {
  await db.exec('set role ' + role);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
async function call(jobId, opts = {}) {
  const pToken = Object.hasOwn(opts, 'token') ? opts.token : token;
  const pSignature = Object.hasOwn(opts, 'signature') ? opts.signature : signature;
  const pColors = Object.hasOwn(opts, 'colors') ? opts.colors : null;
  return asRole(opts.role || 'anon', async () => (await db.query(
    'select public.portal_confirm_job($1,$2,$3,$4::jsonb) as result',
    [pToken, jobId, pSignature, pColors === null ? null : JSON.stringify(pColors)],
  )).rows[0].result);
}
async function snapshot() {
  return (await db.query(`select jsonb_build_object(
    'jobs',(select jsonb_agg(to_jsonb(j) order by id) from public.jobs j),
    'estimates',(select jsonb_agg(to_jsonb(e) order by id) from public.estimates e),
    'calls',(select coalesce(jsonb_agg(to_jsonb(c) order by id),'[]'::jsonb) from topcoat_security_private.calls c)
  ) as value`)).rows[0].value;
}
async function denied(label, id, error, opts = {}) {
  const before = await snapshot();
  await assert.rejects(() => call(id, opts), error);
  assert.deepEqual(await snapshot(), before);
  pass(label + ' (no mutation)');
}
async function addJob(n, options = {}) {
  const id = uuid(n);
  await db.query('insert into public.jobs(id,customer_id,archived_at,voided_at) values($1,$2,$3,$4)', [id, options.customer || uuid(1), options.archived || null, options.voided || null]);
  if (options.estimate) {
    const e = options.estimate;
    await db.query('insert into public.estimates(id,job_id,status,signed_at,deleted_at) values($1,$2,$3,$4,$5)', [uuid(n + 1000), id, e.status || 'accepted', Object.hasOwn(e, 'signed') ? e.signed : '2026-09-20T16:00:00Z', e.deleted || null]);
  }
  return id;
}
async function grantsAndDefinition() {
  return (await db.query(`select p.prosecdef,p.proconfig,p.proacl::text,
    has_function_privilege('anon',p.oid,'EXECUTE') as anon,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
    has_function_privilege('service_role',p.oid,'EXECUTE') as service_role,
    has_function_privilege('untrusted',p.oid,'EXECUTE') as untrusted
    from pg_proc p where p.oid='public.portal_confirm_job(text,uuid,text,jsonb)'::regprocedure`)).rows[0];
}

(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role; create role untrusted;
    create schema topcoat_security_private;
    create table public.customers(id uuid primary key,token text not null,archived_at timestamptz);
    create table public.jobs(id uuid primary key,customer_id uuid not null references public.customers,
      archived_at timestamptz,voided_at timestamptz,confirmed boolean not null default false,
      signature_data text,confirmed_at timestamptz);
    create table public.estimates(id uuid primary key,job_id uuid references public.jobs,
      status text not null,signed_at timestamptz,deleted_at timestamptz,signature jsonb);
    alter table public.customers enable row level security;
    alter table public.jobs enable row level security;
    alter table public.estimates enable row level security;
    create table topcoat_security_private.calls(id bigint generated always as identity,kind text,payload jsonb);
    create function topcoat_security_private.portal_write_limit(p_token text,p_scope text,p_limit integer)
    returns void language plpgsql security definer set search_path='' as $$
    begin
      insert into topcoat_security_private.calls(kind,payload) values('quota',jsonb_build_object('token',p_token,'scope',p_scope,'limit',p_limit));
    end $$;
    create function topcoat_security_private.portal_confirm_job(p_token text,p_job_id uuid,p_signature text,p_colors jsonb)
    returns jsonb language plpgsql security definer set search_path='' as $$
    begin
      insert into topcoat_security_private.calls(kind,payload) values('confirm',jsonb_build_object('job_id',p_job_id,'signature',p_signature,'colors',p_colors));
      update public.jobs set confirmed=true,confirmed_at=now(),signature_data=p_signature where id=p_job_id;
      return jsonb_build_object('ok',true,'job_id',p_job_id);
    end $$;
    revoke all on schema topcoat_security_private from public,anon,authenticated,service_role;
    revoke all on all functions in schema topcoat_security_private from public,anon,authenticated,service_role;
    grant usage on schema public to anon,authenticated,service_role,untrusted;
  `);
  await db.query('insert into public.customers(id,token,archived_at) values($1,$2,null),($3,$4,null),($5,$6,now())', [uuid(1),token,uuid(2),otherToken,uuid(3),'synthetic-archived-customer-token']);
  await db.exec(oldWrapper);
  await db.exec('revoke all on function public.portal_confirm_job(text,uuid,text,jsonb) from public,anon,authenticated,service_role; grant execute on function public.portal_confirm_job(text,uuid,text,jsonb) to anon,authenticated,service_role;');
  const beforePrivileges = await grantsAndDefinition();
  assert.equal(beforePrivileges.untrusted, false);

  const signed = await addJob(100, { estimate: {} });
  assert.equal((await call(signed)).ok, true);
  pass('baseline reproduces accepted estimate permitting a separate project signature');
  await db.query('update public.jobs set confirmed=false,confirmed_at=null,signature_data=null where id=$1', [signed]);
  await db.exec('truncate topcoat_security_private.calls');

  await db.exec(migration);
  assert.deepEqual(await grantsAndDefinition(), beforePrivileges);
  assert.equal(beforePrivileges.prosecdef, true);
  assert.deepEqual(beforePrivileges.proconfig, ['search_path=""']);
  pass('migration preserves grants, SECURITY DEFINER and fixed empty search_path');
  await db.exec(migration);
  assert.deepEqual(await grantsAndDefinition(), beforePrivileges);
  pass('exact migration replays safely');

  await denied('signed estimate denied to anon', signed, /Estimate already signed/);
  await denied('signed estimate denied to authenticated', signed, /Estimate already signed/, {role:'authenticated'});
  await denied('signed estimate denied to service role', signed, /Estimate already signed/, {role:'service_role'});

  const staffAccepted = await addJob(120, { estimate: { signed: null } });
  await db.query("update public.estimates set signature=$1::jsonb where job_id=$2", [JSON.stringify({via:'staff_external_contract',contract_reference:'Synthetic signed customer contract'}), staffAccepted]);
  for (const role of ['anon','authenticated','service_role']) await denied('external contract prevents another signature for '+role, staffAccepted, /Estimate already signed/, {role});
  await denied('external contract remains owner scoped',staffAccepted,/Job not found/,{token:otherToken});
  const unsigned = await addJob(101);
  assert.deepEqual(await call(unsigned, {colors:[{label:'synthetic'}]}), {ok:true,job_id:unsigned});
  const row = (await db.query('select confirmed,signature_data from public.jobs where id=$1',[unsigned])).rows[0];
  assert.deepEqual(row,{confirmed:true,signature_data:signature});
  const calls = (await db.query('select kind,payload from topcoat_security_private.calls order by id')).rows;
  assert.deepEqual(calls,[{kind:'quota',payload:{token,scope:'portal_confirm',limit:30}},{kind:'confirm',payload:{job_id:unsigned,signature,colors:[{label:'synthetic'}]}}]);
  pass('unsigned legacy project writes once through original quota and private implementation');
  let before = await snapshot();
  assert.equal((await call(unsigned)).ok,true);
  assert.deepEqual(await snapshot(),before);
  pass('identical legacy replay succeeds without another write or quota use');
  await denied('different legacy signature denied',unsigned,/Job already confirmed/,{signature:otherSignature});
  await db.query('insert into public.estimates(id,job_id,status,signed_at) values($1,$2,\'accepted\',now())',[uuid(1101),unsigned]);
  before = await snapshot();
  assert.equal((await call(unsigned)).ok,true);
  assert.deepEqual(await snapshot(),before);
  pass('identical legacy retry still succeeds when a signed estimate now exists');
  await denied('changed legacy retry stays denied with signed estimate',unsigned,/Job already confirmed/,{signature:otherSignature});

  for (const [n,label,estimate] of [
    [102,'accepted without signed_at',{signed:null}],
    [103,'nonaccepted estimate with signed_at',{status:'sent'}],
    [104,'deleted signed estimate',{deleted:'2026-09-21T16:00:00Z'}],
  ]) {
    const id=await addJob(n,{estimate});
    assert.equal((await call(id)).ok,true);
    pass(label+' does not block legacy confirmation');
  }
  const otherUnsigned=await addJob(105);
  assert.equal((await call(otherUnsigned,{role:'authenticated'})).ok,true);
  pass('a different signed job for the same customer does not block this project');

  const fresh=await addJob(106);
  await denied('wrong owner denied',fresh,/Job not found/,{token:otherToken});
  await denied('nonexistent job denied',uuid(999),/Job not found/);
  await denied('archived customer denied',await addJob(107,{customer:uuid(3)}),/Job not found/,{token:'synthetic-archived-customer-token'});
  await denied('archived job denied',await addJob(108,{archived:'2026-09-21T16:00:00Z'}),/Job not found/);
  await denied('voided job denied',await addJob(109,{voided:'2026-09-21T16:00:00Z'}),/Job not found/);
  for(const [label,badToken] of [['null',null],['short','short'],['oversized','x'.repeat(129)]]) await denied(label+' token denied',fresh,/Invalid token/,{token:badToken});
  for(const [label,badSignature] of [['null',null],['malformed','not-a-png'],['oversized','data:image/png;base64,'+'A'.repeat(2097152)]]) await denied(label+' signature denied',fresh,/A valid PNG signature is required/,{signature:badSignature});
  await denied('object colors denied',fresh,/Invalid color selections/,{colors:{unexpected:true}});
  await denied('oversized colors denied',fresh,/Invalid color selections/,{colors:['x'.repeat(65537)]});
  await denied('more than 100 colors denied',fresh,/Too many color selections/,{colors:Array(101).fill({})});

  await assert.rejects(()=>asRole('anon',()=>db.query('select * from public.jobs')),/permission denied/);
  await assert.rejects(()=>asRole('authenticated',()=>db.query('select * from public.estimates')),/permission denied/);
  await assert.rejects(()=>asRole('anon',()=>db.query('select topcoat_security_private.portal_confirm_job($1,$2,$3,null)',[token,fresh,signature])),/permission denied/);
  await assert.rejects(()=>call(fresh,{role:'untrusted'}),/permission denied/);
  pass('table reads, private implementation and ungranted caller remain inaccessible');
  await db.exec('alter table public.estimates add column estimate_number integer, add column accepted_at timestamptz, add column signed_name text, add column signed_ip text');
  await db.exec(fs.readFileSync(repo + '/supabase/migrations/2026-08-19_prompt84_estimate_status_guard.sql','utf8'));
  const transition = await addJob(121, {estimate:{status:'sent',signed:null}});
  await db.query("update public.estimates set status='accepted',accepted_at='2026-09-20T07:00:00Z',signature=$1::jsonb where job_id=$2 and status='sent'", [JSON.stringify({via:'staff_external_contract',accepted_by:uuid(800),contract_reference:'Fixture PO'}),transition]);
  const accepted=(await db.query('select status,signed_at,signed_name,signed_ip,signature from public.estimates where job_id=$1',[transition])).rows[0];
  assert.equal(accepted.status,'accepted');assert.equal(accepted.signed_at,null);assert.equal(accepted.signed_name,null);assert.equal(accepted.signed_ip,null);
  pass('real status trigger permits staff acceptance without forging customer signature fields');
  await assert.rejects(db.query("update public.estimates set status='draft' where job_id=$1",[transition]),/may not move backward/);
  pass('accepted contract retains existing status regression protection');
  console.log(`\n${checks} isolated PostgreSQL checks passed; exact migration: ${migrationPath}`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>db.close());
