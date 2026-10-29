import { ArrowDownLeft, ArrowUpRight, Check, Layers3, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Modal } from './Modal';
import { TradeShortcuts } from './TradeShortcuts';
import { SellPreview } from './SellPreview';
import { money, priceDigits, type Instrument, type Quote, type Trade } from '../types';
import { BrokerOrderDialog, type OrderPreview, type OrderSeed } from './BrokerOrderDialog';
import { api } from '../api';
import { LotRiskSettings } from './LotRiskSettings';
import './TradeDialog.css';

export interface TradeForm {
  t_trade?: boolean;
  t_buyback_price?: string;
  stop_loss_mode?: 'percent' | 'amount';
  stop_loss_amount?: string;
  stop_loss_percent?: string;
  side: 'buy' | 'sell'; executed_at: string; price: string; quantity: string;
  fee: string; note: string; buy_lot_id: string; target_mode: 'percent' | 'amount'; target_value: string;
}
interface Props {
  open: boolean; onOpenChange: (open: boolean) => void; instrument?: Instrument;
  code: string; editing: Trade | null; form: TradeForm; onChange: (patch: Partial<TradeForm>) => void;
  onFeeChange: (fee: string) => void; onAutoFee: () => void;
  onSave: (event: FormEvent) => void; busy: boolean; error: string;
  manualFee: boolean; feeLoading: boolean; feeError: string; feeReady: boolean;
  amountValid: boolean; feeValid: boolean; previewValue: string;
  quote?: Quote | null; refreshing: boolean; onRefresh: () => void;
  allowRealTrading?: boolean; onBrokerOrders?: () => void;
  onIntentChanged?: () => void;
  onRiskSaved?: () => Promise<void>;
}

