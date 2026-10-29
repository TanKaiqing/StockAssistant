"""Read-only security suggestions, isolated from the ledger and bounded by the API."""
import json
import re
import sys

SEARCH_PATTERN = r'^(?:[0-9]{3,6}|[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff .&()（）-]{1,39}|[0-9]{1,6}[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff .&()（）-]{0,33})$'


def parse_suggestions(text, query):
    match = re.search(r'v_hint\s*=\s*("(?:\\.|[^"\\])*")', text)
    if not match:
        raise ValueError('候选数据格式异常')
    payload = json.loads(match.group(1))
    candidates, seen = [], set()
    for item in payload.split('^'):
        fields = item.split('~')
        if len(fields) < 5:
            continue
        market, code, name, _, category = fields[:5]
        if market not in {'sh', 'sz', 'bj'} or not re.fullmatch(r'[0-9]{6}', code) or (query.isascii() and query.isdigit() and not code.startswith(query)):
            continue
        kind = 'etf' if category.endswith('ETF') else 'stock' if category == 'GP-A' else None
        if kind is None or not name.strip() or code in seen:
            continue
        seen.add(code)
        candidates.append({'code': code, 'name': name.strip()[:40], 'kind': kind})
    return candidates[:10]


def search(query):
    import requests
    if not re.fullmatch(SEARCH_PATTERN, query):
        raise ValueError('请输入 3 至 6 位代码，或至少 2 个字的名称 / 拼音')
    response = requests.get('https://smartbox.gtimg.cn/s3/', params={'q': query, 't': 'gp'}, timeout=(3, 5))
    response.raise_for_status()
    return parse_suggestions(response.text, query)


if __name__ == '__main__':
    print(json.dumps({'candidates': search(sys.argv[1])}, ensure_ascii=True))
