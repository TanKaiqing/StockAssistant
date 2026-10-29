import { localNow, money, type Lot } from '../types';

export function LotOrderBadge({lot}: {lot: Lot}) {
  const order = lot.sell_order;
  if (!order || lot.remaining <= 0 || order.last_at.slice(0, 10) !== localNow().slice(0, 10)) return null;
  const time = order.last_at.slice(11, 19);
  return <>
    {order.submitted_quantity > 0 && <span className="lot-order-badge" title={order.has_unlinked ? `本系统已提交卖出委托，但尚未获取明确委托号。最近提交 ${time}；具体数量、成交或撤单状态请查看券商当日委托。` : `本系统已提交卖出委托，尚未同步 ${money(order.submitted_quantity, 0)} 股/份。最近提交 ${time}；成交或撤单状态请查看券商当日委托。`}>已委托卖出{!order.has_unlinked && ` ${money(order.submitted_quantity, 0)}`}</span>}
    {order.unconfirmed_quantity > 0 && <span className="lot-order-badge uncertain" title={`提交结果未确认，涉及 ${money(order.unconfirmed_quantity, 0)} 股/份；请先查询当日委托和成交，避免重复下单。最近提交 ${time}`}>卖出待确认 {money(order.unconfirmed_quantity, 0)}</span>}
    {!!order.filled_quantity && <span className="lot-order-badge filled" title="已确认成交，请在券商账户的当日成交中手动同步到账本。">已成交 {money(order.filled_quantity, 0)} · 待同步</span>}
    {!!order.sync_error && <span className="lot-order-badge uncertain" title={order.sync_error}>同步待处理</span>}
    {!!order.canceled_quantity && <span className="lot-order-badge canceled" title="券商当日委托已确认这部分数量撤单，不会作为卖出成交同步。">已撤单 {money(order.canceled_quantity, 0)}</span>}
    {!!order.rejected_quantity && <span className="lot-order-badge canceled" title="券商当日委托已确认拒单或废单。">已拒单 {money(order.rejected_quantity, 0)}</span>}
  </>;
}
