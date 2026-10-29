import { signed, type Lot } from '../types';

export function RestoredLotInfo({lot, originalProfit}: {lot: Lot; originalProfit: number | null}) {
  if (!lot.t_completed_count) return null;
  const tProfit = Number(lot.t_completed_profit ?? 0);
  const combined = originalProfit == null || lot.remaining <= 0 ? null : originalProfit + tProfit;
  const tone = (value: number) => value > 0 ? 'positive' : value < 0 ? 'negative' : '';
  return <span className="lot-t-comparison">
    <span title="按原卖出分摊关联至本批次，累计已买回净价差；扣除实际双边费用。同一卖出委托的分笔成交、分批买回按一次计算。"><small>累计做 T · {lot.t_completed_count} 次</small><strong className={tone(tProfit)}>¥ {signed(tProfit)}</strong></span>
    <span title="剩余持仓按最初买入成本的预计净盈亏，加上本批次历次已完成做 T 的累计净价差；未买回部分不计入。"><small>计入 T 后</small><strong className={combined == null ? '' : tone(combined)}>{combined == null ? '—' : `¥ ${signed(combined)}`}</strong></span>
  </span>;
}
