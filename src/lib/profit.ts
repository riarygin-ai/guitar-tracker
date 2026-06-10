export interface ProfitMetrics {
  totalExpenses: number;
  realizedGain: number | null;
  realizedROI: number | null;
  potentialReward: number | null;
  potentialROI: number | null;
}

export function calculateItemProfitMetrics(params: {
  valueIn: number | null;
  valueOut?: number | null;
  estimatedSoldValue?: number | null;
  totalExpenses?: number;
}): ProfitMetrics {
  const { valueIn, valueOut = null, estimatedSoldValue = null, totalExpenses = 0 } = params;
  const costBasis = (valueIn ?? 0) + totalExpenses;

  const realizedGain =
    valueOut != null && valueIn != null ? valueOut - valueIn - totalExpenses : null;
  const realizedROI =
    realizedGain != null && costBasis > 0 ? (realizedGain / costBasis) * 100 : null;

  const potentialReward =
    estimatedSoldValue != null && valueIn != null
      ? estimatedSoldValue - valueIn - totalExpenses
      : null;
  const potentialROI =
    potentialReward != null && costBasis > 0 ? (potentialReward / costBasis) * 100 : null;

  return { totalExpenses, realizedGain, realizedROI, potentialReward, potentialROI };
}
