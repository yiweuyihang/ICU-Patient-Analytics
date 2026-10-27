"""Local, read-only ICU explorer. No third-party runtime dependencies."""
import argparse
import json
import math
import sqlite3
import statistics
import unicodedata
from summary import config as summary_config, summarize, SummaryError, validate_messages
from filter_actions import prepare_filter_action, FilterActionError, ACTION_AGES
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / 'data/icu_analysis.sqlite'
PUBLIC = ROOT / 'app/static'
AGES = ['18-39', '40-64', '65-79', '80-89', '90+']
METRICS = {220045: ('心率', 'bpm'), 220210: ('呼吸频率', '次/分'), 220277: ('血氧饱和度', '%'),
           220050: ('有创收缩压', 'mmHg'), 220051: ('有创舒张压', 'mmHg'), 220052: ('有创平均压', 'mmHg'),
           220179: ('无创收缩压', 'mmHg'), 220180: ('无创舒张压', 'mmHg'), 220181: ('无创平均压', 'mmHg')}

def connect():
    c = sqlite3.connect(DB.resolve().as_uri() + '?mode=ro', uri=True)
    c.row_factory = sqlite3.Row
    return c

def load_cohort():
    with connect() as c:
        status = c.execute("SELECT value FROM pipeline_metadata WHERE key='vitals_status'").fetchone()
        if not status or status[0] != 'complete':
            raise RuntimeError('数据库的生命体征提取尚未完成。')
        return [dict(r) for r in c.execute('SELECT * FROM icu_cohort ORDER BY stay_id')]

COHORT = []
BY_ID = {}

# Search only fields present in the analysis cohort; diagnoses are not imported.
UNIT_SEARCH_NAMES = {
    'Medical Intensive Care Unit (MICU)': '内科',
    'Medical/Surgical Intensive Care Unit (MICU/SICU)': '内科 外科 内外科',
    'Cardiac Vascular Intensive Care Unit (CVICU)': '心脏血管 心血管',
    'Surgical Intensive Care Unit (SICU)': '外科',
    'Coronary Care Unit (CCU)': '冠心病 冠脉',
    'Trauma SICU (TSICU)': '创伤外科',
    'Neuro Intermediate': '神经中间监护',
    'Neuro Surgical Intensive Care Unit (Neuro SICU)': '神经外科',
    'Neuro Stepdown': '神经过渡监护',
    'Surgery/Vascular/Intermediate': '外科 血管 中间监护',
    'Intensive Care Unit (ICU)': '重症监护',
    'Med/Surg': '内科 外科 内外科',
    'Medicine': '内科',
    'Medicine/Cardiology Intermediate': '内科 心脏 心内科 中间监护',
    'Neurology': '神经内科',
    'PACU': '麻醉恢复 术后恢复',
    'Surgery/Trauma': '外科 创伤',
}
ADMISSION_SEARCH_NAMES = {
    'EW EMER.': '急诊', 'DIRECT EMER.': '急诊 直接急诊',
    'URGENT': '紧急', 'ELECTIVE': '择期',
    'SURGICAL SAME DAY ADMISSION': '手术 当日手术',
    'OBSERVATION ADMIT': '留观 观察入院', 'EU OBSERVATION': '留观 急诊观察',
    'DIRECT OBSERVATION': '留观 直接观察',
    'AMBULATORY OBSERVATION': '留观 门诊观察',
}

def search_terms(value):
    if not isinstance(value, str) or len(value) > 100:
        raise ValueError('搜索内容须为不超过 100 字的文本')
    return unicodedata.normalize('NFKC', value).casefold().split()

def matches_case(row, terms):
    identifiers = {str(row[key]) for key in ('stay_id', 'subject_id', 'hadm_id')}
    unit, admission = row['first_careunit'], row['admission_type']
    text = ' '.join((unit or '', UNIT_SEARCH_NAMES.get(unit, ''), admission or '',
                     ADMISSION_SEARCH_NAMES.get(admission, ''))).casefold()
    for term in terms:
        number = term.removeprefix('#')
        if number.isdecimal():
            if str(int(number)) not in identifiers: return False
        elif term not in text:
            return False
    return True

def numeric(params, key, default=None, minimum=0, maximum=100000):
    raw = params.get(key)
    if raw in (None, ''): return default
    try: value = float(raw)
    except (ValueError, TypeError): raise ValueError(f'{key} 必须是数字')
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f'{key} 超出允许范围')
    return value

