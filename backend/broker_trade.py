"""Explicit, one-shot ordinary-account orders via the native authorized CLI."""
import secrets
import time
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import broker
from .broker_diagnostics import log_submit
from .broker_lot_links import validate_lot, save_intent, finish_intent

def same_origin(request: Request):
    origin = request.headers.get('origin')
    if origin != str(request.base_url).rstrip('/'):
        raise HTTPException(403, '真实委托仅允许从本应用页面操作')


router = APIRouter(prefix='/api/broker/trade', tags=['券商委托'], dependencies=[Depends(same_origin)])
tickets: dict[str, tuple[float, dict]] = {}


class Order(BaseModel):
    model_config = ConfigDict(extra='forbid')
    code: str = Field(pattern=r'^\d{6}$')
    side: Literal['buy', 'sell']
    price: Decimal = Field(gt=0, le=100000, decimal_places=3, allow_inf_nan=False)
    quantity: int = Field(strict=True, gt=0, le=100000000)
    buy_lot_id: int | None = Field(default=None, gt=0, strict=True)
    t_trade: bool = False
    t_buyback_price: Decimal | None = Field(default=None, gt=0, le=1000000, decimal_places=3, allow_inf_nan=False)

    @field_validator('quantity')
    @classmethod
    def board_lot(cls, value, info):
        if info.data.get('side') == 'buy' and value % 100:
            raise ValueError('买入数量应为100的倍数')
        return value

    def native(self):
        return {'code': self.code, 'side': self.side,
                'price': format(self.price, '.3f'), 'quantity': str(self.quantity)}


class Confirmation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ticket: str = Field(min_length=20, max_length=100)
    confirmed: Literal[True]

    @field_validator('confirmed', mode='before')
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError('必须明确确认真实委托')
        return value


def ready():
    health = broker.health_status()
    if not health['ready']:
        raise HTTPException(503, health['message'])
    account = broker.normalize_query('assets', broker.run_tool('assets'))
    if account['account_type'] != 'normal':
        raise HTTPException(409, '当前只支持普通账户买卖，请切换普通账户后重新预览')


def availability(payload):
    document = broker.invoke_tool('order-preview', payload)
    result = document.get('data')
    if not isinstance(result, dict) or result.get('ok') is not True:
        raise HTTPException(503, '委托预览未成功，请检查同花顺提示')
    if result.get('account_type') != 'normal' or result.get('is_credit') is not False:
        raise HTTPException(409, '账户已变化，请重新预览普通账户委托')
    if result.get('code') != payload['code'] or result.get('side') != payload['side']:
        raise HTTPException(409, '预览证券或方向不一致，已停止提交')
    available = broker.number(result, 'available_quantity')
    if available is None or Decimal(available) < Decimal(payload.get('quantity', '0')):
        raise HTTPException(409, '可交易数量不足或无法确认，请调整数量后重新预览')
    return available


class SizeRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    code: str = Field(pattern=r'^\d{6}$')
    side: Literal['buy', 'sell']
    price: Decimal = Field(gt=0, le=100000, decimal_places=3, allow_inf_nan=False)
    portion: Literal[1, 2, 3, 4] = 1


@router.post('/size')
def size(request: SizeRequest):
    acquire()
    try:
        ready()
        available = int(Decimal(availability({'code': request.code, 'side': request.side,
                                             'price': format(request.price, '.3f')})))
        quantity = available if request.side == 'sell' and request.portion == 1 else available // request.portion // 100 * 100
        return {'quantity': quantity, 'available': available, 'source': '同花顺当前普通账户'}
    finally:
        broker.query_slot.release()


def acquire():
    if not broker.query_slot.acquire(blocking=False):
        raise HTTPException(409, '同花顺正在处理其他请求，请稍后重试')


@router.post('/preview')
def preview(order: Order):
    if order.t_trade and (order.side != 'sell' or order.buy_lot_id is None):
        raise HTTPException(422, '做 T 真实卖出请先选择买入批次，以便成交同步时保留标记')
    if order.t_buyback_price is not None and not order.t_trade:
        raise HTTPException(422, '请先勾选做 T 待买回')
    acquire()
    try:
        ready()
        payload = order.native()
        if order.buy_lot_id is not None and order.side != 'sell':
            raise HTTPException(422, '只有卖出可以关联买入批次')
        validate_lot(order.code, order.buy_lot_id, order.quantity)
        available = availability(payload)
        now = time.monotonic()
        for key, (expiry, _) in list(tickets.items()):
            if expiry <= now:
                del tickets[key]
        if len(tickets) >= 100:
            raise HTTPException(429, '预览请求过多，请稍后重试')
        ticket = secrets.token_urlsafe(32)
        tickets[ticket] = (now + 30, {'native': payload, 'buy_lot_id': order.buy_lot_id,
                                    't_trade': order.t_trade, 't_buyback_price': str(order.t_buyback_price) if order.t_buyback_price is not None else None})
        return {'ticket': ticket, 'expires_in': 30, 'order': payload,
                'account_type': 'normal', 'available_quantity': available, 'buy_lot_id': order.buy_lot_id}
    finally:
        broker.query_slot.release()


@router.post('/submit')
def submit(confirmation: Confirmation):
    acquire()
    try:
        # Consume BEFORE any I/O. Neither timeout nor a retry can replay an order.
        entry = tickets.pop(confirmation.ticket, None)
        if entry is None or entry[0] <= time.monotonic():
            raise HTTPException(409, '预览已过期或已使用，请重新预览；如曾提交，请先查询委托')
        payload = entry[1]['native']
        lot_id = entry[1]['buy_lot_id']
        ready()
        availability(payload)
        validate_lot(payload['code'], lot_id, payload['quantity'])
        intent = save_intent(payload, lot_id, t_trade=entry[1].get('t_trade', False), t_buyback_price=entry[1].get('t_buyback_price'))
        try:
            result = broker.invoke_tool('order-submit', payload, allow_pending=True).get('data')
            if not isinstance(result, dict) or result.get('ok') is not True:
                raise HTTPException(503, '无法确认委托结果')
        except Exception as error:
            # Failure can occur AFTER the broker accepted the order.
            log_submit('unconfirmed', error_type=type(error).__name__,
                       http_status=error.status_code if isinstance(error, HTTPException) else None)
            try:
                finish_intent(intent)
            except Exception:
                pass  # The pre-submit intent remains persisted as unresolved.
            return {'status': 'unknown', 'message': '提交结果未确认，请先查询当日委托及成交，勿重复下单。'}
        try:
            linked = finish_intent(intent, result)
        except Exception:
            linked = False
        note = (f' 已关联买入批次 #{lot_id}，请在当日成交中手动同步。' if linked else ' 请在当日成交中选择买入批次并手动同步。') if lot_id else ''
        return {'status': 'accepted', 'message': '提交请求已受理，成交情况请查看当日委托及成交。' + note}
    finally:
        broker.query_slot.release()
