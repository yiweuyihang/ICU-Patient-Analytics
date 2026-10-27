/* Offline UI orchestration checks: no model calls or browser storage is used. */
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const clone=value=>JSON.parse(JSON.stringify(value));
function cohort(filters={}){
  const n=filters.los_min==='10000'?0:filters.gender==='F'?2400:filters.age==='65+'?5957:94363;
  return {summary:{stays:n,patients:n?Math.min(n,5284):0,admissions:n?Math.min(n,5700):0,median_los:n?11.04:null,mean_los:n?14.05:null},units:[],ages:[],genders:[],histogram:[],boxes:[],heatmap:[],scatter:[],total_cohort:94363};
}
function harness(){
  const elements=new Map(),memory=new Map(),calls=[];
  const element=selector=>{
    if(!elements.has(selector))elements.set(selector,{value:'',innerHTML:'',textContent:'',hidden:selector==='#loading',open:false,lastElementChild:null,querySelectorAll(){return [];},addEventListener(){},close(){this.open=false;},focus(){}});
    return elements.get(selector);
  };
  const storage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v)};
  const context=vm.createContext({console,localStorage:storage,document:{querySelector:element,querySelectorAll(){return [];},addEventListener(){}},window:{addEventListener(){},scrollTo(){}},history:{replaceState(){}},setTimeout,clearTimeout,AbortController});
  for(const name of ['chat-store.js','analysis-tools.js','chat-actions.js','app.js'])
    vm.runInContext(fs.readFileSync(path.join(root,'app/static',name),'utf8').replace(/\ninit\(\);\s*$/,''),context);
  vm.runInContext('renderAnalysis=()=>{};this.refs={state,filterActionState,chatStore,getHistory:()=>chatHistory,setHistory:messages=>chatHistory=messages,setReady:()=>chatReady=true,sendChat,applyChatFilter,undoChatFilter,renderFilterAction,canUndoFilter,initChatActions};',context);
  const refs=context.refs;
  Object.assign(refs.state,{page:'explore',filters:{},analysis:cohort(),stays:{items:[],total:94363},pageNumber:2,sort:'los_desc'});
  const plan={version:1,id:'a'.repeat(20),changes:{age:'65+',los_min:'7'},base_filters:{},filters:{age:'65+',los_min:'7'},reason:'筛选65岁及以上且停留至少7天',question:'筛出65岁及以上，停留至少7天',preview_summary:cohort({age:'65+'}).summary};
  const source=refs.chatStore.create({});source.messages=[{role:'user',content:plan.question},{role:'assistant',content:'请核对筛选建议。',filter_action:clone(plan)}];
  refs.setHistory(source.messages);
  const originalSource=JSON.stringify(source.messages);
  let failList=false,releasePreview=null,delayPreview=false;
  const gate=()=>new Promise(resolve=>releasePreview=resolve);
  context.fetch=async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    if(url==='/api/chat')return {ok:true,json:async()=>({answer:'核对条件后点击应用。',charts:[],blocks:[],filter_action:clone(plan),model:'test-only',evidence:{summary:cohort().summary}})};
    if(delayPreview)await gate();
    return {ok:true,json:async()=>clone(plan)};
  };
  context.api=async(url,params)=>{
    calls.push({url,params:clone(params)});
    if(url==='/api/stays'&&failList)throw new Error('查询失败测试');
    const data=cohort(params);
    return url==='/api/analysis'?data:{items:[],total:data.summary.stays,page:params.page,page_size:params.page_size};
  };
  return {context,refs,plan,source,originalSource,elements,element,memory,calls,setDelay:()=>delayPreview=true,release:()=>releasePreview(),failList:()=>failList=true};
}
(async()=>{
  let count=0;
  let h=harness();
  const html=h.refs.renderFilterAction({...h.source.messages[1],filter_action:{...h.plan,reason:'<img src=x onerror=alert(1)>'}},1);
  assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));count++;
  await h.refs.applyChatFilter(1);
  assert.deepEqual(clone(h.refs.state.filters),{age:'65+',los_min:'7'});
  assert.equal(h.refs.state.analysis.summary.stays,5957);
  assert.notEqual(h.refs.chatStore.activeId,h.source.id);
  assert.equal(h.refs.chatStore.active().messages[1].source,'local');
  assert.deepEqual(clone(h.source.filters),{});
  assert.equal(h.source.messages[1].content,'请核对筛选建议。');
  assert.ok(h.refs.canUndoFilter());
  assert.ok(h.calls.some(c=>c.url==='/api/filter-preview'));
  assert.ok(h.calls.some(c=>c.url==='/api/analysis'&&c.params.age==='65+'));
  assert.ok(h.calls.some(c=>c.url==='/api/stays'&&c.params.los_min==='7'));
  count++;
  h.refs.filterActionState.transaction=null;h.refs.initChatActions();
  assert.ok(h.refs.canUndoFilter());count++;
  await h.refs.undoChatFilter();
  assert.deepEqual(clone(h.refs.state.filters),{});
  assert.equal(h.refs.chatStore.activeId,h.source.id);
  assert.equal(h.refs.state.pageNumber,2);
  assert.equal(h.refs.state.analysis.summary.stays,94363);
  assert.equal(h.refs.filterActionState.transaction.status,'undone');
  assert.ok(!h.refs.canUndoFilter());count++;

  h=harness();h.failList();await h.refs.applyChatFilter(1);
  assert.deepEqual(clone(h.refs.state.filters),{});
  assert.equal(h.refs.chatStore.sessions.length,1);
  assert.equal(JSON.stringify(h.source.messages),h.originalSource);
  assert.equal(h.refs.filterActionState.transaction,null);count++;

  h=harness();h.setDelay();const pending=h.refs.applyChatFilter(1);
  assert.deepEqual(clone(h.refs.state.filters),{});
  assert.equal(h.refs.chatStore.activeId,h.source.id);
  h.refs.state.filters={gender:'M'};h.refs.state.request++;
  h.release();await pending;
  assert.deepEqual(clone(h.refs.state.filters),{gender:'M'});
  assert.equal(h.refs.chatStore.sessions.length,1);
  assert.equal(h.refs.filterActionState.transaction,null);count++;

  h=harness();h.source.messages[1].action_dismissed=true;await h.refs.applyChatFilter(1);assert.equal(h.calls.length,0);count++;
  h=harness();h.refs.state.filters={unit:'another'};await h.refs.applyChatFilter(1);assert.equal(h.calls.length,0);count++;

  h=harness();h.refs.setHistory([]);h.source.messages=[];h.refs.setReady();
  await h.refs.sendChat(h.plan.question);
  const button=h.element('#ai-result').innerHTML.match(/<button[^>]*data-apply-filter="1"[^>]*>/)?.[0];
  assert.ok(button);assert.ok(!button.includes('disabled'));
  assert.deepEqual(clone(h.refs.state.filters),{});
  assert.equal(h.refs.getHistory()[1].filter_action.preview_summary.stays,5957);count++;

  h=harness();h.plan.changes={los_min:'10000'};h.plan.filters={los_min:'10000'};
  h.plan.preview_summary=cohort(h.plan.filters).summary;h.plan.question='停留至少10000天';
  h.source.messages[1].filter_action=clone(h.plan);
  await h.refs.applyChatFilter(1);
  assert.equal(h.refs.state.analysis.summary.stays,0);
  assert.ok(h.refs.chatStore.active().messages[1].content.includes('无匹配记录'));
  assert.ok(h.refs.canUndoFilter());count++;

  const report={all_passed:true,checks:count,external_model_calls:0};
  fs.writeFileSync(path.join(root,'reports/filter_actions_frontend_validation.json'),JSON.stringify(report,null,2)+'\n');
  console.log(`${count} action-flow checks passed: click-only mutation, fresh queries, independent history, persisted undo, failure rollback, stale context, dismissal, enabled buttons and empty results.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
