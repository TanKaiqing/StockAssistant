"""Group ledger fills only by persisted, unambiguous broker order evidence."""
from decimal import Decimal


def order_keys(connection):
    candidates = {}
    for row in connection.execute('''SELECT i.trade_id,m.order_group FROM broker_deal_metadata m
        JOIN broker_imports i ON i.source_key=m.source_key WHERE m.order_group IS NOT NULL'''):
        candidates.setdefault(row['trade_id'], set()).add(row['order_group'])
    # Older app-submitted sells can also be grouped by their saved intent.
    intents = {}
    for row in connection.execute('SELECT trade_id,intent_id FROM broker_intent_fills'):
        intents.setdefault(row['trade_id'], set()).add('intent:' + row['intent_id'])
    for identifier, values in intents.items():
        candidates.setdefault(identifier, values)
    return {row['id']: f"{row['code']}:{row['side']}:{row['executed_at'][:10]}:"
            + (next(iter(candidates[row['id']])) if len(candidates.get(row['id'], [])) == 1 else f"trade:{row['id']}")
            for row in connection.execute('SELECT id,code,side,executed_at FROM trades')}


def members(connection, trade_id, side):
    keys = order_keys(connection)
    return [dict(row) for row in connection.execute('SELECT * FROM trades WHERE side=? ORDER BY executed_at,id', (side,))
            if trade_id in keys and keys[row['id']] == keys[trade_id]]


def grouped(rows, keys):
    groups = {}
    for row in rows:
        groups.setdefault(keys[row['id']], []).append(row)
    return [sorted(group, key=lambda row: (row['executed_at'], row['id'])) for group in groups.values()]


def aggregate_plans(plans, buys, rows, keys):
    """Preserve fill IDs for writes; expose one representative ID for each card."""
    result = []
    for group in grouped(plans, keys):
        first = group[0]
        origins, links = {}, {}
        total_amount = sum((Decimal(item['gross_amount']) for item in group), Decimal(0))
        total_quantity = sum(item['quantity'] for item in group)
        targets = {item['target_price'] for item in group}
        proceeds = Decimal(0)
        for item in group:
            proceeds += (Decimal(item['gross_amount']) - Decimal(item['fee'])) * item['remaining'] / item['quantity']
            for origin in item['origins']:
                combined = origins.setdefault(origin['buy_id'], {**origin, 'quantity': 0, 'available': 0, 'restored': 0})
                for field in ('quantity', 'available', 'restored'):
                    combined[field] += origin[field]
            for link in item['links']:
                key = keys[link['buy_id']]
                combined = links.setdefault(key, {'buy_id': link['buy_id'], 'buy_ids': set(), 'quantity': 0,
                    'executed_at': link['executed_at'], 'amount': Decimal(0), 'restored': {}, 'all_restored': True})
                combined['buy_ids'].add(link['buy_id'])
                combined['quantity'] += link['quantity']
                buy = rows[link['buy_id']]
                amount = Decimal(buy['gross_amount']) if buy.get('gross_amount') is not None else Decimal(buy['price']) * buy['quantity']
                combined['amount'] += amount * link['quantity'] / buy['quantity']
                combined['all_restored'] = combined['all_restored'] and bool(link['restore_allocations'])
                for part in link['restore_allocations']:
                    combined['restored'][part['buy_id']] = combined['restored'].get(part['buy_id'], 0) + part['quantity']
        result.append({**first, 'id': min(item['id'] for item in group), 'sell_ids': [item['id'] for item in group],
            'last_id': group[-1]['id'], 'executed_at': group[-1]['executed_at'], 'quantity': total_quantity,
            'gross_amount': str(total_amount), 'price': str(total_amount / total_quantity),
            'fee': str(sum((Decimal(item['fee']) for item in group), Decimal(0))),
            'remaining': sum(item['remaining'] for item in group),
            'matched_quantity': sum(item['matched_quantity'] for item in group),
            'net_profit': str(sum((Decimal(item['net_profit']) for item in group), Decimal(0))),
            'target_price': next(iter(targets)) if len(targets) == 1 else None,
            'remaining_proceeds': str(proceeds), 'origins': list(origins.values()),
            'links': [{'buy_id': min(item['buy_ids']), 'buy_ids': sorted(item['buy_ids']),
                'quantity': item['quantity'], 'executed_at': item['executed_at'],
                'price': str(item['amount'] / item['quantity']), 'all_restored': item['all_restored'],
                'restore_allocations': [{'buy_id': identifier, 'quantity': quantity} for identifier, quantity in item['restored'].items()]}
                for item in links.values()]})
    buy_result = []
    for group in grouped(buys, keys):
        quantity = sum(item['available'] for item in group)
        buy_result.append({**group[0], 'id': min(item['id'] for item in group), 'buy_ids': [item['id'] for item in group],
            'available': quantity, 'price': str(sum((Decimal(item['price']) * item['available'] for item in group), Decimal(0)) / quantity)})
    result.sort(key=lambda item: (item['remaining'] > 0, item['executed_at'], item['id']), reverse=True)
    return result, buy_result
