import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { api } from '../api';
import { money, signed } from '../types';
import './BrokerPage.css';
import { BrokerSyncDialog } from './BrokerSyncDialog';
import { WatchlistDialog } from './WatchlistDialog';
import type { Instrument } from '../types';
import { BrokerOrderDialog, type OrderSeed } from './BrokerOrderDialog';
import { BrokerDealsTable } from './BrokerDealsTable';
import { DealBuybackDialog, type SellTState } from './DealBuybackDialog';
import { DealLotSplit, splitSelection, type SplitQuantities } from './DealLotSplit';

export type BrokerQuery = 'positions' | 'assets' | 'deals' | 'orders' | 'cancelable' | 'history-deals' | 'history-cash-detail' | 'history-delivery';
type Query = BrokerQuery;
type Connection = {installed: boolean; connected: boolean; native_ready: boolean; logged_in: boolean; ready: boolean; message: string};
type Position = {code: string | null; name: string | null; quantity: string | null; available: string | null; cost_price: string | null; price: string | null; market_value: string | null; profit: string | null};
export type RecordRow = {t_trade?: boolean; t_mixed?: boolean; has_t_links?: boolean; rows?: RecordRow[]; grouped?: boolean; sync_quantity?: number; lot_allocations?: {buy_id: number; quantity: number}[] | null; buy_lot_id?: number | null; needs_lot_selection?: boolean; synced?: boolean; sync_token?: string | null; sync_reason?: string | null; id: number | string; date: string | null; time: string | null; code: string | null; name: string | null; operation: string | null; side: 'buy' | 'sell' | null; price: string | null; quantity: string | null; amount: string | null; fee: string | null; cash_change: string | null; balance: string | null; status: string | null; filled_quantity: string | null};
type Assets = {total_assets: string | null; market_value: string | null; cash_balance: string | null; available_cash: string | null; frozen_cash: string | null; withdrawable_cash: string | null};
type Result = {order_groups?: RecordRow[]; query: Query; account_type: 'normal' | 'credit'; is_credit: boolean; fetched_at: string; warnings: string[]; rows?: Position[] | RecordRow[]; assets?: Assets; start_date?: string; end_date?: string};

const tabs: {key: Query; label: string}[] = [
  {key: 'positions', label: '持仓'}, {key: 'assets', label: '资产'}, {key: 'deals', label: '当日成交'},
  {key: 'orders', label: '当日委托'}, {key: 'cancelable', label: '可撤委托'},
  {key: 'history-deals', label: '历史成交'}, {key: 'history-cash-detail', label: '资金流水'}, {key: 'history-delivery', label: '交割单'},
];
function localDate() {
  const day = new Date();
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}
const pnlClass = (value: string | null) => value == null || Number(value) === 0 ? '' : Number(value) > 0 ? 'positive' : 'negative';
const pnlText = (value: string | null) => value == null ? '—' : signed(value);

