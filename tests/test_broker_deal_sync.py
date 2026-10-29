import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError
from backend import app as application, broker, broker_deal_sync as sync


def native(identifier='one', side='买入'):
    return {'zqdm': '513310', 'zqmc': '测试ETF', 'cz': side,
            'cjjj': '4.123', 'cjsl': '100', 'cjje': '412.30',
            'cjrq': date.today().strftime('%Y%m%d'), 'cjsj': '100001',
            'cjbh': identifier, 'htbh': 'secret-contract'}


class DealSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'test.sqlite3'
        self.path_patch = patch.object(application, 'DB_PATH', self.path)
        self.path_patch.start()
        application.init_db()
        sync.snapshots.clear()
        application.save_fee_settings(application.FeeSettingsInput(
            stock={'commission_rate': '1', 'minimum_fee': '5'},
            etf={'commission_rate': '0.5', 'minimum_fee': '0.1'}))

    def tearDown(self):
        sync.snapshots.clear()
        self.path_patch.stop()
        self.temp.cleanup()

    def actions(self, rows, credit=False):
        result = broker.normalize_query('deals', {'ok': True, 'data': {
            'ok': True, 'account_type': 'credit' if credit else 'normal',
            'is_credit': credit, 'data': {'deal': {'513310': rows}}}})
        sync.attach_actions(result, rows)
        self.assertNotIn('secret-contract', json.dumps(result))
        return result['rows']

    def run_import(self, row):
        return sync.import_deal(sync.DealSelection(token=row['sync_token']))

    def test_single_fill_is_backed_up_and_refresh_retry_is_idempotent(self):
        row = self.actions([native()])[0]
        result = self.run_import(row)
        self.assertTrue(result['inserted'])
        self.assertTrue(result['estimated_fee'])
        self.assertFalse(self.run_import(row)['inserted'])
        refreshed = self.actions([native()])[0]
        self.assertTrue(refreshed['synced'])
        self.assertFalse(self.run_import(refreshed)['inserted'])
        with application.db() as connection:
            record = dict(connection.execute('SELECT * FROM trades').fetchone())
            self.assertEqual(record['fee'], '0.10')
            self.assertEqual(record['gross_amount'], '412.30')
            self.assertIn('估算', record['note'])
            self.assertEqual(connection.execute('SELECT count(*) FROM trades').fetchone()[0], 1)
        self.assertEqual(len(list((self.path.parent / 'backups').glob('*.sqlite3'))), 1)

    def test_partial_fills_with_identical_facts_are_not_collapsed(self):
        for row in self.actions([native('one'), native('two')]):
            self.assertTrue(self.run_import(row)['inserted'])
        for row in self.actions([native('two'), native('one')]):
            self.assertFalse(self.run_import(row)['inserted'])
        with application.db() as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM trades').fetchone()[0], 2)

    def test_missing_execution_ids_preserve_multiplicity(self):
        for row in self.actions([native(''), native('')]):
            self.assertTrue(self.run_import(row)['inserted'])
        for row in self.actions([native(''), native('')]):
            self.assertFalse(self.run_import(row)['inserted'])

    def test_prior_fill_at_exact_minute_does_not_block_a_later_fill(self):
        first = native('one'); first['cjsj'] = '100000'
        self.assertTrue(self.run_import(self.actions([first])[0])['inserted'])
        self.assertTrue(self.run_import(self.actions([native('two')])[0])['inserted'])

    def test_existing_manual_record_preserves_actual_fee_and_lot_metadata(self):
        row = self.actions([native()])[0]
        with application.db() as connection:
            connection.execute("INSERT INTO instruments(code,name,kind) VALUES ('513310','保留名称','etf')")
            connection.execute('''INSERT INTO trades(code,side,executed_at,price,quantity,fee,note,target_profit_percent)
                VALUES ('513310','buy',?,'4.123',100,'5','保留备注','3')''', (date.today().isoformat() + 'T10:00:01',))
        self.assertFalse(self.run_import(row)['inserted'])
        with application.db() as connection:
            record = connection.execute('SELECT * FROM trades').fetchone()
            self.assertEqual(record['fee'], '5')
            self.assertEqual(record['target_profit_percent'], '3')

    def test_edited_import_and_missing_buy_history_block_writes(self):
        with self.assertRaises(HTTPException):
            self.run_import(self.actions([native(side='卖出')])[0])
        with application.db() as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM instruments').fetchone()[0], 0)
        row = self.actions([native()])[0]
        self.run_import(row)
        with application.db() as connection:
            connection.execute("UPDATE trades SET quantity=200")
        with self.assertRaises(HTTPException):
            self.run_import(row)

    def test_credit_incomplete_and_expired_snapshots_cannot_import(self):
        self.assertIsNone(self.actions([native()], credit=True)[0]['sync_token'])
        bad = native(); bad['cjsj'] = ''
        self.assertIsNone(self.actions([bad])[0]['sync_token'])
        row = self.actions([native()])[0]
        sync.snapshots[row['sync_token']]['expiry'] = 0
        with self.assertRaises(HTTPException):
            self.run_import(row)

    def test_request_cannot_supply_trade_facts_or_fabricate_snapshot(self):
        row = self.actions([native()])[0]
        with self.assertRaises(ValidationError):
            sync.DealSelection(token=row['sync_token'], price='1')
        with self.assertRaises(HTTPException):
            sync.import_deal(sync.DealSelection(token='fabricated-snapshot-token'))
