from __future__ import annotations

import csv
import io
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
from contextlib import contextmanager, asynccontextmanager
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP, ROUND_CEILING, localcontext
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator

from .accounting import calculate, LedgerError, reference_unit_cost
from .security_search import SEARCH_PATTERN
from .broker import router as broker_router
from .broker_trade import router as broker_trade_router
from .broker_sync import router as broker_sync_router
from .broker_deal_sync import router as broker_deal_sync_router
from .broker_watchlist import router as broker_watchlist_router
from .market_cache import MarketBusy, MarketCache
from .quote_stream import quote_events
from .native_quote_bridge import native_bridge
from .trading_session import is_trading_session
from .runtime import resource_root, default_database, worker_command
from .t_trade import TTradeInput, calculate_t_trade
from .t_trade_tracking import router as t_tracking_router, validate_links, refresh_restorations
from .t_statistics import annotate_statistics
from .t_relationships import migrate_relationships, load_links
from .trade_plans import router as trade_plans_router, initialize as initialize_trade_plans
from .broker_deal_sync import initialize as initialize_deal_groups
from .t_order_groups import order_keys

ROOT = resource_root()
DB_PATH = Path(os.environ.get('STOCK_ASSISTANT_DB', str(default_database())))
@asynccontextmanager
async def lifespan(_app):
    try:
        yield
    finally:
        native_bridge.close()


app = FastAPI(title='拾仓 StockAssistant', docs_url='/api/docs', lifespan=lifespan)
app.include_router(broker_trade_router)
app.include_router(broker_sync_router)
app.include_router(broker_deal_sync_router)
app.include_router(broker_watchlist_router)
app.include_router(broker_router)
app.include_router(t_tracking_router)
app.include_router(trade_plans_router)


@contextmanager
def db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA foreign_keys = ON')
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db():
    with db() as connection:
        connection.executescript('''
          CREATE TABLE IF NOT EXISTS instruments (
            code TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL REFERENCES instruments(code),
            side TEXT NOT NULL CHECK(side IN ('buy','sell')),
            executed_at TEXT NOT NULL, price TEXT NOT NULL,
            quantity INTEGER NOT NULL CHECK(quantity > 0), fee TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '', buy_lot_id INTEGER
          );
          CREATE INDEX IF NOT EXISTS trade_order ON trades(code, executed_at, id);
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS broker_imports (
            source_key TEXT PRIMARY KEY,
            trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS broker_order_intents (
            id TEXT PRIMARY KEY, code TEXT NOT NULL, buy_lot_id INTEGER NOT NULL,
            submitted_at TEXT NOT NULL, price TEXT NOT NULL, quantity INTEGER NOT NULL,
            status TEXT NOT NULL, order_key TEXT UNIQUE
          );
          CREATE TABLE IF NOT EXISTS broker_intent_fills (
            source_key TEXT PRIMARY KEY,
            intent_id TEXT NOT NULL REFERENCES broker_order_intents(id),
            trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE
          );
        ''')
        if 'gross_amount' not in {row['name'] for row in connection.execute('PRAGMA table_info(trades)')}:
            connection.execute('ALTER TABLE trades ADD COLUMN gross_amount TEXT')
        columns = {row['name'] for row in connection.execute('PRAGMA table_info(trades)')}
        for column, declaration in {'t_trade': 'INTEGER NOT NULL DEFAULT 0', 't_buyback_price': 'TEXT', 't_restore_allocations': 'TEXT'}.items():
            if column not in columns:
                connection.execute(f'ALTER TABLE trades ADD COLUMN {column} {declaration}')
        connection.execute('''CREATE TABLE IF NOT EXISTS t_buyback_links (
            sell_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
            buy_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
            quantity INTEGER NOT NULL CHECK(quantity > 0), PRIMARY KEY(sell_id,buy_id))''')
        if 'restore_allocations' not in {row['name'] for row in connection.execute('PRAGMA table_info(t_buyback_links)')}:
            connection.execute('ALTER TABLE t_buyback_links ADD COLUMN restore_allocations TEXT')
        if 'lot_allocations' not in columns:
            connection.execute('ALTER TABLE trades ADD COLUMN lot_allocations TEXT')
        if 'stop_loss_percent' not in columns:
            connection.execute("ALTER TABLE trades ADD COLUMN stop_loss_percent TEXT DEFAULT '2'")
        if 'stop_loss_amount' not in columns:
            if 'stop_loss_price' in columns:
                # The user's former "price" input meant loss in yuan.
                connection.execute('ALTER TABLE trades RENAME COLUMN stop_loss_price TO stop_loss_amount')
            else:
                connection.execute('ALTER TABLE trades ADD COLUMN stop_loss_amount TEXT')
        for column in ('target_profit_percent', 'target_profit_amount'):
            if column not in columns:
                connection.execute(f'ALTER TABLE trades ADD COLUMN {column} TEXT')
        if 'target_sell_reminder' not in columns:
            connection.execute('ALTER TABLE trades ADD COLUMN target_sell_reminder INTEGER NOT NULL DEFAULT 0')
        intent_columns = {row['name'] for row in connection.execute('PRAGMA table_info(broker_order_intents)')}
        for column, declaration in {
            'broker_filled': 'INTEGER NOT NULL DEFAULT 0',
            'broker_canceled': 'INTEGER NOT NULL DEFAULT 0',
            'broker_state': "TEXT NOT NULL DEFAULT ''",
            'status_checked_at': 'TEXT',
            'sync_error': "TEXT NOT NULL DEFAULT ''",
            'orders_before_submit': 'TEXT',
            't_trade': 'INTEGER NOT NULL DEFAULT 0',
            't_buyback_price': 'TEXT',
        }.items():
            if column not in intent_columns:
                connection.execute(f'ALTER TABLE broker_order_intents ADD COLUMN {column} {declaration}')
        migrate_relationships(connection)
        for row in connection.execute('SELECT DISTINCT b.code FROM t_buyback_links l JOIN trades b ON b.id=l.buy_id').fetchall():
            refresh_restorations(connection, row['code'])
        validate_links(connection)
        initialize_trade_plans(connection)
        initialize_deal_groups(connection)


