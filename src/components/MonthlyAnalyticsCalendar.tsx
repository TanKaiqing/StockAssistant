import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { analyzeDay, type analyze, type AnalyticsFilter } from '../analytics';
import { localNow, money, signed, type Instrument } from '../types';
import { DailyAnalytics } from './DailyAnalytics';
import { DailyTradesTable } from './DailyTradesTable';
import './MonthlyAnalyticsCalendar.css';

export function MonthlyAnalyticsCalendar({month, days, instruments, kind}: {
  month: string; days: ReturnType<typeof analyze>['days']; instruments: Instrument[]; kind: AnalyticsFilter['kind'];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useMemo(() => selected ? analyzeDay(instruments, selected, kind) : null, [selected, instruments, kind]);
  const [year, monthNumber] = month.split('-').map(Number);
  const offset = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7;
  const length = new Date(year, monthNumber, 0).getDate();
  const cells = Math.ceil((offset + length) / 7) * 7;
  const today = localNow().slice(0, 10);
  const values = new Map(days.map(day => [day.date, {...day, pnl: Math.round(day.pnl * 100) / 100}]));
  const active = [...values.values()];
  const wins = active.filter(day => day.pnl > 0).length;
  const losses = active.filter(day => day.pnl < 0).length;
  return <>
    <section className="panel analytics-calendar" aria-label={`${year}年${monthNumber}月每日已实现盈亏`}>
      <div className="calendar-heading"><div><h3>{year} 年 {monthNumber} 月 · 每日盈亏</h3><span>已实现盈亏 · 点击日期查看当天统计</span></div>
        <div className="calendar-month-summary"><span>盈利 <strong className="positive">{wins}</strong> 天</span><span>亏损 <strong className="negative">{losses}</strong> 天</span><span>成交 <strong>{active.length}</strong> 天</span></div></div>
      <div className="calendar-weekdays" aria-hidden="true">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
      <div className="calendar-days">{Array.from({length: cells}, (_, index) => {
        const number = index - offset + 1;
        if (number < 1 || number > length) return <span key={index} className="calendar-blank" aria-hidden="true"/>;
        const date = `${month}-${String(number).padStart(2, '0')}`;
        const day = values.get(date);
        const future = date > today;
        const tone = day ? day.pnl > 0 ? 'gain' : day.pnl < 0 ? 'loss' : 'flat' : '';
        return <button key={date} className={`calendar-day ${tone} ${date === today ? 'today' : ''} ${selected === date ? 'selected' : ''}`}
          type="button" disabled={future} aria-pressed={selected === date} aria-current={date === today ? 'date' : undefined}
          aria-label={`${date}，${day ? `已实现盈亏 ${signed(day.pnl)} 元，${day.count} 笔成交` : future ? '尚未到来' : '无成交记录'}`}
          title={day ? `已实现盈亏 ¥ ${signed(day.pnl)} · ${day.count} 笔成交 · 成交额 ¥ ${money(day.amount)}` : future ? '尚未到来' : '无成交记录'}
          onClick={() => setSelected(current => current === date ? null : date)}>
          <span className="calendar-date">{number}{date === today && <em>今</em>}</span>
          <strong className={tone === 'gain' ? 'positive' : tone === 'loss' ? 'negative' : ''}>{day ? signed(day.pnl) : '—'}</strong>
          <small>{day ? `${day.count} 笔成交` : future ? '' : '无成交'}</small>
        </button>;
      })}</div>
    </section>
    {selected && detail && <section className="calendar-day-detail" aria-label={`${selected}统计详情`}>
      <div className="calendar-detail-heading"><h3>{selected} · 当天统计</h3><button className="text-button" onClick={() => setSelected(null)}><X size={14}/>收起</button></div>
      {detail.trades.length ? <><DailyTradesTable day={detail}/><DailyAnalytics day={detail}/></> : <div className="panel analytics-empty">当天暂无成交记录。</div>}
    </section>}
  </>;
}
