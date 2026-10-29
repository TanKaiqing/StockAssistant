"""Windows desktop entry point. No broker orders are issued by the launcher."""
import argparse
import atexit
import contextlib
import ctypes
from ctypes import wintypes
import json
import logging
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

from backend.runtime import application_root, user_data_root, configure_frozen_subprocesses


def load_config():
    path = application_root() / 'portable.json'
    value = json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else {}
    if not isinstance(value, dict):
        raise ValueError('portable.json 格式无效')
    return value


def data_directory(config, override=None):
    value = override or config.get('data_directory')
    if value is None:
        return user_data_root()
    path = Path(os.path.expandvars(value)).expanduser()
    return path.resolve() if path.is_absolute() else (application_root() / path).resolve()


def migrate_database(source, destination):
    """Copy a consistent first-run snapshot. Never replace an existing database."""
    if destination.exists() or not source or not Path(source).is_file():
        return False
    source = Path(source).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f'.ledger-migration-{uuid.uuid4().hex}.sqlite3')
    try:
        with contextlib.closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as reader, contextlib.closing(sqlite3.connect(temporary)) as target:
            names = {row[0] for row in reader.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {'instruments', 'trades', 'settings'} <= names:
                raise ValueError('原数据库结构不匹配')
            reader.backup(target)
            if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('数据库迁移校验失败')
        # On Windows rename is atomic and refuses to replace an existing file.
        if os.name == 'nt':
            temporary.rename(destination)
        else:
            os.link(temporary, destination)
        return True
    finally:
        temporary.unlink(missing_ok=True)


class InstanceLock:
    def __init__(self):
        self.handle = None

    def acquire(self):
        if os.name != 'nt':
            return True
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        kernel.CreateMutexW.restype = wintypes.HANDLE
        self.handle = kernel.CreateMutexW(None, False, r'Local\StockAssistant.Desktop.v1')
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        return ctypes.get_last_error() != 183

    def close(self):
        if self.handle:
            ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(self.handle))
            self.handle = None


class ChildJob:
    """Kill only this launcher's service and descendants on abnormal exit."""
    def __init__(self, process):
        self.handle = None
        if os.name != 'nt':
            return
        class Basic(ctypes.Structure):
            _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64), ('flags', wintypes.DWORD),
                        ('min_working', ctypes.c_size_t), ('max_working', ctypes.c_size_t), ('active', wintypes.DWORD),
                        ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]
        class Extended(ctypes.Structure):
            _fields_ = [('basic', Basic), ('io', IO), ('process_mem', ctypes.c_size_t), ('job_mem', ctypes.c_size_t),
                        ('peak_process_mem', ctypes.c_size_t), ('peak_job_mem', ctypes.c_size_t)]
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        handle = kernel.CreateJobObjectW(None, None)
        info = Extended(); info.basic.flags = 0x2000
        if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(info), ctypes.sizeof(info)) or not kernel.AssignProcessToJobObject(handle, wintypes.HANDLE(int(process._handle))):
            if handle:
                kernel.CloseHandle(ctypes.c_void_p(handle))
            raise RuntimeError('无法建立后台进程保护，已停止启动')
        self.handle = handle

    def close(self):
        if self.handle:
            ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(self.handle))
            self.handle = None


