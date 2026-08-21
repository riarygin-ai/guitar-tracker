// Listing Analysis Packet v1.0 — a deterministic, GPT-friendly export built
// PURELY from an already-computed Listing Evidence v1.0 object. This module
// never queries the database and never recalculates listing state: every
// item array, count, and summary here is either reused verbatim from
// `evidence` or a straightforward filter/reshape of it (see the migration's
// own header: Listing Evidence must remain the single authoritative source
// for current listing state — this packet is a *view* over it, not a
// second computation). No AI, no recommendations — see this module's own
// guardrail/limitation text for what a downstream consumer must not infer.

import type {
  ListingEvidence,
  ChannelSummaryEntry,
  CategoryChannelMatrix,
  CrossListingEvidence,
  ListedItemEvidence,
  UnlistedItemEvidence,
  PersonalSummary,
  PopulationSummary,
  PurposePolicyEntry,
  ListingAgeSemantics,
} from './listingEvidence';

export const LISTING_ANALYSIS_PACKET_SCHEMA_VERSION = '1.0';

export type ListingAnalysisPacketScopeType = 'all' | 'channel' | 'unlisted';

export interface ListingAnalysisPacketScope {
  type: ListingAnalysisPacketScopeType;
  channel_id: number | null;
  channel_name: string | null;
}

export interface ListingAnalysisContext {
  purpose_semantics: {
    business: PurposePolicyEntry;
    hybrid: PurposePolicyEntry;
    personal: PurposePolicyEntry;
  };
  listing_age_semantics: ListingAgeSemantics;
  // Stable, human-readable rules — this packet is designed to be pasted
  // into a brand-new GPT chat with no other app context, so these are full
  // sentences, not just codes.
  guardrails: string[];
}

export interface ListingAnalysisPacket {
  schema_version: '1.0';
  generated_at: string;
  scope: ListingAnalysisPacketScope;
  analysis_context: ListingAnalysisContext;
  summary: PopulationSummary;
  channel_summary: ChannelSummaryEntry[];
  category_channel_matrix: CategoryChannelMatrix;
  cross_listing: CrossListingEvidence;
  listed_items: ListedItemEvidence[];
  listed_elsewhere_not_in_scope: ListedItemEvidence[];
  unlisted_business_items: UnlistedItemEvidence[];
  unlisted_hybrid_items: UnlistedItemEvidence[];
  personal_summary: PersonalSummary;
  limitations: string[];
}

export class ListingAnalysisPacketError extends Error {}

const GUARDRAILS: string[] = [
  'Do not assume Hybrid inventory should be listed.',
  'Do not recommend listing or selling Personal inventory.',
  'Estimated sold value is a user estimate.',
  'Listing age is descriptive evidence, not proof that price is wrong.',
  'Cross-listing coverage is descriptive, not a recommendation to list everywhere.',
  'Asking price may be unavailable/null and must not be inferred from estimated sold value.',
  'Historical-import acquisition dates may be unreliable.',
  'Comparable DOM is contextual evidence, not a guaranteed sale-time prediction.',
];

const EMPTY_CATEGORY_CHANNEL_MATRIX: CategoryChannelMatrix = { rows: [], category_totals: [] };

function buildAnalysisContext(evidence: ListingEvidence): ListingAnalysisContext {
  return {
    purpose_semantics: {
      business: evidence.purpose_semantics.business,
      hybrid: evidence.purpose_semantics.hybrid,
      personal: evidence.purpose_semantics.personal,
    },
    listing_age_semantics: evidence.listing_age_semantics,
    guardrails: GUARDRAILS,
  };
}

function itemHasNullAskingPrice(items: ListedItemEvidence[]): boolean {
  return items.some((item) => item.active_listings.some((listing) => listing.asking_price == null));
}

function buildLimitations(evidence: ListingEvidence, listedItemsInScope: ListedItemEvidence[], listedElsewhere: ListedItemEvidence[]): string[] {
  const limitations = [...evidence.module_limitations];
  if (itemHasNullAskingPrice(listedItemsInScope) || itemHasNullAskingPrice(listedElsewhere)) {
    limitations.push('CURRENT_LISTING_ASKING_PRICE_DATA_IS_UNAVAILABLE_FOR_ONE_OR_MORE_LISTINGS');
  }
  return limitations;
}

export interface BuildListingAnalysisPacketOptions {
  scope: ListingAnalysisPacketScopeType;
  channelId?: number;
}

