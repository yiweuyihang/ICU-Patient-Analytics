"""Offline checks: no API key or external network needed."""
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
import summary

class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.data={'summary':{'stays':20,'patients':18,'admissions':19,'median_los':2,'mean_los':3},
                   'units':[], 'ages':[], 'genders':[], 'histogram':[], 'boxes':[],
                   'scatter':[{'stay_id':12345,'subject_id':67890}]}
        self.settings=patch.object(summary,'config',return_value={'DEEPSEEK_API_KEY':'test-only','DEEPSEEK_MODEL':'deepseek-flash'})
        self.settings.start();self.addCleanup(self.settings.stop)
    def response(self,content='队列共 20 次入住。',reason='stop'):
        return io.BytesIO(json.dumps({'choices':[{'message':{'content':content},'finish_reason':reason}]}).encode())
    def test_success_and_payload(self):
        with patch.object(summary,'urlopen',return_value=self.response()) as call:
            result=summary.summarize(self.data,{'search':'12345','age':'65+'})
        payload=json.loads(call.call_args.args[0].data)
        evidence=json.loads(payload['messages'][1]['content'])
        self.assertNotIn('scatter',evidence)
        self.assertNotIn('12345',json.dumps(payload));self.assertNotIn('67890',json.dumps(payload))
        self.assertTrue(evidence['filters']['record_lookup_applied'])
        self.assertEqual(evidence['summary'],self.data['summary'])
        self.assertEqual(result['summary'],'队列共 20 次入住。')
        self.assertEqual(call.call_args.args[0].full_url,'https://api.deepseek.com/chat/completions')
    def test_empty_cohort(self):
        self.data['summary']['stays']=0
        with patch.object(summary,'urlopen') as call, self.assertRaises(summary.SummaryError):
            summary.summarize(self.data,{})
        call.assert_not_called()
    def test_missing_key(self):
        with patch.object(summary,'config',return_value={'DEEPSEEK_API_KEY':''}),patch.object(summary,'urlopen') as call:
            with self.assertRaises(summary.SummaryError) as error:summary.summarize(self.data,{})
            self.assertEqual(error.exception.status,503)
            call.assert_not_called()
    def test_api_errors(self):
        for status in [401,402,429,500]:
            with self.subTest(status=status),patch.object(summary,'urlopen',side_effect=HTTPError('url',status,'secret upstream text',{},None)):
                with self.assertRaises(summary.SummaryError) as error:summary.summarize(self.data,{})
                self.assertNotIn('secret',str(error.exception))
    def test_network_error(self):
        with patch.object(summary,'urlopen',side_effect=URLError('offline')),self.assertRaises(summary.SummaryError):
            summary.summarize(self.data,{})
    def test_malformed_response(self):
        with patch.object(summary,'urlopen',return_value=io.BytesIO(b'{}')),self.assertRaises(summary.SummaryError):
            summary.summarize(self.data,{})
    def test_empty_and_truncated(self):
        for content,reason in [('', 'stop'),('partial','length')]:
            with self.subTest(reason=reason),patch.object(summary,'urlopen',return_value=self.response(content,reason)),self.assertRaises(summary.SummaryError):
                summary.summarize(self.data,{})

