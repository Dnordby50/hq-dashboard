import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateFinance } from './owner-finance.js';
import { financeColumn, financeInputCell, financeInputValue, parseFinanceInput, financeDisplay, renderFinanceSheet, financeSnapshotView, financeIncomeHiddenRows, financeCompanyView, financeIsEmptyLabel, financeRowHasValues, financeLabelTarget, financeSetAccountLabel, financeEmptySlot, financeSaveSizeError } from './owner-finance-ui.js';

const fixture=()=>({schemaVersion:1,year:2026,source:{file:'Synthetic workbook'},sheets:[
  {id:'budget',name:'Budget - 2',kind:'budget',rows:8,cols:4,cells:{
    A1:{v:'Synthetic annual plan',t:'text'},B2:{v:100,t:'money',editable:true,role:'plan'},
    C2:{v:200,f:'=B2*2',t:'money'},B3:{v:.25,t:'percent',editable:true,role:'plan'},
  },inputRanges:[{range:'C6:C8',role:'plan',t:'money'}]},
  {id:'income',name:'Income Statement - 2',kind:'income',rows:8,cols:4,cells:{
    B2:{v:200,f:"='Budget - 2'!C2",t:'money'},C2:{v:150,t:'money',editable:true,role:'actual'},
    D2:{v:-50,f:'=C2-B2',t:'money'},
  },inputRanges:[{range:'C6:C8',role:'actual',t:'money'}]},
]});

test('raw snapshots borrow layout by sheet name while keeping only original values, formulas, formats and notes',()=>{
  const working=fixture();
  working.sheets[0].cells.B2.v=9999;working.sheets[0].cells.C2.f='=B2*99';
  working.sheets[0].cells.D8={v:'WORKING PRIVATE NOTE'};
  working.sheets[0].colWidths={2:220};working.sheets[0].freezeCols=2;
  working.styles={blue:{background:'#ff0000'}};working.notes={n:'WORKING PRIVATE NOTE'};
  const source={schemaVersion:1,year:2026,source:{file:'Original synthetic workbook'},formats:{cash:'$#,##0.00',percent:'0.0%'},styles:{blue:{background:'#123456'}},notes:{n:'Original note'},sheets:[
    {name:'Income Statement - 2',cells:{B2:{v:20,f:"='Budget - 2'!C2"},C2:{v:15,format:'cash'}},hiddenRows:[7]},
    {name:'Budget - 2',cells:{B2:{v:10,format:'cash'},C2:{v:20,f:'=B2*2'},B3:{v:.2,format:'percent'},A6:{v:'Original array cache'}},arrayFormulas:{A6:{ref:'A6:A7',f:'=IF(B2>0,"Original array cache","")'}},merges:['A1:D1'],styleRanges:{blue:['B2']},notes:{B2:'n'}},
  ]};
  const before=structuredClone(source),workingBefore=structuredClone(working),view=financeSnapshotView(source,working);
  assert.deepEqual(source,before);assert.deepEqual(working,workingBefore);
  assert.deepEqual(view.sheets.map(s=>s.id),['income','budget']);assert.deepEqual(view.sheets.map(s=>s.kind),['income','budget']);
  const budget=view.sheets[1];
  assert.equal(budget.rows,8);assert.equal(budget.cols,4);assert.equal(budget.colWidths[2],220);assert.equal(budget.freezeCols,2);
  assert.equal(budget.cells.B2.v,10);assert.equal(budget.cells.C2.v,20);assert.equal(budget.cells.C2.f,'=B2*2');
  assert.equal(budget.cells.D8,undefined);assert.equal(budget.inputRanges,undefined);
  assert.equal(budget.cells.B2.format,'$#,##0.00');assert.equal(budget.cells.B2.t,'money');
  assert.equal(budget.cells.B3.t,'percent');assert.equal(budget.cells.A6.v,'Original array cache');assert.match(budget.cells.A6.f,/^=IF/);
  assert.equal(view.notes.n,'Original note');assert.equal(view.styles.blue.background,'#123456');
  assert.ok(!JSON.stringify(view).includes('WORKING PRIVATE NOTE'));
  const html=renderFinanceSheet(view,view,'budget');
  assert.match(html,/\$10\.00/);assert.match(html,/Original note/);assert.match(html,/Original array cache/);
  assert.doesNotMatch(html,/<input\b|<textarea\b|9999|B2\*99/);
  view.sheets[1].colWidths[2]=80;assert.equal(working.sheets[0].colWidths[2],220);
});

