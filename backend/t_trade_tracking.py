"""Associate actual buybacks with marked sells without adding ledger profits."""
from decimal import Decimal, localcontext, ROUND_HALF_UP
from typing import Annotated
import json
import sqlite3
from contextlib import closing
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .broker_trade import same_origin
from .accounting import calculate, LedgerError
from .t_relationships import load_links, write_origins, resolve_origins, link_profits
from .t_order_groups import order_keys, members, grouped, aggregate_plans

router = APIRouter(prefix='/api/t-trades', tags=['做T跟踪'])


def validate_links(connection, *, verify_cache=True):
    links = connection.execute('''SELECT l.*,s.side AS sell_side,s.code AS sell_code,s.executed_at AS sold_at,
        s.t_trade,b.side AS buy_side,b.code AS buy_code,b.executed_at AS bought_at
        FROM t_buyback_links l JOIN trades s ON s.id=l.sell_id JOIN trades b ON b.id=l.buy_id''').fetchall()
    for link in links:
        if (link['sell_side'] != 'sell' or not link['t_trade'] or link['buy_side'] != 'buy'
                or link['sell_code'] != link['buy_code']
                or (link['bought_at'], link['buy_id']) <= (link['sold_at'], link['sell_id'])):
            raise HTTPException(409, '做 T 买回关联与交易不一致，请先解除买回关联再修改')
    for column in ('sell_id', 'buy_id'):
        if connection.execute(f'''SELECT 1 FROM t_buyback_links l JOIN trades t ON t.id=l.{column}
            GROUP BY l.{column} HAVING SUM(l.quantity)>MAX(t.quantity) LIMIT 1''').fetchone():
            raise HTTPException(409, '关联买回数量超过交易数量，请先调整买回关联')
    for code in {link['sell_code'] for link in links}:
        try:
            holdings = calculate([dict(row) for row in connection.execute('SELECT * FROM trades WHERE code=?', (code,))])
            resolve_origins(holdings['trades'], load_links(connection, code))
        except (LedgerError, KeyError, ValueError) as error:
            raise HTTPException(409, f'做 T 原批次分摊与交易不一致：{error}') from None
    if verify_cache:
        expected = {}
        for link in load_links(connection):
            for item in json.loads(link['restore_allocations'] or '[]'):
                expected.setdefault(link['buy_id'], []).append((link['sell_id'], item['buy_id'], item['quantity']))
        for row in connection.execute("SELECT id,t_restore_allocations FROM trades WHERE side='buy'"):
            actual = sorted((item['sell_id'], item['buy_id'], item['quantity'])
                            for item in json.loads(row['t_restore_allocations'] or '[]'))
            if actual != sorted(expected.get(row['id'], [])):
                raise HTTPException(409, '做 T 恢复缓存与分摊明细不一致，请重启后台重建缓存')


def gross(trade):
    return Decimal(trade['gross_amount']) if trade['gross_amount'] is not None else Decimal(trade['price']) * trade['quantity']


def refresh_restorations(connection, code):
    grouped = {}
    for row in load_links(connection, code):
        connection.execute('UPDATE t_buyback_links SET restore_allocations=? WHERE sell_id=? AND buy_id=?',
                           (row['restore_allocations'], row['sell_id'], row['buy_id']))
        for item in json.loads(row['restore_allocations'] or '[]'):
            grouped.setdefault(row['buy_id'], []).append({**item, 'sell_id': row['sell_id']})
    for row in connection.execute("SELECT id FROM trades WHERE code=? AND side='buy'", (code,)).fetchall():
        items = grouped.get(row['id'])
        connection.execute('UPDATE trades SET t_restore_allocations=? WHERE id=?',
                           (json.dumps(items) if items else None, row['id']))


