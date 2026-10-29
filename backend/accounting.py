"""Rebuild holdings from the immutable ordering of the editable trade ledger."""
import json
from decimal import Decimal, localcontext, ROUND_DOWN


class LedgerError(ValueError):
    pass


def reference_unit_cost(lot):
    """Restored lots keep their original basis for price goals, not accounting."""
    value = lot.get('original_unit_cost', lot['unit_cost']) if lot.get('t_restored_quantity') else lot['unit_cost']
    return Decimal(value)


def calculate(trades):
    with localcontext() as ctx:
        ctx.prec = 40
        return _calculate(trades)


def _calculate(trades):
    lots = []
    realized = Decimal(0)
    results = []
    restored_counts = {}
    for trade in sorted(trades, key=lambda t: (t['executed_at'], t['id'])):
        quantity = int(trade['quantity'])
        price, fee = Decimal(trade['price']), Decimal(trade['fee'])
        amount = Decimal(trade['gross_amount']) if trade.get('gross_amount') is not None else price * quantity
        result = dict(trade)
        result['realized_pnl'] = None
        result['allocations'] = []
        if trade['side'] == 'buy':
            restoration = trade.get('t_restore_allocations') or []
            if isinstance(restoration, str):
                try:
                    restoration = json.loads(restoration)
                except ValueError:
                    raise LedgerError('原批次恢复数据无法识别') from None
            if (not isinstance(restoration, list) or any(not isinstance(item, dict)
                    or type(item.get('sell_id')) is not int or type(item.get('buy_id')) is not int
                    or type(item.get('quantity')) is not int or item['quantity'] <= 0 for item in restoration)
                    or sum(item['quantity'] for item in restoration) > quantity):
                raise LedgerError('原批次恢复数量无效或超过实际买回数量')
            transferred = 0
            result['restored_to'] = []
            for item in restoration:
                origin = next((lot for lot in lots if lot['id'] == item['buy_id']), None)
                sold = next((row for row in results if row['id'] == item['sell_id'] and row['side'] == 'sell' and row.get('t_trade')), None)
                used = item['quantity']
                maximum = sum(part['quantity'] for part in sold['allocations'] if part['buy_id'] == item['buy_id']) if sold else 0
                restoration_key = (item['sell_id'], item['buy_id'])
                if not origin or not sold or restored_counts.get(restoration_key, 0) + used > maximum:
                    raise LedgerError('恢复数量超过原卖出批次分摊，或买回发生在卖出之前')
                restored_counts[restoration_key] = restored_counts.get(restoration_key, 0) + used
                actual_cost = (amount + fee) * used / quantity
                combined_cost = origin['unit_cost'] * origin['remaining'] + actual_cost
                origin['remaining'] += used
                origin['unit_cost'] = combined_cost / origin['remaining']
                origin['t_restored_quantity'] = origin.get('t_restored_quantity', 0) + used
                origin['t_last_buyback_price'] = str(price)
                origin['t_last_buyback_id'] = trade['id']
                origin['t_last_buyback_at'] = trade['executed_at']
                origin.setdefault('t_restore_history', []).append({**item, 'actual_buy_id': trade['id'],
                    'price': str(price), 'executed_at': trade['executed_at']})
                result['restored_to'].append(dict(item))
                transferred += used
            lots.append({
                'id': trade['id'], 'executed_at': trade['executed_at'],
                'quantity': quantity, 'remaining': quantity - transferred, 'price': str(price),
                't_transferred_quantity': transferred,
                'fee': str(fee), 'unit_cost': (amount + fee) / quantity,
                'original_unit_cost': str((amount + fee) / quantity),
                'target_profit_percent': trade.get('target_profit_percent'),
                'target_profit_amount': trade.get('target_profit_amount'),
                'stop_loss_percent': trade.get('stop_loss_percent', '2'),
                'stop_loss_amount': trade.get('stop_loss_amount'),
            })
        else:
            selected = trade.get('buy_lot_id')
            specified = trade.get('lot_allocations')
            if isinstance(specified, str):
                try:
                    specified = json.loads(specified)
                except ValueError:
                    raise LedgerError('多批次分摊数据无法识别，请核对交易记录') from None
            if specified:
                if (selected is not None or not isinstance(specified, list)
                        or any(not isinstance(item, dict) or type(item.get('buy_id')) is not int
                               or type(item.get('quantity')) is not int or item['quantity'] <= 0 for item in specified)
                        or len({item['buy_id'] for item in specified}) != len(specified)
                        or sum(item['quantity'] for item in specified) != quantity):
                    raise LedgerError('多批次分摊的数量必须为正整数、批次不能重复，合计须等于卖出数量')
                selected_lots = {lot['id']: lot for lot in lots}
                if any(item['buy_id'] not in selected_lots or selected_lots[item['buy_id']]['remaining'] < item['quantity']
                       for item in specified):
                    raise LedgerError('分摊批次在卖出时不存在或可卖数量不足，请核对时间和数量')
                cost, allocated_fee = Decimal(0), Decimal(0)
                allocated_amount = Decimal(0)
                for index, item in enumerate(specified):
                    lot, used = selected_lots[item['buy_id']], item['quantity']
                    part_fee = fee - allocated_fee if index == len(specified) - 1 else (fee * used / quantity).quantize(Decimal('0.00000001'), rounding=ROUND_DOWN)
                    part_amount = amount - allocated_amount if index == len(specified) - 1 else amount * used / quantity
                    part_cost = lot['unit_cost'] * used
                    lot['remaining'] -= used
                    cost += part_cost
                    allocated_fee += part_fee
                    allocated_amount += part_amount
                    result['allocations'].append({'buy_id': lot['id'], 'quantity': used,
                                                  'fee': str(part_fee), 'realized_pnl': str(part_amount - part_fee - part_cost)})
                result['lot_allocations'] = specified
                pnl = amount - fee - cost
                realized += pnl
                result['realized_pnl'] = str(pnl)
                results.append(result)
                continue
            candidates = [lot for lot in lots if lot['remaining'] > 0 and (selected is None or lot['id'] == selected)]
            if sum(lot['remaining'] for lot in candidates) < quantity:
                label = '指定买入批次的可卖数量不足，或该买入发生在卖出之后' if selected else '卖出时持仓不足'
                raise LedgerError(f"{trade['executed_at'][:10]}：{label}（卖出 {quantity} 股/份）。请检查时间和数量。")
            remaining, cost = quantity, Decimal(0)
            for lot in candidates:
                used = min(remaining, lot['remaining'])
                cost += lot['unit_cost'] * used
                lot['remaining'] -= used
                remaining -= used
                result['allocations'].append({'buy_id': lot['id'], 'quantity': used})
                if remaining == 0:
                    break
            pnl = amount - fee - cost
            realized += pnl
            result['realized_pnl'] = str(pnl)
        results.append(result)
    quantity = sum(lot['remaining'] for lot in lots)
    cost = sum((lot['unit_cost'] * lot['remaining'] for lot in lots), Decimal(0))
    for lot in lots:
        lot['unit_cost'] = str(lot['unit_cost'])
    return {
        'quantity': quantity, 'cost': str(cost),
        'average_cost': str(cost / quantity) if quantity else None,
        'realized_pnl': str(realized), 'lots': lots, 'trades': list(reversed(results)),
    }