def filtered(params):
    unit = params.get('unit', '')
    gender = params.get('gender', '')
    age = params.get('age', '')
    terms = search_terms(params.get('search', ''))
    if gender not in ('', 'F', 'M'): raise ValueError('不支持的性别条件')
    if age and age not in AGES + ['65+', '<18', 'Unknown']: raise ValueError('不支持的年龄组')
    if unit and unit not in {r['first_careunit'] for r in COHORT}: raise ValueError('不支持的 ICU 类型')
    lower = numeric(params, 'los_min', 0)
    upper = numeric(params, 'los_max')
    if upper is not None and upper <= lower: raise ValueError('停留时长上限必须大于下限')
    rows = []
    for r in COHORT:
        if unit and r['first_careunit'] != unit: continue
        if gender and r['gender'] != gender: continue
        if age == '65+' and r['age_group'] not in ['65-79', '80-89', '90+']: continue
        if age and age != '65+' and r['age_group'] != age: continue
        if r['icu_los_days'] < lower or (upper is not None and r['icu_los_days'] >= upper): continue
        if terms and not matches_case(r, terms): continue
        rows.append(r)
    return rows

def quantile(sorted_values, q):
    if not sorted_values: return None
    pos = (len(sorted_values)-1)*q
    low = int(pos); high = math.ceil(pos)
    return sorted_values[low] + (sorted_values[high]-sorted_values[low])*(pos-low)

def analysis(params, rows=None):
    rows = filtered(params) if rows is None else rows
    durations = sorted(r['icu_los_days'] for r in rows)
    units = Counter(r['first_careunit'] for r in rows)
    ages = Counter(r['age_group'] for r in rows)
    genders = Counter(r['gender'] for r in rows)
    bins = [(0,1,'<1'),(1,2,'1–2'),(2,3,'2–3'),(3,5,'3–5'),(5,7,'5–7'),(7,14,'7–14'),(14,30,'14–30'),(30,None,'30+')]
    hist = [{'label':label,'min':low,'max':high,'count':sum(low <= d and (high is None or d < high) for d in durations)} for low,high,label in bins]
    unit_durations = defaultdict(list)
    matrix = Counter()
    for r in rows:
        unit_durations[r['first_careunit']].append(r['icu_los_days'])
        matrix[(r['first_careunit'],r['age_group'])] += 1
    boxes = []
    for unit, count in units.most_common():
        vals = sorted(unit_durations[unit])
        q1,q2,q3 = [quantile(vals,q) for q in [.25,.5,.75]]
        lo,hi = q1-1.5*(q3-q1),q3+1.5*(q3-q1)
        boxes.append({'unit':unit,'count':count,'q1':q1,'median':q2,'q3':q3,'low':next(v for v in vals if v>=lo),'high':next(v for v in reversed(vals) if v<=hi)})
    scatter_rows = [r for r in rows if r['age_topcoded'] or r['age_estimate'] is not None]
    size = min(1200,len(scatter_rows))
    sample = [scatter_rows[int(i*len(scatter_rows)/size)] for i in range(size)] if size else []
    return {'summary': {'stays':len(rows),'patients':len({r['subject_id'] for r in rows}), 'admissions':len({r['hadm_id'] for r in rows}),
             'median_los':quantile(durations,.5),'mean_los':statistics.mean(durations) if durations else None,
             'q1_los':quantile(durations,.25),'q3_los':quantile(durations,.75)},
            'units':[{'unit':u,'count':n} for u,n in units.most_common()],
            'ages':[{'age':a,'count':ages[a]} for a in AGES + [a for a in ages if a not in AGES]],
            'genders':[{'gender':g,'count':n} for g,n in sorted(genders.items(),key=lambda x:str(x[0]))],
            'histogram':hist,'boxes':boxes,
            'heatmap':[{'unit':u,'age':a,'count':matrix[(u,a)]} for u,_ in units.most_common() for a in AGES],
            'scatter':[{'stay_id':r['stay_id'],'age':90 if r['age_topcoded'] else r['age_estimate'],'topcoded':r['age_topcoded'], 'los':r['icu_los_days'],'unit':r['first_careunit']} for r in sample],
            'total_cohort':len(COHORT)}

def comparison(params):
    allowed = {'age','gender','unit','los_min','los_max','search'}
    if any(key[:2] not in ('a_', 'b_') or key[2:] not in allowed for key in params):
        raise ValueError('不支持的队列对比条件')
    filters = [{key[2:]:value for key,value in params.items() if key.startswith(prefix)}
               for prefix in ('a_', 'b_')]
    groups = [filtered(f) for f in filters]
    snapshots = []
    for f, rows in zip(filters, groups):
        data = analysis(f, rows)
        snapshots.append({'filters':f, **{key:data[key] for key in
                          ('summary','histogram','ages','genders','units')}})
    stay_sets = [{r['stay_id'] for r in rows} for rows in groups]
    patient_sets = [{r['subject_id'] for r in rows} for rows in groups]
    return {'a':snapshots[0], 'b':snapshots[1],
            'overlap_stays':len(stay_sets[0] & stay_sets[1]),
            'overlap_patients':len(patient_sets[0] & patient_sets[1])}