class Service:
    def __init__(self, directory, port):
        self.directory, self.port = directory, port
        self.process = self.job = self.log = None
        self.stopping = threading.Lock()
        self.instance = uuid.uuid4().hex
        self.stop_file = self.directory / f'.desktop-stop-{self.instance}'

    def start(self):
        with socket.socket() as probe:
            if os.name == 'nt':
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                probe.bind(('127.0.0.1', self.port))
            except OSError:
                raise RuntimeError(f'端口 {self.port} 已被占用，请先关闭旧后台或在 portable.json 调整端口。') from None
        args = [str(application_root() / 'StockAssistantWorker.exe')] if getattr(sys, 'frozen', False) else [sys.executable, str(Path(__file__).resolve())]
        args += ['--worker', 'server', '--port', str(self.port)]
        self.log = (self.directory / 'logs' / 'backend.log').open('ab', buffering=0)
        environment = {**os.environ, 'STOCK_ASSISTANT_DB': str(self.directory / 'ledger.sqlite3'),
                       'STOCK_ASSISTANT_DESKTOP_INSTANCE': self.instance, 'PYTHONIOENCODING': 'utf-8'}
        environment['STOCK_ASSISTANT_STOP_FILE'] = str(self.stop_file)
        self.process = subprocess.Popen(args, cwd=application_root(), stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log,
                                       env=environment, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        try:
            self.job = ChildJob(self.process)
        except Exception:
            self.process.terminate(); self.process.wait(timeout=5)
            raise
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(150):
            if self.process.poll() is not None:
                raise RuntimeError('后台启动失败，请查看数据目录 logs/backend.log')
            try:
                with opener.open(f'http://127.0.0.1:{self.port}/api/health', timeout=.5) as response:
                    if json.load(response).get('desktop_instance') == self.instance:
                        return
            except (OSError, ValueError):
                pass
            time.sleep(.1)
        raise RuntimeError('后台启动超时，请查看数据目录 logs/backend.log')

    def stop(self):
        with self.stopping:
            if self.process:
                if self.process.poll() is None:
                    self.stop_file.touch()
                    try:
                        self.process.wait(timeout=110)
                    except subprocess.TimeoutExpired:
                        logging.warning('Backend graceful exit timed out; terminating owned job')
                if self.job:
                    self.job.close(); self.job = None
                if self.process.poll() is None:
                    self.process.terminate(); self.process.wait(timeout=5)
                self.process = None
            if self.log:
                self.log.close(); self.log = None
            self.stop_file.unlink(missing_ok=True)


def worker(arguments):
    mode, *rest = arguments
    if mode == 'server':
        parser = argparse.ArgumentParser(); parser.add_argument('--port', type=int, default=8000)
        port = parser.parse_args(rest).port
        import uvicorn
        from backend.app import app
        server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port, access_log=False, log_config=None,
                                             loop='asyncio', http='h11', ws='none', timeout_graceful_shutdown=100))
        stop_file = os.environ.get('STOCK_ASSISTANT_STOP_FILE')
        if stop_file:
            def stop_on_signal():
                while not server.should_exit:
                    if Path(stop_file).exists():
                        server.should_exit = True
                        return
                    time.sleep(.15)
            threading.Thread(target=stop_on_signal, daemon=True).start()
        server.run()
    elif mode == 'market':
        from backend.market_worker import run
        with contextlib.redirect_stdout(sys.stderr):
            result = run(rest[0], rest[1], rest[2] == '1', rest[3] == '1')
        print(json.dumps(result, ensure_ascii=True, allow_nan=False), flush=True)
    elif mode == 'search':
        from backend.security_search import search
        print(json.dumps({'candidates': search(rest[0])}, ensure_ascii=True), flush=True)
    else:
        raise ValueError('Unsupported worker mode')


def notify_error(message):
    if os.name == 'nt':
        ctypes.windll.user32.MessageBoxW(None, message, '拾仓 StockAssistant', 0x10)
    elif sys.stderr:
        print(message, file=sys.stderr)


def smoke_test(window, report):
    result = {'ok': False}
    try:
        for _ in range(100):
            state = window.evaluate_js("({ready: !!document.querySelector('.app-shell'), text: document.body.innerText, title: document.title})")
            if state and state['ready'] and '持仓总览' in state['text']:
                # No interactions with real orders. Inspect only the mounted UI.
                result = {'ok': True, 'ready': True, 'title': state['title'], 'has_record_button': '记录交易' in state['text']}
                break
            time.sleep(.2)
        if not result['ok']:
            result['error'] = 'Desktop UI did not mount before timeout'
    except Exception:
        result['error'] = 'Desktop UI inspection failed'
    finally:
        Path(report).write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
        window.destroy()


def main():
    configure_frozen_subprocesses()
    if len(sys.argv) > 1 and sys.argv[1] == '--worker':
        worker(sys.argv[2:]); return
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir'); parser.add_argument('--port', type=int)
    parser.add_argument('--smoke-test', metavar='REPORT')
    options = parser.parse_args()
    lock, service = InstanceLock(), None
    try:
        if not lock.acquire():
            notify_error('StockAssistant 已在运行，请切换到已打开的窗口。'); return
        config = load_config()
        directory = data_directory(config, options.data_dir)
        (directory / 'logs').mkdir(parents=True, exist_ok=True)
        logging.basicConfig(filename=directory / 'logs' / 'desktop.log', encoding='utf-8', level=logging.INFO,
                            format='%(asctime)s %(levelname)s %(message)s')
        port = options.port or int(config.get('port', 8000))
        if not 1024 <= port <= 65535:
            raise ValueError('端口必须在1024至65535之间')
        migrate_database(config.get('first_run_import'), directory / 'ledger.sqlite3')
        service = Service(directory, port); atexit.register(service.stop); service.start()
        import webview
        webview.settings['ALLOW_DOWNLOADS'] = True
        webview.settings['ALLOW_FILE_URLS'] = False
        window = webview.create_window('拾仓 StockAssistant', f'http://127.0.0.1:{port}', width=1280, height=860,
                                       min_size=(960, 640), background_color='#f6f7fb')
        window.events.closed += service.stop
        if options.smoke_test:
            window.events.loaded += lambda: threading.Thread(target=smoke_test, args=(window, options.smoke_test), daemon=True).start()
        webview.start(gui='edgechromium', private_mode=False, storage_path=str(directory / 'webview'))
    except Exception as error:
        logging.exception('Desktop startup failed')
        message = str(error) if isinstance(error, (RuntimeError, ValueError, PermissionError)) else '请确认已安装 Microsoft Edge WebView2 Runtime'
        notify_error(f'程序启动失败：{message}\n详细日志：数据目录 logs/desktop.log')
        return 1
    finally:
        if service:
            service.stop()
        lock.close()


if __name__ == '__main__':
    import multiprocessing
    multiprocessing.freeze_support()
    sys.exit(main() or 0)
