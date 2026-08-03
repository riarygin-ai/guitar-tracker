// Insights Engine v1.1 — orchestrator. Runs the Findings Selector rule set
// against Analytics v2.10's target-user evidence sections and assembles the
// `insights` section merged into analytics_runs.snapshot by runAnalytics.ts.
// Does not read or write Analytics v2.10 data itself — the caller supplies
// the already-validated snapshot sections as plain evidence.
//
// Rules implemented:
//   STRONG_BALANCED_ACQUISITION_BAND  (v1.0, unchanged in behavior)
//   STRONG_CATEGORY_ACQUISITION_BAND  (new in v1.1)
// No category x type, channel, brand, inventory, Purpose, Change Detection,
// Pattern Discovery, or AI Coach findings. See analytics/README.md for
// where those may land later.
//
// Cross-rule relationship: when both rules select the same acquisition
// band, both findings are kept (never deduped away), but the category
// finding is additionally stamped with structured `relationship` metadata
// pointing at the broad-band finding it refines, and its summary gains one
// explanatory sentence. This is a narrow, ad hoc check — not a general
// deduplication framework.

import { evaluateStrongBalancedAcquisitionBand } from './rules/strongBalancedAcquisitionBand';
import { evaluateStrongCategoryAcquisitionBand } from './rules/strongCategoryAcquisitionBand';
import { FINDING_CODE as STRONG_BALANCED_ACQUISITION_BAND_CODE } from './rules/strongBalancedAcquisitionBand';
import type { InsightsSection, SelectedFinding } from './types';

export const INSIGHTS_ENGINE_VERSION = '1.1';
export const FINDINGS_SELECTOR_VERSION = '1.1';
export const SOURCE_ANALYTICS_VERSION = '2.10';

export interface SelectFindingsInput {
  targetUserAcquisitionEvidence: unknown;
  targetUserInventorySegmentationEvidence: unknown;
}

function acquisitionBandOrderOf(finding: SelectedFinding): unknown {
  return finding.segment.acquisition_value_band_order;
}

/**
 * Pure function of its input evidence (aside from generated_at). Never
 * throws — malformed or missing evidence yields an empty selected_findings
 * array plus rule_evaluations explaining why, not an exception.
 */
export function selectFindings(input: SelectFindingsInput): InsightsSection {
  const broad = evaluateStrongBalancedAcquisitionBand(input.targetUserAcquisitionEvidence);
  const category = evaluateStrongCategoryAcquisitionBand(input.targetUserInventorySegmentationEvidence);

  const selectedFindings: SelectedFinding[] = [];
  if (broad.result.status === 'selected') selectedFindings.push(broad.result);
  if (category.result.status === 'selected') selectedFindings.push(category.result);

  if (
    broad.result.status === 'selected' &&
    category.result.status === 'selected' &&
    acquisitionBandOrderOf(broad.result) === acquisitionBandOrderOf(category.result)
  ) {
    const bandOrder = acquisitionBandOrderOf(category.result);
    category.result.relationship = {
      relationship: 'refines',
      related_finding_code: STRONG_BALANCED_ACQUISITION_BAND_CODE,
      dedupe_group: `ACQUISITION_BAND_${bandOrder}`,
    };
    category.result.summary +=
      ` This refines the broader ${STRONG_BALANCED_ACQUISITION_BAND_CODE} finding, which identified the same ` +
      `acquisition band across the whole portfolio — this segment shows the category driving that result.`;
  }

  return {
    insights_engine_version: INSIGHTS_ENGINE_VERSION,
    findings_selector_version: FINDINGS_SELECTOR_VERSION,
    source_analytics_version: SOURCE_ANALYTICS_VERSION,
    generated_at: new Date().toISOString(),
    selected_findings: selectedFindings,
    rule_evaluations: [...broad.candidateEvaluations, ...category.candidateEvaluations],
  };
}
