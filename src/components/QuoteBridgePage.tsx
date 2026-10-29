import { useEffect, useRef, useState } from 'react';
import { Radio, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { Instrument } from '../types';
import './QuoteBridgePage.css';

type Build = {timestamp: number; architecture: string; supported?: boolean};
type BridgeEvent = {time: string; status: string; reason: string};
type BridgeQuote = {code: string; name: string; fresh: boolean; price: number | null;
  fetched_at: string | null; age_seconds: number | null; received_quotes: number;
  fallback_source: string | null; fallback_fetched_at: string | null};
type BridgeStatus = {status: string; reason: string; process_id: number | null; enabled: boolean;
  trading_session: boolean; fresh_quotes: number; watched_quotes: number; received_quotes: number;
  connected_at: string | null; client_build: Build | null; supported_build: Build; supported_builds?: Build[];
  max_age_seconds: number; book_max_age_seconds: number; retry_seconds: number;
  server_time: string; quotes: BridgeQuote[]; events: BridgeEvent[]};

const statuses: Record<string, string> = {idle: '尚未连接', connecting: '正在连接', attached: '已连接',
  paused: '已暂停', unavailable: '不可用'};
const reasons: Record<string, string> = {
  disabled: '已通过启动配置禁用桥接', dependency_missing: '缺少 Frida 依赖，需要安装后重启后台',
  observer_missing: '缺少桥接观察脚本', client_not_running: '未找到同花顺主客户端 hexin.exe',
  unsupported_build: '客户端版本或架构不匹配，已回退原行情源',
  observer_error: '报价观察发生异常，等待重新连接', attach_failed: '无法连接客户端进程，请检查客户端运行状态及双方权限',
  off_hours: '非交易时段，暂停行情观察', no_symbols: '暂无需要观察的证券',
};
function time(value: string | null | undefined, full = false) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : full ? date.toLocaleString('zh-CN', {hour12: false})
    : date.toLocaleTimeString('zh-CN', {hour12: false});
}
function architecture(value: string) {return value === 'ia32' ? '32 位' : value === 'x64' ? '64 位' : value;}

