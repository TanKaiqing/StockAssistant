# 项目目录

## 日常入口

| 文件 | 用途 |
| --- | --- |
| `start.cmd` / `start.ps1` | 构建前端并启动源码版 |
| `desktop.py` | 桌面窗口与本次启动的后台进程管理 |
| `package.json` | 前端依赖和构建命令 |
| `requirements.txt` | 后端依赖 |
| `requirements-desktop.txt` | 桌面打包依赖 |
| `build-portable.ps1` / `StockAssistant.spec` | 便携版构建入口与配置，明确要求打包时才运行 |

## 源码

```text
src/
  App.tsx                       页面布局、持仓及交易状态
  api.ts                        本地后端请求
  types.ts                      交易、批次及行情类型
  analytics.ts                  统计与当日复盘计算
  useQuoteStream.ts             单标的和多标的 SSE 行情订阅
  components/                   页面与界面组件
  styles.css / theme.css        公共样式与主题
backend/
  app.py                        API、数据库、费率和静态页面服务
  accounting.py                 成本、批次与已实现盈亏计算
  broker.py                     同花顺查询与字段规范化
  broker_trade.py               人工预览确认的真实委托
  broker_sync.py                历史成交预览和导入
  broker_deal_sync.py           当日成交按委托分组、原子同步与整单费用分摊
  broker_lot_links.py           真实卖出委托与买入批次关联、分笔成交匹配
  broker_diagnostics.py         order-submit 回执结构脱敏输出（不记录账号或原文）
  broker_watchlist.py           自选股同步
  quote_stream.py               主客户端桥接到 SSE 的转发及公开行情补充
  native_quote_bridge.py        共享只读报价观察与连接状态
  native_quote_agent.js         主客户端已解码报价观察脚本
  market_cache.py                行情缓存
  t_trade.py                     等量卖出买回的 Decimal 测算
  t_trade_tracking.py            做T卖出标记、跨日买回关联及实际净价差
  t_statistics.py                做T买回结算与普通卖出统计成本追踪
  t_relationships.py             做T原批次分摊明细、历史迁移和统一分位分摊
  t_order_groups.py              按已保存的委托证据汇总做T、买回候选及关联
  trade_plans.py                 独立买卖计划、状态和并发编辑校验
  runtime.py                    源码版与桌面版的路径和子进程适配
```

## 数据、工具与构建产物

订单与成交不再每 5 秒自动查询或同步。请在券商账户页面手动查询当日委托、当日成交，
点击成交条目的“同步”按钮写入账本；提交时已取得委托号的关联继续保留。

行情仅在周一至周五 UTC+8 的 09:15–11:30、13:00–15:00 持续轮询与推送，结束时刻暂停。
前端 `tradingSession.ts` 以本地时钟检查时段，暂停列表、分时、日 K 与价格轮询及 SSE，开盘自动恢复。
非交易时段打开页面、切换持仓或进入盈利达标页会单次获取行情，手动刷新同样可用，使用行情接口的 `once=true`。
返回浏览器窗口或从后台恢复可见时，非交易时段也会单次刷新持仓与待买回标的；相邻焦点/可见事件合并，不启动定时行情请求。单次刷新绕过推送跳过逻辑与报价短缓存；已有请求未结束时合并或排队一次，避免收盘取消请求后漏取。图表仅在持仓详情按需获取。
后端 `trading_session.py` 在时段外默认只返回已有缓存，单次获取可启动行情 worker，但不启动新的推送会话。
既有推送会话在收盘时结束，不调用外部服务检查节假日日历。

买入记录的 `stop_loss_percent` 默认 2%，数据库升级时已有买入记录也使用此默认值。
系统设置中的“默认止损”保存到数据库 `settings.default_stop_loss`，支持百分比、亏损金额或留空关闭。
新建买入时读取并预填；当日与历史成交同步新增买入时也使用当前默认值。保存默认值不修改已有批次。
止损支持百分比和亏损金额两种互斥模式，留空关闭。均按剩余持仓的预计净盈亏判断，包含买入费用及预计卖出佣金。
金额模式使用 `stop_loss_amount`（精度 0.01 元），按原买入数量设置，部分卖出后按剩余数量比例折算。
例如原批次设置亏损 100 元，剩余一半时以预计净亏损 50 元为止损线。旧版误称价格的字段会在启动时迁移为金额字段。
触发后，买入批次和盈利达标页面的卡片显示红色背景及“已到止损”。
卖出界面选定买入批次后，可独立保存止盈、止损参数，调用 `PATCH /api/trades/{id}/targets`，
仅修改买入批次的目标字段，不生成交易。达标提醒功能已移除，止盈止损参数及批次高亮继续保留。

当日成交手动同步支持“多批次分摊”：选择至少两个买入批次并指定各自数量，合计须等于成交数量。
使用 `trades.lot_allocations` 保存分摊明细，同一券商成交仍对应一条交易记录和一份同步去重映射。
按成交时间重算全部账本，校验指定批次可卖数量；佣金仅按整笔成交估算一次，再按数量分摊到各批次，
最后一个批次承接舍入差额。交易列表、编辑预览、CSV 导出保留多批次关系。已关联单批次委托的成交
继续遵守原批次关联；不会自动改成其他批次或多批次。

```text
data/
  ledger.sqlite3                源码版主账本
  backups/                      数据库备份
  imports/                      导入原文件
  reconciliation/               账本核对与修正记录
  logs/                         运行日志
  diagnostics/                  本地排查产物（不提交到仓库）
scripts/                        构建辅助、维护及检查脚本
tests/                          后端测试源码；前端测试随组件存放
xiadan-ai-selector/             本机自行安装的官方技能与 CLI（不提交到仓库）
dist/                           前端构建结果，供源码版后端直接提供
build/                          PyInstaller 中间产物
release/                        已有便携版与压缩包
.venv/ / node_modules/          本机依赖
```

数据目录、诊断资料、第三方工具和构建产物均通过 `.gitignore` 排除，不属于仓库源码。
历史抓包、静态分析脚本和报告已移出项目。运行时使用的行情桥接源码仍在 `backend/` 保留。
便携版默认使用 `%LOCALAPPDATA%/StockAssistant` 保存账本、日志及窗口配置；具体以便携目录的 `portable.json` 为准。

## 修改约定

- 日常修改源码后，可运行 `npm.cmd run build` 更新 `dist/`，刷新源码运行页面即可加载新界面。
- 修改后不自动运行测试；需要测试时由用户明确提出。
- 不自动重新生成便携版或压缩包；用户明确要求打包后再执行。
- 当前源码和 `dist/` 可以比 `release/` 更新。整理目录不会同步更新现有 EXE。
- 主账本、备份、导入原文件和账本核对记录不作为临时缓存清理。

脚本分工见 [scripts/README.md](../scripts/README.md)。
