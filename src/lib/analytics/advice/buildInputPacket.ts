// Auditable AI Advice v1.0 — deterministic packet + source registry builder.
// Pure functions only — no I/O, no OpenAI call, no Supabase client. Reads
// EXCLUSIVELY from an already-saved analytics_runs row (id, snapshot,
// analytics_version, evidence_scope) passed in by the caller — never
// fetches "the latest run" itself, never touches live inventory. Old runs
// missing `insights`/`pattern_discovery` simply yield empty arrays here,
// never a throw — see buildAdviceInputPacket's own return shape.
//
// Deliberately excludes: insights.rule_evaluations, pattern_discovery.
// candidate_evaluations, the full snapshot, calendar evidence (no existing
// engine selects a calendar finding today, so there is nothing eligible to
// include — see the task's own conditional instruction), and any other
// user's data (this module only ever sees ONE user's own saved snapshot,
// by construction of the caller).

import type {
  AdviceInputPacket,
  AdviceInputPacketRunMeta,
  AdviceInputPacketSource,
  SourceRegistryEntry,
  SourceType,
} from './types';

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => toRecord(v) !== null) : [];
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ── Deterministic Insight source IDs ─────────────────────────────────────
// Prefers a natural segment identity (item_id for the two item-level
// rules, band/category/channel/journey identity for the peer-comparison
// rules); every one of the 9 Insights rule families selects AT MOST one
// winning finding, so finding_code alone is already unique per run — the
// segment suffix exists for readability/traceability, and the numeric
// array index is only a final collision-safe fallback for a shape this
// module doesn't otherwise recognize.

function deriveInsightSourceId(finding: Record<string, unknown>, indexInArray: number): string {
  const code = toStringOrNull(finding.finding_code) ?? `UNKNOWN_FINDING_${indexInArray}`;
  const segment = toRecord(finding.segment);

  if (segment) {
    const itemId = toNumberOrNull(segment.item_id);
    if (itemId !== null) return `insight:${code}:item:${itemId}`;

    const bandOrder = toNumberOrNull(segment.acquisition_value_band_order);
    if (bandOrder !== null) return `insight:${code}:band:${bandOrder}`;

    const categoryId = toNumberOrNull(segment.category_id);
    if (categoryId !== null) return `insight:${code}:category:${categoryId}`;

    const dealInId = toNumberOrNull(segment.deal_in_channel_id);
    const dealOutId = toNumberOrNull(segment.deal_out_channel_id);
    if (dealInId !== null && dealOutId !== null) return `insight:${code}:journey:${dealInId}-${dealOutId}`;
    if (dealOutId !== null) return `insight:${code}:channel:${dealOutId}`;
    if (dealInId !== null) return `insight:${code}:channel:${dealInId}`;

    const listingChannelId = toNumberOrNull(segment.listing_channel_id);
    if (listingChannelId !== null) return `insight:${code}:channel:${listingChannelId}`;

    const channelId = toNumberOrNull(segment.channel_id);
    if (channelId !== null) return `insight:${code}:channel:${channelId}`;
  }

  // No natural per-segment identity on this finding shape (e.g.
  // ACQUISITION_METHOD_PERFORMANCE_PROFILE, whose evidence is a multi-
  // comparison structure, not a single segment) — finding_code alone is
  // already unique per run.
  return indexInArray === 0 ? `insight:${code}` : `insight:${code}:${indexInArray}`;
}

function insightKeyMetrics(finding: Record<string, unknown>): Record<string, unknown> {
  const metrics = toRecord(finding.metrics);
  if (metrics) return metrics;

  // AcquisitionMethodPerformanceProfileFinding has no `metrics` field — its
  // evidence lives in `comparisons` (one row per comparable exit method).
  if (Array.isArray(finding.comparisons)) {
    return { profile_code: finding.profile_code ?? null, comparisons: finding.comparisons };
  }

  return {};
}

