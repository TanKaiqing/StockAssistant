"""Read-only checks of desktop helpers against an isolated ledger copy."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from desktop import migrate_database, ChildJob

parser = argparse.ArgumentParser()
parser.add_argument('--source', action='store_true')
parser.add_argument('--folder', type=Path, default=ROOT / 'release' / 'StockAssistant')
args = parser.parse_args()
folder = args.folder.resolve()
qa = ROOT / 'data' / 'diagnostics' / 'desktop-qa'
qa.mkdir(parents=True, exist_ok=True)
database = qa / 'verification.sqlite3'
migrate_database(ROOT / 'data' / 'ledger.sqlite3', database)
signal = qa / f'.verify-stop-{os.getpid()}'
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
command = [sys.executable, str(ROOT / 'desktop.py')] if args.source else [str(folder / 'StockAssistantWorker.exe')]
command += ['--worker', 'server', '--port', str(port)]
environment = {**os.environ, 'STOCK_ASSISTANT_DB': str(database), 'STOCK_ASSISTANT_STOP_FILE': str(signal), 'PYTHONIOENCODING': 'utf-8'}
if not args.source:
    environment['STOCK_ASSISTANT_XIADANCTL'] = str(folder / '_internal' / 'xiadan-ai-selector' / 'scripts' / 'xiadanctl.exe')
report = {}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
base = f'http://127.0.0.1:{port}'
with (qa / ('source-api.log' if args.source else 'frozen-api.log')).open('wb') as log:
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                               cwd=ROOT if args.source else folder, env=environment,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    job = ChildJob(process)
    try:
        for _ in range(150):
            if process.poll() is not None:
                raise RuntimeError('Desktop helper exited during startup')
            try:
                with opener.open(base + '/api/health', timeout=1) as response:
                    assert json.load(response)['status'] == 'ok'
                break
            except OSError:
                time.sleep(.1)
        for route in ('/api/portfolio', '/api/instruments/search?q=513310', '/api/market/513310?history=true', '/api/broker/status', '/api/backup', '/api/export'):
            with opener.open(base + route, timeout=35) as response:
                if route.endswith('/backup'):
                    value = {'sqlite_header': response.read().startswith(b'SQLite format 3')}
                    assert value['sqlite_header']
                elif route.endswith('/export'):
                    value = {'bom': response.read().startswith(b'\xef\xbb\xbf')}
                    assert value['bom']
                else:
                    data = json.load(response)
                    if '/market/' in route:
                        value = {'source': data['source'], 'daily_source': data.get('history_source'), 'bars': len(data['history']), 'quote': data['quote'] is not None}
                        assert value['quote'] and value['bars']
                    elif 'search?' in route:
                        value = {'count': len(data['candidates'])}; assert value['count']
                    elif route.endswith('/portfolio'):
                        value = {'trades': sum(len(row['trades']) for row in data['instruments'])}
                    else:
                        value = {'ready': data['ready']}; assert value['ready']
                report[route] = value
                print(json.dumps({route: value}, ensure_ascii=True), flush=True)
        with opener.open(base + '/api/market/513310/stream', timeout=15) as response:
            received = False
            fallback = False
            for _ in range(15):
                line = response.readline().decode()
                if not line:
                    break
                if line.startswith('event: quote'):
                    received = True; break
                if line.startswith('data:'):
                    data = json.loads(line[5:])
                    fallback = fallback or data.get('status') == 'fallback'
            report['sse'] = {'quote_received': received, 'fallback': fallback}
            assert received or fallback, 'Neither native updates nor fallback state was received'
        print(json.dumps({'sse': report['sse']}), flush=True)
    finally:
        signal.touch()
        try:
            process.wait(timeout=20)
        finally:
            job.close()
            if process.poll() is None:
                process.terminate(); process.wait(timeout=5)
            signal.unlink(missing_ok=True)
    report['exit_code'] = process.returncode
    (qa / ('source-api-report.json' if args.source else 'frozen-api-report.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Service stopped:', process.returncode == 0, flush=True)
