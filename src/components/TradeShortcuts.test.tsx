import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TradeShortcuts } from './TradeShortcuts';
import type { Instrument, Quote } from '../types';

const instrument: Instrument = {code: '510300', name: '沪深300ETF', kind: 'etf', quantity: 1050, cost: '4000', average_cost: '3.81', realized_pnl: '0', trades: [], lots: []};
const quote: Quote = {price: 4.36, change_percent: 0, previous_close: 4.36, fetched_at: new Date().toISOString(),
  bids: Array.from({length: 5}, (_, i) => ({price: 4.36 - i * .001, volume: 100})),
  asks: Array.from({length: 5}, (_, i) => ({price: 4.361 + i * .001, volume: 100}))};
const props = () => ({instrument, side: 'buy' as 'buy' | 'sell', price: '4', quantity: '500', fee: '5', manualFee: false,
  executedAt: '2026-01-10T10:00:00', buyLotId: '', quote, refreshing: false,
  onRefresh: vi.fn(), onPrice: vi.fn(), onQuantity: vi.fn()});
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"quantity":400}')));
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

describe('交易快捷选项', () => {
  it('券商仓位查询不读取手工资金或使用账本批次', async () => {
    const input = props(); const user = userEvent.setup();
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"quantity":700,"available":1500}'));
    vi.stubGlobal('fetch', fetch);
    render(<TradeShortcuts {...input} brokerAvailable/>);
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByText('1/2仓'));
    await waitFor(() => expect(input.onQuantity).toHaveBeenCalledWith('700'));
    expect(fetch.mock.calls[0][0]).toBe('/api/broker/trade/size');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({code: '510300', side: 'buy', price: '4', portion: 2});
  });
  it('买入使用买档价格，切换卖出使用卖档价格', async () => {
    const user = userEvent.setup(); const input = props();
    const {rerender} = render(<TradeShortcuts {...input}/>);
    await user.click(screen.getByRole('button', {name: '买1 4.360'}));
    expect(input.onPrice).toHaveBeenLastCalledWith('4.360');
    rerender(<TradeShortcuts {...input} side="sell"/>);
    expect(screen.queryByRole('button', {name: /买1/})).toBeNull();
    await user.click(screen.getByRole('button', {name: '卖5 4.365'}));
    expect(input.onPrice).toHaveBeenLastCalledWith('4.365');
  });
  it('整百增减和固定数量填入表单，无盘口时不允许点击价格', async () => {
    const user = userEvent.setup(); const input = {...props(), quote: null};
    render(<TradeShortcuts {...input}/>);
    expect((screen.getByRole('button', {name: '买1 —'}) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', {name: '数量增加100'}));
    expect(input.onQuantity).toHaveBeenLastCalledWith('600');
    await user.click(screen.getByRole('button', {name: '数量减少100'}));
    expect(input.onQuantity).toHaveBeenLastCalledWith('400');
    await user.click(screen.getByRole('button', {name: '1000'}));
    expect(input.onQuantity).toHaveBeenLastCalledWith('1000');
  });
  it('历史卖出仍按账本批次计算，历史买入无需资金设置', async () => {
    const input = props(); const user = userEvent.setup();
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"quantity":400}'));
    vi.stubGlobal('fetch', fetch);
    const {rerender} = render(<TradeShortcuts {...input}/>);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', {name: '全仓'})).toBeNull();
    rerender(<TradeShortcuts {...input} side="sell" buyLotId="2" editingId={9}/>);
    await user.click(screen.getByRole('button', {name: '全仓'}));
    await waitFor(() => expect(input.onQuantity).toHaveBeenCalledWith('400'));
    expect(fetch.mock.calls[0][0]).toBe('/api/trades/size');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({side: 'sell', buy_lot_id: 2, exclude_trade_id: 9});
  });
  it('较慢的估算响应不会覆盖用户随后输入的新价格或数量', async () => {
    const user = userEvent.setup(); const input = props();
    let resolve: (value: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => {resolve = r;})));
    const {rerender} = render(<TradeShortcuts {...input} brokerAvailable/>);
    await user.click(screen.getByRole('button', {name: '全仓'}));
    rerender(<TradeShortcuts {...input} brokerAvailable quantity="1000"/>);
    resolve(new Response('{"quantity":900}'));
    await waitFor(() => expect((screen.getByRole('button', {name: '全仓'}) as HTMLButtonElement).disabled).toBe(false));
    expect(input.onQuantity).not.toHaveBeenCalled();
  });
});
