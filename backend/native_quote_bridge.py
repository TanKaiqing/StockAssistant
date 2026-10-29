"""One shared read-only quote observer per API process; no listener or trading APIs."""
from __future__ import annotations

import atexit
import copy
import json
import math
import os
import re
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path

from .trading_session import is_trading_session, EXCHANGE_TIME

SOURCE = '同花顺主界面 · 本地桥接'
MAX_AGE = 12
BOOK_MAX_AGE = 15
BUILD_PROFILES = {
    '1787242618': {'architecture': 'ia32', 'record_rva': 0x12a8480,
                   'return_rva': 0x12a8556, 'convert_import_rva': 0x1997198},
    '1790057509': {'architecture': 'ia32', 'record_rva': 0x12b0ab0,
                   'return_rva': 0x12b0b86, 'convert_import_rva': 0x19d50f4},
}


class NativeQuoteBridge:
    def __init__(self):
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.thread = None
        self.prices = {}
        self.last_prices = {}
        self.quote_counts = {}
        self.received_quotes = 0
        self.connected_at = None
        self.client_build = None
        self.events = deque(maxlen=30)
        self.baselines = {}
        self.baseline_attempts = {}
        self.interests = {}
        self.state = 'idle'
        self.reason = ''
        self.pid = None
        self.publish = None

    def watch(self, codes):
        now = time.monotonic()
        with self.lock:
            if os.environ.get('STOCK_ASSISTANT_NATIVE_QUOTES', '1') == '0':
                self._state('unavailable', 'disabled')
                return
            self.interests = {c: expiry for c, expiry in self.interests.items() if expiry > now}
            for code in codes:
                if re.fullmatch(r'[0-9]{6}', code) and (code in self.interests or len(self.interests) < 200):
                    self.interests[code] = now + 90
            if self.thread is None and os.name == 'nt' and os.environ.get('STOCK_ASSISTANT_NATIVE_QUOTES', '1') != '0':
                self.thread = threading.Thread(target=self._run, name='native-quote-bridge', daemon=True)
                self.thread.start()

    def _state(self, state, reason=''):
        with self.lock:
            if (state, reason) != (self.state, self.reason):
                self.events.append({'time': datetime.now(EXCHANGE_TIME).isoformat(timespec='seconds'),
                                    'status': state, 'reason': reason})
            self.state, self.reason = state, reason
            if state != 'attached':
                self.prices.clear()
                self.pid = None

    def _message(self, message, _data):
        if message.get('type') != 'send':
            if self.reason != 'unsupported_build':
                self._state('unavailable', 'observer_error')
            return
        data = message.get('payload')
        if isinstance(data, dict) and data.get('type') == 'build':
            stamp, arch = data.get('timestamp'), data.get('architecture')
            if type(stamp) is int and arch in ('ia32', 'x64', 'arm', 'arm64'):
                with self.lock:
                    profile = BUILD_PROFILES.get(str(stamp))
                    self.client_build = {'timestamp': stamp, 'architecture': arch,
                                         'supported': bool(profile and profile['architecture'] == arch)}
                    if not self.client_build['supported']:
                        self._state('unavailable', 'unsupported_build')
            return
        if not isinstance(data, dict) or data.get('type') != 'quote' or not is_trading_session():
            return
        code, price = data.get('code'), data.get('price')
        if not isinstance(code, str) or isinstance(price, bool) or not isinstance(price, (float, int)):
            return
        if not math.isfinite(price) or not 0 < price < 1000000:
            return
        now = time.monotonic()
        with self.lock:
            if self.state != 'attached' or self.interests.get(code, 0) <= now:
                return
            self.prices[code] = (now, {'price': price, 'fetched_at': datetime.now(EXCHANGE_TIME).isoformat(timespec='milliseconds')})
            self.last_prices[code] = self.prices[code]
            self.received_quotes += 1
            self.quote_counts[code] = self.quote_counts.get(code, 0) + 1
            callback = self.publish
        if callback:
            callback(code, self.quote(code))

    def baseline(self, code, quote):
        if not isinstance(quote, dict) or quote.get('source') == SOURCE:
            return
        with self.lock:
            self.baselines[code] = (time.monotonic(), copy.deepcopy(quote), datetime.now(EXCHANGE_TIME).date())

    def baseline_age(self, code):
        with self.lock:
            item = self.baselines.get(code)
        return time.monotonic() - item[0] if item else float('inf')

    def claim_baseline(self, code, interval=15):
        """Coalesce metadata lookups from multiple pages and REST requests."""
        now = time.monotonic()
        with self.lock:
            if now - self.baseline_attempts.get(code, float('-inf')) < interval:
                return False
            self.baseline_attempts[code] = now
            return True

    def quote(self, code, base=None):
        with self.lock:
            item = self.prices.get(code)
            baseline = self.baselines.get(code)
            attached = self.state == 'attached'
        if not attached or not item or time.monotonic() - item[0] > MAX_AGE:
            return None
        metadata = {}
        if baseline and baseline[2] == datetime.now(EXCHANGE_TIME).date():
            metadata = baseline[1]
        previous = metadata.get('previous_close')
        if isinstance(previous, bool) or not isinstance(previous, (float, int)) or not math.isfinite(previous) or previous <= 0:
            previous = None
        price = item[1]['price']
        book_fresh = baseline and baseline[2] == datetime.now(EXCHANGE_TIME).date() and time.monotonic() - baseline[0] <= BOOK_MAX_AGE
        return {**item[1], 'source': SOURCE, 'quote_time': None,
                'previous_close': previous,
                'change_percent': (price / previous - 1) * 100 if previous else None,
                'bids': copy.deepcopy(metadata.get('bids', [])) if book_fresh else [],
                'asks': copy.deepcopy(metadata.get('asks', [])) if book_fresh else [],
                'book_source': metadata.get('source') if book_fresh else None,
                'book_fetched_at': metadata.get('fetched_at') if book_fresh else None}

    def status(self):
        with self.lock:
            now = time.monotonic()
            codes = sorted(code for code, expiry in self.interests.items() if expiry > now)
            quotes = []
            for code in codes:
                item, baseline = self.last_prices.get(code), self.baselines.get(code)
                age = round(max(0, now - item[0]), 1) if item else None
                fresh = self.state == 'attached' and code in self.prices and now - self.prices[code][0] <= MAX_AGE
                quotes.append({'code': code, 'fresh': fresh, 'price': item[1]['price'] if item else None,
                               'fetched_at': item[1]['fetched_at'] if item else None, 'age_seconds': age,
                               'received_quotes': self.quote_counts.get(code, 0),
                               'fallback_source': baseline[1].get('source') if baseline else None,
                               'fallback_fetched_at': baseline[1].get('fetched_at') if baseline else None})
            return {'status': self.state, 'reason': self.reason, 'process_id': self.pid,
                    'fresh_quotes': sum(item['fresh'] for item in quotes), 'source': SOURCE,
                    'enabled': os.name == 'nt' and os.environ.get('STOCK_ASSISTANT_NATIVE_QUOTES', '1') != '0',
                    'trading_session': is_trading_session(), 'watched_quotes': len(codes),
                    'received_quotes': self.received_quotes, 'connected_at': self.connected_at,
                    'client_build': copy.deepcopy(self.client_build),
                    'supported_build': {'timestamp': 1790057509, 'architecture': 'ia32'},
                    'supported_builds': [{'timestamp': int(stamp), 'architecture': profile['architecture']}
                                         for stamp, profile in BUILD_PROFILES.items()],
                    'max_age_seconds': MAX_AGE, 'book_max_age_seconds': BOOK_MAX_AGE,
                    'retry_seconds': 10, 'quotes': quotes, 'events': list(reversed(self.events)),
                    'server_time': datetime.now(EXCHANGE_TIME).isoformat(timespec='milliseconds')}

    def _run(self):
        try:
            import frida
        except ImportError:
            self._state('unavailable', 'dependency_missing')
            return
        try:
            script_source = Path(__file__).with_name('native_quote_agent.js').read_text(encoding='utf-8')
            script_source = 'const bridgeProfiles = ' + json.dumps(BUILD_PROFILES) + ';\n' + script_source
        except OSError:
            self._state('unavailable', 'observer_missing')
            return
        while not self.stop_event.is_set():
            session = None
            detached = threading.Event()
            try:
                with self.lock:
                    interested = any(expiry > time.monotonic() for expiry in self.interests.values())
                if not is_trading_session() or not interested:
                    self._state('paused', 'off_hours' if not is_trading_session() else 'no_symbols')
                    self.stop_event.wait(1)
                    continue
                self._state('connecting')
                with self.lock:
                    self.client_build = None
                device = frida.get_local_device()
                process = next((p for p in device.enumerate_processes() if p.name.lower() == 'hexin.exe'), None)
                if process is None:
                    self._state('unavailable', 'client_not_running')
                    self.stop_event.wait(10)
                    continue
                session = device.attach(process.pid)
                session.on('detached', lambda *_: detached.set())
                script = session.create_script(script_source)
                ready = threading.Event()
                def receive(message, data):
                    if message.get('type') == 'send' and message.get('payload') == {'type': 'ready'}:
                        ready.set()
                    else:
                        self._message(message, data)
                script.on('message', receive)
                script.load()
                # A failed load (including an unsupported build) must not become attached.
                loaded = ready.wait(2)
                with self.lock:
                    if not loaded or self.state == 'unavailable':
                        raise RuntimeError('unsupported_observer')
                    self.pid = process.pid
                    self.connected_at = datetime.now(EXCHANGE_TIME).isoformat(timespec='seconds')
                    self._state('attached')
                configured = None
                while not self.stop_event.is_set() and not detached.is_set() and is_trading_session():
                    with self.lock:
                        if self.state != 'attached':
                            raise RuntimeError('observer_stopped')
                        codes = sorted(c for c, expiry in self.interests.items() if expiry > time.monotonic())
                    if not codes:
                        break
                    if codes != configured:
                        script.exports_sync.configure(codes, True)
                        configured = codes
                    if self.stop_event.wait(.5):
                        break
            except Exception:
                # Never relay native errors, process memory, or credentials.
                if self.reason not in ('unsupported_build', 'observer_error'):
                    self._state('unavailable', 'attach_failed')
                self.stop_event.wait(10)
            finally:
                if session is not None:
                    try:
                        session.detach()
                    except Exception:
                        pass
                if self.state in ('attached', 'connecting'):
                    self._state('idle' if is_trading_session() else 'paused',
                                '' if is_trading_session() else 'off_hours')

    def close(self):
        self.stop_event.set()
        thread = self.thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=2)


native_bridge = NativeQuoteBridge()
atexit.register(native_bridge.close)