def restoration_options(connection, sell_id, *, exclude_buy_id=None):
    sell = connection.execute('SELECT * FROM trades WHERE id=?', (sell_id,)).fetchone()
    if not sell or sell['side'] != 'sell' or not sell['t_trade']:
        raise HTTPException(404, '做 T 卖出记录不存在')
    rows = [dict(row) for row in connection.execute('SELECT * FROM trades WHERE code=?', (sell['code'],))]
    try:
        calculated = calculate(rows)
    except LedgerError as error:
        raise HTTPException(409, f'请先核对账本：{error}') from None
    record = next(row for row in calculated['trades'] if row['id'] == sell_id)
    used, restored = {}, {}
    for link in load_links(connection, sell['code']):
        if link['sell_id'] != sell_id:
            continue
        if link['buy_id'] == exclude_buy_id:
            continue
        for item in link['origin_allocations']:
            used[item['buy_id']] = used.get(item['buy_id'], 0) + item['quantity']
        for item in json.loads(link['restore_allocations'] or '[]'):
            restored[item['buy_id']] = restored.get(item['buy_id'], 0) + item['quantity']
    by_id = {row['id']: row for row in rows}
    return [{'buy_id': part['buy_id'], 'quantity': part['quantity'],
             'restored': restored.get(part['buy_id'], 0), 'available': part['quantity'] - used.get(part['buy_id'], 0),
             'price': by_id[part['buy_id']]['price'], 'executed_at': by_id[part['buy_id']]['executed_at']}
            for part in record['allocations']]


def apply_restoration(connection, code, buy_id):
    """Pin existing matching before changing ownership, then rebuild atomically."""
    from .broker_lot_links import lot_order_markers
    rows = [dict(row) for row in connection.execute('SELECT * FROM trades WHERE code=?', (code,))]
    before = calculate(rows)
    actual_buy = next(row for row in rows if row['id'] == buy_id)
    buy_time = actual_buy['executed_at']
    old_origins, new_origins = {}, {}
    for item in json.loads(actual_buy.get('t_restore_allocations') or '[]'):
        old_origins[item['buy_id']] = old_origins.get(item['buy_id'], 0) + item['quantity']
    for link in load_links(connection, code):
        if link['buy_id'] != buy_id:
            continue
        for item in json.loads(link['restore_allocations'] or '[]'):
            new_origins[item['buy_id']] = new_origins.get(item['buy_id'], 0) + item['quantity']
    changed_origins = {identifier for identifier in old_origins.keys() | new_origins.keys()
                       if old_origins.get(identifier, 0) != new_origins.get(identifier, 0)}
    if any(trade['side'] == 'sell' and (trade['executed_at'], trade['id']) > (buy_time, buy_id)
           and any(part['buy_id'] in changed_origins for part in trade['allocations']) for trade in before['trades']):
        raise HTTPException(409, '原批次在这次买回后已有卖出，恢复或解除会影响历史成本，请先核对后续卖出记录')
    for trade in before['trades']:
        if (trade['side'] == 'sell' and trade['executed_at'] >= buy_time
                and not trade.get('buy_lot_id') and not trade.get('lot_allocations')):
            allocations = [{'buy_id': part['buy_id'], 'quantity': part['quantity']} for part in trade['allocations']]
            connection.execute('UPDATE trades SET lot_allocations=? WHERE id=?', (json.dumps(allocations), trade['id']))
    refresh_restorations(connection, code)
    try:
        after = calculate([dict(row) for row in connection.execute('SELECT * FROM trades WHERE code=?', (code,))])
    except LedgerError as error:
        raise HTTPException(409, f'恢复后与已有卖出记录冲突，请先核对后续卖出的成本批次：{error}') from None
    old_remaining = {lot['id']: lot['remaining'] for lot in before['lots']}
    markers = lot_order_markers(connection, code)
    for lot in after['lots']:
        marker = markers.get(lot['id'], {})
        reserved = sum(marker.get(field, 0) for field in ('submitted_quantity', 'unconfirmed_quantity', 'filled_quantity'))
        if lot['remaining'] < old_remaining.get(lot['id'], 0) and lot['remaining'] < reserved:
            raise HTTPException(409, '该买回批次还有待确认卖出委托，请先处理成交或撤单后再恢复')


