export type Status = 'new' | 'owned' | 'listed' | 'sold' | 'traded';

export interface ItemCategory {
  id: number;
  name: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}

export interface ItemSubtype {
  id: number;
  category_id: number;
  name: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}
export type DealType = 'purchase' | 'sale' | 'trade' | 'expense' | HistoricalDealType;

// Legacy pre-app acquisitions. 'Historical Import' is used when the original
// method is unknown; 'Historical Purchase' / 'Historical Trade' are corrected
// labels once the real method is known (see
// supabase/data-fixes/correct_historical_import_operations.sql). All three
// are deliberately distinct from 'purchase'/'trade' — never routed into the
// normal Buy/Trade edit workflows (the UI may still say "Buy" as a label;
// the stored value is always 'purchase'), and never expected to balance like
// a real trade (a Historical Trade has no outgoing side on record).
export type HistoricalDealType = 'Historical Import' | 'Historical Purchase' | 'Historical Trade';

// UI-facing / RPC-parameter value for the Historical Import form's "Deal
// type" selector — mapped SERVER-SIDE (create_item_with_historical_import)
// to a HistoricalDealType: 'purchase' -> 'Historical Purchase',
// 'trade' -> 'Historical Trade', 'unknown' -> 'Historical Import'. Never
// send a HistoricalDealType string directly as this parameter.
export type HistoricalAcquisitionMethod = 'purchase' | 'trade' | 'unknown';

export interface DealChannel {
  id: number;
  name: string;
  is_listing_platform: boolean;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}
export type Direction = 'in' | 'out';
export type CollectionType = 'Personal' | 'Business' | 'Hybrid';
export type Condition = 'Mint' | 'Excellent' | 'Very Good' | 'Good' | 'Fair';

export interface AppUser {
  id: number;
  auth_user_id: string;
  email: string | null;
  display_name: string;
  admin: boolean;
  created_at: string;
}

export interface Brand {
  id: number;
  name: string;
  created_at: string;
}

export interface ItemPurpose {
  id: number;
  name: string;
  is_active: boolean;
  created_at: string;
}

export interface InventoryItem {
  id: number;
  user_id: number;
  brand_id: number;
  item_subtype_id: number | null;
  model: string;
  serial_number: string | null;
  sold_date: string | null;
  estimated_sold_value: number | null;
  collection_type: CollectionType | null;
  purpose_id: number | null;
  condition: Condition | null;
  status: Status;
  notes: string | null;
  year: number | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export type InventoryItemWithValue = InventoryItem & {
  value_in: number | null;
  value_out?: number | null;
  acquired_date?: string | null;
  purpose_name?: string | null;
  item_subtype_name?: string | null;
};

// analytics_item_lifecycle — one row per inventory item; see
// supabase/migrations/20260723000000_analytics_item_lifecycle.sql for the
// full formula documentation (grain, RLS/security_invoker behavior, roi as
// a percentage, tag-array semantics, Historical Import placeholder limits).
export interface AnalyticsItemLifecycle {
  item_id: number;
  user_id: number;

  item_display_name: string;
  model: string;
  year: number | null;
  color: string | null;

  brand_id: number;
  brand_name: string | null;

  category_id: number | null;
  category_name: string | null;

  type_id: number | null;
  type_name: string | null;

  condition_name: string | null;

  purpose_id: number | null;
  purpose_name: string | null;

  current_status: Status;
  estimated_sold_value: number | null;

  tag_ids: number[];
  tag_names: string[];
  tag_count: number;

  acquisition_deal_id: number | null;
  acquisition_date: string | null;
  acquisition_deal_type: string | null;
  acquisition_channel_id: number | null;
  acquisition_channel_name: string | null;
  acquisition_method: 'purchase' | 'trade' | 'unknown' | null;
  acquisition_value: number | null;
  is_historical_import: boolean;
  acquisition_date_is_placeholder: boolean;

  marketplace_listed_at: string | null;
  kijiji_listed_at: string | null;
  reverb_listed_at: string | null;

  first_listed_at: string | null;
  last_listed_at: string | null;
  first_listing_platform: 'Marketplace' | 'Kijiji' | 'Reverb' | 'Multiple' | null;

  listing_platform_count: number;
  is_cross_listed: boolean;

  days_acquisition_to_first_listing: number | null;
  days_first_to_last_listing: number | null;
  global_days_on_market: number | null;

