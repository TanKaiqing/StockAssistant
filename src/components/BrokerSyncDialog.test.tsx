import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrokerSyncDialog } from './BrokerSyncDialog';

afterEach(() => {cleanup(); vi.unstubAllGlobals();});
const plan = {ticket: 'preview-ticket', new_count: 1, duplicate_count: 1, skipped_count: 0, blocked: [], rows: [
  {key: 'one', code: '513310', name: '新增ETF', side: 'buy', executed_at: '2026-10-08T10:00:00', price: '4', quantity: 100, fee: '.1', status: 'new'},
  {key: 'two', code: '510300', name: '已有ETF', side: 'buy', executed_at: '2026-10-08T10:00:00', price: '4', quantity: 100, fee: '.1', status: 'duplicate'},
]};

it('only explicit confirmation writes previewed fills and updates the ledger', async () => {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => new Response(JSON.stringify(url.endsWith('/preview') ? plan : {inserted: 1, backup: 'backup.sqlite3'})));
  vi.stubGlobal('fetch', fetch); const onChanged = vi.fn(); const user = userEvent.setup();
  render(<BrokerSyncDialog onClose={vi.fn()} onChanged={onChanged}/>);
  expect(fetch).not.toHaveBeenCalled(); await user.click(screen.getByText('预览同步'));
  await screen.findByText('新增ETF · 513310'); expect(screen.queryByText('已有ETF · 510300')).toBeNull();
  expect(fetch).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('checkbox')); expect(screen.getByText('已有ETF · 510300')).toBeTruthy();
  await user.click(screen.getByText('确认导入 1 笔'));
  await screen.findByText(/已导入 1 笔成交/); expect(onChanged).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ticket: 'preview-ticket', confirmed: true});
});

it('conflicting records disable import', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({...plan, blocked: ['需要人工核对']})));
  vi.stubGlobal('fetch', fetch); const user = userEvent.setup();
  render(<BrokerSyncDialog onClose={vi.fn()}/>); await user.click(screen.getByText('预览同步'));
  await screen.findByText('需要人工核对');
  expect((screen.getByRole('button', {name: '确认导入 1 笔'}) as HTMLButtonElement).disabled).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
});
