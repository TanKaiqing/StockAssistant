import { useRef, useState } from 'react';
import { api } from '../api';
import { money } from '../types';
import { Modal } from './Modal';
import './BrokerPage.css';

type Row = {key: string; code: string; name: string; side: 'buy' | 'sell'; executed_at: string; price: string; quantity: number; fee: string; status: 'new' | 'duplicate' | 'conflict' | 'unsupported'};
type Plan = {ticket: string; rows: Row[]; new_count: number; duplicate_count: number; skipped_count: number; blocked: string[]};
function today() {const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;}

export function BrokerSyncDialog({onClose, onChanged}: {onClose: () => void; onChanged?: () => void}) {
  const [range, setRange] = useState({start_date: `${today().slice(0, 7)}-01`, end_date: today()});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [duplicates, setDuplicates] = useState(false);
  const inFlight = useRef(false);
  async function preview() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setDone(''); setPlan(null);
    try {setPlan(await api<Plan>('/broker/sync/preview', {method: 'POST', body: JSON.stringify(range)}));}
    catch (err) {setError((err as Error).message);}
    finally {inFlight.current = false; setBusy(false);}
  }
  async function apply() {
    if (!plan || plan.blocked.length || !plan.new_count || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const result = await api<{inserted: number; backup: string}>('/broker/sync/apply', {method: 'POST', body: JSON.stringify({ticket: plan.ticket, confirmed: true})});
      setDone(`已导入 ${result.inserted} 笔成交，已保存导入前备份。`);
    } catch (err) {setError(`${(err as Error).message}。请重新预览核对，勿重复写入。`);}
    finally {setPlan(null); inFlight.current = false; setBusy(false); onChanged?.();}
  }
  return <Modal open variant="trade" title="成交同步到账本" description="同花顺当前普通账户 · 历史成交及实际费用" onOpenChange={open => {if (!open && !inFlight.current) onClose();}}>
    <div className="broker-order-body">
      <form className="broker-date-form" onSubmit={e => {e.preventDefault(); void preview();}}>
        <label>开始日期<input type="date" aria-label="同步开始日期" required max={range.end_date} disabled={busy} value={range.start_date} onChange={e => {setPlan(null); setRange({...range, start_date: e.target.value});}}/></label>
        <label>结束日期<input type="date" aria-label="同步结束日期" required min={range.start_date} max={today()} disabled={busy} value={range.end_date} onChange={e => {setPlan(null); setRange({...range, end_date: e.target.value});}}/></label>
        <button className="button secondary" disabled={busy}>{busy ? '正在处理…' : '预览同步'}</button>
      </form>
      {error && <div role="alert" className="broker-error">{error}</div>}
      {done && <div role="status" className="broker-notice">{done}</div>}
      {plan && <>
        <div className="sync-summary">待导入 <strong>{plan.new_count}</strong> 笔 · 已有 <strong>{plan.duplicate_count}</strong> 笔{plan.skipped_count > 0 && ` · 非买卖业务跳过 ${plan.skipped_count} 笔`}</div>
        {plan.blocked.map(text => <div role="alert" className="broker-error" key={text}>{text}</div>)}
        <label className="broker-order-confirm"><input type="checkbox" checked={duplicates} onChange={e => setDuplicates(e.target.checked)}/>显示已存在记录</label>
        <div className="broker-table table-scroll sync-table"><table><thead><tr><th>成交时间 / 标的</th><th>方向</th><th className="numeric">成交价</th><th className="numeric">数量</th><th className="numeric">费用</th><th>同步状态</th></tr></thead><tbody>{plan.rows.filter(row => duplicates || row.status !== 'duplicate').map(row => <tr key={row.key}><td><strong>{row.name} · {row.code}</strong><small>{row.executed_at.replace('T', ' ')}</small></td><td className={row.side === 'buy' ? 'positive' : 'negative'}>{row.side === 'buy' ? '买入' : '卖出'}</td><td className="numeric">{money(row.price, 3)}</td><td className="numeric">{money(row.quantity, 0)}</td><td className="numeric">{money(row.fee)}</td><td>{{new: '待导入', duplicate: '已存在', conflict: '需核对', unsupported: '类型未支持'}[row.status]}</td></tr>)}</tbody></table></div>
        {!plan.new_count && !plan.blocked.length && <div role="status" className="broker-notice">没有新增成交。当天未结算记录可能尚未进入历史成交，请稍后再同步。</div>}
      </>}
      <small>只新增已核实的成交，不覆盖已有记录、批次及盈利目标。确认期间请勿切换同花顺账户。</small>
    </div>
    <div className="broker-order-footer"><button className="button secondary" disabled={busy} onClick={onClose}>关闭</button><button className="button primary" disabled={busy || !plan?.new_count || !!plan?.blocked.length} onClick={() => void apply()}>确认导入{plan?.new_count ? ` ${plan.new_count} 笔` : ''}</button></div>
  </Modal>;
}
