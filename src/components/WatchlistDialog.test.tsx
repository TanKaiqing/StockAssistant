import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WatchlistDialog } from './WatchlistDialog';

afterEach(() => {cleanup(); vi.unstubAllGlobals();});
it('reads once in StrictMode and imports only selected new instruments', async () => {
  let imported = false;
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/import')) {imported = true; return new Response('{"inserted":1}');}
    return new Response(JSON.stringify({skipped_count: 1, rows: [
      {code: '513310', name: '已有ETF', kind: 'etf', in_ledger: true},
      {code: '510300', name: '新增ETF', kind: 'etf', in_ledger: imported},
    ]}));
  });
  vi.stubGlobal('fetch', fetch); const user = userEvent.setup(); const onChanged = vi.fn();
  render(<StrictMode><WatchlistDialog instruments={[]} onClose={vi.fn()} onChanged={onChanged}/></StrictMode>);
  await screen.findByText('新增ETF'); expect(fetch).toHaveBeenCalledOnce();
  expect((screen.getByLabelText('导入已有ETF') as HTMLInputElement).disabled).toBe(true);
  await user.click(screen.getByText('导入选中 1 个'));
  await screen.findByText('已添加 1 个标的到本地列表。');
  expect(JSON.parse(String(fetch.mock.calls.find(([url]) => url.endsWith('/import'))?.[1]?.body))).toEqual({codes: ['510300']});
  expect(onChanged).toHaveBeenCalledOnce();
});
