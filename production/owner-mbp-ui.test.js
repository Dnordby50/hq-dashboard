import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ownerFixture} from './owner-test-fixture.js';
import {calculateMbp} from './owner-mbp.js';
import {applyMbpEdits,applyMbpLive,mbpInputFields} from './owner-mbp-inputs.js';
import {renderMbpGrid} from './owner-studio.js';
import {mbpInputValue,parseMbpInput,renderMbpInput} from './owner-mbp-ui.js';

test('working grids expose original actuals and weights while calculated cells and source copies stay locked',()=>{
  const body={mbp:ownerFixture()};
  for(const sheet of calculateMbp(body.mbp).sheets){
    const html=renderMbpGrid(sheet,'all',{body}),keys=[...html.matchAll(/data-mbp-key="([^"]+)"/g)].map(m=>m[1]);
    const expected=mbpInputFields(body).filter(f=>f.lineId===sheet.businessLineId&&f.kind===sheet.kind&&f.scope!=='annual'&&!f.field.endsWith('Override')).map(f=>f.key);
    assert.deepEqual([...keys].sort(),expected.sort());
    assert.doesNotMatch(renderMbpGrid(sheet,'all',{body,readOnly:true}),/data-mbp-key|data-action="edit-week"/);
  }
});
test('yellow marks saved manual overrides and exposes a restore action only for a currently available PEC value',()=>{
  const time='2026-09-08T16:00:00Z',key='epoxy/sales/2026-09-06/leads';
  const feed={queriedAt:time,throughWeek:'2026-09-13',weeks:[{weekEnding:'2026-09-06',actual:{leads:10},available:{leads:true}}]};
  const live=applyMbpLive({mbp:ownerFixture()},feed),field=mbpInputFields(live).find(f=>f.key===key);
  const html=renderMbpInput(live,field);assert.match(html,/is-automatic/);assert.doesNotMatch(html,/is-manual|Use TopCoat/);
  const edited=applyMbpEdits(live,[{key,value:0}],time),manual=renderMbpInput(edited,field);
  assert.match(manual,/is-manual/);assert.match(manual,/value="0"/);assert.match(manual,/Use TopCoat/);
  const unavailable=applyMbpLive(edited,{...feed,queriedAt:'2026-09-08T16:01:00Z',weeks:[]});
  assert.doesNotMatch(renderMbpInput(unavailable,field),/Use TopCoat/);assert.match(renderMbpInput(unavailable,field),/is-manual/);
  const ftpKey=key.replace('epoxy','painting'),ftp=applyMbpEdits(live,[{key:ftpKey,value:3}],time);
  assert.doesNotMatch(renderMbpInput(ftp,mbpInputFields(ftp).find(f=>f.key===ftpKey)),/Use TopCoat/);
});
test('entry parsing supports clear numbers and percentage points without rounding underlying unchanged inputs',()=>{
  const money={type:'money'},pct={type:'percent'};
  assert.equal(parseMbpInput('$1,234.56',money),1234.56);assert.equal(parseMbpInput('(75.25)',money),-75.25);
  assert.equal(parseMbpInput('',money),null);assert.equal(parseMbpInput('0',money),0);
  assert.equal(parseMbpInput('25',pct),.25);assert.equal(parseMbpInput('25%',pct),.25);
  assert.equal(mbpInputValue(1.23456789012345,money),'1.23456789012345');
  for(const value of ['x','1e999','12x','10%'])assert.throws(()=>parseMbpInput(value,money));
});
test('input names and labels are escaped before rendering',()=>{
  const body={mbp:ownerFixture()},field=mbpInputFields(body)[0];
  assert.doesNotMatch(renderMbpInput(body,{...field,label:'<img onerror="bad">'},{label:true}),/<img/);
  assert.match(renderMbpInput(body,{...field,label:'<img onerror="bad">'},{label:true}),/&lt;img/);
});
