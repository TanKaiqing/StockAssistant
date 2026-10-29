import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDownLeft, ArrowUpRight, ArrowRight, BarChart3, Calculator, Check, ClipboardList, Download, FolderOpen, Layers3, ListFilter, LoaderCircle, Moon, Pencil, Plus, Radio, ReceiptText, RefreshCw, Search, Settings2, Sparkles, Sun, Target, Trash2, Wallet, X } from 'lucide-react';
import { api } from './api';
import type { StopLossDefaults, TTradePlan } from './types';
import { CostChart } from './components/CostChart';
import { TopbarSummary } from './components/TopbarSummary';
import { Modal } from './components/Modal';
import { SettingsDialog } from './components/SettingsDialog';
import { TradeDialog, type TradeForm } from './components/TradeDialog';
import { demoData } from './demo';
import { holdingMetrics, localNow, money, priceDigits, signed, type Instrument, type Lot, type Market, type Quote, type Trade } from './types';
import { BuyLots } from './components/BuyLots';
import { TradePagination } from './components/TradePagination';
import { AnalyticsPage } from './components/AnalyticsPage';
import { readRefreshSeconds, useRefreshCountdown } from './useRefreshCountdown';
import { InstrumentFields } from './components/InstrumentFields';
import { ReachedTargetsPage } from './components/ReachedTargetsPage';
import { applyTheme, readTheme } from './theme';
import { BrokerPage, type BrokerQuery } from './components/BrokerPage';
import { QuoteBridgePage } from './components/QuoteBridgePage';
import { TTradeCalculator } from './components/TTradeCalculator';
import { TradePlansPage } from './components/TradePlansPage';
import { useQuoteStream } from './useQuoteStream';
import { isTradingSession, useTradingSession } from './tradingSession';

const emptyTrade = (): TradeForm => ({side: 'buy', executed_at: localNow(), price: '', quantity: '', fee: '0', note: '', buy_lot_id: '', target_mode: 'percent', target_value: '', stop_loss_percent: '2', stop_loss_amount: '', stop_loss_mode: 'percent'});

