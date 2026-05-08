import React from 'react';
import './globals.css';

export const metadata = {
  title: 'guitar_tracker',
  description: 'A guitar inventory tracking app built with Next.js, Supabase, and Tailwind CSS',
};

const RootLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900">
        <header className="border-b border-slate-200 bg-white shadow-sm">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
            <a href="/" className="text-lg font-semibold tracking-tight text-slate-900">
              Guitar Tracker
            </a>
            <nav className="flex flex-wrap gap-3 text-sm font-medium text-slate-600">
              <a href="/" className="hover:text-slate-900">Home</a>
              <a href="/inventory" className="hover:text-slate-900">Inventory</a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</main>
      </body>
    </html>
  );
};

export default RootLayout;