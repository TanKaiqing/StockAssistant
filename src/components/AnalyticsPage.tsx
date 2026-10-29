import { useMemo, useState } from 'react';
import { BarChart3, CalendarDays, Receipt, TrendingUp } from 'lucide-react';
import { analyze, analyzeDay, type AnalyticsFilter } from '../analytics';
import { DailyAnalytics } from './DailyAnalytics';
import { DailyTradesTable } from './DailyTradesTable';
import { MonthlyAnalyticsCalendar } from './MonthlyAnalyticsCalendar';
import { localNow, money, signed, type Instrument } from '../types';
import './AnalyticsPage.css';

function tone(value: number) {return value > 0 ? 'positive' : value < 0 ? 'negative' : '';}
function dateString(date: Date) {return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;}

export function AnalyticsPage({instruments}: {instruments: Instrument[]}) {
  const [period, setPeriod] = useState('today');
  const [filter, setFilter] = useState<AnalyticsFilter>(() => {
    const today = localNow().slice(0, 10);
    return {start: today, end: today, kind: 'all'};
  });
  const result = useMemo(() => analyze(instruments, filter), [instruments, filter]);
  const singleDay = !!filter.start && filter.start === filter.end;
  const daily = useMemo(() => singleDay ? analyzeDay(instruments, filter.start, filter.kind) : null, [instruments, singleDay, filter.start, filter.kind]);
  const statisticsErrors = instruments.filter(item => filter.kind === 'all' || item.kind === filter.kind)
    .map(item => item.analytics_error ? `${item.name}：${item.analytics_error}`
      : item.trades.some(trade => trade.t_trade && !trade.analytics_settlements) ? `${item.name}：做 T 统计尚未更新，请重启后台` : '').filter(Boolean);
  const invalid = !!filter.start && !!filter.end && filter.start > filter.end;
  function choosePeriod(value: string) {
    const now = new Date(); let start = '', end = '';
    if (value === 'today') {start = dateString(now); end = start;}
    if (value === 'month') {start = dateString(new Date(now.getFullYear(), now.getMonth(), 1)); end = localNow().slice(0, 10);}
    if (value === 'last-month') {start = dateString(new Date(now.getFullYear(), now.getMonth() - 1, 1)); end = dateString(new Date(now.getFullYear(), now.getMonth(), 0));}
    if (value === '30') {const past = new Date(now); past.setDate(past.getDate() - 29); start = dateString(past); end = localNow().slice(0, 10);}
    setPeriod(value); setFilter(current => ({...current, start, end}));
  }
  return <div className="analytics-page">
    <div className="page-heading"><h1>统计分析</h1><select className="analytics-kind" aria-label="统计标的类型" value={filter.kind} onChange={e => setFilter({...filter, kind: e.target.value as AnalyticsFilter['kind']})}><option value="all">股票与 ETF</option><option value="stock">仅股票</option><option value="etf">仅 ETF</option></select></div>
    <div className="analytics-filter panel"><div className="range-switch" aria-label="统计时间范围">{[['today','当日'],['all','全部'],['month','本月'],['last-month','上月'],['30','近30天']].map(([value, label]) => <button key={value} className={period === value ? 'active' : ''} onClick={() => choosePeriod(value)}>{label}</button>)}</div>
      <div className="analytics-dates"><CalendarDays size={15}/><input type="date" aria-label="统计开始日期" value={filter.start} onChange={e => {setPeriod('custom'); setFilter({...filter, start: e.target.value});}}/><span>至</span><input type="date" aria-label="统计结束日期" value={filter.end} onChange={e => {setPeriod('custom'); setFilter({...filter, end: e.target.value});}}/></div>
    </div>
    {invalid ? <div className="form-error" role="alert">开始日期不能晚于结束日期。</div> : statisticsErrors.length ? <div className="form-error" role="alert">{statisticsErrors.join('；')}</div> : <>
      <div className="summary-grid analytics-summary">
        <Metric label="已实现盈亏" value={`¥ ${signed(result.pnl)}`} note={`普通 ${signed(result.ordinaryPnl)} · 做 T ${signed(result.tPnl)}；均已扣对应费用`} tone={tone(result.pnl)} icon={<TrendingUp size={18}/>}/>
        <Metric label="结算胜率" value={result.winRate == null ? '—' : `${money(result.winRate)}%`} note={`${result.wins} 笔盈利 · ${result.losses} 笔亏损 · ${result.flat} 笔持平`} icon={<BarChart3 size={18}/>}/>
        <Metric label="成交总额" value={`¥ ${money(result.amount)}`} note={`${result.count} 笔交易 · ${result.days.length} 个交易日`} icon={<Receipt size={18}/>}/>
        <Metric label="交易总费用" value={`¥ ${money(result.fees)}`} note="所选期间买卖记录中的费用合计" icon={<Receipt size={18}/>}/>
      </div>
      {(period === 'month' || period === 'last-month') && <MonthlyAnalyticsCalendar key={`${filter.start.slice(0, 7)}:${filter.kind}`} month={filter.start.slice(0, 7)} days={result.days} instruments={instruments} kind={filter.kind}/>}
      {!result.count ? <div className="panel analytics-empty">所选范围暂无交易记录。</div> : <>
        {daily && <><DailyTradesTable day={daily}/><DailyAnalytics day={daily}/></>}
        <section className="panel analytics-chart-panel"><div className="panel-heading"><h3>{daily ? '当日已实现盈亏走势' : '累计已实现盈亏'}</h3><span className="muted">{daily ? '按成交顺序从 0 累计' : '所选范围内从 0 累计'}</span></div><ProfitCurve days={daily?.sequence ?? result.days} intraday={!!daily}/>
          <div className="analytics-insights"><div><span>盈利 / 亏损总额比</span><strong>{result.profitFactor == null ? result.gains > 0 ? '无亏损' : '—' : `${money(result.profitFactor)} 倍`}</strong></div><div><span>{daily ? '成交后累计盈亏最大回撤' : '日末累计盈亏最大回撤'}</span><strong>¥ {money(daily?.drawdown ?? result.drawdown)}</strong></div><div><span>每笔结算平均盈亏</span><strong className={tone(result.pnl)}>{result.sells ? `¥ ${signed(result.pnl / result.sells)}` : '—'}</strong></div></div>
        </section>
        <section className="panel analytics-table"><div className="panel-heading"><h3>标的表现</h3><span className="muted">按已实现盈亏排序</span></div><div className="table-scroll"><table><thead><tr><th>标的</th><th className="numeric">已实现盈亏</th><th className="numeric">其中做 T 净价差</th><th className="numeric">结算胜率</th><th className="numeric">交易笔数</th><th className="numeric">成交总额</th><th className="numeric">费用</th></tr></thead><tbody>{result.rankings.map(i => <tr key={i.code}><td><strong>{i.name}</strong><small>{i.code} · {i.kind === 'etf' ? 'ETF' : '股票'}</small></td><td className={`numeric ${tone(i.pnl)}`}>{signed(i.pnl)}</td><td className={`numeric ${tone(i.tPnl)}`}>{signed(i.tPnl)}</td><td className="numeric">{i.winRate == null ? '—' : `${money(i.winRate)}%`}</td><td className="numeric">{i.count}</td><td className="numeric">{money(i.amount)}</td><td className="numeric muted">{money(i.fees)}</td></tr>)}</tbody></table></div></section>
        {!daily && <section className="panel analytics-table"><div className="panel-heading"><h3>月度统计</h3></div><div className="table-scroll"><table><thead><tr><th>月份</th><th className="numeric">已实现盈亏</th><th className="numeric">其中做 T 净价差</th><th className="numeric">买入笔数</th><th className="numeric">卖出笔数</th><th className="numeric">成交总额</th><th className="numeric">费用</th></tr></thead><tbody>{result.months.map(m => <tr key={m.month}><td>{m.month}</td><td className={`numeric ${tone(m.pnl)}`}>{signed(m.pnl)}</td><td className={`numeric ${tone(m.tPnl)}`}>{signed(m.tPnl)}</td><td className="numeric">{m.buys}</td><td className="numeric">{m.sells}</td><td className="numeric">{money(m.amount)}</td><td className="numeric muted">{money(m.fees)}</td></tr>)}</tbody></table></div></section>}
      </>}
      <details className="analytics-rules"><summary>统计口径</summary><p>普通卖出按成交日确认，沿用原批次的统计成本；做 T 卖出不直接计入已实现盈亏，实际买回并关联后，按买回成交日确认对应数量的卖出净额减买回支出。跨日按实际买回日、分批按每次关联数量计算，待买回部分不计入。已确认做 T 的原持仓成本会结转至买回数量，避免后续普通卖出再次计入做 T 价差。实际账本成本和真实已实现盈亏保持不变。结算胜率按普通卖出及每笔做 T 买回关联分别计算。成交总额、费用和资金流仍按实际买卖记录统计，不虚增交易笔数，也不重复扣费。单日曲线按成交顺序累计，多日曲线按日期汇总；本页为交易结算统计，非账户净值或总收益率，不包含浮动盈亏及待买回做 T 的未结算结果。费用以账本实际记录为准，日期和时段沿用成交记录。</p></details>
    </>}
  </div>;
}

