"""Check case searches against independent SQL queries over the real cohort."""
import importlib.util
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
spec = importlib.util.spec_from_file_location('case_search_server', ROOT / 'app/server.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
app.COHORT = app.load_cohort()
app.BY_ID = {row['stay_id']: row for row in app.COHORT}
checks, timings, counts = {}, {}, {}

def verify(name, params, where, values=()):
    started = time.perf_counter()
    found = {row['stay_id'] for row in app.filtered(params)}
    timings[name] = round((time.perf_counter() - started) * 1000, 2)
    with app.connect() as con:
        expected = {row[0] for row in con.execute(
            'SELECT stay_id FROM icu_cohort WHERE ' + where, values)}
    checks[name] = found == expected
    counts[name] = len(found)

for field in ('stay_id', 'subject_id', 'hadm_id'):
    row = app.BY_ID[39784741]
    number = str(row[field])
    verify('search_' + field, {'search': number},
           'stay_id=? OR subject_id=? OR hadm_id=?', (number,) * 3)

verify('prefixed_identifier', {'search': ' #39784741 '}, 'stay_id=39784741')
verify('full_width_identifier', {'search': '３９７８４７４１'}, 'stay_id=39784741')
verify('english_case_insensitive', {'search': 'micu'},
       "first_careunit LIKE '%MICU%'")
verify('chinese_unit', {'search': '心血管'},
       "first_careunit='Cardiac Vascular Intensive Care Unit (CVICU)'")
verify('chinese_admission', {'search': '急诊'},
       "admission_type IN ('EW EMER.','DIRECT EMER.','EU OBSERVATION')")
verify('combined_keywords', {'search': '  ＭＩＣＵ\t紧急 '},
       "first_careunit LIKE '%MICU%' AND admission_type='URGENT'")
verify('search_with_filters', {'search': 'MICU 紧急', 'age': '65+',
       'gender': 'F', 'los_min': '7', 'los_max': '14'},
       "first_careunit LIKE '%MICU%' AND admission_type='URGENT' "
       "AND (age_estimate>=65 OR age_topcoded=1) AND gender='F' "
       'AND icu_los_days>=7 AND icu_los_days<14')
verify('empty_results', {'search': '没有这个科室'}, '0')
verify('search_is_literal_text', {'search': "<script>alert(1)</script>"}, '0')
verify('blank_search', {'search': '  \t '}, '1')
verify('exact_numeric_no_partial_match', {'search': '39784'}, 'stay_id=39784')

params = {'search': 'MICU 紧急', 'sort': 'los_asc', 'page_size': '15'}
first = app.stays({**params, 'page': '1'})
second = app.stays({**params, 'page': '2'})
checks['search_pagination_no_overlap'] = not (
    {row['stay_id'] for row in first['items']} &
    {row['stay_id'] for row in second['items']})
checks['search_sort_order'] = all(
    a['icu_los_days'] <= b['icu_los_days']
    for a, b in zip(first['items'], first['items'][1:]))
checks['list_statistics_consistent'] = first['total'] == app.analysis(params)['summary']['stays']
plan = app.filter_action_preview({'search': 'MICU 紧急'}, {'gender': 'F'}, '只看女性')
checks['assistant_preserves_search'] = (
    plan['filters']['search'] == 'MICU 紧急' and
    plan['preview_summary']['stays'] == app.stays({'search': 'MICU 紧急', 'gender': 'F'})['total'])
for name, value in [('long_search_rejected', 'a' * 101), ('non_text_rejected', 123)]:
    try:
        app.filtered({'search': value})
        checks[name] = False
    except ValueError:
        checks[name] = True

report = {'all_passed': all(checks.values()), 'checks': checks,
          'matched_counts': counts, 'search_timings_ms': timings}
(ROOT / 'reports/case_search_validation.json').write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False, indent=2))
if not report['all_passed']:
    raise SystemExit(1)
