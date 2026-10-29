import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, Check, CheckCheck, Link2, LoaderCircle } from 'lucide-react';
import { api } from '../api';
import { money } from '../types';
import { Modal } from './Modal';
import type { RecordRow } from './BrokerPage';
import './DealBuybackDialog.css';

export type SellTState = {key: string; t_trade: boolean; has_t_links: boolean};
type Context = {buy_id: number; available: number; quantity: number; sell_states: SellTState[];
  candidates: {id: number; executed_at: string; remaining: number; price: string; fill_count: number}[];
  associations: {sell_id: number; executed_at: string; quantity: number; restored: boolean}[]};

export function DealBuybackDialog({row, onClose, onChanged, onBusyChange}: {
  row: RecordRow; onClose: () => void; onChanged: (states: SellTState[]) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [data, setData] = useState<Context | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const [error, setError] = useState('');
  const [sellId, setSellId] = useState('');
  const [quantity, setQuantity] = useState('');
  const token = row.sync_token;
  const load = useCallback(async (signal?: AbortSignal) => {
    return api<Context>('/broker/sync/deal-group/buyback-options', {method: 'POST', signal, body: JSON.stringify({token})});
  }, [token]);
  function chooseDefault(result: Context) {
    const candidate = result.candidates.length === 1 ? result.candidates[0] : null;
    setSellId(candidate ? String(candidate.id) : '');
    setQuantity(candidate ? String(Math.min(candidate.remaining, result.available)) : '');
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then(result => {
      if (!controller.signal.aborted) {setData(result); chooseDefault(result);}
    }).catch(err => {if (!controller.signal.aborted) setError((err as Error).message);})
      .finally(() => {if (!controller.signal.aborted) setLoading(false);});
    return () => controller.abort();
  }, [load]);
  const selected = data?.candidates.find(plan => String(plan.id) === sellId);
  const maximum = Math.min(data?.available ?? 0, selected?.remaining ?? 0);
  const valid = !!selected && Number.isInteger(Number(quantity)) && Number(quantity) > 0 && Number(quantity) <= maximum;
  async function change(sell: number, action: 'link' | 'unlink' | 'restore') {
    if (!data || mutation.current) return;
    mutation.current = true; setBusy(true); onBusyChange(true); setError('');
    let committed = false;
    try {
      await api(`/t-trades/orders/${sell}/buybacks${action === 'link' ? '' : `/${data.buy_id}${action === 'restore' ? '/restoration' : ''}`}`, {
        method: action === 'link' ? 'POST' : action === 'restore' ? 'PUT' : 'DELETE',
        ...(action === 'link' ? {body: JSON.stringify({buy_id: data.buy_id, quantity: Number(quantity)})} : {}),
      });
      committed = true;
      // Notify the parent even if reloading the options fails after a committed write.
      onChanged([]);
      setData(null);
      const result = await load();
      setData(result); chooseDefault(result); onChanged(result.sell_states);
    } catch (err) {setError(committed ? `操作已保存，重新打开可刷新列表：${(err as Error).message}` : (err as Error).message);}
    finally {mutation.current = false; setBusy(false); onBusyChange(false);}
  }
  const canLink = !!data && data.available > 0 && data.candidates.length > 0;
  return <Modal open onOpenChange={value => {if (!busy && !value) onClose();}} title="关联做 T 买回" description="选择对应的卖出委托，恢复原买入批次。" className="deal-buyback-dialog">
    <div className="buyback-scroll">
    {error && <div className="form-error" role="alert">{error}</div>}
    {busy && !data && <div className="broker-empty"><LoaderCircle size={18} className="spin"/>正在更新关联…</div>}
    {loading ? <div className="broker-empty"><LoaderCircle size={18} className="spin"/>正在读取可关联委托…</div> : data && <>
      <div className="buyback-context">
        <div className="buyback-instrument"><span className="buyback-icon"><ArrowDownLeft size={21}/></span><div><strong>{row.name || row.code}</strong><span>{row.code} · 买入均价 {money(row.price, 3)}</span></div></div>
        <div className="buyback-available"><span>可关联数量</span><strong>{money(data.available, 0)}<small> / {money(data.quantity, 0)}</small></strong></div>
      </div>
      {canLink ? <form id="deal-buyback-form" onSubmit={event => {event.preventDefault(); if (valid) void change(Number(sellId), 'link');}}>
        <div className="buyback-section-title" id="buyback-orders-label"><h3>选择卖出委托</h3><span>{data.candidates.length} 笔待买回</span></div>
        <div className="buyback-orders" role="radiogroup" aria-labelledby="buyback-orders-label">
          {data.candidates.map(plan => <label key={plan.id} className={`buyback-order ${sellId === String(plan.id) ? 'selected' : ''}`}>
            <input type="radio" name="buyback-sell" value={plan.id} required checked={sellId === String(plan.id)} disabled={busy} onChange={() => {setSellId(String(plan.id)); setQuantity(String(Math.min(data.available, plan.remaining)));}}/>
            <span className="buyback-radio" aria-hidden="true">{sellId === String(plan.id) && <Check size={12}/>}</span>
            <span className="buyback-order-info"><strong>卖出 #{plan.id}<small>{plan.fill_count} 笔成交</small></strong><span>{plan.executed_at.replace('T', ' ')}</span></span>
            <span className="buyback-order-number"><small>卖出均价</small><strong>{money(plan.price, 3)}</strong></span>
            <span className="buyback-order-number"><small>待买回</small><strong>{money(plan.remaining, 0)}</strong></span>
          </label>)}
        </div>
        <div className="buyback-quantity-row"><div><label htmlFor="deal-buyback-quantity">本次关联数量</label><span>{selected ? `最多 ${money(maximum, 0)} 股/份` : '请先选择卖出委托'}</span></div><div className="buyback-quantity-input"><input id="deal-buyback-quantity" aria-label="本次关联数量" type="number" min="1" max={maximum || undefined} step="1" required disabled={busy || !selected} value={quantity} placeholder="0" onChange={event => setQuantity(event.target.value)}/><button type="button" disabled={busy || !selected} onClick={() => setQuantity(String(maximum))}>全部</button></div></div>
      </form> : <p className="buyback-empty"><CheckCheck size={20}/>{data.available <= 0 ? '这笔买入已全部关联' : '暂无待买回委托，请先将对应卖出设为做 T。'}</p>}
      {!!data.associations.length && <section className="buyback-existing"><div className="buyback-section-title"><h3>已关联委托</h3><span>{data.associations.length} 笔</span></div>{data.associations.map(link => <div className="buyback-link" key={link.sell_id}>
        <Link2 size={16}/><div className="buyback-link-info"><strong>卖出 #{link.sell_id}<span>{money(link.quantity, 0)} 股/份</span></strong><small>{link.executed_at.replace('T', ' ')}</small></div>
        <span className={`buyback-link-status ${link.restored ? 'restored' : ''}`}>{link.restored ? '已恢复' : '待恢复'}</span>
        <div className="buyback-link-actions">{!link.restored && <button className="text-button" disabled={busy} onClick={() => void change(link.sell_id, 'restore')}>恢复原批次</button>}<button className="text-button" disabled={busy} onClick={() => void change(link.sell_id, 'unlink')}>解除关联</button></div>
      </div>)}</section>}
    </>}
    </div>
    <div className="buyback-footer"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>关闭</button>{canLink && <button type="submit" form="deal-buyback-form" className="button primary" disabled={busy || !valid}>{busy ? <LoaderCircle size={15} className="spin"/> : <Link2 size={15}/>}关联并恢复原批次</button>}</div>
  </Modal>;
}
