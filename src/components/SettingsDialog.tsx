import { Database, Download, Moon, RefreshCw, ShieldCheck, Sparkles, Sun } from 'lucide-react';
import type { Theme } from '../theme';
import { Modal } from './Modal';
import { FeeSettings } from './FeeSettings';
import { StopLossSettings } from './StopLossSettings';
import './SettingsDialog.css';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  demo: boolean;
  autoRefresh: boolean;
  onAutoRefresh: (enabled: boolean) => void;
  refreshSeconds: number;
  onRefreshSeconds: (seconds: number) => void;
  quotePush: boolean;
  onQuotePush: (enabled: boolean) => void;
  onFeesSaved: () => void;
  onMessage: (message: string) => void;
  onToggleDemo: () => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
};

export function SettingsDialog({open, onOpenChange, demo, autoRefresh, onAutoRefresh, refreshSeconds, onRefreshSeconds, quotePush, onQuotePush, onFeesSaved, onMessage, onToggleDemo, theme, onThemeChange}: Props) {
  return <Modal open={open} onOpenChange={onOpenChange} title="设置与数据管理"
    description="管理交易佣金与本地账本。" variant="settings">
    <div className="settings-scroll-area">
      <div className={`settings-status ${demo ? 'is-demo' : ''}`}>
        <ShieldCheck size={17}/><span>{demo ? '正在浏览示例账本 · 费率仅供查看' : '本地账本 · 交易记录保存在此电脑'}</span>
        <span className="settings-status-badge">{demo ? '示例模式' : 'SQLite'}</span>
      </div>
      <section className="settings-theme-card"><div><h3>界面主题</h3><p>立即生效，自动记住你的选择。</p></div><div className="theme-switch" aria-label="界面主题"><button className={theme === 'light' ? 'active' : ''} aria-pressed={theme === 'light'} onClick={() => onThemeChange('light')}><Sun size={14}/>亮色</button><button className={theme === 'dark' ? 'active' : ''} aria-pressed={theme === 'dark'} onClick={() => onThemeChange('dark')}><Moon size={14}/>暗色</button></div></section>
      <div className="settings-grid">
        {open && <FeeSettings demo={demo} onSaved={onFeesSaved}/>}
        {open && <StopLossSettings demo={demo} onSaved={() => onMessage('默认止损已保存，将用于新建及同步买入批次')}/>}
        <section className="settings-card quote-settings">
          <div className="settings-card-heading"><span className="settings-card-icon"><RefreshCw size={18}/></span><div><h3>行情刷新</h3><span>跟踪当前标的价格</span></div></div>
          <div className="setting-row"><div><strong>自动刷新行情</strong><p>{quotePush ? `优先实时推送，断开时每 ${refreshSeconds} 秒查询；批次追踪页按间隔刷新。` : `每 ${refreshSeconds} 秒刷新当前标的；批次追踪页刷新目标标的。`}隐藏页面时暂停。</p></div>
            <label className="toggle"><input aria-label="自动刷新行情" type="checkbox" checked={autoRefresh} onChange={event => onAutoRefresh(event.target.checked)}/><span/></label>
          </div>
          <div className="setting-row"><div><strong>优先实时推送</strong><p>通过主客户端桥接更新最新价，盘口使用公开行情。</p></div><label className="toggle"><input aria-label="优先实时推送" type="checkbox" checked={quotePush} onChange={event => onQuotePush(event.target.checked)}/><span/></label></div>
          <div className="setting-row"><label htmlFor="refresh-interval"><strong>轮询间隔</strong></label><select id="refresh-interval" aria-label="行情刷新间隔" value={refreshSeconds} onChange={event => onRefreshSeconds(Number(event.target.value))}><option value={5}>5 秒</option><option value={10}>10 秒</option><option value={30}>30 秒</option></select></div>
          <div className="settings-inline-note"><span className={`settings-refresh-dot ${autoRefresh ? 'enabled' : ''}`}/>{autoRefresh ? '已开启自动刷新' : '当前使用手动刷新'}<span>立即生效</span></div>
          <p className="fee-description">周一至周五北京时间 9:15–11:30、13:00–15:00 持续刷新与推送；时段外打开页面获取一次，也可手动刷新。</p>
        </section>
        <section className="settings-card data-settings">
          <div className="settings-card-heading"><span className="settings-card-icon"><Database size={18}/></span><div><h3>数据管理</h3><span>定期备份，保留完整交易记录</span></div></div>
          <div className="settings-backup-options">
            <div className="settings-backup-option"><div><strong>完整数据库备份</strong><p>保存交易记录与设置，可用于恢复账本。</p></div>
              <a className="button primary" href={demo ? undefined : '/api/backup'} aria-disabled={demo} onClick={event => {if (demo) {event.preventDefault(); onMessage('退出示例后可备份真实账本');}}}><Database size={15}/>备份完整数据库</a>
            </div>
            <div className="settings-backup-option"><div><strong>交易明细 CSV</strong><p>便于在表格软件中查看和整理交易。</p></div>
              <a className="button secondary" href={demo ? undefined : '/api/export'} aria-disabled={demo} onClick={event => {if (demo) {event.preventDefault(); onMessage('退出示例后可导出真实账本');}}}><Download size={15}/>导出 CSV</a>
            </div>
          </div>
          <div className="settings-demo-row"><span>{demo ? '示例账本不会修改你的真实交易记录。' : '通过示例账本体验买卖记录与持仓展示。'}</span>
            <button className="text-button" onClick={() => {onOpenChange(false); onToggleDemo();}}><Sparkles size={15}/>{demo ? '退出示例账本' : '打开示例账本'}</button>
          </div>
        </section>
      </div>
      <details className="settings-calculation"><summary>成本与盈亏计算规则</summary><p>买入成本含买入费用；卖出默认先进先出，也可指定买入批次。已实现盈亏扣除对应买入成本和卖出费用。当前版本不含分红、送股、拆分与多账户。</p></details>
    </div>
    <div className="settings-dialog-footer"><p>费率与默认止损请保存，行情开关立即生效。</p><button className="button secondary" onClick={() => onOpenChange(false)}>完成</button></div>
  </Modal>;
}