test('snapshot adapter infers source-only dimensions and kinds without relying on sheet order or working cells',()=>{
  const source={schemaVersion:1,year:2026,source:{},sheets:[
    {name:'Date Definitions',cells:{E13:{v:'Original date'}}},
    {name:'Budget - 2',cells:{B2:{v:0}},merges:['A1:D1'],styleRanges:{one:['A1:F9']},hiddenRows:[10]},
    {name:'Income Statement - 2',cells:{C5:{v:0}},hiddenCols:[7]},
  ]};
  const view=financeSnapshotView(source);
  assert.deepEqual(view.sheets.map(s=>s.kind),['support','budget','income']);
  assert.deepEqual(view.sheets.map(s=>[s.rows,s.cols]),[[13,5],[10,6],[5,7]]);
  assert.equal(new Set(view.sheets.map(s=>s.id)).size,3);
  assert.match(renderFinanceSheet(view,view,view.sheets[1].id,{readOnly:true}),/data-cell="B2"/);
  assert.equal(financeInputCell(view.sheets[1],'B2').editable,false);
});

test('input ranges expose blank planning and actual fields without making formulas editable',()=>{
  const body=fixture(),[budget,income]=body.sheets;
  budget.cells.C7={v:0,t:'money'};budget.cells.C8={v:200,f:'=B2*2',t:'money'};
  assert.deepEqual(financeInputCell(budget,'C6'),{range:'C6:C8',role:'plan',t:'money',editable:true});
  assert.equal(financeInputCell(income,'C6').role,'actual');
  assert.equal(financeInputCell(budget,'D6').editable,false);
  assert.equal(financeInputCell(budget,'C7').editable,true);
  assert.equal(financeInputCell(budget,'C8').editable,false);
  const before=structuredClone(body),html=renderFinanceSheet(body,calculateFinance(body),'budget');
  assert.match(html,/data-finance-cell="C6"[^>]*value=""/);
  assert.match(html,/data-finance-cell="C7"[^>]*value="0"/);
  assert.doesNotMatch(html,/data-finance-cell="C8"|data-finance-cell="D6"/);
  assert.deepEqual(body,before);
});

test('budget edits update linked income formulas while preserving actual entries and immutable source values',()=>{
  const original=fixture(),working=structuredClone(original);
  working.sheets[0].cells.B2.v=parseFinanceInput('$125',working.sheets[0].cells.B2);
  const calculated=calculateFinance(working),income=renderFinanceSheet(working,calculated,'income');
  assert.equal(calculated.sheets[0].cells.C2.v,250);
  assert.equal(calculated.sheets[1].cells.B2.v,250);
  assert.equal(calculated.sheets[1].cells.D2.v,-100);
  assert.equal(calculated.sheets[1].cells.C2.v,150);
  assert.match(income,/data-finance-cell="C2"[^>]*value="150"/);
  assert.doesNotMatch(income,/data-finance-cell="B2"|data-finance-cell="D2"/);
  const snapshot=renderFinanceSheet(original,original,'income',{readOnly:true});
  assert.match(snapshot,/\$200/);assert.doesNotMatch(snapshot,/<input\b|\$250/);
  assert.equal(original.sheets[0].cells.B2.v,100);assert.equal(original.sheets[1].cells.B2.v,200);
});

test('financial entry preserves blanks and zero and accepts currencies, negatives, and explicit percentages',()=>{
  const money={v:null,t:'money'},percent={v:.125,t:'percent'};
  for(const [text,expected] of [['',null],['   ',null],['0',0],['$1,250.50',1250.5],['($1,250.50)',-1250.5],['-20.75',-20.75],['.5',.5]])assert.equal(parseFinanceInput(text,money),expected,text);
  assert.equal(financeInputValue({v:null,t:'money'}),'');assert.equal(financeInputValue({v:0,t:'money'}),'0');
  assert.equal(financeInputValue(percent),'12.5%');assert.equal(parseFinanceInput(financeInputValue(percent),percent),.125);
  assert.equal(parseFinanceInput('30',percent),.3);assert.equal(parseFinanceInput('-12.5',percent),-.125);
  assert.equal(parseFinanceInput('0%',percent),0);assert.equal(parseFinanceInput('-12.5%',percent),-.125);
  assert.equal(parseFinanceInput('(12.5%)',percent),-.125);
  assert.equal(parseFinanceInput('  A custom budget label  ',{v:'Label',t:'text'}),'  A custom budget label  ');
  for(const text of ['abc','12x','Infinity','NaN','1e999','1.2.3'])assert.throws(()=>parseFinanceInput(text,money),/Enter a number/);
});

