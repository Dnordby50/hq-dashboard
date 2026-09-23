'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {JSDOM} = require('../apps/estimator/node_modules/jsdom');
const source = fs.readFileSync(require.resolve('./advertiser.js'),'utf8').replace('export function','function');
const tick = () => new Promise(resolve=>setImmediate(resolve));
function fixture(reply) {
  const dom = new JSDOM('<body><div id="rdShell">Staff shell</div></body>',{url:'https://synthetic.invalid'});
  let user = {id:'adv-one',name:'Advertiser fixture',role:'advertiser',company:'PEC'};
  const requests=[];let signedOut=false;
  const supabase={rpc:async(name,args)=>{requests.push({name,args});return reply ? reply(name,args) : {data:{lead_count:1,sale_count:1,sales_value:5000,undated_leads:0,undated_sales:0,leads:[{id:'lead',name:'<script>bad()</script>',date:'2026-09-12',source:'Meta',campaign:'Fall',stage:'new'}],sales:[{id:'sale',name:'Client',date:'2026-09-12',source:'Meta',amount:5000}],sources:[{source:'Meta',campaign:'Fall',leads:1,sales:1}]}};}};
  const ctx=vm.createContext({document:dom.window.document,Intl,Date,setInterval:()=>1,clearInterval(){},supabase,getUser:()=>user,signOut:()=>{signedOut=true;vm.runInContext('view.unmount()',ctx);}});
  vm.runInContext(source+'\nconst view=createAdvertiserView({supabase,getUser,signOut});view.mount();',ctx);
  return {document:dom.window.document,window:dom.window,requests,ctx,get signedOut(){return signedOut;},setUser:u=>user=u,close:()=>dom.window.close()};
}
test('advertiser renders only scoped report, escapes names, paginates and signs out',async()=>{
 const f=fixture();await tick();
 assert.equal(f.requests[0].name,'pec_advertiser_report');assert.equal(f.requests[0].args.p_brand,'PEC');
 assert.ok(f.document.body.classList.contains('advertiser-mode'));
 assert.equal(f.document.querySelector('script'),null);assert.match(f.document.querySelector('[data-results]').textContent,/<script>bad/);
 assert.equal(f.document.querySelector('option[value=FTP]'),null);
 f.document.querySelector('[data-tab=sales]').click();await tick();assert.match(f.document.querySelector('[data-results]').textContent,/Client/);
 assert.ok(f.requests.every(r=>r.name==='pec_advertiser_report'));
 f.document.querySelector('[data-signout]').click();assert.equal(f.signedOut,true);assert.equal(f.document.querySelector('#advertiserRoot'),null);f.close();
});
test('late response after account change cannot render previous advertiser data',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);const f=fixture(()=>pending);
 f.setUser({id:'different',role:'admin'});vm.runInContext('view.unmount()',f.ctx);
 resolve({data:{leads:[],sales:[],sources:[]}});await tick();assert.equal(f.document.querySelector('#advertiserRoot'),null);assert.equal(f.document.body.classList.contains('advertiser-mode'),false);f.close();
});
test('failed report clears results instead of showing zero sales or stale data',async()=>{
 const f=fixture(()=>({error:{message:'access revoked'}}));await tick();
 assert.match(f.document.querySelector('[role=alert]').textContent,/access may have changed/);
 assert.equal(f.document.querySelector('table'),null);f.close();
});
test('date range guard rejects inverted filters without another read',async()=>{
 const f=fixture();await tick();const form=f.document.querySelector('form');
 form.elements.from.value='2026-09-30';form.elements.to.value='2026-09-01';form.dispatchEvent(new f.window.Event('submit',{cancelable:true}));
 assert.equal(f.requests.length,1);assert.match(f.document.querySelector('[role=alert]').textContent,/end date/);f.close();
});
function createFixture(authorized=true) {
 const calls=[]; const module={exports:{}};
 const helper={json:(statusCode,body)=>({statusCode,body:JSON.stringify(body)}),requireStaff:async(event,options)=>{calls.push({gate:options});return authorized?{ok:true}:{ok:false,status:403,error:'Admins only'};},sb:async(method,path,payload)=>{calls.push({method,path,payload});return method==='GET'?[]:path==='/admin_users'?[{id:'staff-id'}]:[];}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../netlify/functions/pec-create-staff.cjs'),'utf8'),{module,exports:module.exports,require:()=>helper,process:{env:{SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture'}},console,fetch:async(url,init)=>{calls.push({url,init});return {ok:true,json:async()=>({id:'new-auth-user'})};}});
 return {handler:module.exports.handler,calls};
}
const createEvent = body=>({httpMethod:'POST',headers:{authorization:'Bearer synthetic'},body:JSON.stringify({name:'Ad partner',email:'partner@example.test',password:'synthetic-password',role:'advertiser',company:'PEC',...body})});
test('only a current admin can create advertiser with false capability defaults',async()=>{
 const f=createFixture();assert.equal((await f.handler(createEvent())).statusCode,200);
 assert.equal(f.calls[0].gate.adminOnly,true);
 const record=f.calls.find(c=>c.path==='/admin_users');assert.equal(record.payload.role,'advertiser');assert.equal(record.payload.company,'PEC');
 const perms=f.calls.find(c=>c.path==='/user_permissions').payload;assert.ok(Object.entries(perms).filter(([k])=>k!=='admin_user_id').every(([,v])=>v===false));
 const denied=createFixture(false);assert.equal((await denied.handler(createEvent())).statusCode,403);assert.equal(denied.calls.length,1);
});
test('unknown roles and company values never silently create an office account',async()=>{
 const f=createFixture();assert.equal((await f.handler(createEvent({role:'Advertiser'}))).statusCode,400);assert.equal((await f.handler(createEvent({company:'arbitrary'}))).statusCode,400);assert.equal(f.calls.length,0);
});
