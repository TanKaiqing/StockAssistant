import json
import subprocess
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from backend import broker


def document(payload, account_type='normal'):
    return {'ok': True, 'data': {'ok': True, 'account_type': account_type,
                               'is_credit': account_type == 'credit', 'data': payload}}


class BrokerTests(unittest.TestCase):
    def test_native_gbk_and_utf8_are_decoded_without_corrupting_names_or_sides(self):
        text = json.dumps({'name': '银河ETF', 'side': '买入'}, ensure_ascii=False)
        self.assertEqual(json.loads(broker.decode_output(text.encode('gbk')))['side'], '买入')
        self.assertEqual(json.loads(broker.decode_output(text.encode('utf-8-sig')))['name'], '银河ETF')

    def test_positions_only_return_display_fields_and_preserve_unknown_numbers(self):
        result = broker.normalize_query('positions', document({'position': {'one': {
            'zqdm': '513310', 'zqmc': '测试ETF', 'gpye': '200', 'kyye': '100',
            'cbj': '4.1230', 'sj': '4.20', 'sz': '840', 'yk': '-12.34',
            'account_id': 'sensitive-account', 'gddm': 'sensitive-shareholder',
            'token': 'sensitive-auth',
        }}}))
        self.assertEqual(result['rows'][0]['quantity'], '200')
        self.assertEqual(result['rows'][0]['profit'], '-12.34')
        self.assertNotIn('sensitive', json.dumps(result))
        self.assertIsNone(broker.number({'price': 'NaN'}, 'price'))
        self.assertIsNone(broker.number({'price': ''}, 'price'))

    def test_history_opaque_sensitive_columns_are_dropped_and_cash_fee_is_exact(self):
        rows = [
            {'xd_2141': '20261008', 'xd_2142': '09:36:06', 'xd_2102': '513310',
             'xd_2103': '测试ETF', 'xd_2109': '买入', 'xd_2131': '1880.0000',
             'xd_2110': '-1880.1000', 'xd_2106': 'sensitive-shareholder',
             'xd_2130': 'sensitive-identifier', 'xd_2908': 'sensitive-account'},
            {'xd_2109': '卖出', 'xd_2131': '229.1000', 'xd_2110': '229.0000'},
        ]
        result = broker.normalize_query('history-deals', document({'rows': rows}))
        self.assertEqual(result['rows'][0]['date'], '2026-10-08')
        self.assertEqual(result['rows'][0]['fee'], '0.1000')
        self.assertEqual(result['rows'][1]['fee'], '0.1000')
        self.assertNotIn('sensitive', json.dumps(result))

    def test_missing_assets_and_fees_are_not_fabricated_as_zero(self):
        result = broker.normalize_query('assets', document({'money': {'kyje': '0', 'kqje': ''}}))
        self.assertEqual(result['assets']['available_cash'], '0')
        self.assertIsNone(result['assets']['withdrawable_cash'])
        self.assertIsNone(broker.normalized_record({'xd_2109': '买入', 'xd_2131': '100'}, 0, True)['fee'])

    def test_unknown_structure_is_error_instead_of_empty_history(self):
        with self.assertRaises(HTTPException):
            broker.normalize_query('history-deals', document({'unexpected': []}))
        self.assertEqual(broker.normalize_query('history-delivery', document({'is_null': '1'}))['rows'], [])

    def test_credit_empty_deals_carry_the_native_trial_limitation(self):
        result = broker.normalize_query('deals', document({'deal': {}}, 'credit'))
        self.assertTrue(result['is_credit'])
        self.assertTrue(result['warnings'])
        invalid = document({'deal': {}})
        invalid['data']['is_credit'] = True
        with self.assertRaises(HTTPException):
            broker.normalize_query('deals', invalid)

    def test_grouped_native_records_preserve_multiple_rows_and_filter_secrets(self):
        first = {'zqdm': '513310', 'cz': '买入', 'cjjj': '1.123',
                 'wtjg': '1.125', 'cjsl': '100', 'cjsj': '093001',
                 'htbh': 'sensitive-contract', 'token': 'sensitive-token'}
        second = {**first, 'cjsl': '200', 'cjsj': '093002'}
        for command, key in [('deals', 'deal'), ('orders', 'fullorder'),
                             ('cancelable', 'order')]:
            with self.subTest(command=command):
                result = broker.normalize_query(command, document({key: {
                    '513310': [first, second], '513850': [],
                }}))
                self.assertEqual([row['quantity'] for row in result['rows']], ['100', '200'])
                self.assertEqual([row['id'] for row in result['rows']], [0, 1])
                self.assertEqual(result['rows'][1]['time'], '09:30:02')
                self.assertNotIn('sensitive', json.dumps(result))
        self.assertEqual(broker.normalized_record({'cjjj': '1.123'}, 0, False)['price'], '1.123')
        self.assertEqual(broker.normalized_record(first, 0, False)['price'], '1.125')

    def test_supported_row_containers_remain_compatible(self):
        row = {'zqdm': '513310'}
        for container in ([row], {'one': row}, {'one': [row]},
                          {'one': row, 'two': []}):
            self.assertEqual(broker.rows_from({'deal': container}, 'deal'), [row])
        for container in ([], {}, {'one': []}):
            self.assertEqual(broker.rows_from({'deal': container}, 'deal'), [])

    def test_malformed_group_rows_are_rejected_without_partial_results(self):
        for container in ({'one': [None]}, {'one': [[{}]]}, {'one': 'bad'},
                          {'one': [{'zqdm': '513310'}, 123]}, [[], {}]):
            with self.subTest(container=container), self.assertRaises(HTTPException):
                broker.rows_from({'deal': container}, 'deal')

    def test_cli_success_with_business_failure_is_rejected_without_echoing_secrets(self):
        native = {'ok': True, 'data': {'ok': False, 'error': 'sensitive-account'}}
        with patch.object(broker, 'tool_path', return_value=Path('xiadanctl.exe')), patch.object(
            broker.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(native), '')
        ):
            with self.assertRaises(HTTPException) as raised:
                broker.run_tool('positions')
        self.assertNotIn('sensitive-account', raised.exception.detail)

    def test_history_input_is_bom_free_utf8_and_deleted_after_cli_returns(self):
        input_paths = []
        def native_call(arguments, **kwargs):
            path = Path(arguments[arguments.index('--input') + 1])
            input_paths.append(path)
            value = path.read_bytes()
            self.assertFalse(value.startswith(b'\xef\xbb\xbf'))
            self.assertEqual(json.loads(value), {'start_date': '20261001', 'end_date': '20261014'})
            self.assertNotIn('shell', kwargs)
            return subprocess.CompletedProcess(arguments, 0, json.dumps(document({'rows': []})), '')
        with patch.object(broker, 'tool_path', return_value=Path('xiadanctl.exe')), patch.object(
            broker.subprocess, 'run', side_effect=native_call
        ):
            broker.run_tool('history-deals', {'start_date': '20261001', 'end_date': '20261014'})
        self.assertFalse(input_paths[0].exists())

    def test_disconnected_queries_dates_and_non_query_commands_never_invoke_business(self):
        with patch.object(broker, 'health_status', return_value={'ready': False, 'message': '客户端未登录'}), patch.object(broker, 'run_tool') as native:
            with self.assertRaises(HTTPException):
                broker.query('positions')
            native.assert_not_called()
        with patch.object(broker, 'run_tool') as native:
            with self.assertRaises(HTTPException):
                broker.query('history-deals', date.today(), date.today() - timedelta(days=1))
            native.assert_not_called()
        with patch.object(broker.subprocess, 'run') as native:
            with self.assertRaises(HTTPException):
                broker.run_tool('order-submit')
            native.assert_not_called()

    def test_only_one_native_query_can_run_and_lock_is_released_after_failure(self):
        broker.query_slot.acquire()
        try:
            with self.assertRaises(HTTPException) as raised:
                broker.query('positions')
            self.assertEqual(raised.exception.status_code, 409)
        finally:
            broker.query_slot.release()
        with patch.object(broker, 'health_status', side_effect=HTTPException(503, '断开')):
            with self.assertRaises(HTTPException):
                broker.query('positions')
        self.assertTrue(broker.query_slot.acquire(blocking=False))
        broker.query_slot.release()

    def test_timeout_returns_actionable_error_without_native_output(self):
        with patch.object(broker, 'tool_path', return_value=Path('xiadanctl.exe')), patch.object(
            broker.subprocess, 'run', side_effect=subprocess.TimeoutExpired('xiadanctl', 95)
        ):
            with self.assertRaises(HTTPException) as raised:
                broker.run_tool('positions')
        self.assertEqual(raised.exception.status_code, 504)


if __name__ == '__main__':
    unittest.main()
