import type { analyzeDay } from '../analytics';
import { money, signed } from '../types';

export function DailyTradesTable({day}: {day: ReturnType<typeof analyzeDay>}) {
  return <section className="panel analytics-table calendar-trades">
    <div className="panel-heading"><h3>当天全部成交<span className="soft-count">{day.trades.length}</span></h3><span className="muted">按成交时间倒序</span></div>
    <div className="table-scroll"><table><thead><tr><th>ID</th><th>成交时间</th><th>标的</th><th>方向</th><th className="numeric">成交价</th><th className="numeric">数量</th><th className="numeric">成交金额</th><th className="numeric">费用</th><th className="numeric" title="与月历一致：做 T 买回后确认净价差，做 T 卖出暂不计入">统计盈亏</th></tr></thead>
      <tbody>{[...day.trades].reverse().map(trade => {
        const profit = trade.analytics_pnl !== undefined ? trade.analytics_pnl
          : trade.side === 'sell' && !trade.t_trade ? trade.realized_pnl : null;
        const tone = profit == null ? '' : Number(profit) > 0 ? 'positive' : Number(profit) < 0 ? 'negative' : '';
        const buyback = trade.side === 'buy' && (!!trade.restored_to?.length || trade.analytics_settlements?.some(event => event.kind === 't_trade'));
        return <tr key={trade.id}><td className="muted">{trade.id}</td><td>{trade.executed_at.slice(11, 19)}</td>
          <td><strong>{trade.name}</strong><small>{trade.code}</small></td>
          <td><span className={`side-badge ${trade.side}`}>{trade.side === 'buy' ? '买入' : '卖出'}</span>{!!trade.t_trade && <em className="calendar-trade-t">做 T</em>}{buyback && <em className="calendar-trade-t">T 买回</em>}</td>
          <td className="numeric">{money(trade.price, 3)}</td><td className="numeric">{money(trade.quantity, 0)}</td>
          <td className="numeric">{money(trade.gross_amount ?? Number(trade.price) * trade.quantity)}</td><td className="numeric muted">{money(trade.fee)}</td>
          <td className={`numeric ${tone}`}>{profit == null ? '—' : signed(profit)}</td></tr>;
      })}</tbody>
      <tfoot><tr><td colSpan={6}>合计 · {day.buyCount} 笔买入 / {day.sellCount} 笔卖出</td><td className="numeric">{money(day.buyAmount + day.sellAmount)}</td><td className="numeric">{money(day.buyFees + day.sellFees)}</td><td className={`numeric ${(day.sequence.at(-1)?.cumulative ?? 0) >= 0 ? 'positive' : 'negative'}`}>{signed(day.sequence.at(-1)?.cumulative ?? 0)}</td></tr></tfoot>
    </table></div>
  </section>;
}