export default function App() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [markets, setMarkets] = useState<Record<string, Market>>({});
  const [marketErrors, setMarketErrors] = useState<Record<string, string>>({});
  const [loadingMarkets, setLoadingMarkets] = useState<string[]>([]);
  const [refreshRevisions, setRefreshRevisions] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [demo, setDemo] = useState(false);
  const demoRef = useRef(false);
  const requestedChart = useRef('');
  const requestedQuotes = useRef(new Set<string>());
  const pushedCodes = useRef(new Set<string>());
  const inflight = useRef(new Set<string>());
  const marketRequests = useRef(new Map<string, AbortController>());
  const activeMarketOptions = useRef(new Map<string, {history: boolean; intraday: boolean; once: boolean; depth: boolean}>());
  const pendingMarketRefresh = useRef(new Map<string, {history: boolean; intraday: boolean; depth: boolean}>());
  const [offHoursRefresh, setOffHoursRefresh] = useState(0);
  const marketOpen = useTradingSession();
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'holdings' | 'trades' | 'analytics' | 'targets' | 'broker' | 'bridge' | 'today-deals' | 't-calc' | 'plans'>('targets');
  const [targetBuybacks, setTargetBuybacks] = useState<TTradePlan[]>([]);
  const [buybackError, setBuybackError] = useState('');
  const [brokerInitialQuery, setBrokerInitialQuery] = useState<BrokerQuery>('positions');
  const [targetRefreshBusy, setTargetRefreshBusy] = useState(false);
  const targetRefreshInFlight = useRef(false);
  const targetRefreshQueued = useRef(false);
  const [targetRefreshRevision, setTargetRefreshRevision] = useState(0);
  const [range, setRange] = useState<'1M' | '3M' | '1Y' | 'ALL'>('3M');
  const [chartMode, setChartMode] = useState<'intraday' | 'daily'>(() => localStorage.getItem('chartMode') === 'daily' ? 'daily' : 'intraday');
  const [showClosed, setShowClosed] = useState(false);
  const [focusedLot, setFocusedLot] = useState<number | null>(null);
  const [tradeFilter, setTradeFilter] = useState<'all' | 'buy' | 'sell' | 'unsold'>('all');
  const [tradePage, setTradePage] = useState(1);
  const [tradePageSize, setTradePageSize] = useState(() => {
    const saved = Number(localStorage.getItem('tradePageSize'));
    return [20, 50, 100].includes(saved) ? saved : 20;
  });
  useEffect(() => setTradePage(1), [tradeFilter, tradePageSize, view, demo]);
  const [autoRefresh, setAutoRefresh] = useState(() => localStorage.getItem('autoRefresh') === 'true');
  const [refreshSeconds, setRefreshSeconds] = useState(readRefreshSeconds);
  const [quotePush, setQuotePush] = useState(() => localStorage.getItem('quotePush') !== 'false');
  const [now, setNow] = useState(Date.now);
  const [settings, setSettings] = useState(false);
  const [feeRevision, setFeeRevision] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [instrumentForm, setInstrumentForm] = useState({code: '', name: '', kind: 'stock' as 'stock' | 'etf'});
  const [tradeOpen, setTradeOpen] = useState(false);
  const [editing, setEditing] = useState<Trade | null>(null);
  const [tradeCode, setTradeCode] = useState('');
  const [tradeForm, setTradeForm] = useState<TradeForm>(emptyTrade);
  const [manualFee, setManualFee] = useState(false);
  const [feeError, setFeeError] = useState('');
  const [feeLoading, setFeeLoading] = useState(false);
  const [resolvedFeeKey, setResolvedFeeKey] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Trade | null>(null);
  const [removing, setRemoving] = useState<Instrument | null>(null);
  const [toast, setToast] = useState('');

  const selected = instruments.find(item => item.code === selectedCode) ?? instruments[0];
  const market = selected ? markets[selected.code] : undefined;
  const marketError = selected ? marketErrors[selected.code] : '';
  const quote = market?.quote;
  const digits = selected ? priceDigits(selected.kind) : 2;
  const selectedMetrics = selected ? holdingMetrics(selected) : null;
  const unrealized = selected && quote && selected.quantity > 0 && selectedMetrics?.cost != null
    ? quote.price * selected.quantity - selectedMetrics.cost : null;
  const totalCost = instruments.reduce((sum, item) => sum + Number(item.cost), 0);
  const totalRealized = instruments.reduce((sum, item) => sum + Number(item.realized_pnl), 0);
  const tradeCount = instruments.reduce((sum, item) => sum + item.trades.length, 0);
  const tradeInstrument = instruments.find(i => i.code === tradeCode);
  const tradeAmount = editing?.gross_amount != null && Number(tradeForm.price) === Number(editing.price) && Number(tradeForm.quantity) === editing.quantity
    ? Number(editing.gross_amount) : Number(tradeForm.price) * Number(tradeForm.quantity);
  const feeKey = `${tradeCode}|${tradeInstrument?.kind}|${tradeForm.price}|${tradeForm.quantity}`;
  const amountValid = tradeForm.price.trim() !== '' && Number.isFinite(Number(tradeForm.price)) && Number(tradeForm.price) > 0
    && Number.isInteger(Number(tradeForm.quantity)) && Number(tradeForm.quantity) > 0;
  const manualFeeValid = tradeForm.fee.trim() !== '' && Number.isFinite(Number(tradeForm.fee)) && Number(tradeForm.fee) >= 0;
  const previewValue = !amountValid || (manualFee && !manualFeeValid) ? '—'
    : !manualFee && feeError ? '暂不可用'
    : !manualFee && (feeLoading || resolvedFeeKey !== feeKey) ? '计算中…'
    : `¥ ${money(tradeAmount + (tradeForm.side === 'buy' ? 1 : -1) * Number(tradeForm.fee))}`;
  useEffect(() => {
    if (!tradeOpen || manualFee || !tradeInstrument) return;
    let active = true;
    const controller = new AbortController();
    setFeeError('');
    setResolvedFeeKey(null);
    if (!(Number(tradeForm.price) > 0) || !Number.isInteger(Number(tradeForm.quantity)) || Number(tradeForm.quantity) <= 0) {
      setTradeForm(current => ({...current, fee: '0'}));
      setFeeLoading(false);
      return;
    }
    setFeeLoading(true);
    const timer = window.setTimeout(() => {
      void api<{fee: string}>('/fees/estimate', {method: 'POST', signal: controller.signal, body: JSON.stringify({
        kind: tradeInstrument.kind, price: tradeForm.price, quantity: Number(tradeForm.quantity),
      })}).then(result => {if (active) {setTradeForm(current => ({...current, fee: result.fee})); setResolvedFeeKey(feeKey);}})
        .catch(err => {if (active) setFeeError(err.message);})
        .finally(() => {if (active) setFeeLoading(false);});
    }, 250);
    return () => {active = false; controller.abort(); window.clearTimeout(timer);};
  }, [tradeOpen, manualFee, tradeInstrument?.kind, tradeForm.price, tradeForm.quantity, feeKey]);
  const remainingByTrade = new Map(instruments.flatMap(i => i.lots.map(lot => [`${i.code}:${lot.id}`, lot.remaining] as const)));
  const displayedTrades = (view === 'trades' ? instruments.flatMap(i => i.trades) : selected?.trades ?? [])
    .filter(t => tradeFilter === 'all' || (tradeFilter === 'unsold'
      ? t.side === 'buy' && (remainingByTrade.get(`${t.code}:${t.id}`) ?? 0) > 0
      : t.side === tradeFilter))
    .sort((a, b) => b.executed_at.localeCompare(a.executed_at) || b.id - a.id);
  const tradePages = Math.max(1, Math.ceil(displayedTrades.length / tradePageSize));
  const currentTradePage = Math.min(tradePage, tradePages);
  const pagedTrades = view === 'trades'
    ? displayedTrades.slice((currentTradePage - 1) * tradePageSize, currentTradePage * tradePageSize)
    : displayedTrades;
  useEffect(() => setTradePage(current => Math.min(current, tradePages)), [tradePages]);
  const tradedInstruments = instruments.filter(item => item.quantity > 0 || item.trades.length > 0);
  const filtered = tradedInstruments.filter(item => `${item.name}${item.code}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(b.quantity > 0) - Number(a.quantity > 0));

  const load = useCallback(async () => {
    try {
      const result = await api<{instruments: Instrument[]}>('/portfolio');
      const ordered = [...result.instruments].sort((a, b) => Number(b.quantity > 0) - Number(a.quantity > 0));
      if (!demoRef.current) {
        setInstruments(ordered);
        setSelectedCode(current => ordered.some(i => i.code === current) ? current : ordered[0]?.code ?? null);
      }
      setError('');
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => { setFocusedLot(null); }, [selected?.code]);

  const refreshMarket = useCallback(async (code: string, history = false, intraday = false, once = false, depth = false): Promise<void> => {
    if ((!once && !isTradingSession()) || demoRef.current || (!once && pushedCodes.current.has(code) && !history && !intraday && !depth)) return;
    if (inflight.current.has(code)) {
      const active = activeMarketOptions.current.get(code);
      if (once && !(active?.once && (!history || active.history) && (!intraday || active.intraday) && (!depth || active.depth)
          && !marketRequests.current.get(code)?.signal.aborted)) {
        const pending = pendingMarketRefresh.current.get(code);
        pendingMarketRefresh.current.set(code, {history: history || !!pending?.history, intraday: intraday || !!pending?.intraday, depth: depth || !!pending?.depth});
      }
      return;
    }
    activeMarketOptions.current.set(code, {history, intraday, once, depth});
    const controller = new AbortController();
    marketRequests.current.set(code, controller);
    inflight.current.add(code);
    setLoadingMarkets(current => [...current, code]);
    try {
      const result = await api<Market>(`/market/${code}?history=${history}&intraday=${intraday}&once=${once}&depth=${depth}`, {signal: controller.signal});
      if (demoRef.current || controller.signal.aborted) return;
      setNow(Date.now());
      setMarkets(current => ({...current, [code]: {
        ...result, source: !once && !depth && pushedCodes.current.has(code) ? current[code]?.quote?.source ?? result.source : result.source,
        quote: !once && !depth && pushedCodes.current.has(code) && current[code]?.quote ? current[code].quote : result.quote ?? current[code]?.quote ?? null,
        history: result.history.length ? result.history : current[code]?.history ?? [],
        intraday: result.intraday?.length ? result.intraday : current[code]?.intraday ?? [],
        intraday_date: result.intraday?.length ? result.intraday_date : current[code]?.intraday_date,
        intraday_fetched_at: result.intraday?.length ? result.intraday_fetched_at : current[code]?.intraday_fetched_at,
      }}));
      setMarketErrors(current => ({...current, [code]: result.warnings.join('；')}));
    } catch (err) {
      if (!demoRef.current && !controller.signal.aborted) setMarketErrors(current => ({...current, [code]: (err as Error).message}));
    } finally {
      inflight.current.delete(code);
      marketRequests.current.delete(code);
      activeMarketOptions.current.delete(code);
      const pending = pendingMarketRefresh.current.get(code);
      pendingMarketRefresh.current.delete(code);
      setLoadingMarkets(current => current.filter(item => item !== code));
      setRefreshRevisions(current => ({...current, [code]: (current[code] ?? 0) + 1}));
      if (pending && !demoRef.current) void refreshMarket(code, pending.history, pending.intraday, true, pending.depth);
    }
  }, []);
  useEffect(() => {
    requestedChart.current = ''; requestedQuotes.current.clear();
  }, [marketOpen, offHoursRefresh]);
  useEffect(() => {
    if (!marketOpen) for (const controller of marketRequests.current.values()) controller.abort();
  }, [marketOpen]);
  useEffect(() => {
    if (!selected || demo || inflight.current.has(selected.code)) return;
    const key = `${selected.code}:${view === 'holdings' ? chartMode : 'quote'}`;
    if (requestedChart.current === key) return;
    requestedChart.current = key;
    requestedQuotes.current.add(selected.code);
    void refreshMarket(selected.code, view === 'holdings' && chartMode === 'daily', view === 'holdings' && chartMode === 'intraday', true);
  }, [selected?.code, demo, refreshMarket, chartMode, view, loadingMarkets, marketOpen, offHoursRefresh]);
  useEffect(() => {
    let last = Date.now();
    const refreshOnReturn = () => {
      if (demoRef.current || isTradingSession() || document.visibilityState !== 'visible' || Date.now() - last < 1500) return;
      last = Date.now();
      setOffHoursRefresh(current => current + 1);
    };
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);
    return () => {window.removeEventListener('focus', refreshOnReturn); document.removeEventListener('visibilitychange', refreshOnReturn);};
  }, []);
  const instrumentCodes = instruments.filter(item => item.quantity > 0).map(item => item.code).join(',');
  useEffect(() => {
    if (demo || !instrumentCodes) return;
    let active = true;
    // Fetch held list items one at a time, leaving an upstream slot for the chart.
    void (async () => {
      for (const code of instrumentCodes.split(',')) {
        if (!active) break;
        if (code === selected?.code || requestedQuotes.current.has(code)) continue;
        requestedQuotes.current.add(code);
        await refreshMarket(code, false, false, true);
      }
    })();
    return () => {active = false;};
  }, [instrumentCodes, selected?.code, demo, refreshMarket, marketOpen, offHoursRefresh]);
  useEffect(() => {
    if (!marketOpen || !autoRefresh || demo || !instrumentCodes) return;
    let active = true;
    let running = false;
    async function refreshListPrices() {
      if (!active || running || document.hidden) return;
      running = true;
      try {
        for (const code of instrumentCodes.split(',')) {
          if (!active) break;
          if (code === selected?.code && view !== 'broker') continue;
          await refreshMarket(code);
        }
      } finally {running = false;}
    }
    const timer = window.setInterval(() => void refreshListPrices(), refreshSeconds * 1000);
    document.addEventListener('visibilitychange', refreshListPrices);
    return () => {active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshListPrices);};
  }, [autoRefresh, demo, instrumentCodes, selected?.code, view, refreshSeconds, refreshMarket, marketOpen]);
  useEffect(() => {
    if (demo) {setTargetBuybacks([]); setBuybackError(''); return;}
    if (view !== 'targets' && view !== 'holdings') return;
    const controller = new AbortController();
    void api<{plans: TTradePlan[]}>('/t-trades', {signal: controller.signal})
      .then(result => {if (!controller.signal.aborted) {setTargetBuybacks(result.plans.filter(plan => plan.remaining > 0)); setBuybackError('');}})
      .catch(err => {if (!controller.signal.aborted) setBuybackError((err as Error).message);});
    return () => controller.abort();
  }, [view, demo, instruments]);
  const targetCodes = [...new Set([
    ...instruments.filter(i => i.lots.some(l => l.remaining > 0)).map(i => i.code),
    ...(!demo ? targetBuybacks.map(plan => plan.code) : []),
  ])].sort().join(',');
  const refreshActiveMarkets = useCallback(async (code: string, once = false) => {
    if (view !== 'targets') {await refreshMarket(code, view === 'holdings' && chartMode === 'daily', view === 'holdings' && chartMode === 'intraday', once); return;}
    if (demoRef.current || !targetCodes) return;
    if (targetRefreshInFlight.current) {if (once) targetRefreshQueued.current = true; return;}
    targetRefreshInFlight.current = true; setTargetRefreshBusy(true);
    try {for (const targetCode of targetCodes.split(',')) await refreshMarket(targetCode, false, false, once);}
    finally {
      targetRefreshInFlight.current = false; setTargetRefreshBusy(false);
      if (targetRefreshQueued.current) {targetRefreshQueued.current = false; setTargetRefreshRevision(current => current + 1);}
    }
  }, [view, targetCodes, chartMode, refreshMarket]);
  useEffect(() => {
    if (view === 'targets' && !demo) void refreshActiveMarkets('', true);
  }, [view, demo, refreshActiveMarkets, marketOpen, offHoursRefresh, targetRefreshRevision]);
  const marketRefreshing = !!selected && loadingMarkets.includes(selected.code);
  const targetsRefreshing = targetRefreshBusy || loadingMarkets.some(code => targetCodes.split(',').includes(code));
  const acceptQuote = useCallback((code: string, quote: Quote) => {
    if (!isTradingSession()) return;
    setMarkets(current => ({...current, [code]: {...(current[code] ?? {history: [], warnings: []}), source: quote.source ?? '同花顺', quote,
      warnings: (current[code]?.warnings ?? []).filter(message => message !== '最新行情获取失败' && message !== '五档盘口暂无可用数据')}}));
    setMarketErrors(current => ({...current, [code]: (current[code] ?? '').split('；').filter(message => message === '分时行情获取失败' || message === '历史行情获取失败').join('；')}));
    setNow(Date.now());
  }, []);
  const push = useQuoteStream({enabled: marketOpen && quotePush && autoRefresh && !demo && (view === 'holdings' || view === 'targets' || view === 't-calc'),
    code: selected?.code, codes: view === 'targets' ? targetCodes.split(',').filter(Boolean) : undefined, onQuote: acceptQuote});
  pushedCodes.current = new Set(push.live ? view === 'targets' ? targetCodes.split(',').filter(Boolean) : selected ? [selected.code] : [] : []);
  const countdown = useRefreshCountdown({intervalSeconds: push.live ? 30 : refreshSeconds, enabled: marketOpen && autoRefresh && !demo && view !== 'broker' && (view !== 'targets' || !!targetCodes), code: selected?.code,
    refreshing: view === 'targets' ? targetsRefreshing : marketRefreshing,
    revision: selected ? refreshRevisions[selected.code] ?? 0 : 0, onRefresh: refreshActiveMarkets});

  function toggleDemo() {
    if (!demo) {
      demoRef.current = true;
      const example = demoData();
      setInstruments(example.instruments); setMarkets(example.markets); setMarketErrors({});
      setSelectedCode(example.instruments[0].code); setDemo(true);
    } else {
      demoRef.current = false; setDemo(false); setInstruments([]); setMarkets({}); setMarketErrors({});
      requestedChart.current = ''; requestedQuotes.current.clear(); setLoading(true); void load();
    }
  }
  async function openTrade(side: 'buy' | 'sell' = 'buy', trade?: Trade, lot?: Lot, owner?: Instrument) {
    if (demo) { setToast('示例只用于预览。退出示例后即可录入你的真实交易。'); return; }
    const instrument = owner ?? selected;
    if (!instrument) { setFormError(''); setAddOpen(true); return; }
    let defaults: StopLossDefaults | null = null;
    if (!trade && side === 'buy') {
      try { defaults = await api<StopLossDefaults>('/settings/stop-loss'); }
      catch (err) {setToast(`读取默认止损失败：${(err as Error).message}`); return;}
    }
    setEditing(trade ?? null); setTradeCode(trade?.code ?? instrument.code); setFormError('');
    setManualFee(!!trade); setFeeError(''); setFeeLoading(false); setResolvedFeeKey(null);
    setTradeForm(trade ? {side: trade.side, executed_at: trade.executed_at, price: Number(trade.price).toFixed(3), quantity: String(trade.quantity), fee: trade.fee, note: trade.note, buy_lot_id: trade.buy_lot_id == null ? '' : String(trade.buy_lot_id),
      target_mode: trade.target_profit_amount != null ? 'amount' : 'percent', target_value: trade.target_profit_amount ?? trade.target_profit_percent ?? '',
      stop_loss_percent: trade.stop_loss_percent === null ? '' : trade.stop_loss_percent ?? '2',
      stop_loss_mode: trade.stop_loss_amount != null ? 'amount' : 'percent', stop_loss_amount: trade.stop_loss_amount ?? '', t_trade: !!trade.t_trade, t_buyback_price: trade.t_buyback_price ?? ''}
      : {...emptyTrade(), side, buy_lot_id: lot ? String(lot.id) : '', quantity: lot ? String(lot.remaining) : '',
        ...(defaults ? {stop_loss_mode: defaults.stop_loss_amount != null ? 'amount' as const : 'percent' as const,
          stop_loss_percent: defaults.stop_loss_percent ?? '', stop_loss_amount: defaults.stop_loss_amount ?? ''} : {}),
        price: owner ? markets[instrument.code]?.quote?.price.toFixed(3) ?? '' : ''});
    setTradeOpen(true);
    void refreshMarket(trade?.code ?? instrument.code, false, false, true, true);
  }
  async function openBuyback(code: string, quantity: number, price: string | null) {
    const owner = instruments.find(item => item.code === code);
    if (!owner) return;
    await openTrade('buy', undefined, undefined, owner);
    setTradeForm(current => ({...current, quantity: String(quantity), price: price ?? current.price}));
  }
  async function saveInstrument(event: FormEvent) {
    event.preventDefault(); setBusy(true); setFormError('');
    try {
      await api('/instruments', {method: 'POST', body: JSON.stringify(instrumentForm)});
      await load(); setSelectedCode(instrumentForm.code); setAddOpen(false);
      setInstrumentForm({code: '', name: '', kind: 'stock'}); setToast('已添加股票或 ETF，可以开始记录交易');
    } catch (err) { setFormError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function saveTrade(event: FormEvent) {
    event.preventDefault(); setBusy(true); setFormError('');
    try {
      const fee = manualFee ? tradeForm.fee : (await api<{fee: string}>('/fees/estimate', {
        method: 'POST', body: JSON.stringify({kind: tradeInstrument!.kind, price: tradeForm.price, quantity: Number(tradeForm.quantity)}),
      })).fee;
      await api(editing ? `/trades/${editing.id}` : '/trades', {method: editing ? 'PUT' : 'POST', body: JSON.stringify({
        ...tradeForm, fee, code: tradeCode, quantity: Number(tradeForm.quantity),
        t_trade: tradeForm.side === 'sell' && !!tradeForm.t_trade,
        t_buyback_price: tradeForm.side === 'sell' && tradeForm.t_trade && tradeForm.t_buyback_price ? tradeForm.t_buyback_price : null,
        stop_loss_percent: tradeForm.side === 'buy' && tradeForm.stop_loss_mode !== 'amount' && tradeForm.stop_loss_percent !== '' ? tradeForm.stop_loss_percent ?? '2' : null,
        stop_loss_amount: tradeForm.side === 'buy' && tradeForm.stop_loss_mode === 'amount' && tradeForm.stop_loss_amount !== '' ? tradeForm.stop_loss_amount ?? null : null,
        buy_lot_id: tradeForm.side === 'sell' && tradeForm.buy_lot_id ? Number(tradeForm.buy_lot_id) : null,
        target_profit_percent: tradeForm.side === 'buy' && tradeForm.target_mode === 'percent' && tradeForm.target_value !== '' ? tradeForm.target_value : null,
        target_profit_amount: tradeForm.side === 'buy' && tradeForm.target_mode === 'amount' && tradeForm.target_value !== '' ? tradeForm.target_value : null,
      })});
      await load(); setTradeOpen(false); setToast(editing ? '交易已更新，持仓成本已重新计算' : '交易已保存，持仓成本已更新');
    } catch (err) { setFormError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function confirmDelete() {
    setBusy(true); setFormError('');
    try {
      if (deleting) await api(`/trades/${deleting.id}`, {method: 'DELETE'});
      if (removing) await api(`/instruments/${removing.code}`, {method: 'DELETE'});
      await load(); setDeleting(null); setRemoving(null); setToast('已删除，持仓已重新计算');
    } catch (err) { setFormError((err as Error).message); }
    finally { setBusy(false); }
  }
  const priceAge = quote ? (now - new Date(quote.fetched_at).getTime()) / 1000 : Infinity;
  const priceStale = !!quote && !demo && (priceAge > 90 || /最新行情|超时|繁忙|暂不可用/.test(marketError ?? ''));

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="拾仓首页"><span className="brand-mark"><Layers3 size={24}/></span><span>拾仓</span></a>
      <nav className="main-nav" aria-label="主导航">
        <button className={view === 'targets' ? 'nav-item active' : 'nav-item'} onClick={() => setView('targets')}><Target size={18}/>批次追踪</button>
        <button className={view === 'plans' ? 'nav-item active' : 'nav-item'} onClick={() => setView('plans')}><ClipboardList size={18}/>交易计划</button>
        <button className={view === 'today-deals' ? 'nav-item active' : 'nav-item'} onClick={() => setView('today-deals')}><ReceiptText size={18}/>当日成交</button>
        <button className={view === 'trades' ? 'nav-item active' : 'nav-item'} onClick={() => setView('trades')}><FolderOpen size={18}/>全部交易<span className="count">{tradeCount}</span></button>
        <button className={view === 'analytics' ? 'nav-item active' : 'nav-item'} onClick={() => setView('analytics')}><BarChart3 size={18}/>统计分析</button>
        <button className={view === 't-calc' ? 'nav-item active' : 'nav-item'} onClick={() => setView('t-calc')}><Calculator size={18}/>做 T 测算</button>
        <button className={view === 'broker' ? 'nav-item active' : 'nav-item'} onClick={() => setView('broker')}><RefreshCw size={18}/>券商账户</button>
        <button className={view === 'bridge' ? 'nav-item active' : 'nav-item'} onClick={() => setView('bridge')}><Radio size={18}/>行情桥接</button>
      </nav>
      <div className="sidebar-divider"/>
      <div className="section-label">我的持仓 <span>{tradedInstruments.length}</span><button className="icon-button" aria-label="添加股票或 ETF" onClick={() => demo ? setToast('退出示例后即可添加股票或 ETF') : (setFormError(''), setAddOpen(true))}><Plus size={17}/></button></div>
      <div className="search-field"><Search size={15}/><input aria-label="搜索持仓" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索名称或代码"/></div>
      <div className="instrument-list">
        {filtered.map(item => {
          const itemQuote = markets[item.code]?.quote;
          const pnl = itemQuote && item.quantity ? itemQuote.price * item.quantity - Number(item.cost) : null;
          const dailyChange = itemQuote?.change_percent;
          const priceAvailable = !!itemQuote && Number.isFinite(itemQuote.price) && itemQuote.price > 0;
          const priceAge = itemQuote ? Date.now() - new Date(itemQuote.fetched_at).getTime() : NaN;
          const priceOld = !Number.isFinite(priceAge) || priceAge > 90000 || !!marketErrors[item.code];
          const priceColor = dailyChange != null && dailyChange !== 0 ? dailyChange > 0 ? 'positive' : 'negative' : '';
          const direction = dailyChange != null && Number.isFinite(dailyChange) ? dailyChange > 0 ? 'day-up' : dailyChange < 0 ? 'day-down' : '' : '';
          return <button key={item.code} className={`instrument-item ${direction} ${selected?.code === item.code ? 'selected' : ''}`} title={dailyChange == null ? '暂无当日涨跌数据' : `当日涨跌 ${signed(dailyChange)}%`} onClick={() => {setSelectedCode(item.code); setView('holdings');}}>
            <span className="instrument-info"><strong>{item.name}</strong><span>{item.code} · {item.quantity ? `${money(item.quantity, 0)} 股/份` : '暂无持仓'}</span></span>
            <span className={`instrument-market ${priceOld ? 'price-old' : ''}`} title={priceAvailable ? `${priceOld ? '上次价格' : '最新价格'} · ${itemQuote.fetched_at.replace('T', ' ').slice(0, 19)}` : '暂无行情'}><strong className={priceColor}>{priceAvailable ? `¥ ${money(itemQuote.price, 3)}` : '—'}</strong><span className={`instrument-return ${pnl == null ? '' : pnl >= 0 ? 'positive' : 'negative'}`}>{pnl == null || Number(item.cost) <= 0 ? '—' : `${pnl >= 0 ? '+' : ''}${(pnl / Number(item.cost) * 100).toFixed(2)}%`}</span></span>
          </button>;
        })}
        {!filtered.length && <div className="sidebar-empty">{search ? '没有匹配的标的' : '暂无交易记录'}</div>}
      </div>
      <div className="sidebar-bottom">
        <button className="settings-button" onClick={() => setSettings(true)}><Settings2 size={17}/>设置与数据管理<ArrowRight size={15}/></button>
      </div>
    </aside>

    <main className="main-content">
      <header className="topbar"><TopbarSummary instruments={instruments} now={now} marketOpen={marketOpen} loading={loading}/><div className="topbar-right"><span className="local-status"><span className="status-dot"/>{demo ? '示例模式' : '本地账本'}</span><button className="icon-button theme-toggle" aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'} title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'} aria-pressed={theme === 'dark'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}</button><button className="icon-button" aria-label="打开设置" onClick={() => setSettings(true)}><Settings2 size={18}/></button></div></header>
      <div className={`page-content ${view === 'targets' ? 'targets-workspace' : ''}`}>
        {demo && <div className="demo-banner"><Sparkles size={16}/><span>正在预览示例：交易与行情均为虚构，不会保存到你的账本。</span><button onClick={toggleDemo}>退出示例 <X size={14}/></button></div>}
        {error && <div className="error-banner" role="alert">{error}<button onClick={() => {setLoading(true); void load();}}>重试连接</button></div>}
        {view === 'plans' ? <TradePlansPage key={demo ? 'demo-plans' : 'plans'} instruments={instruments} code={selected?.code} demo={demo}/> : view === 't-calc' ? <TTradeCalculator instruments={instruments} markets={markets} code={selected?.code} onSelect={setSelectedCode} onRefresh={code => void refreshMarket(code, false, false, true)} refreshing={marketRefreshing} feeRevision={feeRevision} demo={demo} autoRefresh={autoRefresh} refreshSeconds={refreshSeconds} onBuyback={openBuyback} onLedgerChange={load}/> : view === 'bridge' ? <QuoteBridgePage instruments={instruments} demo={demo}/> : view === 'today-deals' ? <BrokerPage key="today-deals" page="deals" demo={demo} instruments={instruments} onLedgerChange={() => void load()}/> : view === 'broker' ? <BrokerPage key="account" demo={demo} initialQuery={brokerInitialQuery} instruments={instruments} onLedgerChange={() => void load()}/> : view === 'targets' ? loading ? <div className="panel loading-panel"><LoaderCircle className="spin"/>正在读取买入批次…</div> : <ReachedTargetsPage buybackPlans={targetBuybacks} buybackError={buybackError} onBuyback={openBuyback} marketOpen={marketOpen} pushStatus={quotePush && autoRefresh ? push.status : undefined} pushLive={view === 'targets' && push.live} instruments={instruments} markets={markets} errors={marketErrors} now={now} feeRevision={feeRevision} demo={demo} refreshing={targetsRefreshing} onRefresh={() => refreshActiveMarkets('', true)} onSell={(instrument, lot) => {setSelectedCode(instrument.code); openTrade('sell', undefined, lot, instrument);}} remaining={countdown.remaining} paused={countdown.paused} autoRefresh={autoRefresh} refreshSeconds={refreshSeconds}/> : view === 'analytics' ? loading ? <div className="panel loading-panel"><LoaderCircle className="spin"/>正在读取交易记录…</div> : <AnalyticsPage instruments={instruments}/> : <>
        {view === 'trades' && <div className="page-heading"><h1>全部交易</h1><div className="heading-actions"><button className="button secondary" onClick={() => demo ? setToast('示例数据无需导出') : window.location.assign('/api/export')}><Download size={16}/>导出记录</button><button className="button primary" onClick={() => openTrade()}><Plus size={18}/>记录交易</button></div></div>}
        {view === 'trades' && <div className="summary-grid">
          <Summary label="持仓总成本" value={`¥ ${money(totalCost)}`} caption="剩余持仓的买入金额 + 买入费用" icon={<Wallet size={19}/>} />
          <Summary label="持仓数量" value={String(instruments.filter(item => item.quantity > 0).length)} suffix="只" caption={`${instruments.filter(item => item.kind === 'stock' && item.quantity > 0).length} 只股票 · ${instruments.filter(item => item.kind === 'etf' && item.quantity > 0).length} 只 ETF`} icon={<Layers3 size={19}/>} />
          <Summary label="累计已实现盈亏" value={`${totalRealized > 0 ? '+' : ''}¥ ${money(totalRealized)}`} caption="按匹配买入成本计算，已扣买卖费用" tone={totalRealized > 0 ? 'positive' : totalRealized < 0 ? 'negative' : ''} icon={<BarChart3 size={19}/>} />
          <Summary label="交易记录" value={String(tradeCount)} suffix="笔" icon={<FolderOpen size={19}/>} />
        </div>}

        {loading ? <div className="panel loading-panel"><LoaderCircle className="spin"/>正在打开本地账本…</div> : !selected ? <section className="panel welcome-panel"><h2>尚未添加股票或 ETF</h2><p>添加股票或 ETF 后即可记录买卖。</p><div className="welcome-actions"><button className="button primary" onClick={() => {setFormError(''); setAddOpen(true);}}><Plus size={17}/>添加股票或 ETF</button><button className="button secondary" onClick={toggleDemo}><Sparkles size={16}/>查看示例</button></div></section> : <>
          {view === 'holdings' && <>
          <section className="panel holding-panel">
            <div className="holding-header"><div className="stock-title"><span className={`large-avatar ${selected.kind}`}>{selected.kind === 'etf' ? 'ETF' : selected.name.slice(0, 1)}</span><div><h2>{selected.name}<span className="kind-badge">{selected.kind === 'etf' ? 'ETF' : 'A 股'}</span></h2><span className="muted">{selected.code} <span className="dot-separator">·</span> 人民币</span></div></div><div className="stock-actions">{!selected.trades.length && !demo && <button className="icon-button" aria-label="移除当前标的" onClick={() => {setFormError(''); setRemoving(selected);}}><Trash2 size={15}/></button>}<button className="button small secondary" onClick={() => openTrade('buy')}><ArrowDownLeft size={15}/>买入</button><button className="button small secondary" onClick={() => openTrade('sell')}><ArrowUpRight size={15}/>卖出</button></div></div>
            <div className="holding-stats"><div className="price-block"><span className="stat-label">最新价 {priceStale && <em>上次获取</em>}</span><div className={quote && (quote.change_percent ?? 0) >= 0 ? 'positive' : quote ? 'negative' : ''}><strong>{money(quote?.price, digits)}</strong>{quote?.change_percent != null && <span className="change-pill">{signed(quote.change_percent)}%</span>}</div></div><div><span className="stat-label">持仓数量</span><strong>{money(selected.quantity, 0)}<small>股 / 份</small></strong></div><div title="与统计分析一致：已完成做 T 的买回沿用原持仓统计成本"><span className="stat-label">持仓均价</span><strong>{money(selectedMetrics?.average, digits)}</strong><span className="holding-cost-reference">实际均价 {money(selected.average_cost, digits)}</span></div><div><span className="stat-label">浮动盈亏 {priceStale && <em>参考</em>}</span><strong className={unrealized == null ? '' : unrealized >= 0 ? 'positive' : 'negative'}>{unrealized == null ? '—' : signed(unrealized)}<small>{unrealized == null ? '' : `${selectedMetrics?.cost ? `${signed(unrealized / selectedMetrics.cost * 100)}%` : '—'}`}</small></strong></div><div title="普通卖出盈亏 + 已买回并关联的做 T 净价差；待买回部分不计入"><span className="stat-label">已实现盈亏</span><strong className={selectedMetrics?.realized == null ? '' : selectedMetrics.realized >= 0 ? 'positive' : 'negative'}>{selectedMetrics?.realized == null ? '—' : signed(selectedMetrics.realized)}</strong></div></div>
            {selectedMetrics?.error && <div className="holding-statistics-error" role="alert">{selectedMetrics.error}</div>}
            <div className="chart-toolbar"><div className="chart-heading"><span className="tab-active">行情与成本</span><span className="chart-subtitle">{chartMode === 'intraday' ? market?.intraday?.length ? `分时 · ${market.intraday_date}` : '分时 · 暂无行情' : '日 K · 不复权'}</span></div><div className="chart-controls"><div className="range-switch chart-mode-switch" aria-label="行情图类型"><button className={chartMode === 'intraday' ? 'active' : ''} onClick={() => {setChartMode('intraday'); localStorage.setItem('chartMode', 'intraday');}}>分时</button><button className={chartMode === 'daily' ? 'active' : ''} onClick={() => {setChartMode('daily'); localStorage.setItem('chartMode', 'daily');}}>日 K</button></div>{chartMode === 'daily' && <div className="range-switch" aria-label="图表时间范围">{(['1M', '3M', '1Y', 'ALL'] as const).map(r => <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>{r === 'ALL' ? '全部' : r}</button>)}</div>}<button className="icon-button refresh-button" aria-label="刷新行情" disabled={loadingMarkets.includes(selected.code) || demo} onClick={() => void refreshMarket(selected.code, chartMode === 'daily', chartMode === 'intraday', true)}><RefreshCw size={16} className={loadingMarkets.includes(selected.code) ? 'spin' : ''}/></button></div></div>
            <div className={`market-refresh-status ${marketRefreshing ? 'refreshing' : ''} ${autoRefresh && !demo ? 'automatic' : ''}`}>
              <span>{demo ? '示例行情' : !marketOpen ? '非交易时段 · 暂停自动刷新' : push.live ? '实时推送中' : marketRefreshing ? '正在刷新…' : !autoRefresh ? '手动刷新' : countdown.paused ? '自动刷新已暂停' : `${countdown.remaining} 秒后刷新`}</span>
              {marketOpen && autoRefresh && !demo && !push.live && <div className="market-refresh-track" role="progressbar" aria-label="行情刷新倒计时" aria-valuemin={0} aria-valuemax={refreshSeconds} aria-valuenow={marketRefreshing ? undefined : refreshSeconds - countdown.remaining} aria-valuetext={marketRefreshing ? '正在刷新' : countdown.paused ? '已暂停' : `${countdown.remaining} 秒后刷新`}><span style={{width: marketRefreshing ? '100%' : `${(refreshSeconds - countdown.remaining) / refreshSeconds * 100}%`}}/></div>}
            </div>
            {chartMode === 'intraday' || selected.lots.length || market?.history.length ? <CostChart instrument={selected} market={market} showClosed={showClosed} focusedLot={focusedLot} range={range} mode={chartMode} theme={theme}/> : <div className="chart-placeholder"><BarChart3 size={34}/><strong>这里将显示行情走势</strong><span>行情图保留持仓均价与买卖标记。</span><button className="text-button" onClick={() => openTrade()}>记录买入 <ArrowRight size={15}/></button></div>}
            <div className="chart-footer"><span><i className="legend-line price"/>{chartMode === 'intraday' ? '分时价格' : '日 K'} <i className="legend-line avg"/>持仓均价 <span className="legend-trade-badge buy">B</span>买入 <span className="legend-trade-badge sell">S</span>卖出</span><span>{demo ? '示例行情 · 非真实数据' : quote ? `${priceStale ? '行情可能已过期 · ' : ''}获取于 ${new Date(quote.fetched_at).toLocaleTimeString('zh-CN', {hour12: false})}` : loadingMarkets.includes(selected.code) ? '正在获取行情…' : '暂无可用行情'}{!demo && <span className="dot-separator">· {chartMode === 'intraday' && market?.intraday_fetched_at ? `分时更新 ${new Date(market.intraday_fetched_at).toLocaleTimeString('zh-CN', {hour12: false})}` : (chartMode === 'daily' ? market?.history_source ?? '日K行情' : quote?.source ?? market?.source ?? '行情快照')}</span>}</span></div>
            {marketError && <div className="market-warning">{marketError}。成本线和交易记录仍可使用。{priceStale && ' 当前价格为上次获取的快照。'}</div>}
          </section>
          <div className="detail-grid lots-only">
            <BuyLots buybackPlans={targetBuybacks} buybackError={buybackError} onBuyback={openBuyback} now={now} demo={demo} instrument={selected} quote={quote} stale={priceStale} feeRevision={feeRevision} showClosed={showClosed} onShowClosed={setShowClosed} focusedLot={focusedLot} onLotClick={lot => {setFocusedLot(lot.id); if (lot.remaining > 0) openTrade('sell', undefined, lot);}}/>
          </div>
          </>}
          <section className="panel trades-panel"><div className="panel-heading"><div><h3>{view === 'trades' ? '全部交易记录' : '交易记录'}<span className="soft-count">{displayedTrades.length}</span></h3><p>默认先进先出 · 卖出支持指定买入批次</p></div><div className="trade-tools"><ListFilter size={15}/><select aria-label="筛选买卖方向" value={tradeFilter} onChange={e => setTradeFilter(e.target.value as typeof tradeFilter)}><option value="all">全部交易</option><option value="buy">仅买入</option><option value="sell">仅卖出</option><option value="unsold">未卖完买入</option></select><button className="text-button" onClick={() => openTrade()}><Plus size={15}/>记录交易</button></div></div>
            <div className="table-scroll"><table><thead><tr><th className="trade-sequence">ID</th><th>交易时间</th>{view === 'trades' && <th>标的</th>}<th>方向</th><th className="numeric">成交价</th><th className="numeric">数量</th><th className="numeric">成交金额</th><th className="numeric">费用</th><th className="numeric">已实现盈亏</th><th>备注 / 成本匹配</th><th className="action-th">操作</th></tr></thead><tbody>{pagedTrades.map(trade => {
              const owner = instruments.find(i => i.code === trade.code)!;
              return <tr key={`${trade.code}-${trade.id}`}><td className="trade-sequence">{trade.id}</td><td><strong>{trade.executed_at.slice(0, 10)}</strong><small>{trade.executed_at.slice(11, 16)}</small></td>{view === 'trades' && <td><strong>{owner.name}</strong><small>{owner.code}</small></td>}<td><span className={`side-badge ${trade.side}`}>{trade.side === 'buy' ? <ArrowDownLeft size={12}/> : <ArrowUpRight size={12}/>} {trade.side === 'buy' ? '买入' : '卖出'}</span></td><td className="numeric">{money(trade.price, priceDigits(owner.kind))}</td><td className="numeric">{money(trade.quantity, 0)}{tradeFilter === 'unsold' && <small>剩余 {money(remainingByTrade.get(`${trade.code}:${trade.id}`), 0)} 股/份</small>}</td><td className="numeric">{money(trade.gross_amount ?? Number(trade.price) * trade.quantity)}</td><td className="numeric muted">{money(trade.fee)}</td><td className={`numeric ${trade.realized_pnl == null ? 'muted' : Number(trade.realized_pnl) >= 0 ? 'positive' : 'negative'}`}>{trade.realized_pnl == null ? '—' : signed(trade.realized_pnl)}</td><td className="note-cell"><span title={trade.note}>{!!trade.t_trade && <em className="t-record-mark">做 T</em>}{trade.note || '—'}</span>{trade.restored_to?.length ? <small>恢复原批次：{trade.restored_to.map(item => `#${item.buy_id} × ${item.quantity}`).join('，')}</small> : null}{trade.side === 'sell' && <small>{trade.lot_allocations?.length ? '多批次分摊' : trade.buy_lot_id ? `指定 #${trade.buy_lot_id}` : '先进先出'} · {trade.allocations.map(a => `#${a.buy_id} × ${a.quantity}`).join('，')}</small>}</td><td><div className="row-actions"><button className="icon-button" aria-label={`编辑交易${trade.id}`} onClick={() => openTrade(trade.side, trade)}><Pencil size={14}/></button><button className="icon-button danger-icon" aria-label={`删除交易${trade.id}`} onClick={() => demo ? setToast('示例记录无法删除，退出示例即可管理你的账本') : (setFormError(''), setDeleting(trade))}><Trash2 size={14}/></button></div></td></tr>;
            })}</tbody></table>{!displayedTrades.length && <div className="table-empty"><FolderOpen size={26}/><span>{tradeFilter !== 'all' ? '没有符合筛选条件的交易' : '还没有交易记录'}</span>{tradeFilter === 'all' && <button className="text-button" onClick={() => openTrade()}>记录第一笔交易 <ArrowRight size={14}/></button>}</div>}</div>
            {view === 'trades' && <TradePagination page={currentTradePage} pageSize={tradePageSize} total={displayedTrades.length} onPage={setTradePage} onPageSize={size => {setTradePageSize(size); localStorage.setItem('tradePageSize', String(size));}}/>}
          </section>
        </>}
        </>}
      </div>
    </main>

    <Modal open={addOpen} onOpenChange={value => !busy && setAddOpen(value)} title="添加股票或 ETF" description="添加后即可记录买卖，并查看每个买入批次的成本。">
      <form onSubmit={saveInstrument} className="form"><InstrumentFields form={instrumentForm} onChange={setInstrumentForm} busy={busy} open={addOpen}/>{formError && <div className="form-error" role="alert">{formError}</div>}<div className="form-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setAddOpen(false)}>取消</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin"/> : <Plus size={16}/>}添加标的</button></div></form>
    </Modal>
    <TradeDialog onRiskSaved={load} onIntentChanged={() => void load()} allowRealTrading={!demo} onBrokerOrders={() => {setTradeOpen(false); setBrokerInitialQuery('orders'); setView('broker');}} open={tradeOpen} onOpenChange={value => !busy && setTradeOpen(value)} instrument={tradeInstrument} code={tradeCode} editing={editing} form={tradeForm} onChange={patch => setTradeForm(current => ({...current, ...patch}))} onFeeChange={fee => {setManualFee(true); setResolvedFeeKey(null); setTradeForm(current => ({...current, fee}));}} onAutoFee={() => setManualFee(false)} onSave={saveTrade} busy={busy} error={formError} manualFee={manualFee} feeLoading={feeLoading} feeError={feeError} feeReady={manualFee || (!feeLoading && !feeError && resolvedFeeKey === feeKey)} amountValid={amountValid} feeValid={manualFeeValid} previewValue={previewValue} quote={markets[tradeCode]?.quote} refreshing={loadingMarkets.includes(tradeCode)} onRefresh={() => void refreshMarket(tradeCode, false, false, true, true)}/>
    <Modal open={!!deleting || !!removing} onOpenChange={value => {if (!busy && !value) {setDeleting(null); setRemoving(null);}}} title={deleting ? '删除这笔交易？' : '移除这个标的？'} description={deleting ? '删除后会重新计算持仓和成本。如果影响后续卖出的有效性，软件会阻止删除。' : `${removing?.name}没有交易记录，可以从列表移除。`}>
      {deleting && <div className="delete-preview">{deleting.executed_at.slice(0, 10)} · {deleting.side === 'buy' ? '买入' : '卖出'} {deleting.quantity} 股/份 · ¥ {money(deleting.price, 3)}</div>}{formError && <div className="form-error" role="alert">{formError}</div>}<div className="form-actions"><button className="button secondary" disabled={busy} onClick={() => {setDeleting(null); setRemoving(null);}}>取消</button><button className="button danger" disabled={busy} onClick={() => void confirmDelete()}>{busy && <LoaderCircle size={16} className="spin"/>}确认删除</button></div>
    </Modal>
    <SettingsDialog theme={theme} onThemeChange={setTheme} open={settings} onOpenChange={setSettings} demo={demo} autoRefresh={autoRefresh}
      refreshSeconds={refreshSeconds} onRefreshSeconds={seconds => {setRefreshSeconds(seconds); localStorage.setItem('refreshSeconds', String(seconds));}}
      quotePush={quotePush} onQuotePush={enabled => {setQuotePush(enabled); localStorage.setItem('quotePush', String(enabled));}}
      onAutoRefresh={enabled => {setAutoRefresh(enabled); localStorage.setItem('autoRefresh', String(enabled));}}
      onFeesSaved={() => {setFeeRevision(current => current + 1); setToast('费率已保存，盈利目标将按新佣金设置核对');}}
      onMessage={setToast} onToggleDemo={toggleDemo}/>
    {toast && <div className="toast" role="status"><Check size={17}/>{toast}<button aria-label="关闭提示" onClick={() => setToast('')}><X size={15}/></button></div>}
  </div>;
}

function Summary({label, value, caption, icon, suffix, tone = ''}: {label: string; value: string; caption?: string; icon: React.ReactNode; suffix?: string; tone?: string}) {
  return <div className="summary-card"><div className="summary-label">{label}<span className="summary-icon">{icon}</span></div><div className={`summary-value ${tone}`}>{value}{suffix && <small>{suffix}</small>}</div>{caption && <div className="summary-caption">{caption}</div>}</div>;
}