@router.get('')
def plans():
    from .app import db
    with db() as connection, localcontext() as ctx:
        ctx.prec = 40
        rows = {row['id']: dict(row) for row in connection.execute('SELECT * FROM trades')}
        names = {row['code']: row['name'] for row in connection.execute('SELECT code,name FROM instruments')}
        links = load_links(connection)
        profits = link_profits(list(rows.values()), links)
        buy_used = {}
        for link in links:
            buy_used[link['buy_id']] = buy_used.get(link['buy_id'], 0) + link['quantity']
        result = []
        for sell in rows.values():
            if sell['side'] != 'sell' or not sell['t_trade']:
                continue
            matched, net, associated = 0, Decimal(0), []
            for link in links:
                if link['sell_id'] != sell['id']:
                    continue
                buy = rows[link['buy_id']]
                quantity = link['quantity']
                profit = profits[(sell['id'], buy['id'])]
                matched += quantity
                net += profit
                associated.append({**link, 'restore_allocations': json.loads(link['restore_allocations'] or '[]'),
                                   'price': buy['price'], 'executed_at': buy['executed_at']})
            result.append({'id': sell['id'], 'code': sell['code'], 'name': names[sell['code']],
                           'executed_at': sell['executed_at'], 'price': sell['price'], 'quantity': sell['quantity'],
                           'fee': sell['fee'], 'gross_amount': str(gross(sell)),
                           'target_price': sell['t_buyback_price'], 'matched_quantity': matched,
                           'remaining': sell['quantity'] - matched,
                           'net_profit': str(net.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)), 'links': associated,
                           'origins': restoration_options(connection, sell['id'])})
        result.sort(key=lambda item: (item['remaining'] > 0, item['executed_at'], item['id']), reverse=True)
        buys = [
            {'id': row['id'], 'code': row['code'], 'executed_at': row['executed_at'], 'price': row['price'],
             'available': row['quantity'] - buy_used.get(row['id'], 0)}
            for row in rows.values() if row['side'] == 'buy' and row['quantity'] > buy_used.get(row['id'], 0)]
        keys = order_keys(connection)
        result, buys = aggregate_plans(result, buys, rows, keys)
        sell_orders = []
        linked_sells = {link['sell_id'] for link in links}
        for group in grouped([row for row in rows.values() if row['side'] == 'sell'], keys):
            targets = {row['t_buyback_price'] for row in group}
            sell_orders.append({'id': min(row['id'] for row in group), 'code': group[0]['code'],
                'name': names[group[0]['code']], 'executed_at': group[-1]['executed_at'],
                'quantity': sum(row['quantity'] for row in group), 'fill_count': len(group),
                't_trade': all(row['t_trade'] for row in group), 'has_links': any(row['id'] in linked_sells for row in group),
                'target_price': next(iter(targets)) if len(targets) == 1 else None})
        sell_orders.sort(key=lambda item: (item['executed_at'], item['id']), reverse=True)
        return {'plans': result, 'buy_records': buys, 'sell_orders': sell_orders}


class OriginAllocation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    buy_id: int = Field(gt=0, strict=True)
    quantity: int = Field(gt=0, le=1_000_000_000, strict=True)


class RestoreInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    allocations: list[OriginAllocation] | None = Field(default=None, max_length=200)


def choose_restoration(options, quantity, requested):
    if requested is not None:
        items = [item.model_dump() for item in requested]
    else:
        items, remaining = [], quantity
        for origin in options:
            used = min(remaining, max(0, origin['available']))
            if used:
                items.append({'buy_id': origin['buy_id'], 'quantity': used})
                remaining -= used
    available = {origin['buy_id']: origin['available'] for origin in options}
    if (sum(item['quantity'] for item in items) != quantity or len({item['buy_id'] for item in items}) != len(items)
            or any(item['buy_id'] not in available or item['quantity'] > available[item['buy_id']] for item in items)):
        raise HTTPException(409, '恢复数量须等于本次关联数量，且不能超过各原批次尚可恢复的数量')
    return items


class BuybackInput(RestoreInput):
    model_config = ConfigDict(extra='forbid')
    buy_id: int = Field(gt=0, strict=True)
    quantity: int = Field(gt=0, le=1_000_000_000, strict=True)


def backup_group():
    from .app import DB_PATH
    path = DB_PATH.parent / 'backups' / f'before-t-order-{datetime.now():%Y%m%d-%H%M%S-%f}.sqlite3'
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(DB_PATH)) as source, closing(sqlite3.connect(path)) as target:
        source.backup(target)


