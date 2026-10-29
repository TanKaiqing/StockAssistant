"""Best-effort, redacted diagnostics; never replay an order to collect a reply."""
import json
import os
import re
import threading
from datetime import datetime
from pathlib import Path

from .runtime import default_database

_lock = threading.Lock()


def response_shape(value, key='', depth=0):
    """Keep field structure, never arbitrary native text or account identifiers."""
    if depth >= 10:
        return {'type': type(value).__name__, 'truncated': True}
    if isinstance(value, dict):
        result = {}
        for index, (name, item) in enumerate(value.items()):
            if index >= 100:
                result['<truncated>'] = True
                break
            # Numeric/dynamic keys can themselves be account identifiers.
            label = name if isinstance(name, str) and re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]{0,63}', name) else f'<key-{index}>'
            result[label] = response_shape(item, str(name), depth + 1)
        return result
    if isinstance(value, list):
        return {'type': 'list', 'length': len(value),
                'items': [response_shape(item, depth=depth + 1) for item in value[:10]]}
    if value is None:
        return None
    if isinstance(value, bool) and key in {'ok', 'pending', 'accepted', 'is_credit', 'success'}:
        return value
    if isinstance(value, str) and key == 'account_type' and value in {'normal', 'credit'}:
        return value
    if isinstance(value, str):
        return {'type': 'str', 'length': len(value), 'redacted': True}
    return {'type': type(value).__name__, 'redacted': True}


def log_submit(event, **fields):
    """Fields must be local metadata or response_shape output, never raw replies."""
    try:
        line = json.dumps({'at': datetime.now().isoformat(timespec='milliseconds'),
                           'command': 'order-submit', 'event': event, **fields}, ensure_ascii=False)
        with _lock:
            directory = Path(os.environ.get('STOCK_ASSISTANT_DB', str(default_database()))).parent / 'logs'
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / 'order-submit.jsonl'
            if path.exists() and path.stat().st_size > 2_000_000:
                path.replace(directory / 'order-submit.previous.jsonl')
            with path.open('a', encoding='utf-8') as stream:
                stream.write(line + '\n')
    except Exception:
        pass  # Diagnostics must never change whether an order gets submitted.
    try:
        print('[order-submit] ' + line, flush=True)
    except Exception:
        pass
