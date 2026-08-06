// Auditable AI Advice v1.0 — shared types. This layer reads an EXISTING,
// already-completed analytics_runs.snapshot (never live inventory, never
// the newest run in place of the one asked for) and never mutates it. See
// generateAdvice.ts for the full lifecycle and buildInputPacket.ts for how
// the packet below is derived.

export const ADVICE_SCHEMA_VERSION = '1.0';
export const PROMPT_TEMPLATE_VERSION = 'analytics-advice-v1';
export const ADVICE_PROVIDER = 'openai';

export type AdviceStatus = 'pending' | 'generating' | 'completed' | 'failed';

// ── DB row shape (public.analytics_run_advice) ──────────────────────────

export interface AnalyticsRunAdviceRow {
  id: number;
  analytics_run_id: number;
  user_id: number;
  revision_number: number;
  status: AdviceStatus;
  provider: string;
  model: string;
  advice_schema_version: string;
  prompt_template_version: string;
  canonical_input_hash: string | null;
  advice: StructuredAdviceResponse | null;
  source_refs: SourceRegistryEntry[] | null;
  generated_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

// Metadata-only shape (everything except `advice`/`source_refs`) — for
// History-list bulk lookups that must never pull every revision's full
// structured payload into memory at once.
export type AnalyticsRunAdviceMeta = Omit<AnalyticsRunAdviceRow, 'advice' | 'source_refs'>;

// ── Source registry ──────────────────────────────────────────────────────
// The complete, closed list of citable evidence for one run — built once
// from the saved snapshot, before calling OpenAI, and used both to prompt
// the model (it receives every source_id here) and to validate the
// response afterward (every advice_cards[].source_ids value must appear
// here or the card is rejected). Deliberately compact: headline/summary/
// confidence/key metrics/limitations only — never item names, notes,
// counterparty info, or arrays of raw item/deal IDs beyond the one
// target-user item_id a Business/Hybrid open-inventory insight already
// legitimately carries.

export type SourceType = 'deterministic_insight' | 'confirmed_pattern' | 'preliminary_hypothesis';

export interface SourceRegistryEntry {
  source_id: string;
  source_type: SourceType;
  /** Only ever the AUTHENTICATED TARGET USER's own item — present only for
   *  item-level deterministic insights (Business/Hybrid open-inventory
   *  priority). Never another user's item. */
  item_id: number | null;
  headline: string;
  summary: string;
  /** Existing confidence tier where the source has one; Business/Hybrid
   *  open-inventory priority findings have no peer-compared confidence
   *  tier at all — null there, never fabricated. */
  confidence: string | null;
  key_metrics: Record<string, unknown>;
  limitations: string[];
  /** Present only for preliminary_hypothesis sources. */
  confirmation_needed?: string[];
  ineligibility_reasons?: string[];
}

// ── Advice Input Packet ──────────────────────────────────────────────────
// The compact, deterministic payload sent to OpenAI — never the full Raw
// Snapshot, never rule_evaluations/candidate_evaluations, never another
// user's data. Canonical-hashed exactly as constructed here (see
// canonicalHash.ts) before any volatile field (none exist in this shape —
// there is no timestamp inside the packet itself; generated_at describes
// the SOURCE run, not packet construction time).

export interface AdviceInputPacketRunMeta {
  run_id: number;
  run_generated_at: string;
  analytics_version: string;
  insights_engine_version: string | null;
  findings_selector_version: string | null;
  pattern_discovery_engine_version: string | null;
  pattern_discovery_schema_version: string | null;
  evidence_scope: string;
}

export interface AdviceInputPacketSource {
  source_id: string;
  source_type: SourceType;
  headline: string;
  summary: string;
  confidence: string | null;
  key_metrics: Record<string, unknown>;
  limitations: string[];
  confirmation_needed?: string[];
  ineligibility_reasons?: string[];
}

export interface AdviceInputPacket {
  packet_version: '1.0';
  run: AdviceInputPacketRunMeta;
  deterministic_insights: AdviceInputPacketSource[];
  confirmed_patterns: AdviceInputPacketSource[];
  preliminary_hypotheses: AdviceInputPacketSource[];
  pattern_selection_summary: Record<string, unknown> | null;
  allowed_source_ids: string[];
}

// ── Structured OpenAI response ───────────────────────────────────────────

export type AdviceCardType = 'action' | 'observation' | 'watch' | 'review';
export type AdvicePriority = 'high' | 'medium' | 'low';
export type AdviceConfidenceLabel = 'stronger' | 'moderate' | 'low' | 'preliminary';

export interface AdviceCard {
  advice_code: string;
  advice_type: AdviceCardType;
  priority: AdvicePriority;
  headline: string;
  advice: string;
  why_it_matters: string;
  confidence_label: AdviceConfidenceLabel;
  source_ids: string[];
  limitations: string[];
  item_id: number | null;
}

export interface AdviceRunSummary {
  headline: string;
  summary: string;
  source_ids: string[];
}

export interface StructuredAdviceResponse {
  schema_version: '1.0';
  run_summary: AdviceRunSummary;
  advice_cards: AdviceCard[];
  limitations: string[];
}

export const MAX_ADVICE_CARDS = 3;
