import { calculateMbp } from './owner-mbp.js';
import { FOCUS_FIELDS, routineStatus } from './owner-routine.js';

// Public application code only. Owner data lives behind the authenticated API,
// in memory while signed in, and never in localStorage or a shared AI cache.
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const e = escapeHtml;
const fmt = (n, type='number') => n == null ? '—' : new Intl.NumberFormat('en-US', type==='money' ? {style:'currency',currency:'USD',maximumFractionDigits:0} : type==='percent' ? {style:'percent',maximumFractionDigits:1} : {maximumFractionDigits:1}).format(n);
const button = (text, action, primary=false, extra='') => `<button type="button" class="tc-button ${primary?'tc-primary':''}" data-action="${action}" ${extra}>${e(text)}</button>`;
const field = (label, name, value='', type='text', extra='') => `<label class="tc-field">${e(label)}${type==='textarea'?`<textarea name="${name}" rows="3" maxlength="6000" ${extra}>${e(value)}</textarea>`:`<input name="${name}" type="${type}" value="${e(value)}" ${extra}>`}</label>`;
const select = (label,name,value,options,extra='') => `<label class="tc-field">${e(label)}<select name="${name}" ${extra}>${options.map(([v,t])=>`<option value="${e(v)}" ${String(v)===String(value)?'selected':''}>${e(t)}</option>`).join('')}</select></label>`;
const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const NAV=[['focus','Morning focus'],['sales','Sales Plan'],['revenue','Revenue Produced'],['review','Weekly review'],['rocks','Q4 big rocks'],['problems','Problem solving'],['insights','AI insights'],['settings','Routine settings']];

export function checkinSaveMessage(status) {
  if(status==='completed') return 'Check-in completed and saved. You can continue to TopCoat.';
  if(status==='bypassed') return 'Emergency bypass saved. You can continue to TopCoat.';
  return status==='draft' ? 'Draft saved. Complete every answer, then choose Complete check-in.' : 'Your answers are private. Save before leaving.';
}

export function showCheckinSaving(root, target, action) {
  const label=action==='complete-focus'?'Completing check-in…':action==='bypass-focus'?'Recording bypass…':'Saving draft…';
  const originalLabel=target.textContent;
  const controls=[...root.querySelectorAll('button,input,textarea,select')].map(el=>[el,el.disabled]);
  root.setAttribute('aria-busy','true');
  root.querySelectorAll('.tc-save-status,.tc-focus-save-status').forEach(el=>el.textContent=label);
  controls.forEach(([el])=>el.disabled=true);
  target.textContent=label;
  // The request body has already been captured. Prevent edits from being
  // overwritten by the response, without clearing or replacing any answers.
  return ()=>{
    root.removeAttribute('aria-busy');
    controls.forEach(([el,disabled])=>el.disabled=disabled);
    target.textContent=originalLabel;
  };
}

export function mbpGroups(kind) {
  const week=(label,cols,type='number')=>({label,cols,type,heads:['Plan','Actual','Plan','Actual','Gap'].slice(0,cols.length),sub:cols.length===5?[['Per week',2],['Cumulative',3]]:[['Per week',2],['Cumulative',2]]});
  const group=(label,cols,heads,type,sub)=>({label,cols,heads,type,sub:[[sub,cols.length]]});
  return kind==='sales' ? [week('LEADS',['C','D','E','F']),week('ESTIMATES',['I','J','K','L']),week('JOBS BOOKED',['U','V','W','X']),week('$ BOOKED',['AA','AB','AC','AD','AE'],'money'),group('PLAN SETUP',['AH','AI'],['Booked plan %','Cumulative plan %'],'percent','Seasonal allocation'),group('LEAD CONVERSION',['AJ','AK','AL'],['Plan','Actual','Weekly override'],'percent','Leads → estimates'),group('SALES RATIO',['AM','AN','AO'],['Plan','Actual','Weekly override'],'percent','Estimates → jobs'),group('AVERAGE JOB SIZE',['AP','AQ','AR'],['Plan','Actual','Cumulative'],'money','$ per job booked')]
    : [week('$ PRODUCED',['C','D','E','F','G'],'money'),week('HOURS PRODUCED',['J','K','L','M']),group('PLAN SETUP',['P','Q'],['Plan %','Cumulative plan %'],'percent','Seasonal allocation'),group('CHARGE RATE',['R','S','T'],['Plan','Actual','Cumulative'],'money','$ per hour produced'),week('CUSTOM OPTION',['W','X','Y','Z'])];
}

