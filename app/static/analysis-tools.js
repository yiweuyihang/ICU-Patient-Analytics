'use strict';

// Saved comparison slots contain filter definitions; statistics always come from
// the current database. They are independent of the page's active filter.
const comparisonState={a:null,b:null,data:null,loading:false,error:'',request:0,storageNote:''};
const comparisonStorageKey='icu-atlas-comparison-v1';
const filterKeys=['age','gender','unit','los_min','los_max','search'];
const hourInput=value=>String(Number(value.toFixed(4)));
function filterDescription(filters) {
  return [filters.age?ageName(filters.age):'全部年龄',filters.gender?(filters.gender==='F'?'女性':'男性'):'',
    filters.unit?unitName(filters.unit):'全部 ICU',filters.los_min?`≥${filters.los_min} 天`:'',
    filters.los_max?`<${filters.los_max} 天`:'',filters.search?'已应用案例搜索':''].filter(Boolean).join(' · ');
}
function persistComparison() {
  try {
    const payload=Object.fromEntries(['a','b'].map(key=>[key,comparisonState[key]?{name:comparisonState[key].name,filters:comparisonState[key].filters}:null]));
    localStorage.setItem(comparisonStorageKey,JSON.stringify(payload));
    comparisonState.storageNote='';
  } catch {comparisonState.storageNote='当前浏览器无法保存，刷新后需重新选择队列。';}
}
function restoreComparison() {
  try {
    const saved=JSON.parse(localStorage.getItem(comparisonStorageKey)||'null');
    for(const key of ['a','b']) {
      const slot=saved?.[key];
      if(!slot||typeof slot.name!=='string'||!slot.filters||Array.isArray(slot.filters)||typeof slot.filters!=='object')continue;
      const entries=Object.entries(slot.filters);
      if(entries.every(([k,v])=>filterKeys.includes(k)&&typeof v==='string'&&v.length<200))
        comparisonState[key]={name:slot.name.slice(0,40),filters:Object.fromEntries(entries)};
    }
  } catch {comparisonState.storageNote='未能恢复保存的对比条件，可以重新选择队列。';}
}
function comparisonSlot(key) {
  const slot=comparisonState[key],name=key.toUpperCase();
  const summary=comparisonState.data?.[key]?.summary||slot?.summary;
  return `<article class="cohort-slot cohort-${key}"><div class="cohort-slot-top"><span class="cohort-badge">${name}</span>${slot?`<input class="cohort-name" data-cohort-name="${key}" aria-label="队列 ${name} 名称" maxlength="40" value="${esc(slot.name)}">`:`<h3>选择队列 ${name}</h3>`}${slot?`<button class="cohort-clear" data-compare-clear="${key}" aria-label="清除队列 ${name}">×</button>`:''}</div><p class="cohort-scope">${slot?esc(filterDescription(slot.filters)):'设置上方筛选，再将当前范围保存到这里。'}</p><div class="cohort-n">${slot&&summary?fmt(summary.stays):'—'}<span>次 ICU 入住</span>${slot&&summary?`<small>${fmt(summary.patients)} 位患者</small>`:''}</div><div class="cohort-slot-actions"><button class="preset" data-compare-save="${key}">${slot?'更新为当前筛选':'将当前筛选存为 '+name}</button>${slot?`<button class="text-button" data-compare-load="${key}">载入此筛选 ↗</button>`:''}</div></article>`;
}
function comparisonQuantiles(data) {
  const maximum=Math.max(1,...['a','b'].map(k=>data[k].summary.q3_los||0))*1.18;
  const x=v=>65+v/maximum*480;
  let svg='<svg class="svg-chart comparison-quantiles" viewBox="0 0 600 156" role="img" aria-label="两队列停留时长的中位数与四分位区间，横轴共用天数尺度">';
  for(let i=0;i<=4;i++) {
    const value=maximum*i/4,px=x(value);
    svg+=`<line x1="${px}" x2="${px}" y1="14" y2="115" stroke="#e4eae6" stroke-dasharray="3 4"/><text x="${px}" y="140" text-anchor="middle" font-size="11">${fmt(value,1)}</text>`;
  }
  ['a','b'].forEach((key,i)=>{
    const s=data[key].summary,y=35+i*54,color=i?'#aa7950':'#387cc8';
    svg+=`<text x="22" y="${y+5}" font-size="14" font-weight="600">${key.toUpperCase()}</text>`;
    if(s.median_los==null) {svg+=`<text x="75" y="${y+5}" font-size="12">无记录</text>`;return;}
    svg+=`<g><title>${esc(comparisonState[key]?.name||key)}：Q1 ${fmt(s.q1_los,2)} 天；中位数 ${fmt(s.median_los,2)} 天；Q3 ${fmt(s.q3_los,2)} 天</title><rect x="${x(s.q1_los)}" y="${y-11}" width="${Math.max(1,x(s.q3_los)-x(s.q1_los))}" height="24" rx="5" fill="${color}" fill-opacity=".25"/><line x1="${x(s.q1_los)}" x2="${x(s.q3_los)}" y1="${y+1}" y2="${y+1}" stroke="${color}" stroke-width="2"/><circle cx="${x(s.median_los)}" cy="${y+1}" r="5" fill="${color}"/></g>`;
  });
  return svg+'</svg>';
}
function comparisonHistogram(data) {
  const rows=data.a.histogram;
  const shares=['a','b'].map(key=>data[key].histogram.map(r=>data[key].summary.stays?r.count/data[key].summary.stays:0));
  const ceiling=Math.max(.1,Math.ceil(Math.max(...shares.flat())*10)/10),left=42,bottom=172,step=66;
  let svg='<svg class="svg-chart comparison-histogram" viewBox="0 0 600 210" role="img" aria-label="两队列各停留区间的入住占比，共用百分比纵轴">';
  for(let i=0;i<=3;i++){const y=bottom-i*140/3;svg+=`<line x1="${left}" x2="584" y1="${y}" y2="${y}" stroke="#e4eae6" stroke-dasharray="3 4"/><text x="${left-6}" y="${y+4}" text-anchor="end" font-size="10">${fmt(ceiling*i/3*100)}%</text>`;}
  rows.forEach((row,i)=>{
    ['a','b'].forEach((key,k)=>{const count=data[key].histogram[i].count,share=shares[k][i],height=share/ceiling*140;
      svg+=`<rect x="${left+10+i*step+k*21}" y="${bottom-height}" width="18" height="${height}" rx="3" fill="${k?'#aa7950':'#387cc8'}"><title>${esc(comparisonState[key]?.name||key)} · ${esc(row.label)} 天：${fmt(count)} 次（${fmt(share*100,1)}%）</title></rect>`;
    });
    svg+=`<text x="${left+29+i*step}" y="195" text-anchor="middle" font-size="11">${esc(row.label)}</text>`;
  });
  return svg+'</svg>';
}
function comparisonResults() {
  const data=comparisonState.data;if(!data)return '';
  const a=data.a.summary,b=data.b.summary;
  const delta=a.median_los!=null&&b.median_los!=null?b.median_los-a.median_los:null;
  return `<div class="comparison-insight"><div><span>停留中位数</span><strong><i class="dot-a"></i>A ${fmt(a.median_los,2)} <small>天</small><em>→</em><i class="dot-b"></i>B ${fmt(b.median_los,2)} <small>天</small></strong></div><div class="comparison-delta"><span>B − A</span><strong>${delta==null?'—':(delta>0?'+':'')+fmt(delta,2)}<small>天</small></strong></div></div><div class="comparison-plots"><div><h3>典型停留与分布范围</h3><p>圆点：中位数 · 色带：Q1–Q3 · 横轴：天</p>${comparisonQuantiles(data)}<div class="comparison-iqr">A：${fmt(a.q1_los,2)}–${fmt(a.q3_los,2)} 天　 B：${fmt(b.q1_los,2)}–${fmt(b.q3_los,2)} 天</div></div><div><div class="comparison-chart-title"><h3>停留时长构成</h3><div class="comparison-legend"><span><i class="dot-a"></i>A</span><span><i class="dot-b"></i>B</span></div></div><p>各队列内的入住占比 · 区间单位：天</p>${comparisonHistogram(data)}</div></div><p class="comparison-footnote">共同入住 ${fmt(data.overlap_stays)} 次 · 共同患者 ${fmt(data.overlap_patients)} 位。以上为描述性比较，未调整年龄构成等混杂因素；同一患者可能多次入住。</p>`;
}
function renderComparison() {
  return `<section id="cohort-compare" class="panel comparison-panel" aria-labelledby="compare-title"><div class="panel-head"><div><span class="eyebrow">COMPARE TWO COHORTS</span><h2 id="compare-title">把两个群体，放在一起看。</h2><p>保存两组筛选条件，在相同尺度上比较停留时长。</p></div><button class="preset compare-example" data-compare-example>试一组：65+ 内科 vs 外科 ↗</button></div><div class="cohort-slots">${comparisonSlot('a')}${comparisonSlot('b')}</div><div class="compare-status" role="status" aria-live="polite">${comparisonState.loading?'正在计算两组全量统计…':esc(comparisonState.error||comparisonState.storageNote)}</div>${comparisonState.data?comparisonResults():`<div class="comparison-empty"><span>A ↔ B</span><p>${comparisonState.loading?'正在准备同尺度对比图。':'选好 A 和 B 后，这里会展示中位数、四分位区间与时长构成。'}</p></div>`}</section>`;
}
function refreshComparisonPanel() {const node=$('#cohort-compare');if(node)node.outerHTML=renderComparison();}
async function loadComparison() {
  const request=++comparisonState.request;comparisonState.data=null;comparisonState.error='';
  if(!comparisonState.a||!comparisonState.b){comparisonState.loading=false;refreshComparisonPanel();return;}
  comparisonState.loading=true;refreshComparisonPanel();
  const params={};for(const key of ['a','b'])for(const [k,v] of Object.entries(comparisonState[key].filters))params[key+'_'+k]=v;
  try {
    const data=await api('/api/compare',params);if(request!==comparisonState.request)return;
    comparisonState.data=data;
    for(const key of ['a','b'])comparisonState[key].summary=data[key].summary;
  } catch(error){if(request===comparisonState.request)comparisonState.error=error.message;}
  finally{if(request===comparisonState.request){comparisonState.loading=false;refreshComparisonPanel();}}
}