function buildInsightSource(finding: Record<string, unknown>, indexInArray: number): AdviceInputPacketSource | null {
  const headline = toStringOrNull(finding.headline);
  const summary = toStringOrNull(finding.summary);
  if (headline === null || summary === null) return null; // malformed row — skip, never throw

  return {
    source_id: deriveInsightSourceId(finding, indexInArray),
    source_type: 'deterministic_insight',
    headline,
    summary,
    confidence: toStringOrNull(finding.confidence),
    key_metrics: insightKeyMetrics(finding),
    limitations: toStringArray(finding.limitations),
  };
}

// ── Confirmed Pattern / Preliminary Hypothesis source IDs ────────────────
// Confirmed patterns use pattern_code (DISCOVERY|{pattern_type}|
// {pattern_key}) directly. Hypotheses are prefixed "hypothesis" and keyed
// by pattern_key (not pattern_code) — matches the task's own worked
// example (hypothesis:CATEGORY|category_id=1) exactly.

function patternKeyMetrics(pattern: Record<string, unknown>): Record<string, unknown> {
  const metricEffects = toArray(pattern.metric_effects).map((e) => ({
    metric_code: e.metric_code ?? null,
    available: e.available ?? null,
    candidate_value: e.candidate_value ?? null,
    peer_baseline_median: e.peer_baseline_median ?? null,
    advantage_value: e.advantage_value ?? null,
    direction: e.direction ?? null,
  }));
  return {
    triggered_signals: toStringArray(pattern.triggered_signals),
    metrics: metricEffects,
    realized_item_count: pattern.realized_item_count ?? null,
    distinct_exit_deal_count: pattern.distinct_exit_deal_count ?? null,
  };
}

function buildPatternSource(pattern: Record<string, unknown>, sourceType: 'confirmed_pattern' | 'preliminary_hypothesis'): AdviceInputPacketSource | null {
  const headline = toStringOrNull(pattern.headline);
  const summary = toStringOrNull(pattern.summary);
  const patternKey = toStringOrNull(pattern.pattern_key);
  const patternCode = toStringOrNull(pattern.pattern_code);
  if (headline === null || summary === null || (patternKey === null && patternCode === null)) return null;

  const sourceId =
    sourceType === 'confirmed_pattern'
      ? `pattern:${patternCode ?? patternKey}`
      : `hypothesis:${patternKey ?? patternCode}`;

  const entry: AdviceInputPacketSource = {
    source_id: sourceId,
    source_type: sourceType,
    headline,
    summary,
    confidence: toStringOrNull(pattern.evidence_confidence),
    key_metrics: patternKeyMetrics(pattern),
    limitations: toStringArray(pattern.limitations),
  };
  if (sourceType === 'preliminary_hypothesis') {
    entry.confirmation_needed = toStringArray(pattern.confirmation_needed);
    entry.ineligibility_reasons = toStringArray(pattern.ineligibility_reasons);
  }
  return entry;
}

// ── Top-level builder ─────────────────────────────────────────────────────

export interface BuildAdviceInputPacketParams {
  runId: number;
  /** analytics_runs.analytics_version — NOT re-derived from the snapshot's
   *  own version fields, so old-shape snapshots still produce a packet. */
  analyticsVersion: string;
  evidenceScope: string;
  /** analytics_runs.snapshot — the exact saved JSON, unmodified. */
  snapshot: unknown;
}

export interface BuildAdviceInputPacketResult {
  /** null when the saved snapshot contains no usable deterministic
   *  evidence at all (no insights AND no pattern_discovery) — the caller
   *  must not attempt generation in that case. */
  packet: AdviceInputPacket | null;
  sourceRegistry: SourceRegistryEntry[];
  /** Human-readable notes on what was unavailable (e.g. old run predating
   *  Insights/Pattern Discovery) — never thrown, always returned so the UI
   *  can explain the gap. */
  notes: string[];
}

