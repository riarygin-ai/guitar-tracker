'use client';
import { useEffect, useState } from 'react';

export default function PwaUpdater() {
  const [waitingSW, setWaitingSW] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    let visibilityHandler: (() => void) | null = null;
    let refreshing = false;

    // After skipWaiting the controller changes — reload immediately
    const onControllerChange = () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        // Already waiting when we land on the page (e.g. after background update)
        if (reg.waiting) setWaitingSW(reg.waiting);

        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              setWaitingSW(sw);
            }
          });
        });

        // Re-check for updates whenever the app is foregrounded
        visibilityHandler = () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        };
        document.addEventListener('visibilitychange', visibilityHandler);
      })
      .catch(() => {}); // SW unavailable (HTTP, private browsing) — fail silently

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
    };
  }, []);

  const handleUpdate = () => {
    if (!waitingSW) return;
    waitingSW.postMessage({ type: 'SKIP_WAITING' });
    setWaitingSW(null);
  };

  if (!waitingSW) return null;

  return (
    <div className="fixed bottom-20 left-4 right-4 z-50 rounded-2xl bg-slate-800 p-4 shadow-2xl ring-1 ring-slate-700 sm:bottom-6 sm:left-auto sm:right-6 sm:w-80 dark:bg-slate-800 dark:ring-slate-700">
      <p className="text-sm font-semibold text-white">Update available</p>
      <p className="mt-1 text-xs text-slate-400">A new version of Guitar Tracker is ready.</p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={handleUpdate}
          className="flex-1 rounded-xl bg-teal-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-teal-400"
        >
          Refresh now
        </button>
        <button
          onClick={() => setWaitingSW(null)}
          className="rounded-xl border border-slate-600 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-700"
        >
          Later
        </button>
      </div>
    </div>
  );
}
