'use strict';
class ChatStore {
  constructor(storage) {
    this.storage=storage;
    this.key='icu-atlas-conversations-v1';
    this.sessions=[];
    this.activeId=null;
    this.error='';
    try {
      const saved=JSON.parse(storage.getItem(this.key)||'null');
      if(saved && Array.isArray(saved.sessions)) {
        this.sessions=saved.sessions.filter(s=>s && typeof s.id==='string' && typeof s.title==='string' && s.filters && typeof s.filters==='object' && !Array.isArray(s.filters) && Object.entries(s.filters).every(([k,v])=>['age','gender','unit','los_min','los_max','search'].includes(k)&&typeof v==='string') && Array.isArray(s.messages) && s.messages.length%2===0 && s.messages.every((m,i)=>m && m.role===(i%2?'assistant':'user') && typeof m.content==='string') && typeof s.draft==='string' && typeof s.updatedAt==='number');
        this.activeId=this.sessions.some(s=>s.id===saved.activeId)?saved.activeId:null;
      }
    } catch {this.error='浏览器历史记录暂时无法读取。';}
  }
  persist() {
    try {this.storage.setItem(this.key,JSON.stringify({sessions:this.sessions,activeId:this.activeId}));this.error='';return true;}
    catch {this.error='浏览器无法保存历史，当前对话仅暂存在本页。';return false;}
  }
  active() {return this.sessions.find(s=>s.id===this.activeId)||null;}
  sameFilters(a,b) {return JSON.stringify(Object.entries(a).sort())===JSON.stringify(Object.entries(b).sort());}
  selectFor(filters) {
    let session=this.active();
    if(!session || !this.sameFilters(session.filters,filters)) session=[...this.sessions].sort((a,b)=>b.updatedAt-a.updatedAt).find(s=>this.sameFilters(s.filters,filters));
    this.activeId=session?.id||null;
    return session||null;
  }
  create(filters) {
    const now=Date.now();
    const session={id:now.toString(36)+'-'+Math.random().toString(36).slice(2),title:'新对话',filters:{...filters},messages:[],draft:'',evidence:null,model:'',updatedAt:now};
    this.sessions.unshift(session);this.activeId=session.id;this.persist();return session;
  }
}