export function QuoteBridgePage({instruments, demo}: {instruments: Instrument[]; demo: boolean}) {
  const [data, setData] = useState<BridgeStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const codes = demo ? '' : instruments.filter(item => item.quantity > 0).map(item => item.code).sort().slice(0, 200).join(',');
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      if (!active || document.hidden || request.current) return;
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      try {
        const result = await api<BridgeStatus>(`/market/bridge/status${codes ? `?codes=${encodeURIComponent(codes)}` : ''}`,
          {signal: controller.signal});
        if (!Array.isArray(result.quotes) || !Array.isArray(result.events)) throw new Error('桥接详情接口尚未更新，请重启 StockAssistant 后台');
        if (active) {setData(result); setError('');}
      } catch (err) {
        if (active && !controller.signal.aborted) setError((err as Error).message);
      } finally {
        if (request.current === controller) request.current = null;
        if (active) {
          setBusy(false);
          if (!document.hidden) timer = setTimeout(() => void refresh(), 2000);
        }
      }
    }
    function visibility() {
      clearTimeout(timer);
      if (document.hidden) request.current?.abort();
      else void refresh();
    }
    document.addEventListener('visibilitychange', visibility);
    void refresh();
    return () => {active = false; clearTimeout(timer); request.current?.abort(); request.current = null;
      document.removeEventListener('visibilitychange', visibility);};
  }, [codes, revision]);
  const reason = data ? !data.enabled ? reasons.disabled : !data.trading_session ? reasons.off_hours
    : reasons[data.reason] ?? (data.status === 'attached' ? '正在观察主客户端已订阅证券的最新价' : '等待行情观察启动') : '';
  return <div className="quote-bridge-page">
    <div className="page-heading"><h1>行情桥接</h1><div className="bridge-page-actions">
      <span className="bridge-muted">每 2 秒更新状态</span>
      <button className="button secondary" disabled={busy} onClick={() => setRevision(value => value + 1)}>
        <RefreshCw size={16} className={busy ? 'spin' : ''}/>刷新状态</button>
    </div></div>
    {error && <div className="bridge-error" role="alert">{error}{data && '（以下保留上次状态）'}</div>}
    {!data ? !error && <section className="panel bridge-empty">正在读取桥接信息…</section> : <>
      <section className="panel bridge-connection">
        <div className={`bridge-icon ${error ? '' : data.status}`}><Radio size={24}/></div>
        <div className="bridge-connection-copy"><h2>{statuses[data.status] ?? data.status}{error && ' · 上次状态'}</h2><p>{reason}</p></div>
        <div className="bridge-coverage"><strong>{data.fresh_quotes}<span> / {data.watched_quotes}</span></strong><small>有效报价 / 观察证券</small></div>
      </section>
      <div className="bridge-details-grid">
        <section className="panel bridge-details"><h3>连接信息</h3><dl>
          <div><dt>主客户端</dt><dd>hexin.exe{data.process_id ? ` · PID ${data.process_id}` : ''}</dd></div>
          <div><dt>连接方式</dt><dd>本地只读观察 · Frida</dd></div>
          <div><dt>最近连接</dt><dd>{time(data.connected_at, true)}</dd></div>
          <div><dt>累计收到报价</dt><dd>{data.received_quotes.toLocaleString()} 次</dd></div>
          <div><dt>当前客户端构建</dt><dd>{data.client_build
            ? `${architecture(data.client_build.architecture)} · ${data.client_build.timestamp}` : '尚未读取'}</dd></div>
          <div><dt>版本适配</dt><dd>{data.client_build ? data.client_build.supported ? '匹配' : '不匹配' : '待确认'}
            <small>支持 {(data.supported_builds ?? [data.supported_build]).map(build => `${architecture(build.architecture)} · ${build.timestamp}`).join(' / ')}</small></dd></div>
        </dl></section>
        <section className="panel bridge-details"><h3>更新与回退</h3><dl>
          <div><dt>交易时段</dt><dd>{data.trading_session ? '交易时段内' : '交易时段外'}<small>工作日 09:15–11:30、13:00–15:00</small></dd></div>
          <div><dt>报价有效期</dt><dd>{data.max_age_seconds} 秒</dd></div>
          <div><dt>盘口有效期</dt><dd>{data.book_max_age_seconds} 秒 · 使用原行情接口</dd></div>
          <div><dt>连接失败重试</dt><dd>每 {data.retry_seconds} 秒</dd></div>
          <div><dt>回退顺序</dt><dd>腾讯 → 东方财富</dd></div>
          <div><dt>状态更新时间</dt><dd>{time(data.server_time)}</dd></div>
        </dl></section>
      </div>
      <section className="panel bridge-quotes"><div className="panel-heading"><h3>证券报价<span className="soft-count">{data.quotes.length}</span></h3></div>
        <div className="table-scroll"><table><thead><tr><th>证券</th><th>桥接状态</th><th className="numeric">桥接最新价</th>
          <th>收到时间 / 距今</th><th className="numeric">收到次数</th><th>最近回退快照来源</th></tr></thead><tbody>
          {data.quotes.map(quote => <tr key={quote.code}>
            <td><strong>{quote.name}</strong><small>{quote.code}</small></td>
            <td><span className={`bridge-badge ${quote.fresh ? 'fresh' : ''}`}>{!data.trading_session ? '时段外暂停'
              : quote.fresh ? '有效' : quote.price != null ? '已过期' : '未收到'}</span></td>
            <td className="numeric bridge-price">{quote.price == null ? '—' : quote.price.toFixed(3)}{!quote.fresh && quote.price != null && <small>上次报价</small>}</td>
            <td>{time(quote.fetched_at)}<small>{quote.age_seconds == null ? '尚无桥接报价' : `${quote.age_seconds.toLocaleString()} 秒前`}</small></td>
            <td className="numeric">{quote.received_quotes.toLocaleString()}</td>
            <td>{quote.fallback_source ?? '—'}<small>{time(quote.fallback_fetched_at)}</small></td>
          </tr>)}
        </tbody></table></div>
        {!data.quotes.length && <div className="bridge-empty">暂无观察证券，有持仓的证券会在此显示。</div>}
        <p className="bridge-footnote">桥接仅读取主客户端已订阅的最新价；未收到或报价过期时，业务页面使用原行情源。此处的旧报价仅供查看。</p>
      </section>
      <section className="panel bridge-events"><div className="panel-heading"><h3>最近连接事件</h3><span className="bridge-muted">保留最近 30 条 · 后台重启后清空</span></div>
        {data.events.length ? <ol>{data.events.map((event, index) => <li key={`${event.time}-${index}`}>
          <time dateTime={event.time}>{time(event.time, true)}</time><strong>{statuses[event.status] ?? event.status}</strong>
          <span>{reasons[event.reason] ?? (event.status === 'attached' ? '观察会话已连接' : '—')}</span>
        </li>)}</ol> : <div className="bridge-empty">暂无连接事件</div>}
      </section>
    </>}
  </div>;
}
