import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, ClipboardList, LoaderCircle, Pencil, Plus, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { localNow, money, type Instrument } from '../types';
import { InstrumentFields, type InstrumentForm } from './InstrumentFields';
import { Modal } from './Modal';
import './TradePlansPage.css';

type Status = 'pending' | 'completed' | 'cancelled';
type Plan = InstrumentForm & {id: number; side: 'buy' | 'sell'; price: string; quantity: number;
  plan_date: string | null; note: string; status: Status; revision: number};
type Form = InstrumentForm & {side: 'buy' | 'sell'; price: string; quantity: string; plan_date: string; note: string};
const statuses: Record<Status, string> = {pending: '待执行', completed: '已完成', cancelled: '已取消'};

export function TradePlansPage({instruments, code, demo}: {instruments: Instrument[]; code?: string; demo: boolean}) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const [filter, setFilter] = useState<Status | 'all'>('pending');
  const [side, setSide] = useState<'all' | 'buy' | 'sell'>('all');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [deleting, setDeleting] = useState<Plan | null>(null);
  const [form, setForm] = useState<Form>({code: '', name: '', kind: 'stock', side: 'buy', price: '', quantity: '100', plan_date: '', note: ''});
  const load = useCallback(async (signal?: AbortSignal) => {
    if (demo) {setPlans([]); return;}
    setLoading(true); setError('');
    try {
      const result = await api<{plans: Plan[]}>('/trade-plans', {signal});
      if (!signal?.aborted) setPlans(result.plans);
    } catch (err) {if (!signal?.aborted) setError((err as Error).message);}
    finally {if (!signal?.aborted) setLoading(false);}
  }, [demo]);
  useEffect(() => {
    const controller = new AbortController();
    setOpen(false); setDeleting(null); setError('');
    if (demo) {setPlans([]); setLoading(false);} else void load(controller.signal);
    return () => controller.abort();
  }, [load, demo]);
  function begin(plan?: Plan) {
    if (busy || loading || demo) return;
    const owner = instruments.find(item => item.code === code);
    setEditing(plan ?? null); setFormError('');
    setForm(plan ? {...plan, quantity: String(plan.quantity), plan_date: plan.plan_date ?? ''} : {
      code: owner?.code ?? '', name: owner?.name ?? '', kind: owner?.kind ?? 'stock',
      side: 'buy', price: '', quantity: '100', plan_date: '', note: '',
    });
    setOpen(true);
  }
  async function mutate(action: () => Promise<void>, inForm = false) {
    if (mutation.current || demo) return;
    mutation.current = true; setBusy(true); setError(''); setFormError('');
    try {await action();}
    catch (err) {(inForm ? setFormError : setError)((err as Error).message);}
    finally {mutation.current = false; setBusy(false);}
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void mutate(async () => {
      const payload = {code: form.code, name: form.name.trim(), kind: form.kind, side: form.side,
        price: form.price, quantity: Number(form.quantity), plan_date: form.plan_date || null, note: form.note.trim(),
        ...(editing ? {revision: editing.revision} : {})};
      const saved = await api<Plan>(editing ? `/trade-plans/${editing.id}` : '/trade-plans', {
        method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload),
      });
      setPlans(current => [saved, ...current.filter(plan => plan.id !== saved.id)]);
      setFilter(saved.status); setSide('all'); setOpen(false);
    }, true);
  }
  function changeStatus(plan: Plan, status: Status) {
    void mutate(async () => {
      const saved = await api<Plan>(`/trade-plans/${plan.id}/status`, {method: 'PATCH', body: JSON.stringify({status, revision: plan.revision})});
      setPlans(current => current.map(item => item.id === saved.id ? saved : item));
    });
  }
  const visible = plans.filter(plan => (filter === 'all' || plan.status === filter) && (side === 'all' || plan.side === side))
    .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending')
      || (a.plan_date ?? '9999').localeCompare(b.plan_date ?? '9999') || b.id - a.id);
  const today = localNow().slice(0, 10);
  return <div className="trade-plans-page">
    <div className="page-heading"><h1>交易计划</h1><div className="plan-page-actions">
      <button className="button secondary" disabled={demo || busy || loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spin' : ''}/>刷新</button>
      <button className="button primary" disabled={demo || busy || loading} onClick={() => begin()}><Plus size={16}/>新建计划</button>
    </div></div>
    <div className="plan-toolbar"><div className="plan-filters" aria-label="计划状态">
      {(['pending', 'completed', 'cancelled', 'all'] as const).map(status => <button key={status} className={filter === status ? 'active' : ''} onClick={() => setFilter(status)} aria-pressed={filter === status}>{status === 'all' ? '全部' : statuses[status]}<span>{plans.filter(plan => status === 'all' || plan.status === status).length}</span></button>)}
    </div><select aria-label="计划买卖方向" value={side} onChange={event => setSide(event.target.value as typeof side)}><option value="all">全部方向</option><option value="buy">买入计划</option><option value="sell">卖出计划</option></select></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {demo ? <div className="panel plan-empty">退出示例模式后可管理交易计划。</div> : loading && !plans.length ? <div className="panel loading-panel"><LoaderCircle className="spin"/>正在读取计划…</div>
      : !visible.length ? <div className="panel plan-empty"><ClipboardList size={30}/><strong>{plans.length ? '没有符合条件的计划' : '还没有交易计划'}</strong>{!plans.length && <button className="button secondary" onClick={() => begin()}>新建计划</button>}</div>
      : <div className="plan-card-grid">{visible.map(plan => <article key={plan.id} className={`plan-card plan-${plan.side} ${plan.status !== 'pending' ? 'plan-inactive' : ''}`}>
        <div className="plan-card-heading"><div><strong>{plan.name}</strong><span>{plan.code} · {plan.kind === 'etf' ? 'ETF' : 'A 股'} · #{plan.id}</span></div><span className={`plan-direction ${plan.side}`}>{plan.side === 'buy' ? <ArrowDownLeft size={14}/> : <ArrowUpRight size={14}/>}{plan.side === 'buy' ? '买入' : '卖出'}</span></div>
        <div className="plan-price"><span>计划{plan.side === 'buy' ? '买入' : '卖出'}价</span><strong>{money(plan.price, 3)}</strong></div>
        <div className="plan-card-metrics"><span><small>计划数量</small><strong>{money(plan.quantity, 0)} <em>股/份</em></strong></span><span title="计划价 × 数量，未计交易费用"><small>计划金额</small><strong>¥ {money(Number(plan.price) * plan.quantity)}</strong></span></div>
        <div className="plan-date-line"><span className={plan.status === 'pending' && plan.plan_date && plan.plan_date < today ? 'plan-overdue' : ''}>{plan.plan_date ?? '不限日期'}{plan.status === 'pending' && plan.plan_date && plan.plan_date < today ? ' · 已过计划日' : ''}</span><span className={`plan-status ${plan.status}`}>{statuses[plan.status]}</span></div>
        {plan.note && <p className="plan-card-note">{plan.note}</p>}
        <div className="plan-card-actions">{plan.status === 'pending' ? <>
          <button className="plan-complete" disabled={busy || loading} onClick={() => changeStatus(plan, 'completed')}><Check size={14}/>标记完成</button>
          <button disabled={busy || loading} onClick={() => changeStatus(plan, 'cancelled')}><X size={13}/>取消</button>
        </> : <button className="plan-complete" disabled={busy || loading} onClick={() => changeStatus(plan, 'pending')}><RotateCcw size={13}/>重新启用</button>}
          <button disabled={busy || loading} aria-label={`编辑计划${plan.id}`} title="编辑" onClick={() => begin(plan)}><Pencil size={14}/></button>
          <button className="plan-delete" disabled={busy || loading} aria-label={`删除计划${plan.id}`} title="删除" onClick={() => {setFormError(''); setDeleting(plan);}}><Trash2 size={14}/></button>
        </div>
      </article>)}</div>}
    <Modal open={open} onOpenChange={value => {if (!busy) setOpen(value);}} title={editing ? '编辑交易计划' : '新建交易计划'} description="仅保存计划，完成后可手动标记。" className="plan-dialog">
      <form className="form" onSubmit={save}>
        <div className="side-switch plan-side-switch"><button type="button" disabled={busy} className={form.side === 'buy' ? 'active buy' : ''} onClick={() => setForm(current => ({...current, side: 'buy', quantity: String(Math.max(100, Math.ceil(Number(current.quantity || 100) / 100) * 100))}))}>买入计划</button><button type="button" disabled={busy} className={form.side === 'sell' ? 'active sell' : ''} onClick={() => setForm(current => ({...current, side: 'sell'}))}>卖出计划</button></div>
        {!!instruments.length && <div className="field"><label htmlFor="plan-existing">从已有标的填写</label><select id="plan-existing" disabled={busy} value={instruments.some(item => item.code === form.code) ? form.code : ''} onChange={event => {const item = instruments.find(item => item.code === event.target.value); if (item) setForm(current => ({...current, code: item.code, name: item.name, kind: item.kind}));}}><option value="">选择标的，或在下方搜索</option>{instruments.map(item => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></div>}
        <InstrumentFields form={form} onChange={item => setForm(current => ({...current, ...item}))} busy={busy} open={open}/>
        <div className="plan-form-pair"><div className="field"><label htmlFor="plan-price">计划价格</label><input id="plan-price" type="number" required min="0.001" max="1000000" step="0.001" placeholder="0.000" disabled={busy} value={form.price} onBlur={() => setForm(current => ({...current, price: Number(current.price) > 0 ? Number(current.price).toFixed(3) : current.price}))} onChange={event => setForm(current => ({...current, price: event.target.value}))}/></div>
          <div className="field"><label htmlFor="plan-quantity">计划数量</label><input id="plan-quantity" type="number" required min={form.side === 'buy' ? 100 : 1} max="1000000000" step={form.side === 'buy' ? 100 : 1} disabled={busy} value={form.quantity} onChange={event => setForm(current => ({...current, quantity: event.target.value}))}/></div></div>
        <div className="field"><label htmlFor="plan-date">计划日期 <span>选填</span></label><input id="plan-date" type="date" disabled={busy} value={form.plan_date} onChange={event => setForm(current => ({...current, plan_date: event.target.value}))}/></div>
        <div className="field"><label htmlFor="plan-note">备注 <span>选填</span></label><textarea id="plan-note" maxLength={1000} rows={3} placeholder="记录买卖理由或执行条件" disabled={busy} value={form.note} onChange={event => setForm(current => ({...current, note: event.target.value}))}/></div>
        {formError && <div className="form-error" role="alert">{formError}</div>}
        <div className="form-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setOpen(false)}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy && <LoaderCircle size={15} className="spin"/>}保存计划</button></div>
      </form>
    </Modal>
    <Modal open={!!deleting} onOpenChange={value => {if (!busy && !value) setDeleting(null);}} title="删除这张计划？" description={deleting ? `${deleting.name} · ${deleting.side === 'buy' ? '买入' : '卖出'} ${money(deleting.quantity, 0)} 股/份` : ''}>
      {formError && <div className="form-error" role="alert">{formError}</div>}
      <div className="form-actions"><button className="button secondary" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="button danger" disabled={busy} onClick={() => void mutate(async () => {if (!deleting) return; await api(`/trade-plans/${deleting.id}?revision=${deleting.revision}`, {method: 'DELETE'}); setPlans(current => current.filter(plan => plan.id !== deleting.id)); setDeleting(null);}, true)}>确认删除</button></div>
    </Modal>
  </div>;
}
