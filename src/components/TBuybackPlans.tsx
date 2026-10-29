import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { ChevronDown } from 'lucide-react';
import './TBuybackPlans.css';
import { Modal } from './Modal';
import { isTradingSession } from '../tradingSession';
import { money, signed, type Instrument, type Market } from '../types';

type Plan = {sell_ids?: number[]; last_id?: number; id: number; code: string; name: string; executed_at: string; price: string; quantity: number;
  target_price: string | null; matched_quantity: number; remaining: number; net_profit: string;
  origins?: {buy_id: number; quantity: number; available: number; restored: number; price: string; executed_at: string}[];
  links: {all_restored?: boolean; buy_ids?: number[]; buy_id: number; quantity: number; executed_at: string; price: string; restore_allocations?: {buy_id: number; quantity: number}[]}[]};
type Buy = {buy_ids?: number[]; id: number; code: string; executed_at: string; price: string; available: number};
type SellOrder = {id: number; code: string; name: string; executed_at: string; quantity: number; fill_count: number; t_trade: boolean; has_links: boolean; target_price: string | null};
type Data = {plans: Plan[]; buy_records: Buy[]; sell_orders?: SellOrder[]};

export function TBuybackPlans(props: {instruments: Instrument[]; markets: Record<string, Market>; demo: boolean;
  onRefresh: (code: string) => void; autoRefresh?: boolean; refreshSeconds?: number;
  onBuyback?: (code: string, quantity: number, price: string | null) => void; onLedgerChange?: () => Promise<void>}) {
  const [data, setData] = useState<Data>({plans: [], buy_records: []});
  const [all, setAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingOrder, setSettingOrder] = useState('');
  const [settingPrice, setSettingPrice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [manualRestore, setManualRestore] = useState<Record<number, boolean>>({});
  const [restoreQuantities, setRestoreQuantities] = useState<Record<number, Record<number, string>>>({});
  const mutation = useRef(false);
  const refreshQuote = useRef(props.onRefresh); refreshQuote.current = props.onRefresh;
  const load = useCallback(async (signal?: AbortSignal) => {
    if (props.demo) return;
    setLoading(true);
    try {
      const result = await api<Data>('/t-trades', {signal});
      if (!signal?.aborted) {setData(result); setError('');}
    } catch (err) {if (!signal?.aborted) setError((err as Error).message);}
    finally {if (!signal?.aborted) setLoading(false);}
  }, [props.demo]);
  useEffect(() => {
    if (props.demo) {setData({plans: [], buy_records: []}); setError(''); setLoading(false); return;}
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, props.instruments]);
  const pendingCodes = [...new Set(data.plans.filter(plan => plan.remaining > 0).map(plan => plan.code))].sort().join(',');
  useEffect(() => {
    if (props.demo || !pendingCodes) return;
    function refresh() {if (!document.hidden) for (const code of pendingCodes.split(',')) refreshQuote.current(code);}
    refresh();
    const timer = window.setInterval(() => {if (props.autoRefresh && isTradingSession()) refresh();}, (props.refreshSeconds ?? 5) * 1000);
    return () => window.clearInterval(timer);
  }, [pendingCodes, props.demo, props.autoRefresh, props.refreshSeconds]);
  async function change(plan: Plan, buyId: number, quantity?: number, restoreOnly = false) {
    if (mutation.current || props.demo) return;
    mutation.current = true; setBusy(true); setError('');
    try {
      const allocations = manualRestore[plan.id] ? Object.entries(restoreQuantities[plan.id] ?? {})
        .filter(([, value]) => Number(value) > 0).map(([id, value]) => ({buy_id: Number(id), quantity: Number(value)})) : undefined;
      await api(`/t-trades/orders/${plan.id}/buybacks${restoreOnly ? `/${buyId}/restoration` : quantity == null ? `/${buyId}` : ''}`, {
        method: restoreOnly ? 'PUT' : quantity == null ? 'DELETE' : 'POST',
        ...(restoreOnly ? {body: '{}'} : quantity == null ? {} : {body: JSON.stringify({buy_id: buyId, quantity, allocations})}),
      });
      setSelected(current => ({...current, [plan.id]: ''}));
      await load();
      await props.onLedgerChange?.();
    } catch (err) {setError((err as Error).message);}
    finally {mutation.current = false; setBusy(false);}
  }
  async function saveOrder(enabled: boolean) {
    if (mutation.current || props.demo || !settingOrder) return;
    mutation.current = true; setBusy(true); setError('');
    try {
      await api(`/t-trades/orders/${settingOrder}/settings`, {method: 'PUT', body: JSON.stringify({t_trade: enabled, target_price: enabled && settingPrice ? settingPrice : null})});
      await load(); await props.onLedgerChange?.(); setSettingsOpen(false);
    } catch (err) {setError((err as Error).message);}
    finally {mutation.current = false; setBusy(false);}
  }
  const plans = data.plans.filter(plan => all || plan.remaining > 0);
  const pending = data.plans.filter(plan => plan.remaining > 0).length;
  return <section className="panel t-buybacks">
    <div className="t-buybacks-heading"><h3>做 T 委托<span className="soft-count">{pending}</span></h3><div>
      <button className="button secondary" disabled={busy || loading || props.demo || !data.sell_orders?.length} onClick={() => {setError(''); setSettingOrder(''); setSettingPrice(''); setSettingsOpen(true);}}>整单设置做 T</button>
      <label><input type="checkbox" checked={all} onChange={event => setAll(event.target.checked)}/>显示已完成</label>
      <button className="text-button" disabled={busy || loading || props.demo} onClick={() => {void load(); for (const code of pendingCodes.split(',').filter(Boolean)) props.onRefresh(code);}}>刷新</button>
    </div></div>
    {error && <div className="t-error" role="alert">{error}</div>}
    {!plans.length ? <p className="t-buyback-empty">{props.demo ? '示例模式不显示真实做 T 计划' : loading ? '正在读取…' : '点击“整单设置做 T”选择卖出委托，再一次关联买回委托。'}</p> : <div className="table-scroll t-orders-table"><table><thead><tr><th>成交时间</th><th>标的</th><th className="numeric">卖出均价</th><th className="numeric">卖出数量</th><th className="numeric">已买回</th><th className="numeric">待买回</th><th className="numeric">当前价</th><th className="numeric">期望买回价</th><th className="numeric">净价差</th><th>状态</th><th>操作</th></tr></thead><tbody>{plans.map(plan => {
      const quote = props.markets[plan.code]?.quote;
      const age = quote ? Date.now() - new Date(quote.fetched_at).getTime() : NaN;
      const fresh = Number.isFinite(age) && age >= -5000 && age <= (quote?.source?.includes('本地桥接') ? 12000 : 90000);
      const reached = fresh && quote && plan.target_price != null && quote.price <= Number(plan.target_price) && plan.remaining > 0;
      const candidates = data.buy_records.filter(buy => buy.code === plan.code
        && (buy.executed_at > plan.executed_at || buy.executed_at === plan.executed_at && buy.id > (plan.last_id ?? plan.id)));
      const chosen = candidates.find(buy => String(buy.id) === selected[plan.id]);
      const quantity = quantities[plan.id] ?? String(Math.min(plan.remaining, chosen?.available ?? plan.remaining));
      const origins = plan.origins ?? [];
      const restoreReady = !manualRestore[plan.id] || (origins.every(origin => {
        const value = Number(restoreQuantities[plan.id]?.[origin.buy_id] ?? 0);
        return Number.isInteger(value) && value >= 0 && value <= origin.available;
      }) && origins.reduce((sum, origin) => sum + Number(restoreQuantities[plan.id]?.[origin.buy_id] ?? 0), 0) === Number(quantity));
      const isExpanded = expanded.has(plan.id);
      return <Fragment key={plan.id}>
        <tr className={reached ? 't-order-reached' : ''}>
          <td title={`卖出成交 ${plan.sell_ids?.map(id => `#${id}`).join('、') ?? `#${plan.id}`}`}><strong>{plan.executed_at.slice(0, 10)}</strong><small>{plan.executed_at.slice(11)}</small></td>
          <td><strong>{plan.name}</strong><small>{plan.code} · {plan.sell_ids?.length ?? 1} 笔成交</small></td>
          <td className="numeric">{money(plan.price, 3)}</td><td className="numeric">{money(plan.quantity, 0)}</td>
          <td className="numeric">{money(plan.matched_quantity, 0)}</td><td className="numeric">{money(plan.remaining, 0)}</td>
          <td className="numeric">{money(quote?.price, 3)}{quote && !fresh && <small>上次报价</small>}</td>
          <td className="numeric">{money(plan.target_price, 3)}</td>
          <td className={`numeric ${plan.matched_quantity ? Number(plan.net_profit) >= 0 ? 'positive' : 'negative' : ''}`}>{plan.matched_quantity ? signed(plan.net_profit) : '—'}{plan.matched_quantity > 0 && plan.remaining > 0 && <small>已买回部分</small>}</td>
          <td><span className="t-buyback-status">{plan.remaining === 0 ? '已买回' : reached ? '达到期望买回价' : plan.matched_quantity ? '部分买回' : '待买回'}</span></td>
          <td><div className="t-order-actions">
            {plan.remaining > 0 && props.onBuyback && <button className="button secondary" disabled={busy || props.demo} onClick={() => props.onBuyback?.(plan.code, plan.remaining, quote ? quote.price.toFixed(3) : plan.target_price)}>买回</button>}
            <button className="text-button t-order-expand" aria-expanded={isExpanded} aria-controls={`t-order-details-${plan.id}`} onClick={() => setExpanded(current => {const next = new Set(current); if (next.has(plan.id)) next.delete(plan.id); else next.add(plan.id); return next;})}>关联管理<ChevronDown size={13} className={isExpanded ? 'expanded' : ''}/></button>
            <button className="text-button" disabled={busy || props.demo} onClick={() => {setError(''); setSettingOrder(String(plan.id)); setSettingPrice(plan.target_price ?? ''); setSettingsOpen(true);}}>设置</button>
          </div></td>
        </tr>
        {isExpanded && <tr className="t-order-details" id={`t-order-details-${plan.id}`}><td colSpan={11}><div className="t-order-management">
          {!!plan.links.length && <table className="t-order-links" aria-label={`${plan.name}已关联买回委托`}><thead><tr><th>买回成交</th><th>时间</th><th className="numeric">均价</th><th className="numeric">数量</th><th>原批次</th><th>操作</th></tr></thead><tbody>
            {plan.links.map(link => <tr key={link.buy_id}><td>#{link.buy_id}{(link.buy_ids?.length ?? 0) > 1 && <small>{link.buy_ids!.length} 笔成交</small>}</td><td>{link.executed_at.replace('T', ' ')}</td><td className="numeric">{money(link.price, 3)}</td><td className="numeric">{money(link.quantity, 0)}</td>
              <td>{(link.all_restored ?? !!link.restore_allocations?.length) ? <span>已恢复 {(link.restore_allocations ?? []).map(item => `#${item.buy_id} × ${item.quantity}`).join('，')}</span> : '未全部恢复'}</td>
              <td><div className="t-order-actions">{!(link.all_restored ?? !!link.restore_allocations?.length) && <button className="text-button" disabled={busy} onClick={() => void change(plan, link.buy_id, undefined, true)}>恢复原批次</button>}<button className="text-button" disabled={busy} onClick={() => void change(plan, link.buy_id)}>解除关联</button></div></td></tr>)}
          </tbody></table>}
        {plan.remaining > 0 && <div className="t-buyback-associate"><select aria-label={`卖出${plan.id}关联买回记录`} value={selected[plan.id] ?? ''} disabled={busy} onChange={event => {
          const buy = candidates.find(item => String(item.id) === event.target.value);
          setSelected(current => ({...current, [plan.id]: event.target.value}));
          setManualRestore(current => ({...current, [plan.id]: false}));
          setQuantities(current => ({...current, [plan.id]: String(Math.min(plan.remaining, buy?.available ?? plan.remaining))}));
        }}><option value="">{candidates.length ? '选择买回委托' : '同步买入成交后可整单关联'}</option>{candidates.map(buy => <option key={buy.id} value={buy.id}>#{buy.id}{(buy.buy_ids?.length ?? 0) > 1 ? ` · ${buy.buy_ids!.length} 笔成交` : ''} · {buy.executed_at.replace('T', ' ')} · {Number(buy.price).toFixed(3)} · 可关联 {buy.available}</option>)}</select>
          {chosen && <><input aria-label={`卖出${plan.id}的买回关联数量`} type="number" min="1" max={Math.min(plan.remaining, chosen.available)} step="1" value={quantity} onChange={event => setQuantities(current => ({...current, [plan.id]: event.target.value}))}/>
            <button className="button secondary" disabled={busy || !restoreReady || !Number.isInteger(Number(quantity)) || Number(quantity) <= 0 || Number(quantity) > Math.min(plan.remaining, chosen.available)} onClick={() => void change(plan, chosen.id, Number(quantity))}>整单关联并恢复</button>
            <div className="t-restore-selection"><select aria-label={`卖出${plan.id}恢复原批次方式`} disabled={busy} value={manualRestore[plan.id] ? 'manual' : 'auto'} onChange={event => {
              const manual = event.target.value === 'manual';
              setManualRestore(current => ({...current, [plan.id]: manual}));
              if (manual) {
                let left = Number(quantity) || 0;
                const selected: Record<number, string> = {};
                for (const origin of origins) {const count = Math.min(left, Math.max(0, origin.available)); selected[origin.buy_id] = String(count); left -= count;}
                setRestoreQuantities(current => ({...current, [plan.id]: selected}));
              }
            }}><option value="auto">按原卖出分摊顺序恢复</option><option value="manual">手动选择原批次</option></select>
              {manualRestore[plan.id] && origins.map(origin => <label key={origin.buy_id}>原批次 #{origin.buy_id} · 买入价 {Number(origin.price).toFixed(3)} · 可恢复 {origin.available}
                <input aria-label={`恢复原批次${origin.buy_id}的数量`} type="number" min="0" max={origin.available} step="1" disabled={busy} value={restoreQuantities[plan.id]?.[origin.buy_id] ?? '0'} onChange={event => setRestoreQuantities(current => ({...current, [plan.id]: {...current[plan.id], [origin.buy_id]: event.target.value}}))}/></label>)}
              {manualRestore[plan.id] && !restoreReady && <small className="t-warning">各批次恢复数量合计须等于本次关联数量。</small>}
            </div></>}
        </div>}
        </div></td></tr>}
      </Fragment>;
    })}</tbody></table></div>}
    <Modal open={settingsOpen} onOpenChange={value => {if (!busy) setSettingsOpen(value);}} title="整单设置做 T" description="同一委托的分笔成交一起设置。">
      <form className="form" onSubmit={event => {event.preventDefault(); void saveOrder(true);}}>
        <div className="field"><label htmlFor="t-sell-order">卖出委托</label><select id="t-sell-order" required disabled={busy} value={settingOrder} onChange={event => {setSettingOrder(event.target.value); setSettingPrice(data.sell_orders?.find(order => String(order.id) === event.target.value)?.target_price ?? '');}}>
          <option value="">选择卖出委托</option>{data.sell_orders?.map(order => <option key={order.id} value={order.id}>{order.name} · {order.executed_at.replace('T', ' ')} · {money(order.quantity, 0)} 股/份 · {order.fill_count} 笔{order.t_trade ? ' · 已设做T' : ''}</option>)}
        </select></div>
        <div className="field"><label htmlFor="t-order-price">期望买回价 <span>选填</span></label><input id="t-order-price" type="number" min="0.001" max="1000000" step="0.001" disabled={busy} value={settingPrice} onChange={event => setSettingPrice(event.target.value)} placeholder="0.000"/></div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="form-actions">{data.sell_orders?.find(order => String(order.id) === settingOrder)?.t_trade && <button type="button" className="text-button" disabled={busy || data.sell_orders.find(order => String(order.id) === settingOrder)?.has_links} onClick={() => void saveOrder(false)}>取消做 T</button>}<button type="button" className="button secondary" disabled={busy} onClick={() => setSettingsOpen(false)}>关闭</button><button className="button primary" type="submit" disabled={busy || !settingOrder}>保存整单设置</button></div>
      </form>
    </Modal>
    <p className="t-note t-buyback-footnote">支持跨日、分批买回。关联后按实际买回日期确认做 T 净价差，包含双边已记录费用。</p>
  </section>;
}
