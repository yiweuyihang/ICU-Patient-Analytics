"""Offline model checks and independent SQL checks for proposed filter actions."""
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'app'))
import summary
from filter_actions import prepare_filter_action, FilterActionError

MICU='Medical Intensive Care Unit (MICU)'
SICU='Surgical Intensive Care Unit (SICU)'
UNITS=[MICU,SICU]

class FilterActionTests(unittest.TestCase):
    def plan(self,changes,base=None,question=''):
        return prepare_filter_action({'changes':changes},base or {},UNITS,question)
    def test_basic_proposal_does_not_mutate_base(self):
        base={'unit':MICU}
        result=self.plan({'age':'65+','los_min':7},base,'筛出65岁及以上，停留至少7天')
        self.assertEqual(base,{'unit':MICU})
        self.assertEqual(result['filters'],{'unit':MICU,'age':'65+','los_min':'7'})
        self.assertEqual(result['base_filters'],base)
    def test_incremental_proposal_preserves_unmentioned_conditions(self):
        base={'age':'65+','los_min':'7','unit':MICU,'search':'12345'}
        result=self.plan({'gender':'F'},base,'再只看女性')
        self.assertEqual(result['filters'],{**base,'gender':'F'})
    def test_clearing_is_explicit(self):
        result=self.plan({'unit':None},{'unit':MICU,'age':'65+'},'取消 ICU 类型限制')
        self.assertEqual(result['filters'],{'age':'65+'})
    def test_unit_alias_comes_from_available_types(self):
        self.assertEqual(self.plan({'unit':'micu'})['filters']['unit'],MICU)
        with self.assertRaises(FilterActionError):self.plan({'unit':'虚构ICU'})
    def test_noop_has_no_apply_card(self):
        with self.assertRaises(FilterActionError):self.plan({'age':'65+'},{'age':'65+'})
    def test_unsupported_fields_and_invalid_types(self):
        for changes in [{'sql':'SELECT *'}, {'search':'123'}, {'age':'70+'}, {'gender':'other'},
                        {'unit':{}}, {'los_min':True}, {'los_min':-1}, {'los_max':'nan'},
                        {'los_min':float('inf')}, {'los_min':100001}, {'los_min':'7天'}, {}, [], None]:
            with self.subTest(changes=changes),self.assertRaises(FilterActionError):self.plan(changes)
    def test_ranges_use_existing_exclusive_upper_boundary(self):
        result=self.plan({'los_min':7,'los_max':14})
        self.assertEqual(result['filters'],{'los_min':'7','los_max':'14'})
        for changes in [{'los_min':14,'los_max':7},{'los_min':7,'los_max':7}]:
            with self.assertRaises(FilterActionError):self.plan(changes)
    def test_unsupported_age_and_union_are_not_coarsened(self):
        for question in ['筛出70岁以上的入住','筛出年龄至少70岁的入住','只看65岁以下的患者',
                         '筛出35到50岁的入住','筛出18-39和65-79岁的入住']:
            with self.subTest(question=question),self.assertRaises(FilterActionError):
                self.plan({'age':'65+'},question=question)
    def test_supported_age_range(self):
        self.assertEqual(self.plan({'age':'65-79'},question='只看65到79岁')['filters']['age'],'65-79')
    def test_mismatched_sex_or_duration_is_rejected(self):
        for changes,question in [({'gender':'M'},'只看女性'),({'los_min':8},'停留至少7天'),
                                 ({'los_max':20},'停留少于14天')]:
            with self.subTest(question=question),self.assertRaises(FilterActionError):self.plan(changes,question=question)
    def test_strict_and_inclusive_duration_boundaries_need_clarification(self):
        for question in ['只看超过7天的入住','停留大于7天','停留>7天','停留最多14天',
                         '停留不超过14天','停留<=14天']:
            with self.subTest(question=question),self.assertRaises(FilterActionError):
                self.plan({'los_min':7,'los_max':14},question=question)
    def test_supported_duration_boundaries(self):
        for question in ['停留至少7天且少于14天','停留不少于7天且小于14天','停留>=7天且<14天']:
            with self.subTest(question=question):self.assertTrue(self.plan({'los_min':7,'los_max':14},question=question))
    def test_multiple_units_require_separate_cohorts(self):
        with self.assertRaises(FilterActionError):self.plan({'unit':MICU},question='筛选MICU和SICU的入住')
    def test_ids_are_stable_for_equivalent_patches(self):
        a=self.plan({'age':'65+','los_min':7})
        b=self.plan({'los_min':'7.0','age':'65+'})
        self.assertEqual(a['id'],b['id'])
    def test_reason_and_extra_action_fields_are_bounded(self):
        for raw in [{'changes':{'age':'65+'},'reason':{}}, {'changes':{'age':'65+'},'execute':True},
                    {'changes':{'age':'65+'},'reason':'x'*301}]:
            with self.assertRaises(FilterActionError):prepare_filter_action(raw,{},UNITS)

