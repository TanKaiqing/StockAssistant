import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import type { Instrument } from './types';

vi.mock('./components/CostChart', () => ({CostChart: ({instrument}: {instrument: Instrument}) => <div aria-label="成本图">{instrument.lots.length} 个成本批次</div>}));

const blank = (): Instrument => ({code: '510300', name: '沪深300ETF', kind: 'etf', quantity: 0, cost: '0', average_cost: null, realized_pnl: '0', lots: [], trades: []});
let instruments: Instrument[];
let rejectSale: boolean;
let requests: {path: string; method: string; payload?: Record<string, unknown>}[];
let feeSettings: {stock: {commission_rate: string; minimum_fee: string}; etf: {commission_rate: string; minimum_fee: string}};

beforeEach(() => {
  instruments = []; requests = []; rejectSale = false; localStorage.clear();
  feeSettings = {stock: {commission_rate: '0', minimum_fee: '0'}, etf: {commission_rate: '0', minimum_fee: '0'}};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/api', '');
    const method = init?.method ?? 'GET';
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({path, method, payload});
    if (path === '/broker/trade/size') return new Response('{"quantity":900,"available":1900}');
    if (path === '/trades/size') return new Response('{"quantity":900}');
    if (path === '/trades/preview') {
      const gross = Number(payload.price) * payload.quantity;
      const cost = payload.quantity * 4.5;
      return new Response(JSON.stringify({realized_pnl: (gross - cost - Number(payload.fee)).toFixed(2),
        buy_cost: cost.toFixed(2), sell_amount: gross.toFixed(2), sell_fee: payload.fee}));
    }
    if (path === '/settings/fees') {
      if (method === 'PUT') feeSettings = payload;
      return new Response(JSON.stringify(feeSettings), {status: 200});
    }
    if (path === '/fees/estimate') {
      const rule = feeSettings[payload.kind as 'stock' | 'etf'];
      const fee = Math.max(Number(payload.price) * payload.quantity * Number(rule.commission_rate) / 10000, Number(rule.minimum_fee));
      return new Response(JSON.stringify({fee: fee.toFixed(2)}), {status: 200});
    }
    if (path === '/portfolio') return new Response(JSON.stringify({instruments}), {status: 200});
    if (path === '/instruments' && method === 'POST') {
      instruments.push({...blank(), ...payload});
      return new Response(JSON.stringify(payload), {status: 201});
    }
    if (path.startsWith('/market/')) return new Response(JSON.stringify({quote: null, history: [], source: '测试', warnings: ['最新行情获取失败']}), {status: 200});
    if (path === '/trades' && method === 'POST') {
      if (rejectSale) return new Response(JSON.stringify({detail: '卖出时持仓不足，请检查数量'}), {status: 422});
      const instrument = instruments.find(i => i.code === payload.code)!;
      const total = Number(payload.price) * Number(payload.quantity) + Number(payload.fee);
      instrument.quantity = payload.quantity;
      instrument.cost = String(total);
      instrument.average_cost = String(total / Number(payload.quantity));
      instrument.trades = [{...payload, id: 1, realized_pnl: null, allocations: []}];
      instrument.lots = [{id: 1, executed_at: payload.executed_at, quantity: payload.quantity, remaining: payload.quantity, price: payload.price, fee: payload.fee, unit_cost: instrument.average_cost,
        target_profit_percent: payload.target_profit_percent, target_profit_amount: payload.target_profit_amount}];
      return new Response('{"id":1}', {status: 201});
    }
    return new Response('{}', {status: 200});
  }));
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

