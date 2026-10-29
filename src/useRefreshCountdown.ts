import { useEffect, useRef, useState } from 'react';

export const REFRESH_INTERVAL = 5_000;
export const REFRESH_SECONDS = [5, 10, 30] as const;
export function readRefreshSeconds() {
  const saved = Number(localStorage.getItem('refreshSeconds'));
  return REFRESH_SECONDS.some(value => value === saved) ? saved : 5;
}

export function useRefreshCountdown({enabled, code, refreshing, revision, onRefresh, intervalSeconds = 5}: {
  enabled: boolean; code?: string; refreshing: boolean; revision: number; onRefresh: (code: string) => Promise<void>;
  intervalSeconds?: number;
}) {
  const secondsPerCycle = REFRESH_SECONDS.some(value => value === intervalSeconds) ? intervalSeconds : 5;
  const [remaining, setRemaining] = useState(secondsPerCycle);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    if (!enabled || !code || !visible || refreshing) return;
    const deadline = Date.now() + secondsPerCycle * 1000;
    setRemaining(secondsPerCycle);
    const timer = window.setInterval(() => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0) {
        window.clearInterval(timer);
        void refresh.current(code);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [enabled, code, visible, refreshing, revision, secondsPerCycle]);
  return {remaining, paused: !visible, intervalSeconds: secondsPerCycle};
}