  marketplace_listing_delay_days: number | null;
  marketplace_listing_age_days: number | null;
  marketplace_days_to_exit: number | null;

  kijiji_listing_delay_days: number | null;
  kijiji_listing_age_days: number | null;
  kijiji_days_to_exit: number | null;

  reverb_listing_delay_days: number | null;
  reverb_listing_age_days: number | null;
  reverb_days_to_exit: number | null;

  exit_deal_id: number | null;
  exit_date: string | null;
  exit_type: string | null;
  exit_channel_id: number | null;
  exit_channel_name: string | null;
  exit_value: number | null;
  is_realized: boolean;

  item_expense_count: number;
  item_expenses_total: number;

  // roi is a PERCENTAGE (e.g. 25.5 = 25.5%), matching src/app/page.tsx's
  // existing brand-performance ROI convention — not a 0-1 ratio.
  gross_profit: number | null;
  net_profit: number | null;
  roi: number | null;

  holding_days: number | null;

  has_listing_before_acquisition: boolean;
  has_listing_after_exit: boolean;
  has_lifecycle_date_issue: boolean;
}

export interface Deal {
  id: number;
  user_id: number;
  deal_date: string;
  deal_type: DealType;
  deal_channel_id: number | null;
  cash_received: number | null;
  cash_paid: number | null;
  fees: number | null;
  notes: string | null;
  created_at: string;
}

export interface DealItem {
  id: number;
  user_id: number;
  deal_id: number;
  item_id: number;
  direction: Direction;
  total_value: number | null;
  notes: string | null;
  created_at: string;
}

export interface CashFlow {
  id: number;
  user_id: number;
  deal_id: number | null;
  transaction_date: string;
  opening_balance: number;
  cash_in: number;
  cash_out: number;
  closing_balance: number;
  description: string | null;
  created_at: string;
}

export interface InventoryExpense {
  id: number;
  user_id: number;
  deal_id: number | null;
  item_id: number | null;
  expense_date: string;
  amount: number;
  notes: string;
  created_at: string;
}

export interface InventoryTag {
  id: number;
  name: string;
  is_active: boolean;
  created_at: string;
}

export interface InventoryItemTag {
  id: number;
  item_id: number;
  tag_id: number;
  created_at: string;
}

export interface InventoryItemPhoto {
  id: number;
  user_id: number;
  inventory_item_id: number;
  storage_path: string;
  file_name: string | null;
  content_type: string | null;
  file_size: number | null;
  is_main: boolean;
  sort_order: number;
  created_at: string;
}

export type ListingStatus = 'draft' | 'active' | 'ended' | 'cancelled';

export interface ItemListing {
  id: number;
  user_id: number;
  inventory_item_id: number;
  deal_channel_id: number;
  title: string | null;
  description: string | null;
  asking_price: number | null;
  trade_value: number | null;
  is_ai_generated: boolean;
  ai_prompt_id: number | null;
  status: ListingStatus;
  listed_at: string | null;
  ended_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

// Append-only audit row for item_listings.asking_price changes — written
// exclusively by the item_listings_track_price_history DB trigger
// (20260905000000), never inserted into directly by application code.
export interface ItemListingPriceHistory {
  id: number;
  user_id: number;
  item_listing_id: number;
  old_asking_price: number | null;
  new_asking_price: number;
  changed_at: string;
  created_at: string;
}

// Draft-text fields only — never touches status/listed_at/ended_at/
// cancelled_at. Used by saveListingDraftText, which always targets
// whichever non-terminal (draft or active) row currently exists for the
// item+channel, creating a fresh 'draft' row only if none exists at all.
export type UpsertListingDraftText = {
  id?: number;
  inventory_item_id: number;
  deal_channel_id: number;
  is_ai_generated?: boolean;
  title?: string | null;
  description?: string | null;
  asking_price?: number;
  trade_value?: number;
  ai_prompt_id?: number;
};

export interface AiPrompt {
  id:              number;
  user_id:         number;
  category_id:     number | null;
  deal_channel_id: number;
  prompt_key:      string | null;
  name:            string;
  description:     string | null;
  prompt_text:     string;
  model:           string | null;
  temperature:     number | null;
  is_active:       boolean;
  created_at:      string;
  updated_at:      string;
}

export type UpsertAiPrompt = {
  user_id:         number;
  category_id:     number;
  deal_channel_id: number;
  name:            string;
  description:     string | null;
  prompt_text:     string;
  model:           string | null;
  temperature:     number | null;
  is_active:       boolean;
};

export type UpdateAiPrompt = Partial<Pick<
  AiPrompt,
  'name' | 'description' | 'prompt_text' | 'model' | 'temperature' | 'is_active'
>>;

export type NewBrand = Pick<Brand, 'name'>;

export type NewInventoryItem = Omit<InventoryItem, 'id' | 'created_at' | 'updated_at' | 'user_id'>;
export type NewDeal = Omit<Deal, 'id' | 'created_at' | 'user_id'>;
export type NewDealItem = Omit<DealItem, 'id' | 'created_at' | 'user_id'>;
export type NewCashFlow = Omit<CashFlow, 'id' | 'created_at' | 'user_id'>;
export type NewInventoryExpense = Omit<InventoryExpense, 'id' | 'created_at' | 'user_id'>;

export type UpdateInventoryItem = Partial<Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>> & {
  id: number;
};

export type UpdateDeal = Partial<Omit<Deal, 'id' | 'created_at'>> & {
  id: number;
};

export interface InventorySearchItem extends InventoryItem {
  brand_name: string;
  item_subtype_name: string | null;
}

// ─── Analytics (Phase 2 Step 4, promoted to v2.9 — see analytics/README.md) ────
// Mirrors public.analytics_runs columns (supabase/migrations/20260727000000_
// analytics_runs.sql). AnalyticsSnapshot covers BOTH shapes ever persisted
// into analytics_runs.snapshot: the v1.0-v1.8 shape (evidence_aggregates/
// recommendation_candidates/target_user_evidence) and the v2.0+ shape
// (purpose_semantics/shared_purpose_evidence/target_user_purpose_evidence/
// target_user_open_inventory_evidence) that build_analytics_snapshot_v2_9
// (the current production version) actually returns. Every version-specific
// field is optional so old stored runs of EITHER shape remain readable —
// see analytics/SEMANTIC_CONTRACT.md for the authoritative field-level
// definitions. Nested module contents are intentionally left as
// Record<string, unknown> — the full SQL schema is not duplicated into
// TypeScript.

export type AnalyticsRunStatus = 'pending' | 'running' | 'completed' | 'failed';

// Metadata-only shape — matches the columns selected by getRecentAnalyticsRuns
// (everything except `snapshot`, which is loaded separately per run).
export interface AnalyticsRunMeta {
  id:                 number;
  status:             AnalyticsRunStatus;
  created_at:         string;
  started_at:         string | null;
  completed_at:       string | null;
  duration_ms:        number | null;
  analytics_version:  string;
  evidence_scope:     string;
  error_message:      string | null;
}

export interface AnalyticsRun extends AnalyticsRunMeta {
  snapshot: AnalyticsSnapshot | null;
}

export interface AnalyticsSnapshot {
  snapshot_schema_version:        string;
  analytics_definition_version:   string;
  generated_at:                   string;
  evidence_scope:                 string;