@router.post('/orders/{sell_id}/buybacks', dependencies=[Depends(same_origin)])
def link_order(sell_id: int, payload: BuybackInput):
    from .app import db
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        validate_links(connection)
        sells, buys = members(connection, sell_id, 'sell'), members(connection, payload.buy_id, 'buy')
        if not sells or not buys or sells[0]['code'] != buys[0]['code']:
            raise HTTPException(409, '卖出与买回委托不存在或不属于同一证券')
        if not all(row['t_trade'] for row in sells):
            raise HTTPException(409, '请先将整个卖出委托设为做 T')
        links = load_links(connection, sells[0]['code'])
        sell_used, buy_used = {}, {}
        for link in links:
            sell_used[link['sell_id']] = sell_used.get(link['sell_id'], 0) + link['quantity']
            buy_used[link['buy_id']] = buy_used.get(link['buy_id'], 0) + link['quantity']
        if payload.quantity > min(sum(row['quantity'] - sell_used.get(row['id'], 0) for row in sells),
                                  sum(row['quantity'] - buy_used.get(row['id'], 0) for row in buys)):
            raise HTTPException(409, '关联数量超过委托待买回数量或买入尚可关联数量')
        wanted = {part.buy_id: part.quantity for part in payload.allocations} if payload.allocations is not None else None
        if wanted is not None and (len(wanted) != len(payload.allocations) or sum(wanted.values()) != payload.quantity):
            raise HTTPException(409, '原批次分摊合计须等于本次委托关联数量')
        backup_group()
        left = payload.quantity
        for buy in buys:
            available = buy['quantity'] - buy_used.get(buy['id'], 0)
            changed = False
            for sell in sells:
                if not left or not available:
                    break
                if (sell['executed_at'], sell['id']) >= (buy['executed_at'], buy['id']):
                    continue
                options = restoration_options(connection, sell['id'])
                count = min(left, available, sell['quantity'] - sell_used.get(sell['id'], 0))
                if wanted is not None:
                    count = min(count, sum(min(origin['available'], wanted.get(origin['buy_id'], 0)) for origin in options))
                if count <= 0:
                    continue
                parts, remaining = [], count
                for origin in options:
                    used = min(remaining, origin['available'], wanted.get(origin['buy_id'], 0) if wanted is not None else remaining)
                    if used:
                        parts.append({'buy_id': origin['buy_id'], 'quantity': used})
                        remaining -= used
                        if wanted is not None:
                            wanted[origin['buy_id']] -= used
                if remaining:
                    raise HTTPException(409, '原批次尚可恢复数量不足')
                connection.execute('UPDATE trades SET lot_allocations=? WHERE id=? AND buy_lot_id IS NULL AND lot_allocations IS NULL',
                    (json.dumps([{'buy_id': part['buy_id'], 'quantity': part['quantity']} for part in options]), sell['id']))
                existing = next((link for link in load_links(connection, sell['code'])
                    if link['sell_id'] == sell['id'] and link['buy_id'] == buy['id']), None)
                if existing and not existing['restore_allocations']:
                    raise HTTPException(409, '此成交已有未恢复的旧关联，请先恢复原批次后增加数量')
                combined = {part['buy_id']: part['quantity'] for part in existing['origin_allocations']} if existing else {}
                for part in parts:
                    combined[part['buy_id']] = combined.get(part['buy_id'], 0) + part['quantity']
                connection.execute('''INSERT INTO t_buyback_links(sell_id,buy_id,quantity) VALUES (?,?,?)
                    ON CONFLICT(sell_id,buy_id) DO UPDATE SET quantity=quantity+excluded.quantity''', (sell['id'], buy['id'], count))
                write_origins(connection, sell['id'], buy['id'], [{'buy_id': identifier, 'quantity': value} for identifier, value in combined.items()])
                sell_used[sell['id']] = sell_used.get(sell['id'], 0) + count
                left -= count
                available -= count
                changed = True
            if changed:
                apply_restoration(connection, buy['code'], buy['id'])
        if left or wanted is not None and any(wanted.values()):
            raise HTTPException(409, '所选买回委托与卖出时间或原批次分摊不匹配')
        validate_links(connection)
    return {'message': '已按委托关联买回并恢复原批次'}


def change_order_links(connection, sell_id, buy_id, restore):
    sells, buys = members(connection, sell_id, 'sell'), members(connection, buy_id, 'buy')
    if not sells or not buys or sells[0]['code'] != buys[0]['code']:
        raise HTTPException(404, '委托关联不存在')
    sell_ids = {row['id'] for row in sells}
    backup_group()
    found = False
    for buy in buys:
        links = [link for link in load_links(connection, buy['code']) if link['sell_id'] in sell_ids and link['buy_id'] == buy['id']]
        if not links:
            continue
        found = True
        needs_rebuild = restore or any(link['restore_allocations'] for link in links)
        for link in links:
            if restore:
                write_origins(connection, link['sell_id'], buy['id'], link['origin_allocations'])
            else:
                connection.execute('DELETE FROM t_buyback_links WHERE sell_id=? AND buy_id=?', (link['sell_id'], buy['id']))
        if needs_rebuild:
            apply_restoration(connection, buy['code'], buy['id'])
    if not found:
        raise HTTPException(404, '委托买回关联不存在')
    validate_links(connection)


