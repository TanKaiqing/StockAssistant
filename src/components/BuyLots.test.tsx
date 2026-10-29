import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuyLots } from './BuyLots';
import type { Instrument, Lot, Quote } from '../types';

const lot = (id: number, date: string, goal?: string): Lot => ({id, executed_at: date + 'T10:00:00',
  quantity: 100, remaining: 100, price: '10', fee: '0', unit_cost: '10', target_profit_percent: goal});
const instrument = (lots: Lot[]): Instrument => ({code: '510300', name: '沪深300ETF', kind: 'etf',
  quantity: 300, cost: '3000', average_cost: '10', realized_pnl: '0', trades: [], lots});
const props = (item: Instrument) => ({instrument: item, stale: false, feeRevision: 0,
  showClosed: false, onShowClosed: vi.fn(), focusedLot: null, onLotClick: vi.fn()});
const quote: Quote = {price: 11, fetched_at: new Date().toISOString(), change_percent: 0, previous_close: 10, bids: [], asks: []};
afterEach(() => {cleanup(); vi.unstubAllGlobals();});
const order = () => screen.getAllByRole('button').map(button => button.getAttribute('aria-label'));

describe('批次倒序与盈利目标', () => {
  it('当前价等于含费用成本时淡色高亮，低于成本、已卖完或行情过期不高亮', () => {
    const item = instrument([lot(1, '2026-10-09'), {...lot(2, '2026-10-10'), unit_cost: '10.01'}, {...lot(3, '2026-10-11'), remaining: 0}]);
    const input = {...props(item), showClosed: true};
    const {rerender} = render(<BuyLots {...input} quote={{...quote, price: 10}}/>);
    expect(screen.getByRole('button', {name: '卖出买入批次1'}).classList.contains('cost-reached')).toBe(true);
    expect(screen.getByRole('button', {name: '卖出买入批次2'}).classList.contains('cost-reached')).toBe(false);
    expect(screen.getByRole('button', {name: '查看买入批次3成本线'}).classList.contains('cost-reached')).toBe(false);
    expect(screen.getByText('已到成本')).toBeTruthy();
    expect(order()).toEqual(['查看买入批次3成本线', '卖出买入批次2', '卖出买入批次1']);
    rerender(<BuyLots {...input} quote={{...quote, price: 10}} stale/>);
    expect(screen.queryByText('已到成本')).toBeNull();
    expect(screen.getByRole('button', {name: '卖出买入批次1'}).classList.contains('cost-reached')).toBe(false);
  });

  it('百分比目标显示含费用的对应金额，部分卖出按剩余成本更新', () => {
    const item = instrument([{...lot(1, '2026-10-09', '5'), unit_cost: '10.01'}]);
    const {rerender} = render(<BuyLots {...props(item)}/>);
    expect(screen.getByText('目标 +5.00%')).toBeTruthy();
    expect(screen.getByText('目标金额 +¥ 50.05')).toBeTruthy();
    rerender(<BuyLots {...props({...item, lots: [{...item.lots[0], remaining: 40}]})}/>);
    expect(screen.getByText('目标金额 +¥ 20.02')).toBeTruthy();
  });

  it('按日期和同日记录 ID 倒序显示，保持原始成本匹配顺序不变', () => {
    const lots = [lot(1, '2026-10-09'), lot(2, '2026-10-10'), lot(3, '2026-10-10')];
    render(<BuyLots {...props(instrument(lots))}/>);
    expect(order()).toEqual(['卖出买入批次3', '卖出买入批次2', '卖出买入批次1']);
    expect(lots.map(item => item.id)).toEqual([1, 2, 3]);
  });

  it('行情达标的旧批次高亮置顶；无效或过期行情撤销达标状态并恢复倒序', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({targets: [
      {lot_id: 1, reached: true, profit: '90', profit_percent: '9', target_profit: '50', estimated_sell_fee: '10'},
      {lot_id: 2, reached: false, profit: '90', profit_percent: '9', target_profit: '200', estimated_sell_fee: '10'},
    ]}))));
    const input = props(instrument([lot(1, '2026-10-09', '5'), lot(2, '2026-10-10', '20')]));
    const {rerender} = render(<BuyLots {...input} quote={quote}/>);
    await waitFor(() => expect(order()[0]).toBe('卖出买入批次1'));
    expect(screen.getByRole('button', {name: '卖出买入批次1'}).classList.contains('target-reached')).toBe(true);
    expect(screen.getByRole('button', {name: '卖出买入批次1'}).classList.contains('cost-reached')).toBe(false);
    expect(screen.getByText('已达标')).toBeTruthy();
    rerender(<BuyLots {...input} quote={quote} stale/>);
    expect(order()[0]).toBe('卖出买入批次2');
    expect(screen.queryByText('已达标')).toBeNull();
  });

  it('改变目标或剩余数量时，重新核对而不沿用旧批次的达标结果', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({targets: [{lot_id: 1, reached: true, profit: '90', profit_percent: '9'}]})));
    vi.stubGlobal('fetch', fetch);
    const item = instrument([lot(1, '2026-10-09', '5')]);
    const {rerender} = render(<BuyLots {...props(item)} quote={quote}/>);
    await screen.findByText('已达标');
    fetch.mockImplementation(async () => new Response('{"targets":[]}'));
    rerender(<BuyLots {...props({...item, lots: [{...item.lots[0], target_profit_percent: '50', remaining: 50}]})} quote={quote}/>);
    expect(screen.queryByText('已达标')).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});
