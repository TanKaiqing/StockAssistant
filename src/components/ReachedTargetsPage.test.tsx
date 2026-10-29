import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ReachedTargetsPage } from './ReachedTargetsPage';
import type { Instrument, Market } from '../types';

afterEach(() => {cleanup(); vi.unstubAllGlobals();});
const instrument = (code: string, id: number): Instrument => ({code, name: `标的${code}`, kind: 'etf', quantity: 50,
  cost: '500', average_cost: '10', realized_pnl: '0', trades: [], lots: [{id, executed_at: '2026-10-01T10:00:00',
    quantity: 100, remaining: 50, price: '10', fee: '0', unit_cost: '10', target_profit_amount: '100'}]});
const market = (time = Date.now()): Market => ({source: '测试', warnings: [], history: [], quote: {
  price: 12, fetched_at: new Date(time).toISOString(), change_percent: 2, previous_close: 11, bids: [], asks: []}});
const target = (id: number, reached = true) => ({lot_id: id, reached, profit: '99', profit_percent: '19.8', target_profit: '50', estimated_sell_fee: '1'});
const props = () => ({instruments: [instrument('510300', 1), instrument('513310', 2)], markets: {'510300': market(), '513310': market()}, errors: {},
  now: Date.now(), feeRevision: 0, demo: false, refreshing: false, onRefresh: vi.fn(async () => {}), onSell: vi.fn(), remaining: 30, paused: false, autoRefresh: false});

it('汇总不同标的的达标批次，排除未达标，卖出使用该标的和剩余数量', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify({targets: [target(url.includes('510300') ? 1 : 2, url.includes('513310'))]}))));
  const input = props(); const user = userEvent.setup(); render(<ReachedTargetsPage {...input}/>);
  await user.click(await screen.findByRole('button', {name: '卖出标的513310买入批次2'}));
  expect(input.onSell).toHaveBeenCalledWith(input.instruments[1], input.instruments[1].lots[0]);
  expect(screen.queryByRole('button', {name: '卖出标的510300买入批次1'})).toBeNull();
  expect(screen.getByText('剩余目标 ¥ 50.00')).toBeTruthy();
  expect(screen.getByText('¥ +99.00')).toBeTruthy();
});

it('行情过期立即撤销达标展示，不用无效价格重新请求', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({targets: [target(1)]})));
  vi.stubGlobal('fetch', fetch); const input = {...props(), instruments: [instrument('510300', 1)]};
  const {rerender} = render(<ReachedTargetsPage {...input}/>);
  await screen.findByRole('button', {name: '卖出标的510300买入批次1'});
  rerender(<ReachedTargetsPage {...input} now={input.now + 91000}/>);
  expect(screen.queryByRole('button', {name: '卖出标的510300买入批次1'})).toBeNull();
  expect(screen.getByText('1 个标的等待有效行情')).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('剩余数量或费率更新后重新核对，已卖完批次不沿用旧达标结果', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({targets: [target(1)]})));
  vi.stubGlobal('fetch', fetch); const input = {...props(), instruments: [instrument('510300', 1)]};
  const {rerender} = render(<ReachedTargetsPage {...input}/>);
  await screen.findByRole('button', {name: '卖出标的510300买入批次1'});
  fetch.mockImplementation(async () => new Response('{"targets":[]}'));
  rerender(<ReachedTargetsPage {...input} feeRevision={1}/>);
  expect(screen.queryByRole('button', {name: '卖出标的510300买入批次1'})).toBeNull();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  rerender(<ReachedTargetsPage {...input} instruments={[{...input.instruments[0], lots: [{...input.instruments[0].lots[0], remaining: 0}]}]}/>);
  expect(screen.getByText(/暂无设置盈利目标的未卖完买入/)).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(2);
});
