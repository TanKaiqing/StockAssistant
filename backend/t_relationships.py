"""Persistent T origins; JSON fields are compatibility caches of these rows."""
import json
import sqlite3
from contextlib import closing
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP, localcontext
from pathlib import Path

from .accounting import LedgerError, calculate


def resolve_origins(trades, links):
    by_id = {trade['id']: trade for trade in trades}
    capacity = {trade['id']: {part['buy_id']: part['quantity'] for part in trade['allocations']}
                for trade in trades if trade['side'] == 'sell' and trade.get('t_trade')}
    origins = {}
    ordered = sorted(links, key=lambda row: (by_id[row['buy_id']]['executed_at'], row['buy_id'], row['sell_id']))
    for link in ordered:
        key = (link['sell_id'], link['buy_id'])
        if key[0] not in capacity:
            raise LedgerError('做 T 买回关联缺少对应的做 T 卖出标记')
        parts = link.get('origin_allocations')
        if parts is None:
            parts = json.loads(link['restore_allocations'] or '[]')
        if not parts:
            continue
        if (sum(part['quantity'] for part in parts) != link['quantity']
                or len({part['buy_id'] for part in parts}) != len(parts)):
            raise LedgerError('做 T 原批次分摊数量与买回关联不一致')
        for part in parts:
            identifier, count = part['buy_id'], part['quantity']
            if type(count) is not int or count <= 0 or capacity[key[0]].get(identifier, 0) < count:
                raise LedgerError('做 T 原批次分摊超出原卖出数量')
            capacity[key[0]][identifier] -= count
        origins[key] = parts
    for link in ordered:
        key = (link['sell_id'], link['buy_id'])
        if key in origins:
            continue
        remaining, parts = link['quantity'], []
        for identifier, available in capacity[key[0]].items():
            count = min(remaining, available)
            if count:
                parts.append({'buy_id': identifier, 'quantity': count})
                capacity[key[0]][identifier] -= count
                remaining -= count
        if remaining:
            raise LedgerError('做 T 买回数量超出原卖出数量')
        origins[key] = parts
    return origins


def load_links(connection, code=None):
    condition, args = (' WHERE s.code=?', (code,)) if code else ('', ())
    links = [dict(row) for row in connection.execute('SELECT l.* FROM t_buyback_links l '
        'JOIN trades s ON s.id=l.sell_id' + condition + ' ORDER BY l.buy_id,l.sell_id', args)]
    parts = {}
    for row in connection.execute('SELECT a.* FROM t_buyback_allocations a JOIN trades s ON s.id=a.sell_id'
                                  + condition + ' ORDER BY a.sell_id,a.buy_id,a.origin_buy_id', args):
        parts.setdefault((row['sell_id'], row['buy_id']), []).append(dict(row))
    for link in links:
        rows = parts.get((link['sell_id'], link['buy_id']), [])
        if sum(row['quantity'] for row in rows) != link['quantity'] or len({row['restored'] for row in rows}) != 1:
            raise LedgerError('做 T 原批次明细不完整，请从迁移前备份核对关联')
        link['origin_allocations'] = [{'buy_id': row['origin_buy_id'], 'quantity': row['quantity']} for row in rows]
        restored = [{'buy_id': row['origin_buy_id'], 'quantity': row['quantity']} for row in rows if row['restored']]
        link['restore_allocations'] = json.dumps(restored) if restored else None
    return links


def write_origins(connection, sell_id, buy_id, parts, *, restored=True):
    connection.execute('DELETE FROM t_buyback_allocations WHERE sell_id=? AND buy_id=?', (sell_id, buy_id))
    connection.executemany('INSERT INTO t_buyback_allocations(sell_id,buy_id,origin_buy_id,quantity,restored) '
        'VALUES (?,?,?,?,?)', [(sell_id, buy_id, part['buy_id'], part['quantity'], int(restored)) for part in parts])
    connection.execute('UPDATE t_buyback_links SET restore_allocations=? WHERE sell_id=? AND buy_id=?',
        (json.dumps(parts) if restored else None, sell_id, buy_id))


