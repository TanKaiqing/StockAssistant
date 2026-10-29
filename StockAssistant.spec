# Build both EXEs from one dependency graph; only the worker has console handles.
from pathlib import Path
import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

root = Path(SPECPATH)
configured = os.environ.get('STOCK_ASSISTANT_XIADANCTL')
skill_home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
native_candidates = [Path(configured)] if configured else [
    skill_home / 'skills' / 'xiadan-ai-selector' / 'scripts' / 'xiadanctl.exe',
    root / 'xiadan-ai-selector' / 'scripts' / 'xiadanctl.exe',
]
native = next((path for path in native_candidates if path.is_file()), None)
if native is None:
    raise FileNotFoundError('Install xiadan-ai-selector or set STOCK_ASSISTANT_XIADANCTL before packaging.')
datas = [(str(root / 'dist'), 'dist'), (str(native), 'xiadan-ai-selector/scripts')]
datas += collect_data_files('webview') + collect_data_files('akshare')
datas += [(str(root / 'backend' / 'native_quote_agent.js'), 'backend')]
for package in ('pywebview', 'pythonnet', 'clr_loader', 'akshare'):
    datas += copy_metadata(package)
hidden = ['uvicorn.logging', 'uvicorn.loops.asyncio', 'uvicorn.protocols.http.h11_impl', 'uvicorn.lifespan.on',
          'backend.market_worker', 'backend.security_search', 'webview.platforms.winforms', 'webview.platforms.edgechromium']
hidden += collect_submodules('akshare')
a = Analysis([str(root / 'desktop.py')], pathex=[str(root)], binaries=[], datas=datas, hiddenimports=hidden,
             excludes=['PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'cefpython3', 'pytest', 'IPython', 'tkinter'], noarchive=False)
pyz = PYZ(a.pure)
gui = EXE(pyz, a.scripts, [], exclude_binaries=True, name='StockAssistant', debug=False,
          bootloader_ignore_signals=False, strip=False, upx=False, console=False)
worker = EXE(pyz, a.scripts, [], exclude_binaries=True, name='StockAssistantWorker', debug=False,
             bootloader_ignore_signals=False, strip=False, upx=False, console=True)
coll = COLLECT(gui, worker, a.binaries, a.datas, strip=False, upx=False, name='StockAssistant')
