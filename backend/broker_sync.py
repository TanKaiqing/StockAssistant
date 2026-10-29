"""Reviewable, additive broker imports. Existing trades and lot metadata stay intact."""
import hashlib
import json
import re
import secrets
import sqlite3
import threading
import time
from contextlib import closing
from collections import Counter
from datetime import date, datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import broker
from .accounting import calculate, LedgerError
from .broker_trade import Confirmation, same_origin

router = APIRouter(prefix='/api/broker/sync', tags=['成交同步'], dependencies=[Depends(same_origin)])
plans = {}
plan_lock = threading.Lock()


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def kind_for(code, name):
    if re.fullmatch(r'(?:15\d{4}|5[0168]\d{4})', code) and 'ETF' in name.upper():
        return 'etf'
    if re.fullmatch(r'(?:00[0-3]\d{3}|30[01]\d{3}|60\d{4}|68[89]\d{3}|[48]\d{5}|920\d{3})', code):
        return 'stock'
    return None


def facts(row):
    return (row['code'], row['side'], row['executed_at'], str(Decimal(row['price']).normalize()), int(row['quantity']))


def finances_match(a, b):
    amount = Decimal(b['gross_amount']) if b.get('gross_amount') is not None else Decimal(b['price']) * b['quantity']
    return Decimal(a['fee']) == Decimal(b['fee']) and Decimal(a['gross_amount']) == amount


def parse_rows(rows):
    parsed, skipped = [], 0
    counts = Counter()
    executions = {}
    for row in rows:
        operation = broker.scalar(row, 'xd_2109')
        side = {'买入': 'buy', '卖出': 'sell'}.get(operation)
        if side is None:
            skipped += 1
            continue
        code, name = broker.scalar(row, 'xd_2102'), broker.scalar(row, 'xd_2103')
        if not code or not re.fullmatch(r'\d{6}', code) or not name:
            raise HTTPException(409, '历史成交缺少有效证券代码或名称，已停止同步')
        values = [broker.number(row, key) for key in ('xd_2129', 'xd_2128', 'xd_2131', 'xd_2110')]
        if any(value is None for value in values):
            raise HTTPException(409, '历史成交缺少价格、数量、成交金额或资金变动，不能推算真实费用')
        price, quantity, amount, cash = map(Decimal, values)
        fee = -cash - amount if side == 'buy' else amount - cash
        if price <= 0 or quantity <= 0 or quantity != int(quantity) or amount <= 0 or fee < 0:
            raise HTTPException(409, '历史成交金额、数量或费用无效，已停止同步')
        day = broker.scalar(row, 'xd_2141', 'xd_2104')
        clock = broker.scalar(row, 'xd_2142')
        try:
            moment = datetime.strptime(f'{day} {clock}', '%Y%m%d %H:%M:%S')
        except (ValueError, TypeError):
            try:
                moment = datetime.strptime(f'{day} {clock}', '%Y%m%d %H%M%S')
            except (ValueError, TypeError):
                raise HTTPException(409, '历史成交缺少准确成交时间，已停止同步') from None
        record = {'code': code, 'name': name[:40], 'kind': kind_for(code, name), 'side': side,
                  'executed_at': moment.isoformat(timespec='seconds'), 'price': str(price),
                  'quantity': int(quantity), 'gross_amount': str(amount), 'fee': str(fee),
                  'references': list(filter(None, (broker.scalar(row, 'xd_2135'), broker.scalar(row, 'xd_2136'))))}
        execution = broker.scalar(row, 'xd_2190')
        identity = [code, side, day, execution] if execution else [*facts(record), str(amount), str(fee)]
        key = digest(identity)
        if execution and key in executions:
            previous = executions[key]
            if facts(previous) != facts(record) or not finances_match(record, previous):
                raise HTTPException(409, '同一成交编号对应不同成交事实，已停止同步')
            continue
        if execution:
            executions[key] = record
        counts[key] += 1
        record['key'] = digest([key, counts[key]])
        parsed.append(record)
    return sorted(parsed, key=lambda row: row['executed_at']), skipped


