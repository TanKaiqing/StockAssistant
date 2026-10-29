import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { api } from '../api';
import { LotOrderBadge } from './LotOrderBadge';
import { RestoredLotInfo } from './RestoredLotInfo';
import { lotReferenceUnitCost, money, priceDigits, signed, type Instrument, type Lot, type Quote, type TTradePlan } from '../types';
import { TBuybackTargetCard, useBuybackValuations } from './TBuybackTargetCard';

interface Target {lot_id: number; reached: boolean; profit: string; profit_percent: string; target_profit: string; estimated_sell_fee: string}
type Valuation = Pick<Target, 'lot_id' | 'profit' | 'profit_percent' | 'estimated_sell_fee'> & {stop_loss_reached?: boolean; stop_loss_amount?: string | null};
type Status = {key: string; basis: string; quoteAt?: string; price?: number; targets?: Target[]; valuations?: Valuation[]; error?: string};
interface Props {
  instrument: Instrument; quote?: Quote | null; stale: boolean; feeRevision: number;
  showClosed: boolean; onShowClosed: (value: boolean) => void; focusedLot: number | null; onLotClick: (lot: Lot) => void;
  buybackPlans?: TTradePlan[]; buybackError?: string; now?: number; demo?: boolean;
  onBuyback?: (code: string, quantity: number, price: string | null) => void;
}
export function BuyLots(props: Props) {
  const {instrument, quote, stale, showClosed} = props;
  const [buybackRetry, setBuybackRetry] = useState(0);
  const buybacks = useBuybackValuations({
    plans: (props.buybackPlans ?? []).filter(plan => plan.code === instrument.code && plan.remaining > 0),
    markets: quote ? {[instrument.code]: {source: quote.source ?? '', quote, history: [], warnings: []}} : {},
    now: props.now ?? Date.now(), demo: props.demo ?? false, feeRevision: props.feeRevision, retry: buybackRetry,
  });
  const signature = JSON.stringify(instrument.lots.map(lot => [lot.id, lot.remaining, lot.quantity, lot.unit_cost, lot.original_unit_cost, lot.t_restored_quantity, lot.target_profit_percent, lot.target_profit_amount, lot.stop_loss_percent, lot.stop_loss_amount]));
  const basis = `${instrument.code}|${signature}|${props.feeRevision}`;
  const key = `${instrument.code}|${quote?.price}|${signature}|${props.feeRevision}`;
  const hasOpenLots = instrument.lots.some(lot => lot.remaining > 0);
  const validQuote = !!quote && !stale && Number.isFinite(quote.price) && quote.price > 0;
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const cache = useRef(statuses); cache.current = statuses;
  const requestsInFlight = useRef(new Map<string, AbortController>());
  const [requestRevision, setRequestRevision] = useState(0);
  const latest = useRef({code: instrument.code, basis}); latest.current = {code: instrument.code, basis};
  useEffect(() => {
    const code = instrument.code;
    const previous = cache.current[code];
    if (!hasOpenLots || !validQuote || !quote || requestsInFlight.current.has(code)
        || (previous?.key === key && (!previous.error || previous.quoteAt === quote.fetched_at))) return;
    const price = quote.price;
    const controller = new AbortController();
    requestsInFlight.current.set(code, controller);
    void api<{targets: Target[]; valuations?: Valuation[]}>(`/targets/${code}?price=${encodeURIComponent(price)}`, {signal: controller.signal})
      .then(result => {
        if (!controller.signal.aborted && latest.current.code === code && latest.current.basis === basis) {
          setStatuses(current => ({...current, [code]: {key, basis, quoteAt: quote.fetched_at, price, targets: result.targets, valuations: result.valuations ?? result.targets}}));
        }
      })
      .catch(err => {
        if (!controller.signal.aborted) setStatuses(current => ({...current, [code]: {
          ...(current[code]?.basis === basis ? current[code] : {}), key, basis, quoteAt: quote.fetched_at, error: err.message,
        }}));
      })
      .finally(() => {
        if (requestsInFlight.current.get(code) === controller) {
          requestsInFlight.current.delete(code);
          if (!controller.signal.aborted) setRequestRevision(value => value + 1);
        }
      });
  }, [key, basis, hasOpenLots, validQuote, instrument.code, quote?.price, quote?.fetched_at, requestRevision]);
  useEffect(() => {
    const requests = requestsInFlight.current;
    return () => {for (const controller of requests.values()) controller.abort(); requests.clear();};
  }, []);
  const status = statuses[instrument.code];
  const current = status?.basis === basis ? status : null;
  const previous = !!current?.valuations && (!validQuote || current.key !== key || !!current.error);
  const displayPrice = current?.price ?? (validQuote ? quote?.price : undefined);
  const targets = new Map((current?.targets ?? []).map(target => [target.lot_id, target]));
  const valuations = new Map((current?.valuations ?? []).map(value => [value.lot_id, value]));
  const visible = instrument.lots.filter(lot => showClosed || lot.remaining > 0).sort((a, b) =>
    Number(targets.get(b.id)?.reached ?? false) - Number(targets.get(a.id)?.reached ?? false)
    || b.executed_at.localeCompare(a.executed_at) || b.id - a.id);
  const cards = [
    ...visible.map(lot => ({type: 'lot' as const, lot, reached: targets.get(lot.id)?.reached ?? false, date: lot.executed_at, id: lot.id})),
    ...buybacks.rows.map(row => ({type: 'buyback' as const, row, reached: row.reached, date: row.plan.executed_at, id: row.plan.id})),
  ].sort((a, b) => Number(b.type === 'buyback') - Number(a.type === 'buyback')
    || Number(b.reached) - Number(a.reached) || b.date.localeCompare(a.date) || b.id - a.id);
  return <section className="panel lots-panel">
      <div className="panel-heading"><div><h3>买入批次<span className="soft-count">{cards.length}</span></h3></div>
      <label className="checkbox-label"><input type="checkbox" checked={showClosed} onChange={e => props.onShowClosed(e.target.checked)}/>显示已卖完</label>
    </div>
    <div className="lots-list">{cards.map(card => {
      if (card.type === 'buyback') return <TBuybackTargetCard key={`buyback:${card.row.plan.id}`} row={card.row} onBuyback={props.onBuyback}/>;
      const lot = card.lot;
      const target = targets.get(lot.id);
      const valuation = valuations.get(lot.id);
      const stopReached = lot.remaining > 0 && valuation?.stop_loss_reached === true;
      const profit = valuation ? Number(valuation.profit) : null;
      const pnlClass = profit == null || profit === 0 ? '' : profit > 0 ? 'positive' : 'negative';
      const costReached = lot.remaining > 0 && displayPrice != null && Number.isFinite(displayPrice)
        && displayPrice > 0 && displayPrice >= lotReferenceUnitCost(lot);
      const goal = lot.target_profit_percent != null ? `目标 +${money(lot.target_profit_percent)}%`
        : lot.target_profit_amount != null ? `目标 +¥ ${money(lot.target_profit_amount)}` : null;
      const percentGoalAmount = lot.target_profit_percent != null
        ? target?.target_profit ?? lotReferenceUnitCost(lot) * (lot.remaining > 0 ? lot.remaining : lot.quantity) * Number(lot.target_profit_percent) / 100
        : null;
      const targetAmount = target ? Number(target.target_profit) : lot.target_profit_percent != null
        ? (percentGoalAmount == null ? null : Number(percentGoalAmount)) : lot.target_profit_amount != null ? Number(lot.target_profit_amount) * lot.remaining / lot.quantity : null;
      const gap = profit != null && targetAmount != null ? targetAmount - profit : null;
      return <button key={lot.id} className={`lot-row lot-performance-card ${lot.remaining ? '' : 'lot-closed'} ${props.focusedLot === lot.id ? 'focused' : ''} ${stopReached ? 'stop-loss-reached' : target?.reached ? 'target-reached' : costReached ? 'cost-reached' : ''}`}
        aria-label={lot.remaining > 0 ? `卖出买入批次${lot.id}` : `查看买入批次${lot.id}成本线`} onClick={() => props.onLotClick(lot)}>
        <span className="lot-card-heading"><span className="lot-card-date">{lot.executed_at.slice(0, 10)}<span>#{lot.id}</span></span>
          <span className="lot-card-status"><LotOrderBadge lot={lot}/>{stopReached ? <span className="lot-stop-status">已到止损</span> : target?.reached ? <span className="lot-goal-badge"><Check size={10}/>已达标</span> : costReached ? <span className="lot-cost-status" title="当前价已达到含买入费用的每股成本；卖出费用另计">已到成本</span> : !lot.remaining ? <span>{lot.t_transferred_quantity === lot.quantity ? '已恢复原批次' : lot.t_transferred_quantity ? '部分恢复原批次' : '已全部卖出'}</span> : null}</span><ArrowRight size={13}/>
        </span>
        {lot.remaining > 0 && <span className="lot-pnl-block"><span className="lot-pnl-label">{lot.t_restored_quantity || lot.t_completed_count ? '原价盈亏' : '预计净盈亏'}{previous && <span className="target-previous-value">上次核算</span>}</span><span className={`lot-pnl-values ${pnlClass}`}><strong>{profit != null ? `${profit > 0 ? '+' : profit < 0 ? '−' : ''}¥ ${money(Math.abs(profit))}` : '—'}</strong><span className="lot-pnl-percent">{valuation ? `${signed(valuation.profit_percent)}%` : !validQuote ? '等待行情' : current?.error ? '暂不可用' : '正在核算'}</span></span></span>}
        <span className="lot-card-stats"><span><small>剩余数量</small><strong>{money(lot.remaining, 0)}<em> / {money(lot.quantity, 0)}</em></strong></span><span><small>{lot.t_restored_quantity ? '原买入价' : '每股 / 份成本'}</small><strong>¥ {money(lot.t_restored_quantity ? lot.price : lot.unit_cost, priceDigits(instrument.kind))}</strong></span><span><small>{lot.t_restored_quantity ? '原始成本' : lot.remaining ? '剩余成本' : '原始成本'}</small><strong>¥ {money(lotReferenceUnitCost(lot) * (lot.remaining || lot.quantity))}</strong></span></span>
        {(goal || lot.stop_loss_percent != null || lot.stop_loss_amount != null) && <span className="lot-card-footer">{goal && <span className="lot-target"><span>{goal}</span>{percentGoalAmount != null && <span title="按含买入费用的持仓成本计算">{lot.remaining > 0 ? '目标金额' : '原始目标金额'} +¥ {money(percentGoalAmount)}</span>}{gap != null && lot.remaining > 0 && <span className={`lot-target-gap ${gap <= 0 ? 'positive' : ''}`}>{gap > 0 ? `还差 ¥ ${money(gap)}` : `超目标 ¥ ${money(-gap)}`}</span>}</span>}{lot.stop_loss_amount != null ? <span className="lot-stop-target">{lot.remaining < lot.quantity ? '剩余止损' : '止损'} −¥ {money(Number(lot.stop_loss_amount) * (lot.remaining || lot.quantity) / lot.quantity)}</span> : lot.stop_loss_percent != null ? <span className="lot-stop-target" title="按含买入费用的剩余持仓成本计算；已卖完的批次显示原始止损金额">止损 −{money(lot.stop_loss_percent)}% · −¥ {money(valuation?.stop_loss_amount ?? lotReferenceUnitCost(lot) * (lot.remaining || lot.quantity) * Number(lot.stop_loss_percent) / 100)}</span> : null}</span>}
        <RestoredLotInfo lot={lot} originalProfit={profit}/>
      </button>;
    })}
    {!cards.length && <div className="compact-empty">{instrument.lots.length ? '当前没有未卖完的批次，可勾选查看历史。' : '还没有买入批次，记录一笔买入即可。'}</div>}
    {props.buybackError && <p className="target-note" role="alert">待买回列表：{props.buybackError}</p>}
    {!!buybacks.rows.length && buybacks.error && <p className="target-note" role="alert">待买回盈亏：{buybacks.error} <button className="text-button" onClick={() => setBuybackRetry(value => value + 1)}>重试</button></p>}
    {hasOpenLots && current?.error && <p className="target-note" role="alert">盈亏核算：{current.error}</p>}
    </div>
  </section>;
}
