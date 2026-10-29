from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from scripts.restore_broker_records import prepare, apply


def row(index, operation, quantity, price, amount, fee, balance, cash):
    movement = -(amount + fee) if operation == '证券买入' else amount - fee
    return {'source_row': index, '操作': operation, '币种': '人民币', '交收日期': '20261009',
            '证券代码': '159985', '证券名称': '豆粕ETF', '成交数量': str(quantity), '成交均价': str(price),
            '成交金额': str(amount), '手续费': str(fee), '印花税': '0', '其他杂费': '0',
            '发生金额': str(movement), '资金余额': str(cash), '股票余额': str(balance), '合同编号': str(index)}


class RestoreTests(unittest.TestCase):
    def source(self):
        deposit = {'source_row': 2, '操作': '银行转证券', '币种': '人民币', '交收日期': '20261009',
                   '发生金额': '10000', '资金余额': '10000'}
        return {'source_path': 'table.xls', 'rows': [deposit, row(3, '证券买入', 2100, '2.356', 4948.4, .25, 2100, 5051.35)]}

    def test_validate_rounded_price_and_reject_missing_history(self):
        instruments, trades, report = prepare(self.source())
        self.assertEqual(report['trade_count'], 1)
        self.assertEqual(report['amount_rounding_source_rows'], [3])
        self.assertEqual(trades[0]['gross_amount'], '4948.4')
        source = self.source()
        source['rows'][-1]['股票余额'] = '2200'
        with self.assertRaisesRegex(ValueError, '持仓余额不连续'):
            prepare(source)

    def test_replace_transaction_backs_up_and_preserves_fee_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / 'ledger.sqlite3'
            with closing(sqlite3.connect(database)) as connection:
                connection.executescript('''
                  CREATE TABLE instruments(code TEXT PRIMARY KEY,name TEXT,kind TEXT);
                  CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT,side TEXT,
                    executed_at TEXT,price TEXT,quantity INTEGER,fee TEXT,note TEXT,buy_lot_id INTEGER);
                  CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
                  INSERT INTO instruments VALUES ('510300','测试ETF','etf');
                  INSERT INTO settings VALUES ('commission','{"etf":{"commission_rate":"0.5","minimum_fee":"0.1"}}');
                  INSERT INTO settings VALUES ('account','{"available_cash":"45000"}');
                ''')
            source = self.source()
            path = root / 'source.json'
            path.write_text(json.dumps(source), encoding='utf-8')
            instruments, trades, report = prepare(source)
            backup = apply(database, path, instruments, trades, report)
            with closing(sqlite3.connect(backup)) as connection:
                self.assertEqual(connection.execute('SELECT code FROM instruments').fetchone()[0], '510300')
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM trades').fetchone()[0], 1)
                self.assertEqual(connection.execute('SELECT gross_amount FROM trades').fetchone()[0], '4948.4')
                fee = json.loads(connection.execute("SELECT value FROM settings WHERE key='commission'").fetchone()[0])
                self.assertEqual(fee['etf']['commission_rate'], '0.5')
                cash = json.loads(connection.execute("SELECT value FROM settings WHERE key='account'").fetchone()[0])
                self.assertEqual(cash['available_cash'], '5051.35')
