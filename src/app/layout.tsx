import React from 'react';
import './globals.css';
import AdminNavButton from '@/components/AdminNavButton'
import AuthGuard from '@/components/AuthGuard'
import LogoutButton from '@/components/LogoutButton'
import PwaUpdater from '@/components/PwaUpdater'
import QuickAddButton from '@/components/QuickAddButton'
import ThemeToggle from '@/components/ThemeToggle'

// themeColor belongs in viewport (not metadata) in Next.js 14+
export const viewport = {
  themeColor: '#0f172a',
};

export const metadata = {
  title: 'Guitar Tracker',
  description: 'A guitar inventory tracking app built with Next.js, Supabase, and Tailwind CSS',
  manifest: '/manifest.json',
  icons: {
    icon: '/icon.svg',
    apple: '/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent' as const,
    title: 'Guitar Tracker',
    startupImage: [
      // iPhone SE / 8  (375×667 @2x)
      { url: '/splash-750x1334.png',   media: '(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
      // iPhone XR / 11  (414×896 @2x)
      { url: '/splash-828x1792.png',   media: '(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
      // iPhone 12–15    (390×844 @3x)
      { url: '/splash-1170x2532.png',  media: '(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
      // iPhone 14/15 Pro  (393×852 @3x)
      { url: '/splash-1179x2556.png',  media: '(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
      // iPhone Plus / Max  (428×926 @3x)
      { url: '/splash-1284x2778.png',  media: '(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
    ],
  },
};

const RootLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <html lang="en">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100">
        <header className="border-b border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">

            {/* ── Single row on desktop ──────────────────────────────── */}
            <div className="flex items-center gap-3 py-3 md:py-4">
              <a href="/" className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
                Guitar Tracker
              </a>

              {/* Desktop nav — grows and centers */}
              <nav className="hidden flex-1 items-center justify-center gap-5 text-sm font-medium text-slate-600 dark:text-slate-300 md:flex">
                <a href="/" className="hover:text-slate-900 dark:hover:text-white">Dashboard</a>
                <a href="/inventory" className="hover:text-slate-900 dark:hover:text-white">Inventory</a>
                <a href="/operations" className="hover:text-slate-900 dark:hover:text-white">Operations</a>
                <a href="/cash-flow" className="hover:text-slate-900 dark:hover:text-white">Cash Flow</a>
              </nav>

              {/* Mobile spacer — pushes actions to the right */}
              <div className="flex-1 md:hidden" />

              {/* Action icons — always far right */}
              <div className="flex shrink-0 items-center gap-2">
                <QuickAddButton />
                <AdminNavButton />
                <ThemeToggle />
                <LogoutButton />
              </div>
            </div>

            {/* ── Mobile nav row (below the icon row) ───────────────── */}
            <nav className="flex flex-wrap gap-x-5 gap-y-1.5 pb-3 text-sm font-medium text-slate-600 dark:text-slate-300 md:hidden">
              <a href="/" className="hover:text-slate-900 dark:hover:text-white">Dashboard</a>
              <a href="/inventory" className="hover:text-slate-900 dark:hover:text-white">Inventory</a>
              <a href="/operations" className="hover:text-slate-900 dark:hover:text-white">Operations</a>
              <a href="/cash-flow" className="hover:text-slate-900 dark:hover:text-white">Cash Flow</a>
            </nav>

          </div>
        </header>
        <AuthGuard>
          <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</main>
        </AuthGuard>
        <PwaUpdater />
      </body>
    </html>
  );
};

export default RootLayout;