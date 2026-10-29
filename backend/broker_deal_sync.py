"""Atomic order-group imports retaining verified individual fill identities."""
import json
import secrets
import sqlite3
import threading
import time
from collections import Counter
from contextlib import closing
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP, localcontext
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .accounting import calculate, LedgerError
from .broker_sync import digest, facts, kind_for
from .broker_trade import same_origin
from .broker_lot_links import order_key, find_intent, check_fill, bind_manual

router = APIRouter(prefix='/api/broker/sync', tags=['成交同步'], dependencies=[Depends(same_origin)])
snapshots = {}
snapshot_lock = threading.Lock()


def initialize(connection):
    connection.execute('''CREATE TABLE IF NOT EXISTS broker_t_order_settings (
        order_group TEXT PRIMARY KEY, t_trade INTEGER NOT NULL CHECK(t_trade IN (0,1)), target_price TEXT)''')
    connection.execute('''CREATE TABLE IF NOT EXISTS broker_deal_metadata (
        source_key TEXT PRIMARY KEY REFERENCES broker_imports(source_key) ON DELETE CASCADE,
        order_group TEXT, estimated INTEGER NOT NULL CHECK(estimated IN (0,1)),
        saved_fee TEXT NOT NULL, saved_facts TEXT NOT NULL)''')
    connection.execute('CREATE INDEX IF NOT EXISTS deal_metadata_order ON broker_deal_metadata(order_group)')


