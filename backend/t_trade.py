"""Read-only, equal-quantity sell-then-buy calculations in decimal money."""
from decimal import Decimal, ROUND_HALF_UP
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TTradeInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: Literal['stock', 'etf']
    sell_price: Decimal = Field(gt=0, le=1000000, decimal_places=3, allow_inf_nan=False)
    buy_price: Decimal = Field(gt=0, le=1000000, decimal_places=3, allow_inf_nan=False)
    quantity: int = Field(strict=True, gt=0, le=1_000_000_000)
    sell_extra_fee: Decimal = Field(default=Decimal('0'), ge=0, le=1000000000, decimal_places=2, allow_inf_nan=False)
    buy_extra_fee: Decimal = Field(default=Decimal('0'), ge=0, le=1000000000, decimal_places=2, allow_inf_nan=False)

    @field_validator('quantity')
    @classmethod
    def round_lot(cls, value):
        if value % 100:
            raise ValueError('等量买回数量请填写100的倍数')
        return value


def calculate_t_trade(payload, commission):
    """commission(price) uses the existing account fee settings and rounding."""
    cent, tick = Decimal('0.01'), Decimal('0.001')
    quantity = payload.quantity
    sell_commission = commission(payload.sell_price)
    sell_fee = sell_commission + payload.sell_extra_fee
    sell_gross = payload.sell_price * quantity
    proceeds = sell_gross - sell_fee

    def buy_cost(price):
        return price * quantity + commission(price) + payload.buy_extra_fee

    def amount(value):
        return str(value.quantize(cent, rounding=ROUND_HALF_UP))

    buy_commission = commission(payload.buy_price)
    buy_fee = buy_commission + payload.buy_extra_fee
    total_buy_cost = buy_cost(payload.buy_price)
    net = proceeds - total_buy_cost
    # Highest 0.001 price with a nonnegative net, including commission changes
    # and its rounding/minimum. No positive price is viable if costs exceed cash.
    low, high = 0, int(payload.sell_price / tick)
    while low < high:
        middle = (low + high + 1) // 2
        if buy_cost(tick * middle) <= proceeds:
            low = middle
        else:
            high = middle - 1
    break_even = tick * low if low else None
    scenarios = []
    for offset in ('-0.010', '-0.005', '0', '0.005', '0.010'):
        price = payload.buy_price + Decimal(offset)
        if not 0 < price <= 1000000:
            continue
        scenarios.append({'buy_price': format(price, '.3f'),
                          'net_profit': amount(proceeds - buy_cost(price)), 'selected': offset == '0'})
    return {'sell_gross': amount(sell_gross), 'buy_gross': amount(payload.buy_price * quantity),
            'sell_commission': amount(sell_commission), 'buy_commission': amount(buy_commission),
            'sell_fee': amount(sell_fee), 'buy_fee': amount(buy_fee), 'total_fee': amount(sell_fee + buy_fee),
            'sell_proceeds': amount(proceeds), 'buy_cost': amount(total_buy_cost),
            'gross_profit': amount((payload.sell_price - payload.buy_price) * quantity),
            'net_profit': amount(net),
            'price_gap': format(payload.sell_price - payload.buy_price, '.3f'),
            'break_even_buy_price': format(break_even, '.3f') if break_even else None,
            'minimum_price_gap': format(payload.sell_price - break_even, '.3f') if break_even else None,
            'scenarios': scenarios}
