"""Restore an audited broker-export extraction. Dry run by default; --apply replaces the ledger.

Input is JSON extracted locally from the tab-separated, GB18030 broker export.
No brokerage account credentials or network access are needed.
"""
import argparse
from collections import Counter, defaultdict
from contextlib import closing
from datetime import datetime
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.accounting import calculate


def prepare(source):
    trades = []
    instruments = {}
    quantities = defaultdict(int)
    cash = Decimal(0)
    precision_rows = []
    last_date = ''
    known_operations = {'证券买入', '证券卖出', '银行转证券', '证券转银行', '指定交易', '利息归本'}
    for row in source['rows']:
        line = row['source_row']
        operation = row['操作']
        if operation not in known_operations:
            raise ValueError(f'第 {line} 行有未支持的操作：{operation}')
        if row['币种'] != '人民币':
            raise ValueError(f'第 {line} 行币种不支持')
        date = datetime.strptime(row['交收日期'], '%Y%m%d').strftime('%Y-%m-%d')
        if date < last_date:
            raise ValueError('文件日期未按顺序排列，需要人工核对')
        last_date = date
        cash += Decimal(row['发生金额'])
        if cash != Decimal(row['资金余额']):
            raise ValueError(f'第 {line} 行资金余额不连续')
        if operation not in {'证券买入', '证券卖出'}:
            continue
        code = row['证券代码']
        if len(code) != 6 or not code.isdigit():
            raise ValueError(f'第 {line} 行证券代码无效')
        quantity_decimal = Decimal(row['成交数量'])
        quantity = int(quantity_decimal)
        if quantity_decimal != quantity or quantity <= 0:
            raise ValueError(f'第 {line} 行成交数量无效')
        side = 'buy' if operation == '证券买入' else 'sell'
        price, amount = Decimal(row['成交均价']), Decimal(row['成交金额'])
        fee = sum((Decimal(row[key]) for key in ('手续费', '印花税', '其他杂费')), Decimal(0))
        if price <= 0 or amount <= 0 or fee < 0:
            raise ValueError(f'第 {line} 行成交金额或费用无效')
        movement = -(amount + fee) if side == 'buy' else amount - fee
        if movement != Decimal(row['发生金额']):
            raise ValueError(f'第 {line} 行实际费用和发生金额不一致')
        quantities[code] += quantity if side == 'buy' else -quantity
        if quantities[code] < 0 or quantities[code] != int(row['股票余额']):
            raise ValueError(f'第 {line} 行持仓余额不连续，可能缺少期初持仓')
        if price * quantity != amount:
            precision_rows.append(line)
        # Source codes in this export: 15/51 = listed ETFs; 00 = mainland stocks.
        if code.startswith(('15', '51')):
            kind = 'etf'
        elif code.startswith(('00', '30', '60', '68')):
            kind = 'stock'
        else:
            raise ValueError(f'第 {line} 行需要核对证券类型：{code}')
        instruments[code] = {'code': code, 'name': row['证券名称'], 'kind': kind}
        contract = row['合同编号']
        note = f"银河交割单 table.xls 第{line}行；合同{contract}；日期取交收日期，未提供成交时间"
        trades.append({'id': len(trades) + 1, 'code': code, 'side': side,
                       'executed_at': date + 'T00:00:00', 'price': str(price), 'quantity': quantity,
                       'fee': str(fee), 'note': note, 'buy_lot_id': None, 'gross_amount': str(amount)})
    if not trades:
        raise ValueError('没有可导入的买卖记录')
    summaries = []
    for code, instrument in instruments.items():
        ledger = calculate([trade for trade in trades if trade['code'] == code])
        if ledger['quantity'] != quantities[code]:
            raise ValueError('最终持仓校验失败')
        summaries.append({**instrument, **{key: ledger[key] for key in ('quantity', 'cost', 'average_cost', 'realized_pnl')}})
    report = {'source': source['source_path'], 'source_rows': len(source['rows']), 'trade_count': len(trades),
              'buy_count': sum(trade['side'] == 'buy' for trade in trades),
              'sell_count': sum(trade['side'] == 'sell' for trade in trades),
              'non_trade_operations': dict(Counter(row['操作'] for row in source['rows'] if row['操作'] not in {'证券买入', '证券卖出'})),
              'first_date': trades[0]['executed_at'][:10], 'last_date': trades[-1]['executed_at'][:10],
              'cash_as_of_export': str(cash.quantize(Decimal('0.01'))), 'amount_rounding_source_rows': precision_rows,
              'date_note': '使用源文件交收日期；00:00仅占位，不是真实成交时间；同日按源文件行顺序匹配',
              'instruments': summaries}
    return instruments, trades, report


