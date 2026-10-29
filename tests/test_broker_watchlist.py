import unittest
from unittest.mock import patch
from fastapi import HTTPException
from backend import broker_watchlist as watch


class WatchTests(unittest.TestCase):
    def test_only_supported_display_fields_survive_watchlist(self):
        document = {'ok': True, 'data': {'ok': True, 'items': {'513310': '测试ETF', '002437': '股票', '1A0001': '上证指数'}, 'token': 'secret'}}
        with patch.object(watch.broker, 'invoke_tool', return_value=document):
            result = watch.read()
        self.assertEqual([row['code'] for row in result['rows']], ['513310', '002437'])
        self.assertEqual(result['skipped_count'], 1); self.assertNotIn('secret', str(result))

    def test_pending_watchlist_add_is_not_reported_as_confirmed(self):
        with patch.object(watch, 'ready'), patch.object(watch, 'read', return_value={'rows': [], 'skipped_count': 0}), patch.object(watch.time, 'sleep'), patch.object(watch.broker, 'invoke_tool', return_value={'ok': True, 'data': {'ok': True, 'pending': True}}) as native:
            result = watch.add(watch.Security(code='513310'))
            self.assertFalse(result['confirmed'])
            self.assertEqual(native.call_args_list[0].args, ('watchlist-add', {'code': '513310'}))

    def test_unknown_structure_is_error_not_empty_watchlist(self):
        with patch.object(watch.broker, 'invoke_tool', return_value={'ok': True, 'data': {'ok': True, 'unexpected': []}}):
            with self.assertRaises(HTTPException):
                watch.read()
