import unittest
from backend.market_cache import MarketBusy, MarketCache


class MarketCacheTests(unittest.TestCase):
    def test_five_second_price_refresh_reuses_charts_until_their_own_expiry(self):
        now = [0]
        cache = MarketCache(lambda: now[0])
        calls = []
        def fetch(history, intraday):
            calls.append((history, intraday))
            return {'source': '同花顺', 'quote': {'price': 4 + len(calls), 'fetched_at': str(now[0])},
                    'history': [{'time': '2026-10-14'}] if history else [],
                    'intraday': [{'time': 1, 'price': 4}] if intraday else [],
                    'intraday_date': '2026-10-14' if intraday else None,
                    'intraday_fetched_at': str(now[0]) if intraday else None, 'warnings': []}
        first = cache.get('513310', True, True, fetch)
        now[0] = 1
        self.assertEqual(cache.get('513310', True, True, fetch), first)
        now[0] = 5
        second = cache.get('513310', True, True, fetch)
        self.assertNotEqual(first['quote']['price'], second['quote']['price'])
        self.assertEqual(second['intraday_fetched_at'], '0')
        self.assertEqual(second['history'], first['history'])
        self.assertEqual(calls, [(True, True), (False, False)])
        now[0] = 31
        cache.get('513310', True, True, fetch)
        self.assertEqual(calls[-1], (False, True))
        now[0] = 601
        cache.get('513310', True, True, fetch)
        self.assertEqual(calls[-1], (True, True))

    def test_quote_only_and_chart_requests_share_the_quote_cache(self):
        cache = MarketCache(lambda: 0)
        calls = []
        def fetch(history, intraday):
            calls.append((history, intraday))
            return {'source': '同花顺', 'quote': {'price': 4}, 'history': [{'time': '2026-10-14'}], 'warnings': []}
        cache.get('513310', True, False, fetch)
        result = cache.get('513310', False, False, fetch)
        self.assertEqual(result['history'], [])
        self.assertEqual(len(calls), 1)

    def test_failed_chart_is_not_cached_and_does_not_hide_a_valid_quote(self):
        cache = MarketCache(lambda: 0)
        def fetch(history, intraday):
            return {'source': '同花顺', 'quote': {'price': 4}, 'history': [], 'intraday': [],
                    'intraday_date': None, 'intraday_fetched_at': None, 'warnings': ['分时行情获取失败']}
        result = cache.get('513310', False, True, fetch)
        self.assertEqual(result['quote']['price'], 4)
        self.assertEqual(result['warnings'], ['分时行情获取失败'])
        self.assertEqual(cache.get('513310', False, False, fetch)['warnings'], [])

    def test_bounded_parallelism_and_worker_failure_release_the_slot(self):
        cache = MarketCache(lambda: 0)
        cache.slots.acquire();cache.slots.acquire()
        try:
            with self.assertRaises(MarketBusy):
                cache.get('513310', False, False, lambda *_: {})
        finally:
            cache.slots.release();cache.slots.release()
        def failed(*_):
            raise ValueError('upstream failed')
        with self.assertRaises(ValueError):
            cache.get('513310', False, False, failed)
        self.assertTrue(cache.slots.acquire(blocking=False))
        self.assertTrue(cache.slots.acquire(blocking=False))
        cache.slots.release();cache.slots.release()


if __name__ == '__main__':
    unittest.main()