// Runs encode whether a time bucket contains at least one displayed measurement.
// A partially observed bucket is never presented as continuous monitoring.
function coverageRuns(points,start,end,width) {
  const present=new Set(points.map(p=>p.bucket)),runs=[];
  const total=Math.max(1,Math.ceil((end-start)/width));
  for(let bucket=0;bucket<total;bucket++) {
    const recorded=present.has(bucket),low=start+bucket*width,high=Math.min(end,low+width),last=runs[runs.length-1];
    if(last&&last.recorded===recorded)last.end=high;else runs.push({start:low,end:high,recorded});
  }
  return runs;
}
function coverageHTML(ids) {
  const v=state.vitals;
  return `<div class="coverage-block"><div class="coverage-heading"><span>记录覆盖</span><span><i class="coverage-key recorded"></i>有记录 <i class="coverage-key missing"></i>无记录</span></div>${ids.map(id=>{
    const metric=state.detail.metrics.find(m=>m.itemid===id),c=v.coverage[String(id)];
    const runs=coverageRuns(v.series[String(id)]||[],v.start,v.end,v.bin_hours);
    return `<div class="coverage-row"><div><span>${esc(metric.label)}</span><strong>${fmt(c.fraction*100,1)}% <small>时间桶有记录</small></strong></div><div class="coverage-track" role="img" aria-label="${esc(metric.label)}：${c.recorded_buckets}/${c.total_buckets} 个时间桶有记录，最长连续无记录 ${fmt(c.longest_gap_hours,1)} 小时">${runs.map(run=>`<span class="coverage-run ${run.recorded?'recorded':'missing'}" style="width:${(run.end-run.start)/(v.end-v.start)*100}%" title="${fmt(run.start,1)}–${fmt(run.end,1)} 小时：${run.recorded?'该时间桶内有记录':'无可展示记录'}"></span>`).join('')}</div><small class="coverage-caption">${c.recorded_buckets}/${c.total_buckets} 桶 · 最长无记录 ${fmt(c.longest_gap_hours,1)} 小时</small></div>`;
  }).join('')}<p class="coverage-definition">按当前 ${v.bin_hours} 小时时间桶统计；有记录不代表持续监测。${v.include_flagged?'包含':'已排除'}质量标记值。</p></div>`;
}
function navigatorCurve(data) {
  const points=data.series['220045']||[];
  if(!points.length)return '<text x="500" y="47" text-anchor="middle" font-size="13" fill="#667f76">全程无可展示心率记录，仍可拖选时间区间</text>';
  const values=points.map(p=>p.value),low=Math.min(...values),high=Math.max(...values),span=Math.max(1,high-low);
  return `<path d="${points.map((p,i)=>`${!i||p.bucket-points[i-1].bucket>1?'M':'L'}${(p.hour/data.end*1000).toFixed(2)},${(76-(p.value-low)/span*55).toFixed(2)}`).join(' ')}" fill="none" stroke="#4685bf" stroke-width="1.7" vector-effect="non-scaling-stroke"/>`;
}
function renderTimeNavigator() {
  const holder=$('#time-navigator');if(!holder||!state.vitalOverview)return;
  const data=state.vitalOverview,duration=data.end;
  holder.innerHTML=`<div class="navigator-heading"><div><span class="eyebrow">OVERVIEW → DETAIL</span><h3>拖选一段时间，观察共同变化。</h3><p>心率全程概览 · 每 ${data.bin_hours} 小时聚合均值 · 拖动选区可平移，拖动两端可调整范围</p></div><span id="navigator-readout" class="navigator-readout"></span></div><div class="navigator-track" id="navigator-track" aria-label="拖选生命体征查看时间"><svg viewBox="0 0 1000 96" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="1000" y1="82" y2="82" stroke="#dce7df"/>${navigatorCurve(data)}</svg><div id="navigator-selection" class="navigator-selection"><button type="button" data-edge="start" class="navigator-handle handle-start" role="slider" aria-label="查看区间开始时间" aria-valuemin="0" aria-valuemax="${duration}" aria-valuenow="0"><span></span></button><button type="button" data-edge="end" class="navigator-handle handle-end" role="slider" aria-label="查看区间结束时间" aria-valuemin="0" aria-valuemax="${duration}" aria-valuenow="${duration}"><span></span></button></div></div><div class="navigator-axis"><span>入 ICU · 0 h</span><span>${fmt(duration/2,1)} h</span><span>离开 ICU · ${fmt(duration,1)} h</span></div><p class="navigator-note">上方保留全程，下面四组曲线查看选中区间。也可用方向键调整手柄，或在下方输入精确小时数。</p>`;
  syncTimeNavigator();bindTimeNavigator();
}
function normalizedTimeRange(start,end,duration) {
  const minimum=Math.min(1,duration),step=duration<4?.1:1;
  let low=Math.max(0,Math.min(duration,Math.round(Math.min(start,end)/step)*step));
  let high=Math.max(0,Math.min(duration,Math.round(Math.max(start,end)/step)*step));
  if(high-low<minimum){high=Math.min(duration,low+minimum);low=Math.max(0,high-minimum);}
  return {start:low,end:high};
}
function syncTimeNavigator(range=state.range) {
  const selection=$('#navigator-selection'),readout=$('#navigator-readout');
  if(!selection||!state.vitalOverview)return;
  const duration=state.vitalOverview.end;
  selection.style.left=(range.start/duration*100)+'%';selection.style.width=((range.end-range.start)/duration*100)+'%';
  readout.textContent=fmt(range.start,1)+'–'+fmt(range.end,1)+' h';
  for(const edge of ['start','end']){const handle=selection.querySelector(`[data-edge="${edge}"]`);handle.setAttribute('aria-valuenow',String(range[edge]));handle.setAttribute('aria-valuetext',fmt(range[edge],1)+' 小时');}
}
function commitTimeRange(range) {
  state.range=range;$('#range-start').value=hourInput(range.start);$('#range-end').value=hourInput(range.end);
  syncTimeNavigator();loadVitals();
}
function bindTimeNavigator() {
  const track=$('#navigator-track'),duration=state.vitalOverview.end;
  track.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    event.preventDefault();hideTooltip();
    const rect=track.getBoundingClientRect(),hour=x=>Math.max(0,Math.min(duration,(x-rect.left)/rect.width*duration));
    const origin=hour(event.clientX),initial={...state.range},edge=event.target.closest('[data-edge]')?.dataset.edge;
    const move=!edge&&!!event.target.closest('.navigator-selection');
    let preview={...initial},moved=false;
    track.setPointerCapture(event.pointerId);
    const update=e=>{
      if(e.pointerId!==event.pointerId)return;
      moved=moved||Math.abs(e.clientX-event.clientX)>3;
      const current=hour(e.clientX);
      if(move){const span=initial.end-initial.start,low=Math.max(0,Math.min(duration-span,initial.start+current-origin));preview={start:low,end:low+span};}
      else if(edge==='start')preview={start:Math.min(current,initial.end-Math.min(1,duration)),end:initial.end};
      else if(edge==='end')preview={start:initial.start,end:Math.max(current,initial.start+Math.min(1,duration))};
      else preview={start:origin,end:current};
      preview=normalizedTimeRange(preview.start,preview.end,duration);syncTimeNavigator(preview);
    };
    const finish=e=>{
      if(e.pointerId!==event.pointerId)return;
      track.removeEventListener('pointermove',update);track.removeEventListener('pointerup',finish);track.removeEventListener('pointercancel',cancel);
      if(track.hasPointerCapture(event.pointerId))track.releasePointerCapture(event.pointerId);
      if(moved){update(e);commitTimeRange(preview);}else syncTimeNavigator();
    };
    const cancel=()=>{track.removeEventListener('pointermove',update);track.removeEventListener('pointerup',finish);track.removeEventListener('pointercancel',cancel);syncTimeNavigator();};
    track.addEventListener('pointermove',update);track.addEventListener('pointerup',finish);track.addEventListener('pointercancel',cancel);
  });
  track.addEventListener('keydown',event=>{
    const edge=event.target.dataset.edge;if(!edge||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    event.preventDefault();const next={...state.range},minimum=Math.min(1,duration),step=(duration<4?.1:1)*(event.shiftKey?10:1);
    const value=event.key==='Home'?0:event.key==='End'?duration:next[edge]+(['ArrowRight','ArrowUp'].includes(event.key)?step:-step);
    next[edge]=edge==='start'?Math.max(0,Math.min(value,next.end-minimum)):Math.min(duration,Math.max(value,next.start+minimum));
    commitTimeRange(next);
  });
}
async function loadVitalOverview() {
  const id=state.stayId,flagged=state.flagged,request=++state.overviewRequest;
  const duration=state.detail.stay.icu_los_days*24;
  try {
    const data=await api(`/api/stays/${id}/vitals`,{start:0,end:duration,include_flagged:flagged?1:0});
    if(request!==state.overviewRequest||state.page!=='detail'||state.stayId!==id||state.flagged!==flagged)return;
    state.vitalOverview=data;renderTimeNavigator();
  } catch(error){if(request===state.overviewRequest&&state.page==='detail')$('#time-navigator').innerHTML='<p class="navigator-note">全程概览载入失败，可继续使用下方时间控件。</p>';}
}

