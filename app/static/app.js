'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (v,d=0) => v == null ? '—' : Number(v).toLocaleString('zh-CN',{maximumFractionDigits:d,minimumFractionDigits:d});
const shortUnits = {'Medical Intensive Care Unit (MICU)':'MICU · 内科','Medical/Surgical Intensive Care Unit (MICU/SICU)':'MICU/SICU · 内外科','Cardiac Vascular Intensive Care Unit (CVICU)':'CVICU · 心脏血管','Surgical Intensive Care Unit (SICU)':'SICU · 外科','Coronary Care Unit (CCU)':'CCU · 冠心病','Trauma SICU (TSICU)':'TSICU · 创伤外科','Neuro Intermediate':'神经中间监护','Neuro Surgical Intensive Care Unit (Neuro SICU)':'Neuro SICU · 神经外科','Neuro Stepdown':'神经过渡监护','Surgery/Vascular/Intermediate':'外科/血管中间监护'};
const unitName = s => shortUnits[s] || s;
const ageName = s => s === '65+' ? '65 岁及以上' : s === '90+' ? '90 岁及以上' : `${s.replace('-','–')} 岁`;
const palette = {colors:['#69a4dd','#74a7a5','#8a80b9','#bd976b','#8c9bb4','#7eafb9'], bar:'#4b8bc9', donut:['#4b8bc9','#8a80b9'], heat:'43,105,175', box:'#c6ddf5', stroke:'#3575b7'};
const colors = palette.colors;
const vitalColors=['#357dc2','#258b89','#ad7955'];
const stableUnitColors=['#387cc8','#8b78b6','#398f91','#b48668','#9b8b49','#529c98','#a87594','#5f8db5','#9c8870','#4c9fbd','#ad8745','#7c9186','#a38ab0','#658f7d','#b48d7f','#788cb6','#8c9a58'];
const knownUnits=[...Object.keys(shortUnits),'Intensive Care Unit (ICU)','Med/Surg','Medicine','Medicine/Cardiology Intermediate','Neurology','PACU','Surgery/Trauma'];
const unitColor = unit => {const index=knownUnits.indexOf(unit);if(index>=0)return stableUnitColors[index%stableUnitColors.length];let hash=0;for(const c of unit)hash=(hash*31+c.charCodeAt(0))>>>0;return stableUnitColors[hash%stableUnitColors.length];};

const state = {page:'overview',returnPage:'explore',filters:{},analysis:null,stays:null,pageNumber:1,sort:'los_desc',detail:null,stayId:null,vitals:null,vitalOverview:null,range:null,flagged:false,bp:'noninvasive',request:0,vitalRequest:0,overviewRequest:0,heatMode:'count'};
let scatterPoints=[];
let resizeTimer;

