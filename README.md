# 拾仓 · StockAssistant

本地运行的 A 股与 ETF 交易账本，按买入批次跟踪盈亏，管理做 T 和交易计划。

## 功能

- **批次追踪**：持仓成本、实时盈亏、止盈止损与达标高亮。
- **做 T 管理**：卖出标记、跨日买回关联、多次做 T 收益统计。
- **成交同步**：同花顺账户查询、分笔成交按委托汇总、手动同步到账本。
- **统计分析**：当日成交明细、每日盈亏月历与收益统计。
- **交易计划**：记录买卖计划，管理完成状态。
- **行情与交易**：实时价格、分时与日 K，支持手动确认的真实委托。

支持暗色主题、CSV 导出和完整数据库备份。

## 启动

Windows 环境，需要 Python 3.12+、Node.js 20.19+。

双击 `start.cmd`，或运行：

```powershell
.\start.ps1
```

首次启动自动安装依赖并构建，随后访问 **http://127.0.0.1:8000**。

基础记账可独立使用。同花顺账户与交易功能需要登录下单客户端、启用本地 skill 服务，并自行安装官方 `xiadanctl.exe`。
默认从 `~/.codex/skills/xiadan-ai-selector/scripts/` 查找，也可通过 `STOCK_ASSISTANT_XIADANCTL` 指定完整路径。

## 数据与开发

账本保存在 `data/ledger.sqlite3`，个人数据、本机配置及构建产物不提交到仓库。

技术栈：React · TypeScript · FastAPI · SQLite。

[项目目录与运行规则](docs/PROJECT_STRUCTURE.md) · [维护脚本](scripts/README.md)
