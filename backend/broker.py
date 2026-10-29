"""Read-only Tonghuashun adapter. Account data is never cached or persisted."""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from .runtime import resource_root
from .broker_diagnostics import log_submit, response_shape

router = APIRouter(prefix='/api/broker', tags=['券商查询'])
QUERY_NAMES = {
    'assets', 'positions', 'orders', 'deals', 'cancelable',
    'history-deals', 'history-cash-detail', 'history-delivery',
}
QueryName = Literal['assets', 'positions', 'orders', 'deals', 'cancelable',
                    'history-deals', 'history-cash-detail', 'history-delivery']
query_slot = threading.Lock()
ROOT = resource_root()


def tool_path() -> Path | None:
    configured = os.environ.get('STOCK_ASSISTANT_XIADANCTL')
    skill_home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    candidates = [Path(configured)] if configured else [
        skill_home / 'skills' / 'xiadan-ai-selector' / 'scripts' / 'xiadanctl.exe',
        ROOT / 'xiadan-ai-selector' / 'scripts' / 'xiadanctl.exe',
    ]
    return next((path for path in candidates if path.is_file()), None)


def tool_error(document: dict) -> HTTPException:
    # Never expose a native response/error verbatim: opaque broker fields can
    # contain shareholder or account identifiers, even when their names do not.
    code = document.get('code')
    error = str(document.get('error', ''))
    if '12029' in error:
        return HTTPException(503, '无法连接同花顺，请启动并登录下单客户端，确认本地服务已开启（12029）')
    if document.get('pending') is True:
        return HTTPException(409, '同花顺正在处理查询，请稍后重新查询')
    if isinstance(code, str) and 'auth' in code.lower():
        return HTTPException(503, '同花顺授权未完成，请在下单客户端确认授权后重试')
    return HTTPException(503, '同花顺查询失败，请检查客户端登录、授权及查询提示后重试')


def run_tool(command: str, payload: dict | None = None) -> dict:
    if command != 'health' and command not in QUERY_NAMES:
        raise HTTPException(422, '不支持此查询')
    return invoke_tool(command, payload)


def invoke_tool(command: str, payload: dict | None = None, *, allow_pending: bool = False) -> dict:
    if command not in QUERY_NAMES | {'health', 'order-preview', 'order-submit', 'watchlist', 'watchlist-refresh', 'watchlist-add'}:
        raise HTTPException(422, '不支持此命令')
    tool = tool_path()
    if tool is None:
        raise HTTPException(503, '未找到同花顺交易技能，请安装 xiadan-ai-selector')
    try:
        with tempfile.TemporaryDirectory(prefix='stock-assistant-broker-') as directory:
            arguments = [str(tool), command]
            if payload is not None:
                input_path = Path(directory) / 'input.json'
                input_path.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
                arguments += ['--input', str(input_path)]
            else:
                arguments.append('--json')
            result = subprocess.run(
                arguments, capture_output=True,
                timeout=12 if command == 'health' else 95,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
            )
        try:
            document = json.loads(decode_output(result.stdout), strict=False)
        except (ValueError, TypeError):
            if command == 'order-submit':
                log_submit('invalid_json', exit_code=result.returncode,
                           stdout_bytes=len(result.stdout), stderr_bytes=len(result.stderr))
            raise HTTPException(503, '同花顺返回了无法识别的查询结果') from None
        if command == 'order-submit':
            # Capture before validation can discard an unexpected response.
            log_submit('response', exit_code=result.returncode,
                       response=response_shape(document), stderr_bytes=len(result.stderr))
        if not isinstance(document, dict):
            raise HTTPException(503, '同花顺返回了无法识别的查询结果')
        if result.returncode != 0 or document.get('ok') is not True:
            raise tool_error(document)
        business = document.get('data')
        if isinstance(business, dict) and (business.get('ok') is False or business.get('error') or (business.get('pending') is True and not allow_pending)):
            raise tool_error(business)
        return document
    except subprocess.TimeoutExpired:
        if command == 'order-submit':
            log_submit('timeout')
        raise HTTPException(504, '查询超时，请检查同花顺是否正在等待授权，再重新查询') from None
    except OSError:
        if command == 'order-submit':
            log_submit('process_error')
        raise HTTPException(503, '同花顺查询工具无法运行，请检查技能安装') from None


