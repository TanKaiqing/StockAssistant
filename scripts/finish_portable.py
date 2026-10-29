"""Finish the local desktop artifact without including any personal database."""
import hashlib
import json
import os
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent.parent
output = root / 'release' / 'StockAssistant'
configured = os.environ.get('STOCK_ASSISTANT_XIADANCTL')
skill_home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
native_candidates = [Path(configured)] if configured else [
    skill_home / 'skills' / 'xiadan-ai-selector' / 'scripts' / 'xiadanctl.exe',
    root / 'xiadan-ai-selector' / 'scripts' / 'xiadanctl.exe',
]
native = next((path for path in native_candidates if path.is_file()), None)
if native is None:
    raise FileNotFoundError('Install xiadan-ai-selector or set STOCK_ASSISTANT_XIADANCTL before packaging.')
packed = output / '_internal' / 'xiadan-ai-selector' / 'scripts' / 'xiadanctl.exe'
if hashlib.sha256(native.read_bytes()).digest() != hashlib.sha256(packed.read_bytes()).digest():
    raise RuntimeError('Native xiadanctl was modified during packaging')
config = {'port': 8000}
(output / 'portable.json').write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
readme = '''拾仓 StockAssistant — Windows x64 文件夹便携版

双击 StockAssistant.exe 启动，无需安装 Python 或 Node.js。
请保留 StockAssistantWorker.exe 和 _internal 文件夹；不要只复制主 EXE。
关闭窗口会停止本次启动的后台与行情订阅，不会关闭同花顺。

数据库、日志和界面配置默认保存到：
%LOCALAPPDATA%\\StockAssistant
首次运行会创建空账本；已有目标数据库时不会覆盖。
需要迁移账本时，可在 portable.json 中自行设置 first_run_import，
指向待复制的 ledger.sqlite3；原文件保持不变。
移动到其他电脑不会自动携带账本，可使用应用内完整数据库备份。

若希望数据随文件夹移动，在 portable.json 中增加：
"data_directory": "data"
此时数据保存到本文件夹的 data 目录；升级时保留该目录。

同花顺功能需要下单客户端运行、登录并启用本地 skill 服务。
官方 xiadanctl.exe 原样附带，授权仍在同花顺中完成。
Microsoft Edge WebView2 Runtime 是桌面窗口必需组件；本机已验证，
其他电脑若缺失，可从微软安装：https://developer.microsoft.com/microsoft-edge/webview2/

默认本机端口8000；若被占用，请关闭旧实例，或修改 portable.json 中的 port。
请勿同时运行旧版 start.cmd 与桌面版。
启动失败查看 logs/desktop.log 和 logs/backend.log。

打包文件不包含个人交易数据库、账号或授权信息。
'''
(output / '使用说明.txt').write_text(readme, encoding='utf-8-sig')
shutil.make_archive(str(root / 'release' / 'StockAssistant-Windows-x64'), 'zip', output.parent, output.name)
print(json.dumps({'folder': str(output), 'database_bundled': False, 'native_hash_verified': True}))
