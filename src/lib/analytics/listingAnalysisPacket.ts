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
import type { ItemListing, ItemListingPriceHistory } from '@/types';

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

// ═══════════════════════════════════════════════════════════════════════
// Analysis Export Data — the single "one complete dataset" export.
//
// A separate, additive artifact from ListingAnalysisPacket above (which
// remains exactly as-is, still powering the per-channel "Copy {Channel}
// Analysis" quick-copy buttons). This is what the primary "Copy Analysis
// Data" / "Download Analysis Data" controls on the Listing Dashboard
// build instead — always the complete population (every currently-open
// item, listed AND unlisted, never restricted by channel/scope), with
// each item's full item_listings history and, per listing cycle, its full
// item_listing_price_history — not just the current/active cycle or the
// latest price.
//
// Built ON TOP of buildListingAnalysisPacket({ scope: 'all' }) — every
// field that function already returns is preserved verbatim (schema_
// version, generated_at, scope, analysis_context, summary, channel_
// summary, category_channel_matrix, cross_listing, listed_elsewhere_not_
// in_scope, personal_summary, limitations). This module never
// recalculates listing state itself, same discipline as the packet
// builder above — listing_history/price_history are reshapes of rows the
// caller already bulk-fetched (see src/app/api/listing-analysis-export/
// route.ts), never a second query issued from here.
// ═══════════════════════════════════════════════════════════════════════

// One item_listings row, reshaped for export. Field names/values are
// reproduced verbatim from the actual item_listings schema (see
// supabase/migrations/20260828000000_item_listings_lifecycle.sql and
// 20260905000000_item_listing_price_history.sql) — channel_id/channel_name
// mirror the existing ActiveListingEntry convention (listingEvidence.ts)
// rather than exposing the raw deal_channel_id column name. user_id/
// inventory_item_id are omitted as redundant — this entry is always
// already nested under one specific item, for the one authenticated user.
export interface ListingHistoryEntry {
  id: number;
  channel_id: number;
  channel_name: string | null;
  title: string | null;
  description: string | null;
  status: ItemListing['status'];
  listed_at: string | null;
  ended_at: string | null;
  cancelled_at: string | null;
  asking_price: number | null;
  trade_value: number | null;
  is_ai_generated: boolean;
  created_at: string;
  updated_at: string;
  // Every asking_price change recorded for THIS listing cycle, oldest
  // first — never collapsed to only the latest price.
  price_history: ListingPriceHistoryEntry[];
}

// One item_listing_price_history row, reshaped for export — field names
// reproduced verbatim from that table. item_listing_id is kept (even
// though the entry is already nested under its own ListingHistoryEntry)
// so a price change remains self-describing if ever flattened/exported
// out of context.
export interface ListingPriceHistoryEntry {
  item_listing_id: number;
  old_asking_price: number | null;
  new_asking_price: number;
  changed_at: string;
}

export type ExportListedItemEvidence = ListedItemEvidence & { listing_history: ListingHistoryEntry[] };
export type ExportUnlistedItemEvidence = UnlistedItemEvidence & { listing_history: ListingHistoryEntry[] };

// Same shape as ListingAnalysisPacket, with every item array enriched by
// listing_history, plus unlisted_unclassified_items — evidence already
// computes this bucket (unlisted_open_inventory.unclassified) but
// ListingAnalysisPacket never surfaced it; "one complete dataset" means no
// open item is silently excluded here, so this new array closes that gap
// without touching listed_items/unlisted_business_items/unlisted_hybrid_
// items' existing shape or meaning.
export interface AnalysisExportData extends Omit<ListingAnalysisPacket, 'listed_items' | 'unlisted_business_items' | 'unlisted_hybrid_items'> {
  listed_items: ExportListedItemEvidence[];
  unlisted_business_items: ExportUnlistedItemEvidence[];
  unlisted_hybrid_items: ExportUnlistedItemEvidence[];
  unlisted_unclassified_items: ExportUnlistedItemEvidence[];
}

export interface BuildAnalysisExportDataParams {
  evidence: ListingEvidence;
  // Every item_listings row for this user — every status (draft/active/
  // ended/cancelled), not just active ones. Bulk-fetched once by the
  // caller (no per-item query).
  itemListings: ItemListing[];
  // Every item_listing_price_history row for this user. Bulk-fetched once
  // by the caller (no per-listing query).
  priceHistory: ItemListingPriceHistory[];
}

function compareIsoAscending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Builds the complete Analysis Export dataset: every currently-open item
 * (listed and unlisted) with its full listing_history, each cycle in turn
 * carrying its full price_history. Pure/synchronous — all data (evidence,
 * item_listings, price_history) is already in memory; grouping/joining
 * happens here rather than via any additional query.
 */