def attach_actions(result, native_rows):
    """Keep native identifiers private; the browser receives opaque action tokens."""
    from .app import db
    with db() as connection:
        known = {row['source_key']: dict(row) for row in connection.execute(
            'SELECT broker_imports.source_key,trades.* FROM broker_imports JOIN trades ON trades.id=broker_imports.trade_id')}
        intents = {row['order_key']: dict(row) for row in connection.execute('SELECT * FROM broker_order_intents WHERE order_key IS NOT NULL')}
        t_settings = {row['order_group']: dict(row) for row in connection.execute('SELECT * FROM broker_t_order_settings')}
        linked_sells = {row['sell_id'] for row in connection.execute('SELECT DISTINCT sell_id FROM t_buyback_links')}
    counts = Counter()
    now = time.monotonic()
    with snapshot_lock:
        groups = {}
        for token, value in list(snapshots.items()):
            if value['expiry'] < now:
                del snapshots[token]
        for row, native in zip(result['rows'], native_rows):
            row['sync_token'] = None
            if result['is_credit']:
                row['sync_reason'] = '暂不支持信用账户成交同步'
                continue
            try:
                moment = datetime.fromisoformat(f"{row['date']}T{row['time']}")
                price, quantity, amount = (Decimal(row[key]) for key in ('price', 'quantity', 'amount'))
                if (moment.date() != date.today() or row['side'] not in ('buy', 'sell')
                        or not row['code'] or not row['name'] or not price.is_finite()
                        or not quantity.is_finite() or not amount.is_finite()
                        or price <= 0 or amount <= 0 or quantity <= 0 or quantity != int(quantity)):
                    raise ValueError()
            except (ValueError, TypeError, ArithmeticError):
                row['sync_reason'] = '成交信息不完整，请通过历史成交同步'
                continue
            record = {'code': row['code'], 'name': row['name'][:40],
                      'kind': kind_for(row['code'], row['name']), 'side': row['side'],
                      'executed_at': moment.isoformat(timespec='seconds'), 'price': str(price),
                      'quantity': int(quantity), 'gross_amount': str(amount), 'fee': row['fee']}
            # A fill ID differs from a contract/order ID: partial fills must stay separate.
            execution = str(native.get('cjbh') or '').strip()
            if execution == '0':
                execution = ''
            identity = [record['code'], record['side'], row['date'], str(execution)] if execution else list(facts(record))
            base = digest(identity)
            counts[base] += 1
            record['key'] = 'daily:' + digest([base, 1 if execution else counts[base]])
            record['order_key'] = order_key(record['code'], row['date'], native.get('htbh') or native.get('wtbh'))
            record['order_group'] = digest([record['order_key'], record['side']]) if record['order_key'] and execution else None
            previous = known.get(record['key'])
            row['synced'] = bool(previous and fingerprint(previous) == fingerprint(record))
            intent = intents.get(record['order_key']) if record['side'] == 'sell' else None
            setting = t_settings.get(canonical_group(record))
            row['t_trade'] = bool(previous['t_trade']) if row['synced'] else bool(setting['t_trade']) if setting else bool(intent and intent.get('t_trade'))
            row['has_t_links'] = bool(previous and previous['id'] in linked_sells)
            row['buy_lot_id'] = previous.get('buy_lot_id') if row['synced'] else intent['buy_lot_id'] if intent else None
            row['lot_allocations'] = json.loads(previous['lot_allocations']) if row['synced'] and previous.get('lot_allocations') else None
            row['needs_lot_selection'] = record['side'] == 'sell' and not intent and not row['synced']
            if len(snapshots) >= 5000:
                row['sync_reason'] = '同步快照过多，请稍后刷新'
                continue
            token = secrets.token_urlsafe(32)
            snapshots[token] = {'expiry': now + 600, 'record': record}
            row['sync_token'] = token
            row['sync_reason'] = None
            key = record['order_group'] or record['key']
            groups.setdefault(key, []).append((row, record))
        result['order_groups'] = []
        for group_id, entries in groups.items():
            unique, conflict = {}, False
            for row, record in entries:
                previous = unique.get(record['key'])
                if previous and (facts(previous[1]) != facts(record)
                        or previous[1]['gross_amount'] != record['gross_amount'] or previous[1]['fee'] != record['fee']):
                    conflict = True
                unique[record['key']] = (row, record)
            entries = sorted(unique.values(), key=lambda item: (item[1]['executed_at'], item[1]['key']))
            records = [record for _, record in entries]
            first = entries[-1][0]
            quantity = sum(record['quantity'] for record in records)
            amount = sum((Decimal(record['gross_amount']) for record in records), Decimal(0))
            pending = [record['key'] for row, record in entries if not row['synced']]
            token = secrets.token_urlsafe(32) if not conflict and len(snapshots) < 5000 else None
            if token:
                snapshots[token] = {'expiry': now + 600, 'records': records, 'pending': pending}
            ids = {row['buy_lot_id'] for row, _ in entries if not row['synced']}
            result['order_groups'].append({**first, 'id': group_id, 'sync_token': token,
                'sync_reason': '同一成交编号存在冲突，请先核对券商数据' if conflict else '同步快照过多，请刷新后重试' if not token else None,
                'quantity': str(quantity), 'amount': str(amount), 'price': str(amount / quantity),
                'fee': str(sum((Decimal(record['fee']) for record in records), Decimal(0)))
                    if all(record['fee'] is not None for record in records) else None,
                'synced': not pending, 'sync_quantity': sum(record['quantity'] for row, record in entries if not row['synced']),
                'buy_lot_id': next(iter(ids)) if len(ids) == 1 else None,
                'lot_allocations': None if pending else first.get('lot_allocations'),
                't_trade': all(row.get('t_trade', False) for row, _ in entries),
                't_mixed': len({row.get('t_trade', False) for row, _ in entries}) > 1,
                'has_t_links': any(row.get('has_t_links', False) for row, _ in entries),
                'rows': [row for row, _ in entries], 'grouped': bool(records[0]['order_group'])})
        # Unsupported rows remain visible, but cannot be imported as a group.
        for row in result['rows']:
            if not row.get('sync_token'):
                result['order_groups'].append({**row, 'id': f"unsupported:{row['id']}", 'rows': [row], 'grouped': False})


class DealAllocation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    buy_id: int = Field(gt=0, strict=True)
    quantity: int = Field(gt=0, le=1_000_000_000, strict=True)


