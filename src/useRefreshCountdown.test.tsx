import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRefreshCountdown } from './useRefreshCountdown';

beforeEach(() => {vi.useFakeTimers(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.restoreAllMocks();});

it('默认五秒，改变间隔立即重置，长时间刷新不会重叠请求', () => {
  const refresh = vi.fn(async () => {});
  const initial = {enabled: true, code: '513310', refreshing: false, revision: 0, onRefresh: refresh, intervalSeconds: 5};
  const {result, rerender} = renderHook(props => useRefreshCountdown(props), {initialProps: initial});
  expect(result.current.remaining).toBe(5);
  act(() => vi.advanceTimersByTime(4000));
  expect(result.current.remaining).toBe(1);
  act(() => vi.advanceTimersByTime(1000));
  expect(refresh).toHaveBeenCalledTimes(1);
  rerender({...initial, refreshing: true});
  act(() => vi.advanceTimersByTime(30000));
  expect(refresh).toHaveBeenCalledTimes(1);
  rerender({...initial, revision: 1, intervalSeconds: 10});
  expect(result.current.remaining).toBe(10);
  act(() => vi.advanceTimersByTime(9000));
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(1000));
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('倒计时到期只请求一次，刷新期间暂停，完成后重置下一轮', () => {
  const refresh = vi.fn(async () => {});
  const initial = {intervalSeconds: 30, enabled: true, code: '510300', refreshing: false, revision: 0, onRefresh: refresh};
  const {result, rerender} = renderHook(props => useRefreshCountdown(props), {initialProps: initial});
  act(() => vi.advanceTimersByTime(29000));
  expect(result.current.remaining).toBe(1); expect(refresh).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1000));
  expect(refresh).toHaveBeenCalledExactlyOnceWith('510300');
  rerender({...initial, refreshing: true});
  act(() => vi.advanceTimersByTime(60000));
  expect(refresh).toHaveBeenCalledTimes(1);
  rerender({...initial, revision: 1});
  expect(result.current.remaining).toBe(30);
  act(() => vi.advanceTimersByTime(30000));
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('页面隐藏暂停请求，返回、手动刷新完成、切换标的后重新倒计时，关闭不再刷新', () => {
  const refresh = vi.fn(async () => {});
  const initial = {intervalSeconds: 30, enabled: true, code: '510300', refreshing: false, revision: 0, onRefresh: refresh};
  const {result, rerender} = renderHook(props => useRefreshCountdown(props), {initialProps: initial});
  act(() => vi.advanceTimersByTime(10000));
  rerender({...initial, revision: 1});
  expect(result.current.remaining).toBe(30);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  act(() => vi.advanceTimersByTime(60000));
  expect(result.current.paused).toBe(true); expect(refresh).not.toHaveBeenCalled();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(result.current.remaining).toBe(30);
  act(() => vi.advanceTimersByTime(20000));
  rerender({...initial, code: '002437', revision: 1});
  expect(result.current.remaining).toBe(30);
  act(() => vi.advanceTimersByTime(30000));
  expect(refresh).toHaveBeenCalledExactlyOnceWith('002437');
  rerender({...initial, enabled: false});
  act(() => vi.advanceTimersByTime(60000));
  expect(refresh).toHaveBeenCalledTimes(1);
});
