import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, createChart, LineSeries, LineStyle, LineType, type AutoscaleInfo, type Time } from 'lightweight-charts';
import { holdingMetrics, money, priceDigits, type Instrument, type Market, type Trade } from '../types';
import { TradeBadges } from './TradeBadges';
import { intradayTradeTime, marketClock, marketTimestamp, sessionTimes } from '../chartTime';
import type { Theme } from '../theme';

interface Props {
  instrument: Instrument; market?: Market; showClosed: boolean;
  focusedLot: number | null; range: '1M' | '3M' | '1Y' | 'ALL';
  mode?: 'intraday' | 'daily';
  theme?: Theme;
}
const nextDay = (day: string) => new Date(new Date(`${day}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);

export function CostChart({ instrument, market, range, mode = 'daily', theme = 'light' }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<Trade[]>([]);
  useEffect(() => {
    if (!element.current) return;
    setHovered([]);
    const digits = priceDigits(instrument.kind);
    const averageCost = holdingMetrics(instrument).average;
    const intraday = mode === 'intraday';
    const dark = theme === 'dark';
    const palette = {background: dark ? '#182335' : '#ffffff', text: dark ? '#a0afc7' : '#9297a6',
      grid: dark ? '#2a374c' : '#f0f1f5', crosshair: dark ? '#6f83ab' : '#b9bed0', line: dark ? '#a3b0ff' : '#7082d8'};
    const day = market?.intraday_date ?? localNowDate();
    const visibleTrades = intraday ? instrument.trades.filter(t => t.executed_at.slice(0, 10) === day && intradayTradeTime(t) != null) : instrument.trades;
    const tradeTime = (trade: Trade): Time | null => intraday ? intradayTradeTime(trade) : trade.executed_at.slice(0, 10);
    const chart = createChart(element.current, {
      autoSize: true,
      layout: { background: {type: ColorType.Solid, color: palette.background}, textColor: palette.text, fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif', fontSize: 11, attributionLogo: true },
      grid: {vertLines: {visible: false}, horzLines: {color: palette.grid}},
      rightPriceScale: {borderVisible: false, scaleMargins: {top: 0.14, bottom: 0.16}},
      timeScale: {borderVisible: false, rightOffset: intraday ? 2 : 7, timeVisible: intraday,
        ...(intraday ? {tickMarkFormatter: (time: Time) => typeof time === 'number' ? marketClock(time) : ''} : {})},
      localization: {locale: 'zh-CN', ...(intraday ? {timeFormatter: (time: Time) => typeof time === 'number' ? marketClock(time) : ''} : {})},
      crosshair: {vertLine: {color: palette.crosshair, labelBackgroundColor: '#5363a5'}, horzLine: {color: palette.crosshair, labelBackgroundColor: '#5363a5'}},
    });
    const format = {type: 'price' as const, precision: digits, minMove: 10 ** -digits};
    const history = market?.history ?? [];
    const candles = !intraday && history.length > 0;
    const series = candles ? chart.addSeries(CandlestickSeries, {
      upColor: '#d86b77', downColor: '#46a78e', borderVisible: false,
      wickUpColor: '#d86b77', wickDownColor: '#46a78e', priceFormat: format, priceLineVisible: false,
    }) : chart.addSeries(LineSeries, {
      color: palette.line, lineWidth: 2, lineType: LineType.Simple,
      lineVisible: intraday && !!market?.intraday?.length, priceFormat: format, priceLineVisible: false,
      lastValueVisible: intraday && !!market?.intraday?.length, crosshairMarkerVisible: intraday && !!market?.intraday?.length,
    });
    const today = localNowDate();
    if (intraday) {
      const prices = new Map((market?.intraday ?? []).map(item => [item.time, item.price]));
      series.setData(sessionTimes(day).map(time => prices.has(time) ? {time, value: prices.get(time)!} : {time}));
    } else if (candles) {
      series.setData(history.map(item => ({...item, time: item.time as Time})));
    } else {
      // Execution prices anchor offline costs, without inventing a market curve.
      const prices = new Map<string, number>();
      [...instrument.trades].reverse().forEach(trade => prices.set(trade.executed_at.slice(0, 10), Number(trade.price)));
      series.setData([...prices].sort(([a], [b]) => a.localeCompare(b)).map(([time, value]) => ({time: time as Time, value})));
    }
    const latest = [today, history.at(-1)?.time ?? today, ...instrument.trades.map(t => t.executed_at.slice(0, 10))].sort().at(-1)!;
    const scaleValues: number[] = [];
    scaleValues.push(...visibleTrades.map(trade => Number(trade.price)));
    if (averageCost != null) scaleValues.push(Number(averageCost));
    if (market?.quote) scaleValues.push(market.quote.price);
    series.applyOptions({autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
      const info = original();
      if (!scaleValues.length) return info;
      const min = Math.min(...scaleValues, info?.priceRange?.minValue ?? Infinity);
      const max = Math.max(...scaleValues, info?.priceRange?.maxValue ?? -Infinity);
      const pad = Math.max((max - min) * 0.08, max * 0.01);
      return {priceRange: {minValue: min - pad, maxValue: max + pad}};
    }});
    if (averageCost != null) series.createPriceLine({price: Number(averageCost), color: dark ? '#bbc8e2' : '#344262', lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: '统计均价'});
    if (market?.quote) series.createPriceLine({price: market.quote.price, color: '#de6671', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: '现价'});
    // Each execution has its own point, so trades on the same day can retain
    // different prices. Markers sit at the execution price, not the day's close.
    for (const trade of visibleTrades) {
      const price = Number(trade.price);
      const time = tradeTime(trade)!;
      const color = trade.side === 'buy' ? '#ed6470' : '#448bf0';
      const point = chart.addSeries(LineSeries, {
        color, lineVisible: false, lastValueVisible: false, priceLineVisible: false,
        crosshairMarkerVisible: false, priceFormat: format, autoscaleInfoProvider: () => null,
      });
      point.setData([{time, value: price}]);
    }
    series.attachPrimitive(new TradeBadges(visibleTrades, tradeTime, palette.background));
    chart.subscribeCrosshairMove(event => {
      if (typeof event.hoveredObjectId === 'string' && event.hoveredObjectId.startsWith('trade-time:')) {
        const time = Number(event.hoveredObjectId.slice('trade-time:'.length));
        setHovered(visibleTrades.filter(trade => tradeTime(trade) === time)); return;
      }
      if (typeof event.hoveredObjectId === 'string' && event.hoveredObjectId.startsWith('trade-day:')) {
        const date = event.hoveredObjectId.slice('trade-day:'.length);
        setHovered(visibleTrades.filter(trade => trade.executed_at.slice(0, 10) === date)); return;
      }
      if (!event.time || !event.point || event.point.x < 0 || event.point.y < 0) {setHovered([]); return;}
      const time = event.time;
      const date = typeof time === 'string' ? time : typeof time === 'number' ? new Date(time * 1000 + 8 * 3600000).toISOString().slice(0, 10)
        : `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
      setHovered(visibleTrades.filter(trade => intraday ? tradeTime(trade) === time : trade.executed_at.slice(0, 10) === date));
    });
    if (intraday) chart.timeScale().setVisibleRange({from: marketTimestamp(day, '09:30:00'), to: marketTimestamp(day, '15:00:00')});
    else if (range === 'ALL') chart.timeScale().fitContent();
    else {
      const start = new Date(`${latest}T00:00:00Z`);
      start.setUTCMonth(start.getUTCMonth() - (range === '1M' ? 1 : range === '3M' ? 3 : 12));
      chart.timeScale().setVisibleRange({from: start.toISOString().slice(0, 10) as Time, to: nextDay(latest) as Time});
    }
    return () => chart.remove();
  }, [instrument, market, range, mode, theme]);
  return <div className="cost-chart" aria-label={`${instrument.name}价格曲线、买卖点与成本图`}>
    <div ref={element} className="cost-chart-canvas"/>
    {!!hovered.length && <div className="chart-trade-tooltip"><strong>{hovered[0].executed_at.slice(0, mode === 'intraday' ? 16 : 10).replace('T', ' ')} · 交易记录</strong>
      {hovered.map(trade => <div key={trade.id}><span className={trade.side === 'buy' ? 'positive' : 'negative'}>{trade.side === 'buy' ? '买入' : '卖出'} #{trade.id}</span>
        <span>{money(trade.quantity, 0)} 股/份 · ¥ {money(trade.price, priceDigits(instrument.kind))}</span></div>)}
    </div>}
  </div>;
}

function localNowDate() {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