def snapshot(connection):
    trades = [dict(row) for row in connection.execute('SELECT * FROM trades ORDER BY id')]
    instruments = [dict(row) for row in connection.execute('SELECT * FROM instruments ORDER BY code')]
    imports = [dict(row) for row in connection.execute('SELECT * FROM broker_imports ORDER BY source_key')]
    return trades, instruments, imports


def prepare(records, trades, instruments, imports):
    by_id = {row['id']: row for row in trades}
    known = {row['source_key']: row['trade_id'] for row in imports}
    instruments = {row['code']: row for row in instruments}
    used, new, output = set(), [], []
    blocked = []
    for record in records:
        candidate = dict(record)
        instrument = instruments.get(record['code'])
        if instrument:
            candidate['kind'] = instrument['kind']
        matched = by_id.get(known.get(record['key']))
        if matched is None:
            exact = [row for row in trades if row['id'] not in used and facts(row) == facts(record)]
            matched = next((row for row in exact if finances_match(record, row)), exact[0] if exact else None)
        if matched is None:
            # Old XLS import contracts and minute-only manual records are not
            # silently duplicated when their timestamps/fees differ.
            candidates = [row for row in trades if row['id'] not in used and row['code'] == record['code'] and row['side'] == record['side']
                          and row['executed_at'][:10] == record['executed_at'][:10]
                          and ((row['executed_at'].endswith(':00') and row['executed_at'][:16] == record['executed_at'][:16]
                                and row['quantity'] == record['quantity'] and Decimal(row['price']) == Decimal(record['price']))
                               or any(f'合同{ref}' in row['note'] for ref in record['references']))]
            matched = candidates[0] if candidates else None
        if matched:
            used.add(matched['id'])
            candidate['trade_id'] = matched['id']
            candidate['status'] = 'duplicate' if facts(matched) == facts(record) and finances_match(record, matched) else 'conflict'
            if candidate['status'] == 'conflict':
                blocked.append(f"{record['code']} 存在时间、价格、数量或费用不同的已有记录，请先人工核对")
        elif not candidate['kind']:
            candidate['status'] = 'unsupported'
            blocked.append(f"{record['code']} 的证券类型暂不支持自动导入")
        else:
            candidate['status'] = 'new'
            candidate['id'] = max(by_id, default=0) + len(new) + 1
            candidate['buy_lot_id'] = None
            new.append(candidate)
        output.append(candidate)
    try:
        for code in {row['code'] for row in new}:
            calculate([row for row in [*trades, *new] if row['code'] == code])
    except LedgerError as error:
        blocked.append(f'账本缺少完整买入历史：{error}')
    return output, list(dict.fromkeys(blocked))


class Range(BaseModel):
    model_config = ConfigDict(extra='forbid')
    start_date: date
    end_date: date

    @model_validator(mode='after')
    def dates(self):
        if self.start_date > self.end_date or self.end_date > date.today() or (self.end_date - self.start_date).days > 365:
            raise ValueError('请选择不晚于今天、跨度不超过一年的日期范围')
        return self


def history(request):
    rows = []
    begin = request.start_date
    while begin <= request.end_date:
        end = min(begin + timedelta(days=27), request.end_date)
        document = broker.run_tool('history-deals', {'start_date': begin.strftime('%Y%m%d'), 'end_date': end.strftime('%Y%m%d')})
        normalized = broker.normalize_query('history-deals', document)
        if normalized['is_credit']:
            raise HTTPException(409, '信用账户成交明细存在试用限制，暂不支持同步')
        rows.extend(broker.rows_from(document['data']['data'], 'rows'))
        begin = end + timedelta(days=1)
    records, skipped = parse_rows(rows)
    if any(not request.start_date <= date.fromisoformat(row['executed_at'][:10]) <= request.end_date for row in records):
        raise HTTPException(409, '券商返回的成交超出查询日期范围，已停止同步')
    return records, skipped


