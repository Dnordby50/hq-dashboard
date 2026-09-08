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
export function financeDisplay(cell) {
  if(cell.error)return cell.error;
  const v=cell.v;
  if(v==null||v==='')return '';
  if(typeof v!=='number')return String(v);
  if(cell.t==='date') {const date=new Date(Date.UTC(1899,11,30)+v*86400000);return Number.isFinite(date.getTime())?cell.format?.includes('mmmm')?new Intl.DateTimeFormat('en-US',{month:'long',timeZone:'UTC'}).format(date):date.toISOString().slice(0,10):String(v);}
  return new Intl.NumberFormat('en-US',cell.t==='percent'?{style:'percent',maximumFractionDigits:1}:cell.t==='money'?{style:'currency',currency:'USD',maximumFractionDigits:cell.format?.includes('.00')?2:0}:{maximumFractionDigits:2}).format(v);
}
export function renderFinanceSheet(body,computed,sheetId,{readOnly=false,showHidden=false}={}) {
  const sheet=body.sheets.find(s=>s.id===sheetId), result=computed.sheets.find(s=>s.id===sheetId);
  if(!sheet||!result)return '';
  const hiddenRows=new Set(showHidden?[]:sheet.hiddenRows||[]),hiddenCols=new Set(showHidden?[]:sheet.hiddenCols||[]);
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
    const safeColor=v=>/^#[0-9a-f]{6}$/i.test(v||'')?v:null;
    const background=safeColor(style.background),color=safeColor(style.color);
    const pinned=c<=Math.max(2,sheet.freezeCols||0),left=38+cols.filter(n=>n<c).reduce((sum,n)=>sum+width(n),0);
    const css=[background?`background:${background}`:'',color?`color:${color}`:'',style.bold?'font-weight:600':'', ['left','center','right'].includes(style.align)?`text-align:${style.align}`:'',pinned?`position:sticky;left:${left}px;z-index:2`:''].filter(Boolean).join(';');
    const title=`${sheet.name}!${sourceAddress}${cell.f?' '+cell.f:''}${cell.error?' · Source formula needs attention':''}${body.notes?.[sheet.notes?.[sourceAddress]]?' · '+body.notes[sheet.notes[sourceAddress]]:''}`;
    const label=[sheet.cells[`B${r}`]?.v,sheet.cells[`H${r}`]?.v].find(v=>typeof v==='string')||'';
    const link=sheet.links?.[sourceAddress],display=e(financeDisplay(cell)),content=typeof link==='string'&&/^https:\/\//i.test(link)?`<a href="${e(link)}" target="_blank" rel="noopener noreferrer">${display}</a>`:display;
    return `<td data-cell="${e(sourceAddress)}" class="${pinned?'tc-finance-pinned':''} ${c===2?'tc-finance-label':''} ${input?'tc-finance-editable':''} ${cell.error?'tc-finance-error':''} ${cell.t==='text'||typeof cell.v==='string'?'tc-finance-text':''}" ${span?`rowspan="${span.rowspan}" colspan="${span.colspan}"`:''} ${css?`style="${css}"`:''} title="${e(title)}">${input?(original.t==='text'?`<textarea rows="${Math.max(1,Math.min(4,Math.ceil(String(original.v??'').length/23)))}" data-finance-cell="${e(sourceAddress)}" aria-label="${e(sheet.name+' '+sourceAddress+' '+label)}">${e(financeInputValue(original))}</textarea>`:`<input type="text" data-finance-cell="${e(sourceAddress)}" aria-label="${e(sheet.name+' '+sourceAddress+' '+label)}" value="${e(financeInputValue(original))}" inputmode="decimal" autocomplete="off">`):content}</td>`;
  }).join('')}</tr>`;
  const frozen=sheet.freezeRows??4,header=rows.filter(r=>r<=frozen),detail=rows.filter(r=>r>frozen);
  return `<div class="tc-finance-scroll" tabindex="0" role="region" aria-label="${e(sheet.name)}. Scroll for all rows and months."><table class="tc-finance-table"><caption class="tc-sr-only">${e(sheet.name)} ${body.year}</caption><colgroup><col style="width:38px">${cols.map(c=>`<col style="width:${width(c)}px">`).join('')}</colgroup><thead><tr><th class="tc-finance-rownum"></th>${cols.map(c=>`<th>${financeColumn(c)}</th>`).join('')}</tr>${header.map(renderRow).join('')}</thead><tbody>${detail.map(renderRow).join('')}</tbody></table></div><p class="tc-small tc-muted">${rows.length} rows · ${cols.length} columns. ${showHidden?'All template rows and columns shown.':'Collapsed template rows and columns match the source.'} ${readOnly?'Read-only view.':'Edit the highlighted fields, then save. Calculated cells follow the workbook formulas.'}</p>`;
}
