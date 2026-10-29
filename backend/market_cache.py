"""Cache fast quote snapshots separately from slower chart requests."""
import threading
import time


class MarketBusy(Exception):
    pass


class MarketCache:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(2)
        self.quotes = {}
        self.histories = {}
        self.intradays = {}

    def publish_quote(self, code, quote):
        with self.lock:
            self.quotes[code] = (self.clock(), {'source': quote['source'], 'quote': quote, 'warnings': []})

    def get(self, code, history, intraday, fetch, *, refresh=True, force_quote=False):
        now = self.clock()
        with self.lock:
            quote = self.quotes.get(code)
            candles = self.histories.get(code)
            minutes = self.intradays.get(code)
        previous_quote = quote
        quote_fresh = quote is not None and quote[1].get('quote') is not None and now - quote[0] < 2
        history_fresh = candles is not None and now - candles[0] < 600
        intraday_fresh = minutes is not None and now - minutes[0] < 30
        need_history = bool(history and not history_fresh)
        need_intraday = bool(intraday and not intraday_fresh)
        chart_warnings = []
        if refresh and (force_quote or not quote_fresh or need_history or need_intraday):
            if not self.slots.acquire(blocking=False):
                raise MarketBusy()
            try:
                response = fetch(need_history, need_intraday)
                stamp = self.clock()
                warnings = response.get('warnings', [])
                chart_warnings = [warning for warning in warnings if warning in ('分时行情获取失败', '历史行情获取失败')]
                quote_data = {key: response.get(key) for key in ('source', 'quote')}
                quote_data['warnings'] = [warning for warning in warnings if warning not in chart_warnings]
                if need_history and response.get('history'):
                    candles = (stamp, {'history': response.get('history', []), 'history_source': response.get('history_source')})
                if need_intraday and response.get('intraday'):
                    minutes = (stamp, {key: response.get(key) for key in ('intraday', 'intraday_date', 'intraday_fetched_at')})
                with self.lock:
                    latest = self.quotes.get(code)
                    if latest and latest[1].get('quote') is not None and (
                            quote_data.get('quote') is None or latest is not previous_quote):
                        # A slow chart request must not overwrite a newer push.
                        quote = latest
                        if quote_data.get('quote') is None:
                            quote = (latest[0], {**latest[1], 'warnings': list(dict.fromkeys(
                                [*latest[1]['warnings'], *quote_data['warnings']]))})
                    else:
                        quote = (stamp, quote_data)
                    self.quotes[code] = quote
                    if need_history and candles is not None and candles[1]['history']:
                        self.histories[code] = candles
                    if need_intraday and minutes is not None and minutes[1].get('intraday'):
                        self.intradays[code] = minutes
            finally:
                self.slots.release()
        snapshot = quote[1] if quote is not None else {'source': '公开行情', 'quote': None, 'warnings': []}
        result = {**snapshot, 'warnings': [*snapshot['warnings'], *chart_warnings],
                  'history': candles[1]['history'] if history and candles is not None else [],
                  'history_source': candles[1].get('history_source') if history and candles is not None else None,
                  'intraday': [], 'intraday_date': None, 'intraday_fetched_at': None}
        if intraday and minutes is not None:
            result.update(minutes[1])
        return result