class DealSelection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    token: str = Field(min_length=20, max_length=100)
    allocation: Literal['auto', 'manual', 'fifo', 'split'] = 'auto'
    buy_lot_id: int | None = Field(default=None, gt=0, strict=True)
    allocations: list[DealAllocation] = Field(default_factory=list, max_length=200)

    @model_validator(mode='after')
    def validate_allocations(self):
        if self.allocation == 'split':
            if self.buy_lot_id is not None or len(self.allocations) < 2:
                raise ValueError('多批次分摊至少选择两个批次，不能同时指定单个批次')
            if len({item.buy_id for item in self.allocations}) != len(self.allocations):
                raise ValueError('分摊批次不能重复')
        elif self.allocations:
            raise ValueError('只有多批次分摊可以填写分摊明细')
        return self


def import_record(connection, record, request, *, bind_order=True):
    from .app import commission_fee, fee_settings, default_stop_loss_values
    trades = [dict(row) for row in connection.execute('SELECT * FROM trades WHERE code=? ORDER BY id', (record['code'],))]
    known = connection.execute('SELECT trade_id FROM broker_imports WHERE source_key=?', (record['key'],)).fetchone()
    matched = next((row for row in trades if known and row['id'] == known['trade_id']), None)
    if known and (not matched or facts(matched) != facts(record)):
        raise HTTPException(409, '这笔成交的已有记录已被修改，请先核对账本')
    if not known:
        claimed = {row['trade_id'] for row in connection.execute("SELECT trade_id FROM broker_imports WHERE source_key LIKE 'daily:%'")}
        matches = [row for row in trades if row['id'] not in claimed and facts(row) == facts(record)]
        if len(matches) > 1:
            raise HTTPException(409, '账本中存在多笔同时间、同价格、同数量记录，请先核对，不能自动选择其中一笔')
        matched = matches[0] if matches else None
    intent = find_intent(connection, record)
    lot_id = intent['buy_lot_id'] if intent else None
    if record['side'] == 'buy':
        if request.buy_lot_id is not None or request.allocation != 'auto':
            raise HTTPException(422, '买入成交不需要选择卖出成本批次')
    elif request.allocation == 'manual':
        if request.buy_lot_id is None:
            raise HTTPException(422, '请选择买入批次')
        if intent and lot_id != request.buy_lot_id:
            raise HTTPException(409, '所选批次与原卖出委托关联不一致，请先人工核对')
        lot_id = request.buy_lot_id
    elif request.allocation == 'fifo':
        if request.buy_lot_id is not None:
            raise HTTPException(422, '先进先出不能同时指定买入批次')
        if intent:
            raise HTTPException(409, '这笔委托已关联买入批次，不能改用先进先出')
    elif request.allocation == 'split':
        if intent:
            raise HTTPException(409, '这笔委托已关联单个买入批次，不能改为多批次分摊')
        if sum(item.quantity for item in request.allocations) != record['quantity']:
            raise HTTPException(422, '分摊数量合计必须等于本笔成交数量')
        record['lot_allocations'] = json.dumps([item.model_dump() for item in request.allocations])
    elif request.buy_lot_id is not None:
        raise HTTPException(422, '请使用手动批次选择方式')
    elif record['side'] == 'sell' and not intent and not matched:
        raise HTTPException(409, '无法通过委托号自动关联，请选择买入批次或明确选择先进先出')
    if matched:
        if request.allocation == 'split':
            previous = json.loads(matched['lot_allocations']) if matched.get('lot_allocations') else []
            wanted = [item.model_dump() for item in request.allocations]
            if sorted(previous, key=lambda item: item['buy_id']) != sorted(wanted, key=lambda item: item['buy_id']):
                raise HTTPException(409, '账本已有这笔成交且分摊方式不同，请在交易记录中核对，不会重复导入')
        if record['side'] == 'sell' and (intent or request.allocation != 'auto') and matched.get('buy_lot_id') != lot_id:
            raise HTTPException(409, '已有卖出记录的成本批次不同，请在交易记录中核对并编辑，不会重复导入')
        if bind_order and not intent and request.allocation == 'manual':
            intent = bind_manual(connection, record, lot_id)
        check_fill(connection, intent, record, matched['id'])
        if intent and intent.get('t_trade'):
            connection.execute('UPDATE trades SET t_trade=1,t_buyback_price=? WHERE id=?', (intent.get('t_buyback_price'), matched['id']))
        apply_t_settings(connection, record, intent, matched['id'])
        connection.execute('INSERT OR IGNORE INTO broker_imports(source_key,trade_id) VALUES (?,?)', (record['key'], matched['id']))
        return {'inserted': False, 'trade_id': matched['id'], 'message': '账本已有这笔成交', 'estimated_fee': False}
    # Minute-only manual entries require review instead of silent duplication.
    imported_ids = {row['trade_id'] for row in connection.execute('SELECT trade_id FROM broker_imports')}
    if any(row['id'] not in imported_ids and row['executed_at'].endswith(':00') and row['executed_at'][:16] == record['executed_at'][:16]
           and row['side'] == record['side'] and row['quantity'] == record['quantity']
           and Decimal(row['price']) == Decimal(record['price']) for row in trades):
        raise HTTPException(409, '账本中有同分钟的相似记录，请先核对成交时间，避免重复同步')
    instrument = connection.execute('SELECT kind FROM instruments WHERE code=?', (record['code'],)).fetchone()
    kind = instrument['kind'] if instrument else record['kind']
    if not kind:
        raise HTTPException(409, '证券类型暂不支持自动识别，请先添加标的')
    estimated = record.get('estimated_fee', record['fee'] is None)
    if record['fee'] is None:
        record['fee'] = str(commission_fee(Decimal(record['price']), record['quantity'], fee_settings(connection)[kind]))
    if lot_id is not None and not any(row['id'] == lot_id and row['side'] == 'buy' for row in trades):
        raise HTTPException(409, '关联买入批次已删除或与证券不匹配，请先核对账本')
    if bind_order and not intent and request.allocation == 'manual':
        intent = bind_manual(connection, record, lot_id)
    check_fill(connection, intent, record)
    staged = {**record, 'id': max((row['id'] for row in trades), default=0) + 1, 'buy_lot_id': lot_id}
    try:
        calculate([*trades, staged])
    except LedgerError as error:
        raise HTTPException(409, f'账本缺少可卖出的买入记录，请先同步买入：{error}') from None
    connection.execute('INSERT OR IGNORE INTO instruments(code,name,kind) VALUES (?,?,?)', (record['code'], record['name'], kind))
    split_note = f'；多批次分摊 {len(request.allocations)} 个批次' if request.allocation == 'split' else ''
    note = '同花顺当日成交同步' + (f'；关联买入批次 #{lot_id}' if lot_id else '') + split_note + ('；手续费按费率设置估算，结算后请核对' if estimated else '')
    stop_percent, stop_amount = default_stop_loss_values(connection, record['side'])
    cursor = connection.execute('''INSERT INTO trades(code,side,executed_at,price,quantity,fee,gross_amount,note,target_profit_percent,buy_lot_id,lot_allocations,stop_loss_percent,stop_loss_amount)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''', (record['code'], record['side'], record['executed_at'], record['price'],
                                    record['quantity'], record['fee'], record['gross_amount'], note,
                                    '1' if record['side'] == 'buy' else None, lot_id, record.get('lot_allocations'), stop_percent, stop_amount))
    check_fill(connection, intent, record, cursor.lastrowid)
    if intent and intent.get('t_trade'):
        connection.execute('UPDATE trades SET t_trade=1,t_buyback_price=? WHERE id=?', (intent.get('t_buyback_price'), cursor.lastrowid))
    apply_t_settings(connection, record, intent, cursor.lastrowid)
    connection.execute('INSERT INTO broker_imports(source_key,trade_id) VALUES (?,?)', (record['key'], cursor.lastrowid))
    return {'inserted': True, 'trade_id': cursor.lastrowid, 'estimated_fee': estimated,
            'message': '已同步到交易记录' + (f'，指定买入批次 #{lot_id}' if lot_id else '')
            + (f'，已分摊至 {len(request.allocations)} 个批次' if request.allocation == 'split' else '')
        + ('，手续费为估算值' if estimated else '')}


