"""Optional live-market smoke check, using a temporary ledger and local server."""
import json
from pathlib import Path
import sys
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tests'))
from test_api import ApiTests

if __name__ == '__main__':
    ApiTests.setUpClass()
    try:
        case = ApiTests()
        case.setUp()
        with urllib.request.urlopen(ApiTests.base + '/market/510300?history=true', timeout=30) as response:
            result = json.load(response)
        quote = result['quote']
        assert quote and quote['price'] > 0, 'Live quote unavailable'
        assert len(quote['bids']) == len(quote['asks']) == 5, 'Five levels expected'
        assert any(level['price'] is not None for level in quote['bids']), 'Order book unavailable'
        assert result['history'], 'Unadjusted historical candles unavailable'
        print(json.dumps({'source': result['source'], 'price': quote['price'], 'levels': 5,
                          'candles': len(result['history']), 'warnings': result['warnings']}, ensure_ascii=True))
    finally:
        ApiTests.tearDownClass()