let summaryRequest=0;
let summaryController=null;
let chatHistory=[];
let chatReady=false;
let chatStore;
try {chatStore=new ChatStore(localStorage);} catch {chatStore=new ChatStore({getItem(){return null;},setItem(){throw new Error('unavailable');}});}
let draftTimer;
function saveChatDraft() {
  const session=chatStore.active();
  if(session && session.draft!==$('#chat-input').value) {
    session.draft=$('#chat-input').value;session.updatedAt=Date.now();chatStore.persist();
  }
}
function renderSessions() {
  const sessions=[...chatStore.sessions].sort((a,b)=>b.updatedAt-a.updatedAt);
  $('#chat-session-list').innerHTML=sessions.length?sessions.map(session=>{
    const time=new Date(session.updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const scope=[session.filters.unit?unitName(session.filters.unit):'全部 ICU',session.filters.age?ageName(session.filters.age):'',session.filters.los_min?`≥${session.filters.los_min} 天`:''].filter(Boolean).join(' · ');
    return `<button type="button" class="chat-session ${session.id===chatStore.activeId?'selected':''}" data-session="${esc(session.id)}" aria-pressed="${session.id===chatStore.activeId}"><strong>${esc(session.title)}</strong><span>${esc(scope)}</span><small>${time} · ${session.messages.length/2} 轮对话${session.draft?' · 有草稿':''}</small></button>`;
  }).join(''):'<div class="chat-history-empty">还没有历史对话<br>发送第一个问题后自动保存</div>';
  $('#chat-session-title').textContent=chatStore.active()?.title||'新对话 · 从一个问题开始';
  $('.chat-storage-note').textContent=chatStore.error||'新建对话不会删除旧记录。选择历史对话时，恢复当时的筛选范围。';
}
function restoreEvidence() {
  const session=chatStore.active();
  $('#ai-evidence').hidden=!session?.evidence;
  if(session?.evidence) $('#ai-evidence-text').textContent=JSON.stringify(session.evidence,null,2);
}

function renderChat(pending=null) {
  const messages=pending?[...chatHistory,{role:'user',content:pending}]:chatHistory;
  $('#ai-result').innerHTML=messages.length?messages.map((message,index)=>`<div class="chat-message ${message.role}"><span>${message.role==='user'?'你':message.source==='local'?'✓ 筛选操作 · 本地统计':'✧ DeepSeek'}</span><div class="chat-answer">${renderChatAnswer(message,index)}</div></div>`).join(''):'<div class="chat-welcome"><strong>从一个问题，走到一组数据。</strong>可以直接描述筛选条件，例如“筛出65岁及以上、ICU停留至少7天的入住”。我会先给出条件卡片，点击应用后才更新页面。也可以继续询问当前队列的构成与分布。</div>';
  fitColumnCharts($('#ai-result'));
  const last=$('#ai-result').lastElementChild;
  if(last) $('#ai-result').scrollTop=messages[messages.length-1]?.filter_action?$('#ai-result').scrollHeight:last.offsetTop-$('#ai-result').offsetTop;
}
function renderChatAnswer(message,index=-1) {
  const action=message.role==='assistant'?renderFilterAction(message,index)+renderFilterReceipt(message):'';
  if(message.role==='assistant' && Array.isArray(message.blocks) && message.blocks.length) {
    return message.blocks.slice(0,6).map(block=>`<section class="chat-answer-section"><div class="chat-answer-text">${esc(block.text)}</div>${block.chart?renderChatCharts([block.chart]):''}${block.interpretation?`<div class="chat-chart-interpretation">${esc(block.interpretation)}</div>`:''}</section>`).join('')+action;
  }
  return `<div class="chat-answer-text">${esc(message.content)}</div>${message.role==='assistant'?renderChatCharts(message.charts):''}`+action;
}
function renderChatCharts(charts) {
  if(!Array.isArray(charts)) return '';
  const views={
    ages:['年龄构成',d=>columnChart(d.ages,'age'),'90+ 为脱敏年龄组；次数按 ICU 入住统计。'],
    genders:['性别构成',genderChart,'占比按 ICU 入住统计，患者可重复入住。'],
    units:['ICU 类型分布',unitBars,'按首次进入的 ICU 类型统计。'],
    histogram:['停留时长分布',d=>columnChart(d.histogram,'los'),'区间左闭右开，单位：天。'],
    boxes:['各 ICU 停留时长箱线图',boxplot,'箱体为 Q1–Q3，中线为中位数；须端按 1.5 × IQR，须外值不绘制。']
  };
  return '<div class="chat-charts">'+charts.slice(0,3).map(chart=>{
    const view=views[chart?.id],data=chart?.data;
    if(!view || !data?.summary || !Array.isArray(data[chart.id])) return '';
    // Reuse the website's actual chart renderers, as a read-only answer snapshot.
    const graphic=view[1](data).replace(/<button\b/g,'<span').replace(/<\/button>/g,'</span>')
      .replace(/\sdata-[\w-]+="[^"]*"/g,'').replace(/\s(?:tabindex="0"|role="button")/g,'')
      .replace(/aria-label="筛选 /g,'aria-label="').replace(/ · 点击筛选/g,'');
    return `<figure class="chat-chart" data-chat-chart="${chart.id}"><figcaption><strong>${view[0]}</strong><span>网站同款图表 · 本次回答 ${fmt(data.summary.stays)} 次入住</span></figcaption>${graphic}<p class="chat-chart-note">${view[2]}</p></figure>`;
  }).join('')+'</div>';
}
function syncChatControls() {
  const disabled=!chatReady||!!summaryController||filterActionState.busy;
  $('#chat-send').disabled=disabled;
  $$('[data-question]').forEach(button=>button.disabled=disabled);
  $('#chat-send').textContent=summaryController?'回答中…':'发送 ↗';
  syncFilterActionUI();
}
function resetSummary() {
  saveChatDraft();
  summaryRequest++;
  if(summaryController) summaryController.abort();
  summaryController=null; chatReady=false;
  const session=chatStore.selectFor(state.filters);
  chatHistory=session?.messages||[];
  $('#ai-summary').hidden=state.page==='detail';
  $('#ai-evidence').hidden=true; $('#ai-evidence').open=false;
  $('#ai-status').textContent='';
  $('#ai-scope').textContent='正在载入分析范围…';
  $('#chat-input').value=session?.draft||'';
  renderChat();renderSessions();restoreEvidence();syncChatControls();
}
function updateSummaryScope() {
  const count=state.analysis.summary.stays;
  const chips=$$('#filter-chips .chip').map(node=>node.textContent.replace(/×$/,'')).join(' · ');
  $('#ai-scope').textContent=(chips||'全部纳入队列')+' · '+fmt(count)+' 次入住';
  chatReady=true; syncChatControls();
  if(!count) $('#ai-status').textContent='当前无记录，可以描述新的筛选条件，先预览再应用。';
  else if(chatStore.active()?.messages.length) $('#ai-status').textContent='已恢复历史对话 · '+chatStore.active().model;
  if(chatStore.error) $('#ai-status').textContent=chatStore.error;
}
async function sendChat(question) {
  if(!chatReady||summaryController||filterActionState.busy||!question.trim()) return;
  question=question.trim();
  if(question.length>1500) {$('#ai-status').textContent='问题最多1500字，请精简后发送。';return;}
  const session=chatStore.active()||chatStore.create(state.filters);
  if(!session.messages.length) session.title=question.slice(0,28)+(question.length>28?'…':'');
  session.draft=question;session.updatedAt=Date.now();chatStore.persist();renderSessions();
  const request=++summaryRequest;
  summaryController=new AbortController();
  const controller=summaryController;
  const timeout=setTimeout(()=>controller.abort(),70000);
  const messages=[...chatHistory.slice(-10).map(({role,content})=>({role,content})),{role:'user',content:question}];
  renderChat(question); syncChatControls();
  $('#ai-status').textContent='DeepSeek 正在结合统计依据回答…';
  try {
    const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filters:{...session.filters},messages}),signal:controller.signal});
    const data=await response.json();
    if(request!==summaryRequest) return;
    if(!response.ok) throw new Error(data.error||'对话请求失败');
    chatHistory=[...chatHistory,{role:'user',content:question},{role:'assistant',content:data.answer,charts:data.charts||[],blocks:data.blocks||[],filter_action:data.filter_action||null,action_notice:data.action_notice||''}];
    session.messages=chatHistory;session.draft='';session.evidence=data.evidence;session.model=data.model;session.updatedAt=Date.now();chatStore.persist();renderSessions();
    $('#chat-input').value=''; renderChat();
    $('#ai-evidence-text').textContent=JSON.stringify(data.evidence,null,2); $('#ai-evidence').hidden=false;
    $('#ai-status').textContent='已回答 · '+data.model+' · 完整记录已保存'+(chatStore.error?' · '+chatStore.error:'');
  } catch(error) {
    if(request===summaryRequest) {
      renderChat(); $('#chat-input').value=question;
      $('#ai-status').textContent=error.name==='AbortError'?'回答超时，问题已保留，可以重试。':error.message;
    }
  } finally {
    clearTimeout(timeout);
    if(request===summaryRequest) {summaryController=null;syncChatControls();renderChat();}
  }
}
$('#chat-form').addEventListener('submit',event=>{event.preventDefault();sendChat($('#chat-input').value);});
$('#chat-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendChat(event.currentTarget.value);}});
$$('[data-question]').forEach(button=>button.addEventListener('click',()=>{$('#chat-input').value=button.dataset.question;saveChatDraft();$('#chat-input').focus();}));
$('#chat-input').addEventListener('input',()=>{clearTimeout(draftTimer);draftTimer=setTimeout(()=>{saveChatDraft();renderSessions();},300);});
window.addEventListener('pagehide',saveChatDraft);
$('#new-chat').addEventListener('click',()=>{saveChatDraft();chatStore.create(state.filters);$('#chat-input').value='';resetSummary();if(state.analysis && $('#loading').hidden)updateSummaryScope();$('#chat-input').focus();});
$('#chat-session-list').addEventListener('click',event=>{
  const button=event.target.closest('[data-session]');if(!button)return;
  const session=chatStore.sessions.find(s=>s.id===button.dataset.session);if(!session)return;
  saveChatDraft();chatStore.activeId=session.id;chatStore.persist();$('#chat-input').value=session.draft;
  state.filters={...session.filters};state.pageNumber=1;syncFilters();loadAnalysis();
});

async function api(path,params={}) {
  const query = new URLSearchParams(Object.entries(params).filter(([,v])=>v !== '' && v != null));
  const res = await fetch(path+(query.size?'?'+query:''));
  const data = await res.json();
  if(!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
function showError(e) { $('#message').textContent=e.message;$('#message').hidden=false; }
function hideError() { $('#message').hidden=true; }
function tooltip(event,html) {
  const t=$('#tooltip'); t.innerHTML=html;t.hidden=false;
  t.style.left=Math.max(8,Math.min(event.clientX+14,innerWidth-t.offsetWidth-12))+'px';
  t.style.top=Math.max(8,Math.min(event.clientY+12,innerHeight-t.offsetHeight-12))+'px';
}
function hideTooltip() { $('#tooltip').hidden=true; }
function writeURL() {
  const query=new URLSearchParams(state.filters).toString();
  history.replaceState(null,'','#'+(state.page==='detail'?`detail/${state.stayId}`:state.page)+(query?'?'+query:''));
}
function syncFilters() {
  for(const name of ['age','gender','unit','los_min','los_max']) $(`[name="${name}"]`).value=state.filters[name] ?? '';
  const names={age:v=>ageName(v),gender:v=>v==='F'?'女性':'男性',unit:v=>unitName(v),los_min:v=>`停留 ≥ ${v} 天`,los_max:v=>`停留 < ${v} 天`,search:v=>`搜索：${v}`};
  $('#filter-chips').innerHTML=Object.entries(state.filters).filter(([,v])=>v!=='').map(([k,v])=>`<button class="chip" data-remove="${esc(k)}">${esc(names[k]?.(v)||v)}<span>×</span></button>`).join('');
}
function updateHeading() {
  const info={overview:['数据总览','观生命之象，探疾患之理。','从整体分布开始，探索 ICU 患者构成与停留时长。'],explore:['群体探索','参伍以辨。','比较群体分布，点击图表筛选，再下钻到具体入住。'],cases:['案例搜索','循迹以察。','输入编号或关键词查找案例，点击结果查看时间线与生命体征。'],detail:['入住详情',`入住 #${state.stayId}`,'沿时间线查看生命体征，保留每一段变化与缺失。']}[state.page];
  $('#breadcrumb').textContent=info[0];$('#page-title').textContent=info[1];$('#page-description').textContent=info[2];
  $$('.nav-item').forEach(n=>{const active=n.dataset.page===state.page;n.classList.toggle('active',active);if(active)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');});
  $('#detail-nav').disabled=!state.stayId;$('#filter-panel').hidden=state.page==='detail';
  $('.heading-aside').hidden=state.page==='detail';
  $('#assistant-toggle').hidden=state.page==='detail';
  if(state.page==='detail'&&$('#assistant-drawer').open)$('#assistant-drawer').close();
}
async function navigate(page,stayId=null,push=true) {
  if(page==='detail'&&state.page!=='detail')state.returnPage=state.page;
  if(page!=='detail'&&state.page!=='detail'&&page!==state.page)state.pageNumber=1;
  state.page=page;
  if(stayId!=null) { state.stayId=Number(stayId);state.range=null;state.flagged=false;state.vitalOverview=null;state.overviewRequest++; }
  hideTooltip();hideError();updateHeading();resetSummary();
  if(push){history.pushState(null,'','#'+(page==='detail'?`detail/${state.stayId}`:page));writeURL();}
  window.scrollTo({top:0,behavior:'instant'});
  if(page==='detail') await loadDetail(); else await loadAnalysis();
}
async function loadAnalysis() {
  resetSummary();const request=++state.request;state.vitalRequest++;hideError();$('#loading').hidden=false;
  try {
    const [data,list]=await Promise.all([api('/api/analysis',state.filters),api('/api/stays',{...state.filters,page:state.pageNumber,page_size:state.page==='overview'?5:15,sort:state.sort})]);
    if(request!==state.request || state.page==='detail')return;
    state.analysis=data;state.stays=list;syncFilters();writeURL();renderAnalysis();updateSummaryScope();
    $('.heading-aside').innerHTML=`<span>当前分析队列</span><strong>${fmt(data.summary.stays)}<small> 次入住</small></strong><span>${fmt(data.summary.patients)} 位患者 · ${fmt(data.summary.stays/data.total_cohort*100,1)}% 纳入队列</span>`;
  } catch(e){if(request===state.request){showError(e);$('#page-content').innerHTML='<div class="empty">查询未完成，请调整筛选条件后重试。</div>';}}
  finally {if(request===state.request){$('#loading').hidden=true;syncChatControls();renderChat();}}
}
function applyFilters(patch) {
  state.filters={...state.filters,...patch};
  for(const key of Object.keys(state.filters))if(state.filters[key]==='' || state.filters[key]==null) delete state.filters[key];
  state.pageNumber=1;syncFilters();loadAnalysis();
}
function panel(title,description,content,tag='',note='',cls='') {
  return `<section class="panel ${cls}"><div class="panel-head"><div><h2>${title}</h2><p>${description}</p></div><span class="panel-kicker">${tag}</span></div>${content}${note?`<div class="panel-note">${note}</div>`:''}</section>`;
}
function stats(data) {
  const s=data.summary;
  return `<div class="stats">${[['ICU 入住次数',s.stays,'次','一次入住作为一个分析单位','◫'],['患者人数',s.patients,'人','按患者编号去重','◌'],['住院次数',s.admissions,'次','一次住院可包含多次 ICU 入住','▤'],['ICU 停留中位数',s.median_los,'天','均值 '+fmt(s.mean_los,2)+' 天','⌁']].map(([label,v,u,note,icon],i)=>`<div class="stat"><div class="stat-label">${label}<span class="stat-icon">${icon}</span></div><div class="stat-value">${fmt(v,i===3?2:0)}<small>${u}</small></div><div class="stat-sub">${note}</div></div>`).join('')}</div>`;
}
function unitBars(data) {
  const max=Math.max(1,...data.units.map(r=>r.count));
  return `<div class="bar-list">${data.units.map(r=>`<button class="bar-row" data-unit="${esc(r.unit)}" title="${esc(r.unit)} · ${fmt(r.count)} 次"><span class="bar-label">${esc(unitName(r.unit))}</span><span class="bar-track"><span class="bar-fill" style="display:block;width:${r.count/max*100}%;background:${unitColor(r.unit)}"></span></span><span class="bar-count">${fmt(r.count)}</span></button>`).join('') || '<div class="empty">暂无入住记录</div>'}</div>`;
}
function columnChart(rows,kind,width=600,readOnly=false) {
  const max=Math.max(1,...rows.map(r=>r.count)),w=Math.max(240,width),h=230,left=40,bottom=195,top=25,step=(w-left-10)/Math.max(1,rows.length);
  let svg=`<svg class="svg-chart column-chart" data-column-kind="${kind}" data-column-rows="${esc(JSON.stringify(rows))}" viewBox="0 0 ${w} ${h}" role="group" aria-label="${kind==='age'?'年龄组分布':'ICU 停留时长分布'}">`;
  for(let i=0;i<4;i++){const y=bottom-(bottom-top)*i/3;svg+=`<line x1="${left}" y1="${y}" x2="${w-10}" y2="${y}" stroke="#e5ecf5" stroke-dasharray="3 4"/><text x="${left-7}" y="${y+3}" text-anchor="end" font-size="11">${fmt(max*i/3/1000,1)}k</text>`;}
  rows.forEach((r,i)=>{const x=left+step*i+step*.18,height=r.count/max*(bottom-top),width=step*.64;
    const label=kind==='age'?r.age.replace('-','–'):r.label;
    const attr=kind==='age'?`data-age="${esc(r.age)}"`:`data-los-min="${r.min}" data-los-max="${r.max ?? ''}"`;
    svg+=`<g class="${readOnly?'':'chart-hover'}" ${readOnly?'':`${attr} tabindex="0" role="button"`} aria-label="${readOnly?'':'筛选 '}${esc(label)}，${fmt(r.count)} 次入住"><title>${esc(label)}：${fmt(r.count)} 次入住</title><rect x="${x}" y="${bottom-height}" width="${width}" height="${r.count?Math.max(2,height):0}" rx="4" fill="${kind==='age'?colors[i%colors.length]:palette.bar}"/>${step>=48||kind==='age'?`<text x="${x+width/2}" y="${bottom-height-8}" text-anchor="middle" font-size="11">${fmt(r.count)}</text>`:''}<text x="${x+width/2}" y="216" text-anchor="middle" font-size="11">${esc(label)}</text></g>`;});
  return svg+'</svg>';
}
function fitColumnCharts(scope=document) {
  scope.querySelectorAll('.column-chart').forEach(svg=>{
    const width=Math.round(svg.getBoundingClientRect().width);
    if(width<=0)return;
    svg.outerHTML=columnChart(JSON.parse(svg.dataset.columnRows),svg.dataset.columnKind,Math.min(600,width),Boolean(svg.closest('.chat-chart')));
  });
}
function genderChart(data) {
  const female=data.genders.find(r=>r.gender==='F')?.count||0,total=data.summary.stays,male=data.genders.find(r=>r.gender==='M')?.count||0;
  if(!total)return '<div class="empty">暂无入住记录</div>';
  const fraction=female/total*100;
  return `<div class="donut-layout"><div class="donut" style="background:conic-gradient(${palette.donut[0]} 0 ${fraction}%,${palette.donut[1]} ${fraction}% 100%)"><div class="donut-hole"><strong>${fmt(total)}</strong><span>次 ICU 入住</span></div></div><div class="legend-list">${[['F','女性',female,palette.donut[0]],['M','男性',male,palette.donut[1]]].map(([key,label,n,color])=>`<button class="legend-item" data-gender="${key}"><span class="legend-dot" style="background:${color}"></span><div>${label}<strong>${fmt(n)}</strong><small>${fmt(n/total*100,1)}% · 点击筛选</small></div></button>`).join('')}</div></div>`;
}
function heatmap(data) {
  const max=Math.max(1,...data.heatmap.map(r=>r.count)),units=data.units.map(r=>r.unit),proportional=state.heatMode==='share';
  const controls=`<div class="heatmap-controls" aria-label="热力图显示方式"><button class="preset ${!proportional?'active':''}" data-heat-mode="count" aria-pressed="${!proportional}">入住次数</button><button class="preset ${proportional?'active':''}" data-heat-mode="share" aria-pressed="${proportional}">ICU 内占比</button></div>`;
  const table=`<div class="heatmap-scroll"><table class="heatmap"><thead><tr><th>ICU 类型 / 年龄组</th>${['18–39','40–64','65–79','80–89','90+'].map(a=>`<th>${a}</th>`).join('')}</tr></thead><tbody>${units.map(u=>`<tr><th title="${esc(u)}">${esc(unitName(u))}</th>${['18-39','40-64','65-79','80-89','90+'].map(a=>{
    const n=data.heatmap.find(r=>r.unit===u&&r.age===a)?.count||0,total=data.units.find(r=>r.unit===u).count,share=total?n/total:0,score=proportional?share:Math.sqrt(n/max);
    return `<td><button class="heat-cell" data-unit="${esc(u)}" data-age="${a}" style="background:rgba(${palette.heat},${.04+.8*score});color:${score>.6?'#fff':'#35565c'}" title="${esc(unitName(u))} · ${ageName(a)}：${fmt(n)} 次，占该 ICU ${fmt(share*100,1)}%">${proportional?fmt(share*100,1)+'%':fmt(n)}</button></td>`;
  }).join('')}</tr>`).join('')}</tbody></table></div>`;
  return controls+table+`<div class="heatmap-scale"><span>0${proportional?'%':''}</span><i></i><span>${proportional?'100%':fmt(max)+' 次'}</span><small>${proportional?'占该 ICU 的全部筛选入住':'次数色阶经平方根映射'}</small></div>`;
}
function boxplot(data) {
  const max=Math.max(1,...data.boxes.map(b=>b.high));
  return `<div class="box-list">${data.boxes.map(b=>{const x=v=>5+v/max*275;return `<div class="box-row"><button class="box-label" data-unit="${esc(b.unit)}" title="${esc(b.unit)}">${esc(unitName(b.unit))}</button><svg viewBox="0 0 290 28" class="svg-chart" role="img" aria-label="${esc(unitName(b.unit))} 停留时长箱线图"><title>入住 ${fmt(b.count)} 次；Q1 ${fmt(b.q1,2)} 天，中位数 ${fmt(b.median,2)} 天，Q3 ${fmt(b.q3,2)} 天；须端 ${fmt(b.low,2)}–${fmt(b.high,2)} 天</title><line x1="${x(b.low)}" x2="${x(b.high)}" y1="14" y2="14" stroke="#8fa891"/><line x1="${x(b.low)}" x2="${x(b.low)}" y1="9" y2="19" stroke="#8fa891"/><line x1="${x(b.high)}" x2="${x(b.high)}" y1="9" y2="19" stroke="#8fa891"/><rect x="${x(b.q1)}" y="6" width="${Math.max(1,x(b.q3)-x(b.q1))}" height="16" rx="2" fill="${palette.box}"/><line x1="${x(b.median)}" x2="${x(b.median)}" y1="6" y2="22" stroke="${palette.stroke}" stroke-width="2"/></svg></div>`;}).join('')}</div><div class="box-axis"><span>0</span><span>${fmt(max/2,1)}</span><span>${fmt(max,1)} 天</span></div>`;
}
function caseSearchHTML() {
  return `<section class="panel case-search-panel" aria-labelledby="case-search-title"><span class="eyebrow">FIND AN ICU STAY</span><h2 id="case-search-title">从一个编号，或一个关键词开始。</h2><p id="case-search-help">编号精确匹配；支持 ICU 类型、入院类型的中英文关键词。多个词用空格分隔，须同时满足。</p><form id="case-search-form" class="case-search-form" role="search"><label for="case-search-input">搜索案例<input id="case-search-input" type="search" maxlength="100" autocomplete="off" placeholder="入住 / 患者 / 住院编号，或 MICU、内科、急诊…" aria-describedby="case-search-help" value="${esc(state.filters.search||'')}"></label><button class="primary" type="submit">搜索案例 ↗</button>${state.filters.search?'<button type="button" class="text-button" data-case-clear>清除搜索</button>':''}</form><div class="case-search-examples"><span>试试搜索</span>${['内科','心血管','急诊','MICU 紧急'].map(word=>`<button class="preset" type="button" data-case-query="${esc(word)}">${esc(word)}</button>`).join('')}</div><p class="case-search-scope">在上方筛选范围内搜索；一次 ICU 入住作为一个案例。当前数据支持编号、ICU 类型和入院类型检索。</p></section>`;
}
function tableHTML(list) {
  const totalPages=Math.max(1,Math.ceil(list.total/list.page_size));
  const search=state.page==='cases'?'':`<input id="record-search" type="search" maxlength="100" aria-label="搜索案例编号或关键词" placeholder="案例编号 / ICU 类型 / 入院类型" value="${esc(state.filters.search||'')}"><button class="preset" type="submit">搜索</button>`;
  const empty=`<tr><td colspan="8"><div class="empty"><div><strong>没有找到符合条件的案例</strong><div>请核对完整编号、换个关键词，或减少上方筛选条件。</div><div class="case-empty-actions">${state.filters.search?'<button class="preset" type="button" data-case-clear>清除搜索</button>':''}<button class="preset" type="button" data-case-reset>重置全部条件</button></div></div></div></td></tr>`;
  return `<div class="panel table-panel"><div class="table-toolbar"><h2>${state.page==='cases'?'案例列表':'入住记录'}</h2><span>${fmt(list.total)} 次符合条件</span><form id="${state.page==='cases'?'case-sort-form':'search-form'}">${search}<select id="sort-select" aria-label="排序方式"><option value="los_desc" ${state.sort==='los_desc'?'selected':''}>停留时长：长 → 短</option><option value="los_asc" ${state.sort==='los_asc'?'selected':''}>停留时长：短 → 长</option><option value="stay_asc" ${state.sort==='stay_asc'?'selected':''}>入住编号：升序</option></select></form></div><div class="table-wrap"><table><thead><tr><th>入住编号</th><th>患者编号</th><th>住院编号</th><th>年龄 / 性别</th><th>首次 ICU 类型</th><th>ICU 停留</th><th>入院类型</th><th></th></tr></thead><tbody>${list.items.map(r=>`<tr data-stay="${r.stay_id}" tabindex="0"><td class="id-cell">#${r.stay_id}</td><td>${r.subject_id}</td><td>${r.hadm_id}</td><td>${r.age_topcoded?'90+':r.age_estimate ?? '未知'} 岁 / ${r.gender==='F'?'女':'男'}</td><td><span class="tag" title="${esc(r.first_careunit)}">${esc(unitName(r.first_careunit))}</span></td><td>${fmt(r.icu_los_days,2)} 天</td><td>${esc(r.admission_type)}</td><td><button class="detail-link" data-stay="${r.stay_id}">查看详情 ↗</button></td></tr>`).join('') || empty}</tbody></table></div><div class="pagination"><span>第 ${list.page} / ${totalPages} 页 · 每页 ${list.page_size} 条</span><div><button data-pagination="-1" ${list.page<=1?'disabled':''}>← 上一页</button><button data-pagination="1" ${list.page>=totalPages?'disabled':''}>下一页 →</button></div></div></div>`;
}
function renderAnalysis() {
  const data=state.analysis;
  let content=stats(data);
  if(state.page==='cases'){
    content=caseSearchHTML()+content+`<p class="case-search-status" role="status" aria-live="polite">${state.filters.search?`“${esc(state.filters.search)}” 的搜索结果`:'当前范围内的全部案例'}<span>${fmt(data.summary.stays)} 次入住 · ${fmt(data.summary.patients)} 位患者 · 点击记录查看详情</span></p>`;
  }else if(state.page==='overview'){
    content+=`<div class="grid wide-left">${panel('ICU 类型分布','按首次进入的 ICU 类型统计',unitBars(data),'CARE UNITS','<b>↗</b> 点击条形筛选，其他视图同步更新')}${panel('年龄构成','年龄为入院年份下的估计值',columnChart(data.ages,'age'),'AGE GROUPS','90+ 为脱敏年龄组 · 点击年龄组进行筛选')}</div><div class="grid">${panel('停留时长分布','区间左闭右开，单位：天',columnChart(data.histogram,'los'),'LENGTH OF STAY','点击区间即可查看相应入住记录')}${panel('性别构成','按 ICU 入住统计，患者可重复入住',genderChart(data),'PATIENT MIX')}</div>`;
    content+='<div class="section-heading"><div><h2>从分布走近具体入住</h2><p>先查看停留较长的记录，或通过编号直接检索。</p></div><button data-go="cases">搜索案例 ↗</button></div>';
  }else{
    content+=renderComparison();
    content+=`<div class="grid">${panel('年龄 × ICU 类型','切换次数或 ICU 内占比，点击单元格组合筛选',heatmap(data),'COHORT MATRIX','<b>↗</b> 同时筛选年龄组与 ICU 类型')}${panel('不同 ICU 的停留时长','箱体：Q1–Q3；中线：中位数；须：1.5 × IQR 内的极值',boxplot(data),'DISTRIBUTION','所有筛选记录参与统计 · 须外值未绘制')}</div>`;
    content+=panel('年龄与 ICU 停留时长','悬停查看记录，点击散点打开入住详情',`<canvas class="scatter" id="scatter" aria-label="年龄与 ICU 停留时长散点图"></canvas><div class="scatter-legend" aria-label="ICU 类型图例">${data.units.map(r=>`<button data-unit="${esc(r.unit)}" title="${esc(r.unit)}"><i style="background:${unitColor(r.unit)}"></i>${esc(unitName(r.unit))}</button>`).join('')}</div><div class="panel-note">展示 ${fmt(data.scatter.length)} 个确定性等间隔抽取的点，统计基于全部 ${fmt(data.summary.stays)} 次筛选入住。纵轴为 log(1+天数)，90+ 组绘于 90。</div>`,'INDIVIDUAL STAYS','','scatter-panel');
    content+='<div class="section-heading"><div><h2>筛选结果与入住下钻</h2><p>点击一条记录，查看住院时间线与生命体征。</p></div></div>';
  }
  content+=`<div id="table-container">${tableHTML(state.stays)}</div>`;
  $('#page-content').innerHTML=content;
  fitColumnCharts($('#page-content'));
  if(state.page==='explore')requestAnimationFrame(drawScatter);
}
function drawScatter() {
  const canvas=$('#scatter');if(!canvas||!state.analysis)return;
  const rect=canvas.getBoundingClientRect(),dpr=devicePixelRatio||1,w=rect.width,h=rect.height;
  canvas.width=w*dpr;canvas.height=h*dpr;const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const left=48,right=20,top=12,bottom=35,points=state.analysis.scatter;
  const max=Math.max(7,...points.map(r=>r.los));
  const x=a=>left+(Math.max(18,Math.min(90,a))-18)/72*(w-left-right);
  const y=l=>h-bottom-Math.log1p(l)/Math.log1p(max)*(h-top-bottom);
  ctx.font='11px -apple-system, sans-serif';ctx.fillStyle='#627084';ctx.strokeStyle='#e5ecf5';ctx.lineWidth=1;
  for(const v of [0,1,3,7,14,30,60,120,240,480].filter(v=>v<=max)){const py=y(v);ctx.beginPath();ctx.moveTo(left,py);ctx.lineTo(w-right,py);ctx.stroke();ctx.textAlign='right';ctx.fillText(v+'天',left-8,py+3);}
  for(const age of [18,30,40,50,60,70,80,90]){ctx.textAlign='center';ctx.fillText(age===90?'90+':age,x(age),h-13);}
  scatterPoints=[];
  for(const r of points){const px=x(r.age),py=y(r.los);ctx.fillStyle=unitColor(r.unit)+'bb';ctx.beginPath();ctx.arc(px,py,3,0,Math.PI*2);ctx.fill();scatterPoints.push({...r,x:px,y:py});}
  const nearest=e=>{const b=canvas.getBoundingClientRect(),mx=e.clientX-b.left,my=e.clientY-b.top;let found=null,dist=81;for(const r of scatterPoints){const d=(r.x-mx)**2+(r.y-my)**2;if(d<dist){dist=d;found=r;}}return found;};
  canvas.onmousemove=e=>{const r=nearest(e);if(!r)return hideTooltip();tooltip(e,`入住 #${r.stay_id}<br>${r.topcoded?'90+':r.age} 岁 · ${fmt(r.los,2)} 天<br>${esc(unitName(r.unit))}<br><small>点击查看详情</small>`);};
  canvas.onmouseleave=hideTooltip;
  canvas.onclick=e=>{const r=nearest(e);if(r)navigate('detail',r.stay_id);};
}
async function loadTable() {
  const request=++state.request;hideError();$('#loading').hidden=false;
  try{const list=await api('/api/stays',{...state.filters,page:state.pageNumber,page_size:state.page==='overview'?5:15,sort:state.sort});if(request!==state.request)return;state.stays=list;$('#table-container').innerHTML=tableHTML(list);}
  catch(e){showError(e);}finally{if(request===state.request)$('#loading').hidden=true;}
}
async function loadDetail() {
  resetSummary();const request=++state.request;state.vitalRequest++;hideError();$('#loading').hidden=false;
  $('#page-content').innerHTML='';
  try {
    const data=await api('/api/stays/'+state.stayId);
    if(request!==state.request)return;
    state.detail=data;const duration=data.stay.icu_los_days*24;
    if(!state.range)state.range={start:0,end:Math.min(72,duration)};
    renderDetail();await Promise.all([loadVitals(),loadVitalOverview()]);
  }catch(e){if(request===state.request){showError(e);$('#page-content').innerHTML=`<button class="back" data-go="${state.returnPage}">← 返回${state.returnPage==='cases'?'案例搜索':state.returnPage==='overview'?'数据总览':'群体探索'}</button>`;}}
  finally {if(request===state.request)$('#loading').hidden=true;}
}
function renderDetail() {
  const d=state.detail,r=d.stay,age=r.age_topcoded?'90+':r.age_estimate??'未知';
  const times=[['医院入院',r.admittime],['进入 ICU',r.intime],['离开 ICU',r.outtime],['医院出院',r.dischtime]];
  let html=`<button class="back" data-go="${state.returnPage}">← 返回${state.returnPage==='cases'?'案例搜索':state.returnPage==='overview'?'数据总览':'群体探索'} · 保留筛选条件</button><div class="detail-meta"><span>患者 #${r.subject_id}</span><span>住院 #${r.hadm_id}</span><span>${age} 岁 · ${r.gender==='F'?'女性':'男性'}</span><span>${esc(unitName(r.first_careunit))}</span></div><div class="detail-metrics">${[['ICU 停留',fmt(r.icu_los_days,2),'天'],['医院住院',fmt(r.hospital_los_days,2),'天'],['已记录指标',d.summaries.length+'/9','项'],['生命体征测量',fmt(d.summaries.reduce((s,v)=>s+v.observations,0)),'条']].map(([label,val,u])=>`<div class="detail-metric"><span>${label}</span><strong>${val}</strong><small>${u}</small></div>`).join('')}</div>`;
  if(d.issues.length)html+='<div class="notice">时间质量提示：这次入住的 ICU 时间超出了医院行政入出院时间范围。以下保留原始时间；时间节点按阶段排列，不代表实际时间先后。</div>';
  html+=panel('住院阶段时间线','时间经过脱敏偏移，仅用于当前患者内部分析',`<div class="timeline"><div class="timeline-track"></div><div class="timeline-events">${times.map(([label,t])=>`<div class="timeline-event"><i></i><b>${label}</b><span>${esc(t?.slice(0,10))}</span><span>${esc(t?.slice(11))}</span></div>`).join('')}</div></div>`,'CARE TIMELINE','节点间距仅示意阶段，不编码时长');
  html+='<div class="section-heading"><div><h2>生命体征 · 多视图联动</h2><p>相同时间区间与横轴，悬停可同时查看各指标。</p></div></div>';
  html+=`<section class="panel time-explorer"><div id="time-navigator" class="time-navigator"><p class="navigator-note">正在载入全程记录概览…</p></div><form id="range-form" class="range-control"><button type="button" class="preset" data-hours="24">首 24 小时</button><button type="button" class="preset" data-hours="72">首 72 小时</button><button type="button" class="preset" data-hours="all">全部时间</button><label>开始（小时）<input id="range-start" type="number" min="0" step="any" value="${hourInput(state.range.start)}"></label><label>结束（小时）<input id="range-end" type="number" min="0" step="any" value="${hourInput(state.range.end)}"></label><button class="primary" type="submit">更新区间</button><label class="check-label"><input id="include-flagged" type="checkbox" ${state.flagged?'checked':''}>包含质量标记值</label></form><div class="range-summary" id="range-summary">正在获取测量记录…</div></section><div class="grid" id="vital-panels"></div>`;
  html+=panel('同一患者的其他 ICU 入住','可以继续查看，入住次数不等于住院次数',`<div class="related">${d.related_stays.map(s=>`<button data-stay="${s.stay_id}" class="${s.stay_id===r.stay_id?'active':''}">#${s.stay_id} · ${fmt(s.icu_los_days,2)} 天<small>${esc(unitName(s.first_careunit))} · ${esc(s.intime.slice(0,10))}</small></button>`).join('')}</div>`,'RELATED STAYS');
  $('#page-content').innerHTML=html;
}
async function loadVitals() {
  const request=++state.vitalRequest;const id=state.stayId;hideError();
  $('#range-summary').textContent='正在获取测量记录…';
  try{
    const data=await api(`/api/stays/${id}/vitals`,{start:state.range.start,end:state.range.end,include_flagged:state.flagged?1:0});
    if(request!==state.vitalRequest||state.page!=='detail'||state.stayId!==id)return;
    state.vitals=data;state.range={start:data.start,end:data.end};$('#range-start').value=hourInput(data.start);$('#range-end').value=hourInput(data.end);syncTimeNavigator();
    $('#range-summary').textContent=`入 ICU 后 ${fmt(data.start,1)}–${fmt(data.end,1)} 小时 · 每 ${data.bin_hours} 小时聚合均值 · 缺测区间不连线 · ${data.include_flagged?'已包含质量标记值':'默认忽略质量标记值'}`;
    renderVitals();
  }catch(e){if(request===state.vitalRequest){showError(e);$('#range-summary').textContent='区间查询失败，请检查开始和结束时间。';if(state.vitals){state.range={start:state.vitals.start,end:state.vitals.end};syncTimeNavigator();}}}
}
function lineChart(ids,width=640) {
  const v=state.vitals, series=ids.map(id=>v.series[String(id)]||[]),all=series.flat();
  if(!all.length)return '<div class="chart-empty">当前时间区间无可展示的测量<small>可扩大区间，或检查质量标记设置。</small></div>';
  const w=Math.max(240,width),h=210,left=42,right=15,top=20,bottom=30;
  const min=Math.min(...all.map(p=>p.value)),max=Math.max(...all.map(p=>p.value));
  const pad=Math.max(1,(max-min)*.15),lo=min-pad,hi=max+pad;
  const x=hour=>left+(hour-v.start)/(v.end-v.start)*(w-left-right);
  const y=value=>h-bottom-(value-lo)/(hi-lo)*(h-top-bottom);
  let svg=`<svg class="svg-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="生命体征随入 ICU 后小时数的变化">`;
  for(let i=0;i<4;i++){const value=lo+(hi-lo)*i/3,py=y(value);svg+=`<line x1="${left}" y1="${py}" x2="${w-right}" y2="${py}" stroke="#e5ecf5" stroke-dasharray="3 4"/><text x="${left-7}" y="${py+3}" text-anchor="end" font-size="11">${fmt(value,hi-lo<10?1:0)}</text>`;}
  const ticks=w<400?2:4;
  for(let i=0;i<=ticks;i++){const hour=v.start+(v.end-v.start)*i/ticks;svg+=`<text x="${x(hour)}" y="${h-8}" text-anchor="${i===0?'start':i===ticks?'end':'middle'}" font-size="11">${fmt(hour,1)}h</text>`;}
  series.forEach((arr,index)=>{let path='';arr.forEach((p,i)=>{const command=i===0||p.bucket-arr[i-1].bucket>1?'M':'L';path+=`${command}${x(p.hour).toFixed(2)},${y(p.value).toFixed(2)} `;});svg+=`<path d="${path}" fill="none" stroke="${vitalColors[index]}" stroke-width="2"/>`;arr.forEach(p=>{svg+=`<circle cx="${x(p.hour)}" cy="${y(p.value)}" r="${p.flagged?2.5:1.4}" fill="${p.flagged?'#c28b49':vitalColors[index]}"/>`;});});
  return `<div class="line-chart-wrap" data-series="${ids.join(',')}" data-plot-width="${w}">${svg}</svg><div class="crosshair" hidden></div></div>`;
}
function renderVitals() {
  const labels=Object.fromEntries(state.detail.metrics.map(m=>[m.itemid,m]));
  const bp=state.bp==='arterial'?[220050,220051,220052]:[220179,220180,220181];
  const groups=[['心率',[220045],'bpm'],['呼吸频率',[220210],'次/分'],['血氧饱和度',[220277],'%'],['血压',bp,'mmHg']];
  $('#vital-panels').innerHTML=groups.map(([title,ids,unit],index)=>{
    const tools=index===3?'<select id="bp-select" aria-label="血压测量方式"><option value="noninvasive" '+(state.bp==='noninvasive'?'selected':'')+'>无创血压</option><option value="arterial" '+(state.bp==='arterial'?'selected':'')+'>有创血压</option></select>':`<span class="panel-kicker">${unit}</span>`;
    return `<section class="panel"><div class="panel-head"><div><h2>${title}</h2><p>${unit} · 按时间区间聚合的测量均值</p></div><div class="chart-tools">${tools}</div></div>${lineChart(ids)}<div class="line-legend">${ids.map((id,i)=>`<span style="--line-color:${vitalColors[i]}">${esc(labels[id].label)}</span>`).join('')}</div>${coverageHTML(ids)}</section>`;
  }).join('');
  $$('.line-chart-wrap').forEach(wrap=>{
    const width=Math.round(wrap.getBoundingClientRect().width);
    if(width>0)wrap.outerHTML=lineChart(wrap.dataset.series.split(',').map(Number),Math.min(640,width));
  });
  $$('.line-chart-wrap').forEach(wrap=>{
    wrap.onmousemove=e=>{
      const b=wrap.getBoundingClientRect(),width=Number(wrap.dataset.plotWidth),low=42/width,high=(width-15)/width,relative=Math.max(low,Math.min(high,(e.clientX-b.left)/b.width));
      const hour=state.vitals.start+(relative-low)/(high-low)*(state.vitals.end-state.vitals.start);
      $$('.crosshair').forEach(c=>{c.hidden=false;c.style.left=relative*100+'%';});
      let html=`入 ICU 后约 ${fmt(hour,1)} 小时`;
      const ids=[220045,220210,220277,...(state.bp==='arterial'?[220050,220051,220052]:[220179,220180,220181])];
      for(const id of ids){const arr=state.vitals.series[id]||[];const point=arr.find(p=>hour>=state.vitals.start+p.bucket*state.vitals.bin_hours&&hour<state.vitals.start+(p.bucket+1)*state.vitals.bin_hours);html+=`<br>${labels[id].label}：${point?fmt(point.value,1)+' '+labels[id].unit+'（'+point.observations+' 条）':'无记录'}`;}
      tooltip(e,html);
    };
    wrap.onmouseleave=()=>{hideTooltip();$$('.crosshair').forEach(c=>c.hidden=true);};
  });
}

$('#filter-form').onsubmit=e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.currentTarget));applyFilters(values);};
$('#reset').onclick=()=>{state.filters={};state.pageNumber=1;syncFilters();loadAnalysis();};
document.addEventListener('click',e=>{
  const target=e.target.closest('button,[data-los-min],[data-age],[data-unit],[data-stay]');if(!target||target.disabled)return;
  if(target.dataset.page){if(target.dataset.page==='detail'&&!state.stayId)return;navigate(target.dataset.page);return;}
  if(target.dataset.go){navigate(target.dataset.go);return;}
  if(target.dataset.stay){navigate('detail',target.dataset.stay);return;}
  if(target.hasAttribute('data-case-clear')){applyFilters({search:''});return;}
  if(target.hasAttribute('data-case-reset')){$('#reset').click();return;}
  if(target.dataset.caseQuery){applyFilters({search:target.dataset.caseQuery});return;}
  if(target.dataset.remove){applyFilters({[target.dataset.remove]:''});return;}
  const patch={};
  if(target.dataset.unit!=null)patch.unit=target.dataset.unit;
  if(target.dataset.age!=null)patch.age=target.dataset.age;
  if(target.dataset.gender!=null)patch.gender=target.dataset.gender;
  if(target.dataset.losMin!=null){patch.los_min=target.dataset.losMin;patch.los_max=target.dataset.losMax;}
  if(Object.keys(patch).length){applyFilters(patch);return;}
  if(target.dataset.pagination){state.pageNumber+=Number(target.dataset.pagination);loadTable();return;}
  if(target.dataset.hours){commitTimeRange({start:0,end:target.dataset.hours==='all'?state.detail.stay.icu_los_days*24:Math.min(Number(target.dataset.hours),state.detail.stay.icu_los_days*24)});}
  if(target.dataset.heatMode){state.heatMode=target.dataset.heatMode;renderAnalysis();}
});
document.addEventListener('submit',e=>{
  if(e.target.id==='case-search-form'){e.preventDefault();applyFilters({search:$('#case-search-input').value.trim()});}
  if(e.target.id==='case-sort-form')e.preventDefault();
  if(e.target.id==='search-form'){e.preventDefault();applyFilters({search:$('#record-search').value.trim()});}
  if(e.target.id==='range-form'){e.preventDefault();const start=Number($('#range-start').value),end=Number($('#range-end').value);state.range={start:start===Number(hourInput(state.range.start))?state.range.start:start,end:end===Number(hourInput(state.range.end))?state.range.end:end};loadVitals();}
});
document.addEventListener('change',e=>{
  if(e.target.id==='sort-select'){state.sort=e.target.value;state.pageNumber=1;loadTable();}
  if(e.target.id==='include-flagged'){state.flagged=e.target.checked;loadVitals();loadVitalOverview();}
  if(e.target.id==='bp-select'){state.bp=e.target.value;renderVitals();}
});
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('[role="button"],tr[data-stay]')){e.preventDefault();e.target.dispatchEvent(new MouseEvent('click',{bubbles:true}));}});
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{drawScatter();fitColumnCharts();if(state.page==='detail'&&state.vitals)renderVitals();},100);});
async function fromURL(){const [path,query]=location.hash.slice(1).split('?');state.filters=Object.fromEntries(new URLSearchParams(query||''));state.pageNumber=1;syncFilters();if(path?.startsWith('detail/'))await navigate('detail',path.split('/')[1],false);else await navigate(['explore','cases'].includes(path)?path:'overview',null,false);}
window.addEventListener('popstate',fromURL);
async function init(){try{const options=await api('/api/options');$('#unit-filter').insertAdjacentHTML('beforeend',options.units.map(u=>`<option value="${esc(u)}">${esc(unitName(u))}</option>`).join(''));initAnalysisTools();initChatActions();await fromURL();}catch(e){showError(e);}}
init();
