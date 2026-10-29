import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { InstrumentFields, type InstrumentForm } from './InstrumentFields';

afterEach(() => {cleanup(); vi.unstubAllGlobals();});
function Form() {
  const [form, setForm] = useState<InstrumentForm>({code: '', name: '', kind: 'stock'});
  return <InstrumentFields form={form} onChange={setForm} busy={false} open/>;
}
const response = (code: string, name: string, kind = 'etf') => new Response(JSON.stringify({candidates: [{code, name, kind}]}));

it('三位代码显示候选，选择后填写完整代码、名称和类型，仍可手动改名', async () => {
  const fetch = vi.fn(async () => response('510300', '沪深300ETF'));
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup(); render(<Form/>);
  fireEvent.change(screen.getByLabelText('证券代码'), {target: {value: '51'}});
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('证券代码'), {target: {value: '510'}});
  await user.click(await screen.findByRole('button', {name: /510300.*沪深300ETF/}));
  expect((screen.getByLabelText('证券代码') as HTMLInputElement).value).toBe('510300');
  expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('沪深300ETF');
  expect((screen.getByLabelText('标的类型') as HTMLSelectElement).value).toBe('etf');
  fireEvent.change(screen.getByLabelText('名称'), {target: {value: '我的ETF'}});
  expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('我的ETF');
});

it('快速改代码后旧查询返回不能覆盖最新候选', async () => {
  let resolveOld!: (response: Response) => void;
  const fetch = vi.fn((url: string) => url.includes('510') ? new Promise<Response>(resolve => {resolveOld = resolve;}) : Promise.resolve(response('002437', '誉衡药业', 'stock')));
  vi.stubGlobal('fetch', fetch); render(<Form/>);
  fireEvent.change(screen.getByLabelText('证券代码'), {target: {value: '510'}});
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('证券代码'), {target: {value: '002'}});
  expect(await screen.findByRole('button', {name: /誉衡药业/})).toBeTruthy();
  await act(async () => resolveOld(response('510300', '过期结果')));
  expect(screen.queryByText('过期结果')).toBeNull();
  expect(screen.getByText('誉衡药业')).toBeTruthy();
});

it('查询失败可重试，也能继续手动填写', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('{"detail":"名称查询暂不可用，可手动填写名称"}', {status: 503})).mockResolvedValueOnce(response('510300', '沪深300ETF'));
  vi.stubGlobal('fetch', fetch); const user = userEvent.setup(); render(<Form/>);
  fireEvent.change(screen.getByLabelText('证券代码'), {target: {value: '510300'}});
  await user.click(await screen.findByRole('button', {name: '重试'}));
  expect(await screen.findByText('沪深300ETF')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('名称'), {target: {value: '手动名称'}});
  expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('手动名称');
});

it('名称输入支持中文输入法，选中候选自动带入完整代码和类型', async () => {
  const fetch = vi.fn(async (_url: string) => response('002437', '誉衡药业', 'stock'));
  vi.stubGlobal('fetch', fetch); const user = userEvent.setup(); render(<Form/>);
  const name = screen.getByLabelText('名称');
  fireEvent.compositionStart(name);
  fireEvent.change(name, {target: {value: '誉衡'}});
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.compositionEnd(name);
  await user.click(await screen.findByRole('button', {name: /002437.*誉衡药业/}));
  expect(fetch.mock.calls[0][0]).toContain('q=%E8%AA%89%E8%A1%A1');
  expect((screen.getByLabelText('证券代码') as HTMLInputElement).value).toBe('002437');
  expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('誉衡药业');
  expect((screen.getByLabelText('标的类型') as HTMLSelectElement).value).toBe('stock');
});