@router.put('/orders/{sell_id}/buybacks/{buy_id}/restoration', dependencies=[Depends(same_origin)])
def restore_order(sell_id: int, buy_id: int):
    from .app import db
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        validate_links(connection)
        change_order_links(connection, sell_id, buy_id, True)
    return {'message': '已恢复本委托的原批次'}


@router.delete('/orders/{sell_id}/buybacks/{buy_id}', status_code=204, dependencies=[Depends(same_origin)])
def unlink_order(sell_id: int, buy_id: int):
    from .app import db
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        validate_links(connection)
        change_order_links(connection, sell_id, buy_id, False)


class OrderSettings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    t_trade: bool = True
    target_price: Decimal | None = Field(default=None, gt=0, le=1000000, decimal_places=3, allow_inf_nan=False)


def save_order_settings(connection, rows, payload, key):
    validate_links(connection)
    identifiers = {row['id'] for row in rows}
    if not payload.t_trade and any(link['sell_id'] in identifiers for link in load_links(connection)):
        raise HTTPException(409, '请先解除该委托的买回关联，再取消做 T')
    backup_group()
    explicit_target = 'target_price' in payload.model_fields_set
    targets = set()
    for row in rows:
        target = (str(payload.target_price) if payload.target_price is not None else None) if explicit_target else row['t_buyback_price']
        if not payload.t_trade:
            target = None
        targets.add(target)
        connection.execute('UPDATE trades SET t_trade=?,t_buyback_price=? WHERE id=?', (int(payload.t_trade), target, row['id']))
        connection.execute('''UPDATE broker_order_intents SET t_trade=?,t_buyback_price=? WHERE id IN
            (SELECT intent_id FROM broker_intent_fills WHERE trade_id=?)''', (int(payload.t_trade), target, row['id']))
    previous = connection.execute('SELECT target_price FROM broker_t_order_settings WHERE order_group=?', (key,)).fetchone()
    if not payload.t_trade:
        target = None
    elif explicit_target:
        target = str(payload.target_price) if payload.target_price is not None else None
    elif targets:
        target = next(iter(targets)) if len(targets) == 1 else None
    else:
        target = previous['target_price'] if previous else None
    connection.execute('''INSERT INTO broker_t_order_settings(order_group,t_trade,target_price) VALUES (?,?,?)
        ON CONFLICT(order_group) DO UPDATE SET t_trade=excluded.t_trade,target_price=excluded.target_price''',
        (key, int(payload.t_trade), target))
    validate_links(connection)


@router.put('/orders/{sell_id}/settings', dependencies=[Depends(same_origin)])
def set_order(sell_id: int, payload: OrderSettings):
    from .app import db
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        rows = members(connection, sell_id, 'sell')
        if not rows:
            raise HTTPException(404, '卖出委托不存在')
        save_order_settings(connection, rows, payload, order_keys(connection)[rows[0]['id']])
    return {'message': '已保存整单做 T 设置'}


class BuybackPrices(BaseModel):
    model_config = ConfigDict(extra='forbid')
    prices: dict[Annotated[str, Field(pattern=r'^[0-9]{6}$')],
                 Annotated[Decimal, Field(gt=0, le=1000000, max_digits=18, decimal_places=8, allow_inf_nan=False)]] = Field(max_length=200)


