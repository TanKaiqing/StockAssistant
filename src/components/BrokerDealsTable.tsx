import { Fragment, useState, type ReactNode } from 'react';
import { ChevronDown, Check, LoaderCircle } from 'lucide-react';
import { money } from '../types';
import type { RecordRow } from './BrokerPage';
import './BrokerDealsTable.css';

export function BrokerDealsTable({rows, messages, syncing, tSwitching, tErrors, onToggleT, onAssociateBuyback, demo, allocationControl, allocationReady, onSync}: {
  rows: RecordRow[]; messages: Record<string, {done: boolean; text: string}>; syncing: string | null; demo: boolean;
  allocationControl: (row: RecordRow) => ReactNode; allocationReady: (row: RecordRow) => boolean;
  onSync: (row: RecordRow) => void;
  tSwitching: string | null; tErrors: Record<string, string>;
  onToggleT: (row: RecordRow, enabled: boolean) => void;
  onAssociateBuyback: (row: RecordRow) => void;
}) {
  const [expanded, setExpanded] = useState<Set<RecordRow['id']>>(new Set());
  if (!rows.length) return <div className="broker-empty">没有匹配的成交记录</div>;
  return <div className="table-scroll broker-deals-table"><table><thead><tr>
    <th>成交时间</th><th>标的</th><th>方向</th><th>做 T</th><th className="numeric">成交均价</th>
    <th className="numeric">数量</th><th className="numeric">成交金额</th><th className="numeric">费用</th>
    <th>分笔成交</th><th>同步状态</th><th>操作</th>
  </tr></thead><tbody>{rows.map(row => {
    const fills = row.rows ?? [row];
    const message = row.sync_token ? messages[row.sync_token] : undefined;
    const done = !!row.synced || !!message?.done;
    const running = !!row.sync_token && syncing === row.sync_token;
    const synced = done ? fills.length : fills.filter(fill => fill.synced).length;
    const isExpanded = expanded.has(row.id);
    return <Fragment key={row.id}>
      <tr><td><strong>{row.date ?? '—'}</strong><small>{row.time ?? '—'}</small></td>
        <td><strong>{row.name ?? '—'}</strong><small>{row.code ?? '—'}</small></td>
        <td><span className={`broker-side ${row.side ?? ''}`}>{row.operation ?? '—'}</span></td>
        <td className="deal-t-cell">{row.side === 'buy' ? <button className="text-button deal-buyback-button" disabled={demo || syncing !== null || !row.sync_token || !done} title={done ? '关联对应的做 T 卖出委托' : '请先同步这笔买入成交'} onClick={() => onAssociateBuyback(row)}>关联做 T 买回</button> : row.side !== 'sell' ? '—' : <>
          <span className="deal-t-control"><button type="button" role="switch" aria-checked={!!row.t_trade} aria-label={`${row.name ?? row.code ?? ''}卖出委托做T`} className={`deal-t-switch ${row.t_trade ? 'enabled' : row.t_mixed ? 'mixed' : ''}`}
            disabled={demo || syncing !== null || !row.sync_token || !!(row.t_trade && row.has_t_links)}
            title={row.t_trade && row.has_t_links ? '已有买回关联，请先解除关联才能关闭' : row.t_mixed ? '部分成交已标记，开启后整单设为做 T' : '切换整笔卖出委托的做 T 标记'}
            onClick={() => onToggleT(row, !row.t_trade)}><span/></button>
            {tSwitching === String(row.id) ? <LoaderCircle size={12} className="spin"/> : <span>{row.t_mixed ? '部分' : row.t_trade ? '是' : '否'}</span>}
          </span>{tErrors[String(row.id)] && <small className="deal-t-error" role="alert">{tErrors[String(row.id)]}</small>}
        </>}</td>
        <td className="numeric">{money(row.price, 3)}</td><td className="numeric">{money(row.quantity, 0)}</td>
        <td className="numeric">{money(row.amount)}</td><td className="numeric" title="缺失费用同步时按整单佣金估算并分摊，实际费用以交割单为准。">{row.fee == null ? '待核算' : money(row.fee)}</td>
        <td><button className="deal-fills-toggle" aria-expanded={isExpanded} aria-controls={`deal-fills-${row.id}`} onClick={() => setExpanded(current => {const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next;})}>{fills.length} 笔<ChevronDown size={13} className={isExpanded ? 'expanded' : ''}/></button><small>{row.grouped ? '同一委托' : '独立成交'}</small></td>
        <td className={done ? 'negative' : ''}>{done ? '已全部同步' : synced ? `${synced} / ${fills.length} 已同步` : '未同步'}</td>
        <td className="broker-deal-action">
          {!done && <>{synced > 0 && row.sync_quantity != null && <small>本次同步 {money(row.sync_quantity, 0)} 股/份</small>}{allocationControl(row)}</>}
          <button className="button secondary" disabled={demo || syncing !== null || !row.sync_token || done || !allocationReady(row)} title={row.sync_reason ?? undefined} onClick={() => onSync(row)}>{done ? <Check size={14}/> : running ? <LoaderCircle size={14} className="spin"/> : null}{done ? '已同步' : running ? '同步中…' : fills.length > 1 ? '同步本委托' : '同步成交'}</button>
          {done && row.buy_lot_id && <small>关联批次 #{row.buy_lot_id}</small>}
          {message && <small className="deal-sync-message" role={message.done ? 'status' : 'alert'}>{message.text}</small>}
          {!row.sync_token && row.sync_reason && <small className="deal-sync-message">{row.sync_reason}</small>}
        </td>
      </tr>
      {isExpanded && <tr id={`deal-fills-${row.id}`} className="deal-fill-details"><td colSpan={11}>
        <table aria-label={`${row.name ?? row.code ?? ''}分笔成交明细`}><thead><tr><th>时间</th><th className="numeric">成交价</th><th className="numeric">数量</th><th className="numeric">成交金额</th><th className="numeric">费用</th><th>状态</th></tr></thead>
          <tbody>{fills.map((fill, index) => <tr key={`${fill.id}:${index}`}><td>{fill.time ?? '—'}</td><td className="numeric">{money(fill.price, 3)}</td><td className="numeric">{money(fill.quantity, 0)}</td><td className="numeric">{money(fill.amount)}</td><td className="numeric">{money(fill.fee)}</td><td>{done || fill.synced ? '已同步' : '未同步'}</td></tr>)}</tbody>
        </table>
      </td></tr>}
    </Fragment>;
  })}</tbody></table></div>;
}
