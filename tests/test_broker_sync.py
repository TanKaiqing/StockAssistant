import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import HTTPException
from backend import broker_sync as sync, app as application
from backend.broker_trade import Confirmation


def native_row(side='buy', clock='10:00:00', identifier='one'):
    return {'xd_2109': '买入' if side == 'buy' else '卖出', 'xd_2102': '513310', 'xd_2103': '测试ETF',
            'xd_2129': '4', 'xd_2128': '100', 'xd_2131': '400', 'xd_2110': '-400.1' if side == 'buy' else '399.9',
            'xd_2141': '20261008', 'xd_2142': clock, 'xd_2190': identifier, 'xd_2106': 'secret'}


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'test.sqlite3'
        self.path_patch = patch.object(application, 'DB_PATH', self.path)
        self.path_patch.start(); application.init_db(); sync.plans.clear()
        with application.db() as db:
            db.execute("INSERT INTO settings VALUES ('commission','keep-settings')")
        self.range = sync.Range(start_date='2026-10-08', end_date='2026-10-08')

    def tearDown(self):
        self.path_patch.stop(); self.temp.cleanup(); sync.plans.clear()

    def preview(self, rows):
        records, skipped = sync.parse_rows(rows)
        with patch.object(sync.broker, 'health_status', return_value={'ready': True}), patch.object(sync, 'history', return_value=(records, skipped)):
            return sync.preview(self.range)

    def test_roundtrip_backed_up_repeat_is_duplicate_and_preserves_settings(self):
        source = [native_row(), native_row('sell', clock='10:01:00', identifier='two')]
        plan = self.preview(source)
        self.assertEqual(plan['new_count'], 2); self.assertFalse(plan['blocked'])
        self.assertNotIn('secret', json.dumps(plan))
        result = sync.apply(Confirmation(ticket=plan['ticket'], confirmed=True))
        self.assertEqual(result['inserted'], 2)
        self.assertTrue((self.path.parent / 'backups' / result['backup']).exists())
        with application.db() as db:
            self.assertEqual(db.execute('SELECT value FROM settings').fetchone()[0], 'keep-settings')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM trades').fetchone()[0], 2)
            self.assertEqual(db.execute('SELECT gross_amount FROM trades LIMIT 1').fetchone()[0], '400')
        repeated = self.preview(source)
        self.assertEqual(repeated['new_count'], 0); self.assertEqual(repeated['duplicate_count'], 2)
        with self.assertRaises(HTTPException):
            sync.apply(Confirmation(ticket=plan['ticket'], confirmed=True))

    def test_manual_lot_metadata_and_instrument_names_are_preserved(self):
        with application.db() as db:
            db.execute("INSERT INTO instruments(code,name,kind) VALUES ('513310','原名称','etf')")
            db.execute("INSERT INTO trades(code,side,executed_at,price,quantity,fee,note,target_profit_percent) VALUES ('513310','buy','2026-10-08T10:00:00','4',100,'0.1','keep-note','3')")
        plan = self.preview([native_row(), native_row(clock='10:02:00', identifier='two')])
        self.assertEqual(plan['duplicate_count'], 1)
        sync.apply(Confirmation(ticket=plan['ticket'], confirmed=True))
        with application.db() as db:
            row = db.execute('SELECT * FROM trades WHERE id=1').fetchone()
            self.assertEqual(row['note'], 'keep-note'); self.assertEqual(row['target_profit_percent'], '3')
            self.assertEqual(db.execute('SELECT name FROM instruments').fetchone()[0], '原名称')

    def test_missing_buy_history_and_missing_fees_block_import(self):
        plan = self.preview([native_row('sell')]); self.assertTrue(plan['blocked'])
        with self.assertRaises(HTTPException):
            sync.apply(Confirmation(ticket=plan['ticket'], confirmed=True))
        incomplete = native_row(); incomplete.pop('xd_2110')
        with self.assertRaises(HTTPException):
            self.preview([incomplete])

    def test_concurrent_edit_invalidates_preview(self):
        plan = self.preview([native_row()])
        with application.db() as db:
            db.execute("INSERT INTO instruments(code,name,kind) VALUES ('510300','变化','etf')")
        with self.assertRaises(HTTPException):
            sync.apply(Confirmation(ticket=plan['ticket'], confirmed=True))
        with application.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM trades').fetchone()[0], 0)

    def test_multiple_identical_fills_are_counted_not_collapsed(self):
        source = [native_row(identifier='one'), native_row(identifier='two')]
        plan = self.preview(source); self.assertEqual(plan['new_count'], 2)
        sync.apply(Confirmation(ticket=plan['ticket'], confirmed=True))
        self.assertEqual(self.preview(source)['duplicate_count'], 2)

    def test_edited_import_is_conflict_instead_of_overwrite(self):
        plan = self.preview([native_row()]); sync.apply(Confirmation(ticket=plan['ticket'], confirmed=True))
        with application.db() as db:
            db.execute("UPDATE trades SET fee='5'")
        repeat = self.preview([native_row()])
        self.assertTrue(repeat['blocked']); self.assertEqual(repeat['rows'][0]['status'], 'conflict')

    def test_same_execution_id_is_not_imported_twice(self):
        plan = self.preview([native_row(), native_row()])
        self.assertEqual(plan['new_count'], 1)

    def test_apply_failure_rolls_back_all_trade_and_instrument_changes(self):
        from backend.accounting import LedgerError
        plan = self.preview([native_row()])
        with patch.object(sync, 'calculate', side_effect=LedgerError('模拟核算失败')):
            with self.assertRaises(HTTPException):
                sync.apply(Confirmation(ticket=plan['ticket'], confirmed=True))
        with application.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM trades').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM instruments').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM broker_imports').fetchone()[0], 0)

    def test_watchlist_import_does_not_modify_existing_names_or_create_trades(self):
        from backend import broker_watchlist as watch
        with application.db() as db:
            db.execute("INSERT INTO instruments(code,name,kind) VALUES ('513310','保留名称','etf')")
        with patch.object(watch, 'ready'), patch.object(watch, 'read', return_value={'rows': [
            {'code': '513310', 'name': '远端名称', 'kind': 'etf'}, {'code': '510300', 'name': '沪深300ETF', 'kind': 'etf'}]}):
            result = watch.import_selection(watch.Selection(codes=['513310', '510300']))
        self.assertEqual(result['inserted'], 1)
        with application.db() as db:
            self.assertEqual(db.execute("SELECT name FROM instruments WHERE code='513310'").fetchone()[0], '保留名称')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM trades').fetchone()[0], 0)
