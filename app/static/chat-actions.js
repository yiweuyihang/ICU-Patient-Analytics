'use strict';

const filterActionState={busy:false,request:0,transaction:null,storageError:''};
const filterTransactionKey='icu-atlas-last-filter-action-v1';
const actionFields=['age','gender','unit','los_min','los_max'];
function sameActionFilters(a,b) {
  const clean=value=>Object.entries(value||{}).filter(([,v])=>v!=='').sort(([a],[b])=>a.localeCompare(b));
  return JSON.stringify(clean(a))===JSON.stringify(clean(b));
}
function validActionFilters(value) {
  return value&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).every(([key,v])=>[...actionFields,'search'].includes(key)&&typeof v==='string'&&v.length<=200);
}
function validFilterPlan(plan) {
  return plan&&plan.version===1&&typeof plan.id==='string'&&/^[a-f0-9]{20}$/.test(plan.id)&&
    validActionFilters(plan.base_filters)&&validActionFilters(plan.filters)&&plan.changes&&typeof plan.changes==='object'&&!Array.isArray(plan.changes)&&
    Object.keys(plan.changes).length>0&&Object.entries(plan.changes).every(([key,value])=>actionFields.includes(key)&&(value===null||typeof value==='string'&&value.length<=200))&&
    typeof plan.question==='string'&&plan.question.length<=1500&&typeof plan.reason==='string'&&plan.reason.length<=300&&
    plan.preview_summary&&Number.isSafeInteger(plan.preview_summary.stays)&&plan.preview_summary.stays>=0&&
    Number.isSafeInteger(plan.preview_summary.patients)&&plan.preview_summary.patients>=0;
}
function actionFieldLabel(key,value) {
  if(value==null||value==='')return '不限';
  if(key==='age')return ageName(value);
  if(key==='gender')return value==='F'?'女性':value==='M'?'男性':value;
  if(key==='unit')return unitName(value);
  return (key==='los_min'?'≥ ':'< ')+value+' 天';
}
function renderFilterAction(message,index) {
  const plan=message.filter_action;
  const notice=message.action_notice?`<div class="filter-action-explanation">${esc(message.action_notice)}</div>`:'';
  if(!plan)return notice;
  if(!validFilterPlan(plan))return '<div class="filter-action-explanation">这条历史筛选建议无法核对，请重新提问。</div>';
  if(message.action_dismissed)return '<div class="filter-action-dismissed">这次筛选建议已忽略。</div>';
  const matches=sameActionFilters(state.filters,plan.base_filters),busy=filterActionState.busy||!!summaryController||!$('#loading').hidden;
  const names={age:'年龄',gender:'性别',unit:'ICU 类型',los_min:'停留下限',los_max:'停留上限'};
  const changes=Object.keys(plan.changes).map(key=>`<div class="filter-change"><span>${names[key]}</span><span>${esc(actionFieldLabel(key,plan.base_filters[key]))}</span><i>→</i><strong>${esc(actionFieldLabel(key,plan.filters[key]))}</strong></div>`).join('');
  const summary=plan.preview_summary;
  return `${notice}<section class="filter-action-card" aria-label="待确认的筛选建议"><div class="filter-action-heading"><span class="filter-action-icon">⌘</span><div><span class="eyebrow">REVIEW → APPLY</span><h3>把这句话，变成筛选条件。</h3></div><span class="filter-action-badge">尚未应用</span></div><p class="filter-action-reason">${esc(plan.reason)}</p><div class="filter-changes">${changes}</div><div class="filter-action-scope"><span>应用后的完整范围</span><strong>${esc(filterDescription(plan.filters))}</strong></div><div class="filter-preview"><div><span>匹配 ICU 入住</span><strong>${fmt(summary.stays)}<small>次</small></strong></div><div><span>涉及患者</span><strong>${fmt(summary.patients)}<small>位</small></strong></div></div><p class="filter-preview-note">回答时由数据库查询的预览；点击后会重新核对。${summary.stays===0?'当前条件没有匹配记录，可调整问题后重新生成。':''}${plan.filters.search?'当前案例搜索条件将继续保留。':''}</p><div class="filter-action-buttons"><button type="button" class="primary" data-apply-filter="${index}" ${!matches||busy?'disabled':''}>${filterActionState.busy?'正在更新…':'应用筛选 ↗'}</button><button type="button" class="text-button" data-dismiss-filter="${index}" ${busy?'disabled':''}>暂不应用</button></div><p class="filter-action-note">${matches?'未列出的条件保持不变；应用后可一键撤销。':'当前筛选与这条建议的起点不同，请基于当前范围重新提问。'}</p></section>`;
}
function canUndoFilter(transaction=filterActionState.transaction) {
  return transaction&&transaction.status==='applied'&&state.page!=='detail'&&
    chatStore.activeId===transaction.targetSessionId&&sameActionFilters(state.filters,transaction.afterFilters);
}
function renderFilterReceipt(message) {
  const receipt=message.filter_receipt;if(!receipt||typeof receipt.id!=='string')return '';
  const transaction=filterActionState.transaction,same=transaction?.id===receipt.id,undo=canUndoFilter()&&same;
  return `<div class="filter-receipt"><span>图表、列表与当前对话已切换到这组条件。</span><div><button class="preset" type="button" data-view-filter-charts>查看图表 ↗</button><button class="text-button" type="button" data-undo-filter ${!undo||filterActionState.busy||!!summaryController?'disabled':''}>${same&&transaction.status==='undone'?'已撤销':'撤销这次筛选'}</button></div>${!undo?'<small>撤销仅适用于最近一次操作，且当前范围须与应用结果一致。</small>':''}</div>`;
}
function storeFilterTransaction() {
  try {localStorage.setItem(filterTransactionKey,JSON.stringify(filterActionState.transaction));filterActionState.storageError='';}
  catch {filterActionState.storageError='本机未能保存撤销记录；本页仍可撤销。';}
}
function syncFilterActionUI() {
  const notice=$('#filter-action-notice');if(!notice)return;
  const transaction=filterActionState.transaction,show=canUndoFilter(transaction);
  notice.hidden=!show;
  if(show)notice.innerHTML=`<div><strong>✓ 已应用助手筛选</strong><span>当前 ${fmt(state.analysis?.summary.stays)} 次入住 · 可返回应用前的筛选范围</span></div><button class="preset" type="button" data-undo-filter ${filterActionState.busy||!!summaryController||!$('#loading').hidden?'disabled':''}>撤销这次筛选 ↶</button>`;
}
function actionContext() {
  return {filters:{...state.filters},sessionId:chatStore.activeId,page:state.page,request:state.request,sort:state.sort};
}
function sameActionContext(context) {
  return context.page===state.page&&context.sessionId===chatStore.activeId&&context.request===state.request&&sameActionFilters(context.filters,state.filters);
}
async function readFilterTarget(filters,context,pageNumber=1) {
  const [data,list]=await Promise.all([api('/api/analysis',filters),api('/api/stays',{...filters,page:pageNumber,page_size:context.page==='overview'?5:15,sort:context.sort})]);
  return {data,list};
}
function showActionAnalysis(filters,payload,context,pageNumber=1) {
  state.request++;state.vitalRequest++;
  state.filters={...filters};state.page=context.page;state.pageNumber=pageNumber;state.sort=context.sort;
  state.analysis=payload.data;state.stays=payload.list;
  syncFilters();updateHeading();writeURL();renderAnalysis();resetSummary();updateSummaryScope();
  $('.heading-aside').innerHTML=`<span>当前分析队列</span><strong>${fmt(payload.data.summary.stays)}<small> 次入住</small></strong><span>${fmt(payload.data.summary.patients)} 位患者 · ${fmt(payload.data.summary.stays/payload.data.total_cohort*100,1)}% 纳入队列</span>`;
  hideError();syncFilterActionUI();
}
async function applyChatFilter(index) {
  if(filterActionState.busy||summaryController||!$('#loading').hidden)return;
  const message=chatHistory[index],plan=message?.filter_action,sourceSession=chatStore.active();
  if(!sourceSession||!validFilterPlan(plan)||message.action_dismissed||!sameActionFilters(state.filters,plan.base_filters)||state.page==='detail')return;
  const context=actionContext(),beforePageNumber=state.pageNumber,request=++filterActionState.request;
  filterActionState.busy=true;renderChat();syncChatControls();
  $('#ai-status').textContent='正在重新核对筛选条件和匹配记录…';
  try {
    const response=await fetch('/api/filter-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filters:context.filters,changes:plan.changes,question:plan.question})});
    const prepared=await response.json();
    if(!response.ok)throw new Error(prepared.error||'筛选条件核对失败');
    if(!sameActionFilters(prepared.filters,plan.filters)||prepared.id!==plan.id)throw new Error('这条建议与当前条件不一致，请重新生成。');
    const payload=await readFilterTarget(prepared.filters,context);
    if(request!==filterActionState.request||!sameActionContext(context))throw new Error('当前页面或对话已改变，本次建议未应用。');
    saveChatDraft();
    const now=Date.now(),id=now.toString(36)+'-'+Math.random().toString(36).slice(2),s=payload.data.summary;
    const session=chatStore.create(prepared.filters);
    const scope=filterDescription(prepared.filters);
    session.title=('筛选 · '+scope).slice(0,40);
    session.messages=[{role:'user',content:'应用筛选：'+scope},
      {role:'assistant',source:'local',content:`已应用筛选：${scope}。\n\n数据库实际匹配 ${fmt(s.stays)} 次 ICU 入住、${fmt(s.patients)} 位患者、${fmt(s.admissions)} 次住院。${s.median_los==null?'当前无匹配记录，可以继续描述新的筛选条件。':'ICU 停留中位数为 '+fmt(s.median_los,2)+' 天。你可以继续询问当前队列的构成或分布。'}`,filter_receipt:{id}}];
    session.evidence=Object.fromEntries(['summary','units','ages','genders','histogram','boxes'].map(key=>[key,payload.data[key]]));
    session.evidence.filters={...prepared.filters};session.model='本地统计';session.updatedAt=now;
    message.action_applied_at=now;sourceSession.updatedAt=now;
    filterActionState.transaction={id,status:'applied',beforeFilters:context.filters,afterFilters:{...prepared.filters},originSessionId:sourceSession.id,targetSessionId:session.id,beforePage:context.page,beforePageNumber,beforeSort:context.sort};
    chatStore.persist();storeFilterTransaction();
    $('#chat-input').value='';
    showActionAnalysis(prepared.filters,payload,context);
    $('#ai-status').textContent='筛选已应用 · 当前统计已更新'+(filterActionState.storageError?' · '+filterActionState.storageError:'');
    $('#assistant-drawer').close();window.scrollTo({top:0,behavior:'instant'});
  } catch(error){$('#ai-status').textContent=error.message;}
  finally {if(request===filterActionState.request){filterActionState.busy=false;renderChat();syncChatControls();syncFilterActionUI();}}
}
async function undoChatFilter() {
  if(filterActionState.busy||summaryController||!$('#loading').hidden||!canUndoFilter())return;
  const transaction=filterActionState.transaction,context=actionContext(),request=++filterActionState.request;
  filterActionState.busy=true;syncChatControls();syncFilterActionUI();renderChat();
  try {
    const previous={...context,page:transaction.beforePage,sort:transaction.beforeSort};
    const payload=await readFilterTarget(transaction.beforeFilters,previous,transaction.beforePageNumber);
    if(request!==filterActionState.request||!sameActionContext(context))throw new Error('当前页面或对话已改变，本次撤销未执行。');
    saveChatDraft();
    transaction.status='undone';storeFilterTransaction();
    chatStore.activeId=chatStore.sessions.some(s=>s.id===transaction.originSessionId)?transaction.originSessionId:null;chatStore.persist();
    $('#chat-input').value=chatStore.active()?.draft||'';
    showActionAnalysis(transaction.beforeFilters,payload,previous,transaction.beforePageNumber);
    $('#ai-status').textContent='已撤销这次助手筛选，原来的条件和对话已恢复。';
    $('#assistant-drawer').close();window.scrollTo({top:0,behavior:'instant'});
  } catch(error){showError(error);$('#ai-status').textContent=error.message;}
  finally {if(request===filterActionState.request){filterActionState.busy=false;renderChat();syncChatControls();syncFilterActionUI();}}
}
function initChatActions() {
  try {
    const saved=JSON.parse(localStorage.getItem(filterTransactionKey)||'null');
    if(saved&&typeof saved.id==='string'&&['applied','undone'].includes(saved.status)&&validActionFilters(saved.beforeFilters)&&validActionFilters(saved.afterFilters)&&
      typeof saved.originSessionId==='string'&&typeof saved.targetSessionId==='string'&&['overview','explore','cases'].includes(saved.beforePage)&&
      ['los_desc','los_asc','stay_asc'].includes(saved.beforeSort)&&Number.isSafeInteger(saved.beforePageNumber)&&saved.beforePageNumber>=1&&saved.beforePageNumber<=100000)
      filterActionState.transaction=saved;
  } catch {filterActionState.storageError='未能恢复上次撤销记录，已有对话仍可查看。';}
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.applyFilter!=null)applyChatFilter(Number(button.dataset.applyFilter));
    if(button.dataset.dismissFilter!=null&&!filterActionState.busy&&!summaryController){const message=chatHistory[Number(button.dataset.dismissFilter)];if(message?.filter_action){message.action_dismissed=true;chatStore.persist();renderChat();}}
    if(button.hasAttribute('data-undo-filter'))undoChatFilter();
    if(button.hasAttribute('data-view-filter-charts')){$('#assistant-drawer').close();window.scrollTo({top:0,behavior:'instant'});}
  });
}
