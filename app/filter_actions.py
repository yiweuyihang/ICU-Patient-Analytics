"""Bounded, read-only filter proposals. Model output never becomes SQL or code."""
import hashlib
import json
import math
import re

ACTION_KEYS = ('age', 'gender', 'unit', 'los_min', 'los_max')
ACTION_AGES = ('18-39', '40-64', '65-79', '80-89', '90+', '65+')
UNIT_ALIASES = {
    'MICU':'Medical Intensive Care Unit (MICU)',
    'MICU/SICU':'Medical/Surgical Intensive Care Unit (MICU/SICU)',
    'SICU':'Surgical Intensive Care Unit (SICU)',
    'CVICU':'Cardiac Vascular Intensive Care Unit (CVICU)',
    'CCU':'Coronary Care Unit (CCU)',
    'TSICU':'Trauma SICU (TSICU)',
    'Neuro SICU':'Neuro Surgical Intensive Care Unit (Neuro SICU)',
    '内科ICU':'Medical Intensive Care Unit (MICU)',
    '外科ICU':'Surgical Intensive Care Unit (SICU)',
    '内外科ICU':'Medical/Surgical Intensive Care Unit (MICU/SICU)',
    '心脏血管ICU':'Cardiac Vascular Intensive Care Unit (CVICU)',
    '冠心病ICU':'Coronary Care Unit (CCU)',
    '创伤外科ICU':'Trauma SICU (TSICU)',
}

class FilterActionError(ValueError):
    pass

def normalize_changes(changes, units):
    if not isinstance(changes, dict) or not changes or set(changes)-set(ACTION_KEYS):
        raise FilterActionError('筛选建议仅支持年龄组、性别、ICU 类型和停留天数，请明确这些条件。')
    normalized = {}
    unit_names = {unit.casefold():unit for unit in units}
    unit_names.update({alias.casefold():name for alias,name in UNIT_ALIASES.items() if name in units})
    for key, value in changes.items():
        if value is None or value == '':
            normalized[key] = None
        elif key in ('los_min','los_max'):
            if isinstance(value, bool) or not isinstance(value, (str,int,float)):
                raise FilterActionError('停留天数必须是有限的非负数字。')
            try:
                number = float(value)
            except (ValueError,TypeError,OverflowError):
                raise FilterActionError('停留天数必须是有限的非负数字。') from None
            if not math.isfinite(number) or not 0 <= number <= 100000:
                raise FilterActionError('停留天数必须在 0–100000 天之间。')
            normalized[key] = format(number,'.15g')
        elif key == 'age':
            if not isinstance(value,str) or value not in ACTION_AGES:
                raise FilterActionError('年龄仅支持 18–39、40–64、65–79、80–89、90+ 和 65 岁及以上，请确认希望使用的年龄组。')
            normalized[key] = value
        elif key == 'gender':
            if value not in ('F','M'):
                raise FilterActionError('性别筛选仅支持女性、男性或取消限制。')
            normalized[key] = value
        else:
            if not isinstance(value,str) or value.casefold() not in unit_names:
                raise FilterActionError('未能识别该 ICU 类型，请使用页面下拉框中的类型名称。')
            normalized[key] = unit_names[value.casefold()]
    return normalized

