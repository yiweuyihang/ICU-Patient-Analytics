const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const storage={value:null,getItem(){return this.value;},setItem(k,v){this.value=v;}};
const element={addEventListener(){}};
const context=vm.createContext({console,localStorage:storage,document:{querySelector(){return element;},querySelectorAll(){return [];},addEventListener(){}},window:{addEventListener(){}},setTimeout,clearTimeout});
for(const name of ['chat-store.js','analysis-tools.js','chat-actions.js','app.js'])vm.runInContext(fs.readFileSync(path.join(root,'app/static',name),'utf8').replace(/\ninit\(\);\s*$/,''),context);
vm.runInContext('this.helpers={coverageRuns,normalizedTimeRange,renderComparison,comparisonState,unitColor,knownUnits};',context);
const h=context.helpers;
const runs=JSON.parse(JSON.stringify(h.coverageRuns([{bucket:0},{bucket:2}],0,2.5,1)));
assert.deepEqual(runs,[{start:0,end:1,recorded:true},{start:1,end:2,recorded:false},{start:2,end:2.5,recorded:true}]);
assert.deepEqual(JSON.parse(JSON.stringify(h.coverageRuns([],4,7,1))),[{start:4,end:7,recorded:false}]);
for(const [a,b,d] of [[70,12,96],[-20,200,96],[0,0,.05],[100,100,100],[.01,.03,.1]]){
  const range=h.normalizedTimeRange(a,b,d);
  assert.ok(range.start>=0&&range.end<=d&&range.end>range.start);
}
assert.equal(new Set(h.knownUnits.map(h.unitColor)).size,h.knownUnits.length);
h.comparisonState.a={name:'<script>alert(1)</script>',filters:{age:'65+'}};
const html=h.renderComparison();
assert.ok(html.includes('&lt;script&gt;'));
assert.ok(!html.includes('<script>'));
assert.ok(!html.includes('NaN'));
console.log('Coverage gaps, partial buckets, bounded time brushing, stable ICU colors and escaped comparison inputs passed.');
