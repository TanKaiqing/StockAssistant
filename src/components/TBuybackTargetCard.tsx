import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { api } from '../api';
import { money, signed, type Market, type TTradePlan } from '../types';
import './TBuybackTargetCard.css';

type Valuation = {id: number; price: string; remaining: number; profit: string; profit_percent: string | null;
  sell_proceeds: string; sell_fee: string; buy_fee: string; target_profit: string | null};
export type BuybackCardRow = {plan: TTradePlan; valuation?: Valuation; price: number | null;
  quoteAt?: string; previous: boolean; gap: number | null; reached: boolean};

export function useBuybackValuations(props: {plans: TTradePlan[]; markets: Record<string, Market>; now: number;
  demo: boolean; feeRevision: number; retry: number}) {
  const [values, setValues] = useState<Record<number, {basis: string; value: Valuation; quoteAt?: string}>>({});
  const [error, setError] = useState('');
  const descriptors = props.demo ? [] : props.plans.filter(plan => plan.remaining > 0).map(plan => {
    const quote = props.markets[plan.code]?.quote;
    const age = quote ? props.now - new Date(quote.fetched_at).getTime() : NaN;
    const fresh = !!quote && Number.isFinite(quote.price) && quote.price > 0 && Number.isFinite(age)
      && age >= -5000 && age <= (quote.source?.includes('本地桥接') ? 12000 : 90000);
    return {plan, quote, fresh, basis: JSON.stringify([plan, props.feeRevision])};
  });
  const prices = Object.fromEntries(descriptors.filter(row => row.fresh).map(row => [row.plan.code, String(row.quote!.price)]));
  const signature = JSON.stringify([descriptors.map(row => [row.plan.id, row.basis]), prices, props.retry]);
  useEffect(() => {
    if (!Object.keys(prices).length) return;
    const controller = new AbortController();
    void api<{valuations: Valuation[]}>('/t-trades/valuations', {method: 'POST', signal: controller.signal, body: JSON.stringify({prices})})
      .then(result => {
        if (controller.signal.aborted) return;
        setError('');
        setValues(current => {
          const next = {...current};
          for (const value of result.valuations) {
            const descriptor = descriptors.find(row => row.plan.id === value.id && row.plan.remaining === value.remaining);
            if (descriptor) next[value.id] = {basis: descriptor.basis, value, quoteAt: descriptor.quote?.fetched_at};
          }
          return next;
        });
      }).catch(err => {if (!controller.signal.aborted) setError((err as Error).message);});
    return () => controller.abort();
    // The signature contains plan state, fee revision, valid quote prices and retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const rows: BuybackCardRow[] = descriptors.map(({plan, quote, fresh, basis}) => {
    const valuation = values[plan.id]?.basis === basis ? values[plan.id].value : undefined;
    const previous = !!valuation && (!fresh || Number(valuation.price) !== quote?.price || !!error);
    return {plan, valuation, previous, quoteAt: previous ? values[plan.id]?.quoteAt : quote?.fetched_at,
      price: valuation ? Number(valuation.price) : fresh ? quote!.price : null,
      gap: valuation?.target_profit != null ? Number(valuation.target_profit) - Number(valuation.profit) : null,
      reached: !previous && !!valuation && plan.target_price != null && Number(valuation.price) <= Number(plan.target_price)};
  });
  return {rows, error};
}

export function TBuybackTargetCard({row, onBuyback}: {row: BuybackCardRow;
  onBuyback?: (code: string, quantity: number, price: string | null) => void}) {
  const {plan, valuation, price, previous, gap} = row;
  const profit = valuation ? Number(valuation.profit) : null;
  const tone = profit == null || profit === 0 ? '' : profit > 0 ? 'positive' : 'negative';
  const progress = plan.quantity > 0 ? Math.min(100, Math.max(0, plan.matched_quantity / plan.quantity * 100)) : 0;
  return <button className={`lot-row lot-performance-card target-buyback-card ${row.reached ? 'target-reached' : ''}`}
    title={valuation ? `仅计待买回部分。卖出费 ¥ ${money(valuation.sell_fee)}，预计买回佣金 ¥ ${money(valuation.buy_fee)}，其他买回费用未包含。` : '仅计待买回部分的预计净价差'}
    disabled={!onBuyback} aria-label={`买回${plan.name}做T卖出${plan.id}`} onClick={() => onBuyback?.(plan.code, plan.remaining, price?.toFixed(3) ?? plan.target_price)}>
    <span className="buyback-summary-heading"><span className="buyback-summary-name"><strong>{plan.name}</strong><span>{plan.code} · 卖出{(plan.sell_ids?.length ?? 0) > 1 ? `委托 · ${plan.sell_ids!.length} 笔成交` : ` #${plan.id}`}</span></span>
      <span className="buyback-card-badge">{row.reached ? '达到买回价' : plan.matched_quantity > 0 ? '做 T · 部分买回' : '做 T · 待买回'}</span></span>
    <span className="lot-pnl-block"><span className="lot-pnl-label">{previous ? '按参考价买回 · 预计净价差' : '按现价买回 · 预计净价差'}{previous && <span className="target-previous-value">上次核算</span>}</span>
      <span className={`lot-pnl-values ${tone}`}><strong>{profit == null ? '—' : `${profit > 0 ? '+' : profit < 0 ? '−' : ''}¥ ${money(Math.abs(profit))}`}</strong>
        <span className="lot-pnl-percent">{valuation ? valuation.profit_percent == null ? '—' : `${signed(valuation.profit_percent)}%` : price == null ? '等待行情' : '等待核算'}</span></span></span>
    <span className="buyback-price-grid"><span><small>卖出价</small><strong>{money(plan.price, 3)}</strong></span>
      <span><small>{previous ? '参考价' : '现价'}</small><strong>{money(price, 3)}</strong></span>
      <span><small>期望买回价</small><strong>{plan.target_price ? money(plan.target_price, 3) : '未设置'}</strong></span></span>
    <span className="buyback-goal-line">
      {gap != null ? <span className={gap <= 0 ? 'positive' : ''}>{gap > 0 ? '距期望还差' : gap === 0 ? '已达期望' : '超期望'}{gap !== 0 && <> ¥ {money(Math.abs(gap))}</>}</span> : <span>{plan.target_price ? '期望价差待核算' : '未设置期望买回价'}</span>}
    </span>
    <span className="buyback-quantity-line"><span>待买回 <strong>{money(plan.remaining, 0)}</strong> 股/份</span><span>已买回 {money(plan.matched_quantity, 0)} / {money(plan.quantity, 0)}</span></span>
    <span className="buyback-progress" aria-hidden="true"><span style={{width: `${progress}%`}}/></span>
    <span className="buyback-summary-footer"><span>{plan.executed_at.slice(0, 10)} 卖出{row.quoteAt && <> · 报价 {new Date(row.quoteAt).toLocaleTimeString('zh-CN', {hour12: false})}</>}</span>
      {onBuyback && <span className="buyback-action-label">买回 <ArrowRight size={14}/></span>}</span>
  </button>;
}
