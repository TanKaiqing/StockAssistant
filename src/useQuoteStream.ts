import { useEffect, useRef, useState } from 'react';
import type { Quote } from './types';
import { isTradingSession } from './tradingSession';

type Status = 'idle' | 'connecting' | 'live' | 'retrying' | 'paused' | 'unavailable';

export function useQuoteStream({enabled, code, codes, onQuote}: {
  enabled: boolean; code?: string; codes?: string[]; onQuote: (code: string, quote: Quote) => void;
}) {
  const multiple = codes !== undefined;
  const subscription = [...new Set(multiple ? codes : code ? [code] : [])].sort().join(',');
  const [status, setStatus] = useState<Status>('idle');
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const callback = useRef(onQuote); callback.current = onQuote;
  const quotedCode = useRef<string | undefined>(undefined);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (!enabled || !subscription) {setStatus('idle'); return;}
    const securities = new Set(subscription.split(','));
    if (securities.size > 200) {setStatus('unavailable'); return;}
    if (!visible) {setStatus('paused'); return;}
    if (typeof EventSource === 'undefined') {setStatus('unavailable'); return;}
    let disposed = false;
    let source: EventSource | null = null;
    let retry: number | undefined;
    let lastEvent = Date.now();
    const received = new Set<string>();

    function fallback() {
      if (disposed) return;
      source?.close(); source = null;
      received.clear(); quotedCode.current = undefined;
      setStatus('retrying');
      if (retry === undefined) retry = window.setTimeout(() => {retry = undefined; connect();}, 30_000);
    }
    function connect() {
      if (disposed) return;
      if (!isTradingSession()) {setStatus('paused'); return;}
      setStatus('connecting'); lastEvent = Date.now();
      const url = multiple ? `/api/market/quotes/stream?${new URLSearchParams({codes: subscription})}` : `/api/market/${subscription}/stream`;
      try {source = new EventSource(url);} catch {fallback(); return;}
      const channel = source;
      source.addEventListener('quote', event => {
        if (disposed || source !== channel) return;
        try {
          const data = JSON.parse((event as MessageEvent).data);
          const security = multiple ? data.code : subscription;
          const quote = (multiple ? data.quote : data) as Quote;
          if (!securities.has(security) || !quote) {fallback(); return;}
          if (!Number.isFinite(quote.price) || quote.price <= 0 || !quote.fetched_at) {fallback(); return;}
          lastEvent = Date.now(); received.add(security);
          if (received.size === securities.size) {quotedCode.current = subscription; setStatus('live');}
          callback.current(security, quote);
        } catch {fallback();}
      });
      source.addEventListener('heartbeat', () => {if (!disposed && source === channel) lastEvent = Date.now();});
      source.addEventListener('state', event => {
        if (disposed || source !== channel) return;
        try {
          const state = JSON.parse((event as MessageEvent).data);
          lastEvent = Date.now();
          if (state.status === 'paused') {
            source?.close(); source = null; received.clear(); quotedCode.current = undefined;
            setStatus('paused');
          }
          else if (state.status === 'fallback') fallback();
          else if (state.status === 'connecting') setStatus('connecting');
        } catch {fallback();}
      });
      source.onerror = () => {if (source === channel) fallback();};
    }
    // Avoid starting a discarded StrictMode mount's native subscription.
    const start = window.setTimeout(connect, 0);
    const watchdog = window.setInterval(() => {
      if (source && Date.now() - lastEvent > 15_000) fallback();
    }, 5000);
    return () => {
      disposed = true; source?.close(); window.clearTimeout(start);
      window.clearTimeout(retry); window.clearInterval(watchdog);
    };
  }, [enabled, subscription, multiple, visible]);
  return {status, live: enabled && visible && !!subscription && quotedCode.current === subscription && status === 'live'};
}
