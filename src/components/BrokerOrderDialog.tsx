import { useRef, useState } from 'react';
import { api } from '../api';
import { Modal } from './Modal';
import './BrokerPage.css';

export type OrderSeed = {buy_lot_id?: number | null; side: 'buy' | 'sell'; code?: string; price?: string; name?: string; quantity?: string; t_trade?: boolean; t_buyback_price?: string | null};
export type OrderPreview = {buy_lot_id?: number | null; ticket: string; expires_in: number; available_quantity: string; order: {code: string; side: 'buy' | 'sell'; price: string; quantity: string}};

type Props = {
  seed: OrderSeed; onClose: () => void; onOrders: () => void; onSubmitted?: () => void;
  prepared?: {preview: OrderPreview; expiresAt: number}; onEdit?: (message?: string) => void;
  onIntentChanged?: () => void;
};

export function BrokerOrderDialog({seed, onClose, onOrders, onSubmitted, prepared, onEdit, onIntentChanged}: Props) {
  const [code, setCode] = useState(seed.code ?? '');
  const [side, setSide] = useState(seed.side);
  const [price, setPrice] = useState(seed.price ? Number(seed.price).toFixed(3) : '');
  const [quantity, setQuantity] = useState(seed.quantity ?? '100');
  const [preview, setPreview] = useState<OrderPreview | null>(prepared?.preview ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState('');
  const [queryError, setQueryError] = useState('');
  const submitting = useRef(false);
  const expires = useRef(prepared?.expiresAt ?? 0);

  function changeDraft(patch: Partial<{side: 'buy' | 'sell'; price: string; quantity: string}>) {
    const draft = {side, price, quantity, ...patch};
    setSide(draft.side); setPrice(draft.price); setQuantity(draft.quantity);
  }

  async function prepare() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const value = await api<OrderPreview>('/broker/trade/preview', {method: 'POST', body: JSON.stringify({code, side, price, quantity: Number(quantity), buy_lot_id: side === 'sell' && code === seed.code ? seed.buy_lot_id ?? null : null,
        t_trade: side === 'sell' && code === seed.code && !!seed.t_trade, t_buyback_price: side === 'sell' && code === seed.code && seed.t_trade ? seed.t_buyback_price ?? null : null})});
      expires.current = Date.now() + value.expires_in * 1000;
      setPreview(value);
    } catch (err) {setError((err as Error).message);}
    finally {submitting.current = false; setBusy(false);}
  }

  async function submit() {
    if (!preview || submitting.current || outcome) return;
    if (Date.now() >= expires.current) {
      if (onEdit) onEdit('预览已过期，请重新预览');
      else {setPreview(null); setError('预览已过期，请重新预览');}
      return;
    }
    submitting.current = true; setBusy(true); setError('');
    try {
      const value = await api<{status: string; message: string}>('/broker/trade/submit', {method: 'POST', body: JSON.stringify({ticket: preview.ticket, confirmed: true})});
      setOutcome(value.message);
    } catch (err) {
      setOutcome(`${(err as Error).message}。请先查询当日委托及成交，确认后再操作。`);
    } finally {
      setPreview(null); submitting.current = false; setBusy(false);
      onIntentChanged?.();
      if (onSubmitted) onSubmitted();
      else {
        // The shared holdings dialog has no broker table behind it. Query the
        // order state after sending; the result button opens its full table.
        void api('/broker/orders').catch(err => setQueryError(`委托查询失败：${(err as Error).message}`));
      }
    }
  }

  return <Modal open onOpenChange={open => {if (!open && !submitting.current) onClose();}} variant="trade" title={side === 'buy' ? '买入委托' : '卖出委托'} description="提交至同花顺当前普通账户">
    <div className="broker-order-body">
      {outcome ? <div role="status" className="broker-notice">{outcome}</div> : preview ? <>
        <div className="broker-order-summary">
          <span>证券<strong>{preview.order.code}{seed.code === preview.order.code && seed.name ? ` · ${seed.name}` : ''}</strong></span>
          <span>方向<strong className={side === 'buy' ? 'positive' : 'negative'}>{preview.order.side === 'buy' ? '买入' : '卖出'}</strong></span>
          <span>委托价<strong>¥ {preview.order.price}</strong></span>
          <span>委托数量<strong>{preview.order.quantity}</strong></span>
          <span>委托金额<strong>¥ {(Number(preview.order.price) * Number(preview.order.quantity)).toFixed(2)}（不含费用）</strong></span>
          <span>可交易数量<strong>{preview.available_quantity}</strong></span>
          {preview.order.side === 'sell' && <span>本地成本批次<strong>{preview.buy_lot_id ? `#${preview.buy_lot_id}` : '同步成交时选择'}</strong></span>}
          {preview.order.side === 'sell' && seed.t_trade && <span>做 T 标记<strong>成交同步后待买回{seed.t_buyback_price ? ` · 期望 ${Number(seed.t_buyback_price).toFixed(3)}` : ''}</strong></span>}
        </div>
        <small>预览30秒有效。确认期间请勿切换账户或重新登录；如已切换，请返回重新预览。</small>
      </> : <form id="broker-order-form" onSubmit={e => {e.preventDefault(); void prepare();}} className="broker-order-fields">
        <label>证券代码<input aria-label="委托证券代码" required pattern="[0-9]{6}" maxLength={6} value={code} disabled={busy} onChange={e => setCode(e.target.value)}/></label>
        <label>买卖方向<select aria-label="委托买卖方向" value={side} disabled={busy} onChange={e => changeDraft({side: e.target.value as 'buy' | 'sell'})}><option value="buy">买入</option><option value="sell">卖出</option></select></label>
        <label>委托价<input aria-label="委托价格" required type="number" min="0.001" max="100000" step="0.001" value={price} disabled={busy} onChange={e => changeDraft({price: e.target.value})} onBlur={() => {if (Number(price) > 0) changeDraft({price: Number(price).toFixed(3)});}}/></label>
        <label>委托数量<input aria-label="委托数量" required type="number" min={side === 'buy' ? 100 : 1} max="100000000" step={side === 'buy' ? 100 : 1} value={quantity} disabled={busy} onChange={e => changeDraft({quantity: e.target.value})}/></label>
      </form>}
      {error && <div className="broker-error" role="alert">{error}</div>}
      {queryError && <div className="broker-error" role="alert">{queryError}</div>}
    </div>
    <div className="broker-order-footer">
      {outcome ? <button className="button primary" onClick={onOrders}>查看当日委托</button> : preview ? <><button className="button secondary" disabled={busy} onClick={() => {if (onEdit) onEdit(); else {setPreview(null);}}}>返回修改</button><button className="button primary" disabled={busy} onClick={() => void submit()}>{busy ? '正在提交…' : `确认真实${side === 'buy' ? '买入' : '卖出'}`}</button></> : <button className="button primary" type="submit" form="broker-order-form" disabled={busy}>{busy ? '正在预览…' : '预览委托'}</button>}
    </div>
  </Modal>;
}
