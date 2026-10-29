import unittest
from decimal import Decimal
from backend.accounting import calculate, LedgerError


def trade(identifier, side, price, quantity, fee='0', date=None, lot=None):
    return {'id': identifier, 'code': '510300', 'side': side, 'price': str(price),
            'quantity': quantity, 'fee': str(fee), 'executed_at': date or f'2026-01-{identifier:02d}T10:00:00',
            'note': '', 'buy_lot_id': lot}


class AccountingTests(unittest.TestCase):
    def test_buy_includes_fee(self):
        result = calculate([trade(1, 'buy', '3.815', 1000, '5')])
        self.assertEqual(Decimal(result['cost']), Decimal('3820'))
        self.assertEqual(Decimal(result['average_cost']), Decimal('3.820'))

    def test_fifo_sell_across_batches_and_fees(self):
        result = calculate([trade(1, 'buy', '10', 100, '5'), trade(2, 'buy', '12', 100, '5'),
                            trade(3, 'sell', '15', 150, '8')])
        self.assertEqual(result['quantity'], 50)
        self.assertEqual(Decimal(result['cost']), Decimal('602.5'))
        self.assertEqual(Decimal(result['realized_pnl']), Decimal('634.5'))
        self.assertEqual(result['lots'][0]['remaining'], 0)
        self.assertEqual(result['lots'][1]['remaining'], 50)
        self.assertEqual(result['trades'][0]['allocations'], [{'buy_id': 1, 'quantity': 100}, {'buy_id': 2, 'quantity': 50}])

    def test_explicit_batch(self):
        result = calculate([trade(1, 'buy', 10, 100), trade(2, 'buy', 12, 100), trade(3, 'sell', 15, 40, lot=2)])
        self.assertEqual([lot['remaining'] for lot in result['lots']], [100, 60])
        self.assertEqual(Decimal(result['realized_pnl']), Decimal('120'))

    def test_oversell_rejected(self):
        with self.assertRaises(LedgerError):
            calculate([trade(1, 'buy', 10, 100), trade(2, 'sell', 12, 101)])

    def test_target_batch_does_not_spill_to_other_lots(self):
        with self.assertRaises(LedgerError):
            calculate([trade(1, 'buy', 10, 100), trade(2, 'buy', 12, 100), trade(3, 'sell', 15, 101, lot=2)])

    def test_selling_before_buy_rejected(self):
        with self.assertRaises(LedgerError):
            calculate([trade(1, 'buy', 10, 100, date='2026-02-02T10:00:00'),
                       trade(2, 'sell', 12, 10, date='2026-02-01T10:00:00')])

    def test_close_position_keeps_realized_profit(self):
        result = calculate([trade(1, 'buy', '0.1', 300, '5'), trade(2, 'sell', '0.2', 300, '5')])
        self.assertEqual(result['quantity'], 0)
        self.assertIsNone(result['average_cost'])
        self.assertEqual(Decimal(result['cost']), 0)
        self.assertAlmostEqual(Decimal(result['realized_pnl']), Decimal('20'), places=25)

    def test_repeated_fractional_cost_allocation(self):
        result = calculate([trade(1, 'buy', '3.333', 3, '1'), trade(2, 'sell', '4', 1),
                            trade(3, 'sell', '4', 1), trade(4, 'sell', '4', 1)])
        self.assertAlmostEqual(Decimal(result['realized_pnl']), Decimal('1.001'), places=25)

    def test_same_time_stable_id_order(self):
        date = '2026-01-01T10:00:00'
        result = calculate([trade(2, 'sell', 12, 50, date=date), trade(1, 'buy', 10, 100, date=date)])
        self.assertEqual(result['quantity'], 50)

    def test_broker_amount_overrides_rounded_average_price(self):
        buy = {**trade(1, 'buy', '2.356', 2100, '0.25'), 'gross_amount': '4948.400'}
        sell = {**trade(2, 'sell', '2.4', 2100, '0.25'), 'gross_amount': '5040'}
        result = calculate([buy])
        self.assertEqual(Decimal(result['cost']), Decimal('4948.65'))
        result = calculate([buy, sell])
        self.assertAlmostEqual(Decimal(result['realized_pnl']), Decimal('91.10'), places=25)


if __name__ == '__main__':
    unittest.main()
