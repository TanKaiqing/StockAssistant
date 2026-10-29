import type { Instrument, Trade } from './types';

export type AnalyticsFilter = {start: string; end: string; kind: 'all' | 'stock' | 'etf'};

function settlements(trade: Trade) {
  if (trade.analytics_settlements) return trade.analytics_settlements.map(event => ({kind: event.kind, pnl: Number(event.profit)}));
  return trade.side === 'sell' && trade.realized_pnl != null
    ? [{kind: 'ordinary' as const, pnl: Math.round(Number(trade.realized_pnl) * 100) / 100}] : [];
}

export function analyzeDay(instruments: Instrument[], day: string, kind: AnalyticsFilter['kind']) {
  const trades = instruments.filter(item => kind === 'all' || item.kind === kind)
    .flatMap(item => item.trades.filter(trade => trade.executed_at.slice(0, 10) === day)
      .map(trade => ({...trade, name: item.name})))
    .sort((a, b) => a.executed_at.localeCompare(b.executed_at) || a.id - b.id);
  const sessions = [
    {label: '09:30–10:30', begin: '09:30', end: '10:30'},
    {label: '10:30–11:30', begin: '10:30', end: '11:31'},
    {label: '13:00–14:00', begin: '13:00', end: '14:00'},
    {label: '14:00–15:00', begin: '14:00', end: '15:01'},
    {label: '其他时段', begin: '', end: ''},
  ].map(item => ({...item, count: 0, buys: 0, sells: 0, amount: 0, pnl: 0}));
  let buyAmount = 0, sellAmount = 0, buyFees = 0, sellFees = 0, buyCount = 0, sellCount = 0, cumulative = 0, peak = 0, drawdown = 0;
  const settled: {id: number; name: string; time: string; pnl: number; kind: 'ordinary' | 't_trade'}[] = [];
  const sequence: {date: string; pnl: number; count: number; amount: number; cumulative: number}[] = [];
  for (const trade of trades) {
    const gross = Number(trade.gross_amount ?? Number(trade.price) * trade.quantity);
    const fee = Number(trade.fee);
    const events = settlements(trade);
    const pnl = events.reduce((sum, event) => sum + event.pnl, 0);
    if (trade.side === 'buy') {buyAmount += gross; buyFees += fee; buyCount++;}
    else {
      sellAmount += gross; sellFees += fee; sellCount++;
    }
    for (const event of events) settled.push({id: trade.id, name: trade.name, time: trade.executed_at.slice(11, 19), pnl: event.pnl, kind: event.kind});
    cumulative += pnl; peak = Math.max(peak, cumulative); drawdown = Math.max(drawdown, peak - cumulative);
    sequence.push({date: `${trade.executed_at.slice(11, 19)} #${trade.id}`, pnl, count: 1, amount: gross, cumulative});
    const time = trade.executed_at.slice(11, 16);
    const session = sessions.find(item => item.begin && time >= item.begin && time < item.end) ?? sessions[sessions.length - 1];
    session.count++; session.amount += gross; session.pnl += pnl;
    if (trade.side === 'buy') session.buys++; else session.sells++;
  }
  const winners = settled.filter(item => item.pnl > 0).sort((a, b) => b.pnl - a.pnl);
  const losers = settled.filter(item => item.pnl < 0).sort((a, b) => a.pnl - b.pnl);
  const fees = buyFees + sellFees, amount = buyAmount + sellAmount;
  return {trades, sessions, sequence, buyAmount, sellAmount, buyFees, sellFees, buyCount, sellCount,
    buyOutflow: buyAmount + buyFees, sellInflow: sellAmount - sellFees,
    cashFlow: sellAmount - sellFees - buyAmount - buyFees,
    instrumentCount: new Set(trades.map(trade => trade.code)).size,
    firstTime: trades[0]?.executed_at.slice(11, 19), lastTime: trades.at(-1)?.executed_at.slice(11, 19),
    averageFee: trades.length ? fees / trades.length : null,
    feePerTenThousand: amount ? fees / amount * 10000 : null,
    averageWin: winners.length ? winners.reduce((sum, item) => sum + item.pnl, 0) / winners.length : null,
    averageLoss: losers.length ? losers.reduce((sum, item) => sum + item.pnl, 0) / losers.length : null,
    bestSell: winners[0], worstSell: losers[0], drawdown,
    settlementCount: settled.length,
    unsettled: trades.filter(trade => trade.side === 'sell' && (trade.t_trade
      ? (trade.analytics_pending_quantity ?? trade.quantity) > 0 : !settlements(trade).length)).length,
    estimatedFees: trades.filter(trade => trade.note.includes('估算')).length};
}

