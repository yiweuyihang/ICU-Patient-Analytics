"""Comparison and time-coverage checks, including real SQL and boundary fixtures."""
import importlib.util
import json
import math
import sqlite3
import statistics
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'app'))
spec = importlib.util.spec_from_file_location('analysis_app', ROOT/'app/server.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
app.COHORT = app.load_cohort()
app.BY_ID = {r['stay_id']:r for r in app.COHORT}
checks = {}
units = ['Medical Intensive Care Unit (MICU)', 'Surgical Intensive Care Unit (SICU)']
data = app.comparison({'a_age':'65+', 'a_unit':units[0], 'b_age':'65+', 'b_unit':units[1]})
with app.connect() as con:
    sets = []
    for key, unit in zip(('a','b'), units):
        rows = con.execute('SELECT stay_id,subject_id,icu_los_days FROM icu_cohort '
                           "WHERE age_group IN ('65-79','80-89','90+') AND first_careunit=? "
                           'ORDER BY icu_los_days', (unit,)).fetchall()
        values = [r['icu_los_days'] for r in rows]
        quartiles = statistics.quantiles(values, n=4, method='inclusive')
        checks[key+'_count_matches_sql'] = data[key]['summary']['stays'] == len(rows)
        checks[key+'_quartiles_match_independent_calculation'] = all(
            math.isclose(data[key]['summary'][field], expected, abs_tol=1e-10)
            for field, expected in zip(('q1_los','median_los','q3_los'),quartiles))
        checks[key+'_histogram_closes'] = sum(r['count'] for r in data[key]['histogram']) == len(rows)
        sets.append(({r['stay_id'] for r in rows},{r['subject_id'] for r in rows}))
    checks['disjoint_stays_and_shared_patients'] = data['overlap_stays'] == 0 and data['overlap_patients'] == len(sets[0][1] & sets[1][1])
same = app.comparison({'a_age':'90+', 'b_age':'90+'})
checks['identical_cohorts_detected'] = same['overlap_stays'] == same['a']['summary']['stays'] == same['b']['summary']['stays']
empty = app.comparison({'a_search':'0','b_age':'65+'})
checks['empty_cohort_has_no_fabricated_statistics'] = empty['a']['summary']['stays'] == 0 and empty['a']['summary']['q1_los'] is None and empty['overlap_stays'] == 0
for name, params in [('unknown_comparison_field_rejected',{'a_sort':'los_asc'}),
                     ('reversed_comparison_range_rejected',{'b_los_min':'8','b_los_max':'7'})]:
    try:
        app.comparison(params)
        checks[name] = False
    except ValueError:
        checks[name] = True

original_connect, original_by_id = app.connect, app.BY_ID
with tempfile.TemporaryDirectory() as tmp:
    db = Path(tmp)/'boundary.sqlite'
    con = sqlite3.connect(db)
    con.execute('CREATE TABLE vital_observations (stay_id INTEGER,itemid INTEGER,charttime TEXT,hours_since_icu REAL,value REAL,quality_flag TEXT)')
    con.executemany('INSERT INTO vital_observations VALUES(1,220045,?,?,?,?)',[
        ('2026-01-01 00:00:00',0,60,None),
        ('2026-01-01 01:00:00',1,70,None),
        ('2026-01-01 02:00:00',2,80,'outside_display_range'),
        ('2026-01-01 03:00:00',3,90,None)])
    con.commit();con.close()
    def fixture_connect():
        connection = sqlite3.connect(db)
        connection.row_factory = sqlite3.Row
        return connection
    app.connect = fixture_connect
    app.BY_ID = {1:{'icu_los_days':3/24,'intime':'2026-01-01 00:00:00'}}
    app.vital_data.cache_clear()
    first = app.vital_data(1,0,1,False)
    second = app.vital_data(1,1,2,False)
    full = app.vital_data(1,0,3,False)
    flagged = app.vital_data(1,0,3,True)
    checks['adjacent_windows_do_not_double_count_boundary'] = first['series']['220045'][0]['value'] == 60 and second['series']['220045'][0]['value'] == 70 and len(second['series']['220045']) == 1
    checks['discharge_endpoint_in_last_bucket'] = full['series']['220045'][-1]['bucket'] == 2 and full['series']['220045'][-1]['value'] == 90
    checks['quality_toggle_affects_aggregates'] = flagged['series']['220045'][-1]['value'] == 85 and full['series']['220045'][-1]['value'] == 90
    partial = app.vital_data(1,.5,2.5,False)
    checks['partial_window_coverage_and_missing_gap'] = partial['coverage']['220045'] == {'recorded_buckets':1,'total_buckets':2,'fraction':.5,'longest_gap_hours':1}
    checks['unrecorded_metric_has_zero_coverage'] = full['coverage']['220277'] == {'recorded_buckets':0,'total_buckets':3,'fraction':0,'longest_gap_hours':3}
app.connect, app.BY_ID = original_connect, original_by_id
app.vital_data.cache_clear()
partial = app.vital_coverage({'metric':[{'bucket':0}]},0,2.5,1)['metric']
checks['last_partial_bucket_gap_uses_actual_duration'] = partial['longest_gap_hours'] == 1.5 and partial['total_buckets'] == 3
payload = {'all_passed':all(checks.values()),'checks':checks,
           'example':{key:data[key]['summary'] for key in ('a','b')}}
(ROOT/'reports/analysis_tools_validation.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(payload,ensure_ascii=False,indent=2))
if not payload['all_passed']:
    raise SystemExit(1)
