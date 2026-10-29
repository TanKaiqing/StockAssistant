"""Local buy-lot associations; never forward ledger metadata to the broker CLI."""
import hashlib
import json
import re
import secrets
from datetime import datetime
from decimal import Decimal

from fastapi import HTTPException

from . import broker
from .accounting import calculate


def order_key(code, day, reference):
    if not isinstance(reference, (str, int)) or isinstance(reference, bool) or str(reference).strip() in ('', '0'):
        return None
    value = [code, day[:10].replace('-', ''), str(reference).strip()]
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()


def validate_lot(code, lot_id, quantity):
    if lot_id is None:
        return
    from .app import db
    with db() as connection:
        rows = [dict(row) for row in connection.execute('SELECT * FROM trades WHERE code=?', (code,))]
    lot = next((lot for lot in calculate(rows)['lots'] if lot['id'] == lot_id), None)
    if not lot or lot['remaining'] < int(quantity) or lot['executed_at'] > datetime.now().isoformat(timespec='seconds'):
        raise HTTPException(409, '所选买入批次不存在或剩余数量不足，请重新选择')


def capture_order_baseline(code):
    """Read only; hashed references let us distinguish pre-existing orders."""
    document = broker.run_tool('orders')
    result = broker.normalize_query('orders', document)
    if result['account_type'] != 'normal' or result['is_credit']:
        raise HTTPException(409, '账户已变化，请重新预览普通账户委托')
    rows = broker.rows_from(document['data']['data'], 'fullorder', 'order')
    today = datetime.now().date().isoformat()
    keys = set()
    for row in rows:
        if broker.scalar(row, 'zqdm') != code:
            continue
        key = order_key(code, today, broker.scalar(row, 'htbh', 'wtbh'))
        if not key:
            raise HTTPException(409, '已有委托缺少委托号，暂时无法建立可靠关联，请稍后重试')
        keys.add(key)
    return sorted(keys)


def save_intent(payload, lot_id, baseline=None, *, t_trade=False, t_buyback_price=None):
    if lot_id is None:
        return None
    from .app import db
    identifier = secrets.token_hex(16)
    with db() as connection:
        connection.execute('''INSERT INTO broker_order_intents
            (id,code,buy_lot_id,submitted_at,price,quantity,status,orders_before_submit,t_trade,t_buyback_price) VALUES (?,?,?,?,?,?,?,?,?,?)''',
            (identifier, payload['code'], lot_id, datetime.now().isoformat(timespec='seconds'),
             payload['price'], int(payload['quantity']), 'submitting',
             json.dumps(baseline) if baseline is not None else None, bool(t_trade), t_buyback_price))
    return identifier