def vital_coverage(series, start, end, width):
    total = max(1, math.ceil((end-start)/width))
    coverage = {}
    for itemid, points in series.items():
        present = {p['bucket'] for p in points}
        longest = current = 0
        for bucket in range(total):
            if bucket in present:
                current = 0
            else:
                current += min(width, end-start-bucket*width)
                longest = max(longest, current)
        coverage[itemid] = {'recorded_buckets':len(present), 'total_buckets':total,
                            'fraction':len(present)/total, 'longest_gap_hours':longest}
    return coverage

def stays(params):
    rows = filtered(params)
    page = int(numeric(params,'page',1,1,100000))
    size = int(numeric(params,'page_size',15,1,100))
    sort = params.get('sort','los_desc')
    keys = {'los_desc':('icu_los_days',True),'los_asc':('icu_los_days',False),'stay_asc':('stay_id',False)}
    if sort not in keys: raise ValueError('不支持的排序')
    key,reverse=keys[sort]
    rows.sort(key=lambda r:(r[key],r['stay_id']),reverse=reverse)
    return {'total':len(rows),'page':page,'page_size':size,'items':rows[(page-1)*size:page*size]}

def filter_action_preview(filters, changes, question=''):
    filtered(filters)  # Validate the complete base, including a preserved lookup.
    action = prepare_filter_action({'changes':changes},filters,
        sorted({r['first_careunit'] for r in COHORT}),question)
    action['preview_summary'] = analysis(action['filters'])['summary']
    return action

def detail(stay_id):
    row = BY_ID.get(stay_id)
    if row is None: raise LookupError('找不到这次 ICU 入住')
    with connect() as c:
        issues = [r[0] for r in c.execute('SELECT issue FROM data_quality_issues WHERE stay_id=?',(stay_id,))]
        summaries = [dict(r) for r in c.execute('SELECT * FROM stay_vital_summary WHERE stay_id=?',(stay_id,))]
        related = [dict(r) for r in c.execute('SELECT stay_id,intime,outtime,icu_los_days,first_careunit FROM icu_cohort WHERE subject_id=? ORDER BY intime',(row['subject_id'],))]
    return {'stay':row,'issues':issues,'metrics':[{'itemid':key,'label':label,'unit':unit} for key,(label,unit) in METRICS.items()], 'summaries':summaries,'related_stays':related}