export function TradeDialog(props: Props) {
  const [prepared, setPrepared] = useState<{preview: OrderPreview; expiresAt: number; seed: OrderSeed} | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [orderError, setOrderError] = useState('');
  const preparing = useRef(false);
  useEffect(() => {if (!props.open) {setPrepared(null); setOrderError('');}}, [props.open]);
  const {form, instrument, editing} = props;
  const selectedLot = instrument?.lots.find(lot => String(lot.id) === form.buy_lot_id);
  const busy = props.busy || previewing;
  const canTrade = !editing && props.allowRealTrading && !!props.onBrokerOrders;
  const orderValid = /^\d{6}$/.test(props.code) && form.price.trim() !== '' && Number(form.price) > 0
    && Number(form.price) <= 100000 && Number.isInteger(Number(form.quantity)) && Number(form.quantity) > 0
    && Number(form.quantity) <= 100000000 && (form.side === 'sell' || Number(form.quantity) % 100 === 0);

  async function previewOrder() {
    if (!canTrade || !orderValid || props.busy || preparing.current) return;
    preparing.current = true; setPreviewing(true); setOrderError('');
    if (form.side === 'sell' && form.t_trade && !form.buy_lot_id) {setOrderError('做 T 真实卖出请先选择买入批次'); preparing.current = false; setPreviewing(false); return;}
    const seed = {buy_lot_id: form.side === 'sell' && form.buy_lot_id ? Number(form.buy_lot_id) : null, code: props.code, name: instrument?.name, side: form.side, price: form.price, quantity: form.quantity,
      t_trade: form.side === 'sell' && !!form.t_trade, t_buyback_price: form.side === 'sell' && form.t_trade && form.t_buyback_price ? form.t_buyback_price : null};
    try {
      const preview = await api<OrderPreview>('/broker/trade/preview', {method: 'POST', body: JSON.stringify({
        code: seed.code, side: seed.side, price: seed.price, quantity: Number(seed.quantity), buy_lot_id: seed.buy_lot_id,
        t_trade: seed.t_trade, t_buyback_price: seed.t_buyback_price,
      })});
      setPrepared({preview, expiresAt: Date.now() + preview.expires_in * 1000, seed});
    } catch (err) {setOrderError((err as Error).message);}
    finally {preparing.current = false; setPreviewing(false);}
  }

  if (props.open && prepared && canTrade) return <BrokerOrderDialog seed={prepared.seed}
    onIntentChanged={props.onIntentChanged}
    prepared={prepared} onEdit={message => {setPrepared(null); setOrderError(message ?? '');}}
    onClose={() => props.onOpenChange(false)} onOrders={props.onBrokerOrders!}/>;
  const buy = form.side === 'buy';
  const title = editing ? `编辑${buy ? '买入' : '卖出'}记录` : `记录${buy ? '买入' : '卖出'}`;
  return <Modal open={props.open} onOpenChange={open => {if (!props.busy && !preparing.current) props.onOpenChange(open);}} title={title}
    description={buy ? '填写成交信息，保存后更新持仓、批次成本与盈亏。' : '填写成交信息，核对本次卖出盈亏。'} variant="trade" className={buy ? undefined : 'sell-trade-dialog'}>
    <form onSubmit={props.onSave} className={`trade-form ${buy ? 'buy-form' : 'sell-form'}`}>
      <fieldset className="trade-scroll-area" disabled={busy}>
        <div className="trade-context">
          <span className="trade-context-icon"><Layers3 size={21}/></span>
          <div className="trade-context-name"><strong>{instrument?.name ?? '交易标的'}</strong><span>{props.code} · {instrument?.kind === 'etf' ? 'ETF' : 'A 股'}</span></div>
          <div className="trade-context-stat"><span>最新价</span><strong>{money(props.quote?.price, 3)}</strong></div>
          <div className="trade-context-stat"><span>持仓数量</span><strong>{money(instrument?.quantity, 0)}<small> 股/份</small></strong></div>
          <div className="side-switch trade-direction" aria-label="买卖方向">
          <button type="button" className={buy ? 'active buy' : ''} onClick={() => props.onChange({side: 'buy', buy_lot_id: ''})}><ArrowDownLeft size={17}/>买入</button>
          <button type="button" className={!buy ? 'active sell' : ''} onClick={() => props.onChange({side: 'sell'})}><ArrowUpRight size={17}/>卖出</button>
          </div>
        </div>
        <div className="trade-layout">
          <section className="trade-main-fields trade-section">
            <div className="trade-section-heading"><span className="section-step">01</span><h3>成交信息</h3></div>
            <div className="field"><label htmlFor="trade-date">交易时间</label><input id="trade-date" type="datetime-local" step="1" required disabled={busy} value={form.executed_at} onChange={e => props.onChange({executed_at: e.target.value})}/></div>
            <div className="field-grid trade-key-fields">
              <div className="field"><label htmlFor="trade-price">成交价（元）</label><input id="trade-price" type="number" min="0.001" step="0.001" required disabled={busy} placeholder={instrument?.kind === 'etf' ? '例如 3.950' : '例如 10.500'} value={form.price} onChange={e => props.onChange({price: e.target.value})}
                onBlur={e => {const value = Number(e.target.value); if (e.target.value && Number.isFinite(value) && value > 0) props.onChange({price: value.toFixed(3)});}}/></div>
              <div className="field"><label htmlFor="trade-quantity">数量（股 / 份）</label><input id="trade-quantity" type="number" min={buy && !editing ? 100 : 1} max="1000000000" step={buy && !editing ? 100 : 1} required disabled={busy} placeholder="例如 1000" value={form.quantity} onChange={e => props.onChange({quantity: e.target.value})}/></div>
            </div>
            <div className="trade-field-divider"/>
            <div className="field"><label htmlFor="trade-fee">总费用（元）<span className="fee-mode-badge">{props.manualFee ? '手动填写' : '自动估算'}</span></label>
              <input id="trade-fee" type="number" min="0" step="0.00000001" required disabled={busy} value={form.fee} onChange={e => props.onFeeChange(e.target.value)}/>
              <div className="fee-mode"><small className="field-hint">{props.manualFee ? '保留你填写的费用合计' : props.feeLoading ? '正在按费率估算佣金…' : `按${instrument?.kind === 'etf' ? 'ETF' : '股票'}费率自动估算佣金`}</small>
                {props.manualFee && <button type="button" className="text-button" disabled={busy} onClick={props.onAutoFee}>按费率重新计算</button>}
              </div>
              <small className="field-hint">自动估算仅含佣金；印花税、过户费等请补入费用合计。</small>
              {props.feeError && !props.manualFee && <div className="form-error" role="alert">{props.feeError}；可手动填写费用。</div>}
            </div>
          </section>
          {!buy && <section className="trade-price-section trade-section">
            <div className="trade-section-heading"><h3>快捷价格</h3></div>
            {props.open && instrument && <TradeShortcuts brokerAvailable={!!canTrade} instrument={instrument} side={form.side} price={form.price} quantity={form.quantity} fee={form.fee} manualFee={props.manualFee} executedAt={form.executed_at} editingId={editing?.id} buyLotId={form.buy_lot_id} quote={props.quote} refreshing={props.refreshing} onRefresh={props.onRefresh} onPrice={price => props.onChange({price})} onQuantity={quantity => props.onChange({quantity})}/>}
          </section>}
          <aside className={`trade-shortcut-column ${buy ? '' : 'trade-batch-column'}`}>
            <div className="trade-section-heading"><span className="section-step">02</span><h3>{buy ? '快捷填写' : '买入批次与目标'}</h3></div>
            {buy && props.open && instrument && <TradeShortcuts brokerAvailable={!!canTrade} instrument={instrument} side={form.side} price={form.price} quantity={form.quantity} fee={form.fee} manualFee={props.manualFee} executedAt={form.executed_at} editingId={editing?.id} buyLotId={form.buy_lot_id} quote={props.quote} refreshing={props.refreshing} onRefresh={props.onRefresh} onPrice={price => props.onChange({price})} onQuantity={quantity => props.onChange({quantity})}/>}
            {buy ? <div className="field profit-target-field">
              <label htmlFor="trade-target">本次买入期望盈利<span>选填</span></label>
              <div className="target-inputs"><select aria-label="盈利目标类型" disabled={busy} value={form.target_mode} onChange={e => props.onChange({target_mode: e.target.value as 'percent' | 'amount'})}><option value="percent">盈利率（%）</option><option value="amount">盈利金额（元）</option></select>
                <input id="trade-target" type="number" min="0" max={form.target_mode === 'percent' ? 1000000 : undefined} step="0.01" disabled={busy} placeholder={form.target_mode === 'percent' ? '例如 3' : '例如 100'} value={form.target_value} onChange={e => props.onChange({target_value: e.target.value})}/>
              </div>
              <small className="field-hint">达标批次高亮置顶；留空不设目标。按含买入费用的成本并预扣卖出佣金判断。</small>
              <label htmlFor="trade-stop-loss">止损目标</label>
              <div className="target-inputs"><select aria-label="止损目标类型" disabled={busy} value={form.stop_loss_mode ?? 'percent'}
                onChange={event => props.onChange({stop_loss_mode: event.target.value as 'percent' | 'amount'})}>
                <option value="percent">亏损比例（%）</option><option value="amount">亏损金额（元）</option>
              </select><input id="trade-stop-loss" type="number" min={form.stop_loss_mode === 'amount' ? '0.01' : '0.0001'}
                max={form.stop_loss_mode === 'amount' ? undefined : 100} step="0.01" disabled={busy}
                placeholder={form.stop_loss_mode === 'amount' ? '例如 100' : '默认 2%'}
                value={form.stop_loss_mode === 'amount' ? form.stop_loss_amount ?? '' : form.stop_loss_percent ?? '2'}
                onChange={event => props.onChange(form.stop_loss_mode === 'amount' ? {stop_loss_amount: event.target.value} : {stop_loss_percent: event.target.value})}/></div>
              <small className="field-hint">按含费用的预计净亏损判断；金额按原买入数量设置，剩余持仓按比例折算。留空关闭。</small>
            </div> : <div className="field trade-lot-field">
              <label htmlFor="trade-lot">选择成本批次</label>
              <select id="trade-lot" disabled={busy} value={form.buy_lot_id} onChange={e => props.onChange({buy_lot_id: e.target.value})}><option value="">{editing?.lot_allocations?.length ? '保留多批次分摊' : '先进先出（默认）'}</option>{instrument?.lots.map(lot => <option key={lot.id} value={lot.id}>#{lot.id} · {lot.executed_at.slice(0, 10)} · 成本 {money(lot.unit_cost, priceDigits(instrument.kind))} · 剩余 {lot.remaining}</option>)}</select>
              <small className="field-hint">{editing?.lot_allocations?.length && !form.buy_lot_id
                ? `保留分摊：${editing.lot_allocations.map(item => `#${item.buy_id} × ${item.quantity}`).join('，')}。分摊总数量保持不变。`
                : '按填写的交易时间核算；选择批次后仅匹配该批次。'}</small>
              {selectedLot ? <>
                <div className="sell-lot-summary">
                  <span><small>批次成本 / 股份</small><strong>¥ {money(selectedLot.unit_cost, 3)}</strong></span>
                  <span><small>当前剩余数量</small><strong>{money(selectedLot.remaining, 0)}<em> 股/份</em></strong></span>
                </div>
                <LotRiskSettings key={selectedLot.id} lot={selectedLot} disabled={busy} onSaved={props.onRiskSaved}/>
              </> : <small className="field-hint">选择买入批次后可修改该批次的止盈止损。</small>}
            </div>}
          </aside>
          {!buy && <section className="trade-section t-sell-marker"><label className="trade-toggle-switch"><input type="checkbox" checked={!!form.t_trade} onChange={event => props.onChange({t_trade: event.target.checked})}/><span>做 T · 卖出后待买回</span></label>
            {form.t_trade && <div className="field"><label htmlFor="t-buyback-target">期望买回价（选填）</label><input id="t-buyback-target" type="number" min="0.001" max="1000000" step="0.001" value={form.t_buyback_price ?? ''} onChange={event => props.onChange({t_buyback_price: event.target.value})}/><small className="field-hint">保存成交后进入「做 T 测算」的待买回列表，可跨日关联买回记录。真实卖出需选择成本批次，成交同步后保留标记。</small></div>}
          </section>}
          {buy ? <section className="trade-note-section trade-section">
            <div className="field"><label htmlFor="trade-note">备注<span>选填</span></label><textarea id="trade-note" rows={2} maxLength={500} disabled={busy} placeholder="例如：首次建仓 / 分批加仓" value={form.note} onChange={e => props.onChange({note: e.target.value})}/></div>
          </section> : <details className="trade-note-section sell-note-section" open={form.note ? true : undefined}>
            <summary>备注<span>选填</span></summary>
            <div className="field"><textarea aria-label="卖出备注" rows={2} maxLength={500} disabled={busy} placeholder="补充本次卖出说明" value={form.note} onChange={e => props.onChange({note: e.target.value})}/></div>
          </details>}
        </div>
      </fieldset>
      <footer className="trade-dialog-footer">
        {(orderError || props.error) && <div className="form-error trade-submit-error" role="alert">{orderError || props.error}</div>}
        <div className="trade-footer-row">
          <div className="trade-summary">
            {!buy && props.open ? <SellPreview code={props.code} price={form.price} quantity={form.quantity} fee={form.fee} executedAt={form.executed_at} buyLotId={form.buy_lot_id} editingId={editing?.id} valid={props.amountValid && props.feeValid} ready={props.feeReady} feeError={!props.manualFee ? props.feeError : ''}/> : <div className="trade-preview"><span>本次买入总支出</span><strong>{props.previewValue}</strong></div>}
          </div>
          <div className={`form-actions ${canTrade ? 'dual-trade-actions' : ''}`}><button type="button" className="button secondary" disabled={busy} onClick={() => props.onOpenChange(false)}>取消</button><button type="submit" className="button secondary" disabled={busy}>{props.busy ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>}保存记录</button>{canTrade && <button type="button" className={`button primary real-order-action ${buy ? 'buy' : 'sell'}`} disabled={busy || !orderValid} onClick={() => void previewOrder()}>{previewing ? <LoaderCircle size={16} className="spin"/> : buy ? <ArrowDownLeft size={16}/> : <ArrowUpRight size={16}/>} {previewing ? '正在预览…' : buy ? '真实买入' : '真实卖出'}</button>}</div>
        </div>
      </footer>
    </form>
  </Modal>;
}
