"""Relay shared main-client prices to SSE; public providers fill missing quotes."""
import asyncio
import json
from anyio import CancelScope

from .trading_session import is_trading_session
from .native_quote_bridge import native_bridge

def sse(event, data):
    return f'event: {event}\ndata: {json.dumps(data, ensure_ascii=False, allow_nan=False)}\n\n'


fallback_slots = None


async def fallback_snapshot(code):
    # A bounded number of metadata/missing-symbol lookups across SSE clients.
    global fallback_slots
    if fallback_slots is None:
        fallback_slots = asyncio.Semaphore(2)
    from .market_worker import fetch_quote
    async with fallback_slots:
        if not is_trading_session():
            return None
        return await asyncio.to_thread(fetch_quote, code)


async def quote_events(code, disconnected, publish):
    """Prefer shared main-client prices; public providers supply gaps and depth."""
    if not is_trading_session():
        yield sse('state', {'status': 'paused'})
        return
    multiple = not isinstance(code, str)
    codes = list(dict.fromkeys(code)) if multiple else [code]
    native_bridge.watch(codes)
    yield sse('state', {'status': 'connecting'})
    # The main client's quote cycle is about three seconds. Wait for the
    # shared bridge to attach/warm up before falling back to public polling.
    for _ in range(8):
        if await disconnected():
            return
        if not is_trading_session():
            yield sse('state', {'status': 'paused'})
            return
        if any(native_bridge.quote(security) for security in codes):
            break
        if native_bridge.status()['status'] == 'unavailable':
            break
        await asyncio.sleep(.5)
    if not any(native_bridge.quote(security) for security in codes):
        yield sse('state', {'status': 'fallback'})
        return
    # Browser streams share one native observer. The old two-session cap was
    # for separate CLI child processes and must not reject shared subscriptions.
    tasks, after, sent, last_sent = {}, {}, {}, {}
    loop = asyncio.get_running_loop()
    started = heartbeat = loop.time()
    try:
        while not await disconnected():
            if not is_trading_session():
                yield sse('state', {'status': 'paused'})
                return
            native_bridge.watch(codes)
            now = loop.time()
            for security in list(tasks):
                task = tasks[security]
                if not task.done():
                    continue
                tasks.pop(security)
                try:
                    baseline = task.result()
                    if baseline:
                        native_bridge.baseline(security, baseline)
                        quote = native_bridge.quote(security) or baseline
                        publish(security, quote)
                        sent[security] = quote['fetched_at']
                        last_sent[security] = now
                        yield sse('quote', {'code': security, 'quote': quote} if multiple else quote)
                except Exception:
                    pass
            for security in codes:
                quote = native_bridge.quote(security)
                if quote and quote['fetched_at'] != sent.get(security):
                    publish(security, quote)
                    sent[security], last_sent[security] = quote['fetched_at'], now
                    yield sse('quote', {'code': security, 'quote': quote} if multiple else quote)
                if (security not in tasks and len(tasks) < 2 and now >= after.get(security, 0)
                        and (not quote or native_bridge.baseline_age(security) >= 15)
                        and native_bridge.claim_baseline(security, 15 if quote else 5)):
                    after[security] = now + (15 if quote else 5)
                    tasks[security] = asyncio.create_task(fallback_snapshot(security))
            # Do not call a partially stalled subscription "live" indefinitely.
            if now - started > 15 and any(now - last_sent.get(security, started) > 15 for security in codes):
                break
            if not any(native_bridge.quote(security) for security in codes):
                break
            if now - heartbeat >= 5:
                heartbeat = now
                yield sse('heartbeat', {})
            await asyncio.sleep(.5)
    finally:
        # Starlette cancels its task group on disconnect; let cleanup finish
        # within that scope rather than abandoning metadata task cancellation.
        with CancelScope(shield=True):
            for task in tasks.values():
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks.values(), return_exceptions=True)
    yield sse('state', {'status': 'fallback'})
