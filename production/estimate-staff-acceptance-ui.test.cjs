'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
const {JSDOM}=require('../apps/estimator/node_modules/jsdom');
const dashboard=fs.readFileSync(require.resolve('../index.html'),'utf8');
const source=dashboard.slice(dashboard.indexOf('async function openStaffEstimateAcceptance('),dashboard.indexOf('function estimatePricingSendBlockers('));
const est={id:'11111111-1111-4111-8111-111111111111',rev:3,status:'sent',choice_picked_line_id:'b',estimate_line_items:[
 {id:'a',label:'Commercial floor option A',total:5000,description:'Coat the floor',choice_group:'project'},
 {id:'b',label:'Commercial floor option B',total:6500,description:'Coat the floor',choice_group:'project'},
 {id:'extra',label:'Additional storage room',total:1000,is_optional:true,selected_by_customer:false},
]};
function setup(fresh=est) { return `
window.fixtureEstimate=${JSON.stringify(fresh)}; window.calls=[]; window.messages=[]; window.flushOk=true; window.fail=false;
window.state={session:{access_token:'synthetic-staff-token'}};
window.flushEstimateBeforeSend=async()=>window.flushOk;
window.estChoiceKey=li=>li.choice_group || null;
window.estChoiceLines=items=>items.filter(estChoiceKey);
window.estLineOptional=li=>li.is_optional===true || li.optional===true;
window.esc=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
window.fmtMoney=n=>'$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
window.showToast=s=>messages.push(s); window.renderEstimateDetail=id=>{window.rendered=id;};
window.supabase={from:()=>({select(){return this},eq(){return this},is(){return this},single:async()=>({data:fixtureEstimate})})};
window.openModal=(html,opts)=>{document.getElementById('pecModalRoot').innerHTML='<div class="pec-modal-bg"><div class="pec-modal">'+html+'</div></div>';opts.onMount(document.querySelector('.pec-modal'));};
window.closeModal=()=>{document.getElementById('pecModalRoot').innerHTML='';};
window.fetch=async(url,options)=>{calls.push({url,payload:JSON.parse(options.body),headers:options.headers});return {ok:!window.fail,json:async()=>window.fail?{ok:false,error:'Connection lost. Retry to finish the same job.'}:{ok:true,job_id:'fixture-job'}}};
`; }
function harness(fresh=est) {
 const dom=new JSDOM('<main id="pecModalRoot"></main>',{url:'https://fixture.test',runScripts:'outside-only',pretendToBeVisual:true});
 vm.runInContext(setup(fresh)+source,dom.getInternalVMContext());
 return dom;
}
const tick=()=>new Promise(r=>setImmediate(r));
test('staff modal submits selected work, actual date and evidence with staff authentication',async()=>{
 const dom=harness();try {const w=dom.window;await w.openStaffEstimateAcceptance(est);
 assert.equal(w.document.querySelector('#staffAcceptTotal').textContent,'$6,500.00');
 const extra=w.document.querySelector('[data-accept-optional]');extra.checked=true;extra.dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.equal(w.document.querySelector('#staffAcceptTotal').textContent,'$7,500.00');
 w.document.querySelector('#staffAcceptDate').value='2026-09-20';w.document.querySelector('#staffAcceptReference').value='Signed customer contract / PO 42';
 w.document.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 assert.equal(w.calls.length,1);assert.equal(w.calls[0].payload.action,'accept_staff');assert.equal(w.calls[0].payload.expected_total,7500);assert.equal(w.calls[0].payload.choice,'b');assert.equal(w.calls[0].payload.accepted_date,'2026-09-20');assert.equal(w.calls[0].payload.contract_reference,'Signed customer contract / PO 42');assert.equal(w.calls[0].payload.name,undefined);assert.equal(w.calls[0].headers.Authorization,'Bearer synthetic-staff-token');assert.equal(w.rendered,est.id);
 }finally{dom.window.close();}
});
test('failed submission preserves evidence and re-enables an explicit retry; failed draft flush never opens',async()=>{
 const dom=harness();try{const w=dom.window;w.flushOk=false;await w.openStaffEstimateAcceptance(est);assert.equal(w.document.querySelector('form'),null);
 w.flushOk=true;await w.openStaffEstimateAcceptance(est);w.fail=true;w.document.querySelector('#staffAcceptReference').value='Keep this contract';
 w.document.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 assert.equal(w.document.querySelector('#staffAcceptReference').value,'Keep this contract');assert.equal(w.document.querySelector('#staffAcceptSubmit').disabled,false);assert.match(w.document.querySelector('#staffAcceptError').textContent,/Retry/);
 }finally{dom.window.close();}
});
test('accepted recovery avoids asking for new agreement data',async()=>{
 const fresh={...est,status:'accepted'},dom=harness(fresh);try{const w=dom.window;await w.openStaffEstimateAcceptance(fresh);assert.equal(w.document.querySelector('#staffAcceptReference'),null);w.document.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(w.calls.length,1);assert.equal(w.calls[0].payload.estimate_id,est.id);}finally{dom.window.close();}
});
if(process.env.STAFF_ACCEPTANCE_FIXTURE) {
 const styles=[...dashboard.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map(m=>m[0]).join('\n');
 fs.writeFileSync(process.env.STAFF_ACCEPTANCE_FIXTURE,'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'+styles+'<main id="pecModalRoot"></main><script>'+setup()+source+'\nopenStaffEstimateAcceptance(fixtureEstimate);</script>');
}