test('editable spreadsheet dates round-trip as valid ISO dates and reject rollover dates',()=>{
  const serial=(Date.UTC(2026,0,1)-Date.UTC(1899,11,30))/86400000,cell={v:serial,t:'date'};
  assert.equal(financeInputValue(cell),'2026-01-01');
  assert.equal(parseFinanceInput(financeInputValue(cell),cell),serial);
  assert.equal(parseFinanceInput('2028-02-29',cell),(Date.UTC(2028,1,29)-Date.UTC(1899,11,30))/86400000);
  assert.equal(parseFinanceInput('2026-01-01',{v:'2025-01-01',t:'date'}),'2026-01-01');
  for(const value of ['2026-02-30','2026-02-29','2026-13-01','01/01/2026'])assert.throws(()=>parseFinanceInput(value,cell),/valid date/);
});

test('source-hidden rows and columns retain merged labels and can all be revealed',()=>{
  const body={year:2026,sheets:[{id:'budget',name:'Synthetic layout',rows:4,cols:3,cells:{A1:{v:'Merged title',t:'text'},A3:{v:'Visible row'},B3:{v:'Hidden column'},C4:{v:'Visible bottom'}},hiddenRows:[1],hiddenCols:[1],merges:['A1:C2'],freezeRows:2}]};
  const hidden=renderFinanceSheet(body,body,'budget',{readOnly:true}),revealed=renderFinanceSheet(body,body,'budget',{readOnly:true,showHidden:true});
  assert.doesNotMatch(hidden,/data-finance-row="1"/);assert.match(revealed,/data-finance-row="1"/);
  assert.match(hidden,/data-cell="A1"[^>]*rowspan="1" colspan="2"[^>]*>Merged title/);
  assert.match(revealed,/data-cell="A1"[^>]*rowspan="2" colspan="3"[^>]*>Merged title/);
  assert.match(hidden,/3 rows · 2 columns/);assert.match(revealed,/4 rows · 3 columns/);
  assert.equal((hidden.match(/>Merged title<\/td>/g)||[]).length,1);
  assert.equal(financeColumn(1),'A');assert.equal(financeColumn(26),'Z');assert.equal(financeColumn(27),'AA');assert.equal(financeColumn(163),'FG');
});

test('source names, labels, formulas, input values, and errors are escaped in rendered HTML',()=>{
  const body={year:2026,styles:{unsafe:{background:'red;position:fixed',color:'#123456',bold:true}},sheets:[{id:'budget',name:'Budget "<img src=x onerror=alert(1)>',rows:2,cols:3,cells:{
    A1:{v:'<script>alert(1)</script>',t:'text'},B1:{v:'" autofocus onfocus="alert(1)',t:'text',editable:true,style:'unsafe'},
    C1:{v:null,f:'="<img src=x>"',error:'<svg onload=alert(1)>',t:'text'},
  }}]};
  const html=renderFinanceSheet(body,body,'budget');
  assert.doesNotMatch(html,/<script|<img|<svg|value="" autofocus|position:fixed/);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html,/>&quot; autofocus onfocus=&quot;alert\(1\)<\/textarea>/);
  assert.match(html,/&lt;svg onload=alert\(1\)&gt;/);assert.match(html,/color:#123456/);
  assert.equal(financeDisplay({v:0,t:'money'}),'$0');assert.equal(financeDisplay({v:null,t:'money'}),'');
  assert.equal(financeDisplay({v:100,error:'#REF!'}),'#REF!');
});