export function buildListingAnalysisPacket(
  evidence: ListingEvidence,
  options: BuildListingAnalysisPacketOptions,
): ListingAnalysisPacket {
  const { scope, channelId } = options;

  if (scope === 'channel') {
    if (channelId == null) {
      throw new ListingAnalysisPacketError('channelId is required for scope "channel"');
    }
    const channel = evidence.channel_summary.find((c) => c.channel_id === channelId);
    if (!channel) {
      throw new ListingAnalysisPacketError(`Unknown or non-listing-capable channel_id: ${channelId}`);
    }

    const currentlyOnChannel = evidence.listed_items.filter((item) =>
      item.active_listings.some((l) => l.channel_id === channelId),
    );
    const listedElsewhereNotOnChannel = evidence.listed_items.filter((item) =>
      !item.active_listings.some((l) => l.channel_id === channelId),
    );

    return {
      schema_version: LISTING_ANALYSIS_PACKET_SCHEMA_VERSION,
      generated_at: evidence.generated_at,
      scope: { type: 'channel', channel_id: channel.channel_id, channel_name: channel.channel_name },
      analysis_context: buildAnalysisContext(evidence),
      summary: evidence.population_summary,
      channel_summary: [channel],
      category_channel_matrix: EMPTY_CATEGORY_CHANNEL_MATRIX,
      cross_listing: evidence.cross_listing_evidence,
      listed_items: currentlyOnChannel,
      listed_elsewhere_not_in_scope: listedElsewhereNotOnChannel,
      unlisted_business_items: evidence.unlisted_open_inventory.business,
      unlisted_hybrid_items: evidence.unlisted_open_inventory.hybrid,
      personal_summary: evidence.unlisted_open_inventory.personal_summary,
      limitations: buildLimitations(evidence, currentlyOnChannel, listedElsewhereNotOnChannel),
    };
  }

  if (scope === 'unlisted') {
    return {
      schema_version: LISTING_ANALYSIS_PACKET_SCHEMA_VERSION,
      generated_at: evidence.generated_at,
      scope: { type: 'unlisted', channel_id: null, channel_name: null },
      analysis_context: buildAnalysisContext(evidence),
      summary: evidence.population_summary,
      channel_summary: [],
      category_channel_matrix: EMPTY_CATEGORY_CHANNEL_MATRIX,
      cross_listing: evidence.cross_listing_evidence,
      listed_items: [],
      listed_elsewhere_not_in_scope: [],
      unlisted_business_items: evidence.unlisted_open_inventory.business,
      unlisted_hybrid_items: evidence.unlisted_open_inventory.hybrid,
      personal_summary: evidence.unlisted_open_inventory.personal_summary,
      limitations: buildLimitations(evidence, [], []),
    };
  }

  // scope === 'all'
  return {
    schema_version: LISTING_ANALYSIS_PACKET_SCHEMA_VERSION,
    generated_at: evidence.generated_at,
    scope: { type: 'all', channel_id: null, channel_name: null },
    analysis_context: buildAnalysisContext(evidence),
    summary: evidence.population_summary,
    channel_summary: evidence.channel_summary,
    category_channel_matrix: evidence.category_channel_matrix,
    cross_listing: evidence.cross_listing_evidence,
    listed_items: evidence.listed_items,
    listed_elsewhere_not_in_scope: [],
    unlisted_business_items: evidence.unlisted_open_inventory.business,
    unlisted_hybrid_items: evidence.unlisted_open_inventory.hybrid,
    personal_summary: evidence.unlisted_open_inventory.personal_summary,
    limitations: buildLimitations(evidence, evidence.listed_items, []),
  };
}

/** Counts for the "Copied X · N current listings · M unlisted Business items" confirmation message. */
export interface PacketConfirmationSummary {
  scopeLabel: string;
  currentListingsCount: number;
  unlistedBusinessCount: number;
  unlistedHybridCount: number;
}

export function summarizePacketForConfirmation(packet: ListingAnalysisPacket): PacketConfirmationSummary {
  const scopeLabel =
    packet.scope.type === 'channel'
      ? `${packet.scope.channel_name ?? 'Channel'} Analysis`
      : packet.scope.type === 'unlisted'
        ? 'Unlisted Inventory Analysis'
        : 'All Inventory Analysis';

  return {
    scopeLabel,
    currentListingsCount: packet.listed_items.length,
    unlistedBusinessCount: packet.unlisted_business_items.length,
    unlistedHybridCount: packet.unlisted_hybrid_items.length,
  };
}

/** Plain-text confirmation line, e.g. "Copied Reverb Analysis · 28 current listings · 9 unlisted Business items". */
export function formatPacketConfirmationMessage(packet: ListingAnalysisPacket): string {
  const s = summarizePacketForConfirmation(packet);
  if (packet.scope.type === 'unlisted') {
    return `Copied ${s.scopeLabel} · ${s.unlistedBusinessCount} unlisted Business item${s.unlistedBusinessCount === 1 ? '' : 's'} · ${s.unlistedHybridCount} unlisted Hybrid item${s.unlistedHybridCount === 1 ? '' : 's'}`;
  }
  return `Copied ${s.scopeLabel} · ${s.currentListingsCount} current listing${s.currentListingsCount === 1 ? '' : 's'} · ${s.unlistedBusinessCount} unlisted Business item${s.unlistedBusinessCount === 1 ? '' : 's'}`;
}
