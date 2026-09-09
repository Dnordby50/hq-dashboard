import { getMbpInput, mbpInputFields } from './owner-mbp-inputs.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mbpInputValue(value,field) {
  if(value==null)return '';
  return field.type==='percent'?`${Number((value*100).toPrecision(12))}%`:String(value);
}
export function parseMbpInput(text,field) {
  const value=text.trim();
  if(!value)return null;
  const stripped=value.replace(/[$,\s]/g,'').replace(/^\((.*)\)$/,'-$1');
  const percent=stripped.endsWith('%'),raw=percent?stripped.slice(0,-1):stripped;
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)||!Number.isFinite(Number(raw)))throw new Error('Enter a valid number, or leave an optional input blank.');
  if(percent&&field.type!=='percent')throw new Error('Only percentage fields accept %.');
  return Number(raw)/(field.type==='percent'?100:1);
}
export function renderMbpInput(body,field,{label=false,reset=true}={}) {
  const state=body.mbpCellState?.[field.key]||{},manual=state.origin==='manual',automatic=state.origin==='topcoat';
  const value=mbpInputValue(getMbpInput(body,field.key),field);
  const context=`${field.lineId==='painting'?'FTP':field.lineId==='epoxy'?'PEC':'TOTAL'} ${field.kind==='sales'?'Sales':'Revenue'} ${field.weekEnding==='annual'?'annual':field.weekEnding} ${field.label}`;
  const source=manual?'Manually edited':automatic?(state.sourceAvailable===false?'TopCoat · last available':'TopCoat'):field.live?'Saved input':field.scope==='annual'||field.field==='weight'?'Plan input':'Manual input';
  const canReset=reset&&field.live&&state.sourceAvailable===true&&state.origin!=='topcoat'&&(manual||label);
  return `<div class="tc-mbp-entry ${field.actual?'is-actual':''} ${manual?'is-manual':''} ${automatic?'is-automatic':''}" data-saved-manual="${manual}">${label?`<label>${escape(field.label)}`:''}<input type="text" inputmode="decimal" autocomplete="off" data-mbp-key="${escape(field.key)}" aria-label="${escape(context)}" title="${escape(field.sourceAddress||'')} · ${source}" value="${escape(value)}">${label?'</label>':''}<span class="tc-mbp-input-source">${source}</span>${canReset?`<button type="button" data-action="mbp-use-topcoat" data-mbp-reset="${escape(field.key)}" aria-label="Use TopCoat for ${escape(context)}">Use TopCoat</button>`:''}</div>`;
}
export function mbpSheetFields(body,sheet) {
  return mbpInputFields(body).filter(f=>f.kind===sheet.kind&&f.lineId===sheet.businessLineId);
}