def reconcile_pending_orders(connection, rows, *, from_deals=False):
    """Resolve asynchronous replies only against unique NEW matching orders.

    A baseline is mandatory. Older submissions require an explicit manual link;
    an ambiguous match never picks the nearest time or first row.
    """
    today = datetime.now().date().isoformat()
    intents = [dict(row) for row in connection.execute('''SELECT * FROM broker_order_intents
        WHERE submitted_at LIKE ? AND order_key IS NULL
        AND status IN ('accepted','unknown','submitting')''', (today + '%',))]
    candidates = {}
    references = {}
    for row in rows:
        key = order_key(broker.scalar(row, 'zqdm'), today, broker.scalar(row, 'htbh', 'wtbh'))
        if key:
            references.setdefault(key, []).append(row)
    ambiguous_codes = {broker.scalar(row, 'zqdm') for group in references.values()
                       if len(group) != 1 for row in group}
    owners = {row['order_key'] for row in connection.execute(
        'SELECT order_key FROM broker_order_intents WHERE order_key IS NOT NULL')}
    # Include legacy intents as competitors, even though they cannot auto-link.
    for intent in intents:
        matches = []
        for key, group in references.items():
            if len(group) != 1:
                continue
            row = group[0]
            if (broker.scalar(row, 'zqdm') != intent['code']
                    or broker.scalar(row, 'cz', 'mmlb', 'mmfx') not in ('卖出', '证券卖出', 'S')):
                continue
            day = broker.scalar(row, 'wtrq', 'rq')
            stamp = broker.scalar(row, 'wtsj')
            price, quantity = broker.number(row, 'wtjg'), broker.number(row, 'wtsl')
            if not day or day[:10].replace('-', '') != today.replace('-', '') or not stamp:
                continue
            if re.fullmatch(r'\d{6}', stamp):
                stamp = ':'.join((stamp[:2], stamp[2:4], stamp[4:]))
            try:
                moment = datetime.fromisoformat(f'{today}T{stamp}')
                delta = (moment - datetime.fromisoformat(intent['submitted_at'])).total_seconds()
                # Small broker/local clock skew; native submit timeout is 95s.
                if (not -10 <= delta <= 110 or price is None or quantity is None
                        or (Decimal(price) < Decimal(intent['price']) if from_deals
                            else Decimal(price) != Decimal(intent['price']))
                        or Decimal(quantity) != intent['quantity']):
                    continue
            except (ValueError, TypeError, ArithmeticError):
                continue
            matches.append(key)
        candidates[intent['id']] = matches
    changed = 0
    for intent in intents:
        if intent['orders_before_submit'] is None:
            message = '此委托缺少提交前快照，请在当日成交中选择买入批次后同步'
        else:
            try:
                baseline = json.loads(intent['orders_before_submit'])
                if not isinstance(baseline, list) or any(not isinstance(key, str) for key in baseline):
                    raise ValueError()
            except (ValueError, TypeError):
                baseline = None
            matches = [key for key in candidates[intent['id']] if baseline is not None and key not in baseline]
            if (intent['code'] not in ambiguous_codes and len(matches) == 1 and matches[0] not in owners
                    and sum(matches[0] in values for values in candidates.values()) == 1):
                connection.execute('''UPDATE broker_order_intents SET order_key=?,status='accepted',sync_error=''
                    WHERE id=? AND order_key IS NULL''', (matches[0], intent['id']))
                owners.add(matches[0])
                changed += 1
                continue
            if matches or baseline is None or intent['code'] in ambiguous_codes:
                message = '成交无法唯一匹配，请在当日成交中选择买入批次后同步' if from_deals else '新增委托无法唯一匹配，请在当日成交中选择买入批次后同步'
            else:
                message = '正在等待可唯一匹配的当日成交，请勿重复下单' if from_deals else '正在等待可唯一匹配的新增委托，请勿重复下单'
        if message != intent['sync_error']:
            connection.execute('UPDATE broker_order_intents SET sync_error=? WHERE id=?', (message, intent['id']))
            changed += 1
    return changed


def deal_groups(rows, native_rows):
    """Group actual sells by reference, counting each execution number once."""
    groups, invalid = {}, set()
    today = datetime.now().date().isoformat()
    for row, raw in zip(rows, native_rows):
        if row['side'] != 'sell' or row['date'] != today:
            continue
        key = order_key(row['code'], today, broker.scalar(raw, 'htbh', 'wtbh'))
        if not key:
            continue
        execution = broker.scalar(raw, 'cjbh')
        try:
            quantity, price = Decimal(row['quantity']), Decimal(row['price'])
            if (not execution or execution == '0' or not quantity.is_finite() or not price.is_finite()
                    or quantity <= 0 or quantity != int(quantity) or price <= 0):
                raise ValueError()
        except (ValueError, TypeError, ArithmeticError):
            invalid.add(key)
            continue
        group = groups.setdefault(key, {})
        previous = group.get(execution)
        if previous and previous[0] != row:
            # Display row IDs may differ for otherwise identical native rows.
            fields = ('code', 'date', 'time', 'price', 'quantity', 'amount')
            if any(previous[0].get(field) != row.get(field) for field in fields):
                invalid.add(key)
        group[execution] = (row, raw)
    return {key: list(group.values()) for key, group in groups.items() if key not in invalid}


