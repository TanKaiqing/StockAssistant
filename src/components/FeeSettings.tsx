import { useEffect, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, Percent } from 'lucide-react';
import { api } from '../api';

type Rule = { commission_rate: string; minimum_fee: string };
type Settings = { stock: Rule; etf: Rule };

export function FeeSettings({demo, onSaved}: {demo: boolean; onSaved: () => void}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void api<Settings>('/settings/fees').then(value => {if (active) setSettings(value);})
      .catch(err => {if (active) setError(err.message);});
    return () => {active = false;};
  }, [retry]);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api<Settings>('/settings/fees', {method: 'PUT', body: JSON.stringify(settings)});
      setSettings(result); onSaved();
    } catch (err) {setError((err as Error).message);}
    finally {setBusy(false);}
  }
  return <section className="fee-settings settings-card commission-settings">
    <div className="settings-card-heading"><span className="settings-card-icon"><Percent size={18}/></span><div><h3>手续费费率</h3><span>ETF 与股票分别设置</span></div></div>
    <p className="fee-description">佣金率以「万分之」填写，例如万 2.5 填 2.5。买入和卖出均按单笔成交金额计算。</p>
    {settings ? <form className="form" onSubmit={save}>
      {(['etf', 'stock'] as const).map(kind => {
        const label = kind === 'etf' ? 'ETF' : '股票';
        return <fieldset className="fee-group" key={kind} disabled={demo || busy}>
          <legend>{label}</legend>
          <div className="field-grid">
            <div className="field"><label htmlFor={`${kind}-rate`}>{label} 交易佣金（万分之）</label>
              <input id={`${kind}-rate`} type="number" min="0" max="10000" step="0.000001" required value={settings[kind].commission_rate}
                onChange={e => setSettings({...settings, [kind]: {...settings[kind], commission_rate: e.target.value}})}/></div>
            <div className="field"><label htmlFor={`${kind}-minimum`}>{label} 单笔最低手续费（元）</label>
              <input id={`${kind}-minimum`} type="number" min="0" step="0.01" required value={settings[kind].minimum_fee}
                onChange={e => setSettings({...settings, [kind]: {...settings[kind], minimum_fee: e.target.value}})}/></div>
          </div>
        </fieldset>;
      })}
      <p className="fee-description">单笔佣金 = 成交金额 × 佣金率与最低手续费中的较大值，四舍五入到分。仅估算佣金；印花税、过户费等可在交易总费用中手动补入。保存设置只影响新交易的估算，历史记录保持原费用。</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="button primary" disabled={busy || demo}>{busy ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}保存费率设置</button>
    </form> : error ? <div className="form-error" role="alert">{error} <button className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></div> : <p className="fee-description">正在读取费率设置…</p>}
  </section>;
}