export function analyze(instruments: Instrument[], filter: AnalyticsFilter) {
  const daily = new Map<string, {date: string; pnl: number; count: number; amount: number}>();
  const monthly = new Map<string, {month: string; pnl: number; tPnl: number; buys: number; sells: number; amount: number; fees: number}>();
  let pnl = 0, fees = 0, amount = 0, buys = 0, sells = 0, wins = 0, losses = 0, flat = 0, gains = 0, lossAmount = 0;
  let tPnl = 0;
  const rankings = instruments.filter(i => filter.kind === 'all' || i.kind === filter.kind).map(instrument => {
    const trades = instrument.trades.filter(t => {
      const date = t.executed_at.slice(0, 10);
      return (!filter.start || date >= filter.start) && (!filter.end || date <= filter.end);
    });
    let itemPnl = 0, itemFees = 0, itemAmount = 0, itemSells = 0, itemWins = 0;
    let itemTPnl = 0;
    for (const t of trades) {
      const date = t.executed_at.slice(0, 10), month = date.slice(0, 7);
      const turnover = Number(t.gross_amount ?? Number(t.price) * t.quantity);
      const events = settlements(t);
      const profit = events.reduce((sum, event) => sum + event.pnl, 0);
      const tProfit = events.filter(event => event.kind === 't_trade').reduce((sum, event) => sum + event.pnl, 0);
      const fee = Number(t.fee);
      const d = daily.get(date) ?? {date, pnl: 0, count: 0, amount: 0};
      const m = monthly.get(month) ?? {month, pnl: 0, tPnl: 0, buys: 0, sells: 0, amount: 0, fees: 0};
      d.pnl += profit; d.count++; d.amount += turnover;
      m.pnl += profit; m.amount += turnover; m.fees += fee;
      m.tPnl += tProfit; itemTPnl += tProfit; tPnl += tProfit;
      if (t.side === 'buy') {buys++; m.buys++;} else m.sells++;
      for (const event of events) {
        sells++; itemSells++;
        if (event.pnl > 0) {wins++; itemWins++; gains += event.pnl;}
        else if (event.pnl < 0) {losses++; lossAmount -= event.pnl;} else flat++;
      }
      pnl += profit; itemPnl += profit; fees += fee; itemFees += fee; amount += turnover; itemAmount += turnover;
      daily.set(date, d); monthly.set(month, m);
    }
    return {code: instrument.code, name: instrument.name, kind: instrument.kind, pnl: itemPnl,
      tPnl: itemTPnl, fees: itemFees, amount: itemAmount, count: trades.length, sells: itemSells, winRate: itemSells ? itemWins / itemSells * 100 : null};
  }).filter(i => i.count > 0).sort((a, b) => b.pnl - a.pnl || b.amount - a.amount);
  let cumulative = 0, peak = 0, drawdown = 0;
  const days = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).map(d => {
    cumulative += d.pnl; peak = Math.max(peak, cumulative); drawdown = Math.max(drawdown, peak - cumulative);
    return {...d, cumulative};
  });
  return {pnl, tPnl, ordinaryPnl: pnl - tPnl, fees, amount, buys, sells, wins, losses, flat, gains, lossAmount, rankings, days,
    months: [...monthly.values()].sort((a, b) => b.month.localeCompare(a.month)),
    count: rankings.reduce((n, i) => n + i.count, 0), drawdown,
    winRate: sells ? wins / sells * 100 : null,
    profitFactor: lossAmount ? gains / lossAmount : null,
    best: days.length ? days.reduce((a, b) => b.pnl > a.pnl ? b : a) : null,
    worst: days.length ? days.reduce((a, b) => b.pnl < a.pnl ? b : a) : null};
}
