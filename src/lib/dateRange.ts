export type DatePreset = '30d' | '90d' | '6m' | '12m' | 'all' | 'custom';

export const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: '30d',    label: '30 Days' },
  { key: '90d',    label: '90 Days' },
  { key: '6m',     label: '6 Months' },
  { key: '12m',    label: '12 Months' },
  { key: 'all',    label: 'All Time' },
  { key: 'custom', label: 'Custom' },
];

export const DEFAULT_PRESET: DatePreset = '6m';

export function presetToDateRange(
  preset: DatePreset,
  customFrom: string,
  customTo: string,
): { dateFrom: string; dateTo: string } {
  if (preset === 'all') return { dateFrom: '', dateTo: '' };
  if (preset === 'custom') return { dateFrom: customFrom, dateTo: customTo };
  const now = new Date();
  const from = new Date(now);
  if (preset === '30d')       from.setDate(from.getDate() - 30);
  else if (preset === '90d')  from.setDate(from.getDate() - 90);
  else if (preset === '6m')   from.setMonth(from.getMonth() - 6);
  else if (preset === '12m')  from.setMonth(from.getMonth() - 12);
  return {
    dateFrom: from.toISOString().split('T')[0],
    dateTo: now.toISOString().split('T')[0],
  };
}