init_db()


class InstrumentInput(BaseModel):
    code: str = Field(pattern=r'^\d{6}$')
    name: str = Field(min_length=1, max_length=40)
    kind: Literal['stock', 'etf'] = 'stock'

    @field_validator('name')
    @classmethod
    def strip_name(cls, value):
        if not value.strip():
            raise ValueError('名称不能为空')
        return value.strip()


class CommissionRule(BaseModel):
    commission_rate: Decimal = Field(ge=0, le=10000, max_digits=12, decimal_places=6)
    minimum_fee: Decimal = Field(ge=0, max_digits=12, decimal_places=2)


class FeeSettingsInput(BaseModel):
    stock: CommissionRule
    etf: CommissionRule


class FeeEstimateInput(BaseModel):
    kind: Literal['stock', 'etf']
    price: Decimal = Field(gt=0, max_digits=18, decimal_places=8)
    quantity: int = Field(gt=0, le=1_000_000_000, strict=True)


def commission_fee(price, quantity, rule):
    commission = max(price * quantity * Decimal(rule['commission_rate']) / Decimal(10000), Decimal(rule['minimum_fee']))
    return commission.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


class SizeInput(BaseModel):
    code: str = Field(pattern=r'^\d{6}$')
    side: Literal['buy', 'sell']
    price: Decimal = Field(gt=0, max_digits=18, decimal_places=8)
    portion: Literal[1, 2, 3, 4] = 1
    budget: Decimal | None = Field(default=None, ge=0, max_digits=18, decimal_places=2)
    manual_fee: Decimal | None = Field(default=None, ge=0, max_digits=18, decimal_places=8)
    executed_at: datetime
    exclude_trade_id: int | None = Field(default=None, gt=0)
    buy_lot_id: int | None = Field(default=None, gt=0)


