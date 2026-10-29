"""Isolated market requests: the API can terminate a stuck upstream request."""
import contextlib
import json
import math
import sys
from datetime import datetime, timedelta, timezone


def numeric(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def fetch_eastmoney_quote(code):
    import requests
    # The stock-only AKShare wrapper assumes only codes starting with 6 are
    # Shanghai. Shanghai ETFs start with 5, so explicitly map both prefixes.
    exchange = 1 if code.startswith(('5', '6')) else 0
    fields = ['f43', 'f170', 'f60', 'f530', *[f'f{i}' for i in range(11, 41)]]
    response = requests.get('https://push2.eastmoney.com/api/qt/stock/get',
        params={'secid': f'{exchange}.{code}', 'fltt': '2', 'invt': '2', 'fields': ','.join(fields)},
        timeout=(4, 7))
    response.raise_for_status()
    data = response.json().get('data')
    if not data:
        raise ValueError('无报价数据')
    price = numeric(data.get('f43'))
    if price is None or price <= 0:
        raise ValueError('无有效价格')
    def level(price_field, volume_field):
        volume = numeric(data.get(volume_field))
        return {'price': numeric(data.get(price_field)), 'volume': volume * 100 if volume is not None else None}
    return {
        'source': '东方财富',
        'price': price, 'change_percent': numeric(data.get('f170')),
        'previous_close': numeric(data.get('f60')),
        'fetched_at': datetime.now().isoformat(timespec='seconds'),
        'bids': [level(f'f{19 - i * 2}', f'f{20 - i * 2}') for i in range(5)],
        'asks': [level(f'f{39 - i * 2}', f'f{40 - i * 2}') for i in range(5)],
    }


def fetch_tencent_quote(code):
    import requests
    prefix = 'sh' if code.startswith(('5', '6')) else 'bj' if code.startswith(('4', '8', '9')) else 'sz'
    response = requests.get(f'https://qt.gtimg.cn/q={prefix}{code}', timeout=(3, 5))
    response.raise_for_status()
    text = response.content.decode('gbk', errors='replace')
    if '="' not in text:
        raise ValueError('无报价数据')
    fields = text.split('="', 1)[1].split('"', 1)[0].split('~')
    if len(fields) < 33 or fields[2] != code:
        raise ValueError('报价数据不完整')
    price = numeric(fields[3])
    if price is None or price <= 0:
        raise ValueError('无有效价格')
    def level(index):
        volume = numeric(fields[index + 1])
        return {'price': numeric(fields[index]), 'volume': volume * 100 if volume is not None else None}
    return {
        'source': '腾讯财经', 'price': price, 'change_percent': numeric(fields[32]),
        'previous_close': numeric(fields[4]), 'fetched_at': datetime.now().isoformat(timespec='seconds'),
        'bids': [level(9 + i * 2) for i in range(5)],
        'asks': [level(19 + i * 2) for i in range(5)],
    }


def fetch_quote(code):
    try:
        return fetch_tencent_quote(code)
    except Exception:
        return fetch_eastmoney_quote(code)


def fetch_tencent_history(code):
    import requests
    prefix = 'sh' if code.startswith(('5', '6')) else 'bj' if code.startswith(('4', '8', '9')) else 'sz'
    symbol = prefix + code
    start = (datetime.now() - timedelta(days=365)).strftime('%Y-%m-%d')
    end = datetime.now().strftime('%Y-%m-%d')
    response = requests.get('https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get',
        params={'param': f'{symbol},day,{start},{end},640,'}, timeout=(3, 5))
    response.raise_for_status()
    # Only use `day`: qfqday/hfqday cannot be compared directly to raw costs.
    rows = response.json().get('data', {}).get(symbol, {}).get('day', [])
    candles = []
    for row in rows:
        if len(row) < 5 or not start <= row[0] <= end:
            continue
        candle = {'time': row[0], 'open': numeric(row[1]), 'close': numeric(row[2]),
                  'high': numeric(row[3]), 'low': numeric(row[4])}
        if all(candle[key] is not None and candle[key] > 0 for key in ('open', 'high', 'low', 'close')):
            candles.append(candle)
    if not candles:
        raise ValueError('无有效不复权历史行情')
    return sorted({item['time']: item for item in candles}.values(), key=lambda item: item['time'])


def fetch_tencent_intraday(code):
    import requests
    prefix = 'sh' if code.startswith(('5', '6')) else 'bj' if code.startswith(('4', '8', '9')) else 'sz'
    symbol = prefix + code
    response = requests.get('https://web.ifzq.gtimg.cn/appstock/app/minute/query',
        params={'code': symbol}, timeout=(3, 5))
    response.raise_for_status()
    data = response.json().get('data', {}).get(symbol, {}).get('data', {})
    day = datetime.strptime(str(data.get('date', '')), '%Y%m%d').strftime('%Y-%m-%d')
    points = {}
    for row in data.get('data', []):
        fields = row.split() if isinstance(row, str) else []
        if len(fields) < 2:
            continue
        try:
            time = datetime.strptime(day + fields[0], '%Y-%m-%d%H%M').replace(tzinfo=timezone(timedelta(hours=8)))
        except ValueError:
            continue
        price = numeric(fields[1])
        minute = time.hour * 60 + time.minute
        if price is not None and price > 0 and (570 <= minute <= 690 or 780 <= minute <= 900):
            points[int(time.timestamp())] = price
    if not points:
        raise ValueError('无有效分时行情')
    return {'intraday': [{'time': time, 'price': price} for time, price in sorted(points.items())],
            'intraday_date': day, 'intraday_fetched_at': datetime.now().isoformat(timespec='seconds')}


def run(code, kind, include_history, include_intraday=False):
    result = {'source': '公开行情 / AKShare', 'quote': None, 'history': [], 'warnings': [],
              'intraday': [], 'intraday_date': None, 'intraday_fetched_at': None}
    try:
        result['quote'] = fetch_quote(code)
        result['source'] = result['quote']['source']
        if not any(level['price'] is not None and level['price'] > 0
                   for level in result['quote']['bids'] + result['quote']['asks']):
            result['warnings'].append('五档盘口暂无可用数据')
    except Exception:
        result['warnings'].append('最新行情获取失败')
    if include_intraday:
        try:
            result.update(fetch_tencent_intraday(code))
        except Exception:
            result['warnings'].append('分时行情获取失败')
    if include_history:
        try:
            result['history'] = fetch_tencent_history(code)
            result['history_source'] = '腾讯财经 · 不复权'
        except Exception:
            try:
                result['history'] = fetch_ak_history(code, kind)
                result['history_source'] = '东方财富 · 不复权'
            except Exception:
                result['warnings'].append('历史行情获取失败')
    return result


def fetch_ak_history(code, kind):
    result = {'history': []}
    import akshare as ak
    args = {'symbol': code, 'period': 'daily', 'start_date': (datetime.now() - timedelta(days=365)).strftime('%Y%m%d'),
            'end_date': datetime.now().strftime('%Y%m%d'), 'adjust': ''}
    frame = ak.fund_etf_hist_em(**args) if kind == 'etf' else ak.stock_zh_a_hist(**args)
    for _, row in frame.iterrows():
        candle = {'time': str(row['日期'])[:10], **{key: numeric(row[col]) for key, col in
                   [('open', '开盘'), ('high', '最高'), ('low', '最低'), ('close', '收盘')]}}
        if all(candle[key] is not None and candle[key] > 0 for key in ('open', 'high', 'low', 'close')):
            result['history'].append(candle)
    result['history'] = sorted({item['time']: item for item in result['history']}.values(), key=lambda item: item['time'])
    if not result['history']:
        raise ValueError('历史行情为空')
    return result['history']


if __name__ == '__main__':
    # Some upstream helpers print progress; stdout must stay valid JSON.
    with contextlib.redirect_stdout(sys.stderr):
        response = run(sys.argv[1], sys.argv[2], sys.argv[3] == '1', len(sys.argv) > 4 and sys.argv[4] == '1')
    print(json.dumps(response, ensure_ascii=True, allow_nan=False))
