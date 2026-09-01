'use client';

import React from 'react';

interface CompactPageHeaderProps {
  overline: string;
  summary?: React.ReactNode;
  action?: React.ReactNode;
}

export default function CompactPageHeader({ overline, summary, action }: CompactPageHeaderProps) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="page-overline">{overline}</p>
          {summary != null && <div className="mt-1">{summary}</div>}
        </div>
        {action != null && <div className="sm:shrink-0">{action}</div>}
      </div>
    </div>
  );
}