@app.post('/api/trades/size')
def size_trade(payload: SizeInput):
    with db() as connection:
        instrument = connection.execute('SELECT kind FROM instruments WHERE code=?', (payload.code,)).fetchone()
        if not instrument:
            raise HTTPException(404, '标的不存在')
        if payload.executed_at.tzinfo is not None:
            raise HTTPException(422, '请使用本地交易时间')
        if payload.exclude_trade_id:
            original = connection.execute('SELECT code FROM trades WHERE id=?', (payload.exclude_trade_id,)).fetchone()
            if not original or original['code'] != payload.code:
                raise HTTPException(422, '编辑的交易与标的不匹配')
        with localcontext() as ctx:
            ctx.prec = 40
            if payload.side == 'sell':
                boundary = payload.executed_at.isoformat(timespec='seconds')
                rows = [dict(row) for row in connection.execute('SELECT * FROM trades WHERE code=?', (payload.code,))]
                rows = [row for row in rows if row['executed_at'] < boundary or
                        (row['executed_at'] == boundary and (payload.exclude_trade_id is None or row['id'] < payload.exclude_trade_id))]
                rows = [row for row in rows if row['id'] != payload.exclude_trade_id]
                try:
                    holdings = calculate(rows)
                except LedgerError as exc:
                    raise HTTPException(422, str(exc)) from exc
                available = sum(lot['remaining'] for lot in holdings['lots']
                                if payload.buy_lot_id is None or lot['id'] == payload.buy_lot_id)
                quantity = available if payload.portion == 1 else available // payload.portion // 100 * 100
                return {'quantity': quantity, 'available': available}
            rule = fee_settings(connection)[instrument['kind']]
            budget = payload.budget if payload.budget is not None else Decimal(account_settings(connection)['available_cash'])
            limit = budget / payload.portion
            low, high = 0, min(int(limit / payload.price // 100), 10_000_000)
            while low < high:
                mid = (low + high + 1) // 2
                quantity = mid * 100
                fee = payload.manual_fee if payload.manual_fee is not None else commission_fee(payload.price, quantity, rule)
                if payload.price * quantity + fee <= limit:
                    low = mid
                else:
                    high = mid - 1
            return {'quantity': low * 100, 'budget': str(limit)}


def fee_settings(connection):
    row = connection.execute("SELECT value FROM settings WHERE key='commission'").fetchone()
    return json.loads(row['value']) if row else {
        'stock': {'commission_rate': '0', 'minimum_fee': '0'},
        'etf': {'commission_rate': '0', 'minimum_fee': '0'},
    }


class AccountSettingsInput(BaseModel):
    available_cash: Decimal = Field(ge=0, max_digits=18, decimal_places=2)


def account_settings(connection):
    row = connection.execute("SELECT value FROM settings WHERE key='account'").fetchone()
    return json.loads(row['value']) if row else {'available_cash': '0'}


@app.get('/api/settings/account')
def get_account_settings():
    with db() as connection:
        return account_settings(connection)


@app.put('/api/settings/account')
def save_account_settings(payload: AccountSettingsInput):
    settings = payload.model_dump(mode='json')
    with db() as connection:
        connection.execute("INSERT INTO settings(key,value) VALUES ('account',?) "
                           "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(settings),))
    return settings


@app.get('/api/settings/fees')
def get_fee_settings():
    with db() as connection:
        return fee_settings(connection)


@app.put('/api/settings/fees')
def save_fee_settings(payload: FeeSettingsInput):
    settings = payload.model_dump(mode='json')
    with db() as connection:
        connection.execute("INSERT INTO settings(key,value) VALUES ('commission',?) "
                           "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(settings),))
    return settings


@app.post('/api/fees/estimate')
def estimate_fee(payload: FeeEstimateInput):
    with db() as connection:
        rule = fee_settings(connection)[payload.kind]
    with localcontext() as ctx:
        ctx.prec = 40
        return {'fee': str(commission_fee(payload.price, payload.quantity, rule))}


@app.post('/api/analysis/t-trade')
def estimate_t_trade(payload: TTradeInput):
    with db() as connection:
        rule = fee_settings(connection)[payload.kind]
    with localcontext() as ctx:
        ctx.prec = 40
        result = calculate_t_trade(payload, lambda price: commission_fee(price, payload.quantity, rule))
    return {**result, 'commission_rule': rule}


class StopLossSettingsInput(BaseModel):
    model_config = {'extra': 'forbid'}
    stop_loss_percent: Decimal | None = Field(default=Decimal('2'), gt=0, le=100, decimal_places=4)
    stop_loss_amount: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=2)

    @model_validator(mode='after')
    def exclusive_mode(self):
        if self.stop_loss_percent is not None and self.stop_loss_amount is not None:
            raise ValueError('默认止损只能选择百分比或亏损金额中的一种')
        return self


def stop_loss_settings(connection):
    row = connection.execute("SELECT value FROM settings WHERE key='default_stop_loss'").fetchone()
    return StopLossSettingsInput.model_validate(json.loads(row['value']) if row else {}).model_dump(mode='json')


def default_stop_loss_values(connection, side):
    settings = stop_loss_settings(connection) if side == 'buy' else {}
    return settings.get('stop_loss_percent'), settings.get('stop_loss_amount')


@app.get('/api/settings/stop-loss')
def get_stop_loss_settings():
    with db() as connection:
        return stop_loss_settings(connection)


@app.put('/api/settings/stop-loss')
def save_stop_loss_settings(payload: StopLossSettingsInput):
    settings = payload.model_dump(mode='json')
    with db() as connection:
        connection.execute("INSERT INTO settings(key,value) VALUES ('default_stop_loss',?) "
                           'ON CONFLICT(key) DO UPDATE SET value=excluded.value', (json.dumps(settings),))
    return settings


class TradeInput(BaseModel):
    code: str = Field(pattern=r'^\d{6}$')
    side: Literal['buy', 'sell']
    executed_at: datetime
    price: Decimal = Field(gt=0, max_digits=18, decimal_places=8)
    quantity: int = Field(gt=0, le=1_000_000_000, strict=True)
    fee: Decimal = Field(ge=0, max_digits=18, decimal_places=8)
    note: str = Field(default='', max_length=500)
    buy_lot_id: int | None = Field(default=None, gt=0)
    target_profit_percent: Decimal | None = Field(default=None, ge=0, le=1000000, decimal_places=4)
    target_profit_amount: Decimal | None = Field(default=None, ge=0, max_digits=18, decimal_places=2)
    stop_loss_percent: Decimal | None = Field(default=Decimal('2'), gt=0, le=100, decimal_places=4)
    stop_loss_amount: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=2)
    t_trade: bool = False
    t_buyback_price: Decimal | None = Field(default=None, gt=0, le=1000000, decimal_places=3, allow_inf_nan=False)

    @model_validator(mode='after')
    def validate_target(self):
        if self.side != 'sell' and (self.t_trade or self.t_buyback_price is not None):
            raise ValueError('做 T 待买回标记只适用于卖出记录')
        if self.t_buyback_price is not None and not self.t_trade:
            raise ValueError('请先勾选做 T 待买回')
        if self.stop_loss_amount is not None and self.stop_loss_percent is not None:
            if 'stop_loss_percent' not in self.model_fields_set:
                self.stop_loss_percent = None
            else:
                raise ValueError('止损只能选择百分比或亏损金额中的一种')
        targets = (self.target_profit_percent, self.target_profit_amount)
        if all(target is not None for target in targets):
            raise ValueError('期望盈利只能选择盈利率或金额中的一种')
        if self.side == 'sell' and any(target is not None for target in targets):
            raise ValueError('期望盈利目标只适用于买入记录')
        return self

    @field_validator('executed_at')
    @classmethod
    def local_time(cls, value):
        if value.tzinfo is not None:
            raise ValueError('请使用本地交易时间，不含时区偏移')
        return value

    def values(self):
        if self.side == 'buy' and self.buy_lot_id is not None:
            raise HTTPException(422, '买入不能指定卖出批次')
        return (self.code, self.side, self.executed_at.isoformat(timespec='seconds'),
                str(self.price), self.quantity, str(self.fee), self.note, self.buy_lot_id,
                str(self.target_profit_percent) if self.target_profit_percent is not None else None,
                str(self.target_profit_amount) if self.target_profit_amount is not None else None,
                0,  # Retired reminder column retained for database compatibility.
                str(self.stop_loss_percent) if self.side == 'buy' and self.stop_loss_percent is not None else None,
                str(self.stop_loss_amount) if self.side == 'buy' and self.stop_loss_amount is not None else None,
                self.t_trade, str(self.t_buyback_price) if self.t_buyback_price is not None else None)


def ledger(connection, code):
    rows = [dict(row) for row in connection.execute('SELECT * FROM trades WHERE code=?', (code,))]
    try:
        result = calculate(rows)
        from .broker_lot_links import lot_order_markers
        markers = lot_order_markers(connection, code)
        for lot in result['lots']:
            if lot['remaining'] > 0 and lot['id'] in markers:
                lot['sell_order'] = markers[lot['id']]
        return result
    except LedgerError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get('/api/targets/{code}')
def profit_targets(code: str, price: Decimal = Query(gt=0, max_digits=18, decimal_places=8)):
    with db() as connection:
        instrument = connection.execute('SELECT kind FROM instruments WHERE code=?', (code,)).fetchone()
        if not instrument:
            raise HTTPException(404, '标的不存在')
        holdings = ledger(connection, code)
        rule = fee_settings(connection)[instrument['kind']]
    targets, valuations = [], []
    with localcontext() as ctx:
        ctx.prec = 40
        for lot in holdings['lots']:
            percent, amount = lot.get('target_profit_percent'), lot.get('target_profit_amount')
            if lot['remaining'] <= 0:
                continue
            cost = reference_unit_cost(lot) * lot['remaining']
            fee = commission_fee(price, lot['remaining'], rule)
            pnl = price * lot['remaining'] - fee - cost
            stop_percent = lot.get('stop_loss_percent')
            stop_target_amount = lot.get('stop_loss_amount')
            stop_amount = (Decimal(stop_target_amount) * lot['remaining'] / lot['quantity']
                           if stop_target_amount is not None else
                           cost * Decimal(stop_percent) / 100 if stop_percent is not None else None)
            valuation = {'lot_id': lot['id'], 'profit': str(pnl),
                         'profit_percent': str(pnl / cost * 100), 'estimated_sell_fee': str(fee),
                         'stop_loss_reached': stop_amount is not None and pnl <= -stop_amount,
                         'stop_loss_amount': str(stop_amount) if stop_amount is not None else None}
            valuations.append(valuation)
            if percent is None and amount is None:
                continue
            target = cost * Decimal(percent) / 100 if percent is not None else Decimal(amount) * lot['remaining'] / lot['quantity']
            targets.append({'lot_id': lot['id'], 'reached': pnl >= target,
                            'profit': str(pnl), 'profit_percent': str(pnl / cost * 100),
                            'target_profit': str(target), 'estimated_sell_fee': str(fee)})
    return {'price': str(price), 'targets': targets, 'valuations': valuations}


class SellPreviewInput(TradeInput):
    side: Literal['sell'] = 'sell'
    editing_id: int | None = Field(default=None, gt=0)


@app.post('/api/trades/preview')
def preview_sell(payload: SellPreviewInput):
    with db() as connection:
        if not connection.execute('SELECT 1 FROM instruments WHERE code=?', (payload.code,)).fetchone():
            raise HTTPException(404, '标的不存在')
        rows = [dict(row) for row in connection.execute('SELECT * FROM trades WHERE code=?', (payload.code,))]
        original = None
        if payload.editing_id:
            original = next((row for row in rows if row['id'] == payload.editing_id), None)
            if original is None:
                raise HTTPException(422, '编辑的交易与标的不匹配')
        identifier = payload.editing_id or connection.execute('SELECT COALESCE(MAX(id),0)+1 FROM trades').fetchone()[0]
        date = payload.executed_at.isoformat(timespec='seconds')
        previous = [row for row in rows if row['id'] != payload.editing_id and (row['executed_at'], row['id']) < (date, identifier)]
        amount = original['gross_amount'] if original and payload.price == Decimal(original['price']) and payload.quantity == original['quantity'] else None
        candidate = {**payload.model_dump(mode='json'), 'id': identifier, 'executed_at': date, 'gross_amount': amount}
        if original and payload.buy_lot_id is None:
            candidate['lot_allocations'] = original.get('lot_allocations')
        try:
            result = calculate([*previous, candidate])['trades'][0]
        except LedgerError as exc:
            raise HTTPException(422, str(exc)) from exc
        with localcontext() as ctx:
            ctx.prec = 40
            gross = Decimal(amount) if amount is not None else payload.price * payload.quantity
            pnl = Decimal(result['realized_pnl'])
            cost = gross - payload.fee - pnl
            return {key: str(value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)) for key, value in {
                'realized_pnl': pnl, 'buy_cost': cost, 'sell_amount': gross, 'sell_fee': payload.fee,
            }.items()}


class TargetSellPriceInput(BaseModel):
    code: str = Field(pattern=r'^\d{6}$')
    buy_lot_id: int = Field(gt=0)
    quantity: int = Field(strict=True, gt=0, le=1_000_000_000)
    executed_at: datetime
    editing_id: int | None = Field(default=None, gt=0)
    manual_fee: Decimal | None = Field(default=None, ge=0, max_digits=18, decimal_places=8)

    @field_validator('executed_at')
    @classmethod
    def local_time(cls, value):
        if value.tzinfo is not None:
            raise ValueError('请使用本地交易时间')
        return value


@app.post('/api/trades/target-price')
def target_sell_price(payload: TargetSellPriceInput):
    with db() as connection:
        instrument = connection.execute('SELECT kind FROM instruments WHERE code=?', (payload.code,)).fetchone()
        if not instrument:
            raise HTTPException(404, '标的不存在')
        rows = [dict(row) for row in connection.execute('SELECT * FROM trades WHERE code=?', (payload.code,))]
        if payload.editing_id and not any(row['id'] == payload.editing_id for row in rows):
            raise HTTPException(422, '编辑的交易与标的不匹配')
        identifier = payload.editing_id or connection.execute('SELECT COALESCE(MAX(id),0)+1 FROM trades').fetchone()[0]
        moment = payload.executed_at.isoformat(timespec='seconds')
        previous = [row for row in rows if row['id'] != payload.editing_id and (row['executed_at'], row['id']) < (moment, identifier)]
        try:
            lots = calculate(previous)['lots']
        except LedgerError as exc:
            raise HTTPException(422, str(exc)) from None
        lot = next((lot for lot in lots if lot['id'] == payload.buy_lot_id), None)
        if not lot or lot['remaining'] < payload.quantity:
            raise HTTPException(422, '该交易时间下，指定批次的可卖数量不足')
        percent, amount = lot.get('target_profit_percent'), lot.get('target_profit_amount')
        if percent is None and amount is None:
            raise HTTPException(422, '该买入批次尚未设置盈利目标')
        rule = fee_settings(connection)[instrument['kind']]
    with localcontext() as context:
        context.prec = 40
        cost = reference_unit_cost(lot) * payload.quantity
        target = cost * Decimal(percent) / 100 if percent is not None else Decimal(amount) * payload.quantity / lot['quantity']
        required = cost + target
        if payload.manual_fee is not None:
            gross = required + payload.manual_fee
        else:
            rate = Decimal(rule['commission_rate']) / 10000
            if rate >= 1:
                raise HTTPException(422, '当前佣金设置下无法计算达标价格，请检查费率')
            gross = max(required + Decimal(rule['minimum_fee']), required / (1 - rate))
        price = (gross / payload.quantity).quantize(Decimal('0.001'), rounding=ROUND_CEILING)
        if payload.manual_fee is None and price * payload.quantity - commission_fee(price, payload.quantity, rule) < required:
            # Account for commission rounding only if the first price falls short.
            gross = max(required + Decimal(rule['minimum_fee']), (required + Decimal('0.005')) / (1 - rate))
            price = (gross / payload.quantity).quantize(Decimal('0.001'), rounding=ROUND_CEILING)
        if price <= 0 or price > 100000:
            raise HTTPException(422, '计算出的达标价超出支持范围，请核对盈利目标和费用')
        fee = payload.manual_fee if payload.manual_fee is not None else commission_fee(price, payload.quantity, rule)
        return {'price': str(price), 'estimated_fee': str(fee), 'target_profit': str(target),
                'estimated_profit': str(price * payload.quantity - fee - cost)}


@app.get('/api/health')
def health():
    return {'status': 'ok', **({'desktop_instance': os.environ['STOCK_ASSISTANT_DESKTOP_INSTANCE']}
                             if os.environ.get('STOCK_ASSISTANT_DESKTOP_INSTANCE') else {})}


@app.get('/api/portfolio')
def portfolio():
    with db() as connection:
        instruments = []
        grouped_orders = order_keys(connection)
        for row in connection.execute('SELECT * FROM instruments ORDER BY created_at, code'):
            item = {**dict(row), **ledger(connection, row['code'])}
            try:
                links = load_links(connection, row['code'])
                annotate_statistics(item, links, grouped_orders)
            except (LedgerError, KeyError, ValueError) as error:
                item['analytics_error'] = str(error) if isinstance(error, LedgerError) else '做 T 关联或成本数据不完整，请核对买回记录'
            instruments.append(item)
        return {'instruments': instruments}


@app.post('/api/instruments', status_code=201)
def add_instrument(payload: InstrumentInput):
    with db() as connection:
        try:
            connection.execute('INSERT INTO instruments(code,name,kind) VALUES (?,?,?)',
                               (payload.code, payload.name, payload.kind))
        except sqlite3.IntegrityError:
            raise HTTPException(409, '该股票或 ETF 已在列表中')
    return payload.model_dump()


@app.delete('/api/instruments/{code}', status_code=204)
def remove_instrument(code: str):
    with db() as connection:
        if connection.execute('SELECT 1 FROM trades WHERE code=?', (code,)).fetchone():
            raise HTTPException(409, '请先删除该标的的交易记录')
        cursor = connection.execute('DELETE FROM instruments WHERE code=?', (code,))
        if cursor.rowcount == 0:
            raise HTTPException(404, '标的不存在')


class LotTargetsInput(BaseModel):
    model_config = {'extra': 'forbid'}
    target_profit_percent: Decimal | None = Field(ge=0, le=1000000, decimal_places=4)
    target_profit_amount: Decimal | None = Field(ge=0, max_digits=18, decimal_places=2)
    stop_loss_percent: Decimal | None = Field(gt=0, le=100, decimal_places=4)
    stop_loss_amount: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=2)

    @model_validator(mode='after')
    def single_profit_target(self):
        if self.target_profit_percent is not None and self.target_profit_amount is not None:
            raise ValueError('止盈只能设置盈利率或金额中的一种')
        if self.stop_loss_percent is not None and self.stop_loss_amount is not None:
            raise ValueError('止损只能选择百分比或亏损金额中的一种')
        return self


