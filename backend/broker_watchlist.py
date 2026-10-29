import re
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import broker
from .broker_sync import kind_for
from .broker_trade import acquire, same_origin

router = APIRouter(prefix='/api/broker/watchlist', tags=['自选同步'])


def ready():
    if not broker.health_status()['ready']:
        raise HTTPException(503, '请启动并登录同花顺')


def read():
    result = broker.invoke_tool('watchlist').get('data')
    if not isinstance(result, dict) or result.get('ok') is not True or not isinstance(result.get('items'), dict):
        raise HTTPException(503, '同花顺自选股结构暂不支持')
    rows, skipped = [], 0
    for code, name in result['items'].items():
        kind = kind_for(code, name) if isinstance(name, str) and name.strip() and re.fullmatch(r'\d{6}', code) else None
        if kind:
            rows.append({'code': code, 'name': name.strip()[:40], 'kind': kind})
        else:
            skipped += 1
    return {'rows': rows, 'skipped_count': skipped}


@router.get('')
def listing():
    from .app import db
    acquire()
    try:
        ready(); result = read()
    finally:
        broker.query_slot.release()
    with db() as connection:
        known = {row[0] for row in connection.execute('SELECT code FROM instruments')}
    return {**result, 'rows': [{**row, 'in_ledger': row['code'] in known} for row in result['rows']]}


@router.post('/refresh', dependencies=[Depends(same_origin)])
def refresh():
    acquire()
    try:
        ready()
        broker.invoke_tool('watchlist-refresh', {'force': True}, allow_pending=True)
    finally:
        broker.query_slot.release()
    # Refresh is asynchronous. Return the cache with an explicit refresh state.
    return {'requested': True, 'message': '已请求刷新，请稍后重新读取自选股'}


class Selection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    codes: list[str] = Field(min_length=1, max_length=200)


@router.post('/import', dependencies=[Depends(same_origin)])
def import_selection(request: Selection):
    from .app import db
    if any(not re.fullmatch(r'\d{6}', code) for code in request.codes):
        raise HTTPException(422, '证券代码格式无效')
    acquire()
    try:
        ready(); rows = {row['code']: row for row in read()['rows']}
    finally:
        broker.query_slot.release()
    if any(code not in rows for code in request.codes):
        raise HTTPException(409, '自选列表已变化或包含不支持的标的，请重新读取')
    inserted = 0
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        for code in dict.fromkeys(request.codes):
            row = rows[code]
            cursor = connection.execute('INSERT OR IGNORE INTO instruments(code,name,kind) VALUES (?,?,?)', (code, row['name'], row['kind']))
            inserted += cursor.rowcount
    return {'inserted': inserted}


class Security(BaseModel):
    model_config = ConfigDict(extra='forbid')
    code: str = Field(pattern=r'^\d{6}$')


@router.post('/add', dependencies=[Depends(same_origin)])
def add(request: Security):
    acquire()
    try:
        ready()
        # Let the native host resolve the market. Do not guess a market ID.
        result = broker.invoke_tool('watchlist-add', {'code': request.code}, allow_pending=True).get('data')
        if not isinstance(result, dict) or result.get('ok') is not True:
            raise HTTPException(503, '加入自选请求未成功')
        broker.invoke_tool('watchlist-refresh', {'force': True}, allow_pending=True)
        for attempt in range(3):
            if attempt:
                time.sleep(.4)
            try:
                if any(row['code'] == request.code for row in read()['rows']):
                    return {'confirmed': True, 'message': '已确认在同花顺自选中'}
            except HTTPException as error:
                if error.status_code != 409:
                    raise
        return {'confirmed': False, 'message': '请求已发出，尚未确认加入，请稍后重新读取自选股'}
    finally:
        broker.query_slot.release()