  // ── v1.0-v1.8 shape — absent on v2.0+ stored snapshots ──────────────────
  recommendation_target_user_id?:  number;
  evidence_aggregates?: {
    acquisition_value_band: Record<string, unknown>;
    acquisition_to_exit:    Record<string, unknown>;
    brand:                  Record<string, unknown>;
    deal_in_channel?:        Record<string, unknown>;
    deal_out_channel?:       Record<string, unknown>;
    channel_journey?:        Record<string, unknown>;
    listing_channel_exposure?: Record<string, unknown>;
    category_type_performance?: Record<string, unknown>;
    capital_liquidity?: Record<string, unknown>;
  };
  recommendation_candidates?: {
    open_business_items: Record<string, unknown>[];
  };
  // Item-level, but every row is restricted to the snapshot's own
  // recommendation_target_user_id — see analytics/SEMANTIC_CONTRACT.md
  // section 21.
  target_user_evidence?: {
    open_inventory_decision_support: Record<string, unknown>;
  };

  // ── v2.0+ shape — absent on v1.0-v1.8 stored snapshots ──────────────────
  // build_analytics_snapshot_v2_7 (the current production version, section
  // 30) is a clean, independent contract — no evidence_aggregates/
  // recommendation_candidates/recommendation_target_user_id field exists
  // in a v2.x payload. shared_purpose_evidence / shared_acquisition_
  // evidence / shared_inventory_segmentation_evidence / shared_deal_
  // channel_evidence / shared_listing_channel_evidence / shared_capital_
  // liquidity_evidence / shared_calendar_seasonality_evidence pool every
  // user's items (aggregate only, no item identity); target_user_purpose_
  // evidence / target_user_open_inventory_evidence / target_user_
  // acquisition_evidence / target_user_inventory_segmentation_evidence /
  // target_user_deal_channel_evidence / target_user_listing_channel_
  // evidence / target_user_capital_liquidity_evidence / target_user_
  // calendar_seasonality_evidence are restricted to the snapshot's own
  // target user — see analytics/SEMANTIC_CONTRACT.md sections 22-31.
  purpose_semantics?:                    string;
  shared_purpose_evidence?:              Record<string, unknown>;
  target_user_purpose_evidence?:         Record<string, unknown>;
  target_user_open_inventory_evidence?:  Record<string, unknown>;
  // Added in Snapshot v2.3 (Acquisition Economics) — absent on older
  // v2.0-v2.2 stored snapshots, so optional here.
  shared_acquisition_evidence?:          Record<string, unknown>;
  target_user_acquisition_evidence?:     Record<string, unknown>;
  // Added in Snapshot v2.4 (Inventory Segmentation) — absent on older
  // v2.0-v2.3 stored snapshots, so optional here.
  shared_inventory_segmentation_evidence?:        Record<string, unknown>;
  target_user_inventory_segmentation_evidence?:   Record<string, unknown>;
  // Added in Snapshot v2.5 (Deal Channel Performance) — absent on older
  // v2.0-v2.4 stored snapshots, so optional here.
  shared_deal_channel_evidence?:                  Record<string, unknown>;
  target_user_deal_channel_evidence?:             Record<string, unknown>;
  // Added in Snapshot v2.6 (Listing Channel Exposure) — absent on older
  // v2.0-v2.5 stored snapshots, so optional here.
  shared_listing_channel_evidence?:               Record<string, unknown>;
  target_user_listing_channel_evidence?:          Record<string, unknown>;
  // Added in Snapshot v2.7 (Capital & Liquidity) — absent on older
  // v2.0-v2.6 stored snapshots, so optional here.
  shared_capital_liquidity_evidence?:             Record<string, unknown>;
  target_user_capital_liquidity_evidence?:        Record<string, unknown>;
  // Added in Snapshot v2.8 (Calendar & Seasonality) — absent on older
  // v2.0-v2.7 stored snapshots, so optional here. Since v2.9 (Calendar
  // Observation Coverage & Confidence Correction), these same keys carry
  // corrected content (observation_coverage_summary, coverage-aware
  // monthly_timeline/month_of_year_seasonality/current_month_to_date_
  // pace) — no new top-level snapshot key was added for the correction,
  // so a v2.8-shaped stored run and a v2.9-shaped stored run both satisfy
  // this same optional field.
  shared_calendar_seasonality_evidence?:          Record<string, unknown>;
  target_user_calendar_seasonality_evidence?:     Record<string, unknown>;
  module_limitations?:                   string[];