def canonical_group(record):
    return f"{record['code']}:{record['side']}:{record['executed_at'][:10]}:{record.get('order_group') or record['key']}"


def apply_t_settings(connection, record, intent, trade_id):
    setting = connection.execute('SELECT * FROM broker_t_order_settings WHERE order_group=?',
                                 (canonical_group(record),)).fetchone()
    if not setting and intent:
        setting = connection.execute('SELECT * FROM broker_t_order_settings WHERE order_group=?',
            (f"{record['code']}:{record['side']}:{record['executed_at'][:10]}:intent:{intent['id']}",)).fetchone()
    if setting:
        connection.execute('UPDATE trades SET t_trade=?,t_buyback_price=? WHERE id=?',
            (setting['t_trade'], setting['target_price'], trade_id))


def fingerprint(record):
    amount = record.get('gross_amount')
    if amount is None:
        amount = Decimal(record['price']) * record['quantity']
    return digest([*facts(record), str(Decimal(amount).normalize())])


def prepare_fees(connection, records):
    """Reprice only our unchanged estimates; preserve manual and actual costs."""
    from .app import fee_settings
    rules = fee_settings(connection)
    groups, saved = {}, {}
    for record in records:
        group_id = record.get('order_group') or record['key']
        groups.setdefault(group_id, {})[record['key']] = dict(record)
    for group_id, members in groups.items():
        for row in connection.execute('''SELECT t.*,m.source_key,m.estimated,m.saved_fee,m.saved_facts
            FROM broker_deal_metadata m JOIN broker_imports i ON i.source_key=m.source_key
            JOIN trades t ON t.id=i.trade_id WHERE m.order_group=?''', (group_id,)):
            item = dict(row)
            if fingerprint(item) != item['saved_facts'] or Decimal(item['fee']) != Decimal(item['saved_fee']):
                raise HTTPException(409, '同委托已同步记录被修改，无法自动重分摊手续费，请先核对账本')
            saved[item['source_key']] = item
            members.setdefault(item['source_key'], {**item, 'key': item['source_key'],
                'order_group': group_id, 'fee': None if item['estimated'] else item['fee']})
        for key, record in members.items():
            existing = connection.execute('''SELECT t.* FROM broker_imports i JOIN trades t ON t.id=i.trade_id
                WHERE i.source_key=?''', (key,)).fetchone()
            if existing:
                existing = dict(existing)
                if fingerprint(existing) != fingerprint(record):
                    raise HTTPException(409, '同委托成交事实与已同步记录不一致，请核对后再同步')
                saved.setdefault(key, existing)
        values = sorted(members.values(), key=lambda item: (item['executed_at'], item['key']))
        provided = [item for item in values if item['fee'] is not None]
        missing = [item for item in values if item['fee'] is None]
        if provided and missing:
            raise HTTPException(409, '同委托部分成交缺少费用，不能可靠分摊，请通过历史成交同步核对实际费用')
        if provided:
            for item in provided:
                item['estimated_fee'] = False
            continue
        total_amount = sum((Decimal(item['gross_amount']) if item.get('gross_amount') is not None
            else Decimal(item['price']) * item['quantity'] for item in values), Decimal(0))
        owner = connection.execute('SELECT kind FROM instruments WHERE code=?', (values[0]['code'],)).fetchone()
        kind = owner['kind'] if owner else values[0].get('kind') or kind_for(values[0]['code'], values[0]['name'])
        if not kind:
            raise HTTPException(409, '请先添加标的并确认类型，再同步估算费用')
        rule = rules[kind]
        commission = max(total_amount * Decimal(rule['commission_rate']) / Decimal(10000),
                         Decimal(rule['minimum_fee'])).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
        adjustable, fixed = [], Decimal(0)
        for item in values:
            previous = saved.get(item['key'])
            if previous and not previous.get('estimated'):
                # Legacy imports have no reliable fee provenance.
                item['fee'], item['estimated_fee'] = previous['fee'], False
                fixed += Decimal(previous['fee'])
            else:
                adjustable.append(item)
        remainder = max(Decimal(0), commission - fixed)
        weight = sum((Decimal(item['gross_amount']) if item.get('gross_amount') is not None
            else Decimal(item['price']) * item['quantity'] for item in adjustable), Decimal(0))
        allocated, cumulative = Decimal(0), Decimal(0)
        for item in adjustable:
            cumulative += Decimal(item['gross_amount']) if item.get('gross_amount') is not None else Decimal(item['price']) * item['quantity']
            # Cumulative rounding keeps every share nonnegative and totals exact.
            share = (remainder * cumulative / weight).quantize(Decimal('.01'), rounding=ROUND_HALF_UP) - allocated
            item['fee'], item['estimated_fee'] = str(share), True
            allocated += share
    return {item['key']: item for members in groups.values() for item in members.values()}, saved


