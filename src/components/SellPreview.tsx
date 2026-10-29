import { useEffect, useState } from 'react';
import { api } from '../api';
import { money, signed } from '../types';

interface Props {
  code: string; price: string; quantity: string; fee: string; executedAt: string;
  buyLotId: string; editingId?: number; valid: boolean; ready: boolean; feeError?: string;
}
interface Result {realized_pnl: string; buy_cost: string; sell_amount: string; sell_fee: string}

export function SellPreview(props: Props) {
  const payload = {code: props.code, side: 'sell', price: props.price, quantity: Number(props.quantity),
    fee: props.fee, executed_at: props.executedAt, buy_lot_id: props.buyLotId ? Number(props.buyLotId) : null,
    editing_id: props.editingId ?? null};
  const key = JSON.stringify(payload);
  const [preview, setPreview] = useState<{key: string; result?: Result; error?: string} | null>(null);
  useEffect(() => {
    if (!props.valid || !props.ready || !props.executedAt) return;
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<Result>('/trades/preview', {method: 'POST', signal: controller.signal, body: key})
        .then(result => {if (active) setPreview({key, result});})
        .catch(err => {if (active) setPreview({key, error: err.message});});
    }, 150);
    return () => {active = false; controller.abort(); window.clearTimeout(timer);};
  }, [key, props.valid, props.ready, props.executedAt]);
  const current = preview?.key === key ? preview : null;
  const result = props.valid && props.ready ? current?.result : undefined;
  const error = props.feeError || (props.ready ? current?.error : '');
  const value = !props.valid || !props.executedAt ? '—' : error ? '暂不可用'
    : result ? `¥ ${signed(result.realized_pnl)}` : '计算中…';
  const tone = result ? Number(result.realized_pnl) > 0 ? 'positive' : Number(result.realized_pnl) < 0 ? 'negative' : '' : '';
  return <div className="sell-preview">
    <div className="trade-preview"><span>本次卖出盈亏</span><strong className={tone}>{value}</strong></div>
    <small className="field-hint">卖出金额 − 对应买入成本（含买入费用）− 卖出费用</small>
    {result && <div className="preview-breakdown"><span>卖出金额 ¥ {money(result.sell_amount)}</span><span>买入成本 ¥ {money(result.buy_cost)}</span><span>卖出费用 ¥ {money(result.sell_fee)}</span></div>}
    {error && props.valid && <div className="form-error" role="alert">{error}</div>}
  </div>;
}
