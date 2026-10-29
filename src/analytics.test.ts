import { describe, expect, it } from 'vitest';
import { analyze } from './analytics';
import type { Instrument, Trade } from './types';

const trade = (id: number, date: string, side: 'buy' | 'sell', pnl: string | null, overrides: Partial<Trade> = {}): Trade => ({id, code: '510300', executed_at: `${date}T10:00:00`, side, price: '2.356', quantity: 100, fee: '0.1', note: '', buy_lot_id: null, realized_pnl: pnl, allocations: [], ...overrides});
const instrument = (trades: Trade[], overrides: Partial<Instrument> = {}): Instrument => ({code: '510300', name: 'ETF', kind: 'etf', quantity: 0, cost: '0', average_cost: null, realized_pnl: '0', trades, lots: [], ...overrides});
const all = {start: '', end: '', kind: 'all' as const};

describe('账本统计', () => {
  it('按卖出日期统计已结算盈亏，沿用跨期成本计算结果，不重复扣费用', () => {
    const result = analyze([instrument([
      trade(1, '2026-09-30', 'buy', null),
      trade(2, '2026-10-01', 'sell', '-12.34', {gross_amount: '235.65', fee: '2'}),
      trade(3, '2026-10-31', 'sell', '22.34'),
      trade(4, '2026-11-01', 'sell', '50'),
    ])], {...all, start: '2026-10-01', end: '2026-10-31'});
    expect(result.pnl).toBeCloseTo(10);
    expect(result.amount).toBeCloseTo(471.25);
    expect(result.fees).toBeCloseTo(2.1);
    expect(result.count).toBe(2);
    expect(result.winRate).toBe(50);
    expect(result.profitFactor).toBeCloseTo(22.34 / 12.34);
  });
  it('同日聚合，按日期累计，回撤按日末高点计算', () => {
    const result = analyze([instrument([
      trade(3, '2026-10-03', 'sell', '-7'), trade(2, '2026-10-02', 'sell', '-3'),
      trade(1, '2026-10-01', 'sell', '20'), trade(4, '2026-10-03', 'sell', '2'),
    ])], all);
    expect(result.days.map(d => d.cumulative)).toEqual([20, 17, 12]);
    expect(result.days[2].count).toBe(2);
    expect(result.drawdown).toBe(8);
    expect(result.months[0].pnl).toBe(12);
  });
  it('处理持平尾数、未结算卖出和类型过滤，避免虚增胜率', () => {
    const etf = instrument([trade(1, '2026-10-01', 'sell', '-0.000000000000001'), trade(2, '2026-10-01', 'sell', null)]);
    const stock = instrument([trade(3, '2026-10-01', 'sell', '100')], {kind: 'stock', code: '002437'});
    const result = analyze([etf, stock], {...all, kind: 'etf'});
    expect(result.pnl).toBe(0); expect(result.flat).toBe(1); expect(result.sells).toBe(1);
    expect(result.winRate).toBe(0); expect(result.count).toBe(2);
    expect(result.rankings).toHaveLength(1);
  });
  it('无卖出时胜率与盈亏比留空，空范围不产生无效数字', () => {
    const result = analyze([instrument([trade(1, '2026-10-01', 'buy', null)])], all);
    expect(result.winRate).toBeNull(); expect(result.profitFactor).toBeNull();
    const empty = analyze([], all);
    expect(empty.count).toBe(0); expect(empty.days).toEqual([]); expect(empty.drawdown).toBe(0);
  });
});