// Tagged income statement: explicit company ownership stored per row, slot sections for adding accounts.
const taggedFixture=()=>({schemaVersion:1,year:2026,source:{file:'Synthetic tagged workbook'},sheets:[
  {id:'budget',name:'Budget - 2',kind:'budget',rows:12,cols:8,inputRanges:[{range:'G1:H12',role:'plan',t:'text'}],cells:{
    H1:{v:'FTP'},H2:{v:'PEC'},H3:{v:'Paint'},H4:{v:'Variable Exp Line 2'},H5:{v:'Epoxy'},H6:{f:'=H4'},H7:{v:'Rent'},H8:{v:null},H9:{v:'Fuel'},H10:{v:'Fixed Exp 2'},
  }},
  {id:'income',name:'Income Statement - 2',kind:'income',rows:20,cols:16,freezeRows:0,
    companyRows:{1:'FTP',2:'PEC',4:'FTP',5:'FTP',7:'PEC',8:'PEC',10:'FTP',11:'FTP',13:'PEC',14:'PEC',16:'COMBINED',17:'FTP',18:'PEC'},
    accountSections:[{id:'ftp-variable',label:'FTP variable expenses',company:'FTP',rows:'4:5'},{id:'pec-variable',label:'PEC variable expenses',company:'PEC',rows:'7:8'},{id:'ftp-fixed',label:'FTP fixed expenses',company:'FTP',rows:'10:11'},{id:'pec-fixed',label:'PEC fixed <b>expenses</b>',company:'PEC',rows:'13:14'}],
    inputRanges:['C1:N2','C4:N5','C7:N8','C10:N11','C13:N14','C16:N18'].map(range=>({range,role:'actual',t:'money'})),
    hiddenRows:[9,12,16],
    cells:{B1:{f:"='Budget - 2'!H1"},B2:{f:"='Budget - 2'!H2"},C1:{v:1000},C2:{v:2000},
      B4:{f:"='Budget - 2'!H3"},B5:{f:"='Budget - 2'!H4"},C4:{v:100},
      B7:{f:"='Budget - 2'!H5"},B8:{f:"='Budget - 2'!H6"},C7:{v:300},
      B10:{f:"='Budget - 2'!H7"},B11:{f:"='Budget - 2'!H8"},C10:{v:50},
      B13:{f:"='Budget - 2'!H9"},B14:{f:"='Budget - 2'!H10"},C13:{v:400},C14:{v:25},D14:{v:0},
      B16:{v:'Interest',t:'text'},B17:{v:'Other Income (FTP)',t:'text'},B18:{v:'Other Income (PEC)',t:'text'},C17:{v:5},C18:{v:7},
      B9:{v:'template row',t:'text'},B12:{v:'TOTAL:',t:'text'},C12:{f:'=SUM(C10:C11)+SUM(C13:C14)'},
      B19:{v:'NET',t:'text'},C19:{f:'=C1+C2-C4-C5-C7-C8-C10-C11-C13-C14-C16+C17+C18'},
    }},
]});

test('tagged account rows show when named or valued, follow the company filter, and reveal empty slots on request',()=>{
  const body=taggedFixture(),before=structuredClone(body),income=body.sheets[1],computed=calculateFinance(body).sheets[1];
  const hidden=opts=>[...financeIncomeHiddenRows(income,computed,opts)].sort((a,b)=>a-b);
  assert.deepEqual(hidden({company:'combined'}),[5,8,9,11,12]);
  assert.deepEqual(hidden({company:'PEC'}),[1,4,5,8,9,10,11,12,16,17]);
  assert.deepEqual(hidden({company:'FTP'}),[2,5,7,8,9,11,12,13,14,16,18]);
  assert.deepEqual(hidden({company:'combined',showEmpty:true}),[9,12]);
  assert.deepEqual(hidden({company:'PEC',showEmpty:true}),[1,4,5,9,10,11,12,16,17]);
  assert.deepEqual(hidden({company:'PEC',showHidden:true}),[1,4,5,10,11,16,17]);
  assert.ok(financeIsEmptyLabel('Fixed Exp 67')&&financeIsEmptyLabel('variable exp line 16')&&financeIsEmptyLabel('  ')&&financeIsEmptyLabel(null));
  assert.ok(!financeIsEmptyLabel('Fixed Expenses')&&!financeIsEmptyLabel('Fuel'));
  assert.equal(financeRowHasValues(income,14),true);assert.equal(financeRowHasValues(income,11),false);
  assert.deepEqual(body,before);
});

test('company views blank only the other company and combined-only entries so every total formula stays as imported',()=>{
  const body=taggedFixture(),before=structuredClone(body);
  const net=company=>calculateFinance(financeCompanyView(body,company)).sheets[1].cells.C19.v;
  assert.equal(net('combined'),2137);assert.equal(net('PEC'),1282);assert.equal(net('FTP'),855);
  assert.equal(financeCompanyView(body,'combined'),body);
  const pec=financeCompanyView(body,'PEC');
  assert.equal(pec.sheets[1].cells.C1.v,null);assert.equal(pec.sheets[1].cells.C2.v,2000);assert.equal(pec.sheets[1].cells.C17.v,null);assert.equal(pec.sheets[1].cells.C18.v,7);
  assert.equal(pec.sheets[1].cells.C19.f,body.sheets[1].cells.C19.f);
  assert.deepEqual(body,before);
});

