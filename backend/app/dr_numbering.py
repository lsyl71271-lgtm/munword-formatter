"""Context-sensitive DR numbering; mirrors app/dr-numbering.ts, one shared policy.

Only presentation changes: ordinal values, counter identities and restarts survive.
"""
import copy
import json
import re
from pathlib import Path
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

POLICY = json.loads((Path(__file__).resolve().parents[2] / 'shared/dr-numbering-policy.json').read_text(encoding='utf-8'))


def chinese(value):
    digits = POLICY['chineseDigits']
    if value < 10:
        return digits[value]
    if value < 100:
        return ('' if value < 20 else digits[value // 10]) + '十' + (digits[value % 10] if value % 10 else '')
    return ''


def _series(value, alphabet):
    if value <= len(alphabet):
        return alphabet[value - 1]
    offset = value - len(alphabet) - 1
    return alphabet[offset // len(alphabet)] + alphabet[offset % len(alphabet)] if offset < len(alphabet) ** 2 else ''


def _roman(value):
    result = ''
    for n, token in ((100,'c'),(90,'xc'),(50,'l'),(40,'xl'),(10,'x'),(9,'ix'),(5,'v'),(4,'iv'),(1,'i')):
        while value >= n:
            result += token
            value -= n
    return result


def _value(text, renderer, limit=99):
    return next((n for n in range(1, limit + 1) if renderer(n) == text), None)


def marker_of(text, roman_context=False):
    article = re.match(r'\s*第([零一二三四五六七八九十]+)条', text)
    if article:
        value = _value(article[1], chinese)
        return dict(family='article', value=value, length=article.end()) if value else None
    match = re.match(r'\s*(?:[（(]([^（）()\s]+)[）)]|([0-9]+|[a-zA-Z]+)[.．、)）])', text)
    if not match:
        return None
    token, paren = match[1] or match[2], bool(match[1])
    value, family = None, ''
    if token.isascii() and token.isdigit():
        family, value = ('paren-decimal' if paren else 'decimal'), int(token)
    else:
        for name, renderer, limit in [('chinese',chinese,99),('zodiac',lambda n:_series(n,POLICY['zodiac']),156),('stem',lambda n:_series(n,POLICY['stems']),110)]:
            value = _value(token, renderer, limit)
            if value is not None:
                family = name
                break
        if not family:
            roman_value = _value(token.lower(), _roman)
            if re.fullmatch('[a-zA-Z]', token) and not (roman_context and roman_value):
                family, value = 'letter', ord(token.lower()) - 96
            elif roman_value:
                family, value = ('roman' if paren else 'roman-dot'), roman_value
    return dict(family=family,value=value,length=match.end()) if family and value and value < 100 else None


def marker_text(language, level, value):
    if not 0 <= level < 4 or not 0 < value < 100:
        return None
    target = POLICY['formats'][language][level]
    family = target['family']
    token = chinese(value) if family in ('article','chinese') else _series(value,POLICY['zodiac']) if family == 'zodiac' else _series(value,POLICY['stems']) if family == 'stem' else (chr(96+value) if value <= 26 else '') if family == 'letter' else _roman(value) if family.startswith('roman') else str(value)
    return target['text'].replace('%n',token) if token else None


def plan_hierarchy(items, language):
    ranks, identities, ambiguous, parent, active, result = {}, {}, {}, None, False, []
    for item in items:
        if item.get('top'):
            ranks.clear()
            identities.clear()
            ambiguous.clear()
            active, parent = True, 0 if item['text'].rstrip().endswith(('：',':')) else None
            result.append(dict(level=0,reason=''))
            continue
        if not item['family']:
            parent = None
            result.append(dict(level=item['level'],reason=''))
            continue
        if not active:
            result.append(dict(level=item['level'],reason='无明确顶层条款，不能确定编号层级'))
            continue
        canonical = POLICY['defaultLevels'].get(item['family'],item['level'])
        known_family = item['family'] in ranks
        level = identities.get(item['key']) if item.get('key') else ranks.get(item['family'])
        reason = ''
        if level is None:
            level = ranks.get(item['family'],canonical)
            if parent is not None and (canonical <= 1 or item.get('key')):
                level = parent + 1
            if parent is None and not known_family and level in ranks.values():
                reason = '不同编号系列占用同一层级，但缺少明确父子关系'
            if not known_family:
                ranks[item['family']] = level
            if item.get('key'):
                identities[item['key']] = level
        elif parent is not None and parent == level:
            reason = '相同编号系列既作父项又作子项，层级证据冲突'
        if level > 3:
            reason = '超过学标示例的四级层次，不能安全转换'
        if language == 'zh' and item['family'] == 'zodiac' and not known_family and 'stem' in ranks:
            reason = '地支与天干系列交错，疑似编号错字或层级冲突'
        key = item.get('key') or item['family']
        if reason:
            ambiguous[key] = reason
        reason = reason or ambiguous.get(key,'')
        parent = level if item['text'].rstrip().endswith(('：',':')) else None
        result.append(dict(level=item['level'] if reason else level,reason=reason))
    return result


def valid_marker_change(before, after):
    def tail(text, marker):
        return re.sub(r'[，,；;。.:：、 \t]+$', '', text[marker['length']:])
    old = marker_of(before)
    return bool(old and any(b and old['value'] == b['value'] and tail(before,old) == tail(after,b)
                           for b in (marker_of(after),marker_of(after,True))))


def _val(node, attr='val'):
    return node.get(qn('w:'+attr),'') if node is not None else ''


def native_level(xml, identifier, ilvl):
    num = next((n for n in xml.findall(qn('w:num')) if _val(n,'numId') == identifier), None)
    if num is None:
        return None
    override = next((n for n in num.findall(qn('w:lvlOverride')) if _val(n,'ilvl') == ilvl), None)
    own = override.find(qn('w:lvl')) if override is not None else None
    if own is not None:
        return own
    abstract = next((n for n in xml.findall(qn('w:abstractNum')) if _val(n,'abstractNumId') == _val(num.find(qn('w:abstractNumId')))), None)
    return next((n for n in abstract.findall(qn('w:lvl')) if _val(n,'ilvl') == ilvl), None) if abstract is not None else None


def native_family(xml, identifier, ilvl):
    lvl = native_level(xml,identifier,ilvl)
    if lvl is None:
        return ''
    text = _val(lvl.find(qn('w:lvlText')))
    if '第%' in text and '条' in text:
        return 'article'
    family = POLICY['nativeFamilies'].get(_val(lvl.find(qn('w:numFmt'))),'')
    return 'paren-decimal' if family == 'decimal' and text.startswith(('（','(')) else 'roman-dot' if family == 'roman' and not text.startswith(('（','(')) else family


def native_range_reason(xml, rule, count):
    target = POLICY['formats'][rule['language']][rule['level']]
    limit = len(POLICY['zodiac']) if target['family'] == 'zodiac' else len(POLICY['stems']) if target['family'] == 'stem' else None
    if limit is None:
        return ''
    num = next((n for n in xml.findall(qn('w:num')) if _val(n,'numId') == rule['id']), None)
    override = next((n for n in num.findall(qn('w:lvlOverride')) if _val(n,'ilvl') == rule['ilvl']), None) if num is not None else None
    lvl = native_level(xml,rule['id'],rule['ilvl'])
    raw = _val(override.find(qn('w:startOverride')) if override is not None else None) or _val(lvl.find(qn('w:start')) if lvl is not None else None) or '1'
    try:
        start = int(raw)
    except ValueError:
        start = 0
    return '原生编号超过地支/天干单字范围，Word 循环格式不能安全表达学标的扩展编号' if start < 1 or start + count - 1 > limit else ''


def apply_native_rules(xml, rules):
    for rule in rules:
        identifier, ilvl = rule['id'], rule['ilvl']
        num = next((n for n in xml.findall(qn('w:num')) if _val(n,'numId') == identifier), None)
        original = native_level(xml,identifier,ilvl)
        target = POLICY['formats'][rule['language']][rule['level']]
        if num is None or original is None or original.find(qn('w:numFmt')) is None or original.find(qn('w:lvlText')) is None or not native_family(xml,identifier,ilvl):
            raise ValueError('不能证明原生编号的转换规则')
        placeholder = '%'+str(int(ilvl)+1)
        if ''.join(re.findall(r'%[1-9]',_val(original.find(qn('w:lvlText'))))) != placeholder or original.find(qn('w:isLgl')) is not None:
            raise ValueError('复合编号或法律编号需人工确认')
        desired = target['text'].replace('%n',placeholder)
        if _val(original.find(qn('w:numFmt'))) == target['fmt'] and _val(original.find(qn('w:lvlText'))) == desired:
            continue
        override = next((n for n in num.findall(qn('w:lvlOverride')) if _val(n,'ilvl') == ilvl), None)
        if override is None:
            override = OxmlElement('w:lvlOverride')
            override.set(qn('w:ilvl'),ilvl)
            num.append(override)
        level = override.find(qn('w:lvl'))
        if level is None:
            level = copy.deepcopy(original)
            override.append(level)
        level.find(qn('w:numFmt')).set(qn('w:val'),target['fmt'])
        level.find(qn('w:lvlText')).set(qn('w:val'),desired)