export function buildAnalysisExportData({
  evidence,
  itemListings,
  priceHistory,
}: BuildAnalysisExportDataParams): AnalysisExportData {
  const basePacket = buildListingAnalysisPacket(evidence, { scope: 'all' });

  // Every listing-capable channel, id -> name. evidence.channel_summary
  // already LEFT JOINs every is_listing_platform channel (zero-count ones
  // included), so this covers every deal_channel_id an item_listings row
  // could reference without a second query.
  const channelNameById = new Map<number, string>(
    evidence.channel_summary.map((c) => [c.channel_id, c.channel_name]),
  );

  // Group price history by listing id, chronological (oldest -> newest).
  const priceHistoryByListingId = new Map<number, ListingPriceHistoryEntry[]>();
  for (const p of [...priceHistory].sort((a, b) => compareIsoAscending(a.changed_at, b.changed_at))) {
    const entry: ListingPriceHistoryEntry = {
      item_listing_id: p.item_listing_id,
      old_asking_price: p.old_asking_price,
      new_asking_price: p.new_asking_price,
      changed_at: p.changed_at,
    };
    const existing = priceHistoryByListingId.get(p.item_listing_id);
    if (existing) existing.push(entry);
    else priceHistoryByListingId.set(p.item_listing_id, [entry]);
  }

  // Group listing cycles by inventory item, chronological (oldest ->
  // newest) — multiple cycles for the same item + platform are preserved,
  // never collapsed to one row per platform.
  const listingsByItemId = new Map<number, ListingHistoryEntry[]>();
  for (const l of [...itemListings].sort((a, b) => compareIsoAscending(a.created_at, b.created_at))) {
    const entry: ListingHistoryEntry = {
      id: l.id,
      channel_id: l.deal_channel_id,
      channel_name: channelNameById.get(l.deal_channel_id) ?? null,
      title: l.title,
      description: l.description,
      status: l.status,
      listed_at: l.listed_at,
      ended_at: l.ended_at,
      cancelled_at: l.cancelled_at,
      asking_price: l.asking_price,
      trade_value: l.trade_value,
      is_ai_generated: l.is_ai_generated,
      created_at: l.created_at,
      updated_at: l.updated_at,
      price_history: priceHistoryByListingId.get(l.id) ?? [],
    };
    const existing = listingsByItemId.get(l.inventory_item_id);
    if (existing) existing.push(entry);
    else listingsByItemId.set(l.inventory_item_id, [entry]);
  }

  function withHistory<T extends { item_id: number }>(items: T[]): (T & { listing_history: ListingHistoryEntry[] })[] {
    return items.map((item) => ({ ...item, listing_history: listingsByItemId.get(item.item_id) ?? [] }));
  }

  return {
    ...basePacket,
    listed_items: withHistory(evidence.listed_items),
    unlisted_business_items: withHistory(evidence.unlisted_open_inventory.business),
    unlisted_hybrid_items: withHistory(evidence.unlisted_open_inventory.hybrid),
    unlisted_unclassified_items: withHistory(evidence.unlisted_open_inventory.unclassified),
  };
}

/** Counts for the export's own "Copied All Inventory Analysis · N items · M listing cycles" confirmation message. */
export interface AnalysisExportSummary {
  itemCount: number;
  currentListingsCount: number;
  unlistedItemCount: number;
  listingCycleCount: number;
}

export function summarizeAnalysisExportForConfirmation(data: AnalysisExportData): AnalysisExportSummary {
  const allItems = [
    ...data.listed_items,
    ...data.unlisted_business_items,
    ...data.unlisted_hybrid_items,
    ...data.unlisted_unclassified_items,
  ];
  return {
    itemCount: allItems.length,
    currentListingsCount: data.listed_items.length,
    unlistedItemCount: data.unlisted_business_items.length + data.unlisted_hybrid_items.length + data.unlisted_unclassified_items.length,
    listingCycleCount: allItems.reduce((sum, item) => sum + item.listing_history.length, 0),
  };
}

/** Plain-text confirmation line, e.g. "Copied All Inventory Analysis · 42 items · 9 current listings · 61 listing cycles". */
export function formatAnalysisExportConfirmationMessage(data: AnalysisExportData): string {
  const s = summarizeAnalysisExportForConfirmation(data);
  return `Copied All Inventory Analysis · ${s.itemCount} item${s.itemCount === 1 ? '' : 's'} · ${s.currentListingsCount} current listing${s.currentListingsCount === 1 ? '' : 's'} · ${s.listingCycleCount} listing cycle${s.listingCycleCount === 1 ? '' : 's'}`;
}
