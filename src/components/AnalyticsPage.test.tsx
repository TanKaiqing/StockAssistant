import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { AnalyticsPage } from './AnalyticsPage';
import type { Instrument } from '../types';

afterEach(cleanup);
it('类型与日期筛选更新统计，非法范围显示明确提示', async () => {
  const user = userEvent.setup();
  const etf: Instrument = {code: '510300', name: '测试ETF', kind: 'etf', quantity: 0, cost: '0', average_cost: null, realized_pnl: '10', lots: [], trades: [{id: 1, code: '510300', side: 'sell', executed_at: '2026-10-12T10:00:00', price: '4', quantity: 100, fee: '1', note: '', buy_lot_id: null, realized_pnl: '10', allocations: []}]};
  render(<AnalyticsPage instruments={[etf]}/>);
  expect(screen.getByText('测试ETF')).toBeTruthy();
  expect(screen.getByRole('img', {name: /已实现盈亏曲线/})).toBeTruthy();
  await user.selectOptions(screen.getByLabelText('统计标的类型'), 'stock');
  expect(screen.getByText('所选范围暂无交易记录。')).toBeTruthy();
  await user.selectOptions(screen.getByLabelText('统计标的类型'), 'all');
  const start = screen.getByLabelText('统计开始日期');
  const end = screen.getByLabelText('统计结束日期');
  fireEvent.change(start, {target: {value: '2026-10-13'}});
  fireEvent.change(end, {target: {value: '2026-10-12'}});
  expect(within(screen.getByRole('alert')).getByText('开始日期不能晚于结束日期。')).toBeTruthy();
});
