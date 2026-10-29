import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, PrimitiveHoveredItem, SeriesAttachedParameter, Time } from 'lightweight-charts';
import type { Trade } from '../types';

type Point = {x: number; y: number; side: Trade['side']; date: string; time: Time};
const colors = {buy: '#ed6470', sell: '#448bf0'};

/** Compact execution badges drawn in chart coordinates, following pan and zoom. */
export class TradeBadges implements ISeriesPrimitive<Time> {
  private attachment?: SeriesAttachedParameter<Time>;
  private readonly view: IPrimitivePaneView;
  private hits: {x: number; y: number; date: string; time: Time}[] = [];

  constructor(readonly trades: Trade[], private readonly timeOf: (trade: Trade) => Time | null = trade => trade.executed_at.slice(0, 10), private readonly background = '#fff') {
    const renderer: IPrimitivePaneRenderer = {draw: target => {
      target.useMediaCoordinateSpace(({context: ctx, mediaSize}) => {
        this.hits = [];
        if (!this.attachment) return;
        const {chart, series} = this.attachment;
        const points: Point[] = [];
        for (const trade of this.trades) {
          const date = trade.executed_at.slice(0, 10);
          const time = this.timeOf(trade);
          if (time == null) continue;
          const x = chart.timeScale().timeToCoordinate(time);
          const y = series.priceToCoordinate(Number(trade.price));
          if (x == null || y == null || x < 0 || x > mediaSize.width || y < 0 || y > mediaSize.height) continue;
          points.push({x, y, side: trade.side, date, time});
        }
        ctx.save();
        // Keep actual execution dots; nearby same-direction badges share one label.
        for (const p of points) {
          ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
          ctx.fillStyle = colors[p.side]; ctx.fill();
          ctx.lineWidth = 1; ctx.strokeStyle = this.background; ctx.stroke();
        }
        const groups: Point[] = [];
        for (const p of [...points].sort((a, b) => a.y - b.y)) {
          if (!groups.some(g => g.date === p.date && g.side === p.side && Math.abs(g.x - p.x) < 20 && Math.abs(g.y - p.y) < 18)) groups.push(p);
        }
        const occupied: {x: number; y: number}[] = [];
        for (const p of groups) {
          const badgeWidth = 18, badgeHeight = 20;
          const below = p.y + 16 + badgeHeight < mediaSize.height - 3;
          const badgeY = below ? p.y + 16 : p.y - 16 - badgeHeight;
          let badgeX = Math.max(2, Math.min(mediaSize.width - badgeWidth - 2, p.x - badgeWidth / 2));
          const collides = (x: number) => occupied.some(b => Math.abs(b.y - badgeY) < badgeHeight + 3 && Math.abs(b.x - x) < badgeWidth + 4);
          if (collides(badgeX)) {
            const offsets = [22, -22, 44, -44, 66, -66];
            const free = offsets.map(offset => badgeX + offset).find(x => x >= 2 && x + badgeWidth <= mediaSize.width - 2 && !collides(x));
            // Dense clusters retain their precise dots rather than stacking labels.
            if (free == null) continue;
            badgeX = free;
          }
          occupied.push({x: badgeX, y: badgeY});
          this.hits.push({x: badgeX, y: badgeY, date: p.date, time: p.time});
          const center = badgeX + badgeWidth / 2, tip = below ? badgeY : badgeY + badgeHeight;
          ctx.beginPath(); ctx.moveTo(p.x, p.y + (below ? 4 : -4)); ctx.lineTo(center, tip);
          ctx.strokeStyle = colors[p.side]; ctx.globalAlpha = .5; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
          ctx.beginPath(); ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 4);
          ctx.fillStyle = colors[p.side]; ctx.fill();
          ctx.beginPath(); ctx.moveTo(center - 3, tip); ctx.lineTo(center, tip + (below ? -4 : 4)); ctx.lineTo(center + 3, tip); ctx.closePath(); ctx.fill();
          ctx.font = '600 13px Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
          ctx.fillText(p.side === 'buy' ? 'B' : 'S', center, badgeY + badgeHeight / 2 + .5);
        }
        ctx.restore();
      });
    }};
    this.view = {zOrder: () => 'top', renderer: () => renderer};
  }
  attached(attachment: SeriesAttachedParameter<Time>) {this.attachment = attachment; attachment.requestUpdate();}
  detached() {this.attachment = undefined; this.hits = [];}
  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const hit = [...this.hits].reverse().find(b => x >= b.x && x <= b.x + 18 && y >= b.y - 4 && y <= b.y + 24);
    return hit ? {externalId: typeof hit.time === 'number' ? `trade-time:${hit.time}` : `trade-day:${hit.date}`, zOrder: 'top', cursorStyle: 'crosshair'} : null;
  }
  paneViews() {return [this.view];}
}
