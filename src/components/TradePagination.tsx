type Props = {
  page: number; pageSize: number; total: number;
  onPage: (page: number) => void; onPageSize: (size: number) => void;
};

export function TradePagination({page, pageSize, total, onPage, onPageSize}: Props) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  const buttons = Array.from({length: Math.min(5, pages)}, (_, index) => start + index);
  return <nav className="trade-pagination" aria-label="交易记录分页">
    <span className="trade-page-count">共 {total} 笔 · {total ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, total)}</span>
    <label>每页<select aria-label="每页交易条数" value={pageSize} onChange={event => onPageSize(Number(event.target.value))}>{[20, 50, 100].map(size => <option key={size} value={size}>{size} 条</option>)}</select></label>
    <div className="trade-page-buttons"><button type="button" disabled={page <= 1} onClick={() => onPage(1)}>首页</button><button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>{buttons.map(number => <button type="button" key={number} className={`trade-page-number ${number === page ? 'active' : ''}`} aria-label={`第 ${number} 页`} aria-current={number === page ? 'page' : undefined} onClick={() => onPage(number)}>{number}</button>)}<button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</button><button type="button" disabled={page >= pages} onClick={() => onPage(pages)}>末页</button></div>
    <span className="trade-page-position">{page} / {pages} 页</span>
  </nav>;
}
