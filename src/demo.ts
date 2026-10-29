import type { Instrument, Market, Trade } from './types';

// A clearly labelled, memory-only example. Never inserted into the local ledger.
export function demoData(): { instruments: Instrument[]; markets: Record<string, Market> } {
  const dates = [55, 31, 13].map(days => {
    const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10);
  });
  const create = (code: string, name: string, kind: 'stock' | 'etf', prices: number[], qty: number): Instrument => {
    const trades: Trade[] = prices.map((price, i) => ({id: i + 1, code, side: 'buy', executed_at: `${dates[i]}T10:30:00`, price: String(price), quantity: qty, fee: '5', note: ['首次建仓', '分批加仓', '调整仓位'][i], buy_lot_id: null, realized_pnl: null, allocations: []}));
    const cost = prices.reduce((n, p) => n + p * qty + 5, 0);
    return {code, name, kind, quantity: qty * prices.length, cost: String(cost), average_cost: String(cost / (qty * prices.length)), realized_pnl: '0', trades: [...trades].reverse(), lots: trades.map(t => ({id: t.id, executed_at: t.executed_at, price: t.price, quantity: qty, remaining: qty, fee: t.fee, unit_cost: String(Number(t.price) + 5 / qty)}))};
  };
  const instruments = [create('510300', '沪深300ETF', 'etf', [3.815, 3.928, 4.062], 1000), create('600519', '贵州茅台', 'stock', [1438.5], 100), create('159915', '创业板ETF', 'etf', [2.105, 2.236], 2000)];
  const markets: Record<string, Market> = {};
  instruments.forEach((instrument, index) => {
    const base = [3.69, 1390, 2.04][index];
    const history = [];
    for (let i = 0; i < 90; i++) {
      const date = new Date(); date.setDate(date.getDate() - 89 + i);
      if ([0, 6].includes(date.getDay())) continue;
      const trend = 1 + i * 0.0014 + Math.sin(i * 0.19) * 0.019;
      const open = base * trend;
      const close = open * (1 + Math.sin(i * 1.7) * 0.008);
      history.push({time: date.toISOString().slice(0, 10), open, close, high: Math.max(open, close) * 1.006, low: Math.min(open, close) * 0.994});
    }
    const price = Number(history.at(-1)!.close.toFixed(instrument.kind === 'etf' ? 3 : 2));
    const step = instrument.kind === 'etf' ? 0.001 : 0.01;
    markets[instrument.code] = {source: '示例行情 · 非真实数据', warnings: [], history, quote: {price, change_percent: 0.82, previous_close: price / 1.0082, fetched_at: new Date().toISOString(), bids: Array.from({length: 5}, (_, i) => ({price: price - step * i, volume: 14200 + i * 3850})), asks: Array.from({length: 5}, (_, i) => ({price: price + step * (i + 1), volume: 12300 + i * 2750}))}};
  });
  return {instruments, markets};
}
