import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api';
import type { StopLossDefaults } from '../types';

export function StopLossSettings({demo, onSaved}: {demo: boolean; onSaved: () => void}) {
  const [mode, setMode] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    setReady(false); setError('');
    void api<StopLossDefaults>('/settings/stop-loss').then(settings => {
      if (!active) return;
      setMode(settings.stop_loss_amount != null ? 'amount' : 'percent');
      setValue(settings.stop_loss_amount ?? settings.stop_loss_percent ?? '');
      setReady(true);
    }).catch(err => {if (active) setError(err.message);});
    return () => {active = false;};
  }, [retry]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (demo || !ready || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    const amount = value.trim();
    try {
      await api('/settings/stop-loss', {method: 'PUT', body: JSON.stringify({
        stop_loss_percent: mode === 'percent' && amount !== '' ? amount : null,
        stop_loss_amount: mode === 'amount' && amount !== '' ? amount : null,
      })});
      onSaved();
    } catch (err) {setError((err as Error).message);}
    finally {inFlight.current = false; setBusy(false);}
  }
  return <section className="settings-card default-stop-loss">
    <div className="settings-card-heading"><span className="settings-card-icon"><ShieldCheck size={18}/></span><div><h3>默认止损</h3><span>新买入批次的初始止损目标</span></div></div>
    {ready ? <form className="form" onSubmit={event => void save(event)}>
      <fieldset className="fee-group" disabled={demo || busy}>
        <div className="field"><label htmlFor="default-stop-loss-value">止损目标</label>
          <div className="target-inputs"><select aria-label="默认止损类型" value={mode}
            onChange={event => {setMode(event.target.value as 'percent' | 'amount'); setValue(''); setError('');}}>
            <option value="percent">亏损比例（%）</option><option value="amount">亏损金额（元）</option>
          </select><input id="default-stop-loss-value" type="number" min="0.01" max={mode === 'percent' ? 100 : undefined}
            step="0.01" placeholder="留空不设止损" value={value} onChange={event => {setValue(event.target.value); setError('');}}/></div>
        </div>
      </fieldset>
      <p className="fee-description">用于新建及同步买入，已有批次保留原目标。留空保存可关闭默认止损；单个批次仍可调整。</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="button primary" disabled={demo || busy}>{busy ? '正在保存…' : '保存默认止损'}</button>
    </form> : error ? <div className="form-error" role="alert">{error} <button className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></div>
      : <p className="fee-description">正在读取默认止损…</p>}
  </section>;
}
