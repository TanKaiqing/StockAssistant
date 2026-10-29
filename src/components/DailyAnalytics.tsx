import { analyzeDay } from '../analytics';
import { money, signed } from '../types';

type Day = ReturnType<typeof analyzeDay>;
const tone = (value: number) => value > 0 ? 'positive' : value < 0 ? 'negative' : '';

export function DailyAnalytics({day}: {day: Day}) {
  return <>
    <div className="summary-grid analytics-summary daily-cash-summary">
      <CashMetric label="买入总支出" value={`¥ ${money(day.buyOutflow)}`} note={`${day.buyCount} 笔买入 · 含费用 ¥ ${money(day.buyFees)}`}/>
      <CashMetric label="卖出净到账" value={`¥ ${money(day.sellInflow)}`} note={`${day.sellCount} 笔卖出 · 扣除费用 ¥ ${money(day.sellFees)}`}/>
      <CashMetric label="净资金流" value={`¥ ${signed(day.cashFlow)}`} note={`${day.cashFlow >= 0 ? '流入' : '流出'} = 卖出到账 − 买入支出，非盈利`}/>
      <CashMetric label="参与标的" value={`${day.instrumentCount} 只`} note={`首笔 ${day.firstTime ?? '—'} · 末笔 ${day.lastTime ?? '—'}`}/>
    </div>
    <div className="daily-detail-grid">
      <section className="panel daily-performance"><div className="panel-heading"><h3>单笔表现</h3><span className="muted">普通卖出与已买回做 T</span></div>
        <div className="daily-extremes"><Performance label="最大单笔盈利" record={day.bestSell}/><Performance label="最大单笔亏损" record={day.worstSell}/></div>
        <div className="daily-small-metrics"><div><span>平均盈利结算</span><strong className="positive">{day.averageWin == null ? '—' : `¥ ${signed(day.averageWin)}`}</strong></div><div><span>平均亏损结算</span><strong className="negative">{day.averageLoss == null ? '—' : `¥ ${signed(day.averageLoss)}`}</strong></div><div><span>成交后累计盈亏最大回撤</span><strong>¥ {money(day.drawdown)}</strong></div></div>
      </section>
      <section className="panel daily-performance"><div className="panel-heading"><h3>费用与交易强度</h3><span className="muted">按当日账本记录</span></div>
        <div className="daily-small-metrics daily-fee-metrics"><div><span>每万元成交费用</span><strong>{day.feePerTenThousand == null ? '—' : `¥ ${money(day.feePerTenThousand)}`}</strong></div><div><span>平均每笔费用</span><strong>{day.averageFee == null ? '—' : `¥ ${money(day.averageFee)}`}</strong></div><div><span>平均每笔成交额</span><strong>¥ {money((day.buyAmount + day.sellAmount) / day.trades.length)}</strong></div><div><span>买入 / 卖出笔数</span><strong>{day.buyCount} / {day.sellCount}</strong></div></div>
        <p className="daily-metric-note">{day.estimatedFees ? `${day.estimatedFees} 笔记录备注含估算费用，请在结算后核对。` : '费用按账本已记录金额统计。'}{day.unsettled > 0 ? `另有 ${day.unsettled} 笔卖出尚未完成结算（含待买回做 T），不计入单笔表现。` : ''}</p>
      </section>
    </div>
    <section className="panel analytics-table daily-sessions"><div className="panel-heading"><h3>交易时段分布</h3><span className="muted">按记录中的成交时间</span></div><div className="table-scroll"><table><thead><tr><th>时段</th><th className="numeric">买入笔数</th><th className="numeric">卖出笔数</th><th className="numeric">成交总额</th><th className="numeric">已实现盈亏</th></tr></thead><tbody>{day.sessions.map(session => <tr key={session.label}><td>{session.label}</td><td className="numeric">{session.buys}</td><td className="numeric">{session.sells}</td><td className="numeric">{money(session.amount)}</td><td className={`numeric ${tone(session.pnl)}`}>{signed(session.pnl)}</td></tr>)}</tbody></table></div></section>
  </>;
}

function CashMetric({label, value, note}: {label: string; value: string; note: string}) {
  return <div className="summary-card"><div className="summary-label">{label}</div><div className="summary-value">{value}</div><div className="summary-caption">{note}</div></div>;
}
function Performance({label, record}: {label: string; record?: Day['bestSell']}) {
  return <div><span>{label}</span><strong className={record ? tone(record.pnl) : ''}>{record ? `¥ ${signed(record.pnl)}` : '—'}</strong><small>{record ? `${record.name} · ${record.kind === 't_trade' ? '买回' : '卖出'} #${record.id} · ${record.time}` : '暂无符合条件的结算'}</small></div>;
}
