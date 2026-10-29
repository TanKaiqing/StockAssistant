"""Local trading intentions, independent of fills and brokerage orders."""
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


router = APIRouter(prefix='/api/trade-plans', tags=['交易计划'])


def initialize(connection):
    connection.execute('''CREATE TABLE IF NOT EXISTS trade_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('stock','etf')),
        side TEXT NOT NULL CHECK(side IN ('buy','sell')),
        price TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0),
        plan_date TEXT, note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0))''')


def local_origin(request: Request):
    if request.headers.get('origin') != str(request.base_url).rstrip('/'):
        raise HTTPException(403, '请从本应用页面管理交易计划')


class PlanInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    code: str = Field(pattern=r'^[0-9]{6}$')
    name: str = Field(min_length=1, max_length=40)
    kind: Literal['stock', 'etf']
    side: Literal['buy', 'sell']
    price: Decimal = Field(gt=0, le=1000000, max_digits=12, decimal_places=3, allow_inf_nan=False)
    quantity: int = Field(strict=True, gt=0, le=1_000_000_000)
    plan_date: date | None = None
    note: str = Field(default='', max_length=1000)

    @field_validator('name', 'note', mode='before')
    @classmethod
    def trim(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode='after')
    def buy_quantity(self):
        if self.side == 'buy' and self.quantity % 100:
            raise ValueError('计划买入数量须为 100 的整数倍')
        return self

    def values(self):
        return (self.code, self.name, self.kind, self.side, str(self.price), self.quantity,
                self.plan_date.isoformat() if self.plan_date else None, self.note)


class PlanEdit(PlanInput):
    revision: int = Field(strict=True, gt=0)


class PlanStatus(BaseModel):
    model_config = ConfigDict(extra='forbid')
    status: Literal['pending', 'completed', 'cancelled']
    revision: int = Field(strict=True, gt=0)


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def check_change(connection, plan_id, cursor):
    if cursor.rowcount:
        return
    if not connection.execute('SELECT 1 FROM trade_plans WHERE id=?', (plan_id,)).fetchone():
        raise HTTPException(404, '交易计划不存在')
    raise HTTPException(409, '这张计划已更新，请刷新后重试')


@router.get('')
def list_plans():
    from .app import db
    with db() as connection:
        return {'plans': [dict(row) for row in connection.execute('''SELECT * FROM trade_plans
            ORDER BY status='pending' DESC, plan_date IS NULL, plan_date, created_at DESC, id DESC''')]}


@router.post('', status_code=201, dependencies=[Depends(local_origin)])
def create_plan(payload: PlanInput):
    from .app import db
    with db() as connection:
        now = timestamp()
        cursor = connection.execute('''INSERT INTO trade_plans
            (code,name,kind,side,price,quantity,plan_date,note,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)''', (*payload.values(), now, now))
        return dict(connection.execute('SELECT * FROM trade_plans WHERE id=?', (cursor.lastrowid,)).fetchone())


@router.put('/{plan_id}', dependencies=[Depends(local_origin)])
def edit_plan(plan_id: int, payload: PlanEdit):
    from .app import db
    with db() as connection:
        cursor = connection.execute('''UPDATE trade_plans SET code=?,name=?,kind=?,side=?,price=?,quantity=?,
            plan_date=?,note=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?''',
            (*payload.values(), timestamp(), plan_id, payload.revision))
        check_change(connection, plan_id, cursor)
        return dict(connection.execute('SELECT * FROM trade_plans WHERE id=?', (plan_id,)).fetchone())


@router.patch('/{plan_id}/status', dependencies=[Depends(local_origin)])
def change_status(plan_id: int, payload: PlanStatus):
    from .app import db
    with db() as connection:
        cursor = connection.execute('''UPDATE trade_plans SET status=?,updated_at=?,revision=revision+1
            WHERE id=? AND revision=?''', (payload.status, timestamp(), plan_id, payload.revision))
        check_change(connection, plan_id, cursor)
        return dict(connection.execute('SELECT * FROM trade_plans WHERE id=?', (plan_id,)).fetchone())


@router.delete('/{plan_id}', status_code=204, dependencies=[Depends(local_origin)])
def delete_plan(plan_id: int, revision: int = Query(gt=0)):
    from .app import db
    with db() as connection:
        cursor = connection.execute('DELETE FROM trade_plans WHERE id=? AND revision=?', (plan_id, revision))
        check_change(connection, plan_id, cursor)
