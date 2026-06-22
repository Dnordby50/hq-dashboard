import { useEffect, useState } from 'react';

// Tracks connectivity via the browser's online/offline events. Note navigator
// .onLine only reflects whether there is a network interface, not whether the
// server is reachable, but it is the right cheap signal for "should I try to
// sync now."
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}
