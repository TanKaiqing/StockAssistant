"""Configured quote hours in exchange time; does not query a calendar service."""
from datetime import datetime, timedelta, timezone

EXCHANGE_TIME = timezone(timedelta(hours=8))


def is_trading_session():
    now = datetime.now(EXCHANGE_TIME)
    minute = now.hour * 60 + now.minute
    return now.weekday() < 5 and (555 <= minute < 690 or 780 <= minute < 900)
