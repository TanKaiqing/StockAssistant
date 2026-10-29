import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MouseEventParams, Time } from 'lightweight-charts';
import { CostChart } from './CostChart';
import type { Instrument, Market, Trade } from '../types';
import { marketTimestamp } from '../chartTime';

const chartMock = vi.hoisted(() => {
  const series: {options: Record<string, unknown>; data: {time: Time; value?: number}[];
    applyOptions: ReturnType<typeof vi.fn>; createPriceLine: ReturnType<typeof vi.fn>}[] = [];
  const markers = vi.fn();
  const crosshair = vi.fn();
  return {series, markers, crosshair, chart: {
    addSeries: vi.fn((_type: unknown, options: Record<string, unknown>) => {
      const item = {options, data: [] as {time: Time; value?: number}[], applyOptions: vi.fn(), createPriceLine: vi.fn(),
        attachPrimitive: vi.fn(), setData(data: {time: Time; value?: number}[]) {this.data = data;}};
      series.push(item); return item;
    }),
    subscribeCrosshairMove: crosshair,
    timeScale: () => ({fitContent: vi.fn(), setVisibleRange: vi.fn()}),
    remove: vi.fn(),
  }};
});
vi.mock('lightweight-charts', async importOriginal => ({
  ...await importOriginal<typeof import('lightweight-charts')>(),
  createChart: () => chartMock.chart, createSeriesMarkers: chartMock.markers,
}));

function trade(id: number, side: 'buy' | 'sell', price: string, time = '2026-01-10T10:00:00'): Trade {
  return {id, code: '510300', side, price, quantity: 100, fee: '0', executed_at: time,
    note: '', buy_lot_id: null, realized_pnl: null, allocations: []};
}
const instrument = (trades: Trade[]): Instrument => ({code: '510300', name: '沪深300ETF', kind: 'etf',
  quantity: 100, cost: '400', average_cost: '4', realized_pnl: '0', lots: [], trades});
const market: Market = {source: '测试', quote: null, warnings: [], history: [
  {time: '2026-01-10', open: 4, high: 5, low: 3, close: 4.5},
  {time: '2026-01-11', open: 4.5, high: 5.2, low: 4, close: 4.8},
]};
beforeEach(() => {chartMock.series.length = 0; vi.clearAllMocks();});
afterEach(cleanup);

describe('价格曲线与成交点', () => {
  it('日K使用原始OHLC，同日买卖点保留各自实际价格，也保留早于行情的交易', () => {
    render(<CostChart instrument={instrument([trade(2, 'sell', '4.7'), trade(1, 'buy', '4.2'),
      trade(3, 'buy', '3.8', '2025-12-01T10:00:00')])} market={market} showClosed={false} focusedLot={null} range="ALL"/>);
    expect(chartMock.series[0].data).toEqual(market.history);
    expect(chartMock.series[0].options).toMatchObject({upColor: '#d86b77', downColor: '#46a78e'});
    const points = chartMock.series.slice(1).flatMap(series => series.data);
    expect(points).toHaveLength(3);
    expect(points).toEqual(expect.arrayContaining([
      expect.objectContaining({time: '2026-01-10', value: 4.2}),
      expect.objectContaining({time: '2026-01-10', value: 4.7}),
      expect.objectContaining({time: '2025-12-01', value: 3.8}),
    ]));
    expect(chartMock.series[0].createPriceLine).toHaveBeenCalledWith(expect.objectContaining({price: 4, title: '均价'}));
  });

  it('分时使用北京时间分钟价格，保留未来空白，忽略历史及占位成交时间', () => {
    const time = marketTimestamp('2026-01-10', '10:00:00');
    const data = [{time: marketTimestamp('2026-01-10', '09:30:00'), price: 4.2}, {time, price: 4.5}];
    render(<CostChart instrument={instrument([trade(1, 'buy', '4.2'), trade(2, 'sell', '4.7', '2026-01-09T10:00:00'), trade(3, 'buy', '4.1', '2026-01-10T00:00:00')])}
      market={{...market, intraday_date: '2026-01-10', intraday: data}} showClosed={false} focusedLot={null} range="ALL" mode="intraday"/>);
    expect(chartMock.series[0].data.filter(p => p.value != null)).toEqual(data.map(p => ({time: p.time, value: p.price})));
    expect(chartMock.series[0].data.at(-1)).toEqual({time: marketTimestamp('2026-01-10', '15:00:00')});
    expect(chartMock.series.slice(1).flatMap(s => s.data)).toEqual([{time, value: 4.2}]);
  });

  it('无行情时不画市场价格曲线，仍然显示真实买卖点', () => {
    render(<CostChart instrument={instrument([trade(1, 'buy', '4.2')])} showClosed={false} focusedLot={null} range="ALL"/>);
    expect(chartMock.series[0].options.lineVisible).toBe(false);
    expect(chartMock.series[0].data).toEqual([{time: '2026-01-10', value: 4.2}]);
    expect(chartMock.series[1].data[0].value).toBe(4.2);
  });

  it('悬停同一天显示每笔交易的成交价格和数量', () => {
    render(<CostChart instrument={instrument([trade(1, 'buy', '4.2'), trade(2, 'sell', '4.7')])}
      market={market} showClosed={false} focusedLot={null} range="ALL"/>);
    const callback = chartMock.crosshair.mock.calls[0][0] as (event: MouseEventParams<Time>) => void;
    act(() => callback({time: '2026-01-10', point: {x: 100, y: 100}} as MouseEventParams<Time>));
    expect(screen.getByText('买入 #1')).toBeTruthy();
    expect(screen.getByText('卖出 #2')).toBeTruthy();
    expect(screen.getByText('100 股/份 · ¥ 4.200')).toBeTruthy();
    expect(screen.getByText('100 股/份 · ¥ 4.700')).toBeTruthy();
  });
});
