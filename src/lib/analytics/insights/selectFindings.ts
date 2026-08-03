// Insights Engine v1.6 — orchestrator. Runs the Findings Selector rule set
// against Analytics target-user evidence sections and assembles the
// `insights` section merged into analytics_runs.snapshot by runAnalytics.ts.
// Does not read or write Analytics data itself — the caller supplies the
// already-validated snapshot sections as plain evidence.
//
// v1.6 adds STRONG_LISTING_PLATFORM, reading target_user_listing_channel_
// evidence.performance_by_listing_channel (Analytics v2.11's per-platform
// listing-to-exit timing fields) — the ONLY rule that reads this evidence
// section. SOURCE_ANALYTICS_VERSION stays 2.11 (this task adds no new
// Analytics SQL — v2.11 already carried the evidence this rule needed).
// The other six rules are unchanged in behavior.
//
// Rules implemented:
//   STRONG_BALANCED_ACQUISITION_BAND       (v1.0, unchanged in behavior)
//   STRONG_CATEGORY_ACQUISITION_BAND       (v1.1, unchanged in behavior)
//   ACQUISITION_METHOD_PERFORMANCE_PROFILE (v1.2, unchanged in behavior)
//   STRONG_DEAL_IN_TO_DEAL_OUT_JOURNEY      (v1.3, unchanged in behavior)
//   STRONG_DEAL_OUT_CHANNEL                 (v1.4, unchanged in behavior)
//   STRONG_DEAL_IN_CHANNEL                  (v1.5, unchanged in behavior)
//   STRONG_LISTING_PLATFORM                 (new in v1.6)
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
// channel-journey, deal-out-channel, deal-in-channel, and listing-platform
// rules have no relationship to that pair, or to each other — Deal In and
// Deal Out evaluate different questions (where inventory was sourced vs.
// where it exited), and Listing Platform answers yet another one (where an
// item was advertised) — none of these three are ever deduplicated or
// suppressed against each other, even when they happen to select the same
// channel_id or reference the same channel name.

import { evaluateStrongBalancedAcquisitionBand } from './rules/strongBalancedAcquisitionBand';
import { evaluateStrongCategoryAcquisitionBand } from './rules/strongCategoryAcquisitionBand';
import { FINDING_CODE as STRONG_BALANCED_ACQUISITION_BAND_CODE } from './rules/strongBalancedAcquisitionBand';
import { evaluateAcquisitionMethodPerformanceProfile } from './rules/acquisitionMethodPerformanceProfile';
import { evaluateStrongDealInToDealOutJourney } from './rules/strongDealInToDealOutJourney';
import { evaluateStrongDealOutChannel } from './rules/strongDealOutChannel';
import { evaluateStrongDealInChannel } from './rules/strongDealInChannel';
import { evaluateStrongListingPlatform } from './rules/strongListingPlatform';
import type { AcquisitionMethodPerformanceProfileFinding, InsightsSection, ListingPlatformFinding, SelectedFinding } from './types';

export const INSIGHTS_ENGINE_VERSION = '1.6';
export const FINDINGS_SELECTOR_VERSION = '1.6';
export const SOURCE_ANALYTICS_VERSION = '2.11';

export interface SelectFindingsInput {
  targetUserAcquisitionEvidence: unknown;
  targetUserInventorySegmentationEvidence: unknown;
  targetUserDealChannelEvidence: unknown;
  targetUserListingChannelEvidence: unknown;
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
  const listingPlatform = evaluateStrongListingPlatform(input.targetUserListingChannelEvidence);

  const selectedFindings: Array<SelectedFinding | AcquisitionMethodPerformanceProfileFinding | ListingPlatformFinding> = [];
  if (broad.result.status === 'selected') selectedFindings.push(broad.result);
  if (category.result.status === 'selected') selectedFindings.push(category.result);
  if (methodProfile.result.status === 'selected') selectedFindings.push(methodProfile.result);
  if (channelJourney.result.status === 'selected') selectedFindings.push(channelJourney.result);
  if (dealOutChannel.result.status === 'selected') selectedFindings.push(dealOutChannel.result);
  if (dealInChannel.result.status === 'selected') selectedFindings.push(dealInChannel.result);
  if (listingPlatform.result.status === 'selected') selectedFindings.push(listingPlatform.result);

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
      ...listingPlatform.candidateEvaluations,
    ],
  };
}