def import_records(request, records, expected_pending=None):
    from .app import db, DB_PATH, ledger
    from .t_trade_tracking import validate_links
    with db() as connection, localcontext() as ctx:
        ctx.prec = 40
        connection.execute('BEGIN IMMEDIATE')
        pending = []
        for record in records:
            previous = connection.execute('''SELECT t.* FROM broker_imports i JOIN trades t ON t.id=i.trade_id
                WHERE i.source_key=?''', (record['key'],)).fetchone()
            if previous:
                if fingerprint(dict(previous)) != fingerprint(record):
                    raise HTTPException(409, '成交的已有记录已被修改，请先核对账本')
            else:
                pending.append(record)
        if expected_pending is not None and {item['key'] for item in pending} != set(expected_pending):
            if not pending:
                return {'inserted': False, 'message': '这些成交已全部同步', 'count': 0}
            raise HTTPException(409, '同委托的同步状态已变化，请刷新当日成交后重试')
        if not pending:
            return {'inserted': False, 'message': '这些成交已全部同步', 'count': 0}
        if request.allocation == 'split' and sum(item.quantity for item in request.allocations) != sum(item['quantity'] for item in pending):
            raise HTTPException(422, '分摊数量合计必须等于本委托尚未同步的成交数量')
        prepared, saved = prepare_fees(connection, records)
        backup = DB_PATH.parent / 'backups' / f'before-deal-sync-{datetime.now():%Y%m%d-%H%M%S-%f}.sqlite3'
        backup.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(DB_PATH)) as reader, closing(sqlite3.connect(backup)) as target:
            reader.backup(target)
        for key, previous in saved.items():
            item = prepared[key]
            if previous.get('estimated'):
                connection.execute('UPDATE trades SET fee=? WHERE id=?', (item['fee'], previous['id']))
                connection.execute('UPDATE broker_deal_metadata SET saved_fee=?,estimated=? WHERE source_key=?',
                    (item['fee'], int(item['estimated_fee']), key))
            elif 'saved_facts' not in previous:
                connection.execute('''INSERT OR IGNORE INTO broker_deal_metadata
                    (source_key,order_group,estimated,saved_fee,saved_facts) VALUES (?,?,?,?,?)''',
                    (key, item.get('order_group') or key, 0, previous['fee'], fingerprint(previous)))
        splits = [{'buy_id': item.buy_id, 'quantity': item.quantity} for item in request.allocations]
        count, estimated = 0, False
        for record in sorted(pending, key=lambda item: (item['executed_at'], item['key'])):
            selection = request
            if request.allocation == 'split':
                left, parts = record['quantity'], []
                for part in splits:
                    used = min(left, part['quantity'])
                    if used:
                        parts.append({'buy_id': part['buy_id'], 'quantity': used})
                        part['quantity'] -= used
                        left -= used
                selection = DealSelection(token=request.token,
                    allocation='manual' if len(parts) == 1 else 'split',
                    buy_lot_id=parts[0]['buy_id'] if len(parts) == 1 else None,
                    allocations=parts if len(parts) > 1 else [])
            item = prepared[record['key']]
            response = import_record(connection, item, selection, bind_order=request.allocation != 'split')
            count += int(response['inserted'])
            trade = dict(connection.execute('SELECT * FROM trades WHERE id=?', (response['trade_id'],)).fetchone())
            # Matched manual entries keep their costs and are not repriced later.
            is_estimate = bool(item['estimated_fee'] and response['inserted'])
            connection.execute('''INSERT OR REPLACE INTO broker_deal_metadata
                (source_key,order_group,estimated,saved_fee,saved_facts) VALUES (?,?,?,?,?)''',
                (record['key'], record.get('order_group') or record['key'], int(is_estimate), trade['fee'], fingerprint(trade)))
            estimated = estimated or is_estimate
        for code in {record['code'] for record in records}:
            ledger(connection, code)
        validate_links(connection)
        return {'inserted': bool(count), 'count': count, 'estimated_fee': estimated,
                'message': f'已同步 {count} 笔成交' + ('，费用按整单估算分摊，结算后请核对' if estimated else '')}