def apply(database, source_path, instruments, trades, report):
    if not database.is_file():
        raise ValueError('目标数据库不存在，拒绝覆盖')
    backups = database.parent / 'backups'
    backups.mkdir(parents=True, exist_ok=True)
    backup_path = backups / f"before-broker-restore-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.sqlite3"
    with closing(sqlite3.connect(database, timeout=15)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys = ON')
        connection.execute('BEGIN IMMEDIATE')
        try:
            # A separate read connection snapshots the ledger while our reserved
            # lock prevents concurrent writers. Back up before the schema change.
            with closing(sqlite3.connect(database)) as reader, closing(sqlite3.connect(backup_path)) as target:
                reader.backup(target)
            original_fee = connection.execute("SELECT value FROM settings WHERE key='commission'").fetchone()
            if 'gross_amount' not in {row['name'] for row in connection.execute('PRAGMA table_info(trades)')}:
                connection.execute('ALTER TABLE trades ADD COLUMN gross_amount TEXT')
            connection.execute('DELETE FROM trades')
            connection.execute('DELETE FROM instruments')
            connection.execute("DELETE FROM sqlite_sequence WHERE name='trades'")
            connection.execute("DELETE FROM settings WHERE key<>'commission'")
            connection.executemany('INSERT INTO instruments(code,name,kind) VALUES (:code,:name,:kind)', instruments.values())
            connection.executemany('''INSERT INTO trades(id,code,side,executed_at,price,quantity,fee,note,buy_lot_id,gross_amount)
                VALUES (:id,:code,:side,:executed_at,:price,:quantity,:fee,:note,:buy_lot_id,:gross_amount)''', trades)
            connection.execute("INSERT INTO settings(key,value) VALUES ('account',?)",
                               (json.dumps({'available_cash': report['cash_as_of_export']}),))
            for code in instruments:
                saved = [dict(row) for row in connection.execute('SELECT * FROM trades WHERE code=?', (code,))]
                result = calculate(saved)
                expected = next(item for item in report['instruments'] if item['code'] == code)
                if any(result[key] != expected[key] for key in ('quantity', 'cost', 'average_cost', 'realized_pnl')):
                    raise ValueError(f'{code} 持仓与成本校验失败')
            saved_fee = connection.execute("SELECT value FROM settings WHERE key='commission'").fetchone()
            if (original_fee['value'] if original_fee else None) != (saved_fee['value'] if saved_fee else None):
                raise ValueError('费率设置发生变化，拒绝提交')
            if connection.execute('PRAGMA foreign_key_check').fetchall():
                raise ValueError('外键校验失败')
            if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('数据库完整性校验失败')
            report['backup_path'] = str(backup_path)
            report['source_extraction_sha256'] = hashlib.sha256(source_path.read_bytes()).hexdigest()
            report['applied_at'] = datetime.now().isoformat(timespec='seconds')
            report['preserved_settings'] = ['commission']
            audit_path = source_path.parent / f"restore-audit-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.json"
            # Save the validation report before committing. On any error, rollback
            # leaves the original ledger untouched and the backup available.
            audit_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    return backup_path


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--database', type=Path, default=ROOT / 'data' / 'ledger.sqlite3')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    source = json.loads(args.source.read_text(encoding='utf-8'))
    instruments, trades, report = prepare(source)
    if args.apply:
        apply(args.database.resolve(), args.source.resolve(), instruments, trades, report)
    print(json.dumps(report, ensure_ascii=True, indent=2))