def reconcile_pending_deals(connection, groups):
    # Without a submit reference, require the FULL quantity in one new order.
    # Referenced partial fills can be synced immediately by update_deal_states.
    candidates = []
    for group in groups.values():
        row, raw = group[0]
        # Use order time rather than fill time: a resting order may fill much later.
        stamp = broker.scalar(raw, 'wtsj')
        if not stamp or any(broker.scalar(item, 'wtsj') != stamp for _, item in group):
            continue
        candidates.append({'zqdm': row['code'], 'cz': 'S', 'wtrq': row['date'], 'wtsj': stamp,
                           'htbh': broker.scalar(raw, 'htbh', 'wtbh'),
                           'wtjg': str(min(Decimal(item['price']) for item, _ in group)),
                           'wtsl': str(sum(int(Decimal(item['quantity'])) for item, _ in group))})
    return reconcile_pending_orders(connection, candidates, from_deals=True)


def update_deal_states(connection, groups):
    """Only executions can advance confirmed filled quantity."""
    today = datetime.now().date().isoformat()
    changed = 0
    for intent in connection.execute('''SELECT * FROM broker_order_intents
            WHERE submitted_at LIKE ? AND order_key IS NOT NULL
            AND status IN ('accepted','unknown','submitting')''', (today + '%',)).fetchall():
        group = groups.get(intent['order_key'])
        if not group or any(row['code'] != intent['code'] or Decimal(row['price']) < Decimal(intent['price'])
                            for row, _ in group):
            continue
        filled = sum(int(Decimal(row['quantity'])) for row, _ in group)
        if filled < intent['broker_filled'] or filled + intent['broker_canceled'] > intent['quantity']:
            continue
        state = ('filled' if filled == intent['quantity'] else
                 'canceled' if filled + intent['broker_canceled'] == intent['quantity'] else 'partial')
        if (filled, state) != (intent['broker_filled'], intent['broker_state']):
            changed += 1
        connection.execute('''UPDATE broker_order_intents SET broker_filled=?,broker_state=?,
            status='accepted',status_checked_at=? WHERE id=?''',
            (filled, state, datetime.now().isoformat(timespec='seconds'), intent['id']))
    return changed


def finish_intent(identifier, result=None):
    if identifier is None:
        return False
    from .app import db
    # Only explicit order-number fields are considered, never arbitrary nested IDs.
    containers = [result] if isinstance(result, dict) else []
    if containers and isinstance(result.get('data'), dict):
        containers.append(result['data'])
    references = {value for row in containers for key in ('htbh', 'wtbh', 'entrust_no', 'order_id')
                  if (value := broker.scalar(row, key))}
    with db() as connection:
        intent = connection.execute('SELECT * FROM broker_order_intents WHERE id=?', (identifier,)).fetchone()
        key = order_key(intent['code'], intent['submitted_at'], next(iter(references))) if len(references) == 1 else None
        # A reused/ambiguous reference must not steal an existing association.
        if key and connection.execute('SELECT 1 FROM broker_order_intents WHERE order_key=? AND id<>?', (key, identifier)).fetchone():
            key = None
        connection.execute('UPDATE broker_order_intents SET status=?,order_key=? WHERE id=?',
                           ('accepted' if result else 'unknown', key, identifier))
    return key is not None


def find_intent(connection, record):
    if record['side'] != 'sell' or not record.get('order_key'):
        return None
    row = connection.execute('SELECT * FROM broker_order_intents WHERE order_key=? AND code=?',
                             (record['order_key'], record['code'])).fetchone()
    return dict(row) if row else None


def bind_manual(connection, record, lot_id):
    """An explicit lot choice also associates later partial fills of this order."""
    if record['side'] != 'sell' or not record.get('order_key') or lot_id is None:
        return None
    lot = connection.execute('SELECT * FROM trades WHERE id=? AND code=? AND side=?',
                             (lot_id, record['code'], 'buy')).fetchone()
    if not lot:
        raise HTTPException(409, '选择的买入批次不存在或与证券不匹配')
    existing = find_intent(connection, record)
    if existing:
        if existing['buy_lot_id'] != lot_id:
            raise HTTPException(409, '同一委托已关联其他买入批次，请先人工核对')
        return existing
    connection.execute('''INSERT INTO broker_order_intents
        (id,code,buy_lot_id,submitted_at,price,quantity,status,order_key) VALUES (?,?,?,?,?,?,?,?)''',
        (secrets.token_hex(16), record['code'], lot_id, record['executed_at'], '0', lot['quantity'], 'manual', record['order_key']))
    return find_intent(connection, record)