export function buildAdviceInputPacket(params: BuildAdviceInputPacketParams): BuildAdviceInputPacketResult {
  const notes: string[] = [];
  const snapshot = toRecord(params.snapshot);
  if (!snapshot) {
    return { packet: null, sourceRegistry: [], notes: ['SNAPSHOT_MISSING_OR_MALFORMED'] };
  }

  const insights = toRecord(snapshot.insights);
  if (!insights) notes.push('INSIGHTS_UNAVAILABLE_ON_THIS_RUN');
  const selectedFindings = insights ? toArray(insights.selected_findings) : [];

  const patternDiscovery = toRecord(snapshot.pattern_discovery);
  if (!patternDiscovery) notes.push('PATTERN_DISCOVERY_UNAVAILABLE_ON_THIS_RUN');
  const selectedPatterns = patternDiscovery ? toArray(patternDiscovery.selected_patterns) : [];
  const emergingHypotheses = patternDiscovery ? toArray(patternDiscovery.emerging_hypotheses) : [];
  const selectionSummary = patternDiscovery ? toRecord(patternDiscovery.selection_summary) : null;

  const deterministicInsights = selectedFindings
    .map((f, i) => buildInsightSource(f, i))
    .filter((s): s is AdviceInputPacketSource => s !== null);
  const confirmedPatterns = selectedPatterns
    .map((p) => buildPatternSource(p, 'confirmed_pattern'))
    .filter((s): s is AdviceInputPacketSource => s !== null);
  const preliminaryHypotheses = emergingHypotheses
    .map((h) => buildPatternSource(h, 'preliminary_hypothesis'))
    .filter((s): s is AdviceInputPacketSource => s !== null);

  if (deterministicInsights.length === 0 && confirmedPatterns.length === 0 && preliminaryHypotheses.length === 0) {
    notes.push('NO_CITABLE_EVIDENCE_ON_THIS_RUN');
    return { packet: null, sourceRegistry: [], notes };
  }

  const runMeta: AdviceInputPacketRunMeta = {
    run_id: params.runId,
    run_generated_at: toStringOrNull(snapshot.generated_at) ?? '',
    analytics_version: params.analyticsVersion,
    insights_engine_version: insights ? toStringOrNull(insights.insights_engine_version) : null,
    findings_selector_version: insights ? toStringOrNull(insights.findings_selector_version) : null,
    pattern_discovery_engine_version: patternDiscovery ? toStringOrNull(patternDiscovery.engine_version) : null,
    pattern_discovery_schema_version: patternDiscovery ? toStringOrNull(patternDiscovery.schema_version) : null,
    evidence_scope: params.evidenceScope,
  };

  const allSources = [...deterministicInsights, ...confirmedPatterns, ...preliminaryHypotheses];

  const packet: AdviceInputPacket = {
    packet_version: '1.0',
    run: runMeta,
    deterministic_insights: deterministicInsights,
    confirmed_patterns: confirmedPatterns,
    preliminary_hypotheses: preliminaryHypotheses,
    pattern_selection_summary: selectionSummary,
    allowed_source_ids: allSources.map((s) => s.source_id),
  };

  const sourceRegistry: SourceRegistryEntry[] = allSources.map((s) => {
    // item_id lives only on the source's own registry entry (never inside
    // the packet sent to OpenAI as a bare top-level field on the source —
    // it IS included in key_metrics/segment context already via the
    // deterministic insight's own headline/summary, and the registry keeps
    // it separately so the UI can build an "Open Item" link without
    // re-parsing key_metrics).
    const itemIdMatch = s.source_id.match(/^insight:.*:item:(\d+)$/);
    return {
      source_id: s.source_id,
      source_type: s.source_type as SourceType,
      item_id: itemIdMatch ? Number(itemIdMatch[1]) : null,
      headline: s.headline,
      summary: s.summary,
      confidence: s.confidence,
      key_metrics: s.key_metrics,
      limitations: s.limitations,
      ...(s.confirmation_needed !== undefined ? { confirmation_needed: s.confirmation_needed } : {}),
      ...(s.ineligibility_reasons !== undefined ? { ineligibility_reasons: s.ineligibility_reasons } : {}),
    };
  });

  return { packet, sourceRegistry, notes };
}

/** DOM-safe id for scroll-to/highlight targets — source_ids contain `|`,
 *  `=`, and `:`, all of which are technically legal in an HTML id but
 *  awkward in CSS selectors/URL fragments, so this is the one place that
 *  encoding happens. Never used for storage/hashing — only for the DOM. */
export function sourceIdToDomId(sourceId: string): string {
  return `advice-source-${encodeURIComponent(sourceId).replace(/[.!~*'()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`;
}