describe('交易录入界面', () => {
  it('实时推送更新最新价，较慢的曲线响应不会覆盖它', async () => {
    instruments = [{...blank(), code: '513310', name: '中韩芯片ETF'}];
    localStorage.setItem('autoRefresh', 'true');
    let quoteListener: ((event: MessageEvent) => void) | undefined;
    let finishMarket: ((response: Response) => void) | undefined;
    class Source {
      onerror = null;
      addEventListener(type: string, listener: (event: MessageEvent) => void) {if (type === 'quote') quoteListener = listener;}
      close() {}
    }
    vi.stubGlobal('EventSource', Source);
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => String(url).startsWith('/api/market/')
      ? new Promise<Response>(resolve => {finishMarket = resolve;}) : originalFetch(url, init)));
    render(<App/>);
    await waitFor(() => expect(quoteListener).toBeDefined());
    await waitFor(() => expect(finishMarket).toBeDefined());
    const freshQuote = {source: '同花顺', price: 4.5, previous_close: 4.3, change_percent: 4.65,
      fetched_at: new Date().toISOString(), bids: [], asks: []};
    act(() => quoteListener!(new MessageEvent('quote', {data: JSON.stringify(freshQuote)})));
    expect(screen.getByText('实时推送中')).toBeTruthy();
    expect(document.querySelector('.book-mid strong')?.textContent).toBe('4.500');
    await act(async () => finishMarket!(new Response(JSON.stringify({source: '腾讯财经', quote: {...freshQuote, source: '腾讯财经', price: 4.2}, history: [], intraday: [], warnings: []}))));
    expect(document.querySelector('.book-mid strong')?.textContent).toBe('4.500');
  });
  it('刷新间隔默认五秒，可选十秒并在重新打开后恢复', async () => {
    const user = userEvent.setup(); const {unmount} = render(<App/>);
    await user.click(screen.getByRole('button', {name: '打开设置'}));
    expect((screen.getByLabelText('行情刷新间隔') as HTMLSelectElement).value).toBe('5');
    await user.selectOptions(screen.getByLabelText('行情刷新间隔'), '10');
    expect(localStorage.getItem('refreshSeconds')).toBe('10');
    unmount(); render(<App/>);
    await user.click(screen.getByRole('button', {name: '打开设置'}));
    expect((screen.getByLabelText('行情刷新间隔') as HTMLSelectElement).value).toBe('10');
  });
  it('右上角主题切换持久保存，重新打开后恢复，设置内切换同步生效', async () => {
    const user = userEvent.setup(); const {unmount} = render(<App/>);
    await user.click(screen.getByRole('button', {name: '切换到暗色主题'}));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    unmount(); render(<App/>);
    expect(screen.getByRole('button', {name: '切换到亮色主题'}).getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(screen.getByRole('button', {name: '打开设置'}));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', {name: '亮色'}));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', {name: '完成'}));
    expect(screen.getByRole('button', {name: '切换到暗色主题'})).toBeTruthy();
  });

  it('默认查询分时行情，可切换日K并显示历史时间范围', async () => {
    instruments = [blank()]; const user = userEvent.setup(); render(<App/>);
    await screen.findByRole('heading', {name: /沪深300ETF/});
    await waitFor(() => expect(requests.some(r => r.path === '/market/510300?history=false&intraday=true')).toBe(true));
    expect(screen.queryByRole('button', {name: '1M'})).toBeNull();
    await user.click(screen.getByRole('button', {name: '日 K'}));
    await waitFor(() => expect(requests.some(r => r.path === '/market/510300?history=true&intraday=false')).toBe(true));
    expect(screen.getByRole('button', {name: '1M'})).toBeTruthy();
    expect(localStorage.getItem('chartMode')).toBe('daily');
    await user.click(screen.getByRole('button', {name: '分时'}));
    expect(screen.queryByRole('button', {name: '1M'})).toBeNull();
    expect(localStorage.getItem('chartMode')).toBe('intraday');
  });

  it('盈利达标页卖出其他标的时使用该标的代码、批次与剩余数量', async () => {
    const first = {...blank(), quantity: 100, cost: '400', average_cost: '4'};
    const second = {...blank(), code: '513310', name: '中韩芯片ETF', quantity: 50, cost: '50', average_cost: '1',
      lots: [{id: 42, executed_at: '2026-10-01T10:00:00', quantity: 100, remaining: 50, price: '1', fee: '0', unit_cost: '1', target_profit_percent: '5'}]};
    instruments = [first, second];
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/market/513310')) return new Response(JSON.stringify({source: '测试', warnings: [], history: [],
        quote: {price: 2, fetched_at: new Date().toISOString(), change_percent: 1, previous_close: 1.9, bids: [], asks: []}}));
      if (url.includes('/targets/513310')) return new Response(JSON.stringify({targets: [{lot_id: 42, reached: true, profit: '49', profit_percent: '98', target_profit: '2.5', estimated_sell_fee: '1'}]}));
      return originalFetch(url, init);
    }));
    const user = userEvent.setup(); render(<App/>);
    await screen.findByRole('heading', {name: /沪深300ETF/});
    await user.click(screen.getByRole('button', {name: '盈利达标'}));
    await user.click(await screen.findByRole('button', {name: '卖出中韩芯片ETF买入批次42'}));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('中韩芯片ETF')).toBeTruthy();
    expect((within(dialog).getByLabelText('数量（股 / 份）') as HTMLInputElement).value).toBe('50');
    expect((within(dialog).getByLabelText('成交价（元）') as HTMLInputElement).value).toBe('2.000');
    expect((within(dialog).getByLabelText('卖出成本匹配') as HTMLSelectElement).value).toBe('42');
    await user.click(within(dialog).getByRole('button', {name: '保存记录'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests.find(r => r.path === '/trades')?.payload).toMatchObject({code: '513310', quantity: 50, buy_lot_id: 42, side: 'sell'});
  });

  it('未卖完筛选保留部分卖出的买入，排除已卖完批次，并支持全部标的', async () => {
    const first = blank();
    first.quantity = 50; first.cost = '200'; first.average_cost = '4';
    first.trades = [1, 2, 3].map(id => ({id, code: first.code, side: id === 3 ? 'sell' : 'buy',
      executed_at: `2026-10-0${id}T10:00:00`, price: '4', quantity: 100, fee: '0', note: '',
      buy_lot_id: null, realized_pnl: id === 3 ? '0' : null, allocations: []}));
    first.lots = [1, 2].map(id => ({id, executed_at: `2026-10-0${id}T10:00:00`, price: '4',
      quantity: 100, remaining: id === 1 ? 0 : 50, fee: '0', unit_cost: '4'}));
    const second = {...blank(), code: '513310', name: '中韩芯片ETF', quantity: 100, cost: '400', average_cost: '4',
      trades: [{...first.trades[1], id: 4, code: '513310'}], lots: [{...first.lots[1], id: 4, remaining: 100}]};
    instruments = [first, second]; const user = userEvent.setup(); render(<App/>);
    await screen.findByRole('heading', {name: /沪深300ETF/});
    await user.selectOptions(screen.getByLabelText('筛选买卖方向'), 'unsold');
    expect(screen.getByRole('button', {name: '编辑交易2'})).toBeTruthy();
    expect(screen.queryByRole('button', {name: '编辑交易1'})).toBeNull();
    expect(screen.queryByRole('button', {name: '编辑交易3'})).toBeNull();
    expect(screen.getByText('剩余 50 股/份')).toBeTruthy();
    await user.click(screen.getByRole('button', {name: /^全部交易/}));
    expect(screen.getByRole('button', {name: '编辑交易4'})).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('筛选买卖方向'), 'all');
    expect(screen.getByRole('button', {name: '编辑交易1'})).toBeTruthy();
    expect(screen.getByRole('button', {name: '编辑交易3'})).toBeTruthy();
  });

  it('新账本从空状态开始，并可添加 ETF', async () => {
    const user = userEvent.setup(); render(<App/>);
    await user.click(await screen.findByRole('button', {name: '添加第一个标的'}));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('标的类型'), 'etf');
    await user.type(within(dialog).getByLabelText('证券代码'), '510300');
    await user.type(within(dialog).getByLabelText('名称'), '沪深300ETF');
    await user.click(within(dialog).getByRole('button', {name: '添加标的'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', {name: /沪深300ETF/})).toBeTruthy();
    expect(requests.find(r => r.method === 'POST')?.payload).toEqual({code: '510300', name: '沪深300ETF', kind: 'etf'});
  });

  it('提交真实输入并展示保存后的买入批次', async () => {
    instruments = [blank()]; const user = userEvent.setup(); render(<App/>);
    await screen.findByRole('heading', {name: /沪深300ETF/});
    await user.click(screen.getByRole('button', {name: '买入'}));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('成交价（元）'), '3.815');
    await user.type(within(dialog).getByLabelText('数量（股 / 份）'), '1000');
    await user.clear(within(dialog).getByLabelText(/总费用/));
    await user.type(within(dialog).getByLabelText(/总费用/), '5');
    await user.click(within(dialog).getByRole('button', {name: '保存记录'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByLabelText('成本图')).toBeTruthy();
    expect(screen.getByText('¥ 3.820')).toBeTruthy();
    const submission = requests.find(r => r.path === '/trades' && r.method === 'POST')?.payload;
    expect(submission?.quantity).toBe(1000);
    expect(submission?.price).toBe('3.815');
    expect(submission?.fee).toBe('5');
  });

  it('服务端拒绝超量卖出时保留输入并显示错误', async () => {
    instruments = [blank()]; rejectSale = true; const user = userEvent.setup(); render(<App/>);
    await screen.findByRole('heading', {name: /沪深300ETF/});
    await user.click(screen.getByRole('button', {name: '卖出'}));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('成交价（元）'), '4');
    await user.type(within(dialog).getByLabelText('数量（股 / 份）'), '100');
    await user.click(within(dialog).getByRole('button', {name: '保存记录'}));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('卖出时持仓不足');
    expect((within(dialog).getByLabelText('数量（股 / 份）') as HTMLInputElement).value).toBe('100');
  });

  it('示例可预览但不会写入账本', async () => {
    const user = userEvent.setup(); render(<App/>);
    await user.click(await screen.findByRole('button', {name: '查看示例'}));
    expect(screen.getByText(/交易与行情均为虚构/)).toBeTruthy();
    expect(screen.getByLabelText('成本图')).toBeTruthy();
    await user.click(screen.getAllByRole('button', {name: '记录交易'})[0]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requests.filter(r => r.method !== 'GET')).toHaveLength(0);
    await user.click(screen.getByRole('button', {name: /退出示例/}));
    expect(await screen.findByRole('button', {name: '添加第一个标的'})).toBeTruthy();
  });

  it('股票和 ETF 费率分别保存，ETF 自动费用可覆盖且不随价格再变化', async () => {
    instruments = [blank()]; const user = userEvent.setup(); render(<App/>);
    await screen.findByRole('heading', {name: /沪深300ETF/});
    await user.click(screen.getByRole('button', {name: '打开设置'}));
    const settingsDialog = screen.getByRole('dialog');
    const rate = await within(settingsDialog).findByLabelText('ETF 交易佣金（万分之）');
    const minimum = within(settingsDialog).getByLabelText('ETF 单笔最低手续费（元）');
    await user.clear(rate); await user.type(rate, '2.5');
    await user.clear(minimum); await user.type(minimum, '5');
    const stockRate = within(settingsDialog).getByLabelText('股票 交易佣金（万分之）');
    await user.clear(stockRate); await user.type(stockRate, '1');
    await user.click(within(settingsDialog).getByRole('button', {name: '保存费率设置'}));
    await waitFor(() => expect(feeSettings.etf.commission_rate).toBe('2.5'));
    expect(feeSettings.stock.commission_rate).toBe('1');
    await user.click(within(settingsDialog).getByRole('button', {name: '关闭'}));
    await user.click(screen.getByRole('button', {name: '买入'}));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('成交价（元）'), '4');
    await user.type(within(dialog).getByLabelText('数量（股 / 份）'), '1000');
    const fee = within(dialog).getByLabelText(/总费用/) as HTMLInputElement;
    await waitFor(() => expect(fee.value).toBe('5.00'));
    await user.clear(fee); await user.type(fee, '7');
    await user.clear(within(dialog).getByLabelText('成交价（元）'));
    await user.type(within(dialog).getByLabelText('成交价（元）'), '5');
    expect(fee.value).toBe('7');
    await user.click(within(dialog).getByRole('button', {name: '保存记录'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests.find(r => r.path === '/trades')?.payload?.fee).toBe('7');
  });

  it('超过最低佣金后按费率计算，卖出同样使用自动佣金', async () => {
    instruments = [blank()]; feeSettings.etf = {commission_rate: '2.5', minimum_fee: '5'};
    const user = userEvent.setup(); render(<App/>);
    await screen.findByRole('heading', {name: /沪深300ETF/});
    await user.click(screen.getByRole('button', {name: '卖出'}));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('成交价（元）'), '4');
    await user.type(within(dialog).getByLabelText('数量（股 / 份）'), '10000');
    const fee = within(dialog).getByLabelText(/总费用/) as HTMLInputElement;
    await waitFor(() => expect(fee.value).toBe('10.00'));
    await user.clear(fee); await user.type(fee, '12');
    await user.click(within(dialog).getByRole('button', {name: '按费率重新计算'}));
    await waitFor(() => expect(Number(fee.value)).toBe(10));
    expect(within(dialog).getByText('按ETF费率自动估算佣金')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', {name: '保存记录'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests.find(r => r.path === '/trades')?.payload?.fee).toBe('10.00');
  });

  it('设置不再提供手工资金，买入仓位只查询券商', async () => {
    instruments = [blank()]; const user = userEvent.setup(); render(<App/>);
    await screen.findByRole('heading', {name: /沪深300ETF/});
    await user.click(screen.getByRole('button', {name: '打开设置'}));
    expect(screen.queryByLabelText('可用资金（元）')).toBeNull();
    expect(screen.queryByRole('button', {name: '保存资金设置'})).toBeNull();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', {name: '关闭'}));
    await user.click(screen.getByRole('button', {name: '买入'}));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('成交价（元）'), '4');
    await user.click(within(dialog).getByRole('button', {name: '全仓'}));
    await waitFor(() => expect((within(dialog).getByLabelText('数量（股 / 份）') as HTMLInputElement).value).toBe('900'));
    expect(requests.find(r => r.path === '/broker/trade/size')?.payload).toEqual({code: '510300', side: 'buy', price: '4.000', portion: 1});
    expect(requests.some(r => r.path === '/settings/account')).toBe(false);
  });

  it('编辑导入记录时费用预览采用券商实际金额，改数量后按新价格计算', async () => {
    instruments = [{...blank(), trades: [{id: 1, code: '510300', side: 'buy', executed_at: '2026-10-09T00:00:00',
      price: '2.356', quantity: 2100, fee: '0.25', gross_amount: '4948.400', note: '交割单', buy_lot_id: null, realized_pnl: null, allocations: []}]}];
    const user = userEvent.setup(); render(<App/>);
    await user.click(await screen.findByRole('button', {name: '编辑交易1'}));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('¥ 4,948.65')).toBeTruthy();
    const quantity = within(dialog).getByLabelText('数量（股 / 份）');
    await user.clear(quantity); await user.type(quantity, '1000');
    expect(within(dialog).getByText('¥ 2,356.25')).toBeTruthy();
  });

  it('点击买入批次打开卖出，预选对应批次与剩余数量并保存指定批次', async () => {
    instruments = [{...blank(), quantity: 1400, lots: [
      {id: 17, executed_at: '2026-10-09T10:00:00', quantity: 1300, remaining: 500, price: '3.8', fee: '0', unit_cost: '3.8'},
      {id: 18, executed_at: '2026-10-10T10:00:00', quantity: 900, remaining: 900, price: '3.9', fee: '0', unit_cost: '3.9'},
    ]}];
    const user = userEvent.setup(); render(<App/>);
    await user.click(await screen.findByRole('button', {name: '卖出买入批次17'}));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText('卖出成本匹配') as HTMLSelectElement).value).toBe('17');
    expect((within(dialog).getByLabelText('数量（股 / 份）') as HTMLInputElement).value).toBe('500');
    await user.type(within(dialog).getByLabelText('成交价（元）'), '4');
    await user.click(within(dialog).getByRole('button', {name: '保存记录'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests.find(r => r.path === '/trades')?.payload).toMatchObject({side: 'sell', buy_lot_id: 17, quantity: 500});
  });

  it('卖出盈亏包含买入成本和费用，低价卖出显示亏损，刷新费用时不使用旧金额', async () => {
    instruments = [blank()]; feeSettings.etf = {commission_rate: '2.5', minimum_fee: '5'};
    const user = userEvent.setup(); render(<App/>);
    await screen.findByRole('heading', {name: /沪深300ETF/});
    await user.click(screen.getByRole('button', {name: '卖出'}));
    const dialog = screen.getByRole('dialog');
    const preview = () => within(dialog).getByText('本次卖出盈亏').parentElement!.querySelector('strong')!.textContent;
    expect(preview()).toBe('—');
    await user.type(within(dialog).getByLabelText('成交价（元）'), '4');
    await user.type(within(dialog).getByLabelText('数量（股 / 份）'), '10000');
    await waitFor(() => expect(preview()).toBe('¥ -5,010.00'));
    const previousFetch = globalThis.fetch;
    let resolve: (response: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => String(url).endsWith('/fees/estimate')
      ? new Promise<Response>(r => {resolve = r;}) : previousFetch(url, init)));
    await user.clear(within(dialog).getByLabelText('成交价（元）'));
    expect(preview()).toBe('—');
    await user.type(within(dialog).getByLabelText('成交价（元）'), '5');
    expect(preview()).toBe('计算中…');
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => String(url).endsWith('/fees/estimate'))).toBe(true));
    resolve(new Response('{"fee":"12.50"}'));
    await waitFor(() => expect(preview()).toBe('¥ +4,987.50'));
    const fee = within(dialog).getByLabelText(/总费用/);
    await user.clear(fee); expect(preview()).toBe('—');
    await user.type(fee, '20');
    await waitFor(() => expect(preview()).toBe('¥ +4,980.00'));
  });

  it('买入录入期望盈利目标，保存到对应批次并在编辑中回填', async () => {
    instruments = [blank()]; const user = userEvent.setup(); render(<App/>);
    await screen.findByRole('heading', {name: /沪深300ETF/});
    await user.click(screen.getByRole('button', {name: '买入'}));
    let dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('成交价（元）'), '4');
    await user.type(within(dialog).getByLabelText('数量（股 / 份）'), '1000');
    await user.type(within(dialog).getByLabelText(/本次买入期望盈利/), '3');
    await user.click(within(dialog).getByRole('button', {name: '保存记录'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests.find(r => r.path === '/trades')?.payload).toMatchObject({target_profit_percent: '3', target_profit_amount: null});
    expect(screen.getByText('目标 +3.00%')).toBeTruthy();
    await user.click(screen.getByRole('button', {name: '编辑交易1'}));
    dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText(/本次买入期望盈利/) as HTMLInputElement).value).toBe('3');
    await user.selectOptions(within(dialog).getByLabelText('盈利目标类型'), 'amount');
    await user.clear(within(dialog).getByLabelText(/本次买入期望盈利/));
    await user.type(within(dialog).getByLabelText(/本次买入期望盈利/), '100');
    await user.click(within(dialog).getByRole('button', {name: '保存记录'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests.find(r => r.path === '/trades/1')?.payload).toMatchObject({target_profit_percent: null, target_profit_amount: '100'});
  });
});
