import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Lot } from '../types';

export function LotRiskSettings({lot, disabled, onSaved}: {
  lot: Lot; disabled: boolean; onSaved?: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'percent' | 'amount'>('percent');
  const [profit, setProfit] = useState('');
  const [stop, setStop] = useState('');
  const [stopMode, setStopMode] = useState<'percent' | 'amount'>('percent');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  useEffect(() => {
    setMode(lot.target_profit_amount != null ? 'amount' : 'percent');
    setProfit(lot.target_profit_amount ?? lot.target_profit_percent ?? '');
    setStopMode(lot.stop_loss_amount != null ? 'amount' : 'percent');
    setStop(lot.stop_loss_amount ?? (lot.stop_loss_percent === null ? '' : lot.stop_loss_percent ?? '2'));
  }, [lot.id, lot.target_profit_amount, lot.target_profit_percent, lot.stop_loss_percent, lot.stop_loss_amount]);

  async function save() {
    if (disabled || inFlight.current) return;
    setError(''); setMessage('');
    const profitValue = profit.trim(), stopValue = stop.trim();
    if ((profitValue && (!Number.isFinite(Number(profitValue)) || Number(profitValue) < 0))
        || (stopValue && (!Number.isFinite(Number(stopValue)) || Number(stopValue) <= 0
          || (stopMode === 'percent' && Number(stopValue) > 100)))) {
      setError(stopMode === 'amount' ? '止盈目标须为非负数，亏损金额须大于 0，最多保留两位小数。' : '止盈目标须为非负数，止损比例须大于 0 且不超过 100%。');
      return;
    }
    inFlight.current = true; setBusy(true);
    try {
      await api(`/trades/${lot.id}/targets`, {method: 'PATCH', body: JSON.stringify({
        target_profit_percent: mode === 'percent' && profitValue !== '' ? profitValue : null,
        target_profit_amount: mode === 'amount' && profitValue !== '' ? profitValue : null,
        stop_loss_percent: stopMode === 'percent' && stopValue !== '' ? stopValue : null,
        stop_loss_amount: stopMode === 'amount' && stopValue !== '' ? stopValue : null,
      })});
      setMessage('已保存止盈止损参数');
      await onSaved?.();
    } catch (err) {setError((err as Error).message);}
    finally {inFlight.current = false; setBusy(false);}
  }
  const change = () => {setMessage(''); setError('');};
  return <div className="lot-risk-settings">
    <div className="lot-risk-heading">止盈止损<span>批次 #{lot.id}</span></div>
    <div className="lot-risk-grid"><div className="lot-risk-field"><label htmlFor={`lot-risk-profit-${lot.id}`}>止盈目标</label>
    <div className="target-inputs"><select aria-label="批次止盈类型" disabled={disabled || busy} value={mode}
      onChange={event => {setMode(event.target.value as 'percent' | 'amount'); change();}}>
      <option value="percent">盈利率（%）</option><option value="amount">盈利金额（元）</option>
    </select><input id={`lot-risk-profit-${lot.id}`} type="number" min="0" step="0.01" placeholder="不设置"
      value={profit} disabled={disabled || busy} onChange={event => {setProfit(event.target.value); change();}}/></div></div>
    <div className="lot-risk-field"><label htmlFor={`lot-risk-stop-${lot.id}`}>止损目标</label>
    <div className="target-inputs"><select aria-label="批次止损类型" disabled={disabled || busy} value={stopMode}
      onChange={event => {setStopMode(event.target.value as 'percent' | 'amount'); setStop(''); change();}}>
      <option value="percent">亏损比例（%）</option><option value="amount">亏损金额（元）</option>
    </select><input id={`lot-risk-stop-${lot.id}`} type="number" min={stopMode === 'amount' ? '0.01' : '0.0001'}
      max={stopMode === 'amount' ? undefined : 100} step="0.01" placeholder="不设置"
      value={stop} disabled={disabled || busy} onChange={event => {setStop(event.target.value); change();}}/></div></div></div>
    <small className="field-hint">金额按原批次数量设置，部分卖出按比例折算；留空关闭。</small>
    <button type="button" className="button secondary" disabled={disabled || busy} onClick={() => void save()}>
      {busy ? '正在保存…' : '保存止盈止损'}
    </button>
    {message && <small role="status">{message}</small>}
    {error && <small className="form-error" role="alert">{error}</small>}
  </div>;
}
