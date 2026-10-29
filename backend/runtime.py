"""Shared paths and subprocess entry points for source and frozen builds."""
import os
import sys
import subprocess
import threading
from pathlib import Path


def resource_root():
    return Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent.parent))


def application_root():
    return Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else resource_root()


def user_data_root():
    return Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData' / 'Local'))) / 'StockAssistant'


def default_database():
    return (user_data_root() if getattr(sys, 'frozen', False) else resource_root() / 'data') / 'ledger.sqlite3'


def worker_command(module, *arguments):
    modes = {'backend.market_worker': 'market', 'backend.security_search': 'search'}
    if module not in modes:
        raise ValueError('Unsupported worker')
    if getattr(sys, 'frozen', False):
        return [str(application_root() / 'StockAssistantWorker.exe'), '--worker', modes[module], *map(str, arguments)]
    return [sys.executable, '-m', module, *map(str, arguments)]


def configure_frozen_subprocesses():
    """Detach new EXEs from PyInstaller's bootloader state and DLL search path."""
    if not getattr(sys, 'frozen', False) or os.name != 'nt' or getattr(subprocess.Popen, '_stock_launcher', False):
        return
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetDllDirectoryW.argtypes = [wintypes.DWORD, wintypes.LPWSTR]
    kernel.SetDllDirectoryW.argtypes = [wintypes.LPCWSTR]
    original = subprocess.Popen
    launch_lock = threading.RLock()

    class FrozenPopen(original):
        _stock_launcher = True

        def __init__(self, *args, **kwargs):
            kwargs['env'] = {**(kwargs.get('env') or os.environ), 'PYINSTALLER_RESET_ENVIRONMENT': '1'}
            if kwargs.get('stdin') is None:
                kwargs['stdin'] = subprocess.DEVNULL
            with launch_lock:
                directory = ctypes.create_unicode_buffer(32768)
                kernel.GetDllDirectoryW(len(directory), directory)
                kernel.SetDllDirectoryW(None)
                try:
                    super().__init__(*args, **kwargs)
                finally:
                    kernel.SetDllDirectoryW(directory.value or None)

    subprocess.Popen = FrozenPopen