function initAnalysisTools() {
  restoreComparison();if(comparisonState.a&&comparisonState.b)loadComparison();
  const drawer=$('#assistant-drawer'),toggle=$('#assistant-toggle');
  toggle.addEventListener('click',()=>{drawer.showModal();toggle.setAttribute('aria-expanded','true');renderChat();});
  $('#assistant-close').addEventListener('click',()=>drawer.close());
  drawer.addEventListener('close',()=>{toggle.setAttribute('aria-expanded','false');hideTooltip();});
  drawer.addEventListener('click',event=>{if(event.target===drawer){const b=drawer.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)drawer.close();}});
  document.addEventListener('click',event=>{
    const target=event.target.closest('button');if(!target)return;
    if(target.dataset.compareSave){
      if(!state.analysis||!$('#loading').hidden)return;
      const key=target.dataset.compareSave;
      comparisonState[key]={name:comparisonState[key]?.name||'队列 '+key.toUpperCase(),filters:{...state.filters},summary:{...state.analysis.summary}};
      persistComparison();loadComparison();
    }
    if(target.dataset.compareClear){comparisonState[target.dataset.compareClear]=null;persistComparison();loadComparison();}
    if(target.dataset.compareLoad){const slot=comparisonState[target.dataset.compareLoad];if(slot){state.filters={...slot.filters};state.pageNumber=1;syncFilters();loadAnalysis();}}
    if(target.hasAttribute('data-compare-example')){
      comparisonState.a={name:'65+ · MICU 内科',filters:{age:'65+',unit:'Medical Intensive Care Unit (MICU)'}};
      comparisonState.b={name:'65+ · SICU 外科',filters:{age:'65+',unit:'Surgical Intensive Care Unit (SICU)'}};
      persistComparison();loadComparison();
    }
  });
  document.addEventListener('change',event=>{
    if(event.target.dataset.cohortName){const key=event.target.dataset.cohortName;if(comparisonState[key]){comparisonState[key].name=event.target.value.trim().slice(0,40)||'队列 '+key.toUpperCase();event.target.value=comparisonState[key].name;persistComparison();}}
  });
}
