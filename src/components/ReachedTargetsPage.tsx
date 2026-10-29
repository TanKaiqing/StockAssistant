import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { LotOrderBadge } from './LotOrderBadge';
import { RestoredLotInfo } from './RestoredLotInfo';
import { lotReferenceUnitCost, money, signed, type Instrument, type Lot, type Market, type TTradePlan } from '../types';
import { TBuybackTargetCard, useBuybackValuations } from './TBuybackTargetCard';
import './ReachedTargetsPage.css';

interface Target {lot_id: number; reached: boolean; profit: string; profit_percent: string; target_profit: string; estimated_sell_fee: string}
type Valuation = Pick<Target, 'lot_id' | 'profit' | 'profit_percent'> & {stop_loss_reached?: boolean; stop_loss_amount?: string | null};
type Status = {key: string; basis: string; quoteAt?: string; price?: number; targets?: Target[]; valuations?: Valuation[]; error?: string};
type Row = {instrument: Instrument; lot: Lot; target?: Target; valuation?: Valuation; price: number | null; goal: number | null; gap: number | null; distance: number | null; previous: boolean};
type Props = {
  marketOpen?: boolean;
  instruments: Instrument[]; markets: Record<string, Market>; errors: Record<string, string>;
  now: number; feeRevision: number; demo: boolean; refreshing: boolean;
  onRefresh: () => Promise<void>; onSell: (instrument: Instrument, lot: Lot) => void;
  pushLive?: boolean; pushStatus?: string;
  remaining: number; paused: boolean; autoRefresh: boolean; refreshSeconds?: number;
  buybackPlans?: TTradePlan[]; buybackError?: string;
  onBuyback?: (code: string, quantity: number, price: string | null) => void;
};

