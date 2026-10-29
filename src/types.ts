export interface StopLossDefaults {stop_loss_percent: string | null; stop_loss_amount: string | null}
export interface TTradePlan {
  sell_ids?: number[];
  id: number; code: string; name: string; executed_at: string; price: string; quantity: number;
  fee: string; gross_amount: string; target_price: string | null; matched_quantity: number; remaining: number;
}

export interface Trade {
  analytics_pnl?: string | null;
  analytics_settlements?: {kind: 'ordinary' | 't_trade'; sell_id?: number; quantity: number; profit: string}[];
  analytics_pending_quantity?: number;
  restored_to?: {sell_id: number; buy_id: number; quantity: number}[];
  t_trade?: boolean | number;
  t_buyback_price?: string | null;
  stop_loss_amount?: string | null;
  stop_loss_percent?: string | null;
  lot_allocations?: {buy_id: number; quantity: number}[] | null;
  target_profit_percent?: string | null;
  target_profit_amount?: string | null;
  gross_amount?: string | null;
  id: number; code: string; side: 'buy' | 'sell'; executed_at: string;
  price: string; quantity: number; fee: string; note: string; buy_lot_id: number | null;
  realized_pnl: string | null; allocations: { buy_id: number; quantity: number; fee?: string; realized_pnl?: string }[];
}
export interface Lot {
  t_completed_profit?: string;
  t_completed_count?: number;
  original_unit_cost?: string;
  t_restored_quantity?: number;
  t_last_buyback_price?: string;
  t_last_buyback_id?: number;
  t_last_buyback_at?: string;
  t_transferred_quantity?: number;
  t_restore_history?: {sell_id: number; buy_id: number; actual_buy_id: number; quantity: number; price: string; executed_at: string}[];
  stop_loss_amount?: string | null;
  stop_loss_percent?: string | null;
  sell_order?: {submitted_quantity: number; unconfirmed_quantity: number; filled_quantity?: number; canceled_quantity?: number;
    rejected_quantity?: number; needs_poll?: boolean; sync_error?: string; has_unlinked?: boolean; last_at: string};
  target_profit_percent?: string | null;
  target_profit_amount?: string | null;
  id: number; executed_at: string; quantity: number; remaining: number;
  price: string; fee: string; unit_cost: string;
}
export interface Instrument {
  analytics_error?: string;
  analytics_cost?: string;
  analytics_average_cost?: string | null;
  analytics_realized_pnl?: string;
  code: string; name: string; kind: 'stock' | 'etf';
  quantity: number; cost: string; average_cost: string | null; realized_pnl: string;
  trades: Trade[]; lots: Lot[];
}
export interface Candle { time: string; open: number; high: number; low: number; close: number }
export interface Quote {
  source?: string;
  quote_time?: string | null;
  book_source?: string | null;
  book_fetched_at?: string | null;
  price: number; change_percent: number | null; previous_close: number | null; fetched_at: string;
  bids: {price: number | null; volume: number | null}[];
  asks: {price: number | null; volume: number | null}[];
}
export interface Market { source: string; history_source?: string | null; quote: Quote | null; history: Candle[]; warnings: string[];
  intraday?: {time: number; price: number}[]; intraday_date?: string | null; intraday_fetched_at?: string | null;
}
export const LOT_COLORS = ['#5970dc', '#cf9651', '#39a092', '#a874c3', '#d76f84', '#649abc'];
export const money = (value: number | string | null | undefined, digits = 2) => value == null ? '—' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const signed = (value: number | string) => `${Number(value) > 0 ? '+' : ''}${money(value)}`;
export const priceDigits = (kind: Instrument['kind']) => kind === 'etf' ? 3 : 2;
export const lotReferenceUnitCost = (lot: Lot) => Number(lot.t_restored_quantity ? lot.original_unit_cost ?? lot.unit_cost : lot.unit_cost);
export function holdingMetrics(instrument: Instrument) {
  const unavailable = !!instrument.analytics_error || (instrument.trades.some(trade => !!trade.t_trade)
    && (instrument.analytics_cost == null || instrument.analytics_realized_pnl == null));
  return {
    cost: unavailable ? null : Number(instrument.analytics_cost ?? instrument.cost),
    average: unavailable ? null : instrument.analytics_average_cost !== undefined
      ? instrument.analytics_average_cost : instrument.average_cost,
    realized: unavailable ? null : Number(instrument.analytics_realized_pnl ?? instrument.realized_pnl),
    error: unavailable ? instrument.analytics_error ?? '做 T 统计尚未更新，请重启后台' : '',
  };
}
export const localNow = () => {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