export function renderMbpGrid(sheet, quarter='all') {
  const groups=mbpGroups(sheet.kind), cols=groups.flatMap(g=>g.cols.map((col,i)=>({col,type:g.type,start:i===0,actual:g.heads[i]==='Actual'})));
  const rows=sheet.rows.filter(r=>quarter==='all'||String(r.quarter).replace('Q','')===quarter.replace('Q',''));
  const cell=(r,c)=>{ const coverage=r.coverage?.[c.col], incomplete=coverage&&coverage.state!=='complete'; return `<td class="${c.start?'tc-mbp-divider':''} ${c.actual?'tc-mbp-actual':''}" title="${e(sheet.sourceTabName)}!${c.col}${r.sourceRow??''}${incomplete?' · Missing inputs; not a confirmed zero':''}">${fmt(r.v[c.col],c.type)}${incomplete?'<span class="tc-incomplete" aria-label="Missing inputs">*</span>':''}</td>`; };
  return `<div class="tc-mbp-scroll" tabindex="0" role="region" aria-label="${e(sheet.sourceTabName)}. Scroll horizontally for all columns."><table class="tc-mbp-table"><caption class="tc-sr-only">${e(sheet.sourceTabName)} weekly plan and actuals</caption><thead><tr><th rowspan="3">QTR</th><th rowspan="3" class="tc-mbp-date">WEEK ENDING</th>${groups.map((g,i)=>`<th colspan="${g.cols.length}" data-mbp-group="${i}" class="tc-mbp-divider">${g.label}</th>`).join('')}</tr><tr>${groups.map(g=>g.sub.map(([text,n])=>`<th colspan="${n}">${text}</th>`).join('')).join('')}</tr><tr>${groups.map(g=>g.heads.map(h=>`<th scope="col">${h}</th>`).join('')).join('')}</tr></thead><tbody>${rows.map(r=>`<tr><td>Q${String(r.quarter).replace('Q','')}</td><th scope="row" class="tc-mbp-date"><button type="button" data-action="edit-week" data-week="${r.weekEnding}">${r.weekEnding}</button></th>${cols.map(c=>cell(r,c)).join('')}</tr>`).join('')}</tbody><tfoot><tr><td></td><td class="tc-mbp-date">Full-year footer</td>${cols.map(c=>cell({v:sheet.footer},c)).join('')}</tr></tfoot></table></div><div class="tc-mbp-foot"><span>${rows.length} of ${sheet.rows.length} weeks. Footer is always full-year.</span><span>* Missing inputs, not a confirmed zero.</span></div>`;
}