def get_snapshot(token):
    with snapshot_lock:
        snapshot = snapshots.get(token)
        if not snapshot or snapshot['expiry'] < time.monotonic():
            raise HTTPException(409, '成交查询已过期，请刷新当日成交后再同步')
        return snapshot


@router.post('/deal')
def import_deal(request: DealSelection):
    snapshot = get_snapshot(request.token)
    if 'record' not in snapshot:
        raise HTTPException(422, '请使用委托合并同步')
    return import_records(request, [dict(snapshot['record'])])


@router.post('/deal-group')
def import_deal_group(request: DealSelection):
    snapshot = get_snapshot(request.token)
    if 'records' not in snapshot:
        raise HTTPException(422, '请刷新当日成交后使用委托同步')
    return import_records(request, [dict(record) for record in snapshot['records']], snapshot['pending'])


class DealTSetting(BaseModel):
    model_config = ConfigDict(extra='forbid')
    token: str = Field(min_length=20, max_length=100)
    t_trade: bool = Field(strict=True)


class DealToken(BaseModel):
    model_config = ConfigDict(extra='forbid')
    token: str = Field(min_length=20, max_length=100)


@router.post('/deal-group/buyback-options')
def deal_buyback_options(payload: DealToken):
    from .app import db
    from .t_order_groups import order_keys, members
    from .t_trade_tracking import plans
    snapshot = get_snapshot(payload.token)
    records = snapshot.get('records') or [snapshot.get('record')]
    if not records or not all(record and record['side'] == 'buy' for record in records):
        raise HTTPException(422, '请从买入成交选择做 T 买回关联')
    with db() as connection:
        identifiers = []
        for record in records:
            row = connection.execute('''SELECT t.* FROM broker_imports i JOIN trades t ON t.id=i.trade_id
                WHERE i.source_key=?''', (record['key'],)).fetchone()
            if not row:
                raise HTTPException(409, '请先同步这笔买入委托的全部成交，再关联做 T 买回')
            if fingerprint(dict(row)) != fingerprint(record):
                raise HTTPException(409, '买入记录已被修改，请先核对账本')
            identifiers.append(row['id'])
        keys = order_keys(connection)
        if len({keys[identifier] for identifier in identifiers}) != 1:
            raise HTTPException(409, '买入成交无法唯一归入同一委托，请核对后重试')
        buys = members(connection, identifiers[0], 'buy')
        buy_ids = {row['id'] for row in buys}
        used = {row['buy_id']: row['quantity'] for row in connection.execute(
            'SELECT buy_id,SUM(quantity) AS quantity FROM t_buyback_links GROUP BY buy_id')}
        available = sum(row['quantity'] - used.get(row['id'], 0) for row in buys)
        linked_sells = {row['sell_id'] for row in connection.execute('SELECT DISTINCT sell_id FROM t_buyback_links')}
        states = {}
        for row in connection.execute("SELECT id,t_trade FROM trades WHERE side='sell'"):
            state = states.setdefault(keys[row['id']], {'key': keys[row['id']], 't_trade': True, 'has_t_links': False})
            state['t_trade'] = state['t_trade'] and bool(row['t_trade'])
            state['has_t_links'] = state['has_t_links'] or row['id'] in linked_sells
    data = plans()
    candidates, associations = [], []
    for plan in data['plans']:
        if plan['code'] != buys[0]['code']:
            continue
        matches = [link for link in plan['links'] if buy_ids.intersection(link.get('buy_ids', [link['buy_id']]))]
        if matches:
            associations.append({'sell_id': plan['id'], 'executed_at': plan['executed_at'],
                'quantity': sum(link['quantity'] for link in matches),
                'restored': all(link.get('all_restored', bool(link['restore_allocations'])) for link in matches)})
        if plan['remaining'] > 0 and (plan['executed_at'], plan.get('last_id', plan['id'])) < (buys[-1]['executed_at'], buys[-1]['id']):
            candidates.append({'id': plan['id'], 'executed_at': plan['executed_at'], 'remaining': plan['remaining'],
                'price': plan['price'], 'fill_count': len(plan.get('sell_ids', [plan['id']]))})
    return {'buy_id': min(buy_ids), 'available': available, 'quantity': sum(row['quantity'] for row in buys),
            'candidates': candidates, 'associations': associations, 'sell_states': list(states.values())}