@lru_cache(maxsize=64)
def vital_data(stay_id,start,end,include_flagged):
    row=BY_ID.get(stay_id)
    if row is None: raise LookupError('找不到这次 ICU 入住')
    duration=row['icu_los_days']*24
    end=min(end,duration)
    if end <= start: raise ValueError('时间区间结束必须大于开始')
    # At most ~240 time bins per metric. Bin widths are common across all panels.
    width=max(1,math.ceil((end-start)/240))
    t0=(datetime.fromisoformat(row['intime'])+timedelta(hours=start)).isoformat(sep=' ')
    t1=(datetime.fromisoformat(row['intime'])+timedelta(hours=end)).isoformat(sep=' ')
    flag_condition='' if include_flagged else 'AND quality_flag IS NULL'
    # Adjacent windows do not count a shared boundary twice. Include the actual
    # discharge endpoint only in the final window and keep it in the last bucket.
    right_operator = '<=' if end == duration else '<'
    last_bucket = max(0, math.ceil((end-start)/width)-1)
    with connect() as c:
        result=[dict(r) for r in c.execute(f'''SELECT itemid,MIN(?,CAST((hours_since_icu-?)/? AS INTEGER)) AS bucket,
            AVG(hours_since_icu) AS hour,AVG(value) AS value,MIN(value) AS minimum,MAX(value) AS maximum,
            COUNT(*) AS observations,SUM(quality_flag IS NOT NULL) AS flagged
            FROM vital_observations WHERE stay_id=? AND charttime>=? AND charttime{right_operator}? {flag_condition}
            GROUP BY itemid,bucket ORDER BY itemid,bucket''',(last_bucket,start,width,stay_id,t0,t1))]
    series={str(k):[] for k in METRICS}
    for r in result: series[str(r.pop('itemid'))].append(r)
    return {'start':start,'end':end,'bin_hours':width,'series':series,'include_flagged':include_flagged,
            'coverage':vital_coverage(series,start,end,width)}

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(PUBLIC),**kwargs)
    def do_GET(self):
        parsed=urlparse(self.path)
        if not parsed.path.startswith('/api/'):
            if parsed.path == '/': self.path='/index.html'
            return super().do_GET()
        try:
            params={k:v[-1] for k,v in parse_qs(parsed.query).items()}
            route=parsed.path
            if route=='/api/summary/status':
                settings=summary_config()
                data={'configured':bool(settings['DEEPSEEK_API_KEY']), 'model':settings['DEEPSEEK_MODEL']}
            elif route=='/api/options':
                data={'units':sorted({r['first_careunit'] for r in COHORT}),'ages':AGES,'cohort_count':len(COHORT),'database':'MIMIC-IV 3.1'}
            elif route=='/api/analysis': data=analysis(params)
            elif route=='/api/compare': data=comparison(params)
            elif route=='/api/stays': data=stays(params)
            elif route.startswith('/api/stays/'):
                parts=route.strip('/').split('/')
                sid=int(parts[2])
                if len(parts)==3: data=detail(sid)
                elif len(parts)==4 and parts[3]=='vitals':
                    r=BY_ID.get(sid)
                    if r is None: raise LookupError('找不到这次 ICU 入住')
                    start=numeric(params,'start',0)
                    end=numeric(params,'end',r['icu_los_days']*24)
                    data=vital_data(sid,start,end,params.get('include_flagged')=='1')
                else: raise LookupError('接口不存在')
            else: raise LookupError('接口不存在')
            self.respond(200,data)
        except (ValueError,TypeError) as e: self.respond(400,{'error':str(e)})
        except LookupError as e: self.respond(404,{'error':str(e)})
        except Exception as e:
            print('Request error:',repr(e),flush=True)
            self.respond(500,{'error':'查询失败，请查看服务端日志'})
    def do_POST(self):
        if self.path not in ('/api/summary', '/api/chat', '/api/filter-preview'):
            return self.respond(404, {'error':'接口不存在'})
        origin = self.headers.get('Origin')
        if origin and origin != 'http://' + self.headers.get('Host', ''):
            return self.respond(403, {'error':'不允许跨站请求'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.respond(415, {'error':'请求必须使用 JSON'})
        try:
            length=int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 100000:
                return self.respond(413, {'error':'请求大小不合法'})
            body=json.loads(self.rfile.read(length))
            expected = {'filters','changes','question'} if self.path == '/api/filter-preview' else {'filters', 'messages'} if self.path == '/api/chat' else {'filters'}
            if not isinstance(body, dict) or set(body) != expected or not isinstance(body['filters'], dict):
                raise ValueError('请求格式不合法')
            if self.path == '/api/chat':
                validate_messages(body['messages'])
            params=body['filters']
            if set(params) - {'age','gender','unit','los_min','los_max','search'} or any(not isinstance(v,str) for v in params.values()):
                raise ValueError('筛选条件格式不合法')
            if self.path == '/api/filter-preview':
                if not isinstance(body['question'],str) or len(body['question'])>1500:
                    raise ValueError('筛选问题格式不合法')
                return self.respond(200,filter_action_preview(params,body['changes'],body['question']))
            options = {'ages':list(ACTION_AGES),'units':sorted({r['first_careunit'] for r in COHORT})}
            result = summarize(analysis(params),params,body.get('messages'),options)
            if result.get('filter_action'):
                action = result['filter_action']
                action['preview_summary'] = analysis(action['filters'])['summary']
            self.respond(200,result)
        except FilterActionError as e:
            self.respond(400, {'error':str(e)})
        except SummaryError as e:
            self.respond(e.status, {'error':str(e)})
        except (ValueError, TypeError):
            self.respond(400, {'error':'筛选条件或请求格式不合法'})
        except Exception:
            self.respond(500, {'error':'助手暂时无法回答，请稍后重试'})

    def respond(self,status,data):
        body=json.dumps(data,ensure_ascii=False,allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(body)))
        self.end_headers();self.wfile.write(body)

def main():
    global COHORT,BY_ID
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8765)
    args=p.parse_args()
    if not DB.exists(): raise SystemExit('请先运行 scripts/build_database.py')
    COHORT=load_cohort();BY_ID={r['stay_id']:r for r in COHORT}
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    print(f'ICU Explorer ready: http://127.0.0.1:{args.port} ({len(COHORT):,} stays)',flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()

if __name__=='__main__': main()
