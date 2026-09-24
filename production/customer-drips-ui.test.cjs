'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM}=require('../apps/estimator/node_modules/jsdom');
const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
const source=html.slice(html.indexOf('function customerDripPreferenceHtml('),html.indexOf('async function renderCustomerDetail('));
function harness(enabled=true){
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'});
 vm.runInContext(`window.customer={id:'customer-1',drips_enabled:${enabled}};window.calls=[];window.fail=false;window.$=id=>document.getElementById(id);window.withFreshWrite=fn=>fn();window.supabase={from:table=>({update(payload){calls.push({table,payload});return this},eq(key,value){calls.at(-1).filter={key,value};return this},select(){return this},async single(){if(window.wait)await window.wait;return fail?{error:{message:'Offline'}}:{data:{id:customer.id,...calls.at(-1).payload}}}})};`+source+`document.querySelector('main').innerHTML=customerDripPreferenceHtml(customer);wireCustomerDripPreference(customer);`,dom.getInternalVMContext()); return dom;
}
const tick=()=>new Promise(r=>setImmediate(r));
test('customer switch persists off/on to only the displayed customer and confirms saved state',async()=>{
 const dom=harness(),w=dom.window,b=w.$('pecCustDripsToggle');
 assert.equal(b.getAttribute('aria-checked'),'true');b.click();await tick();assert.equal(b.textContent,'Off');assert.equal(w.customer.drips_enabled,false);
 assert.deepEqual(JSON.parse(JSON.stringify(w.calls[0])),{table:'customers',payload:{drips_enabled:false},filter:{key:'id',value:'customer-1'}});
 b.click();await tick();assert.equal(b.textContent,'On');assert.match(w.$('pecCustDripsStatus').textContent,/Stopped sequences stay stopped/);dom.window.close();
});
test('failed save preserves state; pending save prevents duplicate clicks',async()=>{
 const dom=harness(false),w=dom.window,b=w.$('pecCustDripsToggle');w.fail=true;b.click();b.click();await tick();assert.equal(w.calls.length,1);assert.equal(b.textContent,'Off');assert.equal(b.disabled,false);assert.match(w.$('pecCustDripsStatus').textContent,/Offline/);dom.window.close();
});
test('navigating away during save does not touch the new profile',async()=>{
 const dom=harness(),w=dom.window;let finish;w.wait=new Promise(r=>{finish=r});w.$('pecCustDripsToggle').click();w.document.querySelector('main').innerHTML='<div id="pecCustDripsStatus">Another customer</div>';finish();await tick();assert.equal(w.$('pecCustDripsStatus').textContent,'Another customer');dom.window.close();
});
module.exports={source};