test('income statement renders editable account names, per-section add rows, and only the selected company',()=>{
  const body=taggedFixture(),computed=calculateFinance(financeCompanyView(body,'PEC'));
  const html=renderFinanceSheet(body,computed,'income',{company:'PEC'});
  assert.doesNotMatch(html,/data-finance-row="1"|data-finance-row="4"|data-finance-row="16"|data-finance-row="17"/);
  assert.match(html,/data-finance-row="2"/);assert.match(html,/data-finance-row="7"/);assert.match(html,/data-finance-row="18"/);
  assert.match(html,/data-finance-label="7"[^>]*value="Epoxy"/);assert.match(html,/data-finance-label="13"[^>]*value="Fuel"/);
  assert.doesNotMatch(html,/data-finance-label="2"|data-finance-label="18"/);
  assert.match(html,/data-finance-section="pec-variable"/);assert.match(html,/data-finance-section="pec-fixed"/);
  assert.doesNotMatch(html,/data-finance-section="ftp-variable"|data-finance-section="ftp-fixed"/);
  assert.match(html,/PEC fixed &lt;b&gt;expenses&lt;\/b&gt;/);assert.doesNotMatch(html,/<b>expenses/);
  assert.match(html,/PEC rows only; totals use PEC entries/);
  const adding=renderFinanceSheet(body,computed,'income',{company:'PEC',adding:'pec-fixed'});
  assert.match(adding,/name="financeAccountName"/);assert.match(adding,/data-action="finance-add-confirm" data-section="pec-fixed"/);
  const combined=renderFinanceSheet(body,calculateFinance(body),'income',{company:'combined',showEmpty:true});
  assert.match(combined,/data-finance-row="16"/);assert.match(combined,/data-finance-label="5"[^>]*value="Variable Exp Line 2"/);
  assert.match(combined,/data-finance-label="8"[^>]*value="Variable Exp Line 2"/);
  assert.equal((combined.match(/tc-finance-addrow/g)||[]).length,4);
  const readOnly=renderFinanceSheet(body,calculateFinance(body),'income',{readOnly:true});
  assert.doesNotMatch(readOnly,/data-finance-label|tc-finance-addrow|<input/);
});

test('adding and renaming accounts writes the linked budget cell, fills the next empty slot, and reports a full section',()=>{
  const body=taggedFixture(),income=body.sheets[1],budget=body.sheets[0];
  const computed=()=>calculateFinance(body).sheets[1];
  assert.deepEqual(financeLabelTarget(body,income,8),{sheet:budget,address:'H6'});
  assert.equal(financeLabelTarget(body,income,18),null);
  assert.deepEqual({row:8,used:1,total:2},(({row,used,total})=>({row,used,total}))(financeEmptySlot(income,computed(),'pec-variable')));
  assert.equal(financeEmptySlot(income,computed(),'missing'),null);
  budget.hiddenRows=[6,10];
  financeSetAccountLabel(body,income,8,'  Dump Fees ');
  assert.deepEqual(budget.cells.H6,{v:'Dump Fees'});
  assert.deepEqual(budget.hiddenRows,[10],'naming a slot reveals its budget row');
  assert.equal(computed().cells.B8.v,'Dump Fees');
  assert.equal(financeEmptySlot(income,computed(),'pec-variable').row,null);
  assert.equal(financeEmptySlot(income,computed(),'pec-variable').used,2);
  financeSetAccountLabel(body,income,4,'');
  assert.deepEqual(budget.cells.H3,{v:null});
  assert.equal(financeIncomeHiddenRows(income,computed(),{}).has(4),false,'valued row stays visible after clearing its name');
  income.cells.C4.v=null;
  assert.equal(financeIncomeHiddenRows(income,computed(),{}).has(4),true,'cleared row hides once it has no values');
  assert.equal(financeIncomeHiddenRows(income,computed(),{showEmpty:true}).has(4),false);
  assert.throws(()=>financeSetAccountLabel(body,income,18,'x'),/not linked/);
  assert.equal(financeSaveSizeError(1000),null);
  assert.match(financeSaveSizeError(1900000),/1,855 KB of the 1,758 KB limit/);
  assert.match(financeSaveSizeError(1900000),/Nothing was sent/);
});
