import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useQuoteStream } from './useQuoteStream';

class FakeSource {
  static instances: FakeSource[] = [];
  closed = false;
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {};
  onerror: (() => void) | null = null;
  constructor(public url: string) {FakeSource.instances.push(this);}
  addEventListener(type: string, handler: (event: MessageEvent) => void) {(this.listeners[type] ??= []).push(handler);}
  close() {this.closed = true;}
  emit(type: string, payload: unknown) {this.listeners[type]?.forEach(handler => handler(new MessageEvent(type, {data: JSON.stringify(payload)})));}
}
const quote = {source: '同花顺', price: 4.2, fetched_at: '2026-10-14T14:30:00', bids: [], asks: []};
beforeEach(() => {
  vi.useFakeTimers(); FakeSource.instances = [];
  vi.stubGlobal('EventSource', FakeSource);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

it('StrictMode establishes one subscription and forwards successive price updates', () => {
  const onQuote = vi.fn();
  const {result} = renderHook(() => useQuoteStream({enabled: true, code: '513310', onQuote}), {wrapper: ({children}: {children: ReactNode}) => <StrictMode>{children}</StrictMode>});
  act(() => vi.advanceTimersByTime(0));
  expect(FakeSource.instances.length).toBe(1);
  expect(result.current.live).toBe(false);
  act(() => FakeSource.instances[0].emit('quote', quote));
  expect(result.current.live).toBe(true);
  act(() => FakeSource.instances[0].emit('quote', {...quote, price: 4.3}));
  expect(onQuote).toHaveBeenLastCalledWith('513310', {...quote, price: 4.3});
});

it('failure closes the subscription and retries after thirty seconds', () => {
  const onQuote = vi.fn();
  const {result, unmount} = renderHook(() => useQuoteStream({enabled: true, code: '513310', onQuote}));
  act(() => vi.advanceTimersByTime(0));
  const first = FakeSource.instances[0];
  act(() => first.emit('quote', quote));
  act(() => first.emit('state', {status: 'fallback'}));
  expect(first.closed).toBe(true);expect(result.current.live).toBe(false);
  act(() => vi.advanceTimersByTime(30000));
  expect(FakeSource.instances.length).toBe(2);
  act(() => first.emit('quote', {...quote, price: 99}));
  expect(onQuote).toHaveBeenCalledTimes(1);
  unmount(); expect(FakeSource.instances[1].closed).toBe(true);
});

it('changing code ignores old updates and hiding the page stops the native stream', () => {
  const onQuote = vi.fn(); const initial = {enabled: true, code: '513310', onQuote};
  const {result, rerender} = renderHook(props => useQuoteStream(props), {initialProps: initial});
  act(() => vi.advanceTimersByTime(0));
  const first = FakeSource.instances[0];act(() => first.emit('quote', quote));
  rerender({...initial, code: '513850'});
  expect(result.current.live).toBe(false);expect(first.closed).toBe(true);
  act(() => first.emit('quote', {...quote, price: 99}));
  expect(onQuote).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(0));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(FakeSource.instances[1].closed).toBe(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  act(() => vi.advanceTimersByTime(0));
  expect(FakeSource.instances.length).toBe(3);
});

it('a silent connection falls back even if its TCP connection stays open', () => {
  const {result} = renderHook(() => useQuoteStream({enabled: true, code: '513310', onQuote: vi.fn()}));
  act(() => vi.advanceTimersByTime(20000));
  expect(result.current.status).toBe('retrying');
  expect(FakeSource.instances[0].closed).toBe(true);
});