def check_fill(connection, intent, record, trade_id=None):
    if not intent:
        return
    filled = connection.execute('''SELECT COALESCE(SUM(quantity),0) FROM trades
        WHERE id IN (SELECT trade_id FROM broker_intent_fills WHERE intent_id=? AND source_key<>?)
          AND (? IS NULL OR id<>?)''', (intent['id'], record['key'], trade_id, trade_id)).fetchone()[0]
    if filled + record['quantity'] > intent['quantity'] or Decimal(record['price']) < Decimal(intent['price']):
        raise HTTPException(409, '成交数量或价格与关联委托不一致，请人工核对')
    if trade_id is not None:
        connection.execute('INSERT OR IGNORE INTO broker_intent_fills(source_key,intent_id,trade_id) VALUES (?,?,?)',
                           (record['key'], intent['id'], trade_id))


def update_order_states(connection, rows, *, cancellation_only=False):
    """Reconcile exact order references only. Absence is not a cancellation."""
    today = datetime.now().date().isoformat()
    intents = {row['order_key']: dict(row) for row in connection.execute('''
        SELECT * FROM broker_order_intents WHERE submitted_at LIKE ? AND order_key IS NOT NULL
        AND status IN ('accepted','unknown','submitting')''', (today + '%',))}
    candidates = {}
    for row in rows:
        code = broker.scalar(row, 'zqdm')
        key = order_key(code, today, broker.scalar(row, 'htbh', 'wtbh'))
        if key in intents:
            candidates.setdefault(key, []).append(row)
    changed = 0
    for key, matches in candidates.items():
        if len(matches) != 1:
            continue
        row, intent = matches[0], intents[key]
        operation = broker.scalar(row, 'cz', 'mmlb', 'mmfx')
        quantity = broker.number(row, 'wtsl')
        if operation not in ('卖出', '证券卖出', 'S') or quantity is None or Decimal(quantity) != intent['quantity']:
            continue
        day = broker.scalar(row, 'wtrq', 'rq')
        if day and day[:10].replace('-', '') != today.replace('-', ''):
            continue
        status = (broker.scalar(row, 'wtzt', 'ztmc', 'status') or '').strip()
        filled = broker.number(row, 'cjsl')
        canceled = broker.number(row, 'cxsl')
        filled = Decimal(filled) if filled is not None else Decimal(0)
        canceled = Decimal(canceled) if canceled is not None else Decimal(0)
        if any(value < 0 or value != int(value) for value in (filled, canceled)) or filled + canceled > intent['quantity']:
            continue
        rejected = status in ('废单', '已拒绝', '拒单', 'rejected')
        canceled_status = status in ('已撤', '已撤单', '部撤', '部分撤单', '全部撤单', '撤单成功', 'canceled', 'cancelled')
        filled_status = status in ('已成', '全部成交', '已成交', 'filled')
        if canceled_status and broker.number(row, 'cjsl') is None:
            if canceled <= 0:
                continue  # A cancel status without quantities cannot identify partial fills.
            filled = Decimal(intent['quantity']) - canceled
        if filled_status and filled == 0 and broker.number(row, 'cjsl') is None:
            filled = Decimal(intent['quantity'])
        if rejected or canceled_status:
            canceled = Decimal(intent['quantity']) - filled
        if cancellation_only:
            # Orders may report filled ahead of the execution list. Wait for deals.
            filled = Decimal(intent['broker_filled'])
            if filled + canceled > intent['quantity']:
                continue
        state = ('filled' if filled == intent['quantity'] else 'rejected' if rejected else
                 'canceled' if filled + canceled == intent['quantity'] else 'partial' if filled > 0 else 'working')
        # Never let an older broker snapshot move quantities backwards.
        if filled < intent['broker_filled'] or canceled < intent['broker_canceled']:
            continue
        if (int(filled), int(canceled), state) != (intent['broker_filled'], intent['broker_canceled'], intent['broker_state']):
            changed += 1
        connection.execute('''UPDATE broker_order_intents SET broker_filled=?,broker_canceled=?,broker_state=?,
            status_checked_at=?,status='accepted' WHERE id=?''',
            (int(filled), int(canceled), state, datetime.now().isoformat(timespec='seconds'), intent['id']))
    return changed