def decode_output(output: bytes | str) -> str:
    if isinstance(output, str):
        return output
    try:
        return output.decode('utf-8-sig')
    except UnicodeDecodeError:
        # Account/watchlist fields are emitted using the native Windows codepage.
        return output.decode('gb18030')


def health_status() -> dict:
    document = run_tool('health')
    health = document.get('data') if isinstance(document.get('data'), dict) else document
    connected = health.get('connected') is True
    native_ready = health.get('nativeReady') is True
    logged_in = health.get('loggedIn') is True
    return {
        'installed': True, 'connected': connected, 'native_ready': native_ready,
        'logged_in': logged_in, 'ready': connected and native_ready and logged_in,
        'message': '' if connected and native_ready and logged_in else '请启动并登录同花顺下单客户端',
    }


def scalar(row: dict, *keys: str) -> str | None:
    for key in keys:
        value = row.get(key)
        if isinstance(value, (str, int, float)) and not isinstance(value, bool) and str(value).strip():
            return str(value).strip()
    return None


def number(row: dict, *keys: str) -> str | None:
    value = scalar(row, *keys)
    if value is None:
        return None
    try:
        parsed = Decimal(value.replace(',', ''))
        return str(parsed) if parsed.is_finite() else None
    except InvalidOperation:
        return None


def rows_from(payload: dict, *keys: str) -> list[dict]:
    for key in keys:
        rows = payload.get(key)
        if isinstance(rows, dict):
            # Newer hosts group multiple executions/orders under each security.
            # Flatten one documented level only; malformed rows must stay errors.
            values = []
            for group in rows.values():
                if isinstance(group, dict):
                    values.append(group)
                elif isinstance(group, list):
                    values.extend(group)
                else:
                    raise HTTPException(503, '同花顺返回了无法识别的数据行')
        elif isinstance(rows, list):
            values = rows
        else:
            continue
        if any(not isinstance(row, dict) for row in values):
            raise HTTPException(503, '同花顺返回了无法识别的数据行')
        return values
    if payload.get('is_null') == '1':
        return []
    raise HTTPException(503, '同花顺返回的查询结构暂不支持，请勿将其视为空记录')


def normalized_position(row: dict) -> dict:
    return {
        'code': scalar(row, 'zqdm'), 'name': scalar(row, 'zqmc'),
        # gpye can be the opening balance; sjsl reflects intraday executions.
        'quantity': number(row, 'sjsl', 'gpye'), 'available': number(row, 'kyye'),
        'cost_price': number(row, 'cbj'), 'price': number(row, 'sj'),
        'market_value': number(row, 'sz'), 'profit': number(row, 'yk'),
    }


def normalized_record(row: dict, index: int, historical: bool, *, order: bool = False) -> dict:
    # Explicit mappings are intentional. xd_2106 / xd_2130 / xd_2908 contain
    # sensitive identifiers and must never reach a browser, export, or log.
    operation = scalar(row, 'xd_2109', 'xd_2201', 'xd_2105', 'ywmc', 'cz', 'mmlb', 'mmfx')
    side = 'buy' if operation and ('买入' in operation or operation == 'B') else (
        'sell' if operation and ('卖出' in operation or operation == 'S') else None)
    day = scalar(row, 'xd_2141', 'xd_2104', 'xd_2139', 'cjrq', 'wtrq')
    if not day and not historical:
        day = date.today().isoformat()
    if day and re.fullmatch(r'\d{8}', day):
        day = f'{day[:4]}-{day[4:6]}-{day[6:]}'
    time_value = scalar(row, 'xd_2142', 'cjsj', 'wtsj')
    if time_value and re.fullmatch(r'\d{6}', time_value):
        time_value = ':'.join((time_value[:2], time_value[2:4], time_value[4:]))
    gross = number(row, 'xd_2131', 'cjje')
    cash = number(row, 'xd_2110', 'fsje')
    fee = None
    if side and gross is not None and cash is not None:
        amount, movement = Decimal(gross), Decimal(cash)
        candidate = -movement - amount if side == 'buy' else amount - movement
        if amount >= 0 and candidate >= 0:
            fee = str(candidate)
    return {
        'id': index, 'date': day, 'time': time_value,
        'code': scalar(row, 'xd_2102', 'zqdm'), 'name': scalar(row, 'xd_2103', 'zqmc'),
        'operation': operation, 'side': side,
        'price': number(row, 'xd_2129', 'cjjg', 'wtjg', 'cjjj'),
        'quantity': number(row, 'wtsl', 'cjsl') if order else number(row, 'xd_2128', 'cjsl', 'wtsl'),
        'amount': gross, 'fee': fee, 'cash_change': cash,
        'balance': number(row, 'xd_2160', 'zjye'),
        'status': scalar(row, 'wtzt', 'ztmc', 'status'),
        'filled_quantity': number(row, 'cjsl'),
    }


