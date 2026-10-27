"""Export a human-readable audit and SQLite data dictionary."""
import json
import sqlite3
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT=Path(__file__).resolve().parents[1]
out=ROOT/'reports'
report=json.loads((out/'quality_report.json').read_text())
timestamp=datetime.fromisoformat(report['built_at']).astimezone(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')
con=sqlite3.connect(ROOT/'data/icu_analysis.sqlite')
cohort=report['cohort']; overview=report['overview']
labels={
    'nonpositive_hospital_duration':'住院时长非正数', 'missing_or_invalid_time':'起止时间缺失或无效',
    'missing_patient':'无法关联患者记录','missing_admission':'无法关联住院记录',
    'subject_id_mismatch':'患者标识不一致','nonpositive_icu_duration':'ICU 时长非正数',
    'icu_outside_hospital_interval':'ICU 时间超出医院行政入出院时间范围',
    'selected_metric_records':'原始目标指标测量','retained_before_deduplication':'去重前保留测量',
    'outside_icu_interval':'测量时间不在对应 ICU 入住区间','flagged_value_records':'保留但标记的数值',
    'excluded_or_unknown_stay':'对应入住未纳入分析','exact_duplicates_removed':'删除完全重复的分析记录',
    'scanned_records':'扫描全部原始事件','retained_records':'最终保留测量',
    'identifier_mismatch':'测量与入住的标识不一致','missing_or_nonfinite_value':'测量数值缺失或非有限数',
    'invalid_charttime':'测量时间无效','unexpected_or_missing_unit':'单位缺失或不匹配',
    'heart_rate':'心率','respiratory_rate':'呼吸频率','spo2':'脉搏血氧饱和度',
    'arterial_systolic':'有创收缩压','arterial_diastolic':'有创舒张压','arterial_mean':'有创平均压',
    'noninvasive_systolic':'无创收缩压','noninvasive_diastolic':'无创舒张压','noninvasive_mean':'无创平均压',
}
lines=['# 数据清洗与数据库构建报告','',f"数据来源：MIMIC-IV 3.1；构建时间：{timestamp}（北京时间）。",'',
       '## 原始表规模','','| 数据表 | 原始记录数 |','|---|---:|']
for k,v in report['source_rows'].items(): lines.append(f'| {k} | {v:,} |')
lines+=['','## ICU 分析队列','',f"原始 ICU 入住 **{cohort['raw_icu_stays']:,}** 次，纳入 **{cohort['included_icu_stays']:,}** 次，排除 **{cohort['excluded_icu_stays']:,}** 次。",'',
        f"纳入记录涉及 **{overview['patients']:,}** 位患者、**{overview['admissions']:,}** 次住院。",'',
        f"ICU 停留时长中位数 **{overview['median_icu_los_days']:.3f} 天**，均值 **{overview['mean_icu_los_days']:.3f} 天**。",'',
        '| 排除原因 | 入住数 |','|---|---:|']
for k,v in cohort['exclusion_reasons'].items(): lines.append(f'| {labels.get(k,k)} | {v:,} |')
lines+=['','质量提示记录保留在分析队列，不直接排除：','']
for k,v in cohort['quality_issues'].items(): lines.append(f'- {labels.get(k,k)}：{v:,} 次入住。')
lines+=['','## ICU 类型分布','','| 类型（首次进入的 ICU） | 入住数 |','|---|---:|']
for r in report['icu_types']: lines.append(f"| {r['icu_type']} | {r['stays']:,} |")
if 'vitals' in report:
    lines+=['','## 生命体征提取','','| 处理阶段或原因 | 记录数 |','|---|---:|']
    for k,v in report['vitals'].items(): lines.append(f'| {labels.get(k,k)} | {v:,} |')
    lines+=['','## 指标覆盖情况','','覆盖率分母为全部纳入 ICU 入住；指标有至少一条保留测量即为有数据，不代表连续记录完整。','',
            '| 指标 | itemid | 测量条数 | 有数据的入住数 | 入住覆盖率 | 标记值条数 |','|---|---:|---:|---:|---:|---:|']
    for r in report['vital_coverage']:
        lines.append(f"| {labels.get(r['metric'],r['metric'])} | {r['itemid']} | {r['observations']:,} | {r['stays_with_data']:,} | {r['stays_with_data']/cohort['included_icu_stays']:.2%} | {r['flagged_observations']:,} |")
if (out/'validation.json').exists() and (out/'source_validation.json').exists():
    validation=json.loads((out/'validation.json').read_text())
    source_validation=json.loads((out/'source_validation.json').read_text())
    lines+=['','## 验证结果','',
            f"五个输入文件的 SHA-256 校验：{'全部通过' if source_validation['all_passed'] else '存在失败'}。",'',
            f"数据库与统计校验：{sum(validation['checks'].values())}/{len(validation['checks'])} 项通过。覆盖完整性、外键、纳入排除数量闭合、患者关联、年龄脱敏处理、生命体征时间范围和汇总一致性。",'']
lines+=['','## 使用口径','',
        '- 年龄为入院年份下的估计值；原始 `anchor_age=91` 的组仅标记为 90+，精确年龄留空。',
        '- ICU 入住次数、患者人数、住院次数分别计算。重复入住不作为重复病例删除。',
        '- ICU 时长由 ICU 时间计算，住院时长由医院时间计算；行政时间差异保留并标记。',
        '- 不插补缺失测量，不把测量缺失当作正常，不混合有创和无创血压。',
        '- 日期经过脱敏偏移，跨患者不使用显示年份作真实年度趋势。曲线使用入 ICU 后小时数。',
        '- 质量标记是工程展示规则，不能用于临床诊断或风险分类。',
        '- 所有阈值、去重键和完整规则见项目 README；逐条排除记录见 cohort_exclusions.csv。','',
        '## 数据来源','', '[PhysioNet MIMIC-IV 3.1](https://physionet.org/content/mimiciv/3.1/)；指标标识及单位核对本地 d_items。','']
(out/'数据清洗报告.md').write_text('\n'.join(lines))
descriptions={
 'subject_id':'脱敏患者标识；患者人数按此去重','hadm_id':'脱敏住院标识；一次住院可含多次 ICU 入住','stay_id':'脱敏 ICU 入住标识；主分析单位',
 'gender':'原始患者性别字段','anchor_age':'锚定年份年龄；91 表示超过 89 岁的脱敏组','anchor_year':'患者脱敏锚定年份','anchor_year_group':'锚定年份对应的真实年份区间',
 'dod':'脱敏死亡日期，原样保留','age_estimate':'入院年龄估计；脱敏高龄组为 NULL','age_group':'年龄分组；脱敏高龄组为 90+','age_topcoded':'是否为原始 anchor_age=91 的组',
 'first_careunit':'首次进入的 ICU 类型','last_careunit':'最后离开的 ICU 类型','admission_type':'医院入院类型','admission_location':'医院入院来源','discharge_location':'医院出院去向',
 'admittime':'医院入院时间（脱敏）','dischtime':'医院出院时间（脱敏）','deathtime':'住院记录的死亡时间（脱敏）','hospital_expire_flag':'医院住院死亡标记，不代表 ICU 内死亡',
 'intime':'ICU 入住时间（脱敏）','outtime':'ICU 离开时间（脱敏）','los':'原始 ICU 停留天数','icu_los_days':'重新计算的 ICU 停留天数','hospital_los_days':'重新计算的住院天数',
 'itemid':'指标编号；关联 d_items','label':'指标原始名称','unitname':'原始指标字典单位','category':'原始指标分类','linksto':'原始指标关联事件表',
 'metric':'系统使用的指标名称','expected_unit':'纳入测量要求的单位','observation_id':'数据库内部测量主键','charttime':'测量时间（脱敏）','storetime':'记录保存时间（脱敏）',
 'value':'原始有限数值；单位见 unit','unit':'测量单位','hours_since_icu':'测量时间距 ICU 入住的小时数','warning':'原始警告字段；不直接作为临床分类','quality_flag':'展示质量标记；NULL 为未触发规则',
 'reason':'排除/过滤原因或处理计数名称','records':'原因对应的记录数','issue':'保留入住的质量提示','key':'流水线元数据键','value':'数值或元数据值，含义随表变化',
 'observations':'保留测量条数','stays_with_data':'至少一条保留测量的 ICU 入住数','flagged_observations':'有质量标记的测量数','first_hour':'首条保留测量距入 ICU 的小时数','last_hour':'末条保留测量距入 ICU 的小时数',
 'minimum':'未标记测量的最小值','maximum':'未标记测量的最大值','mean':'未标记测量的平均值',
}
dictionary=['# SQLite 数据字典','','所有时间沿用原始脱敏时间。NULL 表示缺失或明确不可估计，不代表 0。','']
for name,sql in con.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
    dictionary += [f'## {name}','','| 字段 | 类型 | 主键 | 含义 |','|---|---|---|---|']
    for _,field,typ,notnull,default,pk in con.execute('PRAGMA table_info('+name+')'):
        description=descriptions.get(field,field)
        if field=='value' and name=='vital_observations': description='原始有限测量数值；单位见 unit'
        if field=='value' and name=='pipeline_metadata': description='流水线状态值'
        dictionary.append(f'| {field} | {typ} | {"是" if pk else ""} | {description} |')
    dictionary.append('')
(out/'数据字典.md').write_text('\n'.join(dictionary))
con.close()
print('Exported reports/数据清洗报告.md and reports/数据字典.md')
