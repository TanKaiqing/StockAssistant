import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TradeDialog, type TradeForm } from './TradeDialog';
import type { Trade } from '../types';

vi.mock('./TradeShortcuts', () => ({TradeShortcuts: () => <div/>}));
vi.mock('./SellPreview', () => ({SellPreview: () => <div/>}));
afterEach(() => {cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

function Harness({editing = null, allowRealTrading = true, onSave = vi.fn(), onOrders = vi.fn()}: {
  editing?: Trade | null; allowRealTrading?: boolean; onSave?: () => void; onOrders?: () => void;
}) {
  const [form, setForm] = useState<TradeForm>({side: 'buy', price: '4.123', quantity: '500',
    executed_at: '2026-10-14T10:00', fee: '0.1', note: '备注', buy_lot_id: '', target_mode: 'percent', target_value: '3'});
  return <TradeDialog open onOpenChange={vi.fn()} code="513310" editing={editing}
    instrument={{code: '513310', name: '测试ETF', kind: 'etf', quantity: 1000, cost: '4000', average_cost: '4', realized_pnl: '0', lots: [], trades: []}}
    form={form} onChange={patch => setForm(current => ({...current, ...patch}))}
    onFeeChange={vi.fn()} onAutoFee={vi.fn()} onSave={e => {e.preventDefault(); onSave();}}
    busy={false} error="" manualFee={false} feeLoading={false} feeError="" feeReady
    amountValid feeValid previewValue="¥ 2061.60" refreshing={false} onRefresh={vi.fn()}
    allowRealTrading={allowRealTrading} onBrokerOrders={onOrders}/>;
}

function nativeMock() {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify(url.endsWith('/preview')
      ? {ticket: 'test-ticket', expires_in: 30, available_quantity: '1000', order: {...input, quantity: String(input.quantity)}}
      : {status: 'accepted', message: '已受理，等待成交'}));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('keeps one form with separate record and real-order actions', async () => {
  const fetch = nativeMock(); const onSave = vi.fn();
  const user = userEvent.setup(); render(<Harness onSave={onSave}/>);
  expect(screen.queryByRole('group', {name: '交易模式'})).toBeNull();
  expect(screen.getByRole('button', {name: '真实买入'})).toBeTruthy();
  await user.click(screen.getByRole('button', {name: '保存记录'}));
  expect(onSave).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it('previews directly from existing form and returns to it without losing fields', async () => {
  const fetch = nativeMock(); const user = userEvent.setup(); render(<Harness/>);
  await user.clear(screen.getByLabelText('成交价（元）'));
  await user.type(screen.getByLabelText('成交价（元）'), '4.200');
  await user.clear(screen.getByLabelText('数量（股 / 份）'));
  await user.type(screen.getByLabelText('数量（股 / 份）'), '700');
  await user.click(screen.getByRole('button', {name: '真实买入'}));
  expect(await screen.findByRole('button', {name: '确认买入'})).toBeTruthy();
  expect(fetch.mock.calls).toHaveLength(1);
  const request = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(request).toEqual({code: '513310', side: 'buy', price: '4.200', quantity: 700});
  expect(screen.queryByLabelText('委托价格')).toBeNull();
  await user.click(screen.getByRole('button', {name: '返回修改'}));
  expect((screen.getByLabelText('成交价（元）') as HTMLInputElement).value).toBe('4.200');
  expect((screen.getByLabelText('数量（股 / 份）') as HTMLInputElement).value).toBe('700');
  expect((screen.getByLabelText(/备注/) as HTMLTextAreaElement).value).toBe('备注');
  expect((screen.getByLabelText(/本次买入期望盈利/) as HTMLInputElement).value).toBe('3');
});

it('real submit requires confirmation and does not invoke manual save', async () => {
  const fetch = nativeMock(); const onSave = vi.fn(); const onOrders = vi.fn();
  const user = userEvent.setup(); render(<Harness onSave={onSave} onOrders={onOrders}/>);
  await user.click(screen.getByRole('button', {name: '真实买入'}));
  const submit = await screen.findByRole('button', {name: '确认买入'});
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('checkbox')); await user.dblClick(submit);
  await screen.findByText('已受理，等待成交');
  expect(onSave).not.toHaveBeenCalled();
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/submit'))).toHaveLength(1);
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/broker/orders'))).toBe(true);
  expect(screen.queryByRole('button', {name: '保存记录'})).toBeNull();
  await user.click(screen.getByText('查看当日委托')); expect(onOrders).toHaveBeenCalledOnce();
});

it('sell uses the same form and the current sell direction', async () => {
  const fetch = nativeMock(); const user = userEvent.setup(); render(<Harness/>);
  await user.click(screen.getByRole('button', {name: '卖出'}));
  await user.click(screen.getByRole('button', {name: '真实卖出'}));
  await screen.findByRole('button', {name: '确认卖出'});
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).side).toBe('sell');
});

it('failed preview retains the original form and never saves or submits', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({detail: '可交易数量不足'}), {status: 409}));
  vi.stubGlobal('fetch', fetch);
  const onSave = vi.fn(); const user = userEvent.setup(); render(<Harness onSave={onSave}/>);
  await user.click(screen.getByRole('button', {name: '真实买入'}));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect((screen.getByLabelText('数量（股 / 份）') as HTMLInputElement).value).toBe('500');
  expect(screen.getByRole('button', {name: '保存记录'})).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
});

it('expired preview returns to the original form and needs a new preview', async () => {
  const fetch = nativeMock(); const user = userEvent.setup(); render(<Harness/>);
  await user.click(screen.getByRole('button', {name: '真实买入'}));
  await user.click(await screen.findByRole('checkbox'));
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 31000);
  await user.click(screen.getByRole('button', {name: '确认买入'}));
  expect(await screen.findByText('预览已过期，请重新预览')).toBeTruthy();
  expect(screen.getByRole('button', {name: '真实买入'})).toBeTruthy();
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/submit'))).toBe(false);
});

it('editing and demo mode have only the record action', () => {
  const {rerender} = render(<Harness allowRealTrading={false}/>);
  expect(screen.queryByRole('button', {name: '真实买入'})).toBeNull();
  rerender(<Harness editing={{id: 1} as Trade}/>);
  expect(screen.queryByRole('button', {name: '真实买入'})).toBeNull();
  expect(screen.getByText('保存记录')).toBeTruthy();
});