def normalize_query(command: str, document: dict) -> dict:
    business = document.get('data')
    if not isinstance(business, dict) or business.get('ok') is not True:
        raise HTTPException(503, '同花顺业务查询未成功')
    account_type = business.get('account_type')
    is_credit = business.get('is_credit')
    if account_type not in ('normal', 'credit') or not isinstance(is_credit, bool):
        raise HTTPException(503, '同花顺未返回有效账户类型，请重新查询')
    if (account_type == 'credit') != is_credit:
        raise HTTPException(503, '同花顺返回的账户类型不一致，请重新查询')
    payload = business.get('data')
    if not isinstance(payload, dict):
        raise HTTPException(503, '同花顺返回了无法识别的业务结果')
    warnings = []
    if is_credit and command in ('deals', 'history-deals'):
        warnings.append('信用账户试用版成交查询可能返回空结果，请结合当日委托确认，空结果不代表没有成交。')
    result = {'query': command, 'account_type': account_type, 'is_credit': is_credit,
              'fetched_at': datetime.now().isoformat(timespec='seconds'), 'warnings': warnings}
    if command == 'assets':
        row = payload.get('money')
        if not isinstance(row, dict):
            raise HTTPException(503, '同花顺资产字段暂不支持')
        result['assets'] = {
            'total_assets': number(row, 'zzc'), 'market_value': number(row, 'zsz', 'sz'),
            'cash_balance': number(row, 'zjye'), 'available_cash': number(row, 'kyje'),
            'frozen_cash': number(row, 'djje'), 'withdrawable_cash': number(row, 'kqje'),
        }
    elif command == 'positions':
        result['rows'] = [normalized_position(row) for row in rows_from(payload, 'position')]
    else:
        keys = ('rows',) if command.startswith('history-') else (
            ('deal',) if command == 'deals' else ('fullorder', 'order', 'cancelable'))
        result['rows'] = [normalized_record(row, index, command.startswith('history-'), order=command in ('orders', 'cancelable'))
                          for index, row in enumerate(rows_from(payload, *keys))]
    return result


@router.get('/status')
def status():
    if not query_slot.acquire(blocking=False):
        raise HTTPException(409, '同花顺查询正在进行，请稍后重试')
    try:
        try:
            return health_status()
        except HTTPException as error:
            return {'installed': tool_path() is not None, 'connected': False,
                    'native_ready': False, 'logged_in': False, 'ready': False, 'message': error.detail}
    finally:
        query_slot.release()


@router.get('/{command}')
def query(command: QueryName, start_date: date | None = None, end_date: date | None = None):
    historical = command.startswith('history-')
    if historical and (start_date is None or end_date is None):
        raise HTTPException(422, '请选择历史查询的开始和结束日期')
    if historical and (start_date > end_date or end_date > date.today()):
        raise HTTPException(422, '开始日期不能晚于结束日期，结束日期不能晚于今天')
    if not historical and (start_date is not None or end_date is not None):
        raise HTTPException(422, '当日查询不接受历史日期参数')
    if not query_slot.acquire(blocking=False):
        raise HTTPException(409, '同花顺查询正在进行，请完成客户端授权或稍后重试')
    try:
        health = health_status()
        if not health['ready']:
            raise HTTPException(503, health['message'])
        payload = {'start_date': start_date.strftime('%Y%m%d'), 'end_date': end_date.strftime('%Y%m%d')} if historical else None
        document = run_tool(command, payload)
        result = normalize_query(command, document)
        if command == 'deals':
            from .broker_deal_sync import attach_actions
            attach_actions(result, rows_from(document['data']['data'], 'deal'))
        if historical:
            result.update(start_date=start_date.isoformat(), end_date=end_date.isoformat())
        return result
    finally:
        query_slot.release()
