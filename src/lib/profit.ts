export interface ProfitMetrics {
  totalExpenses: number;
  realizedGain: number | null;
  realizedROI: number | null;
  potentialReward: number | null;
  potentialROI: number | null;
}

/**
 * Canonical profit/ROI calculation.
 *
 * ROI denominator is valueIn (purchase cost), not valueIn + expenses.
 * Expenses reduce the reward/gain but are not added to the cost basis.
 *
 * Zero-cost-basis rule: if valueIn === 0 and reward/gain > 0, ROI = 100%.
 * This covers items received for free (e.g. extras in a trade).
 */
export function calculateItemProfitMetrics(params: {
  valueIn: number | null;
  valueOut?: number | null;
  estimatedSoldValue?: number | null;
  totalExpenses?: number;
}): ProfitMetrics {
  const { valueIn, valueOut = null, estimatedSoldValue = null, totalExpenses = 0 } = params;

  const potentialReward =
    estimatedSoldValue != null && valueIn != null
      ? estimatedSoldValue - valueIn - totalExpenses
      : null;

  const potentialROI = roiFrom(potentialReward, valueIn);

  const realizedGain =
    valueOut != null && valueIn != null ? valueOut - valueIn - totalExpenses : null;

  const realizedROI = roiFrom(realizedGain, valueIn);

  return { totalExpenses, realizedGain, realizedROI, potentialReward, potentialROI };
}

/** Shared ROI logic: 100% for zero-cost with positive gain; else gain/valueIn. */
function roiFrom(gain: number | null, valueIn: number | null): number | null {
  if (gain == null || valueIn == null) return null;
  if (valueIn === 0) return gain > 0 ? 100 : null;
  return (gain / valueIn) * 100;
}
