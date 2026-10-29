import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Instrument } from '../types';
import { Modal } from './Modal';
import './BrokerPage.css';

type Item = {code: string; name: string; kind: 'stock' | 'etf'; in_ledger: boolean};
type List = {rows: Item[]; skipped_count: number};

export function WatchlistDialog({instruments, onClose, onChanged}: {instruments: Instrument[]; onClose: () => void; onChanged?: () => void}) {
  const [list, setList] = useState<List | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const flight = useRef(false);
  const alive = useRef(true);
  async function read() {
    const result = await api<List>('/broker/watchlist');
    if (alive.current) {setList(result); setSelected(result.rows.filter(row => !row.in_ledger).map(row => row.code));}
  }
  async function run(action: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(''); setMessage('');
    try {await action();} catch (err) {if (alive.current) setError((err as Error).message);}
    finally {flight.current = false; if (alive.current) setBusy(false);}
  }
  useEffect(() => {
    alive.current = true;
    const timer = window.setTimeout(() => void run(read), 0);
    return () => {alive.current = false; window.clearTimeout(timer);};
  }, []);
  async function refresh() {
    await api('/broker/watchlist/refresh', {method: 'POST'});
    await new Promise(resolve => window.setTimeout(resolve, 700));
    await read(); setMessage('已读取自选缓存，如列表仍未更新可再次读取。');
  }
  async function importSelected() {
    const result = await api<{inserted: number}>('/broker/watchlist/import', {method: 'POST', body: JSON.stringify({codes: selected})});
    onChanged?.(); await read(); setMessage(`已添加 ${result.inserted} 个标的到本地列表。`);
  }
  async function add() {
    const result = await api<{message: string}>('/broker/watchlist/add', {method: 'POST', body: JSON.stringify({code: adding})});
    setMessage(result.message); await read();
  }
  return <Modal open variant="trade" title="自选股同步" description="同步同花顺自选与我的标的" onOpenChange={open => {if (!open && !flight.current) onClose();}}>
    <div className="broker-order-body">
      <div className="watchlist-toolbar"><button className="button secondary" disabled={busy} onClick={() => void run(read)}>读取自选</button><button className="button secondary" disabled={busy} onClick={() => void run(refresh)}>刷新同花顺自选</button></div>
      {error && <div className="broker-error" role="alert">{error}</div>}{message && <div className="broker-notice" role="status">{message}</div>}
      {list && <><div className="sync-summary">{list.rows.length} 个股票 / ETF{list.skipped_count > 0 && ` · 跳过 ${list.skipped_count} 个指数或其他品种`}</div><div className="watchlist-items">{list.rows.map(row => <label key={row.code}><input type="checkbox" aria-label={`导入${row.name}`} disabled={busy || row.in_ledger} checked={row.in_ledger || selected.includes(row.code)} onChange={e => setSelected(current => e.target.checked ? [...current, row.code] : current.filter(code => code !== row.code))}/><strong>{row.name}</strong><span>{row.code}</span><small>{row.in_ledger ? '已在账本' : row.kind === 'etf' ? 'ETF' : '股票'}</small></label>)}</div></>}
      {!!instruments.length && <div className="watchlist-toolbar"><select aria-label="加入同花顺自选的标的" disabled={busy} value={adding} onChange={e => setAdding(e.target.value)}><option value="">选择本地标的</option>{instruments.map(row => <option key={row.code} value={row.code}>{row.name} · {row.code}</option>)}</select><button className="button secondary" disabled={busy || !adding} onClick={() => void run(add)}>加入同花顺自选</button></div>}
    </div>
    <div className="broker-order-footer"><button className="button secondary" disabled={busy} onClick={onClose}>关闭</button><button className="button primary" disabled={busy || !selected.length} onClick={() => void run(importSelected)}>{busy ? '正在处理…' : `导入选中 ${selected.length} 个`}</button></div>
  </Modal>;
}