export function createOwnerStudio({ getSession, openOwner, onAccess=()=>{}, fetchImpl=fetch, now=()=>new Date() }) {
  let uid=null, epoch=0, allowed=false, status=null, mount=null, page='focus', docs=new Map(), requests=new Set(), pending=new Map(), dirty=false, busy=false, message='', bootstrapPromise=null;
  let brand='total', quarter='all', week=null, editor=false, sourceView=false, insight='', crmPreview=null;
  let denied=false, retryAt=0, failures=0;
  const endpoint='/.netlify/functions/pec-owner-studio';
  const detach=()=>{if(mount){mount.oninput=null;mount.onchange=null;mount.onclick=null;}};
  const reset=()=>{
    epoch++; requests.forEach(c=>c.abort()); requests.clear(); uid=null; allowed=false; status=null; docs.clear(); pending.clear(); dirty=false; busy=false; bootstrapPromise=null; insight=''; crmPreview=null; page='focus'; message='';denied=false;retryAt=0;failures=0;
    detach(); if(mount?.isConnected) mount.replaceChildren(); mount=null; onAccess(false);
  };
  const api=async(action,body,params={})=>{
    const session=getSession(), id=session?.user?.id, generation=epoch;
    if(!id||id!==uid) throw new Error('Sign in again to open your private workspace.');
    const controller=new AbortController(); requests.add(controller);
    const timer=setTimeout(()=>controller.abort(),35000);
    try {
      const response=await fetchImpl(`${endpoint}?${new URLSearchParams({action,...params})}`,{method:body===undefined?'GET':'POST',cache:'no-store',signal:controller.signal,headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const result=await response.json();
      if(generation!==epoch||getSession()?.user?.id!==id) throw new Error('Account changed. Private workspace cleared.');
      if(!response.ok) {
        if(response.status===401||response.status===403) {reset();uid=id;denied=response.status===403;retryAt=new Date(now()).getTime()+30000;}
        throw Object.assign(new Error(result.error||'Request failed. Reload before retrying.'),{status:response.status});
      }
      return result;
    } finally { clearTimeout(timer); requests.delete(controller); }
  };
  const due=()=>allowed&&status&&routineStatus(now(),status.config,docs.get(`focus:${status.routine.day}`)||status.focus).due;
  const bootstrap=()=>{
    const id=getSession()?.user?.id;
    if(id!==uid) { reset(); uid=id||null; }
    if(!uid) return Promise.resolve(false);
    if(bootstrapPromise) return bootstrapPromise;
    const generation=epoch;
    const promise=(async()=>{
      try {
        const result=await api('status');
        if(generation!==epoch) return false;
        status=result; allowed=true;denied=false;failures=0;retryAt=0;
        if(result.focus && !dirty) docs.set(result.focus.doc_key,result.focus);
        onAccess(true);
        if(due()) { page='focus'; openOwner(); }
        return true;
      } catch(err) { if(generation===epoch) { message=err.message;failures++;retryAt=new Date(now()).getTime()+Math.min(300000,30000*2**(failures-1));onAccess(allowed?true:null); } return false; }
      finally { if(bootstrapPromise===promise) bootstrapPromise=null; }
    })();
    bootstrapPromise=promise; return promise;
  };
  const getDoc=async(key,body={})=>{
    if(!docs.has(key)) { const result=await api('document',undefined,{key}); docs.set(key,result.document||{doc_key:key,revision:0,body}); }
    return docs.get(key);
  };
  const save=async(key,body)=>{
    const doc=docs.get(key), encoded=JSON.stringify(body), previous=pending.get(key);
    const request=previous?.encoded===encoded?previous:{encoded,id:crypto.randomUUID()}; pending.set(key,request);
    const result=await api('save',{key,body,revision:doc?.revision||0,requestId:request.id});
    docs.set(key,result.document); pending.delete(key); dirty=false; message='Saved privately. All changes are up to date.';
    if(key.startsWith('focus:')) status.focus=result.document;
    return result.document;
  };
  const year=()=>Number(status?.routine.day.slice(0,4)||2026);
  const focusKey=()=>`focus:${status.routine.day}`;
  const mbpKey=()=>`${sourceView?'source':'mbp'}:${year()}`;
  const planKey=()=>`plan:${year()}-q4`;
  const reviewKey=()=>`review:${status.routine.priorWeekEnding}`;
  const head=(eyebrow,title,subtitle)=>`<div class="tc-pagehead"><div><div class="tc-eyebrow">${e(eyebrow)}</div><h1>${e(title)}</h1><p class="tc-subtitle">${e(subtitle)}</p></div></div>`;
  const note=(text)=>`<div class="tc-notice">${e(text)}</div>`;
  const snapshotNotice=body=>note(body?.source ? `Imported reference: ${body.source.file||'MBP 2026'}. Original actuals stop ${body.source.lastEntry||'May 10, 2026'}. Blank weeks are not zero. ${body.status==='active'?'Active working plan.':'Draft planning assumptions; not yet your approved Q4 targets.'}` : 'This is a private working plan. Review assumptions and data coverage before drawing conclusions.');
  function focusPage() {
    const doc=docs.get(focusKey()), answers=doc.body.answers||{}, items=docs.get(planKey())?.body.items||[];
    return head('DAILY ALIGNMENT', 'Start with what matters.', `${DAYS[status.routine.weekday]} · ${status.routine.day} · ${status.config.morningMinutes}-minute target`)+
      `<div class="tc-notice ${due()?'tc-warning':''}">${due()?'Your morning check-in is due. Answer every prompt and choose Complete check-in to unlock the rest of TopCoat, or record an emergency bypass.':doc.body.status==='completed'?'Check-in completed and saved. Your priorities are set.':doc.body.status==='bypassed'?'Emergency bypass recorded for today. You can still complete your check-in.':'Your private morning alignment. Answer every prompt, then choose Complete check-in. There is no minimum timer.'}</div>`+
      `<div class="tc-focus-context"><section class="tc-panel"><h3>Q4 focus</h3><p>Lead flow · Cash flow · Sales</p><p class="tc-muted tc-small">September preparation, then Q4 execution. Team morale, mission, and core values stay central.</p>${items.slice(0,3).map(i=>`<p class="tc-small">${e(i.title)} · ${e(i.checkpoint||'Set a weekly checkpoint')}</p>`).join('')}</section><section class="tc-panel"><h3>Today’s standard</h3><p>One clear commitment. One protected block. One problem addressed.</p><p class="tc-muted tc-small">Monday includes both morning focus and the ${e(status.config.weeklyTime)} weekly review.</p></section></div>`+
      `<form data-form="focus" class="tc-panel">${FOCUS_FIELDS.map(([key,label],i)=>field(`${String(i+1).padStart(2,'0')} · ${label}`,key,answers[key],'textarea')).join('')}<div class="tc-focus-save-status" role="status" aria-live="polite">${e(message||checkinSaveMessage(doc.revision?doc.body.status:null))}</div><div class="tc-actionbar"><span class="tc-small tc-muted">${doc.body.status==='completed'?'Your saved check-in is complete.':'Saving a draft does not complete the check-in.'}</span><div class="tc-row">${button('Save draft','save-focus')}${button('Complete check-in','complete-focus',true)}</div></div><details class="tc-mbp-sources"><summary>Emergency bypass</summary><p>Only use this when something truly cannot wait. Your reason remains in the private check-in history.</p>${field('Why do you need to bypass today?','bypassReason',doc.body.bypassReason,'textarea')}${button('Record bypass and continue','bypass-focus')}<div class="tc-focus-save-status" role="status" aria-live="polite">${e(message)}</div></details></form>`+
      `<div class="tc-actionbar">${button('Recent check-ins','recent-focus')}${button('Back to TopCoat','leave')}</div><div data-recent></div>`;
  }
  function summary(sheet) {
    const t=sheet.top;
    const table=(title,heads,rows)=>`<section><h3>${title}</h3><table><thead><tr><th></th>${heads.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(([label,a,b,type])=>`<tr><th scope="row">${label}</th><td>${fmt(a,type)}</td><td>${fmt(b,type)}</td></tr>`).join('')}</tbody></table></section>`;
    return `<div class="tc-mbp-summary">${sheet.kind==='sales'?table('Annual sales plan',['Plan','Trend*'],[['TOTAL Sales',t.C4,t.E4,'money'],['New Sales',t.C5,t.E5,'money'],['Carry Over Sales',t.C6,t.E6,'money'],['Recurring Contracts',t.C7,t.E7,'money']])+table('Planning assumptions',['Plan','Recorded YTD'],[['Lead Conversion',t.K4,t.L4,'percent'],['Sales Ratio',t.K5,t.L5,'percent'],['Average Job Size',t.K6,t.L6,'money']]):table('Annual production plan',['Plan','Trend*'],[['$ Produced',t.C4,t.D4,'money']])+table('Charge rate',['Plan','Recorded YTD'],[['$ per hour produced',t.C6,t.D6,'money']])}</div>`;
  }
  function workbookPage(kind) {
    const doc=docs.get(mbpKey());
    if(!doc?.body.mbp) return head('YOUR MBP',kind==='sales'?'Sales Plan':'Revenue Produced','Private workbook connection')+note('Your original workbook is not imported yet. No sample numbers are being substituted.');
    const computed=calculateMbp(doc.body.mbp), sheet=computed.sheets.find(s=>s.kind===kind&&s.businessLineId===brand);
    return head('YOUR MBP · '+year(),kind==='sales'?'Sales Plan':'Revenue Produced','The original weekly plan, actuals, and cumulative view.')+
      `<div class="tc-mbp-tabs" aria-label="Workbook tabs">${computed.sheets.filter(s=>s.kind===kind).map(s=>`<button type="button" data-action="brand" data-brand="${s.businessLineId}" aria-pressed="${brand===s.businessLineId}">${e(s.sourceTabName)}</button>`).join('')}</div>`+summary(sheet)+snapshotNotice(doc.body)+
      `<div class="tc-mbp-bar">${select('Period','quarter',quarter,[['all','Full year'],['1','Q1'],['2','Q2'],['3','Q3'],['4','Q4']],'data-change="quarter"')}<div class="tc-row">${button(sourceView?'Return to working plan':'View original snapshot','source')}${sourceView?'':button('Plan assumptions','assumptions')}${sourceView?'':button('Weekly entry','edit-week',true)}</div></div>`+
      `<p class="tc-small tc-muted">* Seasonal annualization through ${e(doc.body.mbp.asOfWeekEnding)}; incomplete inputs are not a current forecast. Painting = FTP (manual). Epoxy = PEC (CRM review).</p>`+
      (editor&&!sourceView?weeklyEditor(kind,doc.body.mbp):'')+
      `<div class="tc-mbp-jumps"><span>Jump to</span>${mbpGroups(kind).map((g,i)=>button(g.label,'jump',false,`data-group="${i}"`)).join('')}</div>`+renderMbpGrid(sheet,quarter)+
      `<details class="tc-mbp-sources"><summary>Workbook details and data rules</summary><p>Original week-ending dates and source-cell references are retained. Blue columns are actuals. TOTAL combines Painting and Epoxy with missing-input markers. A blank is not a confirmed zero. Future cumulative gaps are workbook arithmetic, not a current performance verdict.</p><p>Sales means booked work. Revenue means produced work, not cash collected. Year-footer ratios average weekly ratios, while summary ratios use totals, matching the source. The source’s disabled claims scenario is not activated. Custom Option totals in the working plan sum entered values; the original workbook had a literal-zero custom footer.</p><p>Edits save only to your private TopCoat working copy. They never change the uploaded workbook, source snapshot, or customer/job records. Revision conflicts do not overwrite another window.</p></details>`;
  }
  function weeklyEditor(kind,input) {
    const selected=brand==='total'?'painting':brand, line=input.lines.find(l=>l.id===selected);
    const row=line[kind].weekly.find(r=>r.weekEnding===week)||line[kind].weekly[0]; week=row.weekEnding;
    const fields=kind==='sales'?[['leads','Leads'],['estimates','Estimates'],['jobsBooked','Jobs booked'],['bookedDollars','$ booked']]:[['producedDollars','$ produced'],['laborHours','Hours produced'],['custom','Custom actual']];
    return `<form class="tc-mbp-editor" data-form="weekly"><h3>Week ending ${week} · ${line.label} (${selected==='painting'?'FTP manual':'PEC reviewed actuals'})</h3>${select('Week ending','week',week,input.weekEndings.map(d=>[d,d]),'data-change="week"')}<div class="tc-two-fields">${fields.map(([key,label])=>field(label,key,row.actual?.[key]??'','number',`step="${/Dollars|Hours|custom/.test(key)?'any':'1'}" ${/leads|estimates|jobsBooked|laborHours/.test(key)?'min="0"':''} placeholder="Not entered"`)).join('')}</div>${kind==='revenue'?field('Custom weekly plan','customPlan',row.customPlan??'','number','step="any"'):field('Lead conversion override (0–1, blank uses plan)','leadConversionOverride',row.leadConversionOverride??'','number','min="0" max="1" step="any"')+field('Sales ratio override (0–1, blank uses plan)','salesRatioOverride',row.salesRatioOverride??'','number','min="0" max="1" step="any"')}<div class="tc-actionbar"><span class="tc-small tc-muted">Blank stays unknown. Zero is an explicit entry.</span><div class="tc-row">${selected==='epoxy'?button('Preview PEC CRM actuals','crm-preview'):''}${button('Cancel','close-editor')}${button('Save this week','save-week',true)}</div></div><div data-crm-preview></div></form>`;
  }
  function assumptionsPage() {
    const doc=docs.get(`mbp:${year()}`);
    if(!doc?.body.mbp) return note('Import your MBP before editing plan assumptions.');
    const input=doc.body.mbp;
    const sales=[['newSales','New sales ($)'],['carryOver','Carry-over sales ($)'],['recurring','Recurring contracts ($)'],['leadConversion','Lead conversion (0–1)'],['salesRatio','Sales ratio (0–1)'],['averageJobSize','Average job size ($)']];
    return head('PLAN SETUP','Make the targets yours.','Imported assumptions are a starting point. Set Q4 rocks separately; nothing activates automatically.')+`<form data-form="assumptions" class="tc-panel">${select('Review through week','asOfWeekEnding',input.asOfWeekEnding,input.weekEndings.map(d=>[d,d]))}${select('Plan status','status',doc.body.status,[['draft','Draft, still planning'],['active','Active, approved by me']])}${input.lines.map(line=>`<section><h2>${e(line.label)} · ${line.id==='painting'?'FTP':'PEC'}</h2><div class="tc-two-fields">${sales.map(([key,label])=>field(label,`${line.id}.sales.${key}`,line.sales[key]??'','number','step="any"')).join('')}${field('Annual produced revenue ($)',`${line.id}.revenue.annualProduced`,line.revenue.annualProduced,'number','step="any"')}${field('Production charge rate ($/hour)',`${line.id}.revenue.chargeRate`,line.revenue.chargeRate,'number','step="any"')}</div><details class="tc-mbp-sources"><summary>Advanced: weekly seasonal allocations</summary><p>Weights are fractions. Each column must total 1 (100%). No silent redistribution.</p><div class="tc-weight-scroll"><table class="tc-table"><thead><tr><th>Week ending</th><th>Sales weight</th><th>Revenue weight</th></tr></thead><tbody>${input.weekEndings.map((d,i)=>`<tr><th>${d}</th><td>${field('Sales '+d,`${line.id}.sales.weight.${i}`,line.sales.weekly[i].weight,'number','step="any" min="0" max="1"')}</td><td>${field('Revenue '+d,`${line.id}.revenue.weight.${i}`,line.revenue.weekly[i].weight,'number','step="any" min="0" max="1"')}</td></tr>`).join('')}</tbody></table></div></details></section>`).join('')}<div class="tc-actionbar">${button('Back to workbook','back-workbook')}${button('Save plan assumptions','save-assumptions',true)}</div></form>`;
  }
  function reviewPage() {
    const doc=docs.get(reviewKey()), body=doc.body;
    return head('MONDAY · '+status.config.weeklyTime,'Review. Decide. Commit.',`Week ended ${status.routine.priorWeekEnding} · ${status.config.weeklyMinutes}-minute target. Morning check-in stays separate.`)+
      `<div class="tc-mbp-linkcards"><button data-action="go-sales"><span>01 · WEEKLY NUMBERS</span><strong>Sales Plan</strong><span>Enter FTP, reconcile PEC, review plan vs actual.</span></button><button data-action="go-revenue"><span>02 · PRODUCTION</span><strong>Revenue Produced</strong><span>Review dollars, hours, and charge rate.</span></button></div><form data-form="review" class="tc-panel"><label class="tc-check"><input type="checkbox" name="numbersReviewed" ${body.numbersReviewed?'checked':''}> I reviewed the sales and production numbers and their missing-data warnings.</label>${field('What do the numbers tell you? What is the biggest constraint?','notes',body.notes,'textarea')}${field('Cash-flow review: collections, upcoming payments, and action needed','cashFlow',body.cashFlow,'textarea')}${field('Next week’s commitment and measurable checkpoint','commitment',body.commitment,'textarea')}<div class="tc-actionbar"><span>${body.status==='completed'?'Review completed and saved.':'Saved weekly reviews preserve your decisions.'}</span><div class="tc-row">${button('Save draft','save-review')}${button('Complete weekly review','complete-review',true)}</div></div></form>`;
  }
  function listPage(kind) {
    const rocks=kind==='rocks', items=docs.get(rocks?planKey():'problems').body.items;
    return head(rocks?'SEPTEMBER PREP → Q4 EXECUTION':'BREAK THE REPEAT CYCLE',rocks?'Your big rocks.':'Solve it at the source.',rocks?'Lead flow, cash flow, and sales, grounded in team morale, mission, and core values.':'Name the pattern. Test a response. Review what changed.')+
      `<form data-form="items"><div class="tc-items">${items.map((item,i)=>`<section class="tc-panel" data-item="${i}"><div class="tc-row"><span class="tc-tag">${rocks?'ROCK':'PROBLEM'} ${i+1}</span>${select('Status',`status-${i}`,item.status||'planned',rocks?[['planned','Planned'],['on-track','On track'],['at-risk','At risk'],['done','Done']]:[['planned','Open'],['testing','Testing a solution'],['resolved','Resolved']])}</div>${field(rocks?'Outcome / big rock':'Repeating difficulty',`title-${i}`,item.title)}${field(rocks?'Measurable target and definition of done':'Likely root cause',`target-${i}`,item.target,'textarea')}${field(rocks?'This week’s checkpoint':'Next experiment and success measure',`checkpoint-${i}`,item.checkpoint,'textarea')}${field('Review date',`date-${i}`,item.date,'date')}${field('Progress, evidence, and lessons',`notes-${i}`,item.notes,'textarea')}</section>`).join('')||note(rocks?'Add up to five clear rocks to begin. Define success before adding tasks.':'No problems logged yet. Capture a repeating issue and one experiment to change it.')}</div><div class="tc-actionbar">${button(rocks?'Add a rock':'Log a problem','add-item')}${button('Save changes','save-items',true)}</div></form>`;
  }
  function insightsPage() { return head('PRIVATE · ON REQUEST','Turn numbers into decisions.','A direct, practical second look at your goals and progress.')+`<section class="tc-panel"><p>Generate sends your saved Q4 goals and MBP KPI summaries to Anthropic. Private check-in answers and problem notes are included only if selected below. No request is made until you click the button. Suggestions never change your plan or calendar.</p><label class="tc-check"><input type="checkbox" name="includeFocus"> Include today’s saved check-in answers</label><label class="tc-check"><input type="checkbox" name="includeProblems"> Include saved problem-solving notes</label>${button('Generate insights','generate-insights',true)}<p class="tc-small tc-muted">AI can make mistakes. Verify the numbers and choose the actions yourself.</p></section><section class="tc-panel tc-insight" data-insight aria-live="polite">${e(insight||'Your requested analysis will appear here. Nothing has been sent automatically.')}</section>`; }
  function settingsPage() {
    const c=status.config;
    return head('YOUR ROUTINE','Protect the time.','Private owner settings. All schedule times use the selected timezone.')+`<form data-form="settings" class="tc-panel">${select('Morning check-in required','owner_studio_enabled',String(c.enabled),[['true','On'],['false','Off']])}${field('Morning start','owner_morning_time',c.morningTime,'time')}<details class="tc-mbp-sources"><summary>Advanced schedule</summary><div class="tc-two-fields">${select('Weekly review day','owner_weekly_day',c.weeklyDay,DAYS.map((d,i)=>[i,d]))}${field('Weekly review start','owner_weekly_time',c.weeklyTime,'time')}${field('Morning target minutes','owner_morning_target_minutes',c.morningMinutes,'number','min="1" max="180"')}${field('Weekly target minutes','owner_weekly_target_minutes',c.weeklyMinutes,'number','min="1" max="180"')}${field('Timezone','owner_timezone',c.timezone)}</div><fieldset><legend>Morning days</legend>${DAYS.map((d,i)=>`<label class="tc-check"><input type="checkbox" name="day" value="${i}" ${c.morningDays.includes(i)?'checked':''}>${d}</label>`).join('')}</fieldset></details><div class="tc-actionbar">${button('Save routine','save-settings',true)}</div><p class="tc-small tc-muted">This controls TopCoat’s opening requirement, not a computer alarm. Calendar block creation and automated calendar adherence checks are not connected in this release.</p></form>`;
  }
  async function loadPage() {
    if(page==='focus') { await getDoc(focusKey(),{status:'draft',answers:{}}); await getDoc(planKey(),{items:[]}); }
    if(['sales','revenue','assumptions'].includes(page)) await getDoc(page==='assumptions'?`mbp:${year()}`:mbpKey(),{});
    if(page==='review') await getDoc(reviewKey(),{status:'draft'});
    if(page==='rocks') await getDoc(planKey(),{items:[]});
    if(page==='problems') await getDoc('problems',{items:[]});
  }
  function draw() {
    if(!mount?.isConnected||!allowed) return;
    const content=page==='focus'?focusPage():['sales','revenue'].includes(page)?workbookPage(page):page==='assumptions'?assumptionsPage():page==='review'?reviewPage():['rocks','problems'].includes(page)?listPage(page):page==='insights'?insightsPage():settingsPage();
    mount.innerHTML=`<div id="topcoat-owner-studio"><div class="tc-shell"><aside class="tc-sidebar"><div class="tc-logo"><span class="tc-logo-mark">T</span>TopCoat</div><div class="tc-private">My Eyes Only · Private</div><nav class="tc-nav" aria-label="Owner workspace">${NAV.map(([id,label])=>`<button type="button" data-page="${id}" ${page===id?'aria-current="page"':''}>${label}</button>`).join('')}</nav><div class="tc-side-note"><strong>Direction before distraction.</strong>One priority. A protected block. Progress you can measure.</div></aside><main class="tc-main"><div class="tc-topbar"><strong>Owner workspace</strong><span class="tc-beta">UI BETA</span><span>${e(status.routine.day)}</span></div><div class="tc-content"><div class="tc-save-status" role="status">${e(message)}</div>${content}</div></main></div></div>`;
    mount.oninput=event=>{if(!mount||event.target.dataset.change||page==='insights')return;dirty=true; mount.querySelectorAll('.tc-save-status,.tc-focus-save-status').forEach(el=>el.textContent='Unsaved changes. Save before leaving.');};
    mount.onchange=event=>{const change=event.target.dataset.change; if(change){ if(dirty&&!confirm('Discard unsaved edits and change this view?')) {event.target.value=change==='week'?week:quarter;return;} dirty=false; if(change==='quarter')quarter=event.target.value; if(change==='week')week=event.target.value; draw(); }};
    mount.onclick=click;
  }
  async function navigate(next) {
    if(dirty) {if(!confirm('Discard unsaved changes? Saved records will stay intact.')) return;docs.clear();}
    dirty=false; page=next; editor=false; message=''; await loadPage(); draw();
  }
  const formData=name=>Object.fromEntries(new FormData(mount.querySelector(`[data-form="${name}"]`)));
  const numeric=value=>value===''?null:Number(value);
  function collectItems() {
    const key=page==='rocks'?planKey():'problems', existing=docs.get(key), data=formData('items');
    return {key,body:{...existing.body,items:existing.body.items.map((item,i)=>({...item,...Object.fromEntries(['title','target','checkpoint','date','notes','status'].map(k=>[k,data[`${k}-${i}`]||'']))}))}};
  }
  async function click(event) {
    const target=event.target.closest('button'); if(!target||busy) return;
    const generation=epoch; busy=true;
    try {
      if(target.dataset.page) {await navigate(target.dataset.page);return;}
      const action=target.dataset.action;
      if(action==='leave') { if(due()) throw new Error('Complete your saved check-in or record an emergency bypass first.'); if(!dirty||confirm('Discard unsaved edits and return to TopCoat?')) {dirty=false; window.pecSwitchView?.('dashboard');} return; }
      if(action==='source') { if(dirty&&!confirm('Discard unsaved edits?'))return; dirty=false;sourceView=!sourceView;editor=false;await loadPage(); }
      if(action==='brand') { if(dirty&&!confirm('Discard unsaved edits?'))return;dirty=false;brand=target.dataset.brand;editor=false; }
      if(action==='edit-week') { if(sourceView)throw new Error('The original snapshot is read-only. Return to the working plan to edit.'); editor=true; week=target.dataset.week||week||status.routine.priorWeekEnding; }
      if(action==='close-editor') {if(dirty&&!confirm('Discard unsaved weekly entries?'))return;editor=false;dirty=false;}
      if(action==='jump') { const scroller=mount.querySelector('.tc-mbp-scroll'), group=mount.querySelector(`[data-mbp-group="${target.dataset.group}"]`);scroller.scrollTo({left:group.offsetLeft-130,behavior:'smooth'});return; }
      if(action==='assumptions') { await navigate('assumptions');return; }
      if(action==='back-workbook'||action==='go-sales'||action==='go-revenue') {await navigate(action==='go-revenue'?'revenue':'sales');return;}
      if(['save-focus','complete-focus','bypass-focus'].includes(action)) {
        const data=formData('focus'), release=showCheckinSaving(mount,target,action);
        try {
          const doc=await save(focusKey(),{status:action==='complete-focus'?'completed':action==='bypass-focus'?'bypassed':'draft',answers:Object.fromEntries(FOCUS_FIELDS.map(([k])=>[k,data[k]||''])),bypassReason:data.bypassReason||''});
          message=checkinSaveMessage(doc.body.status);
        } finally {release();}
      }
      if(action==='save-week') {
        const data=formData('weekly'), doc=docs.get(`mbp:${year()}`), body=structuredClone(doc.body), selected=brand==='total'?'painting':brand;
        const row=body.mbp.lines.find(l=>l.id===selected)[page].weekly.find(r=>r.weekEnding===week);
        const keys=page==='sales'?['leads','estimates','jobsBooked','bookedDollars']:['producedDollars','laborHours','custom'];
        row.actual={...row.actual,...Object.fromEntries(keys.map(k=>[k,numeric(data[k])]))};
        if(page==='sales') {row.leadConversionOverride=numeric(data.leadConversionOverride);row.salesRatioOverride=numeric(data.salesRatioOverride);} else row.customPlan=numeric(data.customPlan);
        calculateMbp(body.mbp); await save(`mbp:${year()}`,body);editor=false;
      }
      if(action==='save-assumptions') {
        const data=formData('assumptions'), body=structuredClone(docs.get(`mbp:${year()}`).body);body.status=data.status;body.mbp.asOfWeekEnding=data.asOfWeekEnding;
        for(const line of body.mbp.lines) for(const kind of ['sales','revenue']) {
          for(const key of kind==='sales'?['newSales','carryOver','recurring','leadConversion','salesRatio','averageJobSize']:['annualProduced','chargeRate']) line[kind][key]=numeric(data[`${line.id}.${kind}.${key}`]);
          line[kind].weekly.forEach((row,i)=>row.weight=numeric(data[`${line.id}.${kind}.weight.${i}`]));
        }
        calculateMbp(body.mbp);await save(`mbp:${year()}`,body);
      }
      if(action==='save-review'||action==='complete-review') {const data=formData('review');await save(reviewKey(),{...data,numbersReviewed:data.numbersReviewed==='on',status:action==='complete-review'?'completed':'draft'});}
      if(action==='add-item'||action==='save-items') {const {key,body}=collectItems(); if(action==='add-item'){body.items.push({id:crypto.randomUUID(),title:'',status:'planned'});docs.get(key).body=body;dirty=true;}else{if(body.items.some(i=>!i.title.trim()))throw new Error('Give each item a clear title before saving.');await save(key,body);}}
      if(action==='save-settings') {const data=formData('settings');delete data.day;data.owner_morning_days=JSON.stringify([...mount.querySelectorAll('[name="day"]:checked')].map(el=>Number(el.value)));await api('settings',{values:data});dirty=false;message='Routine settings saved.';await bootstrap();}
      if(action==='recent-focus') {const result=await api('recent-focus');if(generation!==epoch)return;mount.querySelector('[data-recent]').innerHTML=result.documents.map(d=>`<details class="tc-panel"><summary>${e(d.doc_key.slice(6))} · ${e(d.body.status)}</summary>${FOCUS_FIELDS.map(([key,label])=>`<h3>${e(label)}</h3><p class="tc-preserve">${e(d.body.answers?.[key]||'Not entered')}</p>`).join('')}${d.body.bypassReason?`<p>Bypass reason: ${e(d.body.bypassReason)}</p>`:''}</details>`).join('')||note('No saved check-ins yet.');return;}
      if(action==='generate-insights') { const region=mount.querySelector('[data-insight]');region.textContent='Analyzing your saved goals and selected information…';const result=await api('insights',{requested:true,year:year(),includeFocus:mount.querySelector('[name="includeFocus"]').checked,includeProblems:mount.querySelector('[name="includeProblems"]').checked});insight=result.text;dirty=false; }
      if(action==='crm-preview') {const result=await api('crm-week',undefined,{week});crmPreview=result;const region=mount.querySelector('[data-crm-preview]');region.innerHTML=`<div class="tc-notice"><strong>CRM preview only</strong><p>${e(result.description)}</p>${Object.entries(result.actual).map(([k,v])=>`<p>${e(k)}: ${fmt(v)}</p>`).join('')}<p>${e(result.warnings.join(' '))}</p><p>Review these values before entering them above. This does not overwrite your workbook.</p></div>`;return;}
      if(generation===epoch) draw();
    } catch(err) {if(generation===epoch&&mount?.isConnected){message=err.message;mount.querySelectorAll('.tc-save-status,.tc-focus-save-status').forEach(el=>el.textContent=message);}}
    finally {if(generation===epoch)busy=false;}
  }
  const render=async(root)=>{
    mount=root; const generation=epoch;
    if(!allowed&&!await bootstrap()) { if(root.isConnected) root.textContent=message||'This workspace is private to its owner.'; return; }
    if(generation!==epoch&&getSession()?.user?.id!==uid)return;
    await loadPage(); if(mount===root&&root.isConnected)draw();
  };
  const canLeave=()=>!due()&&(!dirty||confirm('Discard unsaved owner-workspace edits?'));
  const tick=()=>{if(getSession()?.user?.id!==uid){reset();return;}if(uid&&!denied&&retryAt&&new Date(now()).getTime()>=retryAt){void bootstrap();return;}if(allowed&&status){const current=routineStatus(now(),status.config,status.focus);if(current.day!==status.routine.day){if(dirty)return;docs.clear();status.routine=current;void bootstrap();}else if(due()&&!document.getElementById('topcoat-owner-studio'))openOwner();}};
  if(typeof window!=='undefined') {
    setInterval(tick,30000);
    window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
    // Outer Cockpit/crew/CRM tabs must obey the same required check-in. Server
    // authorization, not this convenience guard, protects private records.
    document.addEventListener('click',event=>{const nav=event.target.closest?.('[data-tab], [data-pec-view], [data-rd-view]');if(!nav||nav.closest('#topcoat-owner-studio'))return;if(due()){event.preventDefault();event.stopImmediatePropagation();openOwner();}},true);
  }
  return {bootstrap,render,reset,due,canLeave,tick,isAllowed:()=>allowed,sessionChanged:()=>{if(getSession()?.user?.id!==uid)reset();},unmount:()=>{detach();mount=null;dirty=false;docs.clear();}};
}
