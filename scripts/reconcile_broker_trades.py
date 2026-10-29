"""Correct uniquely matched trade facts, preserving IDs, lot links and settings.

Input must be an explicitly allowlisted extraction of the broker's history-deals
response. Dry run by default. No raw account response is read or persisted here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from contextlib import closing
from datetime import datetime
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.accounting import calculate


def decimal(value) -> Decimal:
    number = Decimal(str(value))
    if not number.is_finite():
        raise ValueError('券商返回非有限数值')
    return number


def source_records(source: dict) -> list[dict]:
    records = []
    for row in source['rows']:
        side = {'买入': 'buy', '卖出': 'sell'}.get(row.get('xd_2109'))
        if side is None:
            raise ValueError('历史成交包含未支持的业务，拒绝修改')
        code = row['xd_2102']
        if not re.fullmatch(r'\d{6}', code):
            raise ValueError('证券代码格式无效')
        quantity = decimal(row['xd_2128'])
        price, amount, cash = map(decimal, (row['xd_2129'], row['xd_2131'], row['xd_2110']))
        fee = -cash - amount if side == 'buy' else amount - cash
        if quantity != int(quantity) or quantity <= 0 or price <= 0 or amount <= 0 or fee < 0:
            raise ValueError('成交数量、价格、金额或费用无效')
        day = row.get('xd_2141') or row['xd_2104']
        moment = datetime.strptime(f"{day} {row['xd_2142']}", '%Y%m%d %H:%M:%S')
        refs = set(filter(None, (row.get('xd_2135'), row.get('xd_2136'))))
        records.append({'code': code, 'side': side, 'executed_at': moment.isoformat(timespec='seconds'),
                        'quantity': int(quantity), 'price': str(price), 'gross_amount': str(amount),
                        'fee': str(fee), 'references': refs})
    return records


def prepare(trades: list[dict], source: dict, expected_positions: dict[str, int] | None = None):
    records = source_records(source)
    if len(trades) != len(records) or not trades:
        raise ValueError('券商成交与账本条数不一致，拒绝批量修正')
    contracts = defaultdict(list)
    for index, record in enumerate(records):
        for reference in record['references']:
            contracts[(record['code'], record['side'], reference)].append(index)
    used = set()
    matches = {}
    manual = []
    for trade in trades:
        contract = re.search(r'合同([^；;\s]+)', trade['note'])
        if not contract:
            manual.append(trade)
            continue
        candidates = [index for index in contracts[(trade['code'], trade['side'], contract[1])] if index not in used]
        if len(candidates) > 1:
            candidates = [index for index in candidates if records[index]['executed_at'][:10] == trade['executed_at'][:10]]
        if len(candidates) != 1:
            raise ValueError(f"记录 #{trade['id']} 的合同不能唯一对应，拒绝修改")
        matches[trade['id']] = candidates[0]
        used.add(candidates[0])
    for trade in manual:
        candidates = [index for index, record in enumerate(records) if index not in used
                      and (record['code'], record['side'], record['quantity']) == (trade['code'], trade['side'], trade['quantity'])
                      and decimal(record['price']) == decimal(trade['price'])
                      and record['executed_at'][:10] == trade['executed_at'][:10]]
        if len(candidates) != 1:
            raise ValueError(f"手工记录 #{trade['id']} 不能唯一对应，拒绝修改")
        matches[trade['id']] = candidates[0]
        used.add(candidates[0])
    if len(used) != len(records):
        raise ValueError('存在未对应的券商成交，拒绝修改')

    staged = []
    changes = []
    counts = Counter()
    fields = ('executed_at', 'price', 'quantity', 'fee', 'gross_amount')
    for trade in trades:
        native = records[matches[trade['id']]]
        # Contract matches still have to agree on the actual security and size.
        # A mismatch requires a separate audit, rather than overwriting a lot.
        if (trade['code'], trade['side'], trade['quantity']) != (native['code'], native['side'], native['quantity']):
            raise ValueError(f"记录 #{trade['id']} 数量或证券不一致，拒绝修改")
        new = dict(trade)
        details = {}
        for field in fields:
            previous, updated = trade.get(field), native[field]
            same = previous == updated if field in ('executed_at', 'quantity') else (
                previous is not None and decimal(previous) == decimal(updated))
            if not same:
                new[field] = updated
                details[field] = {'before': previous, 'after': updated}
                counts[field] += 1
        note = trade['note'].replace('日期取交收日期，未提供成交时间', '成交日期及时间已按银河历史成交核对')
        if note != trade['note']:
            new['note'] = note
            details['note'] = {'before': trade['note'], 'after': note}
            counts['note'] += 1
        if details:
            changes.append({'id': trade['id'], 'code': trade['code'], 'side': trade['side'], 'fields': details})
        staged.append(new)

    positions = {}
    accounting_changes = []
    for code in sorted({trade['code'] for trade in trades}):
        before = calculate([trade for trade in trades if trade['code'] == code])
        after = calculate([trade for trade in staged if trade['code'] == code])
        if after['quantity']:
            positions[code] = after['quantity']
        if before['quantity'] != after['quantity']:
            raise ValueError('修正改变了持仓数量，拒绝修改')
        if before['cost'] != after['cost'] or before['realized_pnl'] != after['realized_pnl']:
            accounting_changes.append({'code': code, 'cost_before': before['cost'], 'cost_after': after['cost'],
                                       'realized_before': before['realized_pnl'], 'realized_after': after['realized_pnl']})
    if expected_positions is not None and positions != {code: quantity for code, quantity in expected_positions.items() if quantity}:
        raise ValueError('修正后持仓与券商当前持仓不一致，拒绝修改')
    return staged, {'trade_count': len(trades), 'matched': len(matches), 'changed_records': len(changes),
                    'changed_fields': dict(counts), 'positions': positions,
                    'accounting_changes': accounting_changes, 'changes': changes,
                    'preserved': ['交易ID', '买卖方向与数量', '指定买入批次', '盈利目标', '标的', '全部系统设置']}


def read_trades(connection: sqlite3.Connection) -> list[dict]:
    return [dict(row) for row in connection.execute('SELECT * FROM trades ORDER BY id')]


def signature(rows: list[dict]) -> str:
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()


def apply(database: Path, source: dict, expected: dict[str, int], preflight: list[dict], audit_directory: Path):
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup_path = database.parent / 'backups' / f'before-broker-reconcile-{stamp}.sqlite3'
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    audit_directory.mkdir(parents=True, exist_ok=True)
    audit_path = audit_directory / f'reconcile-audit-{stamp}.json'
    with closing(sqlite3.connect(database, timeout=15)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('BEGIN IMMEDIATE')
        try:
            actual = read_trades(connection)
            if signature(actual) != signature(preflight):
                raise ValueError('账本在核对期间发生变化，拒绝修改')
            staged, report = prepare(actual, source, expected)
            settings = list(connection.execute('SELECT key,value FROM settings ORDER BY key'))
            instruments = list(connection.execute('SELECT * FROM instruments ORDER BY code'))
            with closing(sqlite3.connect(database)) as reader, closing(sqlite3.connect(backup_path)) as backup:
                reader.backup(backup)
                if backup.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('备份校验失败')
            for trade in staged:
                connection.execute('''UPDATE trades SET executed_at=:executed_at,price=:price,fee=:fee,
                                      gross_amount=:gross_amount,note=:note WHERE id=:id''', trade)
            if signature(read_trades(connection)) != signature(staged):
                raise ValueError('写入后的交易与核对结果不一致')
            if list(connection.execute('SELECT key,value FROM settings ORDER BY key')) != settings:
                raise ValueError('系统设置发生变化')
            if list(connection.execute('SELECT * FROM instruments ORDER BY code')) != instruments:
                raise ValueError('标的发生变化')
            if connection.execute('PRAGMA foreign_key_check').fetchall():
                raise ValueError('外键检查失败')
            if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('数据库完整性检查失败')
            report.update(backup=str(backup_path), applied_at=datetime.now().isoformat(timespec='seconds'))
            audit_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    return report, backup_path, audit_path


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--database', type=Path, default=ROOT / 'data' / 'ledger.sqlite3')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    source = json.loads(args.source.read_text(encoding='utf-8'))
    with closing(sqlite3.connect(f'file:{args.database.resolve().as_posix()}?mode=ro', uri=True)) as connection:
        connection.row_factory = sqlite3.Row
        trades = read_trades(connection)
    from backend.broker import query
    current = query('positions')
    if current['account_type'] != 'normal' or current['is_credit']:
        raise ValueError('当前账户不是已核对的普通账户')
    expected = {row['code']: int(decimal(row['quantity'])) for row in current['rows']}
    staged, report = prepare(trades, source, expected)
    if args.apply:
        report, backup_path, audit_path = apply(args.database.resolve(), source, expected, trades, args.source.parent)
    else:
        audit_path = args.source.parent / 'reconcile-preview.json'
        audit_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key != 'changes'}, ensure_ascii=True, indent=2))
    print(json.dumps({'audit': str(audit_path)}, ensure_ascii=True))
