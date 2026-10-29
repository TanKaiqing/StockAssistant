import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrokerOrderDialog } from './BrokerOrderDialog';

afterEach(() => {cleanup(); vi.unstubAllGlobals();});

it('requires preview and explicit confirmation, submits immutable ticket once', async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/preview')
    ? {ticket: 'one-shot-ticket', expires_in: 30, available_quantity: '1000', order: {code: '513310', side: 'sell', price: '4.123', quantity: '100'}}
    : {status: 'accepted', message: '提交请求已受理'})));
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  render(<BrokerOrderDialog seed={{side: 'sell', code: '513310', price: '4.123'}} onClose={vi.fn()} onOrders={vi.fn()}/>);
  expect(fetch).not.toHaveBeenCalled();
  await user.click(screen.getByText('预览委托'));
  const submit = await screen.findByRole('button', {name: '确认卖出'});
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('checkbox'));
  await user.dblClick(submit);
  await screen.findByText('提交请求已受理');
  expect(fetch.mock.calls.filter(c => String(c[0]).endsWith('/submit'))).toHaveLength(1);
  expect(screen.queryByRole('button', {name: '确认卖出'})).toBeNull();
});

it('network failure after submit offers query instead of retry', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/submit')) throw new Error('连接中断');
    return new Response(JSON.stringify({ticket: 'one-shot-ticket', expires_in: 30, available_quantity: '1000', order: {code: '513310', side: 'sell', price: '4.123', quantity: '100'}}));
  }));
  const user = userEvent.setup();
  render(<BrokerOrderDialog seed={{side: 'sell', code: '513310', price: '4.123'}} onClose={vi.fn()} onOrders={vi.fn()}/>);
  await user.click(screen.getByText('预览委托'));
  await user.click(await screen.findByRole('checkbox'));
  await user.click(screen.getByRole('button', {name: '确认卖出'}));
  expect(await screen.findByText(/连接中断/)).toBeTruthy();
  expect(screen.getByText('查看当日委托')).toBeTruthy();
  expect(screen.queryByText('预览委托')).toBeNull();
});
