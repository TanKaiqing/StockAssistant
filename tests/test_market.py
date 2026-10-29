import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

from backend.market_worker import fetch_tencent_quote, fetch_tencent_history, fetch_tencent_intraday, fetch_quote, run


class MarketTests(unittest.TestCase):
    def test_public_history_reports_its_actual_source(self):
        quote = {'source': '腾讯财经', 'price': 4, 'bids': [{'price': 4}], 'asks': [{'price': 4}]}
        with patch('backend.market_worker.fetch_quote', return_value=quote), patch('backend.market_worker.fetch_tencent_history', return_value=[{'time': '2026-10-14'}]):
            result = run('513310', 'etf', True)
            self.assertEqual(result['history_source'], '腾讯财经 · 不复权')

    def sample_response(self):
        # Tencent's actual ETF wire layout, reduced to fields used by this app.
        fields = [''] * 33
        fields[2:5] = ['510300', '4.360', '4.385']
        for i in range(5):
            fields[9 + i * 2] = str(4.360 - i * 0.001)
            fields[10 + i * 2] = str(5752 + i)
            fields[19 + i * 2] = str(4.361 + i * 0.001)
            fields[20 + i * 2] = str(6947 + i)
        fields[32] = '-0.57'
        return Mock(content=('v_sh510300="' + '~'.join(fields) + '";').encode('gbk'))

    @patch('requests.get')
    def test_shanghai_etf_and_five_levels(self, get):
        get.return_value = self.sample_response()
        result = fetch_tencent_quote('510300')
        self.assertEqual(get.call_args.args[0], 'https://qt.gtimg.cn/q=sh510300')
        self.assertEqual(result['price'], 4.36)
        self.assertEqual(result['change_percent'], -0.57)
        self.assertEqual(result['bids'][0], {'price': 4.36, 'volume': 575200.0})
        self.assertEqual(result['asks'][0], {'price': 4.361, 'volume': 694700.0})
        self.assertEqual(len(result['bids']), 5)
        self.assertEqual(len(result['asks']), 5)

    @patch('requests.get')
    def test_unadjusted_history_filters_dates_and_duplicates(self, get):
        day = datetime.now().strftime('%Y-%m-%d')
        old_day = (datetime.now() - timedelta(days=400)).strftime('%Y-%m-%d')
        rows = [[old_day, '1', '2', '3', '1'], [day, '4.384', '4.360', '4.408', '4.351']]
        get.return_value = Mock()
        get.return_value.json.return_value = {'data': {'sh510300': {'day': rows + rows}}}
        result = fetch_tencent_history('510300')
        self.assertEqual(result, [{'time': day, 'open': 4.384, 'close': 4.36, 'high': 4.408, 'low': 4.351}])

    @patch('backend.market_worker.fetch_eastmoney_quote')
    @patch('backend.market_worker.fetch_tencent_quote', side_effect=ValueError('Unavailable'))
    def test_quote_fallback(self, tencent, eastmoney):
        eastmoney.return_value = {'price': 4.36}
        self.assertEqual(fetch_quote('510300'), {'price': 4.36})
        eastmoney.assert_called_once_with('510300')

    @patch('backend.market_worker.fetch_quote', side_effect=ValueError('Unavailable'))
    def test_failure_keeps_ledger_independent(self, quote):
        result = run('510300', 'etf', False)
        self.assertIsNone(result['quote'])
        self.assertEqual(result['warnings'], ['最新行情获取失败'])

    @patch('requests.get')
    def test_intraday_uses_provider_date_beijing_time_and_valid_session_prices(self, get):
        get.return_value = Mock()
        get.return_value.json.return_value = {'data': {'sh510300': {'data': {'date': '20261013', 'data': [
            '0930 4.2 100', '0930 4.3 200', '1301 4.5 300', '1200 4.4 300', '9999 4.6 400', '1302 nan', '1303 -1']}}}}
        result = fetch_tencent_intraday('510300')
        self.assertEqual(result['intraday_date'], '2026-10-13')
        self.assertEqual(len(result['intraday']), 2)
        self.assertEqual(result['intraday'][0], {'time': 1791855000, 'price': 4.3})
        self.assertEqual(get.call_args.kwargs['params'], {'code': 'sh510300'})

    @patch('backend.market_worker.fetch_tencent_intraday', side_effect=ValueError('Unavailable'))
    @patch('backend.market_worker.fetch_quote', return_value={'source': '测试', 'price': 4.3, 'bids': [{'price': 4.3}], 'asks': [{'price': 4.4}]})
    def test_intraday_failure_keeps_valid_quote_and_does_not_invent_curve(self, quote, intraday):
        result = run('510300', 'etf', False, True)
        self.assertEqual(result['quote']['price'], 4.3)
        self.assertEqual(result['intraday'], [])
        self.assertIsNone(result['intraday_date'])
        self.assertEqual(result['warnings'], ['分时行情获取失败'])


if __name__ == '__main__':
    unittest.main()
