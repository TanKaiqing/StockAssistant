import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrokerPage } from './BrokerPage';

let requests: string[];
let failure: boolean;
const state = {installed: true, connected: true, native_ready: true, logged_in: true, ready: true, message: ''};
beforeEach(() => {
  requests = []; failure = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(String(url));
    if (String(url).endsWith('/status')) return new Response(JSON.stringify(state));
    if (failure) return new Response(JSON.stringify({detail: '同花顺授权未完成'}), {status: 503});
    if (String(url).endsWith('/sync/deal')) return new Response(JSON.stringify({inserted: true, message: '已同步到交易记录，手续费为估算值'}));
    const query = String(url).split('/').at(-1)!.split('?')[0];
    const base = {query, account_type: 'normal', is_credit: false, fetched_at: '2026-10-14T11:30:00', warnings: []};
    if (query === 'positions') return new Response(JSON.stringify({...base, rows: [{code: '513310', name: '测试芯片ETF', quantity: '7900', available: '7800', cost_price: '4.521', price: '4.311', market_value: '34056.90', profit: '-1662.61'}]}));
    if (query === 'deals') return new Response(JSON.stringify({...base, rows: [{id: 0, date: '2026-10-15', time: '10:00:01', code: '513310', name: '当日ETF', operation: '买入', side: 'buy', price: '4.123', quantity: '100', amount: '412.30', fee: null, sync_token: 'server-verified-deal-token'}]}));
    if (query.startsWith('history-')) {
      const params = new URL(String(url), 'http://localhost').searchParams;
      return new Response(JSON.stringify({...base, start_date: params.get('start_date'), end_date: params.get('end_date'), rows: [{id: 0, date: '2026-10-08', time: '10:17:34', code: '513310', name: '历史ETF', operation: '买入', side: 'buy', price: '4.7000', quantity: '400', amount: '1880', fee: '0.10', cash_change: '-1880.10', balance: '303.94'}]}));
    }
    return new Response(JSON.stringify({...base, rows: []}));
  }));
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

describe('券商查询页面', () => {
  it('only imports the clicked fill and shows success without repeated submission', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<BrokerPage initialQuery="deals" onLedgerChange={changed}/>);
    await screen.findByText('当日ETF');
    expect(requests.some(url => url.endsWith('/sync/deal'))).toBe(false);
    await user.click(screen.getByRole('button', {name: /^同步$/}));
    expect(await screen.findByText('已同步到交易记录，手续费为估算值')).toBeTruthy();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', {name: /^已同步$/}).hasAttribute('disabled')).toBe(true);
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/sync/deal'))!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({token: 'server-verified-deal-token'});
    expect(requests.filter(url => url.endsWith('/sync/deal'))).toHaveLength(1);
  });

  it('keeps a failed fill available for retry and does not refresh the ledger', async () => {
    const user = userEvent.setup(); const changed = vi.fn();
    render(<BrokerPage initialQuery="deals" onLedgerChange={changed}/>);
    await screen.findByText('当日ETF'); failure = true;
    await user.click(screen.getByRole('button', {name: /^同步$/}));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole('button', {name: /^同步$/}).hasAttribute('disabled')).toBe(false);
  });

  it('opens the order table directly when navigating from a real order', async () => {
    render(<BrokerPage initialQuery="orders"/>);
    await screen.findByText('本次查询未返回记录');
    expect(screen.getByRole('tab', {name: '当日委托'}).getAttribute('aria-selected')).toBe('true');
    expect(requests.some(url => url.endsWith('/orders'))).toBe(true);
    expect(requests.some(url => url.endsWith('/positions'))).toBe(false);
  });
  it('StrictMode only starts one holdings query and renders broker values', async () => {
    render(<StrictMode><BrokerPage/></StrictMode>);
    expect(await screen.findByText('测试芯片ETF')).toBeTruthy();
    expect(requests.filter(url => url.endsWith('/positions')).length).toBe(1);
    expect(screen.getByText('4.521')).toBeTruthy();
    expect(screen.getByText('7,800')).toBeTruthy();
    expect(screen.getByText('已连接同花顺 · 普通账户')).toBeTruthy();
  });

  it('queries selected history dates only on submit and filters the returned records', async () => {
    const user = userEvent.setup(); render(<BrokerPage/>);
    await screen.findByText('测试芯片ETF');
    await user.click(screen.getByRole('tab', {name: '历史成交'}));
    await screen.findByText('历史ETF');
    const start = screen.getByLabelText('券商查询开始日期');
    const end = screen.getByLabelText('券商查询结束日期');
    await user.clear(start); await user.type(start, '2026-10-01');
    await user.clear(end); await user.type(end, '2026-10-10');
    const previousCount = requests.length;
    await user.click(screen.getByRole('button', {name: /^查询$/}));
    await screen.findByText('历史ETF');
    expect(requests.slice(previousCount).some(url => url.includes('start_date=2026-10-01&end_date=2026-10-10'))).toBe(true);
    expect(within(screen.getByRole('table')).getByText('0.10')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('券商买卖筛选'), 'sell');
    expect(screen.queryByText('历史ETF')).toBeNull();
    expect(screen.getByText('没有匹配的记录')).toBeTruthy();
  });

  it('failed refresh clears old holdings rather than presenting them as current', async () => {
    const user = userEvent.setup(); render(<BrokerPage/>);
    await screen.findByText('测试芯片ETF'); failure = true;
    await user.click(screen.getByRole('button', {name: /^刷新$/}));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('测试芯片ETF')).toBeNull();
  });

  it('demo mode never sends a native account query and clears previous real results', async () => {
    const {rerender} = render(<BrokerPage demo/>);
    await waitFor(() => expect(screen.getByText('退出示例模式后即可查询')).toBeTruthy());
    expect(requests).toEqual([]);
    rerender(<BrokerPage/>); await screen.findByText('测试芯片ETF');
    rerender(<BrokerPage demo/>);
    expect(screen.queryByText('测试芯片ETF')).toBeNull();
  });
});
