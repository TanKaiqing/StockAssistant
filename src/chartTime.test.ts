import { expect, it } from 'vitest';
import { intradayTradeTime, marketClock, marketTimestamp, sessionTimes } from './chartTime';

it('分钟时间固定使用北京时间，排除占位和非交易时间，午休不生成价格点', () => {
  expect(marketTimestamp('2026-10-13', '09:30:00')).toBe(Date.parse('2026-10-13T01:30:00Z') / 1000);
  expect(marketClock(marketTimestamp('2026-10-13', '09:30:00'))).toBe('09:30');
  expect(intradayTradeTime({executed_at: '2026-10-13T00:00:00'})).toBeNull();
  expect(intradayTradeTime({executed_at: '2026-10-13T12:00:00'})).toBeNull();
  expect(intradayTradeTime({executed_at: '2026-10-13T10:23:45'})).toBe(marketTimestamp('2026-10-13', '10:23:00'));
  expect(sessionTimes('2026-10-13')).not.toContain(marketTimestamp('2026-10-13', '12:00:00'));
});