@router.post('/preview')
def preview(request: Range):
    from .app import db
    if not broker.query_slot.acquire(blocking=False):
        raise HTTPException(409, '同花顺正在查询，请稍后重试')
    try:
        if not broker.health_status()['ready']:
            raise HTTPException(503, '请启动并登录同花顺')
        records, skipped = history(request)
    finally:
        broker.query_slot.release()
    with db() as connection:
        state = snapshot(connection)
    rows, blocked = prepare(records, *state)
    with plan_lock:
        for key, value in list(plans.items()):
            if value['expiry'] < time.monotonic():
                del plans[key]
        if len(plans) >= 30:
            raise HTTPException(429, '同步预览过多，请稍后重试')
        ticket = secrets.token_urlsafe(32)
        plans[ticket] = {'expiry': time.monotonic() + 300, 'signature': digest(state), 'rows': rows, 'blocked': blocked}
    public_keys = ('key', 'code', 'name', 'side', 'executed_at', 'price', 'quantity', 'gross_amount', 'fee', 'status', 'trade_id')
    return {'ticket': ticket, 'rows': [{key: row[key] for key in public_keys if key in row} for row in rows],
            'new_count': sum(row['status'] == 'new' for row in rows), 'duplicate_count': sum(row['status'] == 'duplicate' for row in rows),
            'blocked': blocked, 'skipped_count': skipped, 'start_date': request.start_date.isoformat(), 'end_date': request.end_date.isoformat()}


@router.post('/apply')
def apply(confirmation: Confirmation):
    from .app import db, DB_PATH, default_stop_loss_values
    with plan_lock:
        plan = plans.pop(confirmation.ticket, None)
    if not plan or plan['expiry'] < time.monotonic():
        raise HTTPException(409, '同步预览已过期或已使用，请重新预览')
    if plan['blocked']:
        raise HTTPException(409, '预览中有待核对记录，不能写入账本')
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        if digest(snapshot(connection)) != plan['signature']:
            raise HTTPException(409, '预览后账本已发生变化，请重新预览')
        backup = DB_PATH.parent / 'backups' / f'before-broker-sync-{datetime.now():%Y%m%d-%H%M%S-%f}.sqlite3'
        backup.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(DB_PATH)) as reader, closing(sqlite3.connect(backup)) as target:
            reader.backup(target)
        inserted = 0
        codes = set()
        for row in plan['rows']:
            if row['status'] == 'new':
                connection.execute('INSERT OR IGNORE INTO instruments(code,name,kind) VALUES (?,?,?)', (row['code'], row['name'], row['kind']))
                stop_percent, stop_amount = default_stop_loss_values(connection, row['side'])
                cursor = connection.execute('''INSERT INTO trades(code,side,executed_at,price,quantity,fee,gross_amount,note,target_profit_percent,stop_loss_percent,stop_loss_amount)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)''', (row['code'], row['side'], row['executed_at'], row['price'], row['quantity'], row['fee'], row['gross_amount'], '同花顺历史成交同步',
                                                 '1' if row['side'] == 'buy' else None, stop_percent, stop_amount))
                identifier = cursor.lastrowid
                inserted += 1; codes.add(row['code'])
            else:
                identifier = row['trade_id']
            connection.execute('INSERT OR IGNORE INTO broker_imports(source_key,trade_id) VALUES (?,?)', (row['key'], identifier))
        for code in codes:
            try:
                calculate([dict(row) for row in connection.execute('SELECT * FROM trades WHERE code=?', (code,))])
            except LedgerError as error:
                raise HTTPException(409, f'导入后持仓核算失败，已回滚：{error}') from None
    return {'inserted': inserted, 'backup': backup.name}
