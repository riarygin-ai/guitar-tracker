// Insights Engine v1.0 — orchestrator. Runs the (currently single-member)
// Findings Selector rule set against Analytics v2.10's target_user_
// acquisition_evidence and assembles the `insights` section merged into
// analytics_runs.snapshot by runAnalytics.ts. Does not read or write
// Analytics v2.10 data itself — the caller supplies the already-validated
// snapshot section as plain evidence.
//
// Scope note: this is a narrow first slice. Only STRONG_BALANCED_
// ACQUISITION_BAND is implemented — no category x band, channel, brand,
// inventory, Purpose, Change Detection, Pattern Discovery, or AI Coach
// findings. See analytics/README.md for where those may land later.

import { evaluateStrongBalancedAcquisitionBand } from './rules/strongBalancedAcquisitionBand';
import type { InsightsSection, SelectedFinding } from './types';

export const INSIGHTS_ENGINE_VERSION = '1.0';
export const FINDINGS_SELECTOR_VERSION = '1.0';
export const SOURCE_ANALYTICS_VERSION = '2.10';

/**
 * Pure function of its input evidence (aside from generated_at). Never
 * throws — malformed or missing evidence yields an empty selected_findings
 * array plus rule_evaluations explaining why, not an exception.
 */
export function selectFindings(targetUserAcquisitionEvidence: unknown): InsightsSection {
  const { result, candidateEvaluations } = evaluateStrongBalancedAcquisitionBand(targetUserAcquisitionEvidence);

  const selectedFindings: SelectedFinding[] = result.status === 'selected' ? [result] : [];

  return {
    insights_engine_version: INSIGHTS_ENGINE_VERSION,
    findings_selector_version: FINDINGS_SELECTOR_VERSION,
    source_analytics_version: SOURCE_ANALYTICS_VERSION,
    generated_at: new Date().toISOString(),
    selected_findings: selectedFindings,
    rule_evaluations: candidateEvaluations,
  };
}