function Metric({label, value, note, tone = '', icon}: {label: string; value: string; note: string; tone?: string; icon: React.ReactNode}) {
  return <div className="summary-card"><div className="summary-label">{label}{icon}</div><div className={`summary-value ${tone}`}>{value}</div><div className="summary-caption">{note}</div></div>;
}

function ProfitCurve({days, intraday = false}: {days: ReturnType<typeof analyze>['days']; intraday?: boolean}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 900, height = 240, left = 75, right = 22, top = 22, bottom = 35;
  const values = [0, ...days.map(d => d.cumulative)];
  const low = Math.min(...values), high = Math.max(...values), padding = Math.max((high - low) * .15, 1);
  const min = low - padding, max = high + padding;
  const x = (i: number) => left + i / Math.max(days.length, 1) * (width - left - right);
  const y = (v: number) => top + (max - v) / (max - min) * (height - top - bottom);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const item = hover == null ? days.at(-1) : days[hover];
  return <div className="analytics-curve"><div className="analytics-curve-readout" aria-live="polite">{item && <><span>{item.date}</span><span>{intraday ? '本笔' : '当日'} <strong className={tone(item.pnl)}>{signed(item.pnl)} 元</strong></span><span>累计 <strong className={tone(item.cumulative)}>{signed(item.cumulative)} 元</strong></span><span>{item.count} 笔</span></>}</div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={intraday ? '按成交顺序累计的当日已实现盈亏曲线' : '按交易日累计的已实现盈亏曲线'}>
      {[max, (min + max) / 2, min].map(v => <g key={v}><line x1={left} x2={width - right} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)"/><text x={left - 10} y={y(v) + 4} textAnchor="end">{money(v, 0)}</text></g>)}
      <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} stroke="var(--chart-zero)" strokeDasharray="4 4"/>
      <polyline points={points} fill="none" stroke="var(--chart-line)" strokeWidth="2.5" strokeLinejoin="round"/>
      {days.map((d, i) => <g key={d.date}><circle cx={x(i + 1)} cy={y(d.cumulative)} r="3" fill="var(--chart-line)"/><rect x={x(i + .5)} y={top} width={(width - left - right) / days.length} height={height - top - bottom} fill="transparent" tabIndex={0} aria-label={`${d.date}，累计盈亏 ${money(d.cumulative)} 元`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}><title>{d.date} · {signed(d.cumulative)} 元</title></rect></g>)}
      {item && hover != null && <line x1={x(hover + 1)} x2={x(hover + 1)} y1={top} y2={height - bottom} stroke="var(--chart-guide)" strokeDasharray="3 4" pointerEvents="none"/>}
      <text x={left} y={height - 8}>{days[0]?.date}</text><text x={width - right} y={height - 8} textAnchor="end">{days.at(-1)?.date}</text>
    </svg>
  </div>;
}