  // Added in Snapshot v2.13 (Pattern Discovery Evidence Foundation) —
  // absent on older v2.0-v2.12 stored snapshots, so optional here. A
  // unified candidate-segment dataset (13 curated dimensions) covering
  // ONLY realized item economics — no pattern selection, ranking, or
  // recommendation.
  target_user_pattern_discovery_evidence?:        Record<string, unknown>;

  // Added by Pattern Discovery Engine v1.0 (application layer, versioned
  // independently of Analytics — engine_version, not snapshot_schema_
  // version). Optional: absent on stored runs from before this engine
  // existed. Reads only target_user_pattern_discovery_evidence above —
  // never Insights' selected findings, never open-inventory evidence.
  pattern_discovery?:                             Record<string, unknown>;

  // Insights Engine v1.0 (application layer, versioned independently of
  // Analytics — insights_engine_version / findings_selector_version, not
  // snapshot_schema_version / analytics_definition_version). Optional:
  // absent on stored runs from before this was introduced, and on any run
  // this layer skips. See src/lib/analytics/insights/.
  insights?: {
    insights_engine_version:   string;
    findings_selector_version: string;
    source_analytics_version:  string;
    generated_at:               string;
    selected_findings:          Record<string, unknown>[];
    rule_evaluations:           Record<string, unknown>[];
  };
}
