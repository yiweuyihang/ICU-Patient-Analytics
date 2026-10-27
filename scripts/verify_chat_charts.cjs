/* Offline chart rendering and history compatibility; no browser state is changed. */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const storage = {value:null,getItem(){return this.value;},setItem(key,value){this.value=value;}};
const element = {addEventListener(){}};
const context = vm.createContext({console,localStorage:storage,
  document:{querySelector(){return element;},querySelectorAll(){return [];},addEventListener(){}},
  window:{addEventListener(){}},setTimeout,clearTimeout});
vm.runInContext(fs.readFileSync(path.join(root,'app/static/chat-store.js'),'utf8'),context);
vm.runInContext(fs.readFileSync(path.join(root,'app/static/chat-actions.js'),'utf8'),context);
vm.runInContext(fs.readFileSync(path.join(root,'app/static/app.js'),'utf8').replace(/\ninit\(\);\s*$/, ''),context);
vm.runInContext('this.renderCharts=renderChatCharts; this.renderAnswer=renderChatAnswer; this.Store=ChatStore;',context);
const data = {summary:{stays:20},ages:[{age:'65-79',count:20}],genders:[{gender:'F',count:20}],
  units:[{unit:'MICU <script>',count:20}],histogram:[{label:'1–2',min:1,max:2,count:20}],
  boxes:[{unit:'MICU',count:20,q1:1,median:2,q3:3,low:0,high:5}]};
const charts=Object.keys(data).filter(id=>id!=='summary').map(id=>({id,data:{summary:data.summary,[id]:data[id]}}));
for(const chart of charts) {
  const html=context.renderCharts([chart]);
  assert.ok(html.includes(`data-chat-chart="${chart.id}"`));
  assert.ok(html.includes('20 次入住'));
  assert.ok(!/<button|role="button"|data-age=|data-unit=|data-los-min=/.test(html));
  assert.ok(!html.includes('<script>'));
}
assert.equal(context.renderCharts(undefined),'');
assert.ok(!context.renderCharts([{id:'unknown',data}]).includes('<figure'));
let store=new context.Store(storage);
const session=store.create({age:'65+'});
session.messages=[{role:'user',content:'年龄'}, {role:'assistant',content:'解释',charts:[charts[0]]}];
store.persist();
store=new context.Store(storage);
assert.equal(store.active().messages[1].charts[0].data.ages[0].count,20);
assert.equal(store.active().filters.age,'65+');
// Later filters or source data cannot mutate a persisted response snapshot.
data.ages[0].count=999;
assert.equal(store.active().messages[1].charts[0].data.ages[0].count,20);
delete store.active().messages[1].charts;store.persist();
assert.equal(new context.Store(storage).active().messages[1].content,'解释');
console.log('All five existing chart renderers and new/legacy history checks passed.');

const blocks=[{text:'AGE-CONCLUSION',chart:charts[0],interpretation:'AGE-EXPLANATION'},
 {text:'GENDER-CONCLUSION',chart:charts[1],interpretation:'GENDER-EXPLANATION'}];
const answer=context.renderAnswer({role:'assistant',content:'fallback',blocks});
assert.ok(answer.indexOf('AGE-CONCLUSION')<answer.indexOf('data-chat-chart="ages"'));
assert.ok(answer.indexOf('data-chat-chart="ages"')<answer.indexOf('AGE-EXPLANATION'));
assert.ok(answer.indexOf('AGE-EXPLANATION')<answer.indexOf('GENDER-CONCLUSION'));
assert.ok(answer.indexOf('GENDER-CONCLUSION')<answer.indexOf('data-chat-chart="genders"'));
assert.ok(answer.indexOf('data-chat-chart="genders"')<answer.indexOf('GENDER-EXPLANATION'));
store.active().messages[1].blocks=blocks;store.persist();
assert.equal(new context.Store(storage).active().messages[1].blocks[1].interpretation,'GENDER-EXPLANATION');
assert.ok(!context.renderAnswer({role:'assistant',blocks:[{text:'<script>',interpretation:'<img>'}]}).includes('<script>'));
console.log('Interleaved explanation/chart order and section history restoration passed.');
