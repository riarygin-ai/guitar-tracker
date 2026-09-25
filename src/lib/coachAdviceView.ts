// Pure, client-safe view helpers for the general Business Coach detail drawer
// (Dashboard "Latest Analytics Advice"). Like listingAdviceView.ts, everything
// here works ONLY from the PERSISTED records of the analytics_run_advice
// revision being shown: stored source_ids are resolved against that revision's
// immutable input_packet (falling back to its source_refs registry for legacy
// rows without a packet). Nothing is re-queried and no live inventory, lead or
// analytics data is consulted, so the drawer shows exactly what the Coach saw.

import type { AdviceCard, AdviceInputPacket, AdviceInputPacketSource, SourceRegistryEntry } from './analytics/advice/types';
import type { LinkedDealAnalyticsContext, LinkedDealMetrics } from './analytics/advice/linkedDealAnalytics';
import { formatLimitation, humanizeCode } from './analytics/advice/presentation';
import {
  adviceActions as demandActions, resolveEvidence as resolveDemandEvidence,
  type AdviceAction, type EvidenceBlock,
} from './listingAdviceView';

type PersistedSource = AdviceInputPacketSource | SourceRegistryEntry;

const SOURCE_BADGE: Record<string, { kind: EvidenceBlock['kind']; badge: string }> = {
  deterministic_insight: { kind: 'insight', badge: 'Deterministic insight' },
  confirmed_pattern: { kind: 'pattern', badge: 'Confirmed pattern' },
  preliminary_hypothesis: { kind: 'hypothesis', badge: 'Preliminary hypothesis' },
  linked_deal_analytics: { kind: 'linked_deal', badge: 'Lead → Deal linkage' },
};

/** Every non-demand source persisted with the revision (packet first, registry fallback). */
function persistedSources(packet: AdviceInputPacket | null, registry: SourceRegistryEntry[] | null): PersistedSource[] {
  if (packet) return [...packet.deterministic_insights, ...packet.confirmed_patterns, ...packet.preliminary_hypotheses];
  return (registry ?? []).filter((s) => s.source_type !== 'listing_demand');
}

function metricValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function sourceBlock(s: PersistedSource): EvidenceBlock {
  const meta = SOURCE_BADGE[s.source_type] ?? { kind: 'insight' as const, badge: humanizeCode(s.source_type) };
  const facts = Object.entries(s.key_metrics ?? {})
    .filter(([, v]) => v == null || typeof v !== 'object')
    .slice(0, 8)
    .map(([k, v]) => ({ label: humanizeCode(k), value: metricValue(v) }));
  return { sourceId: s.source_id, kind: meta.kind, badge: meta.badge, title: s.headline, text: s.summary, facts, weeks: [] };
}

function linkedDealMetricsToFacts(m: LinkedDealMetrics): { label: string; value: string }[] {
  return Object.entries(m)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ({ label: humanizeCode(k), value: metricValue(v) }));
}

/** Resolves one linked_deal:* source id from the persisted context — pure pass-through, never re-queried. */
function resolveLinkedDealEvidence(ctx: LinkedDealAnalyticsContext, sourceId: string): EvidenceBlock | null {
  if (sourceId === ctx.overall.source_id) {
    const { source_id, ...rest } = ctx.overall;
    return { sourceId: source_id, kind: 'linked_deal', badge: 'Lead → Deal linkage — overall', title: 'Lead → Deal linkage — overall', facts: linkedDealMetricsToFacts(rest), weeks: [] };
  }
  const channel = ctx.by_channel.find((c) => c.source_id === sourceId);
  if (channel) {
    const { source_id, channel_id, channel_name, ...rest } = channel;
    return { sourceId: source_id, kind: 'linked_deal', badge: 'Lead → Deal linkage', title: `Lead → Deal linkage — ${channel_name}`, facts: linkedDealMetricsToFacts(rest), weeks: [] };
  }
  return null;
}

/** Resolves one stored source id to evidence, or null when it is not in the persisted revision. */
export function resolveCoachEvidence(sourceId: string, packet: AdviceInputPacket | null, registry: SourceRegistryEntry[] | null): EvidenceBlock | null {
  if (sourceId.startsWith('demand:')) {
    return packet?.listing_demand ? resolveDemandEvidence({ listing_demand: packet.listing_demand }, sourceId) : null;
  }
  if (sourceId.startsWith('linked_deal:')) {
    return packet?.linked_deal_analytics ? resolveLinkedDealEvidence(packet.linked_deal_analytics, sourceId) : null;
  }
  const s = persistedSources(packet, registry).find((x) => x.source_id === sourceId);
  return s ? sourceBlock(s) : null;
}

export function resolveCoachCardEvidence(card: AdviceCard, packet: AdviceInputPacket | null, registry: SourceRegistryEntry[] | null): EvidenceBlock[] {
  return card.source_ids.map((id) => resolveCoachEvidence(id, packet, registry)).filter((b): b is EvidenceBlock => b !== null);
}

/** The card's own limitations plus those persisted on the sources it cites (deduplicated, humanized). */
export function coachLimitations(card: AdviceCard, packet: AdviceInputPacket | null, registry: SourceRegistryEntry[] | null): string[] {
  const out: string[] = [];
  const add = (l: string) => { const h = formatLimitation(l); if (!out.includes(h)) out.push(h); };
  card.limitations.forEach(add);
  const cited = new Set(card.source_ids);
  for (const s of persistedSources(packet, registry)) if (cited.has(s.source_id)) (s.limitations ?? []).forEach(add);
  if (packet?.listing_demand && cited.has(packet.listing_demand.data_quality.source_id)) packet.listing_demand.data_quality.limitations.forEach(add);
  if (packet?.linked_deal_analytics && cited.has(packet.linked_deal_analytics.overall.source_id)) packet.linked_deal_analytics.limitations.forEach(add);
  return out;
}

/**
 * Deterministic navigation actions. Open Item comes from the card's own item_id
 * or an item-level cited source in the registry; View Leads comes only from
 * cited persisted Listing Demand sources (item / channel / market window).
 * Never model-written URLs.
 */
export function coachActions(card: AdviceCard, packet: AdviceInputPacket | null, registry: SourceRegistryEntry[] | null, returnTo: string | null): AdviceAction[] {
  const out: AdviceAction[] = [];
  const seen = new Set<string>();
  const push = (a: AdviceAction) => { if (!seen.has(a.href)) { seen.add(a.href); out.push(a); } };

  if (packet?.listing_demand) {
    for (const a of demandActions(card, { listing_demand: packet.listing_demand }, returnTo)) push(a);
  }

  const itemIds: number[] = [];
  if (card.item_id != null) itemIds.push(card.item_id);
  for (const id of card.source_ids) {
    const ref = (registry ?? []).find((r) => r.source_id === id);
    if (ref?.item_id != null && !itemIds.includes(ref.item_id)) itemIds.push(ref.item_id);
  }
  for (const id of itemIds) push({ label: 'Open Item', href: `/inventory/${id}`, kind: 'open_item', subject: `item #${id}` });

  return out;
}
