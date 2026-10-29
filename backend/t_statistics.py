"""Statistical settlements: completed T spreads plus ordinary holding returns.

Keep a parallel carried cost so a T spread is never counted again when the
rebought shares are sold later. Actual ledger prices and realized P&L stay intact.
"""
from decimal import Decimal, ROUND_HALF_UP, localcontext

from .accounting import LedgerError
from .t_relationships import resolve_origins, link_profits


def annotate_statistics(holdings, links, order_keys=None):
    with localcontext() as ctx:
        ctx.prec = 40
        _annotate(holdings, links, order_keys or {})


def _gross(trade):
    return Decimal(trade['gross_amount']) if trade.get('gross_amount') is not None else Decimal(trade['price']) * trade['quantity']


def _annotate(holdings, links, order_keys):
    trades = sorted(holdings['trades'], key=lambda row: (row['executed_at'], row['id']))
    by_id = {trade['id']: trade for trade in trades}
    linked, used = {}, {}
    origins = resolve_origins(trades, links)
    profits = link_profits(trades, links)
    for link in links:
        linked.setdefault(link['buy_id'], []).append(link)
        used[link['sell_id']] = used.get(link['sell_id'], 0) + link['quantity']
    inventory, sold_basis, t_results = {}, {}, {}
    cent = Decimal('0.01')
    for trade in trades:
        quantity, identifier = trade['quantity'], trade['id']
        amount, fee = _gross(trade), Decimal(trade['fee'])
        events = []
        if trade['side'] == 'buy':
            actual_unit = (amount + fee) / quantity
            bought_links = linked.get(identifier, [])
            linked_quantity = sum(link['quantity'] for link in bought_links)
            if linked_quantity > quantity:
                raise LedgerError('买回关联数量超出实际买入数量')
            carried = actual_unit * (quantity - linked_quantity)
            for link in bought_links:
                sell = by_id[link['sell_id']]
                count = link['quantity']
                for part in origins[(sell['id'], identifier)]:
                    carried += sold_basis[(sell['id'], part['buy_id'])] * part['quantity']
                pnl = profits[(sell['id'], identifier)]
                events.append({'kind': 't_trade', 'sell_id': sell['id'], 'quantity': count, 'raw_profit': pnl,
                    'origins': origins[(sell['id'], identifier)]})
            transferred = 0
            for part in trade.get('restored_to', []):
                origin = inventory[part['buy_id']]
                cost = sold_basis[(part['sell_id'], part['buy_id'])] * part['quantity']
                origin['quantity'] += part['quantity']
                origin['cost'] += cost
                carried -= cost
                transferred += part['quantity']
            inventory[identifier] = {'quantity': quantity - transferred, 'cost': carried}
        else:
            cost = Decimal(0)
            for part in trade['allocations']:
                origin = inventory.get(part['buy_id'])
                if not origin or origin['quantity'] < part['quantity']:
                    raise LedgerError('做 T 统计成本与账本批次数量不一致')
                unit = origin['cost'] / origin['quantity']
                allocated = unit * part['quantity']
                origin['quantity'] -= part['quantity']
                origin['cost'] = origin['cost'] - allocated if origin['quantity'] else Decimal(0)
                cost += allocated
                if trade.get('t_trade'):
                    sold_basis[(identifier, part['buy_id'])] = unit
            if not trade.get('t_trade'):
                events.append({'kind': 'ordinary', 'quantity': quantity, 'raw_profit': amount - fee - cost})
        total = sum((event['raw_profit'] for event in events), Decimal(0)).quantize(cent, rounding=ROUND_HALF_UP)
        allocated = Decimal(0)
        for index, event in enumerate(events):
            raw = event.pop('raw_profit')
            profit = total - allocated if index == len(events) - 1 else raw.quantize(cent, rounding=ROUND_HALF_UP)
            event['profit'] = str(profit)
            allocated += profit
            parts = event.pop('origins', [])
            origin_allocated = Decimal(0)
            for part_index, part in enumerate(parts):
                result = t_results.setdefault(part['buy_id'], {'profit': Decimal(0), 'sells': set()})
                share = profit - origin_allocated if part_index == len(parts) - 1 else (
                    profit * part['quantity'] / event['quantity']).quantize(cent, rounding=ROUND_HALF_UP)
                result['profit'] += share
                result['sells'].add(order_keys.get(event['sell_id'], event['sell_id']))
                origin_allocated += share
        trade['analytics_pnl'] = str(total) if events else None
        trade['analytics_settlements'] = events
        trade['analytics_pending_quantity'] = quantity - used.get(identifier, 0) if trade['side'] == 'sell' and trade.get('t_trade') else 0

    statistical_quantity = sum(lot['quantity'] for lot in inventory.values())
    if statistical_quantity != holdings['quantity']:
        raise LedgerError('统计持仓数量与实际账本不一致')
    cost = sum((lot['cost'] for lot in inventory.values()), Decimal(0))
    holdings['analytics_cost'] = str(cost)
    holdings['analytics_average_cost'] = str(cost / statistical_quantity) if statistical_quantity else None
    holdings['analytics_realized_pnl'] = str(sum((Decimal(trade['analytics_pnl'])
        for trade in trades if trade['analytics_pnl'] is not None), Decimal(0)))
    for lot in holdings['lots']:
        result = t_results.get(lot['id'])
        lot['t_completed_profit'] = str(result['profit']) if result else '0.00'
        lot['t_completed_count'] = len(result['sells']) if result else 0
