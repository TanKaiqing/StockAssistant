import { useEffect, useState } from 'react';

// Exchange time (UTC+8); no network request is needed to check the clock.
export function isTradingSession(timestamp = Date.now()) {
  const local = new Date(timestamp + 8 * 60 * 60 * 1000);
  const day = local.getUTCDay();
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return day !== 0 && day !== 6 && ((minute >= 555 && minute < 690) || (minute >= 780 && minute < 900));
}

export function useTradingSession() {
  const [open, setOpen] = useState(isTradingSession);
  useEffect(() => {
    const update = () => setOpen(isTradingSession());
    const timer = window.setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
    };
  }, []);
  return open;
}
