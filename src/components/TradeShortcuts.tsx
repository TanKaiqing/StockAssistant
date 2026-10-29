import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Minus, Plus, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { money, type Instrument, type Quote } from '../types';

interface Props {
  instrument: Instrument; side: 'buy' | 'sell'; price: string; quantity: string;
  fee: string; manualFee: boolean; executedAt: string; editingId?: number; buyLotId: string;
  quote?: Quote | null; refreshing: boolean; onRefresh: () => void;
  onPrice: (price: string) => void; onQuantity: (quantity: string) => void;
  brokerAvailable?: boolean;
}

export function TradeShortcuts(props: Props) {
  const broker = !!props.brokerAvailable && props.side === 'buy';
  const sourceRef = useRef(broker); sourceRef.current = broker;
  const [available, setAvailable] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = useRef(props);
  current.current = props;
  const inflight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  useEffect(() => {
    setAvailable(null);
  }, [props.side, props.instrument.code, props.price, broker]);
  const book = props.side === 'buy' ? props.quote?.bids : props.quote?.asks;
  const digits = 3;
  const bookTime = book?.some(level => level.price != null && level.price > 0)
    ? props.quote?.book_fetched_at ?? props.quote?.fetched_at : undefined;
  const stale = !!bookTime && Date.now() - new Date(bookTime).getTime() > 90000;
  function adjust(amount: number) {
    const base = Math.floor((Number(props.quantity) || 0) / 100) * 100;
    props.onQuantity(String(Math.max(100, Math.min(1_000_000_000, base + amount))));
  }
  async function size(fraction: string) {
    if (inflight.current || (!broker && props.side === 'buy')) return;
    inflight.current = true; setBusy(true); setError('');
    const snapshot = props;
    try {
      const result = await api<{quantity: number; available?: number}>(broker ? '/broker/trade/size' : '/trades/size', {
        method: 'POST', body: JSON.stringify(broker ? {
          code: props.instrument.code, side: props.side, price: props.price, portion: Number(fraction),
        } : {
          code: props.instrument.code, side: props.side, price: props.price, portion: Number(fraction),
          manual_fee: props.manualFee ? props.fee : null, executed_at: props.executedAt,
          exclude_trade_id: props.editingId ?? null, buy_lot_id: props.buyLotId ? Number(props.buyLotId) : null,
        }),
      });
      const latest = current.current;
      if (!mounted.current || sourceRef.current !== broker || latest.instrument.code !== snapshot.instrument.code || latest.side !== snapshot.side || latest.price !== snapshot.price || latest.executedAt !== snapshot.executedAt ||
          latest.buyLotId !== snapshot.buyLotId || latest.quantity !== snapshot.quantity || latest.manualFee !== snapshot.manualFee ||
          (latest.manualFee && latest.fee !== snapshot.fee)) return;
      if (broker) setAvailable(result.available ?? null);
      if (result.quantity <= 0) {
        setError(broker ? '当前券商账户没有足够的可交易数量。' : props.side === 'buy' ? '这部分资金不足以买入 100 股/份（含佣金）。' : '该交易时间或指定批次下，没有可按此比例卖出的整百数量。');
      } else props.onQuantity(String(result.quantity));
    } catch (err) {if (mounted.current) setError((err as Error).message);}
    finally {inflight.current = false; if (mounted.current) setBusy(false);}
  }
  async function useTargetPrice() {
    if (inflight.current || !props.buyLotId || !Number.isInteger(Number(props.quantity)) || Number(props.quantity) <= 0) return;
    const snapshot = props;
    inflight.current = true; setBusy(true); setError('');
    try {
      const result = await api<{price: string}>('/trades/target-price', {method: 'POST', body: JSON.stringify({
        code: props.instrument.code, buy_lot_id: Number(props.buyLotId), quantity: Number(props.quantity),
        executed_at: props.executedAt, editing_id: props.editingId ?? null,
        manual_fee: props.manualFee ? props.fee : null,
      })});
      const latest = current.current;
      if (mounted.current && latest.side === 'sell' && latest.instrument.code === snapshot.instrument.code
        && latest.buyLotId === snapshot.buyLotId && latest.quantity === snapshot.quantity && latest.executedAt === snapshot.executedAt
        && latest.editingId === snapshot.editingId && latest.price === snapshot.price
        && latest.manualFee === snapshot.manualFee && (!latest.manualFee || latest.fee === snapshot.fee)) props.onPrice(result.price);
    } catch (err) {if (mounted.current) setError((err as Error).message);}
    finally {inflight.current = false; if (mounted.current) {setBusy(false);}}
  }
  return <section className="trade-shortcuts">
    <div className="shortcut-heading"><span>盘口快捷价</span><time className="shortcut-quote-time" dateTime={bookTime}
      title={props.quote ? `${props.quote.book_source ?? props.quote.source ?? ''}${stale ? ' · 上次快照' : ''}` : undefined}>
      {bookTime ? `获取于 ${new Date(bookTime).toLocaleTimeString('zh-CN', {hour12: false})}` : '暂无盘口'}
    </time><button className="text-button" type="button" disabled={props.refreshing} onClick={props.onRefresh}><RefreshCw size={12} className={props.refreshing ? 'spin' : ''}/>刷新</button></div>
    <div className="price-shortcuts">{Array.from({length: 5}, (_, i) => {
      const price = book?.[i]?.price;
      const valid = price != null && price > 0;
      const value = valid ? price.toFixed(digits) : '';
      return <button type="button" key={i} className={Number(props.price) === price && valid ? 'selected' : ''}
        disabled={!valid} onClick={() => props.onPrice(value)}>
        <span>{props.side === 'buy' ? '买' : '卖'}{i + 1}</span><strong>{valid ? money(price, digits) : '—'}</strong>
      </button>;
    })}</div>
    {props.side === 'sell' && <div className="target-price-shortcut"><button type="button" className="button secondary" disabled={busy || !props.buyLotId || !props.executedAt || !Number.isInteger(Number(props.quantity)) || Number(props.quantity) <= 0} onClick={() => void useTargetPrice()}>使用达标价卖出</button></div>}
    {props.side === 'buy' && <><div className="shortcut-heading quantity-heading"><span>快捷数量</span><span className="shortcut-caption">整百递增 · 股 / 份</span></div>
    <div className="quantity-shortcuts"><button type="button" onClick={() => adjust(-100)} aria-label="数量减少100"><Minus size={12}/>100</button>{[100, 500, 1000].map(value => <button key={value} type="button" onClick={() => props.onQuantity(String(value))}>{value}</button>)}<button type="button" onClick={() => adjust(100)} aria-label="数量增加100"><Plus size={12}/>100</button></div>
    {broker && <div className="shortcut-cash"><span>券商可买数量</span><strong>{available === null ? '—' : money(available, 0)}</strong></div>}
    {broker && <><div className="position-shortcuts">{[['全仓', '1'], ['1/2仓', '2'], ['1/3仓', '3'], ['1/4仓', '4']].map(([label, fraction]) => <button type="button" key={fraction}
      disabled={busy || !(Number(props.price) > 0) || (!broker && !props.executedAt)}
      onClick={() => void size(fraction)}>{label}</button>)}{busy && <LoaderCircle size={14} className="spin"/>}</div>
    <small className="field-hint">点击仓位按钮查询当前账户可买数量，数量向下取整到100股/份。</small></>}</>}
    {error && <div className="form-error" role="alert">{error}</div>}
  </section>;
}
