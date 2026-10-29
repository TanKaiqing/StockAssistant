# 脚本索引

从项目根目录执行脚本，Python 使用 `.venv/Scripts/python.exe`。

| 脚本 | 用途 |
| --- | --- |
| `finish_portable.py` | 打包末尾生成配置、使用说明和便携版压缩包，由 `build-portable.ps1` 调用 |
| `check_portable.py` | 源码或桌面后台的只读连通检查，使用隔离账本，输出到 `data/diagnostics/desktop-qa/` |
| `check_live_market.py` | 可选的真实行情连通检查，使用临时账本 |
| `restore_broker_records.py` | 从券商导出数据恢复账本；应用模式会写数据库并备份 |
| `reconcile_broker_trades.py` | 券商记录与账本核对、修正；应用模式会写数据库并备份 |

检查、测试、恢复和打包脚本均不在普通前端构建中自动执行。实际参数以脚本定义为准。
运行资料的目录见 [项目目录](../docs/PROJECT_STRUCTURE.md)。
