"""Meaningful backend checks against the real database; writes a test report."""
import importlib.util
import json
import sqlite3
import time
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'app'))
spec=importlib.util.spec_from_file_location('icu_server',ROOT/'app/server.py')
app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)
app.COHORT=app.load_cohort();app.BY_ID={r['stay_id']:r for r in app.COHORT}
checks={};timings={}
def timed(name,fn):
    started=time.perf_counter();result=fn();timings[name]=round((time.perf_counter()-started)*1000,2);return result

all_data=timed('overall_analysis_ms',lambda:app.analysis({}))
with app.connect() as con:
    checks['overall_counts_match_database']=all_data['summary']['stays']==con.execute('SELECT COUNT(*) FROM icu_cohort').fetchone()[0]
    checks['distinct_patient_count']=all_data['summary']['patients']==con.execute('SELECT COUNT(DISTINCT subject_id) FROM icu_cohort').fetchone()[0]
    condition={'age':'65+','los_min':'7','gender':'F'}
    subset=timed('filtered_analysis_ms',lambda:app.analysis(condition))
    count=con.execute("SELECT COUNT(*) FROM icu_cohort WHERE (age_estimate>=65 OR age_topcoded=1) AND icu_los_days>=7 AND gender='F'").fetchone()[0]
    checks['combined_filter_matches_sql']=subset['summary']['stays']==count
    checks['histogram_count_partition']=sum(r['count'] for r in subset['histogram'])==count
    checks['age_and_unit_partition']=sum(r['count'] for r in subset['ages'])==sum(r['count'] for r in subset['units'])==count
    checks['scatter_limit_and_membership']=len(subset['scatter'])<=1200 and all(r['age']>=65 and r['los']>=7 for r in subset['scatter'])
    list1=app.stays({**condition,'page':'1','page_size':'15','sort':'los_asc'})
    list2=app.stays({**condition,'page':'2','page_size':'15','sort':'los_asc'})
    checks['pagination_no_overlap']=not {r['stay_id'] for r in list1['items']} & {r['stay_id'] for r in list2['items']}
    checks['sort_order']=all(a['icu_los_days']<=b['icu_los_days'] for a,b in zip(list1['items'],list1['items'][1:]))
    checks['pagination_total_matches']=list1['total']==count
    short=app.analysis({'los_max':'1'})
    checks['exclusive_upper_boundary']=short['summary']['stays']==con.execute('SELECT COUNT(*) FROM icu_cohort WHERE icu_los_days<1').fetchone()[0]
    empty=app.analysis({'search':'0'})
    checks['empty_results_safe']=empty['summary']['stays']==0 and empty['summary']['median_los'] is None and empty['scatter']==[]
    sid=39784741
    details=app.detail(sid)
    checks['detail_identity']=details['stay']['stay_id']==sid and bool(details['summaries'])
    data=timed('detail_vitals_72h_ms',lambda:app.vital_data(sid,0,72,False))
    for rawid,arr in data['series'].items():
        if arr:
            actual=con.execute('SELECT AVG(value),COUNT(*) FROM vital_observations WHERE stay_id=? AND itemid=? AND hours_since_icu>=0 AND hours_since_icu<1 AND quality_flag IS NULL',(sid,int(rawid))).fetchone()
            first=next((r for r in arr if r['bucket']==0),None)
            if first:
                checks['hourly_mean_matches_raw_sql']=abs(first['value']-actual[0])<1e-9 and first['observations']==actual[1]
                break
    checks['time_range_respected']=all(0<=p['hour']<=72 for arr in data['series'].values() for p in arr)
    checks['flagged_excluded_by_default']=all(p['flagged']==0 for arr in data['series'].values() for p in arr)
    full=timed('detail_vitals_full_ms',lambda:app.vital_data(sid,0,details['stay']['icu_los_days']*24,True))
    checks['aggregation_bounded']=all(len(arr)<=241 for arr in full['series'].values())
    topcoded=next(r for r in app.COHORT if r['age_topcoded'])
    checks['topcoded_age_query']=app.stays({'search':str(topcoded['stay_id']),'age':'65+'})['total']==1 and topcoded['age_estimate'] is None
    checks['identifier_query']=app.stays({'search':str(sid)})['total']==1
for name,fn in [('invalid_filter_rejected',lambda:app.filtered({'los_min':'nan'})),('reversed_range_rejected',lambda:app.filtered({'los_min':'8','los_max':'7'})),('invalid_sort_rejected',lambda:app.stays({'sort':'DROP TABLE'})),('invalid_vital_range_rejected',lambda:app.vital_data(sid,10,1,False))]:
    try:fn();checks[name]=False
    except ValueError:checks[name]=True
try:app.detail(0);checks['unknown_stay_rejected']=False
except LookupError:checks['unknown_stay_rejected']=True
payload={'all_passed':all(checks.values()),'checks':checks,'timings_ms':timings}
(ROOT/'reports/app_validation.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(payload,ensure_ascii=False,indent=2))
if not payload['all_passed']:raise SystemExit(1)
