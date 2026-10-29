import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from scripts.reconcile_broker_trades import apply, prepare, read_trades


def trade(identifier, side, price, note, lot=None):
    return {'id': identifier, 'code': '513310', 'side': side,
            'executed_at': f'2026-10-12T12:0{identifier}:00', 'price': price,
            'quantity': 100, 'fee': '1', 'gross_amount': None, 'note': note,
            'buy_lot_id': lot, 'target_profit_percent': '3' if side == 'buy' else None,
            'target_profit_amount': None}


def native(side, price, time, contract):
    amount = str(float(price) * 100)
    cash = -(float(amount) + 1) if side == '买入' else float(amount) - 1
    return {'xd_2102': '513310', 'xd_2109': side, 'xd_2128': '100',
            'xd_2129': price, 'xd_2131': amount, 'xd_2110': str(cash),
            'xd_2141': '20261012', 'xd_2142': time, 'xd_2135': contract}


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.trades = [trade(1, 'buy', '2', '合同C1；日期取交收日期，未提供成交时间'),
                       trade(2, 'sell', '2.1', '合同C2', 1)]
        self.source = {'rows': [native('买入', '2', '09:30:01', 'C1'), native('卖出', '2.1', '09:35:01', 'C2')]}

    def test_correct_time_and_amount_preserve_targets_links_and_financial_values(self):
        staged, report = prepare(self.trades, self.source, {})
        self.assertEqual(staged[0]['executed_at'], '2026-10-12T09:30:01')
        self.assertEqual(staged[1]['buy_lot_id'], 1)
        self.assertEqual(staged[0]['target_profit_percent'], '3')
        self.assertEqual(staged[0]['price'], '2')
        self.assertEqual(staged[0]['fee'], '1')
        self.assertEqual(report['matched'], 2)
        self.assertNotIn('fee', report['changed_fields'])

    def test_ambiguous_manual_matching_and_incomplete_history_are_rejected(self):
        manual = [trade(1, 'buy', '2', ''), trade(2, 'buy', '2', '')]
        source = {'rows': [native('买入', '2', '09:30:01', 'A'), native('买入', '2', '10:00:01', 'B')]}
        with self.assertRaises(ValueError):
            prepare(manual, source)
        with self.assertRaises(ValueError):
            prepare(self.trades, {'rows': self.source['rows'][:1]})

    def test_current_position_mismatch_or_invalid_lot_chronology_blocks_changes(self):
        with self.assertRaises(ValueError):
            prepare(self.trades, self.source, {'513310': 100})
        reversed_source = {'rows': [native('买入', '2', '10:00:01', 'C1'), native('卖出', '2.1', '09:35:01', 'C2')]}
        with self.assertRaises(ValueError):
            prepare(self.trades, reversed_source)

    def database(self, root):
        database = root / 'ledger.sqlite3'
        with closing(sqlite3.connect(database)) as connection:
            connection.executescript('''
              CREATE TABLE instruments(code TEXT PRIMARY KEY,name TEXT,kind TEXT);
              CREATE TABLE trades(id INTEGER PRIMARY KEY,code TEXT,side TEXT,executed_at TEXT,
                price TEXT,quantity INTEGER,fee TEXT,gross_amount TEXT,note TEXT,buy_lot_id INTEGER,
                target_profit_percent TEXT,target_profit_amount TEXT);
              CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
              INSERT INTO instruments VALUES ('513310','自定义名称','etf');
              INSERT INTO settings VALUES ('commission','fee-rule'),('account','cash-setting');
            ''')
            connection.executemany('''INSERT INTO trades VALUES (:id,:code,:side,:executed_at,:price,
                :quantity,:fee,:gross_amount,:note,:buy_lot_id,:target_profit_percent,:target_profit_amount)''', self.trades)
            connection.commit()
        return database

    def test_apply_creates_valid_backup_and_preserves_all_user_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);database = self.database(root)
            report, backup, audit = apply(database, self.source, {}, self.trades, root / 'audit')
            self.assertTrue(audit.exists())
            with closing(sqlite3.connect(backup)) as connection:
                self.assertEqual(connection.execute('SELECT executed_at FROM trades WHERE id=1').fetchone()[0], self.trades[0]['executed_at'])
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(connection.execute('SELECT executed_at FROM trades WHERE id=1').fetchone()[0], '2026-10-12T09:30:01')
                self.assertEqual(connection.execute('SELECT target_profit_percent FROM trades WHERE id=1').fetchone()[0], '3')
                self.assertEqual(connection.execute('SELECT buy_lot_id FROM trades WHERE id=2').fetchone()[0], 1)
                self.assertEqual(dict(connection.execute('SELECT key,value FROM settings')), {'commission': 'fee-rule', 'account': 'cash-setting'})
            self.assertEqual(report['matched'], 2)

    def test_concurrent_edit_is_detected_without_overwriting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);database = self.database(root)
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("UPDATE trades SET note='user changed this' WHERE id=1");connection.commit()
            with self.assertRaises(ValueError):
                apply(database, self.source, {}, self.trades, root / 'audit')
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(connection.execute('SELECT note FROM trades WHERE id=1').fetchone()[0], 'user changed this')


if __name__ == '__main__':
    unittest.main()
