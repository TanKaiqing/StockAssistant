import json
import unittest
from unittest.mock import Mock, patch

from backend.security_search import parse_suggestions, search


class SecuritySearchTests(unittest.TestCase):
    def test_candidates_filter_market_type_prefix_and_duplicates(self):
        entries = ['sh~513310~中韩芯片ETF~zhxp~QDII-ETF', 'sh~513310~重复~cf~ETF',
                   'sh~600513~联环药业~lhyy~GP-A', 'sh~513999~债券~zq~ZQ',
                   'hk~513000~港股~gg~GP-A', 'sh~513120~创新药ETF~cxy~ETF']
        text = 'v_hint=' + json.dumps('^'.join(entries))
        self.assertEqual(parse_suggestions(text, '513'), [
            {'code': '513310', 'name': '中韩芯片ETF', 'kind': 'etf'},
            {'code': '513120', 'name': '创新药ETF', 'kind': 'etf'}])
        stock = 'v_hint=' + json.dumps('sz~002437~誉衡药业~yhyy~GP-A')
        self.assertEqual(parse_suggestions(stock, '002437')[0]['kind'], 'stock')

    def test_empty_response_is_distinct_from_bad_upstream_data(self):
        self.assertEqual(parse_suggestions('v_hint="";', '000'), [])
        with self.assertRaises(ValueError):
            parse_suggestions('<html>bad gateway</html>', '000')

    @patch('requests.get')
    def test_read_only_query_has_bounded_timeout(self, get):
        get.return_value = Mock(text='v_hint="sh~510300~\\u6caa\\u6df1300ETF~hs300~ETF"')
        self.assertEqual(search('510300')[0]['name'], '沪深300ETF')
        self.assertEqual(get.call_args.kwargs['params'], {'q': '510300', 't': 'gp'})
        self.assertEqual(get.call_args.kwargs['timeout'], (3, 5))

    @patch('requests.get')
    def test_invalid_queries_do_not_contact_provider(self, get):
        for query in ['51', '5103007', 'https://example.com', 'a', '１２３', 'bad!']:
            with self.assertRaises(ValueError):
                search(query)
        get.assert_not_called()

    @patch('requests.get')
    def test_chinese_names_and_pinyin_return_supported_securities(self, get):
        get.return_value = Mock(text='v_hint=' + json.dumps('sh~000300~沪深300~hs300~ZS^sh~510300~沪深300ETF~hs300etf~ETF'))
        for query in ('沪深', 'hushen', 'hs300', '300ETF'):
            self.assertEqual(search(query), [{'code': '510300', 'name': '沪深300ETF', 'kind': 'etf'}])
            self.assertEqual(get.call_args.kwargs['params']['q'], query)


if __name__ == '__main__':
    unittest.main()