def check_wording(question, changes, target):
    """Reject common expressions that cannot be represented by these controls."""
    compact = re.sub(r'\s+','',question).replace('–','-').replace('—','-')
    compact = re.sub(r'(\d+)(岁)?(?:至|到)(\d+)',r'\1\2-\3',compact)
    if re.search(r'\d+岁|年龄',compact):
        unsupported = re.findall(r'(\d+)岁(?:及以上|以上|及以下|以下|及以内|以内|起)',compact)
        if any(number not in ('65','90') for number in unsupported):
            raise FilterActionError('该年龄阈值无法由现有年龄组选项精确表示，请改用页面支持的年龄组。')
        if re.search(r'\d+岁(?:及以下|以下|及以内|以内)',compact):
            raise FilterActionError('该年龄上限不能由一个现有年龄组精确表示，请确认希望选择的年龄组。')
        thresholds = re.findall(r'(?:至少|不少于|大于等于|>=|≥)(\d+)岁',compact)
        if any(value not in ('65','90') for value in thresholds):
            raise FilterActionError('该年龄阈值无法由现有年龄组选项精确表示，请改用页面支持的年龄组。')
        if re.search(r'\d+-\d+(?:岁)?(?:和|或|与|、)\d+-\d+岁',compact):
            raise FilterActionError('目前一次只能选择一个年龄组，请先确认要查看的年龄组。')
        if re.search(r'(?:大于|超过|小于|不到|不满)\d+岁',compact):
            raise FilterActionError('该精确年龄边界无法由现有年龄组表示，请确认希望选择的年龄组。')
        ranges = re.findall(r'(\d+)(?:岁)?-(\d+)岁',compact)
        if ranges and any(a+'-'+b not in ACTION_AGES for a,b in ranges):
            raise FilterActionError('该年龄区间不能由一个现有年龄组精确表示，请确认希望选择的年龄组。')
        if ranges and target.get('age') not in {a+'-'+b for a,b in ranges}:
            raise FilterActionError('识别出的年龄组与问题不一致，请重新描述年龄条件。')
        if '65岁' in compact and re.search(r'65岁(?:及以上|以上|起)',compact) and target.get('age') != '65+':
            raise FilterActionError('问题中的 65 岁及以上应包含高龄脱敏组，请重新生成筛选建议。')
        if '90岁' in compact and re.search(r'90岁(?:及以上|以上|起)',compact) and target.get('age') != '90+':
            raise FilterActionError('识别出的高龄组与问题不一致，请重新生成筛选建议。')
    if not re.search(r'取消|清除|不限|不限制',question):
        female = bool(re.search(r'女性|女患者|女病人',question))
        male = bool(re.search(r'男性|男患者|男病人',question))
        if female != male and target.get('gender') != ('F' if female else 'M'):
            raise FilterActionError('识别出的性别与问题不一致，请重新描述筛选条件。')
    if re.search(r'\d+(?:\.\d+)?天',compact):
        if re.search(r'(?<!不)(?:超过|大于)(?!等于)\d+(?:\.\d+)?天|(?<![<>=])>(?!=)\d+(?:\.\d+)?天',compact):
            raise FilterActionError('页面停留下限包含边界。“超过”请先确认是否按“至少”该天数筛选。')
        if re.search(r'(?:不超过|不大于|至多|最多|小于等于|≤|<=)\d+(?:\.\d+)?天',compact):
            raise FilterActionError('页面停留上限不包含边界。“最多”请先确认是否改为“小于”该天数。')
        if not re.search(r'取消|清除|不限|不限制',question):
            lower = re.findall(r'(?:至少|不少于|大于等于|>=|≥)(\d+(?:\.\d+)?)天',compact)
            lower += re.findall(r'(\d+(?:\.\d+)?)天(?:及以上|以上|起)',compact)
            upper = re.findall(r'(?<!不)(?:少于|不足|小于|<)(\d+(?:\.\d+)?)天',compact)
            for key, values in [('los_min',lower),('los_max',upper)]:
                if values and (key not in target or float(target[key])!=float(values[-1])):
                    raise FilterActionError('识别出的停留天数与问题不一致，请重新描述筛选条件。')
    if re.search(r'(?:MICU|SICU|CVICU|CCU|TSICU)\s*(?:和|或|与|、|and|or)\s*(?:MICU|SICU|CVICU|CCU|TSICU)',question,re.I):
        raise FilterActionError('目前一次只能选择一个 ICU 类型，请分别筛选，或使用页面的 A/B 对比。')
    return changes

def prepare_filter_action(raw, base_filters, units, question=''):
    if raw is None:
        return None
    if not isinstance(raw,dict) or set(raw)-{'changes','reason'}:
        raise FilterActionError('筛选建议格式不完整，请重试。')
    if not isinstance(base_filters,dict) or set(base_filters)-set(ACTION_KEYS)-{'search'} or any(not isinstance(v,str) for v in base_filters.values()):
        raise FilterActionError('当前筛选格式不合法。')
    reason = raw.get('reason','按你的问题准备筛选条件。')
    if not isinstance(reason,str) or len(reason)>300:
        raise FilterActionError('筛选说明格式不完整，请重试。')
    changes = normalize_changes(raw.get('changes'),units)
    base = {k:v for k,v in base_filters.items() if v != ''}
    target = dict(base)
    for key,value in changes.items():
        if value is None:
            target.pop(key,None)
        else:
            target[key] = value
    check_wording(question,changes,target)
    try:
        lower = float(target.get('los_min',0))
        upper = float(target['los_max']) if 'los_max' in target else None
    except (ValueError,TypeError):
        raise FilterActionError('停留天数格式不正确。') from None
    if upper is not None and upper <= lower:
        raise FilterActionError('停留时长上限必须大于下限，请调整区间。')
    # Drop no-op patches; a card always describes a real change to this base.
    changes = {k:v for k,v in changes.items() if base.get(k) != target.get(k)}
    if not changes:
        raise FilterActionError('这些条件与当前筛选一致，无需再次应用，可以直接继续提问。')
    fingerprint = json.dumps({'base':base,'changes':changes},sort_keys=True,ensure_ascii=False)
    return {'version':1,'id':hashlib.sha256(fingerprint.encode()).hexdigest()[:20],
            'changes':changes,'base_filters':base,'filters':target,
            'reason':reason.strip() or '按你的问题准备筛选条件。','question':question}

def proposal_from_reply(content):
    clean = content.strip()
    if clean.startswith('```') and clean.endswith('```'):
        clean = clean.split('\n',1)[1].rsplit('```',1)[0].strip()
    try:
        value = json.loads(clean)
    except (ValueError,TypeError):
        return None
    return value.get('filter_action') if isinstance(value,dict) else None