def link_profits(trades, links):
    """Round once per actual buy; deterministically assign the final cent residual."""
    by_id = {trade['id']: trade for trade in trades}
    grouped, result = {}, {}
    for link in links:
        grouped.setdefault(link['buy_id'], []).append(link)
    def gross(trade):
        return Decimal(trade['gross_amount']) if trade.get('gross_amount') is not None else Decimal(trade['price']) * trade['quantity']
    with localcontext() as ctx:
        ctx.prec = 40
        for buy_id, group in grouped.items():
            buy = by_id[buy_id]
            buy_unit = (gross(buy) + Decimal(buy['fee'])) / buy['quantity']
            group.sort(key=lambda link: link['sell_id'])
            raw = []
            for link in group:
                sell = by_id[link['sell_id']]
                raw.append(((gross(sell) - Decimal(sell['fee'])) / sell['quantity'] - buy_unit) * link['quantity'])
            total = sum(raw, Decimal(0)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
            allocated = Decimal(0)
            for index, link in enumerate(group):
                profit = total - allocated if index == len(group) - 1 else raw[index].quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
                result[(link['sell_id'], buy_id)] = profit
                allocated += profit
    return result


def migrate_relationships(connection):
    if connection.execute("SELECT 1 FROM settings WHERE key='t_allocations_v1'").fetchone():
        return
    # Back up the last committed database, without importing/starting the app.
    filename = connection.execute('PRAGMA database_list').fetchone()[2]
    if filename:
        source_path = Path(filename)
        directory = source_path.parent / 'backups'
        directory.mkdir(parents=True, exist_ok=True)
        target_path = directory / f'ledger-before-t-relations-{datetime.now():%Y%m%d-%H%M%S-%f}.sqlite3'
        with closing(sqlite3.connect(source_path.as_uri() + '?mode=ro', uri=True)) as source:
            with closing(sqlite3.connect(target_path)) as target:
                source.backup(target)
    if not connection.in_transaction:
        connection.execute('BEGIN IMMEDIATE')
    connection.execute('''CREATE TABLE t_buyback_allocations (
        sell_id INTEGER NOT NULL, buy_id INTEGER NOT NULL,
        origin_buy_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK(quantity>0),
        restored INTEGER NOT NULL CHECK(restored IN (0,1)),
        PRIMARY KEY(sell_id,buy_id,origin_buy_id),
        FOREIGN KEY(sell_id,buy_id) REFERENCES t_buyback_links(sell_id,buy_id) ON DELETE CASCADE)''')
    connection.execute('CREATE INDEX t_allocations_origin ON t_buyback_allocations(origin_buy_id)')
    for operation in ('INSERT', 'UPDATE'):
        excluded = ' AND NOT (sell_id=OLD.sell_id AND buy_id=OLD.buy_id AND origin_buy_id=OLD.origin_buy_id)' if operation == 'UPDATE' else ''
        connection.execute(f'''CREATE TRIGGER t_allocation_guard_{operation.lower()}
            BEFORE {operation} ON t_buyback_allocations BEGIN
            SELECT CASE WHEN NEW.quantity + COALESCE((SELECT SUM(quantity) FROM t_buyback_allocations
                WHERE sell_id=NEW.sell_id AND buy_id=NEW.buy_id{excluded}),0) >
                (SELECT quantity FROM t_buyback_links WHERE sell_id=NEW.sell_id AND buy_id=NEW.buy_id)
                THEN RAISE(ABORT,'T allocation exceeds linked quantity') END;
            SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM trades s, trades b, trades o
                WHERE s.id=NEW.sell_id AND b.id=NEW.buy_id AND o.id=NEW.origin_buy_id
                AND s.side='sell' AND s.t_trade=1 AND b.side='buy' AND o.side='buy'
                AND s.code=b.code AND s.code=o.code
                AND (o.executed_at<s.executed_at OR (o.executed_at=s.executed_at AND o.id<s.id))
                AND (s.executed_at<b.executed_at OR (s.executed_at=b.executed_at AND s.id<b.id)))
                THEN RAISE(ABORT,'Invalid T allocation origin or chronology') END;
            END''')
    for code_row in connection.execute('SELECT DISTINCT s.code FROM t_buyback_links l JOIN trades s ON s.id=l.sell_id').fetchall():
        code = code_row['code']
        calculated = calculate([dict(row) for row in connection.execute('SELECT * FROM trades WHERE code=?', (code,))])
        links = [dict(row) for row in connection.execute('SELECT l.* FROM t_buyback_links l JOIN trades s '
            'ON s.id=l.sell_id WHERE s.code=?', (code,))]
        origins = resolve_origins(calculated['trades'], links)
        # Freeze FIFO matching of source sells so later history edits cannot
        # silently change which original batch the saved T allocation belongs to.
        for trade in calculated['trades']:
            if any(link['sell_id'] == trade['id'] for link in links) and not trade.get('buy_lot_id') and not trade.get('lot_allocations'):
                connection.execute('UPDATE trades SET lot_allocations=? WHERE id=?',
                    (json.dumps([{'buy_id': part['buy_id'], 'quantity': part['quantity']} for part in trade['allocations']]), trade['id']))
        for link in links:
            write_origins(connection, link['sell_id'], link['buy_id'], origins[(link['sell_id'], link['buy_id'])],
                          restored=bool(json.loads(link['restore_allocations'] or '[]')))
    connection.execute("INSERT INTO settings(key,value) VALUES ('t_allocations_v1','1')")