def lot_order_markers(connection, code):
    """Include verified fills/cancellations without writing any ledger trades."""
    today = datetime.now().date().isoformat()
    intents = connection.execute('''SELECT * FROM broker_order_intents
        WHERE code=? AND submitted_at LIKE ? AND status IN ('accepted','unknown','submitting')''',
        (code, today + '%')).fetchall()
    imported = {row['intent_id']: row['quantity'] for row in connection.execute('''
        SELECT intent_id,SUM(quantity) AS quantity FROM (
          SELECT DISTINCT fills.intent_id,trades.id,trades.quantity
          FROM broker_intent_fills AS fills JOIN trades ON trades.id=fills.trade_id
          JOIN broker_order_intents AS intents ON intents.id=fills.intent_id WHERE intents.code=?
        ) GROUP BY intent_id''', (code,))}
    markers = {}
    for intent in intents:
        synced = imported.get(intent['id'], 0)
        filled = max(0, intent['broker_filled'] - synced)
        canceled = intent['broker_canceled']
        quantity = max(0, intent['quantity'] - max(intent['broker_filled'], synced) - canceled)
        if not quantity and not filled and not canceled:
            continue
        marker = markers.setdefault(intent['buy_lot_id'], {'submitted_quantity': 0, 'unconfirmed_quantity': 0,
            'filled_quantity': 0, 'canceled_quantity': 0, 'rejected_quantity': 0, 'needs_poll': False,
            'sync_error': '', 'has_unlinked': False, 'last_at': ''})
        field = 'submitted_quantity' if intent['status'] == 'accepted' else 'unconfirmed_quantity'
        marker[field] += quantity
        marker['filled_quantity'] += filled
        marker['rejected_quantity' if intent['broker_state'] == 'rejected' else 'canceled_quantity'] += canceled
        marker['needs_poll'] = marker['needs_poll'] or filled > 0 or quantity > 0
        if (filled > 0 or not intent['order_key']) and intent['sync_error']:
            marker['sync_error'] = intent['sync_error']
        marker['has_unlinked'] = marker['has_unlinked'] or not intent['order_key']
        marker['last_at'] = max(marker['last_at'], intent['submitted_at'])
    return markers


def orders_needing_sync(connection):
    today = datetime.now().date().isoformat()
    return [dict(row) for row in connection.execute('''SELECT intents.* FROM broker_order_intents AS intents
        WHERE submitted_at LIKE ? AND order_key IS NOT NULL AND broker_filled > (
            SELECT COALESCE(SUM(quantity),0) FROM trades WHERE id IN (
                SELECT trade_id FROM broker_intent_fills WHERE intent_id=intents.id))''', (today + '%',))]


def orders_to_watch(connection):
    today = datetime.now().date().isoformat()
    return [dict(row) for row in connection.execute('''SELECT intents.* FROM broker_order_intents AS intents
        WHERE submitted_at LIKE ? AND status IN ('accepted','unknown','submitting')
        AND (quantity-broker_canceled > (
            SELECT COALESCE(SUM(quantity),0) FROM trades WHERE id IN (
                SELECT trade_id FROM broker_intent_fills WHERE intent_id=intents.id))
        OR broker_filled > (
            SELECT COALESCE(SUM(quantity),0) FROM trades WHERE id IN (
                SELECT trade_id FROM broker_intent_fills WHERE intent_id=intents.id)))''', (today + '%',))]
