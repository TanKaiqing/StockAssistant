"""Exercise the actual HTTP API against a temporary database, never the user's ledger."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from contextlib import closing


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='stock-assistant-test-')
        cls.database = Path(cls.temp.name) / 'test.sqlite3'
        with socket.socket() as socket_:
            socket_.bind(('127.0.0.1', 0))
            port = socket_.getsockname()[1]
        cls.base = f'http://127.0.0.1:{port}/api'
        env = dict(os.environ, STOCK_ASSISTANT_DB=str(cls.database))
        cls.process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', str(port)],
                                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        for _ in range(100):
            if cls.process.poll() is not None:
                cls.temp.cleanup()
                raise RuntimeError('测试服务退出，请先安装 requirements.txt')
            try:
                if cls.request('/health')[0] == 200:
                    return
            except urllib.error.URLError:
                time.sleep(0.1)
        cls.process.terminate()
        cls.process.wait(timeout=10)
        cls.temp.cleanup()
        raise RuntimeError('测试服务启动失败')

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=10)
        cls.temp.cleanup()

    @classmethod
    def request(cls, path, method='GET', body=None, raw=False):
        request = urllib.request.Request(cls.base + path, method=method,
                  data=json.dumps(body).encode() if body is not None else None,
                  headers={'Content-Type': 'application/json'})
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            content = response.read()
            return response.status, content if raw else json.loads(content) if content else None

    def setUp(self):
        with closing(sqlite3.connect(self.database)) as connection:
            with connection:
                connection.execute('DELETE FROM trades')
                connection.execute('DELETE FROM instruments')
                connection.execute('DELETE FROM settings')
        self.assertEqual(self.request('/instruments', 'POST', {'code': '510300', 'name': '沪深300ETF', 'kind': 'etf'})[0], 201)

    def test_security_search_rejects_invalid_queries_without_changing_ledger(self):
        for query in ('51', 'bad%21', '5103007'):
            self.assertEqual(self.request('/instruments/search?q=' + query)[0], 422)
        self.assertEqual(len(self.request('/portfolio')[1]['instruments']), 1)

    def payload(self, side='buy', quantity=1000, price='3.815', fee='5', date='2026-01-01T10:00:00', lot=None):
        return {'code': '510300', 'side': side, 'quantity': quantity, 'price': price, 'fee': fee,
                'executed_at': date, 'note': '测试', 'buy_lot_id': lot}

    def test_record_persists_and_roundtrips(self):
        status, _ = self.request('/trades', 'POST', self.payload())
        self.assertEqual(status, 201)
        portfolio = self.request('/portfolio')[1]['instruments'][0]
        self.assertEqual(portfolio['quantity'], 1000)
        self.assertEqual(float(portfolio['average_cost']), 3.82)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute('SELECT price FROM trades').fetchone()[0], '3.815')

    def test_invalid_sell_rollback(self):
        self.request('/trades', 'POST', self.payload())
        status, _ = self.request('/trades', 'POST', self.payload('sell', quantity=1001, date='2026-01-02T10:00:00'))
        self.assertEqual(status, 422)
        self.assertEqual(len(self.request('/portfolio')[1]['instruments'][0]['trades']), 1)

    def test_edit_and_delete_revalidate_following_sells(self):
        buy_id = self.request('/trades', 'POST', self.payload())[1]['id']
        sell_id = self.request('/trades', 'POST', self.payload('sell', quantity=500, price='4', date='2026-01-02T10:00:00'))[1]['id']
        self.assertEqual(self.request(f'/trades/{buy_id}', 'PUT', self.payload(quantity=400))[0], 422)
        self.assertEqual(self.request(f'/trades/{buy_id}', 'DELETE')[0], 422)
        self.assertEqual(self.request('/portfolio')[1]['instruments'][0]['quantity'], 500)
        self.assertEqual(self.request(f'/trades/{sell_id}', 'DELETE')[0], 204)
        self.assertEqual(self.request(f'/trades/{buy_id}', 'DELETE')[0], 204)
        self.assertEqual(self.request('/portfolio')[1]['instruments'][0]['quantity'], 0)

    def test_successful_edit_changes_cost(self):
        buy_id = self.request('/trades', 'POST', self.payload())[1]['id']
        self.assertEqual(self.request(f'/trades/{buy_id}', 'PUT', self.payload(price='4.2'))[0], 200)
        self.assertEqual(float(self.request('/portfolio')[1]['instruments'][0]['cost']), 4205)

    def test_edit_preserves_broker_amount_unless_price_or_quantity_changes(self):
        trade_id = self.request('/trades', 'POST', self.payload(quantity=2100, price='2.356', fee='0.25'))[1]['id']
        with closing(sqlite3.connect(self.database)) as connection:
            with connection:
                connection.execute('UPDATE trades SET gross_amount=? WHERE id=?', ('4948.400', trade_id))
        payload = self.payload(quantity=2100, price='2.356', fee='0.25')
        payload['note'] = '修改备注'
        self.assertEqual(self.request(f'/trades/{trade_id}', 'PUT', payload)[0], 200)
        saved = self.request('/portfolio')[1]['instruments'][0]
        self.assertEqual(saved['trades'][0]['gross_amount'], '4948.400')
        self.assertEqual(float(saved['cost']), 4948.65)
        self.assertEqual(self.request(f'/trades/{trade_id}', 'PUT', {**payload, 'price': '2.4'})[0], 200)
        saved = self.request('/portfolio')[1]['instruments'][0]
        self.assertIsNone(saved['trades'][0]['gross_amount'])
        self.assertEqual(float(saved['cost']), 5040.25)

    def test_backup_and_csv(self):
        payload = self.payload()
        payload['note'] = '=1+1'
        self.request('/trades', 'POST', payload)
        status, content = self.request('/export', raw=True)
        self.assertEqual(status, 200)
        self.assertTrue(content.startswith(b'\xef\xbb\xbf'))
        self.assertIn("'=1+1", content.decode('utf-8-sig'))
        status, backup = self.request('/backup', raw=True)
        self.assertEqual(status, 200)
        self.assertTrue(backup.startswith(b'SQLite format 3'))
        connection = sqlite3.connect(':memory:')
        connection.deserialize(backup)
        self.assertEqual(connection.execute('SELECT COUNT(*) FROM trades').fetchone()[0], 1)
        connection.close()

    def test_input_constraints(self):
        for patch in ({'quantity': 0}, {'quantity': 1.5}, {'price': 'NaN'}, {'price': '-1'}, {'fee': '-1'}):
            self.assertEqual(self.request('/trades', 'POST', {**self.payload(), **patch})[0], 422)
        self.assertEqual(self.request('/instruments', 'POST', {'code': '510300', 'name': '重复', 'kind': 'etf'})[0], 409)

    def test_specific_batch_in_another_instrument_is_rejected(self):
        self.request('/instruments', 'POST', {'code': '600519', 'name': '贵州茅台', 'kind': 'stock'})
        foreign_id = self.request('/trades', 'POST', {**self.payload(), 'code': '600519'})[1]['id']
        self.request('/trades', 'POST', self.payload())
        status, _ = self.request('/trades', 'POST', self.payload('sell', quantity=10, date='2026-01-02T10:00:00', lot=foreign_id))
        self.assertEqual(status, 422)

    def test_fee_settings_and_estimate(self):
        settings = {'stock': {'commission_rate': '1', 'minimum_fee': '5'},
                    'etf': {'commission_rate': '2.5', 'minimum_fee': '0.1'}}
        self.assertEqual(self.request('/settings/fees', 'PUT', settings)[0], 200)
        self.assertEqual(self.request('/settings/fees')[1], settings)
        self.assertEqual(self.request('/fees/estimate', 'POST', {'kind': 'etf', 'price': '4', 'quantity': 1000})[1]['fee'], '1.00')
        self.assertEqual(self.request('/fees/estimate', 'POST', {'kind': 'stock', 'price': '4', 'quantity': 1000})[1]['fee'], '5.00')
        self.assertEqual(self.request('/fees/estimate', 'POST', {'kind': 'stock', 'price': '4', 'quantity': 100000})[1]['fee'], '40.00')
        # Settings are persisted in the backup, without recalculating existing trades.
        self.request('/trades', 'POST', self.payload(fee='7'))
        self.request('/settings/fees', 'PUT', {**settings, 'etf': {'commission_rate': '3', 'minimum_fee': '5'}})
        self.assertEqual(self.request('/portfolio')[1]['instruments'][0]['trades'][0]['fee'], '7')
        backup = self.request('/backup', raw=True)[1]
        connection = sqlite3.connect(':memory:')
        connection.deserialize(backup)
        self.assertEqual(json.loads(connection.execute("SELECT value FROM settings WHERE key='commission'").fetchone()[0])['stock'], settings['stock'])
        connection.close()

    def test_fee_rounding_and_invalid_settings(self):
        settings = {'stock': {'commission_rate': '10000', 'minimum_fee': '0'},
                    'etf': {'commission_rate': '0', 'minimum_fee': '0'}}
        self.request('/settings/fees', 'PUT', settings)
        self.assertEqual(self.request('/fees/estimate', 'POST', {'kind': 'stock', 'price': '10.005', 'quantity': 1})[1]['fee'], '10.01')
        self.assertEqual(self.request('/fees/estimate', 'POST', {'kind': 'etf', 'price': '10', 'quantity': 100})[1]['fee'], '0.00')
        for invalid in ({'commission_rate': '-1', 'minimum_fee': '0'}, {'commission_rate': 'NaN', 'minimum_fee': '0'},
                        {'commission_rate': '2.5', 'minimum_fee': '-1'}, {'commission_rate': '2.5', 'minimum_fee': '0.001'}):
            self.assertEqual(self.request('/settings/fees', 'PUT', {**settings, 'etf': invalid})[0], 422)
        self.assertEqual(self.request('/settings/fees')[1], settings)

    def size_payload(self, **updates):
        return {'code': '510300', 'side': 'buy', 'price': '4', 'portion': 1, 'budget': '4000',
                'executed_at': '2026-01-10T10:00:00', **updates}

    def test_buy_size_reserves_minimum_fee_and_rounds_down(self):
        settings = {'stock': {'commission_rate': '0', 'minimum_fee': '0'},
                    'etf': {'commission_rate': '2.5', 'minimum_fee': '5'}}
        self.request('/settings/fees', 'PUT', settings)
        self.assertEqual(self.request('/trades/size', 'POST', self.size_payload())[1]['quantity'], 900)
        self.assertEqual(self.request('/trades/size', 'POST', self.size_payload(portion=2))[1]['quantity'], 400)
        self.assertEqual(self.request('/trades/size', 'POST', self.size_payload(budget='4005'))[1]['quantity'], 1000)
        self.assertEqual(self.request('/trades/size', 'POST', self.size_payload(budget='404'))[1]['quantity'], 0)
        self.assertEqual(self.request('/trades/size', 'POST', self.size_payload(budget='4005', manual_fee='10'))[1]['quantity'], 900)

    def test_buy_third_uses_exact_integer_portion(self):
        self.assertEqual(self.request('/trades/size', 'POST', self.size_payload(price='1', budget='900', portion=3))[1]['quantity'], 300)

    def test_sell_size_uses_historical_holdings_and_keeps_odd_lots(self):
        self.request('/trades', 'POST', self.payload(quantity=1050))
        self.request('/trades', 'POST', self.payload('sell', quantity=350, date='2026-01-20T10:00:00'))
        self.assertEqual(self.request('/trades/size', 'POST', self.size_payload(side='sell'))[1]['quantity'], 1050)
        self.assertEqual(self.request('/trades/size', 'POST', self.size_payload(side='sell', portion=2))[1]['quantity'], 500)
        self.assertEqual(self.request('/trades/size', 'POST', self.size_payload(side='sell', executed_at='2026-01-25T10:00:00'))[1]['quantity'], 700)
        self.assertEqual(self.request('/trades/size', 'POST', self.size_payload(side='sell', executed_at='2025-12-25T10:00:00'))[1]['quantity'], 0)

    def test_sell_size_respects_target_lot_and_excludes_edited_sell(self):
        first = self.request('/trades', 'POST', self.payload(quantity=600))[1]['id']
        second = self.request('/trades', 'POST', self.payload(quantity=300, date='2026-01-02T10:00:00'))[1]['id']
        sell = self.request('/trades', 'POST', self.payload('sell', quantity=200, date='2026-01-03T10:00:00', lot=first))[1]['id']
        self.assertEqual(self.request('/trades/size', 'POST', self.size_payload(side='sell', buy_lot_id=second))[1]['quantity'], 300)
        self.assertEqual(self.request('/trades/size', 'POST', self.size_payload(side='sell', buy_lot_id=first))[1]['quantity'], 400)
        result = self.request('/trades/size', 'POST', self.size_payload(side='sell', executed_at='2026-01-03T10:00:00', exclude_trade_id=sell))[1]
        self.assertEqual(result['quantity'], 900)

    def test_size_does_not_write_trades_and_rejects_bad_inputs(self):
        self.request('/trades/size', 'POST', self.size_payload())
        self.assertEqual(self.request('/portfolio')[1]['instruments'][0]['trades'], [])
        for patch in ({'portion': 0}, {'budget': '-1'}, {'price': '0'}, {'price': 'NaN'}, {'exclude_trade_id': 99999}):
            self.assertEqual(self.request('/trades/size', 'POST', self.size_payload(**patch))[0], 422)

    def test_account_cash_persists_and_is_used_for_buy_size(self):
        self.assertEqual(self.request('/settings/account')[1], {'available_cash': '0'})
        self.assertEqual(self.request('/settings/account', 'PUT', {'available_cash': '4000'})[0], 200)
        self.assertEqual(self.request('/settings/account')[1], {'available_cash': '4000'})
        payload = self.size_payload()
        del payload['budget']
        self.assertEqual(self.request('/trades/size', 'POST', payload)[1]['quantity'], 1000)
        self.assertEqual(self.request('/trades/size', 'POST', {**payload, 'portion': 2})[1]['quantity'], 500)
        self.request('/trades', 'POST', self.payload())
        self.assertEqual(self.request('/settings/account')[1], {'available_cash': '4000'})
        for cash in ('-1', 'NaN', '0.001'):
            self.assertEqual(self.request('/settings/account', 'PUT', {'available_cash': cash})[0], 422)
        self.assertEqual(self.request('/settings/account')[1], {'available_cash': '4000'})
        connection = sqlite3.connect(':memory:')
        try:
            connection.deserialize(self.request('/backup', raw=True)[1])
            value = connection.execute("SELECT value FROM settings WHERE key='account'").fetchone()[0]
            self.assertEqual(json.loads(value), {'available_cash': '4000'})
        finally:
            connection.close()

    def test_sell_preview_shows_loss_and_does_not_write(self):
        self.request('/trades', 'POST', self.payload(quantity=100, price='10', fee='5'))
        sale = self.payload('sell', quantity=100, price='9', fee='5', date='2026-01-02T10:00:00')
        status, result = self.request('/trades/preview', 'POST', sale)
        self.assertEqual(status, 200)
        self.assertEqual(result, {'realized_pnl': '-110.00', 'buy_cost': '1005.00', 'sell_amount': '900.00', 'sell_fee': '5.00'})
        saved = self.request('/portfolio')[1]['instruments'][0]
        self.assertEqual(len(saved['trades']), 1)
        self.assertEqual(saved['quantity'], 100)
        self.assertEqual(self.request('/trades/preview', 'POST', {**sale, 'quantity': 101})[0], 422)

    def test_sell_preview_fifo_and_selected_batch_match_saved_profit(self):
        self.request('/trades', 'POST', self.payload(quantity=100, price='10', fee='5'))
        second = self.request('/trades', 'POST', self.payload(quantity=100, price='12', fee='5', date='2026-01-02T10:00:00'))[1]['id']
        sale = self.payload('sell', quantity=50, price='11', fee='5', date='2026-01-03T10:00:00')
        self.assertEqual(self.request('/trades/preview', 'POST', sale)[1]['realized_pnl'], '42.50')
        selected = {**sale, 'buy_lot_id': second}
        result = self.request('/trades/preview', 'POST', selected)[1]
        self.assertEqual(result['realized_pnl'], '-57.50')
        self.request('/trades', 'POST', selected)
        saved = self.request('/portfolio')[1]['instruments'][0]['trades'][0]
        self.assertEqual(float(saved['realized_pnl']), float(result['realized_pnl']))

    def test_sell_preview_edit_excludes_original_sale_and_future_buys(self):
        self.request('/trades', 'POST', self.payload(quantity=100, price='10', fee='5'))
        sale = self.payload('sell', quantity=40, price='12', fee='5', date='2026-01-02T10:00:00')
        identifier = self.request('/trades', 'POST', sale)[1]['id']
        self.request('/trades', 'POST', self.payload(quantity=50, price='30', date='2026-01-03T10:00:00'))
        status, result = self.request('/trades/preview', 'POST', {**sale, 'quantity': 75, 'editing_id': identifier})
        self.assertEqual(status, 200)
        self.assertEqual(result['realized_pnl'], '141.25')
        self.assertEqual(self.request('/trades/preview', 'POST', {**sale, 'quantity': 101, 'editing_id': identifier})[0], 422)

    def test_buy_profit_goal_persists_and_updates(self):
        buy = {**self.payload(quantity=100, price='10', fee='5'), 'target_profit_percent': '5'}
        identifier = self.request('/trades', 'POST', buy)[1]['id']
        item = self.request('/portfolio')[1]['instruments'][0]
        self.assertEqual(item['lots'][0]['target_profit_percent'], '5')
        self.assertEqual(item['trades'][0]['target_profit_percent'], '5')
        below = self.request('/targets/510300?price=10.5524')[1]['targets'][0]
        self.assertFalse(below['reached'])
        self.assertTrue(self.request('/targets/510300?price=10.5525')[1]['targets'][0]['reached'])
        self.request('/trades/' + str(identifier), 'PUT', self.payload(quantity=100, price='10', fee='5'))
        self.assertIsNone(self.request('/portfolio')[1]['instruments'][0]['lots'][0]['target_profit_percent'])
        self.assertEqual(self.request('/targets/510300?price=11')[1]['targets'], [])

    def test_goal_includes_buy_fee_and_estimated_sell_commission(self):
        self.request('/settings/fees', 'PUT', {'stock': {'commission_rate': '0', 'minimum_fee': '0'},
                                            'etf': {'commission_rate': '0', 'minimum_fee': '5'}})
        identifier = self.request('/trades', 'POST', {**self.payload(quantity=100, price='10', fee='5'), 'target_profit_percent': '5'})[1]['id']
        self.assertFalse(self.request('/targets/510300?price=10.6')[1]['targets'][0]['reached'])
        target = self.request('/targets/510300?price=10.6025')[1]['targets'][0]
        self.assertTrue(target['reached'])
        self.assertEqual(float(target['profit']), 50.25)
        self.assertEqual(float(target['target_profit']), 50.25)
        self.assertEqual(self.request('/trades/' + str(identifier), 'PUT', {**self.payload(quantity=100, price='10', fee='5'), 'target_profit_amount': '100'})[0], 200)
        lot = self.request('/portfolio')[1]['instruments'][0]['lots'][0]
        self.assertIsNone(lot['target_profit_percent'])
        self.assertEqual(lot['target_profit_amount'], '100')

    def test_amount_goal_prorates_after_partial_sell_and_closed_lots_skip(self):
        self.request('/trades', 'POST', {**self.payload(quantity=200, price='10', fee='0'), 'target_profit_amount': '100'})
        self.request('/trades', 'POST', self.payload('sell', quantity=100, price='10', fee='0', date='2026-01-02T10:00:00'))
        target = self.request('/targets/510300?price=10.5')[1]['targets'][0]
        self.assertTrue(target['reached'])
        self.assertEqual(float(target['target_profit']), 50)
        self.request('/trades', 'POST', self.payload('sell', quantity=100, price='10.5', fee='0', date='2026-01-03T10:00:00'))
        self.assertEqual(self.request('/targets/510300?price=11')[1]['targets'], [])

    def test_profit_goal_validation(self):
        for extra in ({'target_profit_percent': '-1'}, {'target_profit_amount': '-1'},
                      {'target_profit_percent': '3', 'target_profit_amount': '100'}, {'target_profit_percent': 'NaN'}):
            self.assertEqual(self.request('/trades', 'POST', {**self.payload(), **extra})[0], 422)
        self.assertEqual(self.request('/trades', 'POST', {**self.payload('sell'), 'target_profit_percent': '3'})[0], 422)


if __name__ == '__main__':
    unittest.main()
