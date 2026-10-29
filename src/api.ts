export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const detail = data?.detail;
    throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail)
      ? detail.map((item: {loc: string[]; msg: string}) => `${item.loc.slice(1).join('.')}：${item.msg}`).join('；')
      : `请求失败（${response.status}），请确认本地服务已启动`);
  }
  return response.status === 204 ? undefined as T : response.json();
}
