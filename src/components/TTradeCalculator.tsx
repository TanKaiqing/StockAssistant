import { useEffect, useState } from 'react';
import { ArrowDownUp, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { money, signed, type Instrument, type Market } from '../types';
import './TTradeCalculator.css';
import { TBuybackPlans } from './TBuybackPlans';

type Estimate = {sell_gross: string; buy_gross: string; sell_commission: string; buy_commission: string;
  sell_fee: string; buy_fee: string; total_fee: string; sell_proceeds: string; buy_cost: string;
  gross_profit: string; net_profit: string; price_gap: string; break_even_buy_price: string | null;
  minimum_price_gap: string | null; commission_rule: {commission_rate: string; minimum_fee: string};
  scenarios: {buy_price: string; net_profit: string; selected: boolean}[]};
type Props = {instruments: Instrument[]; markets: Record<string, Market>; code?: string;
  onSelect: (code: string) => void; onRefresh: (code: string) => void; refreshing: boolean; feeRevision: number; demo: boolean;
  autoRefresh?: boolean; refreshSeconds?: number;
  onBuyback?: (code: string, quantity: number, price: string | null) => void; onLedgerChange?: () => Promise<void>};
function localDay() {const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;}

export function TTradeCalculator(props: Props) {
  const holdings = props.instruments.filter(item => item.quantity > 0);
  const instrument = holdings.find(item => item.code === props.code) ?? holdings[0];
  const [lotId, setLotId] = useState('');
  const [sell, setSell] = useState('');
  const [buy, setBuy] = useState('');
  const [quantity, setQuantity] = useState('100');
  const [sellExtra, setSellExtra] = useState('0');
  const [buyExtra, setBuyExtra] = useState('0');
  const [estimate, setEstimate] = useState<{key: string; data: Estimate} | null>(null);
  const [error, setError] = useState('');
  const [calculating, setCalculating] = useState(false);
  const [brokerBusy, setBrokerBusy] = useState(false);
  const [broker, setBroker] = useState<{code: string; available: number | null; message: string} | null>(null);
  const today = localDay();
  const quote = instrument ? props.markets[instrument.code]?.quote : null;
  const lots = instrument?.lots.filter(lot => lot.remaining > 0) ?? [];
  const referenceQuantity = lots.filter(lot => (!lotId || String(lot.id) === lotId)
    && (instrument?.kind !== 'stock' || lot.executed_at.slice(0, 10) < today))
    .reduce((sum, lot) => sum + Math.max(0, lot.remaining - (instrument?.kind === 'stock' ? (lot.t_restore_history ?? []).filter(item => item.executed_at.slice(0, 10) >= localDay()).reduce((n, item) => n + item.quantity, 0) : 0) - (lot.sell_order?.unconfirmed_quantity ?? 0)), 0);
  const selectedLot = lots.find(lot => String(lot.id) === lotId);
  const currentBroker = broker?.code === instrument?.code ? broker : null;
  useEffect(() => {
    if (instrument && instrument.code !== props.code) props.onSelect(instrument.code);
  }, [instrument?.code, props.code, props.onSelect]);
  useEffect(() => {
    setLotId(''); setBuy(''); setSell(quote?.price.toFixed(3) ?? '');
    const available = instrument?.lots.filter(lot => lot.remaining > 0 && (instrument.kind !== 'stock' || lot.executed_at.slice(0, 10) < localDay()))
      .reduce((sum, lot) => sum + Math.max(0, lot.remaining - (instrument?.kind === 'stock' ? (lot.t_restore_history ?? []).filter(item => item.executed_at.slice(0, 10) >= localDay()).reduce((n, item) => n + item.quantity, 0) : 0) - (lot.sell_order?.unconfirmed_quantity ?? 0)), 0) ?? 0;
    setQuantity(String(Math.floor(available / 100) * 100 || 100));
    // New securities get a fresh plan; quote updates never overwrite user prices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument?.code]);
  const valid = !!instrument && Number.isFinite(Number(sell)) && Number(sell) > 0 && Number(sell) <= 1_000_000
    && Number.isFinite(Number(buy)) && Number(buy) > 0 && Number(buy) <= 1_000_000
    && Number.isInteger(Number(quantity)) && Number(quantity) > 0 && Number(quantity) <= 1_000_000_000 && Number(quantity) % 100 === 0
    && sellExtra.trim() !== '' && buyExtra.trim() !== '' && Number.isFinite(Number(sellExtra)) && Number(sellExtra) >= 0
    && Number.isFinite(Number(buyExtra)) && Number(buyExtra) >= 0;
  const payload = {kind: instrument?.kind, sell_price: sell, buy_price: buy, quantity: Number(quantity),
    sell_extra_fee: sellExtra, buy_extra_fee: buyExtra};
  const key = JSON.stringify({...payload, feeRevision: props.feeRevision});
  useEffect(() => {
    setError(''); setCalculating(false);
    if (!valid) return;
    const controller = new AbortController();
    setCalculating(true);
    const timer = setTimeout(() => {
      void api<Estimate>('/analysis/t-trade', {method: 'POST', signal: controller.signal, body: JSON.stringify(payload)})
        .then(data => {if (!controller.signal.aborted) setEstimate({key, data});})
        .catch(err => {if (!controller.signal.aborted) setError((err as Error).message);})
        .finally(() => {if (!controller.signal.aborted) setCalculating(false);});
    }, 300);
    return () => {clearTimeout(timer); controller.abort();};
    // key contains all input fields and the fee settings revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, valid]);
  const result = valid && estimate?.key === key && !error ? estimate.data : null;
  async function checkBroker() {
    if (!instrument || props.demo || brokerBusy) return;
    const code = instrument.code;
    setBrokerBusy(true); setBroker(null);
    try {
      const data = await api<{rows?: {code: string | null; available: string | null}[]; warnings?: string[]}>('/broker/positions');
      if (!Array.isArray(data.rows)) throw new Error('券商未返回完整持仓信息');
      const row = data.rows.find(item => item.code === code);
      const available = row ? row.available == null || row.available.trim() === '' ? null : Number(row.available) : 0;
      setBroker({code, available: available != null && Number.isFinite(available) && available >= 0 ? available : null,
        message: data.warnings?.join('；') ?? ''});
    } catch (err) {setBroker({code, available: null, message: (err as Error).message});}
    finally {setBrokerBusy(false);}
  }
  const oldQuote = !quote || Date.now() - new Date(quote.fetched_at).getTime() > 90000;
  return <div className="t-calculator">
    <div className="page-heading"><h1>做 T 测算</h1><span className="t-muted">先卖出，再等量买回</span></div>
    <TBuybackPlans instruments={props.instruments} markets={props.markets} demo={props.demo} onRefresh={props.onRefresh} autoRefresh={props.autoRefresh} refreshSeconds={props.refreshSeconds} onBuyback={props.onBuyback} onLedgerChange={props.onLedgerChange}/>
    {!instrument ? <section className="panel t-empty">暂无持仓，添加买入记录后即可选择证券测算。</section> : <div className="t-layout">
      <section className="panel t-input-panel"><form onSubmit={event => event.preventDefault()}>
        <div className="t-field"><label htmlFor="t-instrument">持仓证券</label><select id="t-instrument" value={instrument.code} onChange={event => props.onSelect(event.target.value)}>
          {holdings.map(item => <option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}
        </select></div>
        <div className="t-quote"><div><span>{oldQuote ? '上次报价' : '最新价'}</span><strong>{quote ? money(quote.price, 3) : '—'}</strong>
          <small>{quote ? `${quote.source ?? ''} · ${new Date(quote.fetched_at).toLocaleTimeString('zh-CN', {hour12: false})}` : '暂无行情'}</small></div>
          <button className="icon-button" type="button" aria-label="刷新测算行情" disabled={props.refreshing || props.demo} onClick={() => props.onRefresh(instrument.code)}><RefreshCw size={16} className={props.refreshing ? 'spin' : ''}/></button>
          <button className="button secondary" type="button" disabled={!quote} onClick={() => setSell(quote!.price.toFixed(3))}>填入卖出价</button></div>
        <div className="t-field"><label htmlFor="t-lot">关联买入批次</label><select id="t-lot" value={lotId} onChange={event => setLotId(event.target.value)}>
          <option value="">全部持仓批次</option>{lots.map(lot => <option key={lot.id} value={lot.id}
            disabled={instrument.kind === 'stock' && lot.executed_at.slice(0, 10) >= today}>
            #{lot.id} · {lot.executed_at.slice(0, 10)} · 剩余 {lot.remaining} · 成本 {Number(lot.unit_cost).toFixed(3)}
          </option>)}
        </select></div>
        <div className="t-availability"><span>账本参考数量 <strong>{money(referenceQuantity, 0)}</strong></span>
          <button className="text-button" type="button" disabled={props.demo || brokerBusy} onClick={() => void checkBroker()}>{brokerBusy ? '查询中…' : '核对券商可卖'}</button>
          {currentBroker && <span className="t-broker-available">券商可卖 <strong>{money(currentBroker.available, 0)}</strong> 股/份<small>查询时快照</small></span>}
          {currentBroker?.message && <small role="status">{currentBroker.message}</small>}
        </div>
        <div className="t-field-grid"><div className="t-field"><label htmlFor="t-sell">计划卖出价</label><input id="t-sell" type="number" min="0.001" max="1000000" step="0.001" placeholder="0.000" value={sell} onChange={event => setSell(event.target.value)}/></div>
          <div className="t-field"><label htmlFor="t-buy">计划买回价</label><input id="t-buy" type="number" min="0.001" max="1000000" step="0.001" placeholder="输入买回价" value={buy} onChange={event => setBuy(event.target.value)}/></div></div>
        <div className="t-field"><label htmlFor="t-quantity">等量卖出 / 买回数量</label><input id="t-quantity" type="number" min="100" max="1000000000" step="100" value={quantity} onChange={event => setQuantity(event.target.value)}/>
          {quantity && (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0 || Number(quantity) % 100 !== 0) && <small className="t-warning">请填写正整数，且为 100 的倍数。</small>}
          {Number(quantity) > referenceQuantity && <small className="t-warning">超过账本参考数量，需核对批次及券商实际可卖数量。</small>}
          {currentBroker?.available != null && Number(quantity) > currentBroker.available && <small className="t-warning">超过本次查询到的券商可卖数量。</small>}
        </div>
        <div className="t-field-grid"><div className="t-field"><label htmlFor="t-sell-extra">卖出额外费用（元）</label><input id="t-sell-extra" type="number" min="0" max="1000000000" step="0.01" value={sellExtra} onChange={event => setSellExtra(event.target.value)}/></div>
          <div className="t-field"><label htmlFor="t-buy-extra">买回额外费用（元）</label><input id="t-buy-extra" type="number" min="0" max="1000000000" step="0.01" value={buyExtra} onChange={event => setBuyExtra(event.target.value)}/></div></div>
        <p className="t-note">佣金使用系统设置。印花税、过户费及滑点预算请计入额外费用；默认 0 元表示未计入。测算按每边一笔成交计算。</p>
        <p className="t-note">账本参考数量已扣除已关联的待确认卖出数量；股票排除当日买入批次，ETF 是否可当日卖出以具体品种及券商为准。</p>
      </form></section>
      <div className="t-results" aria-busy={calculating}>
        {error && <div className="t-error" role="alert">{error}</div>}
        {!result ? <section className="panel t-empty"><ArrowDownUp size={28}/><strong>{calculating ? '正在测算…' : '填写交易计划'}</strong><span>输入卖出价、买回价和数量，查看扣费后的价差收益。</span></section> : <>
          <section className={`panel t-profit ${Number(result.net_profit) > 0 ? 'gain' : Number(result.net_profit) < 0 ? 'loss' : ''}`}>
            <span>预计做 T 净收益</span><strong className={Number(result.net_profit) >= 0 ? 'positive' : 'negative'}>¥ {signed(result.net_profit)}</strong>
            <p>价差收益 {signed(result.gross_profit)} − 双边费用 {money(result.total_fee)}</p>
            <small>{Number(result.net_profit) > 0 ? '按计划价格成交后，可覆盖已计入费用' : Number(result.net_profit) < 0 ? '当前价差不足以覆盖已计入费用' : '当前计划刚好覆盖已计入费用'}</small>
          </section>
          <section className="panel t-break-even"><div><span>保本买回价上限</span><strong>{result.break_even_buy_price ?? '无可行价格'}</strong></div>
            <div><span>至少需要的价差</span><strong>{result.minimum_price_gap ?? '—'}</strong></div>
            <p>已按 0.001 向下取可保本价格，包含最低佣金与额外费用。</p></section>
          <section className="panel t-costs"><h3>资金与费用</h3><dl>
            <div><dt>卖出成交金额</dt><dd>¥ {money(result.sell_gross)}</dd></div>
            <div><dt>卖出费用 <small>佣金 {money(result.sell_commission)} + 额外 {money(sellExtra)}</small></dt><dd>− {money(result.sell_fee)}</dd></div>
            <div className="t-subtotal"><dt>卖出到手</dt><dd>¥ {money(result.sell_proceeds)}</dd></div>
            <div><dt>买回成交金额</dt><dd>¥ {money(result.buy_gross)}</dd></div>
            <div><dt>买回费用 <small>佣金 {money(result.buy_commission)} + 额外 {money(buyExtra)}</small></dt><dd>+ {money(result.buy_fee)}</dd></div>
            <div className="t-subtotal"><dt>买回支出</dt><dd>¥ {money(result.buy_cost)}</dd></div>
          </dl><p className="t-note">{instrument.kind === 'etf' ? 'ETF' : '股票'}佣金万 {result.commission_rule.commission_rate} · 每笔最低 {money(result.commission_rule.minimum_fee)} 元</p></section>
          <section className="panel t-scenarios"><h3>买回价格变化</h3><table><thead><tr><th>买回价</th><th>预计净收益</th></tr></thead><tbody>{result.scenarios.map(row => <tr key={row.buy_price} className={row.selected ? 'selected' : ''}><td>{row.buy_price}{row.selected && <small>当前计划</small>}</td><td className={Number(row.net_profit) >= 0 ? 'positive' : 'negative'}>¥ {signed(row.net_profit)}</td></tr>)}</tbody></table></section>
        </>}
        <p className="t-note">{selectedLot ? `已关联买入批次 #${selectedLot.id}。` : ''}历史买入成本不影响本次价差收益；本页仅测算，不提交委托、不写入账本。</p>
      </div>
    </div>}
  </div>;
}
