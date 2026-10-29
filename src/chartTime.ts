import type { Time, UTCTimestamp } from 'lightweight-charts';
import type { Trade } from './types';

export const marketTimestamp = (date: string, clock: string) => Math.floor(new Date(`${date}T${clock}+08:00`).getTime() / 1000) as UTCTimestamp;
export function intradayTradeTime(trade: Pick<Trade, 'executed_at'>): Time | null {
  const clock = trade.executed_at.slice(11, 16);
  const minute = Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
  if (!/^\d{2}:\d{2}$/.test(clock) || !(minute >= 570 && minute <= 690 || minute >= 780 && minute <= 900)) return null;
  return marketTimestamp(trade.executed_at.slice(0, 10), clock + ':00');
}
export function sessionTimes(date: string): UTCTimestamp[] {
  const times: UTCTimestamp[] = [];
  for (const [start, end] of [[570, 690], [780, 900]]) {
    for (let minute = start; minute <= end; minute++) times.push(marketTimestamp(date, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`));
  }
  return times;
}
export const marketClock = (time: number) => new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date(time * 1000));