@app.patch('/api/trades/{trade_id}/targets')
def update_lot_targets(trade_id: int, payload: LotTargetsInput):
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        trade = connection.execute('SELECT side FROM trades WHERE id=?', (trade_id,)).fetchone()
        if not trade:
            raise HTTPException(404, '买入批次不存在')
        if trade['side'] != 'buy':
            raise HTTPException(422, '止盈止损只能设置在买入批次上')
        values = [str(value) if value is not None else None for value in (
            payload.target_profit_percent, payload.target_profit_amount, payload.stop_loss_percent, payload.stop_loss_amount)]
        connection.execute('''UPDATE trades SET target_profit_percent=?,target_profit_amount=?,stop_loss_percent=?,stop_loss_amount=?
            WHERE id=?''', (*values, trade_id))
    return {'id': trade_id, **payload.model_dump(mode='json')}


@app.post('/api/trades', status_code=201)
def add_trade(payload: TradeInput):
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        if payload.side == 'buy' and not {'stop_loss_percent', 'stop_loss_amount'} & payload.model_fields_set:
            payload = TradeInput.model_validate({**payload.model_dump(), **stop_loss_settings(connection)})
        if not connection.execute('SELECT 1 FROM instruments WHERE code=?', (payload.code,)).fetchone():
            raise HTTPException(404, '请先添加股票或 ETF')
        cursor = connection.execute('''INSERT INTO trades
          (code,side,executed_at,price,quantity,fee,note,buy_lot_id,target_profit_percent,target_profit_amount,target_sell_reminder,stop_loss_percent,stop_loss_amount,t_trade,t_buyback_price)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', payload.values())
        ledger(connection, payload.code)
        validate_links(connection)
        return {'id': cursor.lastrowid}


@app.put('/api/trades/{trade_id}')
def edit_trade(trade_id: int, payload: TradeInput):
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        original = connection.execute('SELECT code,price,quantity,gross_amount,lot_allocations FROM trades WHERE id=?', (trade_id,)).fetchone()
        if not original:
            raise HTTPException(404, '交易不存在')
        if original['code'] != payload.code:
            raise HTTPException(422, '不能修改交易所属标的')
        amount = original['gross_amount'] if payload.price == Decimal(original['price']) and payload.quantity == original['quantity'] else None
        allocations = original['lot_allocations'] if payload.side == 'sell' and payload.buy_lot_id is None else None
        connection.execute('''UPDATE trades SET code=?,side=?,executed_at=?,price=?,quantity=?,fee=?,note=?,buy_lot_id=?,target_profit_percent=?,target_profit_amount=?,target_sell_reminder=?,stop_loss_percent=?,stop_loss_amount=?,t_trade=?,t_buyback_price=?,gross_amount=?,lot_allocations=?
                              WHERE id=?''', (*payload.values(), amount, allocations, trade_id))
        ledger(connection, payload.code)
        validate_links(connection)
    return {'id': trade_id}


@app.delete('/api/trades/{trade_id}', status_code=204)
def delete_trade(trade_id: int):
    with db() as connection:
        connection.execute('BEGIN IMMEDIATE')
        row = connection.execute('SELECT code FROM trades WHERE id=?', (trade_id,)).fetchone()
        if not row:
            raise HTTPException(404, '交易不存在')
        try:
            connection.execute('DELETE FROM trades WHERE id=?', (trade_id,))
        except sqlite3.IntegrityError:
            raise HTTPException(409, '该买入批次仍被做 T 分摊引用，请先解除对应买回关联') from None
        refresh_restorations(connection, row['code'])
        ledger(connection, row['code'])
        validate_links(connection)


@app.get('/api/export')
def export():
    with db() as connection:
        t_links = {}
        for link in load_links(connection):
            t_links.setdefault(link['buy_id'], []).append({'sell_id': link['sell_id'], 'quantity': link['quantity'],
                'origins': link['origin_allocations'], 'restored': bool(link['restore_allocations'])})
        rows = connection.execute('''SELECT t.*,i.name,i.kind FROM trades t
            JOIN instruments i ON i.code=t.code ORDER BY t.executed_at,t.id''').fetchall()
        stream = io.StringIO()
        writer = csv.writer(stream)
        writer.writerow(['记录ID', '证券代码', '证券名称', '类型', '买卖方向', '交易时间', '成交价', '数量', '成交金额', '总费用', '指定买入ID', '期望盈利率(%)', '期望盈利金额(元)', '备注', '多批次分摊', '止损目标(%)', '止损金额(元)', '做T卖出', '期望买回价', '原批次恢复分摊', '做T买回关系明细'])
        for row in rows:
            values = [row['id'], row['code'], row['name'], row['kind'], row['side'], row['executed_at'],
                      row['price'], row['quantity'], row['gross_amount'] if row['gross_amount'] is not None else str(Decimal(row['price']) * row['quantity']),
                      row['fee'], row['buy_lot_id'], row['target_profit_percent'], row['target_profit_amount'], row['note'], row['lot_allocations'], row['stop_loss_percent'] if row['side'] == 'buy' else None, row['stop_loss_amount'] if row['side'] == 'buy' else None, row['t_trade'], row['t_buyback_price'], row['t_restore_allocations']]
            values.append(json.dumps(t_links.get(row['id'], []), ensure_ascii=False))
            # Avoid evaluating user text as spreadsheet formulas on opening an export.
            writer.writerow(["'" + v if isinstance(v, str) and v.startswith(('=', '+', '-', '@', '\t', '\r')) else v for v in values])
        return Response(stream.getvalue().encode('utf-8-sig'), media_type='text/csv',
                        headers={'Content-Disposition': 'attachment; filename="stock-assistant-trades.csv"'})


@app.get('/api/backup')
def backup():
    # SQLite's backup API produces a consistent snapshot even during writes.
    with db() as connection:
        target = sqlite3.connect(':memory:')
        try:
            connection.backup(target)
            data = target.serialize()
        finally:
            target.close()
    return Response(data, media_type='application/octet-stream',
                    headers={'Content-Disposition': 'attachment; filename="ledger-backup.sqlite3"'})


market_cache = MarketCache()
native_bridge.publish = lambda code, quote: market_cache.publish_quote(code, quote) if quote else None
security_search_cache = {}
security_search_lock = threading.Lock()
security_search_slots = threading.BoundedSemaphore(2)


@app.get('/api/instruments/search')
def search_instruments(q: str = Query(pattern=SEARCH_PATTERN)):
    with security_search_lock:
        cached = security_search_cache.get(q)
        if cached and time.monotonic() - cached[0] < 3600:
            return cached[1]
    if not security_search_slots.acquire(blocking=False):
        raise HTTPException(503, '名称查询繁忙，可稍后重试或手动填写')
    try:
        process = subprocess.run(worker_command('backend.security_search', q),
            cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=10,
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if process.returncode != 0:
            raise HTTPException(503, '名称查询暂不可用，可手动填写名称')
        result = json.loads(process.stdout)
        with security_search_lock:
            if len(security_search_cache) >= 128:
                security_search_cache.pop(next(iter(security_search_cache)))
            security_search_cache[q] = (time.monotonic(), result)
        return result
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        raise HTTPException(503, '名称查询超时，可重试或手动填写名称')
    finally:
        security_search_slots.release()


@app.get('/api/market/bridge/status')
def market_bridge_status(codes: str = Query(default='', max_length=1399)):
    with db() as connection:
        names = {row['code']: row['name'] for row in connection.execute('SELECT code, name FROM instruments')}
    if codes:
        requested = list(dict.fromkeys(codes.split(',')))
        if len(requested) > 200 or any(code not in names for code in requested):
            raise HTTPException(422, '请使用账本中已添加的证券代码')
        native_bridge.watch(requested)
    result = native_bridge.status()
    for quote in result['quotes']:
        quote['name'] = names.get(quote['code'], quote['code'])
    return result


@app.get('/api/market/{code}')
def market(code: str, history: bool = False, intraday: bool = False, once: bool = False, depth: bool = False):
    with db() as connection:
        instrument = connection.execute('SELECT kind FROM instruments WHERE code=?', (code,)).fetchone()
    if not instrument:
        raise HTTPException(404, '标的不存在')
    native_bridge.watch([code])
    def fetch(need_history, need_intraday):
        process = subprocess.run(
            worker_command('backend.market_worker', code, instrument['kind'], str(int(need_history)), str(int(need_intraday))),
            cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=22,
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        )
        if process.returncode != 0:
            raise HTTPException(503, '行情服务暂不可用；记账功能不受影响')
        result = json.loads(process.stdout)
        native_bridge.baseline(code, result.get('quote'))
        bridged = native_bridge.quote(code, result.get('quote'))
        if bridged:
            result.update(source=bridged['source'], quote=bridged)
            result['warnings'] = [w for w in result.get('warnings', []) if w not in ('最新行情获取失败', '五档盘口暂无可用数据')]
        return result
    try:
        if depth and (once or is_trading_session()):
            # An explicit depth refresh must not be satisfied by a price-only push.
            if not market_cache.slots.acquire(blocking=False):
                raise MarketBusy()
            try:
                result = fetch(False, False)
            finally:
                market_cache.slots.release()
            if result.get('quote'):
                market_cache.publish_quote(code, result['quote'])
            return result
        if (not once and is_trading_session() and native_bridge.quote(code)
                and native_bridge.baseline_age(code) >= 15
                and market_cache.slots.acquire(blocking=False)):
            try:
                if native_bridge.claim_baseline(code):
                    try:
                        metadata = fetch(False, False)
                        if metadata.get('quote'):
                            market_cache.publish_quote(code, metadata['quote'])
                    except (HTTPException, subprocess.TimeoutExpired, json.JSONDecodeError):
                        # Native prices remain usable if an optional depth lookup fails.
                        pass
            finally:
                market_cache.slots.release()
        result = market_cache.get(code, history, intraday, fetch, refresh=once or is_trading_session(), force_quote=once)
        bridged = native_bridge.quote(code, result.get('quote'))
        if bridged:
            result.update(source=bridged['source'], quote=bridged)
        return result
    except MarketBusy:
        raise HTTPException(503, '行情请求繁忙，请稍后刷新')
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        raise HTTPException(503, '行情请求超时；请稍后重试')


@app.get('/api/market/quotes/stream')
async def market_quotes_stream(request: Request, codes: str = Query(min_length=6, max_length=1399)):
    securities = list(dict.fromkeys(codes.split(',')))
    if len(securities) > 200 or any(len(code) != 6 or not code.isascii() or not code.isdigit() for code in securities):
        raise HTTPException(422, '请选择 1 到 200 个有效证券代码')
    with db() as connection:
        known = {row['code'] for row in connection.execute('SELECT code FROM instruments')}
    if any(code not in known for code in securities):
        raise HTTPException(404, '订阅包含不存在的标的')
    return StreamingResponse(
        quote_events(securities, request.is_disconnected, market_cache.publish_quote),
        media_type='text/event-stream', headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'},
    )


@app.get('/api/market/{code}/stream')
async def market_stream(code: str, request: Request):
    with db() as connection:
        instrument = connection.execute('SELECT code FROM instruments WHERE code=?', (code,)).fetchone()
    if not instrument:
        raise HTTPException(404, '标的不存在')
    return StreamingResponse(
        quote_events(code, request.is_disconnected, market_cache.publish_quote),
        media_type='text/event-stream', headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'},
    )


if (ROOT / 'dist').exists():
    app.mount('/', StaticFiles(directory=ROOT / 'dist', html=True), name='frontend')
