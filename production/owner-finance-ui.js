// Source workbook data is supplied by the private owner endpoint, never bundled.
const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function financeColumn(n) { let s=''; for(;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s; return s; }
function coordinate(address) { const [,letters,row]=address.match(/^([A-Z]+)(\d+)$/);return [Number(row),[...letters].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)]; }
// Raw imports retain spreadsheet caches rather than the working model's schema.
// Borrow only layout by sheet name; no working values, formulas, or entry ranges
// may appear in the immutable snapshot, even after the working plan is edited.
export function financeSnapshotView(snapshot, workingBody) {
  const view=structuredClone(snapshot),normalize=name=>String(name||'').trim().toLowerCase();
  const layouts=new Map((workingBody?.sheets||[]).map(sheet=>[normalize(sheet.name),sheet]));
  const layoutFields=['id','kind','rows','cols','rowHeights','colWidths','freezeRows','freezeCols'];
  view.sheets=(view.sheets||[]).map((source,index)=>{
    const layout=layouts.get(normalize(source.name)),sheet={};
    for(const field of layoutFields)if(layout?.[field]!==undefined)sheet[field]=structuredClone(layout[field]);
    Object.assign(sheet,source);
    delete sheet.inputRanges;
    sheet.cells||={};
    let rows=1,cols=1;
    const include=range=>{
      if(typeof range!=='string')return;
      for(const address of range.split(':'))if(/^[A-Z]+[1-9]\d*$/.test(address)){
        const [r,c]=coordinate(address);rows=Math.max(rows,r);cols=Math.max(cols,c);
      }
    };
    for(const address of Object.keys(sheet.cells||{}))include(address);
    for(const range of sheet.merges||[])include(range);
    for(const [address,array] of Object.entries(sheet.arrayFormulas||{})){
      include(address);include(array.ref);
      if(typeof array.f==='string')sheet.cells[address]={v:null,...sheet.cells[address],f:array.f};
    }
    if(Array.isArray(sheet.styleRanges))for(const item of sheet.styleRanges)include(item.range);
    else for(const ranges of Object.values(sheet.styleRanges||{}))for(const range of ranges)include(range);
    for(const r of sheet.hiddenRows||[])if(Number.isInteger(r))rows=Math.max(rows,r);
    for(const c of sheet.hiddenCols||[])if(Number.isInteger(c))cols=Math.max(cols,c);
    sheet.rows=Math.max(rows,Number(sheet.rows)||0);sheet.cols=Math.max(cols,Number(sheet.cols)||0);
    const name=normalize(sheet.name);
    sheet.kind||=/\bincome\s+statement\b/.test(name)?'income':/\bbudget\b/.test(name)?'budget':'support';
    sheet.id||=`source-${index}`;
    sheet.cells=Object.fromEntries(Object.entries(sheet.cells||{}).map(([address,original])=>{
      const cell={...original,editable:false};
      if(cell.format!==undefined){
        cell.format=view.formats?.[cell.format]??cell.format;
        if(typeof cell.format==='string'&&!cell.t)cell.t=cell.format.includes('%')?'percent':cell.format.includes('$')?'money':/mmmm|yyyy|dd/i.test(cell.format)?'date':'number';
      }
      return [address,cell];
    }));
    return sheet;
  });
  return view;
}
export function financeInputCell(sheet,address) {
  const cell=sheet.cells[address]||{},[r,c]=coordinate(address);
  const range=(sheet.inputRanges||[]).find(item=>{const [a,b=a]=item.range.split(':'),[r1,c1]=coordinate(a),[r2,c2]=coordinate(b);return r>=r1&&r<=r2&&c>=c1&&c<=c2;});
  return {...range,...cell,editable:!cell.f&&(cell.editable===true||!!range)};
}
export function financeInputValue(cell) {
  if(cell.t==='date'&&typeof cell.v==='number')return new Date(Date.UTC(1899,11,30)+cell.v*86400000).toISOString().slice(0,10);
  if(cell.t==='money'&&typeof cell.v==='number')return new Intl.NumberFormat('en-US',{maximumFractionDigits:10}).format(cell.v);
  return cell.v == null ? '' : cell.t==='percent'&&typeof cell.v==='number' ? `${Number((cell.v*100).toPrecision(12))}%` : String(cell.v);
}
export function parseFinanceInput(value, cell) {
  const text=value.trim();
  if(cell.t==='text'||typeof cell.v==='string'&&!['money','number','percent','date'].includes(cell.t))return value;
  if(!text)return null;
  if(cell.t==='date') {const ms=Date.parse(text+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(text)||!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==text)throw new Error('Enter a valid date as YYYY-MM-DD.');return typeof cell.v==='number'?(ms-Date.UTC(1899,11,30))/86400000:text;}
  const cleaned=text.replace(/[$,\s]/g,'').replace(/^\((.*)\)$/,'-$1'), pct=cleaned.endsWith('%'),raw=pct?cleaned.slice(0,-1):cleaned;
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)||!Number.isFinite(Number(raw)))throw new Error('Enter a number, or leave the field blank.');
  return Number(raw)/(pct||cell.t==='percent'?100:1);
}
// Account rows carry an explicit company tag in the document (sheet.companyRows) and
// live inside stored slot sections (sheet.accountSections). Nothing below infers
// ownership from row numbers; a document without tags renders exactly as before.
export const FINANCE_COMPANIES=[['combined','Combined (PEC + FTP)'],['PEC','PEC only'],['FTP','FTP only']];
export const FINANCE_SAVE_LIMIT_BYTES=1800000;
// Template slots keep their workbook placeholder names ("Fixed Exp 67"); those count as empty.
const PLACEHOLDER=/^(?:variable exp line|fixed exp)\s*\d+$/i;
export function financeIsEmptyLabel(value){const text=value==null?'':String(value).trim();return !text||PLACEHOLDER.test(text);}
export function financeRowHasValues(sheet,row){
  for(let c=3;c<=14;c++){const v=sheet.cells[financeColumn(c)+row]?.v;if(v===null||v===undefined||v===''||v===0)continue;return true;}
  return false;
}
export function financeSectionRows(sheet){
  const map=new Map();
  for(const section of sheet.accountSections||[]){const [a,b]=String(section.rows).split(':').map(Number);for(let r=a;r<=(b||a);r++)map.set(r,section);}
  return map;
}
// Hidden rows for an income sheet: untagged rows keep the workbook's static hiddenRows;
// tagged rows follow the rule "shows when named or when any month has a value",
// the company filter, and the Show empty slots toggle.
export function financeIncomeHiddenRows(sheet,computed,{company='combined',showEmpty=false,showHidden=false}={}){
  const hidden=new Set(showHidden?[]:sheet.hiddenRows||[]);
  for(const [key,tag] of Object.entries(sheet.companyRows||{})){
    const row=Number(key);hidden.delete(row);
    if(company!=='combined'&&tag!==company){hidden.add(row);continue;}
    if(showHidden||showEmpty)continue;
    const label=computed?.cells?.[`B${row}`]?.v??sheet.cells[`B${row}`]?.v;
    if(financeIsEmptyLabel(label)&&!financeRowHasValues(sheet,row))hidden.add(row);
  }
  return hidden;
}
// PEC/FTP views blank the other company's month entries (and combined-only rows) before
// calculation, so every workbook total formula stays exactly as imported.
export function financeCompanyView(body,company='combined'){
  if(company==='combined')return body;
  const view=structuredClone(body);
  for(const sheet of view.sheets)for(const [key,tag] of Object.entries(sheet.companyRows||{})){
    if(tag===company)continue;
    for(let c=3;c<=14;c++){const cell=sheet.cells[financeColumn(c)+key];if(cell&&!cell.f)cell.v=null;}
  }
  return view;
}
// Income column B is a link such as ='Budget - 2'!H35. Renames write that budget cell,
// so the Budget tab and the Income Statement share one list of account names.
export function financeLabelTarget(body,sheet,row){
  const match=/^=(?:'([^']+)'|([A-Za-z0-9_.]+))!\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(String(sheet.cells[`B${row}`]?.f||'').trim());
  if(!match)return null;
  const name=(match[1]||match[2]).toLowerCase(),target=body.sheets.find(s=>String(s.name).toLowerCase()===name);
  if(!target)return null;
  const address=match[3].toUpperCase()+match[4],[r,c]=coordinate(address);
  if(r>target.rows||c>target.cols)return null;
  return {sheet:target,address};
}
export function financeSetAccountLabel(body,sheet,row,name){
  const target=financeLabelTarget(body,sheet,row);
  if(!target)throw new Error(`Row ${row} is not linked to a budget account name.`);
  const text=String(name??'').trim();
  const cell={...target.sheet.cells[target.address]};delete cell.f;delete cell.error;cell.v=text||null;
  target.sheet.cells[target.address]=cell;
  return {...target,value:cell.v};
}
export function financeEmptySlot(sheet,computed,sectionId){
  const section=(sheet.accountSections||[]).find(s=>s.id===sectionId);
  if(!section)return null;
  const [start,end]=String(section.rows).split(':').map(Number),total=end-start+1;let used=0,row=null;
  for(let r=start;r<=end;r++){
    const empty=financeIsEmptyLabel(computed?.cells?.[`B${r}`]?.v??sheet.cells[`B${r}`]?.v)&&!financeRowHasValues(sheet,r);
    if(empty){row??=r;}else used++;
  }
  return {section,row,used,total};
}
export function financeSaveSizeError(bytes,limit=FINANCE_SAVE_LIMIT_BYTES){
  if(!(bytes>limit))return null;
  const kb=n=>new Intl.NumberFormat('en-US').format(Math.round(n/1024));
  return `This budget year is too large to save (${kb(bytes)} KB of the ${kb(limit)} KB limit). Nothing was sent and your edits are still on this screen. Copy any new entries before leaving; the storage limit has to be raised before this year can be saved.`;
}
export function financeDisplay(cell) {
  if(cell.error)return cell.error;
  const v=cell.v;
  if(v==null||v==='')return '';
  if(typeof v!=='number')return String(v);
  if(cell.t==='date') {const date=new Date(Date.UTC(1899,11,30)+v*86400000);return Number.isFinite(date.getTime())?cell.format?.includes('mmmm')?new Intl.DateTimeFormat('en-US',{month:'long',timeZone:'UTC'}).format(date):date.toISOString().slice(0,10):String(v);}
  return new Intl.NumberFormat('en-US',cell.t==='percent'?{style:'percent',maximumFractionDigits:1}:cell.t==='money'?{style:'currency',currency:'USD',maximumFractionDigits:cell.format?.includes('.00')?2:0}:{maximumFractionDigits:2}).format(v);
}
export function renderFinanceSheet(body,computed,sheetId,{readOnly=false,showHidden=false,company='combined',showEmpty=false,adding=null}={}) {
  const sheet=body.sheets.find(s=>s.id===sheetId), result=computed.sheets.find(s=>s.id===sheetId);
  if(!sheet||!result)return '';
  const tagged=!!sheet.companyRows&&typeof sheet.companyRows==='object';
  const hiddenRows=tagged?financeIncomeHiddenRows(sheet,result,{company,showEmpty,showHidden}):new Set(showHidden?[]:sheet.hiddenRows||[]),hiddenCols=new Set(showHidden?[]:sheet.hiddenCols||[]);
  const sectionOf=readOnly?new Map():financeSectionRows(sheet);
  const rows=Array.from({length:sheet.rows},(_,i)=>i+1).filter(i=>!hiddenRows.has(i));
  const cols=Array.from({length:sheet.cols},(_,i)=>i+1).filter(i=>!hiddenCols.has(i));
  const width=c=>{const n=sheet.colWidths?.[c]||120;return n<30?n:n<60?65:n<100?110:Math.min(280,Math.max(180,n));};
  const styles=new Map();
  const styleRanges=Array.isArray(sheet.styleRanges)?sheet.styleRanges:Object.entries(sheet.styleRanges||{}).flatMap(([style,ranges])=>ranges.map(range=>({style,range})));
  for(const item of styleRanges) {const [a,b=a]=item.range.split(':'),[r1,c1]=coordinate(a),[r2,c2]=coordinate(b);for(let r=r1;r<=r2;r++)for(let c=c1;c<=c2;c++)styles.set(financeColumn(c)+r,item.style);}
  const inputs=new Map();
  for(const item of sheet.inputRanges||[]) {const [a,b=a]=item.range.split(':'),[r1,c1]=coordinate(a),[r2,c2]=coordinate(b);for(let r=r1;r<=r2;r++)for(let c=c1;c<=c2;c++)if(!inputs.has(financeColumn(c)+r))inputs.set(financeColumn(c)+r,item);}
  const merges=new Map(),covered=new Set();
  for(const merge of sheet.merges||[]) {
    const [a,b=a]=merge.split(':'),[r1,c1]=coordinate(a),[r2,c2]=coordinate(b);
    const rr=rows.filter(r=>r>=r1&&r<=r2),cc=cols.filter(c=>c>=c1&&c<=c2);
    if(!rr.length||!cc.length)continue;
    const anchor=financeColumn(cc[0])+rr[0];merges.set(anchor,{rowspan:rr.length,colspan:cc.length,source:a});
    for(const r of rr)for(const c of cc){const key=financeColumn(c)+r;if(key!==anchor)covered.add(key);}
  }
  const renderRow=r=>`<tr data-finance-row="${r}"><th class="tc-finance-rownum" scope="row">${r}</th>${cols.map(c=>{
    const address=financeColumn(c)+r;if(covered.has(address))return '';
    const span=merges.get(address),sourceAddress=span?.source||address,range=inputs.get(sourceAddress),raw=sheet.cells[sourceAddress]||{},original={...range,...raw,editable:!raw.f&&(raw.editable===true||!!range)},style=body.styles?.[original.style??styles.get(sourceAddress)]||{};
    const cell={t:style.t||(style.format?.includes('$')?'money':style.format?.includes('%')?'percent':style.format?.includes('mmmm')?'date':'number'),format:style.format,...original,...result.cells[sourceAddress]};
    const input=!readOnly&&original.editable&&!original.f;
    const section=c===2?sectionOf.get(r):null;
    const safeColor=v=>/^#[0-9a-f]{6}$/i.test(v||'')?v:null;
    const background=safeColor(style.background),color=safeColor(style.color);
    const pinned=c<=Math.max(2,sheet.freezeCols||0),left=38+cols.filter(n=>n<c).reduce((sum,n)=>sum+width(n),0);
    const css=[background?`background:${background}`:'',color?`color:${color}`:'',style.bold?'font-weight:600':'', ['left','center','right'].includes(style.align)?`text-align:${style.align}`:'',pinned?`position:sticky;left:${left}px;z-index:2`:''].filter(Boolean).join(';');
    const title=`${sheet.name}!${sourceAddress}${cell.f?' '+cell.f:''}${cell.error?' · Source formula needs attention':''}${body.notes?.[sheet.notes?.[sourceAddress]]?' · '+body.notes[sheet.notes[sourceAddress]]:''}`;
    const label=[sheet.cells[`B${r}`]?.v,sheet.cells[`H${r}`]?.v].find(v=>typeof v==='string')||'';
    const link=sheet.links?.[sourceAddress],display=e(financeDisplay(cell)),content=typeof link==='string'&&/^https:\/\//i.test(link)?`<a href="${e(link)}" target="_blank" rel="noopener noreferrer">${display}</a>`:display;
    if(section)return `<td data-cell="${e(sourceAddress)}" class="${pinned?'tc-finance-pinned':''} tc-finance-label tc-finance-editable tc-finance-text tc-finance-account" ${css?`style="${css}"`:''} title="${e(`${title} · ${section.label}. Renaming updates the Budget tab.`)}"><input type="text" data-finance-label="${r}" value="${e(typeof cell.v==='string'?cell.v:'')}" aria-label="${e(`Account name, row ${r}, ${section.label}`)}" maxlength="120" autocomplete="off" placeholder="Empty slot"></td>`;
    return `<td data-cell="${e(sourceAddress)}" class="${pinned?'tc-finance-pinned':''} ${c===2?'tc-finance-label':''} ${input?'tc-finance-editable':''} ${cell.error?'tc-finance-error':''} ${cell.t==='text'||typeof cell.v==='string'?'tc-finance-text':''}" ${span?`rowspan="${span.rowspan}" colspan="${span.colspan}"`:''} ${css?`style="${css}"`:''} title="${e(title)}">${input?(original.t==='text'?`<textarea rows="${Math.max(1,Math.min(4,Math.ceil(String(original.v??'').length/23)))}" data-finance-cell="${e(sourceAddress)}" aria-label="${e(sheet.name+' '+sourceAddress+' '+label)}">${e(financeInputValue(original))}</textarea>`:`<input type="text" data-finance-cell="${e(sourceAddress)}" aria-label="${e(sheet.name+' '+sourceAddress+' '+label)}" value="${e(financeInputValue(original))}" inputmode="decimal" autocomplete="off">`):content}</td>`;
  }).join('')}</tr>`;
  const frozen=sheet.freezeRows??4,header=rows.filter(r=>r<=frozen),detail=rows.filter(r=>r>frozen);
  // One "Add account" row per stored slot section, anchored under the section's last shown row.
  const anchors=new Map();
  if(!readOnly)for(const section of sheet.accountSections||[]){
    if(company!=='combined'&&section.company!==company)continue;
    const [start,end]=String(section.rows).split(':').map(Number);
    const anchor=[...rows].reverse().find(r=>r>=start&&r<=end)??[...rows].reverse().find(r=>r<start);
    if(anchor)anchors.set(anchor,[...(anchors.get(anchor)||[]),section]);
  }
  const renderAdd=section=>`<tr class="tc-finance-addrow" data-finance-section="${e(section.id)}"><th class="tc-finance-rownum" scope="row"></th><td class="tc-finance-pinned tc-finance-text" colspan="2" style="position:sticky;left:38px;z-index:2">${adding===section.id?`<span class="tc-finance-addform"><input type="text" name="financeAccountName" maxlength="120" placeholder="New account name" aria-label="${e(`New account name for ${section.label}`)}" autocomplete="off"><button type="button" class="tc-button tc-primary" data-action="finance-add-confirm" data-section="${e(section.id)}">Add</button><button type="button" class="tc-button" data-action="finance-add-cancel">Cancel</button></span>`:`<button type="button" class="tc-button" data-action="finance-add" data-section="${e(section.id)}">+ Add account · ${e(section.label)}</button>`}</td>${cols.length>2?`<td colspan="${cols.length-2}"></td>`:''}</tr>`;
  const renderDetail=r=>renderRow(r)+(anchors.get(r)||[]).map(renderAdd).join('');
  return `<div class="tc-finance-scroll" tabindex="0" role="region" aria-label="${e(sheet.name)}. Scroll for all rows and months."><table class="tc-finance-table"><caption class="tc-sr-only">${e(sheet.name)} ${body.year}</caption><colgroup><col style="width:38px">${cols.map(c=>`<col style="width:${width(c)}px">`).join('')}</colgroup><thead><tr><th class="tc-finance-rownum"></th>${cols.map(c=>`<th>${financeColumn(c)}</th>`).join('')}</tr>${header.map(renderRow).join('')}</thead><tbody>${detail.map(renderDetail).join('')}</tbody></table></div><p class="tc-small tc-muted">${rows.length} rows · ${cols.length} columns. ${showHidden?'All template rows and columns shown.':tagged?`Account rows show when they have a name or a monthly value${showEmpty?', plus empty slots':''}.${company==='combined'?'':` ${company} rows only; totals use ${company} entries.`}`:'Collapsed template rows and columns match the source.'} ${readOnly?'Read-only view.':'Edit the highlighted fields, then save. Calculated cells follow the workbook formulas.'}</p>`;
}
