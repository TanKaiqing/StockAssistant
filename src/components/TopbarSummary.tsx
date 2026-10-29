import { useMemo } from 'react';
import { analyzeDay } from '../analytics';
import { money, signed, type Instrument } from '../types';
import './TopbarSummary.css';

export function TopbarSummary({instruments, now, marketOpen, loading}: {
  instruments: Instrument[]; now: number; marketOpen: boolean; loading: boolean;
}) {
  const date = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai'}).format(now);
  const day = useMemo(() => analyzeDay(instruments, date, 'all'), [instruments, date]);
  const unavailable = loading || instruments.some(item => !!item.analytics_error || item.trades.some(trade => trade.t_trade && !trade.analytics_settlements));
  const pnl = day.sequence.at(-1)?.cumulative ?? 0;
  const weekday = new Intl.DateTimeFormat('zh-CN', {weekday: 'short', timeZone: 'Asia/Shanghai'}).format(now);
  return <div className="topbar-summary" aria-label="今日账本摘要">
    <div className="topbar-calendar"><time dateTime={date}>{date.slice(5).replace('-', ' / ')}</time><span>{weekday}</span></div>
    <span className={`topbar-session ${marketOpen ? 'open' : ''}`}>{marketOpen ? '交易时段' : '非交易时段'}</span>
    <div className="topbar-stat" title="本地账本今日已实现盈亏，做 T 在买回关联后结算，不含浮动盈亏"><span>今日已实现</span><strong className={unavailable ? '' : pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : ''}>{unavailable ? '—' : `¥ ${signed(pnl)}`}</strong></div>
    <div className="topbar-stat topbar-volume" title={`本地账本今日买入 ${day.buyCount} 笔，成交金额不含费用`}><span>买入 <small>{day.buyCount} 笔</small></span><strong>{loading ? '—' : `¥ ${money(day.buyAmount)}`}</strong></div>
    <div className="topbar-stat topbar-volume" title={`本地账本今日卖出 ${day.sellCount} 笔，成交金额不含费用`}><span>卖出 <small>{day.sellCount} 笔</small></span><strong>{loading ? '—' : `¥ ${money(day.sellAmount)}`}</strong></div>
  </div>;
}
