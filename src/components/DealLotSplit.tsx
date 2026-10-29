import { money, type Lot } from '../types';

export type SplitQuantities = Record<number, string>;

export function splitSelection(lots: Lot[], quantities: SplitQuantities, total: number) {
  const allocations = lots.map(lot => ({buy_id: lot.id, quantity: Number(quantities[lot.id] ?? '')}))
    .filter(item => item.quantity !== 0);
  const allocated = allocations.reduce((sum, item) => sum + item.quantity, 0);
  const valid = allocations.length >= 2 && allocated === total && allocations.every(item =>
    Number.isInteger(item.quantity) && item.quantity > 0
    && item.quantity <= (lots.find(lot => lot.id === item.buy_id)?.remaining ?? 0));
  return {allocations, allocated, valid};
}

export function DealLotSplit({lots, quantities, total, disabled, onChange}: {
  lots: Lot[]; quantities: SplitQuantities; total: number; disabled: boolean;
  onChange: (quantities: SplitQuantities) => void;
}) {
  const {allocated, valid} = splitSelection(lots, quantities, total);
  return <div className="broker-deal-split">
    <div className="broker-deal-split-lots">{lots.map(lot => <label key={lot.id}>
      <span><strong>#{lot.id}<span>{lot.executed_at.slice(0, 10)}</span></strong><small>可分摊 {money(lot.remaining, 0)}</small></span>
      <input type="number" min="0" max={lot.remaining} step="1" placeholder="数量" disabled={disabled}
        aria-label={`批次${lot.id}分摊数量`} value={quantities[lot.id] ?? ''}
        onChange={event => onChange({...quantities, [lot.id]: event.target.value})}/>
    </label>)}</div>
    <small className={valid ? 'negative' : ''}>已分摊 {Number.isFinite(allocated) ? money(allocated, 0) : '—'} / {money(total, 0)} 股/份</small>
    <small>至少选择两个批次；合计须等于成交数量，手续费按数量分摊。</small>
  </div>;
}