export function ReachedTargetsPage(props: Props) {
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const cache = useRef(statuses); cache.current = statuses;
  const requestsInFlight = useRef(new Map<string, AbortController>());
  const [requestRevision, setRequestRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const [sort, setSort] = useState('distance');
  const buybacks = useBuybackValuations({plans: props.buybackPlans ?? [], markets: props.markets, now: props.now,
    demo: props.demo, feeRevision: props.feeRevision, retry});
  const eligible = props.instruments.filter(i => i.lots.some(l => l.remaining > 0));
  const descriptors = eligible.map(i => {
    const quote = props.markets[i.code]?.quote;
    const fresh = !props.demo && !!quote && Number.isFinite(quote.price) && quote.price > 0 && Number.isFinite(new Date(quote.fetched_at).getTime())
      && props.now - new Date(quote.fetched_at).getTime() <= 90000 && !/最新行情|超时|繁忙|暂不可用/.test(props.errors[i.code] ?? '');
    const basis = JSON.stringify([i.code, i.lots.map(lot => [lot.id, lot.remaining, lot.quantity, lot.unit_cost, lot.original_unit_cost, lot.t_restored_quantity, lot.target_profit_percent, lot.target_profit_amount, lot.stop_loss_percent, lot.stop_loss_amount]), props.feeRevision]);
    const key = JSON.stringify([basis, quote?.price, retry]);
    return {code: i.code, price: quote?.price, quoteAt: quote?.fetched_at, fresh, key, basis};
  });
  const latest = useRef(descriptors); latest.current = descriptors;
  const signature = JSON.stringify(descriptors);
  useEffect(() => {
    const requests = (JSON.parse(signature) as typeof descriptors).filter(d => {
      const previous = cache.current[d.code];
      return d.fresh && !requestsInFlight.current.has(d.code)
        && (!previous || previous.key !== d.key || (!!previous.error && previous.quoteAt !== d.quoteAt));
    });
    for (const d of requests) {
      const controller = new AbortController();
      requestsInFlight.current.set(d.code, controller);
      void api<{targets: Target[]; valuations?: Valuation[]}>(`/targets/${d.code}?price=${encodeURIComponent(d.price!)}`, {signal: controller.signal})
        .then(result => {
          if (!controller.signal.aborted && latest.current.some(item => item.code === d.code && item.basis === d.basis)) {
            setStatuses(current => ({...current, [d.code]: {key: d.key, basis: d.basis, quoteAt: d.quoteAt, price: d.price, targets: result.targets, valuations: result.valuations ?? result.targets}}));
          }
        })
        .catch(error => {
          if (!controller.signal.aborted) setStatuses(current => ({...current, [d.code]: {
            ...(current[d.code]?.basis === d.basis ? current[d.code] : {}), key: d.key, basis: d.basis, quoteAt: d.quoteAt, error: error.message,
          }}));
        })
        .finally(() => {
          if (requestsInFlight.current.get(d.code) === controller) {
            requestsInFlight.current.delete(d.code);
            if (!controller.signal.aborted) setRequestRevision(value => value + 1);
          }
        });
    }
  }, [signature, requestRevision]);
  useEffect(() => {
    const requests = requestsInFlight.current;
    return () => {for (const controller of requests.values()) controller.abort(); requests.clear();};
  }, []);
  const rows: Row[] = [];
  eligible.forEach((instrument, index) => {
    const d = descriptors[index]; const status = statuses[instrument.code];
    const ready = !props.demo && status?.basis === d.basis;
    for (const lot of instrument.lots.filter(item => item.remaining > 0)) {
      const target = ready ? status?.targets?.find(item => item.lot_id === lot.id) : undefined;
      const valuation = ready ? status?.valuations?.find(item => item.lot_id === lot.id) : undefined;
      const cost = lotReferenceUnitCost(lot) * lot.remaining;
      const goal = lot.target_profit_percent != null ? cost * Number(lot.target_profit_percent) / 100
        : lot.target_profit_amount != null ? Number(lot.target_profit_amount) * lot.remaining / lot.quantity : null;
      const gap = goal != null && valuation ? goal - Number(valuation.profit) : null;
      const previous = !!valuation && (!d.fresh || status?.key !== d.key || !!status?.error);
      rows.push({instrument, lot, target, valuation, price: ready ? status?.price ?? (d.fresh ? d.price! : null) : d.fresh ? d.price! : null, goal, gap, previous,
        distance: gap != null && cost > 0 ? gap / cost * 100 : null});
    }
  });
  const cards = [
    ...rows.map(row => ({type: 'lot' as const, row, gap: row.gap, percent: Number(row.valuation?.profit_percent ?? -Infinity), date: row.lot.executed_at, id: row.lot.id})),
    ...buybacks.rows.map(row => ({type: 'buyback' as const, row, gap: row.gap, percent: Number(row.valuation?.profit_percent ?? -Infinity), date: row.plan.executed_at, id: row.plan.id})),
  ].sort((a, b) => Number(b.type === 'buyback') - Number(a.type === 'buyback')
    || (sort === 'date' ? b.date.localeCompare(a.date)
    : sort === 'profit' ? b.percent - a.percent
    : a.gap == null ? (b.gap == null ? 0 : 1) : b.gap == null ? -1 : a.gap - b.gap)
    || b.date.localeCompare(a.date) || b.id - a.id);
  return <div className="reached-targets-page">
    <section className="panel lots-panel reached-targets-table reached-targets-cards">
      <div className="panel-heading targets-heading">
        <h1>批次追踪<span className="soft-count">{cards.length}</span></h1>
        {cards.length > 0 && <div className={`market-refresh-status ${props.refreshing ? 'refreshing' : ''}`}><span>{props.demo ? '示例模式不核对真实盈利目标' : props.marketOpen === false ? '非交易时段 · 暂停自动刷新' : props.pushLive ? '实时推送中 · 盈亏与排序实时更新' : props.pushStatus === 'connecting' ? '推送连接中 · 定时刷新' : props.pushStatus === 'retrying' || props.pushStatus === 'unavailable' ? '推送暂不可用 · 定时刷新' : props.refreshing ? '正在刷新行情…' : props.autoRefresh ? props.paused ? '自动刷新已暂停' : `${props.remaining} 秒后刷新` : '手动刷新'}</span>{props.marketOpen !== false && props.autoRefresh && !props.demo && !props.pushLive && <div className="market-refresh-track" role="progressbar" aria-label="批次行情刷新倒计时" aria-valuemin={0} aria-valuemax={props.refreshSeconds ?? 5} aria-valuenow={props.refreshing ? undefined : (props.refreshSeconds ?? 5) - props.remaining}><span style={{width: props.refreshing ? '100%' : `${((props.refreshSeconds ?? 5) - props.remaining) / (props.refreshSeconds ?? 5) * 100}%`}}/></div>}</div>}
        <div className="targets-toolbar">
          <select aria-label="批次排序" title="距目标金额为剩余盈利目标减预计净盈利，待买回批次置顶" value={sort} onChange={event => setSort(event.target.value)}>
            <option value="distance">距目标金额从小到大</option><option value="profit">盈利率从高到低</option><option value="date">交易时间倒序</option>
          </select>
          <button className="button secondary" disabled={props.refreshing || props.demo || !cards.length}
            onClick={() => {setRetry(value => value + 1); void props.onRefresh();}}>
            <RefreshCw size={15} className={props.refreshing ? 'spin' : ''}/>{props.refreshing ? '正在刷新' : '刷新行情'}
          </button>
        </div>
      </div>
      {props.buybackError && <div className="buyback-target-error" role="alert">待买回列表：{props.buybackError}</div>}
      {!!buybacks.rows.length && buybacks.error && <div className="buyback-target-error" role="alert">买回盈亏核算：{buybacks.error}</div>}
      {cards.length ? <div className="target-batch-cards">{cards.map(card => {
        if (card.type === 'buyback') return <TBuybackTargetCard key={`buyback:${card.row.plan.id}`} row={card.row} onBuyback={props.onBuyback}/>;
        const {instrument, lot, target, valuation, price, goal, gap, previous} = card.row;
        const profit = valuation ? Number(valuation.profit) : null;
        const tone = profit == null || profit === 0 ? '' : profit > 0 ? 'positive' : 'negative';
        const costReached = price != null && price >= lotReferenceUnitCost(lot);
        const stopReached = valuation?.stop_loss_reached === true;
        return <button key={`${instrument.code}:${lot.id}`} className={`lot-row lot-performance-card ${stopReached ? 'stop-loss-reached' : target?.reached ? 'target-reached' : costReached ? 'cost-reached' : ''}`} disabled={props.demo} aria-label={`卖出${instrument.name}买入批次${lot.id}`} onClick={() => props.onSell(instrument, lot)}>
          <span className="target-card-instrument"><strong>{instrument.name}</strong><span>{instrument.code}</span><span className="target-card-price">{previous ? '参考价' : '现价'} {money(price, 3)}</span></span>
          <span className="lot-card-heading"><span className="lot-card-date">{lot.executed_at.slice(0, 10)}<span>#{lot.id}</span></span><span className="lot-card-status"><LotOrderBadge lot={lot}/>{stopReached ? <span className="lot-stop-status">已到止损</span> : target?.reached ? <span className="lot-goal-badge"><Check size={10}/>已达标</span> : costReached ? <span className="lot-cost-status" title="当前价已到含买入费用的成本，卖出费用另计">已到成本</span> : null}</span><ArrowRight size={13}/></span>
          <span className="lot-pnl-block"><span className="lot-pnl-label">{lot.t_restored_quantity || lot.t_completed_count ? '原价盈亏' : '预计净盈亏'}{previous && <span className="target-previous-value">上次核算</span>}</span><span className={`lot-pnl-values ${tone}`}><strong>{profit != null ? `${profit > 0 ? '+' : profit < 0 ? '−' : ''}¥ ${money(Math.abs(profit))}` : '—'}</strong><span className="lot-pnl-percent">{valuation ? `${signed(valuation.profit_percent)}%` : price == null ? '等待行情' : '等待核算'}</span></span></span>
          <span className="lot-card-stats"><span><small>剩余数量</small><strong>{money(lot.remaining, 0)}<em> / {money(lot.quantity, 0)}</em></strong></span><span><small>{lot.t_restored_quantity ? '原买入价' : '每股 / 份成本'}</small><strong>¥ {money(lot.t_restored_quantity ? lot.price : lot.unit_cost, 3)}</strong></span><span><small>{lot.t_restored_quantity ? '原始成本' : '剩余成本'}</small><strong>¥ {money(lotReferenceUnitCost(lot) * lot.remaining)}</strong></span></span>
          <span className="lot-card-footer"><span className="lot-target">{goal == null ? <span>未设置目标</span> : <><span>{lot.target_profit_percent != null ? `目标 +${money(lot.target_profit_percent)}%` : `目标 +¥ ${money(lot.target_profit_amount)}`}</span><span>{lot.remaining < lot.quantity ? '剩余目标' : '目标金额'} +¥ {money(goal)}</span>{gap != null && <span className={`lot-target-gap ${gap <= 0 ? 'positive' : ''}`}>{gap > 0 ? '还差' : '超目标'} ¥ {money(Math.abs(gap))}</span>}</>}</span>{lot.stop_loss_amount != null ? <span className="lot-stop-target">{lot.remaining < lot.quantity ? '剩余止损' : '止损'} −¥ {money(Number(lot.stop_loss_amount) * (lot.remaining || lot.quantity) / lot.quantity)}</span> : lot.stop_loss_percent != null ? <span className="lot-stop-target" title="按含买入费用的剩余持仓成本计算；已卖完的批次显示原始止损金额">止损 −{money(lot.stop_loss_percent)}% · −¥ {money(valuation?.stop_loss_amount ?? lotReferenceUnitCost(lot) * (lot.remaining || lot.quantity) * Number(lot.stop_loss_percent) / 100)}</span> : null}</span>
          <RestoredLotInfo lot={lot} originalProfit={profit}/>
        </button>;
      })}</div> : <div className="targets-empty">暂无持仓或待买回批次。</div>}
    </section>
  </div>;
}