class ModelActionTests(unittest.TestCase):
    def setUp(self):
        self.data={'summary':{'stays':20,'patients':18,'admissions':19,'median_los':2,'mean_los':3},
                   'units':[], 'ages':[], 'genders':[], 'histogram':[], 'boxes':[], 'scatter':[{'stay_id':12345}]}
        self.settings=patch.object(summary,'config',return_value={'DEEPSEEK_API_KEY':'test-only','DEEPSEEK_MODEL':'deepseek-flash'})
        self.settings.start();self.addCleanup(self.settings.stop)
    def run_reply(self,action,question='筛出65岁及以上，停留至少7天',filters=None):
        content=json.dumps({'sections':[{'text':'请核对下面的筛选条件，尚未应用。','chart_id':None,'interpretation':''}], 'filter_action':action})
        response=io.BytesIO(json.dumps({'choices':[{'message':{'content':content},'finish_reason':'stop'}]}).encode())
        with patch.object(summary,'urlopen',return_value=response) as call:
            result=summary.summarize(self.data,filters or {},[{'role':'user','content':question}],{'ages':['65+'],'units':UNITS})
        return result,json.loads(call.call_args.args[0].data)
    def test_valid_action_and_server_options(self):
        result,payload=self.run_reply({'changes':{'age':'65+','los_min':7},'reason':'按年龄和时长筛选'})
        self.assertEqual(result['filter_action']['filters'],{'age':'65+','los_min':'7'})
        self.assertNotIn('preview_summary',result['filter_action'])
        evidence=json.loads(payload['messages'][1]['content'])
        self.assertEqual(evidence['filter_options']['units'],UNITS)
        self.assertNotIn('scatter',evidence)
    def test_invalid_action_does_not_destroy_valid_answer(self):
        result,_=self.run_reply({'changes':{'sql':'DROP TABLE'}},question='筛选')
        self.assertIsNone(result['filter_action']);self.assertTrue(result['action_notice']);self.assertTrue(result['blocks'])
    def test_unsupported_age_is_not_silently_rounded(self):
        result,_=self.run_reply({'changes':{'age':'65+'}},question='筛选70岁以上的患者')
        self.assertIsNone(result['filter_action']);self.assertIn('年龄',result['action_notice'])
    def test_empty_current_cohort_can_request_new_filters(self):
        self.data['summary']['stays']=0
        result,_=self.run_reply({'changes':{'los_min':None}},question='取消停留下限',filters={'los_min':'10000'})
        self.assertEqual(result['filter_action']['filters'],{})
    def test_ordinary_analysis_has_no_filter_action(self):
        result,_=self.run_reply(None,question='概括当前队列')
        self.assertIsNone(result['filter_action']);self.assertEqual(result['action_notice'],'')
    def test_identifier_remains_local(self):
        result,payload=self.run_reply({'changes':{'age':'65+','los_min':7}},filters={'search':'12345'})
        self.assertEqual(result['filter_action']['filters']['search'],'12345')
        self.assertNotIn('12345',json.dumps(payload))

class DatabaseActionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec=importlib.util.spec_from_file_location('icu_action_server',ROOT/'app/server.py')
        cls.app=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.app)
        cls.app.COHORT=cls.app.load_cohort();cls.app.BY_ID={r['stay_id']:r for r in cls.app.COHORT}
    def test_preview_counts_and_median_match_independent_sql(self):
        action=self.app.filter_action_preview({}, {'age':'65+','los_min':'7'},'筛出65岁及以上、停留至少7天')
        with self.app.connect() as con:
            row=con.execute("SELECT COUNT(*),COUNT(DISTINCT subject_id),COUNT(DISTINCT hadm_id) FROM icu_cohort WHERE age_group IN ('65-79','80-89','90+') AND icu_los_days>=7").fetchone()
        self.assertEqual(action['preview_summary']['stays'],row[0]);self.assertEqual(row[0],5957)
        self.assertEqual(action['preview_summary']['patients'],row[1]);self.assertEqual(action['preview_summary']['admissions'],row[2])
    def test_preview_for_preserved_lookup_is_zero(self):
        action=self.app.filter_action_preview({'search':'0'},{'age':'65+'},'65岁以上')
        self.assertEqual(action['filters']['search'],'0');self.assertEqual(action['preview_summary']['stays'],0)
    def test_invalid_existing_conditions_cannot_be_applied(self):
        with self.assertRaises(ValueError):self.app.filter_action_preview({'unit':'fake'},{'age':'65+'},'筛选65岁以上')

if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result=unittest.TextTestRunner(verbosity=1).run(suite)
    (ROOT/'reports/filter_actions_validation.json').write_text(json.dumps({'all_passed':result.wasSuccessful(),'tests_run':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'external_model_calls':0},indent=2)+'\n')
    raise SystemExit(0 if result.wasSuccessful() else 1)