@router.put('/deal-group/t-setting')
def toggle_deal_t(payload: DealTSetting):
    from .app import db
    from .t_order_groups import order_keys
    from .t_trade_tracking import OrderSettings, save_order_settings
    snapshot = get_snapshot(payload.token)
    records = snapshot.get('records') or [snapshot.get('record')]
    if not records or not all(record and record['side'] == 'sell' for record in records):
        raise HTTPException(422, '做 T 开关仅用于卖出委托')
    key = canonical_group(records[0])
    if any(canonical_group(record) != key for record in records):
        raise HTTPException(409, '成交不能唯一归入同一卖出委托，请刷新重试')
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        known_ids = set()
        for record in records:
            previous = connection.execute('''SELECT t.* FROM broker_imports i JOIN trades t ON t.id=i.trade_id
                WHERE i.source_key=?''', (record['key'],)).fetchone()
            if previous:
                known_ids.add(previous['id'])
                if fingerprint(dict(previous)) != fingerprint(record):
                    raise HTTPException(409, '已同步成交被修改，请先核对账本后再切换做 T')
                connection.execute('''INSERT OR IGNORE INTO broker_deal_metadata
                    (source_key,order_group,estimated,saved_fee,saved_facts) VALUES (?,?,?,?,?)''',
                    (record['key'], record.get('order_group') or record['key'], 0, previous['fee'], fingerprint(dict(previous))))
        keys = order_keys(connection)
        rows = [dict(row) for row in connection.execute("SELECT * FROM trades WHERE side='sell'") if keys[row['id']] == key]
        if not known_ids.issubset({row['id'] for row in rows}):
            raise HTTPException(409, '成交的委托归属存在冲突，请核对后重试')
        save_order_settings(connection, rows, OrderSettings(t_trade=payload.t_trade), key)
        linked = {row['sell_id'] for row in connection.execute('SELECT DISTINCT sell_id FROM t_buyback_links')}
        has_links = bool(linked & {row['id'] for row in rows})
    return {'t_trade': payload.t_trade, 't_mixed': False,
            'has_t_links': has_links, 'message': '已设为做 T' if payload.t_trade else '已取消做 T'}
