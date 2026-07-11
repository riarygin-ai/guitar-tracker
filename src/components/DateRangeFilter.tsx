'use client';

import { type DatePreset, DATE_PRESETS } from '@/lib/dateRange';

interface DateRangeFilterProps {
  preset: DatePreset;
  onPresetChange: (preset: DatePreset) => void;
  customFrom: string;
  onCustomFromChange: (value: string) => void;
  customTo: string;
  onCustomToChange: (value: string) => void;
}

export default function DateRangeFilter({
  preset,
  onPresetChange,
  customFrom,
  onCustomFromChange,
  customTo,
  onCustomToChange,
}: DateRangeFilterProps) {
  return (
    <div>
      <p className="mb-2 section-label">Date Range</p>
      <div className="flex flex-wrap gap-2">
        {DATE_PRESETS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => onPresetChange(key)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
              preset === key
                ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {preset === 'custom' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="form-label">From</label>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => onCustomFromChange(e.target.value)}
              className="mt-1.5 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
            />
          </div>
          <div>
            <label className="form-label">To</label>
            <input
              type="date"
              value={customTo}
              onChange={(e) => onCustomToChange(e.target.value)}
              className="mt-1.5 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
            />
          </div>
        </div>
      )}
    </div>
  );
}