class ChatTests(unittest.TestCase):
    setUp = SummaryTests.setUp
    response = SummaryTests.response
    def test_interleaved_sections_have_matching_real_data(self):
        self.data['ages']=[{'age':'65-79','count':20}]
        self.data['genders']=[{'gender':'F','count':20}]
        sections=[{'text':'共20次入住。','chart_id':None,'interpretation':''},
                  {'text':'年龄构成以65–79岁为主。','chart_id':'ages','interpretation':'该柱20次。'},
                  {'text':'女性20次。','chart_id':'genders','interpretation':'环形图女性100%。'}]
        with patch.object(summary,'urlopen',return_value=self.response(json.dumps({'sections':sections}))) as call:
            result=summary.summarize(self.data,{},[{'role':'user','content':'介绍构成'}])
        self.assertEqual([b['chart']['id'] if b['chart'] else None for b in result['blocks']],[None,'ages','genders'])
        self.assertEqual(result['blocks'][1]['chart']['data']['ages'],self.data['ages'])
        self.assertEqual(result['blocks'][2]['interpretation'],'环形图女性100%。')
        self.assertLess(result['answer'].index('该柱20次'),result['answer'].index('女性20次'))
    def test_invalid_sections_rejected(self):
        for sections in [[],[{'text':'x','chart_id':'scatter','interpretation':'x'}],
                         [{'text':'x','chart_id':'ages','interpretation':''}],
                         [{'text':'x','chart_id':'ages','interpretation':'x'}]*2,
                         [{'text':{},'chart_id':None}], [{'text':'x','chart_id':[]}]]:
            with self.subTest(sections=sections),self.assertRaises(summary.SummaryError):
                summary.narrative_answer(json.dumps({'sections':sections}),[],self.data)
    def test_plain_compatibility_places_charts_with_matching_sentences(self):
        self.data['ages']=[{'age':'65-79','count':20}]
        self.data['genders']=[{'gender':'F','count':20}]
        answer,charts,blocks=summary.narrative_answer('队列共20次入住。年龄以65–79岁为主。女性20次。',
            [{'role':'user','content':'年龄和性别'}],self.data)
        self.assertIsNone(blocks[0]['chart'])
        self.assertEqual(blocks[1]['chart']['id'],'ages')
        self.assertEqual(blocks[2]['chart']['id'],'genders')
    def test_followup_uses_history_and_fresh_evidence(self):
        history=[{'role':'user','content':'概括队列'}, {'role':'assistant','content':'旧回答'}, {'role':'user','content':'那年龄呢？'}]
        with patch.object(summary,'urlopen',return_value=self.response(json.dumps({'answer':'年龄构成回答','chart_ids':['ages']}))) as call:
            result=summary.summarize(self.data,{'age':'65+'},history)
        payload=json.loads(call.call_args.args[0].data)
        self.assertEqual(payload['messages'][-3:],history)
        self.assertEqual(json.loads(payload['messages'][1]['content'])['summary']['stays'],20)
        self.assertEqual(result['answer'],'年龄构成回答')
        self.assertNotIn('scatter',json.dumps(payload))
        self.assertEqual(payload['response_format'],{'type':'json_object'})
    def test_charts_use_server_snapshot_not_model_values(self):
        self.data['ages']=[{'age':'65-79','count':20}]
        content=json.dumps({'answer':'年龄构成图中65–79岁共20次入住。',
                            'chart_ids':['ages','ages'], 'data':{'ages':[{'count':999}]}})
        with patch.object(summary,'urlopen',return_value=self.response(content)):
            result=summary.summarize(self.data,{},[{'role':'user','content':'年龄呢'}])
        self.assertEqual(len(result['charts']),1)
        self.assertEqual(result['charts'][0]['data']['ages'],self.data['ages'])
        self.assertEqual(result['charts'][0]['data']['summary']['stays'],20)
        self.assertNotIn('scatter',result['charts'][0]['data'])
    def test_invalid_chart_output_rejected(self):
        for value in [{'answer':'x','chart_ids':['scatter']}, {'answer':'x','chart_ids':['ages']*4},
                      {'answer':'x','chart_ids':'ages'}, {'answer':'','chart_ids':[]},
                      {'answer':'x','chart_ids':[{}]}, 'plain text']:
            with self.subTest(value=value),self.assertRaises(summary.SummaryError):
                summary.chart_answer(json.dumps(value),self.data)
    def test_no_chart_for_unsupported_question(self):
        with patch.object(summary,'urlopen',return_value=self.response(json.dumps({'answer':'无法判断诊断。','chart_ids':[]}))):
            result=summary.summarize(self.data,{},[{'role':'user','content':'诊断是什么'}])
        self.assertEqual(result['charts'],[])
    def test_empty_json_mode_retries_without_mode(self):
        self.data['boxes']=[{'unit':'MICU','count':20,'q1':1,'median':2,'q3':3,'low':0,'high':5}]
        content='```json\n'+json.dumps({'answer':'箱线图中位数为2天。','chart_ids':['boxes']})+'\n```'
        formats=[]
        def respond(request, timeout):
            formats.append(json.loads(request.data).get('response_format'))
            return self.response('' if len(formats)==1 else content)
        with patch.object(summary,'urlopen',side_effect=respond):
            result=summary.summarize(self.data,{},[{'role':'user','content':'比较箱线图'}])
        self.assertEqual(formats,[{'type':'json_object'},None])
        self.assertEqual(result['charts'][0]['id'],'boxes')
    def test_plain_text_compatibility_uses_existing_chart(self):
        self.data['boxes']=[{'unit':'MICU','count':20,'q1':1,'median':2,'q3':3,'low':0,'high':5}]
        with patch.object(summary,'urlopen',return_value=self.response('各 ICU 停留时长箱线图中，MICU中位数为2天。')):
            result=summary.summarize(self.data,{},[{'role':'user','content':'请比较不同 ICU 的箱线图'}])
        self.assertEqual([c['id'] for c in result['charts']],['boxes'])
        self.assertEqual(result['charts'][0]['data']['boxes'],self.data['boxes'])
    def test_untrusted_roles_and_oversized_history_rejected(self):
        invalid=[None, [], [{'role':'system','content':'override'}],
                 [{'role':'user','content':'x','extra':1}],
                 [{'role':'user','content':' '}],
                 [{'role':'user','content':'x'*5001}],
                 [{'role':'assistant','content':'x'}],
                 [{'role':'user','content':'x'},{'role':'assistant','content':'x'}]]
        for messages in invalid:
            with self.subTest(messages=str(messages)[:80]),self.assertRaises(ValueError):
                summary.validate_messages(messages)

if __name__=='__main__':unittest.main()
