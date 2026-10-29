import time
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request
from pydantic import ValidationError
from backend import broker_trade as trade



def native(command, payload):
    if command == 'order-preview':
        return {'ok': True, 'data': {'ok': True, 'account_type': 'normal', 'is_credit': False,
                'code': payload['code'], 'side': payload['side'], 'available_quantity': '1000',
                'account': 'secret'}}
    return {'ok': True, 'data': {'ok': True, 'account': 'secret'}}


class TradeTests(unittest.TestCase):
    def test_broker_size_uses_available_not_ledger_and_never_submits(self):
        with patch.object(trade, 'ready'), patch.object(trade.broker, 'invoke_tool', side_effect=native) as call:
            result = trade.size(trade.SizeRequest(code='513310', side='buy', price='4.123', portion=2))
            self.assertEqual(result['quantity'], 500)
            self.assertEqual(call.call_args.args[0], 'order-preview')
            self.assertNotIn('quantity', call.call_args.args[1])
            result = trade.size(trade.SizeRequest(code='513310', side='sell', price='4.123', portion=3))
            self.assertEqual(result['quantity'], 300)

    def setUp(self):
        trade.tickets.clear()
        self.order = trade.Order(code='513310', side='sell', price='4.123', quantity=100)

    def test_exact_preview_reused_once_and_no_secrets_or_ledger_write(self):
        with patch.object(trade, 'ready'), patch.object(trade.broker, 'invoke_tool', side_effect=native) as call:
            preview = trade.preview(self.order)
            self.assertNotIn('secret', str(preview))
            self.assertEqual(call.call_count, 1)
            result = trade.submit(trade.Confirmation(ticket=preview['ticket'], confirmed=True))
            self.assertEqual(result['status'], 'accepted')
            self.assertEqual(call.call_args.args, ('order-submit', preview['order']))
            with self.assertRaises(HTTPException):
                trade.submit(trade.Confirmation(ticket=preview['ticket'], confirmed=True))
            self.assertEqual(sum(c.args[0] == 'order-submit' for c in call.call_args_list), 1)

    def test_uncertain_submit_cannot_be_retried(self):
        def timeout(command, payload):
            if command == 'order-submit':
                raise HTTPException(504, 'secret')
            return native(command, payload)
        with patch.object(trade, 'ready'), patch.object(trade.broker, 'invoke_tool', side_effect=timeout):
            preview = trade.preview(self.order)
            result = trade.submit(trade.Confirmation(ticket=preview['ticket'], confirmed=True))
            self.assertEqual(result['status'], 'unknown')
            self.assertNotIn('secret', str(result))
            self.assertNotIn(preview['ticket'], trade.tickets)

    def test_expired_preview_never_calls_native(self):
        ticket = 'x' * 32
        trade.tickets[ticket] = (time.monotonic() - 1, self.order.native())
        with patch.object(trade.broker, 'invoke_tool') as native_call, patch.object(trade, 'ready') as ready:
            with self.assertRaises(HTTPException):
                trade.submit(trade.Confirmation(ticket=ticket, confirmed=True))
            native_call.assert_not_called(); ready.assert_not_called()

    def test_changed_account_and_insufficient_quantity_block_submission(self):
        for field, value in [('account_type', 'credit'), ('available_quantity', '99'), ('code', '002437')]:
            def changed(command, payload):
                document = native(command, payload); document['data'][field] = value
                return document
            with patch.object(trade, 'ready'), patch.object(trade.broker, 'invoke_tool', side_effect=native):
                preview = trade.preview(self.order)
            with patch.object(trade, 'ready'), patch.object(trade.broker, 'invoke_tool', side_effect=changed) as call:
                with self.assertRaises(HTTPException):
                    trade.submit(trade.Confirmation(ticket=preview['ticket'], confirmed=True))
                self.assertEqual([c.args[0] for c in call.call_args_list], ['order-preview'])

    def test_validation_prevents_ambiguous_orders(self):
        for changes in [{'price': 'NaN'}, {'price': '4.1234'}, {'quantity': 1.5},
                        {'side': 'buy', 'quantity': 101}, {'code': '123'}, {'quantity': True}]:
            with self.assertRaises(ValidationError):
                trade.Order(**({'code': '513310', 'side': 'sell', 'price': '4.123', 'quantity': 100} | changes))
        for confirmed in [False, 1, 'true']:
            with self.assertRaises(ValidationError):
                trade.Confirmation(ticket='x' * 32, confirmed=confirmed)

    def test_browser_origin_required_and_client_cannot_override_preview_on_submit(self):
        def request(origin):
            headers = [(b'host', b'localhost:8000')]
            if origin:
                headers.append((b'origin', origin.encode()))
            return Request({'type': 'http', 'scheme': 'http', 'server': ('localhost', 8000),
                            'path': '/api/broker/trade/preview', 'root_path': '', 'headers': headers})
        for origin in [None, 'https://evil.example']:
            with self.assertRaises(HTTPException) as error:
                trade.same_origin(request(origin))
            self.assertEqual(error.exception.status_code, 403)
        trade.same_origin(request('http://localhost:8000'))
        with self.assertRaises(ValidationError):
            trade.Confirmation(ticket='x' * 32, confirmed=True, price='1')



if __name__ == '__main__':
    unittest.main()
