// Insights Engine v1.5 — orchestrator. Runs the Findings Selector rule set
// against Analytics target-user evidence sections and assembles the
// `insights` section merged into analytics_runs.snapshot by runAnalytics.ts.
// Does not read or write Analytics data itself — the caller supplies the
// already-validated snapshot sections as plain evidence.
//
// SOURCE_ANALYTICS_VERSION moved from 2.10 to 2.11 (Analytics v2.11 —
// Per-Platform Listing-to-Exit Timing) purely to reflect which Analytics
// snapshot version now feeds this engine — none of the six rules below
// read target_user_listing_channel_evidence / shared_listing_channel_
// evidence (the only sections v2.11 touches), so this bump changes no
// rule's behavior. insights_engine_version / findings_selector_version
// deliberately stay at 1.5 — no new Findings Selector rule was added.
//
// Rules implemented:
//   STRONG_BALANCED_ACQUISITION_BAND       (v1.0, unchanged in behavior)
//   STRONG_CATEGORY_ACQUISITION_BAND       (v1.1, unchanged in behavior)
//   ACQUISITION_METHOD_PERFORMANCE_PROFILE (v1.2, unchanged in behavior)
//   STRONG_DEAL_IN_TO_DEAL_OUT_JOURNEY      (v1.3, unchanged in behavior)
//   STRONG_DEAL_OUT_CHANNEL                 (v1.4, unchanged in behavior)
//   STRONG_DEAL_IN_CHANNEL                  (new in v1.5)
// No category x type, brand, inventory, Purpose, Change Detection, Pattern
// Discovery, or AI Coach findings. See analytics/README.md for where those
// may land later.
//
// Cross-rule relationship: when the broad-band and category rules select
// the same acquisition band, both findings are kept (never deduped away),
// but the category finding is additionally stamped with structured
// `relationship` metadata pointing at the broad-band finding it refines,
// and its summary gains one explanatory sentence. This is a narrow, ad hoc
// check — not a general deduplication framework. The acquisition-method,
// channel-journey, deal-out-channel, and deal-in-channel rules have no
// relationship to that pair, or to each other — Deal In and Deal Out
// evaluate different questions (where inventory was sourced vs. where it
// exited) and are never deduplicated or suppressed against each other,
// even when they happen to select the same channel_id.

import { evaluateStrongBalancedAcquisitionBand } from './rules/strongBalancedAcquisitionBand';
import { evaluateStrongCategoryAcquisitionBand } from './rules/strongCategoryAcquisitionBand';
import { FINDING_CODE as STRONG_BALANCED_ACQUISITION_BAND_CODE } from './rules/strongBalancedAcquisitionBand';
import { evaluateAcquisitionMethodPerformanceProfile } from './rules/acquisitionMethodPerformanceProfile';
import { evaluateStrongDealInToDealOutJourney } from './rules/strongDealInToDealOutJourney';
import { evaluateStrongDealOutChannel } from './rules/strongDealOutChannel';
import { evaluateStrongDealInChannel } from './rules/strongDealInChannel';
import type { AcquisitionMethodPerformanceProfileFinding, InsightsSection, SelectedFinding } from './types';

export const INSIGHTS_ENGINE_VERSION = '1.5';
export const FINDINGS_SELECTOR_VERSION = '1.5';
export const SOURCE_ANALYTICS_VERSION = '2.11';

export interface SelectFindingsInput {
  targetUserAcquisitionEvidence: unknown;
  targetUserInventorySegmentationEvidence: unknown;
  targetUserDealChannelEvidence: unknown;
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
  const methodProfile = evaluateAcquisitionMethodPerformanceProfile(input.targetUserAcquisitionEvidence);
  const channelJourney = evaluateStrongDealInToDealOutJourney(input.targetUserDealChannelEvidence);
  const dealOutChannel = evaluateStrongDealOutChannel(input.targetUserDealChannelEvidence);
  const dealInChannel = evaluateStrongDealInChannel(input.targetUserDealChannelEvidence);

  const selectedFindings: Array<SelectedFinding | AcquisitionMethodPerformanceProfileFinding> = [];
  if (broad.result.status === 'selected') selectedFindings.push(broad.result);
  if (category.result.status === 'selected') selectedFindings.push(category.result);
  if (methodProfile.result.status === 'selected') selectedFindings.push(methodProfile.result);
  if (channelJourney.result.status === 'selected') selectedFindings.push(channelJourney.result);
  if (dealOutChannel.result.status === 'selected') selectedFindings.push(dealOutChannel.result);
  if (dealInChannel.result.status === 'selected') selectedFindings.push(dealInChannel.result);

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
    rule_evaluations: [
      ...broad.candidateEvaluations,
      ...category.candidateEvaluations,
      ...methodProfile.candidateEvaluations,
      ...channelJourney.candidateEvaluations,
      ...dealOutChannel.candidateEvaluations,
      ...dealInChannel.candidateEvaluations,
    ],
  };
}