export function BrokerPage({demo = false, initialQuery = 'positions', page = 'account', instruments = [], onLedgerChange}: {demo?: boolean; initialQuery?: BrokerQuery; page?: 'account' | 'deals'; instruments?: Instrument[]; onLedgerChange?: () => void}) {
  const dealsOnly = page === 'deals';
  const entryQuery = dealsOnly ? 'deals' : initialQuery === 'deals' ? 'positions' : initialQuery;
  const [sync, setSync] = useState(false);
  const [syncingDeal, setSyncingDeal] = useState<string | null>(null);
  const [tSwitching, setTSwitching] = useState<string | null>(null);
  const [buybackRow, setBuybackRow] = useState<RecordRow | null>(null);
  const [buybackBusy, setBuybackBusy] = useState(false);
  const [tErrors, setTErrors] = useState<Record<string, string>>({});
  const [dealMessages, setDealMessages] = useState<Record<string, {done: boolean; text: string}>>({});
  const dealInFlight = useRef(false);
  const [dealAllocations, setDealAllocations] = useState<Record<string, string>>({});
  const [dealSplits, setDealSplits] = useState<Record<string, SplitQuantities>>({});
  const availableLots = (row: RecordRow) => (instruments.find(item => item.code === row.code)?.lots ?? [])
    .filter(lot => lot.remaining > 0);
  const selectedSplit = (row: RecordRow) => splitSelection(availableLots(row), dealSplits[row.sync_token ?? ''] ?? {}, Number(row.sync_quantity ?? row.quantity));
  const allocationReady = (row: RecordRow) => row.side !== 'sell' || !!row.buy_lot_id
    || (!!row.sync_token && (dealAllocations[row.sync_token] === 'split'
      ? selectedSplit(row).valid : !!dealAllocations[row.sync_token]));

  async function syncDeal(row: RecordRow) {
    if (demo || !row.sync_token || dealInFlight.current) return;
    const token = row.sync_token;
    const allocation = dealAllocations[token];
    if (!allocationReady(row)) return;
    dealInFlight.current = true; setSyncingDeal(token);
    try {
      const response = await api<{inserted: boolean; message: string}>(row.rows ? '/broker/sync/deal-group' : '/broker/sync/deal', {
        method: 'POST', body: JSON.stringify({token, ...(row.side === 'sell' && !row.buy_lot_id
          ? allocation === 'split' ? {allocation: 'split', allocations: selectedSplit(row).allocations}
            : allocation === 'fifo' ? {allocation: 'fifo'} : {allocation: 'manual', buy_lot_id: Number(allocation)} : {})}),
      });
      setDealMessages(current => ({...current, [token]: {done: true, text: response.message}}));
      onLedgerChange?.();
    } catch (err) {
      setDealMessages(current => ({...current, [token]: {done: false, text: (err as Error).message}}));
    } finally {
      dealInFlight.current = false; setSyncingDeal(null);
    }
  }
  async function toggleT(row: RecordRow, enabled: boolean) {
    if (demo || busy || !row.sync_token || row.side !== 'sell' || dealInFlight.current) return;
    const id = String(row.id);
    dealInFlight.current = true; setTSwitching(id); setTErrors(current => ({...current, [id]: ''}));
    try {
      const saved = await api<{t_trade: boolean; t_mixed: boolean; has_t_links: boolean}>('/broker/sync/deal-group/t-setting', {
        method: 'PUT', body: JSON.stringify({token: row.sync_token, t_trade: enabled}),
      });
      const fillIds = new Set((row.rows ?? [row]).map(fill => fill.id));
      setResult(current => current ? {...current,
        order_groups: current.order_groups?.map(group => group.id === row.id ? {...group, ...saved,
          rows: group.rows?.map(fill => ({...fill, t_trade: saved.t_trade}))} : group),
        rows: (current.rows as RecordRow[] | undefined)?.map(fill => fillIds.has(fill.id) ? {...fill, ...saved} : fill),
      } : current);
      onLedgerChange?.();
    } catch (err) {setTErrors(current => ({...current, [id]: (err as Error).message}));}
    finally {dealInFlight.current = false; setTSwitching(null);}
  }
  const onBuybackBusy = useCallback((value: boolean) => {dealInFlight.current = value; setBuybackBusy(value);}, []);
  function onBuybackChanged(states: SellTState[]) {
    if (!states.length) {onLedgerChange?.(); return;}
    const linked = new Map(states.map(state => [state.key, state.has_t_links]));
    setResult(current => current ? {...current, order_groups: current.order_groups?.map(group => {
      const key = `${group.code}:${group.side}:${group.date}:${group.id}`;
      return linked.has(key) ? {...group, has_t_links: linked.get(key)} : group;
    })} : current);
  }
  const [watchlist, setWatchlist] = useState(false);
  const [order, setOrder] = useState<OrderSeed | null>(null);
  const [tab, setTab] = useState<Query>(entryQuery);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [side, setSide] = useState('all');
  const [dates, setDates] = useState(() => ({start: `${localDate().slice(0, 7)}-01`, end: localDate()}));
  const active = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const today = localDate();
  const history = tab.startsWith('history-');
  const label = tabs.find(item => item.key === tab)!.label;

  async function refresh(query: Query, range: {start: string; end: string}) {
    if (demo || inFlight.current || dealInFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); setResult(null);
    try {
      const state = await api<Connection>('/broker/status', {signal: controller.signal});
      if (controller.signal.aborted) return;
      setConnection(state);
      if (!state.ready) {setError(state.message || '请启动并登录同花顺下单客户端'); return;}
      const params = query.startsWith('history-') ? `?${new URLSearchParams({start_date: range.start, end_date: range.end})}` : '';
      const data = await api<Result>(`/broker/${query}${params}`, {signal: controller.signal});
      if (!controller.signal.aborted) setResult(data);
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message);
    } finally {
      if (active.current === controller) {
        inFlight.current = false;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }

  useEffect(() => {
    if (demo) {setResult(null); setConnection(null); setError(''); setBusy(false); return;}
    // Deferring also prevents React StrictMode's first, discarded mount from
    // starting a second native query or authorization prompt.
    setTab(entryQuery);
    const timer = window.setTimeout(() => void refresh(entryQuery, dates), 0);
    return () => {window.clearTimeout(timer); active.current?.abort(); active.current = null; inFlight.current = false;};
    // Queries run only on entry or an explicit tab / refresh action.
  }, [demo, entryQuery]);

  function changeTab(query: Query) {
    if (dealInFlight.current) return;
    setTab(query); setSearch(''); setSide('all');
    void refresh(query, dates);
  }
  function submitHistory(event: FormEvent) {event.preventDefault(); void refresh(tab, dates);}
  const positions = (result?.query === 'positions' ? result.rows ?? [] : []) as Position[];
  const matches = (row: {code: string | null; name: string | null}) => `${row.code ?? ''}${row.name ?? ''}`.toLowerCase().includes(search.trim().toLowerCase());
  const records = ((result?.query !== 'positions' ? result?.rows ?? [] : []) as RecordRow[])
    .filter(row => matches(row) && (side === 'all' || row.side === side));
  if (result?.query === 'deals') {
    records.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')
      || (b.time ?? '').localeCompare(a.time ?? '') || Number(b.id) - Number(a.id));
  }
  const allPresent = (key: 'market_value' | 'profit') => positions.length > 0 && positions.every(row => row[key] != null);
  const sum = (key: 'market_value' | 'profit') => positions.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const cash = tab === 'history-cash-detail';
  const orders = tab === 'orders' || tab === 'cancelable';
  const dateChanged = history && result && (result.start_date !== dates.start || result.end_date !== dates.end);

  const dealGroups = tab === 'deals' ? (result?.order_groups ?? records).filter(matches)
    .filter(row => side === 'all' || row.side === side)
    .sort((a, b) => `${b.date ?? ''}T${b.time ?? ''}`.localeCompare(`${a.date ?? ''}T${a.time ?? ''}`)) : [];
  function allocationControl(row: RecordRow) {
    if (row.side !== 'sell') return null;
    if (row.lot_allocations?.length) return <small>多批次分摊 · {row.lot_allocations.map(item => `#${item.buy_id} × ${item.quantity}`).join('，')}</small>;
    if (row.buy_lot_id) return <small>关联买入批次 #{row.buy_lot_id}</small>;
    if (!row.sync_token || row.synced || dealMessages[row.sync_token]?.done) return null;
    const token = row.sync_token;
    const lots = availableLots(row);
    return <><select className="broker-sync-lot" aria-label={`成交${row.id}的成本批次`} disabled={syncingDeal !== null} value={dealAllocations[token] ?? ''}
      onChange={event => setDealAllocations(current => ({...current, [token]: event.target.value}))}>
      <option value="">请选择买入批次</option>{lots.map(lot => <option key={lot.id} value={lot.id}>#{lot.id} · {lot.executed_at.slice(0, 10)} · 剩余 {money(lot.remaining, 0)}</option>)}<option value="split">多批次分摊</option><option value="fifo">先进先出（手动确认）</option>
    </select>{dealAllocations[token] === 'split' && <DealLotSplit lots={lots} total={Number(row.sync_quantity ?? row.quantity)}
      quantities={dealSplits[token] ?? {}} disabled={syncingDeal !== null}
      onChange={quantities => setDealSplits(current => ({...current, [token]: quantities}))}/>}</>;
  }

  return <div className="broker-page">
    {buybackRow && !demo && <DealBuybackDialog row={buybackRow} onClose={() => setBuybackRow(null)} onBusyChange={onBuybackBusy} onChanged={onBuybackChanged}/>}
    {sync && !demo && <BrokerSyncDialog onClose={() => setSync(false)} onChanged={onLedgerChange}/>}
    {watchlist && !demo && <WatchlistDialog instruments={instruments} onClose={() => setWatchlist(false)} onChanged={onLedgerChange}/>}
    {order && !demo && <BrokerOrderDialog onIntentChanged={onLedgerChange} seed={order} onClose={() => setOrder(null)} onSubmitted={() => changeTab('orders')} onOrders={() => {setOrder(null); changeTab('orders');}}/>}
    <div className="page-heading"><h1>{dealsOnly ? '当日成交' : '券商账户'}</h1><div className="broker-heading-actions">{!dealsOnly && <><button className="button secondary" disabled={busy || demo} onClick={() => setSync(true)}>成交同步</button><button className="button secondary" disabled={busy || demo} onClick={() => setWatchlist(true)}>自选同步</button><button className="button secondary" disabled={busy || demo || !connection?.ready} onClick={() => setOrder({side: 'buy'})}>买入委托</button><button className="button secondary" disabled={busy || demo || !connection?.ready} onClick={() => setOrder({side: 'sell'})}>卖出委托</button></>}<button className="button secondary" disabled={busy || demo || syncingDeal !== null || tSwitching !== null || buybackBusy} onClick={() => void refresh(tab, dates)}><RefreshCw size={15} className={busy ? 'spin' : ''}/>{busy ? '正在查询' : '刷新'}</button></div></div>
    <div className="broker-connection" role="status"><span className={`broker-status-dot ${connection?.ready ? 'ready' : ''}`}/><span>{demo ? '退出示例后可查询券商账户' : busy ? '正在查询同花顺' : connection?.ready ? `已连接同花顺${result ? result.is_credit ? ' · 信用账户' : ' · 普通账户' : ''}` : connection ? connection.installed ? '同花顺未就绪' : '交易技能未安装' : '正在检查连接'}</span>{result && <span className="broker-updated">更新于 {result.fetched_at.slice(11, 19)}</span>}</div>
    {!dealsOnly && <div className="broker-tabs" role="tablist" aria-label="券商查询类型">{tabs.filter(item => item.key !== 'deals').map(item => <button key={item.key} role="tab" aria-selected={tab === item.key} aria-controls="broker-query-panel" id={`broker-tab-${item.key}`} disabled={busy || demo} className={tab === item.key ? 'active' : ''} onClick={() => changeTab(item.key)}>{item.label}</button>)}</div>}
    {history && <form className="broker-date-form" onSubmit={submitHistory}><label>开始日期<input type="date" required aria-label="券商查询开始日期" max={dates.end || today} value={dates.start} disabled={busy} onChange={e => setDates(current => ({...current, start: e.target.value}))}/></label><label>结束日期<input type="date" required aria-label="券商查询结束日期" min={dates.start} max={today} value={dates.end} disabled={busy} onChange={e => setDates(current => ({...current, end: e.target.value}))}/></label><button className="button secondary" type="submit" disabled={busy || demo || !dates.start || !dates.end || dates.start > dates.end || dates.end > today}>查询</button>{dateChanged && <span>日期已调整，点击查询更新结果</span>}</form>}
    {error && <div className="broker-error" role="alert">{error}</div>}
    {result?.warnings.map(warning => <div className="broker-notice" role="status" key={warning}>{warning}</div>)}
    <div role={dealsOnly ? 'region' : 'tabpanel'} id="broker-query-panel" aria-label={dealsOnly ? '当日成交' : undefined} aria-labelledby={dealsOnly ? undefined : `broker-tab-${tab}`}>
      {busy ? <div className="panel broker-empty"><LoaderCircle size={20} className="spin"/><span>正在查询…</span><small>如果同花顺弹出授权，请在客户端确认。</small></div> : result?.query === tab ? <>
        {tab === 'positions' && <div className="summary-grid"><Metric label="持仓市值" value={allPresent('market_value') ? `¥ ${money(sum('market_value'))}` : positions.length === 0 ? '¥ 0.00' : '—'}/><Metric label="持仓盈亏" value={allPresent('profit') ? `¥ ${signed(sum('profit'))}` : positions.length === 0 ? '¥ 0.00' : '—'} className={allPresent('profit') ? pnlClass(String(sum('profit'))) : ''}/><Metric label="持仓标的" value={`${positions.length} 只`}/><Metric label="持仓数量" value={positions.every(row => row.quantity != null) ? money(positions.reduce((total, row) => total + Number(row.quantity), 0), 0) : '—'}/></div>}
        {tab === 'assets' && result.assets ? <div className="broker-assets">{([
          ['总资产', 'total_assets'], ['股票市值', 'market_value'], ['资金余额', 'cash_balance'],
          ['可用资金', 'available_cash'], ['冻结资金', 'frozen_cash'], ['可取资金', 'withdrawable_cash'],
        ] as const).map(([name, key]) => <Metric key={key} label={name} value={result.assets![key] == null ? '—' : `¥ ${money(result.assets![key])}`}/>)}</div> : <section className="panel broker-table">
          <div className="panel-heading"><h3>{label}<span className="soft-count">{tab === 'positions' ? positions.filter(matches).length : tab === 'deals' ? dealGroups.length : records.length}</span></h3><div className="broker-table-tools"><div className="broker-search"><Search size={14}/><input aria-label="筛选券商标的" placeholder="名称或代码" value={search} onChange={e => setSearch(e.target.value)}/></div>{tab !== 'positions' && !cash && <select aria-label="券商买卖筛选" value={side} onChange={e => setSide(e.target.value)}><option value="all">全部方向</option><option value="buy">买入</option><option value="sell">卖出</option></select>}</div></div>
          {tab === 'deals' && !result.is_credit && <div className="broker-range">按委托合并显示，展开查看分笔成交；同步后仍保留每笔真实记录。</div>}
          {result.start_date && <div className="broker-range">{result.start_date} 至 {result.end_date}</div>}
          {tab === 'deals' ? <BrokerDealsTable rows={dealGroups} messages={dealMessages} syncing={syncingDeal ?? (tSwitching ? 't-setting' : buybackBusy ? 't-buyback' : null)} tSwitching={tSwitching} tErrors={tErrors} onToggleT={(row, enabled) => void toggleT(row, enabled)} onAssociateBuyback={row => {if (!demo && !dealInFlight.current) setBuybackRow(row);}} demo={demo} allocationControl={allocationControl} allocationReady={allocationReady} onSync={row => void syncDeal(row)}/> : tab === 'positions' ? <div className="table-scroll"><table><thead><tr><th>标的</th><th className="numeric">持仓数量</th><th className="numeric">可用数量</th><th className="numeric">成本价</th><th className="numeric">现价</th><th className="numeric">市值</th><th className="numeric">持仓盈亏</th><th>操作</th></tr></thead><tbody>{positions.filter(matches).map((row, index) => <tr key={`${row.code}:${index}`}><td><strong>{row.name ?? '—'}</strong><small>{row.code ?? '—'}</small></td><td className="numeric">{money(row.quantity, 0)}</td><td className="numeric">{money(row.available, 0)}</td><td className="numeric">{money(row.cost_price, 3)}</td><td className="numeric">{money(row.price, 3)}</td><td className="numeric">{money(row.market_value)}</td><td className={`numeric ${pnlClass(row.profit)}`}>{pnlText(row.profit)}</td><td><button className="button secondary" disabled={!row.code || Number(row.available ?? 0) <= 0} onClick={() => setOrder({side: 'sell', code: row.code ?? undefined, name: row.name ?? undefined, price: row.price ?? undefined})}>卖出</button></td></tr>)}</tbody></table>{positions.filter(matches).length === 0 && <div className="broker-empty">{positions.length ? '没有匹配的标的' : '当前账户暂无持仓'}</div>}</div> : <div className="table-scroll"><table><thead><tr><th>{orders ? '委托时间' : '交易时间'}</th><th>标的</th><th>业务</th><th className="numeric">{orders ? '委托价' : '成交价'}</th><th className="numeric">数量</th>{orders ? <><th className="numeric">成交数量</th><th>状态</th></> : <><th className="numeric">成交金额</th><th className="numeric">费用</th>{cash && <><th className="numeric">资金变动</th><th className="numeric">资金余额</th></>}</>}</tr></thead><tbody>{records.map(row => <tr key={row.id}><td><strong>{row.date ?? '—'}</strong><small>{row.time ?? '—'}</small></td><td><strong>{row.name ?? '—'}</strong><small>{row.code ?? '—'}</small></td><td><span className={`broker-side ${row.side ?? ''}`}>{row.operation ?? '—'}</span></td><td className="numeric">{money(row.price, 3)}</td><td className="numeric">{money(row.quantity, 0)}</td>{orders ? <><td className="numeric">{money(row.filled_quantity, 0)}</td><td>{row.status ?? '—'}</td></> : <><td className="numeric">{money(row.amount)}</td><td className="numeric">{money(row.fee)}</td>{cash && <><td className={`numeric ${pnlClass(row.cash_change)}`}>{pnlText(row.cash_change)}</td><td className="numeric">{money(row.balance)}</td></>}</>}</tr>)}</tbody></table>{records.length === 0 && <div className="broker-empty">{result.rows?.length ? '没有匹配的记录' : '本次查询未返回记录'}</div>}</div>}
        </section>}
        <div className="broker-footnote">数据来自同花顺当前账户 · 点击同步后才写入账本{tab !== 'positions' && tab !== 'assets' && !orders ? ' · 缺失字段显示 —' : ''}</div>
      </> : !error && <div className="panel broker-empty">{demo ? '退出示例模式后即可查询' : '连接同花顺后查询账户数据'}</div>}
    </div>
  </div>;
}

function Metric({label, value, className = ''}: {label: string; value: string; className?: string}) {
  return <div className="summary-card"><div className="summary-label">{label}</div><div className={`summary-value ${className}`}>{value}</div></div>;
}