@router.post('/valuations')
def valuations(payload: BuybackPrices):
    from .app import db, fee_settings, commission_fee
    with db() as connection, localcontext() as ctx:
        ctx.prec = 40
        rules = fee_settings(connection)
        rows = connection.execute('''SELECT s.*,i.kind,COALESCE(SUM(l.quantity),0) AS matched
            FROM trades s JOIN instruments i ON i.code=s.code
            LEFT JOIN t_buyback_links l ON l.sell_id=s.id
            WHERE s.side='sell' AND s.t_trade=1 GROUP BY s.id''').fetchall()
        result = []
        for group in grouped([dict(row) for row in rows], order_keys(connection)):
            row = group[0]
            price = payload.prices.get(row['code'])
            quantity = sum(item['quantity'] - item['matched'] for item in group)
            if price is None or quantity <= 0:
                continue
            sell_gross = sum((gross(item) * (item['quantity'] - item['matched']) / item['quantity'] for item in group), Decimal(0))
            sell_fee = sum((Decimal(item['fee']) * (item['quantity'] - item['matched']) / item['quantity'] for item in group), Decimal(0))
            proceeds = sell_gross - sell_fee
            buy_fee = commission_fee(price, quantity, rules[row['kind']])
            profit = proceeds - price * quantity - buy_fee
            target = None
            if row['t_buyback_price'] is not None and len({item['t_buyback_price'] for item in group}) == 1:
                target_price = Decimal(row['t_buyback_price'])
                target = proceeds - target_price * quantity - commission_fee(target_price, quantity, rules[row['kind']])
            def amount(value):
                return str(value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)) if value is not None else None
            result.append({'id': min(item['id'] for item in group), 'price': str(price), 'remaining': quantity,
                           'profit': amount(profit), 'profit_percent': amount(profit / proceeds * 100) if proceeds > 0 else None,
                           'sell_proceeds': amount(proceeds), 'sell_fee': amount(sell_fee), 'buy_fee': amount(buy_fee),
                           'target_profit': amount(target)})
        return {'valuations': result}


@router.post('/{sell_id}/buybacks', dependencies=[Depends(same_origin)])
def link_buyback(sell_id: int, payload: BuybackInput):
    from .app import db
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        validate_links(connection)
        rows = connection.execute('SELECT id FROM trades WHERE id IN (?,?)', (sell_id, payload.buy_id)).fetchall()
        if len(rows) != 2:
            raise HTTPException(404, '卖出或买入记录不存在')
        if connection.execute('SELECT 1 FROM t_buyback_links WHERE sell_id=? AND buy_id=?', (sell_id, payload.buy_id)).fetchone():
            raise HTTPException(409, '这笔买入已关联，请先解除关联后调整数量')
        options = restoration_options(connection, sell_id)
        connection.execute('UPDATE trades SET lot_allocations=? WHERE id=? AND buy_lot_id IS NULL AND lot_allocations IS NULL',
            (json.dumps([{'buy_id': part['buy_id'], 'quantity': part['quantity']} for part in options]), sell_id))
        allocations = choose_restoration(options, payload.quantity, payload.allocations)
        connection.execute('INSERT INTO t_buyback_links(sell_id,buy_id,quantity,restore_allocations) VALUES (?,?,?,?)',
                           (sell_id, payload.buy_id, payload.quantity, json.dumps(allocations)))
        write_origins(connection, sell_id, payload.buy_id, allocations)
        validate_links(connection, verify_cache=False)
        code = connection.execute('SELECT code FROM trades WHERE id=?', (payload.buy_id,)).fetchone()['code']
        apply_restoration(connection, code, payload.buy_id)
        validate_links(connection)
    return {'message': '已关联买回并恢复原批次'}


@router.put('/{sell_id}/buybacks/{buy_id}/restoration', dependencies=[Depends(same_origin)])
def restore_existing(sell_id: int, buy_id: int, payload: RestoreInput):
    from .app import db
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        validate_links(connection)
        link = connection.execute('SELECT * FROM t_buyback_links WHERE sell_id=? AND buy_id=?', (sell_id, buy_id)).fetchone()
        if not link:
            raise HTTPException(404, '买回关联不存在')
        options = restoration_options(connection, sell_id, exclude_buy_id=buy_id)
        allocations = choose_restoration(options, link['quantity'], payload.allocations)
        write_origins(connection, sell_id, buy_id, allocations)
        code = connection.execute('SELECT code FROM trades WHERE id=?', (buy_id,)).fetchone()['code']
        apply_restoration(connection, code, buy_id)
        validate_links(connection)
    return {'message': '已恢复原批次'}


@router.delete('/{sell_id}/buybacks/{buy_id}', status_code=204, dependencies=[Depends(same_origin)])
def unlink_buyback(sell_id: int, buy_id: int):
    from .app import db
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        validate_links(connection)
        buy = connection.execute('SELECT code FROM trades WHERE id=?', (buy_id,)).fetchone()
        link = next((link for link in load_links(connection, buy['code'])
                     if link['sell_id'] == sell_id and link['buy_id'] == buy_id), None) if buy else None
        connection.execute('DELETE FROM t_buyback_links WHERE sell_id=? AND buy_id=?', (sell_id, buy_id))
        if buy and link and json.loads(link['restore_allocations'] or '[]'):
            apply_restoration(connection, buy['code'], buy_id)
        validate_links(connection)
