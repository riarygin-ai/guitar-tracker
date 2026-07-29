# analytics/

This folder holds **experimental analytical queries**, not production dashboard
metrics or proven business rules.

## What this is

Read-only SQL exploring questions against the `analytics_item_lifecycle` view
(see `supabase/migrations/20260723000000_analytics_item_lifecycle.sql`). Files
here are analysis notebooks in SQL form — a way to ask a business question,
look at the numbers, and record the caveats, before anything gets built on top
of them.

## What this is not

- Not a source of truth. Nothing here has been reviewed enough to drive
  pricing, buying, or listing decisions on its own.
- Not wired into the app. No UI, API route, RPC, or AI integration reads from
  these files. They are run manually (SQL Editor / `psql`) against the
  database.
- Not a migration. Files here create no database objects — they only `SELECT`
  from existing views.

## Files

Reusable numbered analysis sequence, under `analytics/sql/`:

- `sql/01_acquisition_value_band_performance.sql` — profit/ROI/DOM/holding
  performance grouped by Acquisition Value Band, plus category, user, and
  acquisition-method robustness checks.
- `sql/02_acquisition_to_exit_analysis.sql` — value movement from
  acquisition_value to exit_value: Acquisition Value Band performance,
  the Acquisition Value Band → Exit Value Band transition matrix, and
  acquisition-method × exit-method breakdowns, including Purchase Price
  Band and Sale Price Band sections. Does not compute holding time — see
  its own header and `analytics/SEMANTIC_CONTRACT.md`.
- `sql/03_brand_performance.sql` — the same profit/ROI/DOM/holding
  methodology as file 01, grouped by brand instead of acquisition value.
- `sql/04_deal_in_channel_performance.sql` — Channel Analytics module 1:
  which contact-source channel (Marketplace/Kijiji/Reverb/Regular Buyer /
  Seller) a Business item entered inventory through, and how items sourced
  through each channel perform. See `analytics/SEMANTIC_CONTRACT.md`
  section 15 for the full Deal In Channel definition. Category/Type
  Performance, Open Inventory Decision Support, and every Channel
  Analytics module besides Deal Out Channel, Channel Journey, and Listing
  Channel Exposure (below) are explicitly out of scope for this file.
- `sql/05_deal_out_channel_performance.sql` — Channel Analytics module 2:
  which contact-source channel a Business item LEFT inventory through
  (cash sale or trade), and how cash-sale and trade exits perform per
  channel. See `analytics/SEMANTIC_CONTRACT.md` section 16 for the full
  Deal Out Channel definition. Every Channel Analytics module besides
  Channel Journey and Listing Channel Exposure (below) is explicitly out of
  scope for this file.
- `sql/06_channel_journey.sql` — Channel Analytics module 3A: how Business
  items move from their Deal In contact-source channel to their Deal Out
  contact-source channel — the deal-in → deal-out matrix, same-channel vs.
  different-channel path evidence, and paths by acquisition/exit method.
  See `analytics/SEMANTIC_CONTRACT.md` section 17 for the full Channel
  Journey definition, including why same-channel-exit percentages are
  descriptive path evidence, never a conversion rate. Listing Channel
  Exposure (below) is the only other Channel Analytics module in scope
  alongside this file; every other module is explicitly out of scope.
- `sql/07_listing_channel_exposure.sql` — Channel Analytics module 3B:
  where Business items were ADVERTISED (read directly from
  `item_listings`, never inferred from Deal In/Deal Out Channel), how
  often items were cross-listed, which listing platforms were associated
  with realized exits, and which open inventory remains listed,
  cross-listed, or not listed. See `analytics/SEMANTIC_CONTRACT.md`
  section 18 for the full Listing Channel Exposure definition, including
  the `item_listings` active-state schema findings and the canonical
  item/channel exposure dedup logic. Category/Type Performance (below) is
  the only other module in scope alongside this file; every other module —
  Open Inventory Decision Support, listing conversion, current listing
  recommendations, AI interpretation, recommendations/rankings — is
  explicitly out of scope.
- `sql/08_category_type_performance.sql` — which item Categories and Types
  (within their Category) perform best, how results vary by Acquisition
  Value Band, and where open inventory capital is concentrated by
  Category/Type. NOT a Channel Analytics module — groups by
  `category_id`/`type_id` instead of any Deal In/Deal Out/Listing channel.
  See `analytics/SEMANTIC_CONTRACT.md` section 19 for the full definition,
  including why `confidence` here is tiered from the REALIZED sample
  (unlike the Channel Analytics modules, which tier from the whole group).
  Capital & Liquidity (below) is the only other module in scope alongside
  this file; Open Inventory Decision Support, AI interpretation,
  recommendations/rankings, and Business Coach are explicitly out of scope
  for this file.
- `sql/09_capital_liquidity.sql` — how much acquisition capital is tied up
  in open Business inventory, how much is listed vs. unlisted, how old the
  open capital is, which Acquisition Value Bands/acquisition methods hold
  the most open capital, and how efficiently realized inventory has turned
  acquisition capital into profit. Reports CAPITAL (`acquisition_value`
  assigned to inventory), never a user's `cash_flow` ledger/cash-balance.
  See `analytics/SEMANTIC_CONTRACT.md` section 20 for the full definition,
  including the mutually-exclusive open-capital age buckets and why
  `profit_to_acquisition_capital_percent` is never interchangeable with
  `median_roi`. Open Inventory Decision Support (below) is the only other
  module in scope alongside this file; item-level recommendations, recent
  trends, AI recommendations, Business Coach, and cash-balance analysis are
  explicitly out of scope for this file.
- `sql/10_open_inventory_decision_support.sql` — transparent, item-level
  evidence for the CURRENT user's own open Business inventory (capital
  exposure, comparable-cohort DOM/profit/ROI, ownership age, estimated
  upside, within-brand comparison) meant to help a later Business Coach,
  never a final answer itself. Produces NO score, priority_score,
  recommended_action, or AI-generated prose — only a deterministic
  `reason_codes` evidence-flag array. The first module to expose item-level
  identity, via a NEW top-level snapshot section
  (`target_user_evidence.open_inventory_decision_support`), always
  restricted to the calling user's own items. See
  `analytics/SEMANTIC_CONTRACT.md` section 21 for the full definition,
  including the comparable-cohort specificity hierarchy and the model-field
  reliability decision. AI-generated recommendations, Business Coach,
  recent trends, cash-balance logic, automatic repricing, notifications,
  and UI redesign are explicitly out of scope for this file.

One-off scripts (not part of the reusable numbered sequence), under
`analytics/audits/`:

- `audits/historical_import_audit.sql` — one-off, read-only audit of
  Historical Import deal/item edge cases, predates the numbered Phase 1
  analysis sequence above. Moved out of `sql/` because it previously
  shared the `02_` prefix with `02_acquisition_to_exit_analysis.sql`; that
  collision is now resolved by directory, not by number.

## Persistence: analytics_runs (Phase 2 Step 1)

`public.analytics_runs` (`supabase/migrations/20260727000000_analytics_runs.sql`)
records one execution of the analytics autorunner and holds its versioned
JSON snapshot once complete. **No autorunner, orchestrator, API route,
frontend UI, or scheduled job exists yet** — this migration is persistence
and a status contract only. Nothing currently writes to this table; a
future controlled server-side runner will.

Status lifecycle (`status` column, enforced by a table CHECK constraint,
not a trigger):

```
pending → running → completed
                  ↘ failed
```

- `pending` — row created, nothing has run yet (`started_at`/`completed_at`/
  `duration_ms`/`snapshot`/`error_message` all NULL).
- `running` — execution started (`started_at` set; everything that only
  makes sense once finished stays NULL).
- `completed` — finished successfully (`started_at`/`completed_at`/
  `snapshot` all set; `error_message` NULL).
- `failed` — finished unsuccessfully (`started_at`/`completed_at`/
  `error_message` all set).

`snapshot` is versioned by `analytics_version` (the analytical definition
version, e.g. `'1.0'` — not this app's release version), so a future reader
can tell which snapshot shape it's looking at. `snapshot`'s JSON structure
is not enforced by the database yet — that's a later phase.

Every run has both a `requested_by_user_id` (audit/history metadata only —
who triggered the run) and a `recommendation_target_user_id` (whose open
Business items may appear as recommendation candidates in the snapshot,
and the ONLY column that controls read access — see RLS below) — usually
the same person today, but the schema doesn't force that. Item-level
recommendation data in a future snapshot is always scoped to
`recommendation_target_user_id` only; evidence aggregates may be computed
over the full shared Business population but must never expose another
user's item-level details. See `analytics/SEMANTIC_CONTRACT.md` sections
9-12 for the full evidence/recommendation/developer-verification boundary
this table is built to respect.

Access is enforced by two independent layers, both least-privilege:

- **Table grants**: `authenticated` holds `SELECT` privilege only on
  `public.analytics_runs` — no `INSERT`/`UPDATE`/`DELETE` table privilege
  exists for `authenticated` or `anon` (see
  `20260729000000_analytics_runs_grant_hardening.sql`, which revokes this
  project's ambient default table/sequence privileges down to that
  baseline; the identity sequence likewise grants nothing to `anon`/
  `authenticated`). `anon` has no privileges on this table at all.
- **RLS**: an authenticated user may `SELECT` a run only where
  `recommendation_target_user_id` equals their own `app_users.id` —
  `requested_by_user_id` does NOT independently grant access, since a
  requester running analytics on someone else's behalf must not be able to
  read that other user's item-level data back out of the snapshot. No
  `INSERT`/`UPDATE`/`DELETE` policy exists for `authenticated` either.

For this initial autorunner implementation, normal user-created runs
always set `requested_by_user_id = recommendation_target_user_id`;
cross-user admin-initiated runs are not implemented or made visible in
this step. Every write — insert pending, transition to running, persist
completed/failed — is performed exclusively by the service-role runner
(`src/lib/analytics/runAnalytics.ts`); direct client writes are denied by
both the table grant and RLS layers independently, not by RLS alone.

## Snapshot builder: build_analytics_snapshot_v1 (Phase 2 Step 2)

`public.build_analytics_snapshot_v1(p_recommendation_target_user_id int)`
(`supabase/migrations/20260728000000_build_analytics_snapshot_v1.sql`)
computes the three reusable analytics modules above, in one database call,
and returns a single stable JSONB snapshot. **This function persists
nothing** — it does not create or update an `analytics_runs` row; Phase 2
Step 3 will call it and store the result. There is still no orchestrator,
API route, frontend UI, scheduled job, or AI interpretation.

Execution: **service_role only.** `EXECUTE` is explicitly revoked from
`PUBLIC`, `anon`, and `authenticated` on this function and its four private
helpers (`_build_acquisition_value_band_snapshot_v1`,
`_build_acquisition_to_exit_snapshot_v1`, `_build_brand_snapshot_v1`,
`_build_recommendation_candidates_snapshot_v1`) — none of these are meant to
be called by an ordinary app session, only by the future controlled
server-side runner. Every function is `SECURITY INVOKER` and never calls
`auth.uid()`/`get_app_user_id()`; the recommendation target is always an
explicit `int` argument, validated against `app_users` (NULL or unknown IDs
raise an exception).

Current version: `snapshot_schema_version` / `analytics_definition_version`
both `"1.0"`. Top-level shape:

```
{
  "snapshot_schema_version": "1.0",
  "analytics_definition_version": "1.0",
  "generated_at": "...",                 -- one value, shared by the whole snapshot
  "evidence_scope": "shared_business_population",
  "recommendation_target_user_id": <int>,
  "evidence_aggregates": {
    "acquisition_value_band": { 14 keys — see the function's own header },
    "acquisition_to_exit":    { 9 keys  — see the function's own header },
    "brand":                  { 14 keys — see the function's own header }
  },
  "recommendation_candidates": {
    "open_business_items": [ ... ]
  }
}
```

`evidence_aggregates` is computed over the full shared Business population
visible to the executing role — never filtered to the recommendation
target — and contains no `item_id`, `user_id`, or item display name
anywhere. `recommendation_candidates.open_business_items` contains only the
target user's own open (not realized) Business items. Every developer-only
drilldown (01's Query G5, 02's Query H, 03's Query H) and every per-user
comparative diagnostic (01's Query G2, 03's Query G — both reclassified
developer-only in this same change) is excluded from the snapshot; see each
manual file's own Query Classification Index. `requested_by_user_id`, run
status, and `error_message` are NOT part of this contract — those belong to
`analytics_runs` (above), not the analytical snapshot itself.

`analytics/SEMANTIC_CONTRACT.md` section 13 now defines the required
conceptual principles for future Business Coach insights (fact vs.
interpretation vs. recommendation vs. confidence vs. scope vs. evidence vs.
limitations) — documentation only. The actual prompt text and
structured-output response schema are not implemented yet.

## Server-side runner: POST /api/analytics/runs (Phase 2 Step 3)

`src/lib/analytics/runAnalytics.ts` and `src/app/api/analytics/runs/route.ts`
are the first code that actually executes an analytics run and persists it
into `analytics_runs`. **There was still no frontend trigger as of this
step** (added in Phase 2 Step 4, below) **and there is still no scheduled/
cron execution or AI/Business Coach analysis** — this step is server-side
execution and persistence only.

Request/response contract:

- `POST /api/analytics/runs`, authenticated (bearer token, same convention
  as the other `/api/ai/*` routes). **No request body is required or read.**
  There is no field anywhere in this flow — body, query string, header — that
  lets a caller choose whose analytics get run or whose data becomes the
  recommendation target. The runner always uses the caller's own resolved
  `app_users.id` for both `requested_by_user_id` and
  `recommendation_target_user_id`.
- Responses: `401` if unauthenticated, `403` if no `app_users` row exists for
  the caller, `500` for a server misconfiguration or an execution/persistence
  failure. On success, `200` with `{ run: { id, status, created_at,
  started_at, completed_at, duration_ms, analytics_version, evidence_scope,
  snapshot } }`. Error responses never include a service-role detail, a raw
  Postgres/Supabase error object, a stack trace, or another user's data.

Execution flow (`runAnalyticsForCurrentUser`, in `runAnalytics.ts`):

1. The route authenticates the caller with the normal anon-key client (same
   `createClient` + bearer-token pattern used elsewhere) and resolves
   `app_users.id` under that user's own RLS — exactly like the existing
   `/api/ai/debug-prompt` admin-check pattern, just without the admin
   requirement.
2. Only after that identity is established does the route construct a
   **service-role** Supabase client (`SUPABASE_SERVICE_ROLE_KEY`, never a
   `NEXT_PUBLIC_` variable) and hand it to the runner. The service-role
   client is used for exactly three things: inserting/updating the
   `analytics_runs` row, calling `build_analytics_snapshot_v1`, and reading
   back the completed row — nothing else. `analytics_runs`' RLS and
   `build_analytics_snapshot_v1`'s `service_role`-only grants are unchanged.
3. The runner inserts a `pending` row, then updates it to `running` with
   `started_at` set, then calls `build_analytics_snapshot_v1` for the same
   app user, timing the call with `performance.now()`.
4. The returned snapshot's top-level metadata is checked with a type guard
   (`isValidAnalyticsSnapshot`) before anything is persisted:
   `snapshot_schema_version`/`analytics_definition_version` must equal the
   current `'1.0'`/`'1.0'`, `evidence_scope` must equal
   `'shared_business_population'`, `recommendation_target_user_id` must
   equal the caller's own `app_users.id`, and `evidence_aggregates`/
   `recommendation_candidates` must both be present. A mismatch is treated
   as a failure, not persisted as a completed snapshot.
5. On success the row is updated to `completed` with `duration_ms`,
   `snapshot`, and `error_message = NULL`. On any failure (builder error or
   failed metadata validation) the row is updated to `failed` with
   `duration_ms` (when available) and a sanitized `error_message` — stripped
   to its first line, with anything JWT- or connection-string-shaped
   redacted, capped at ~500 characters. The runner never leaves a row stuck
   in `running` because of an ordinary handled exception; if persisting the
   `failed` status itself fails, both failures are logged server-side
   separately and a generic error is returned to the caller.

Current limitations (deliberate, for this step):

- **No concurrency control.** Multiple manually triggered runs for the same
  user may run and complete independently — there is no lock, uniqueness
  constraint, queue, or cancellation, and an existing in-flight run is never
  silently reused. This is acceptable for now because nothing triggers runs
  automatically yet; revisit once a frontend trigger or scheduler exists.
- **No frontend trigger as of Phase 2 Step 3.** The route had to be called
  directly (e.g. via `curl`/Postman with a real user's access token). Phase
  2 Step 4, below, adds the first UI trigger.

**Duplicated-logic maintenance rule.** Until analytics logic is
consolidated into a single implementation, the same analytical definitions
exist in two places that must be kept in sync by hand: the developer-readable
manual SQL files (`analytics/sql/01_...`, `02_...`, `03_...`, `04_...`,
`05_...`, `06_...`, `07_...`, `08_...`, `09_...`, `10_...` — these reflect
the CURRENT semantics, edited in place) and the versioned snapshot builder
functions, one migration per version
(`supabase/migrations/20260728000000_build_analytics_snapshot_v1.sql`
for v1.0, `supabase/migrations/20260730000000_build_analytics_snapshot_v1_1.sql`
for v1.1, `supabase/migrations/20260801000000_build_analytics_snapshot_v1_2.sql`
for v1.2, `supabase/migrations/20260803000000_build_analytics_snapshot_v1_3.sql`
for v1.3, `supabase/migrations/20260804000000_build_analytics_snapshot_v1_4.sql`
for v1.4, `supabase/migrations/20260805000000_build_analytics_snapshot_v1_5.sql`
for v1.5, `supabase/migrations/20260806000000_build_analytics_snapshot_v1_6.sql`
for v1.6, `supabase/migrations/20260807000000_build_analytics_snapshot_v1_7.sql`
for v1.7, `supabase/migrations/20260808000000_build_analytics_snapshot_v1_8.sql`
for v1.8). A change to an analytical definition (a band boundary, an
eligibility rule, a new metric) must be applied to both the manual files
and the CURRENT builder version, or they will silently disagree. Already-
shipped versioned builder migrations (like v1.0's) are never edited after
the fact — a semantic change always ships as a new version. This
duplication is not redesigned in this step.

## Frontend: /analytics page (Phase 2 Step 4)

`/analytics` (`src/app/analytics/page.tsx`) is the **first frontend trigger**
for the analytics autorunner. An authenticated user can now:

- click **Run Analytics** to call `POST /api/analytics/runs` (bearer token
  from the current Supabase session, no request body — the button cannot
  supply any target other than the caller's own account);
- see whether the run completed or failed, with a disabled/"Running
  analytics…" button state while the request is in flight;
- browse their own recent runs (latest 10, `created_at DESC`), loaded with
  the normal authenticated browser client under the existing RLS policy —
  a user only ever sees rows where `recommendation_target_user_id` is their
  own `app_users.id`;
- select any run and load its stored snapshot separately, by run id, again
  under RLS.

Results are shown as **structured/raw snapshot sections** — collapsible,
formatted-JSON blocks for Acquisition Value Band, Acquisition to Exit,
Brand, My Open Business Items, and the complete raw snapshot — not a
polished dashboard. This is a development-stage results viewer. **No
Business Coach or AI interpretation exists yet, and no scheduled execution
exists yet**; every run is still manually triggered from this page (or
directly against the API), one request at a time.

The page issues no lifecycle-table queries of its own — it only ever reads
`analytics_runs` metadata and the persisted `snapshot` JSONB column, so it
cannot show more than what `build_analytics_snapshot_v1` already decided to
put in the snapshot (no other user's items, no developer-only drilldowns).

## Analytics Snapshot v1.1 (semantic cleanup)

`public.build_analytics_snapshot_v1_1(p_recommendation_target_user_id int)`
(`supabase/migrations/20260730000000_build_analytics_snapshot_v1_1.sql`) is
a **new, additive version** that corrects ambiguous field names and
semantics identified in Snapshot v1.0. **`build_analytics_snapshot_v1`
(v1.0) is unchanged and remains callable; no previously stored v1.0
`analytics_runs.snapshot` row is altered.** `src/lib/analytics/
runAnalytics.ts` now calls v1.1 for new runs (`ANALYTICS_VERSION = '1.1'`),
but the Analytics page continues to display both `analytics_version` values
in run history and renders whichever JSON a selected run actually has
stored — it makes no assumption about which version's field names appear
inside `evidence_aggregates`/`recommendation_candidates` (those are typed
as `Record<string, unknown>` in `src/types/index.d.ts`, already
version-agnostic).

**Changelog (see `analytics/SEMANTIC_CONTRACT.md` section 7.1 for full
rationale and reconciliation formulas):**

- **`acquisition_value_status`** (`positive` / `zero_assigned` / `unknown` /
  `negative_invalid`) — one consistent derived field, added wherever
  item-level or cohort logic needs it, including recommendation candidates.
- **Band labels split**: v1.0's combined `"Zero / unknown"` label is now
  `"Zero assigned value"` and `"Unknown acquisition value"` (plus a
  defensive `"Negative (invalid)"` catch-all). The six positive bands
  (`$1-999` … `$5,000+`) are unchanged.
- **New special-value summaries**: `evidence_aggregates.acquisition_value_
  band.zero_assigned_value_summary` and `.unknown_acquisition_value_
  summary` — zero-assigned and unknown items are reported explicitly
  instead of being excluded with no trace. `positive_value_performance`
  replaces v1.0's `performance` key (same query, same numbers).
- **Exit-count naming**: `total_realized_sale_exit_count` /
  `total_realized_trade_exit_count` (every realized exit) vs. `eligible_
  transition_sale_exit_count` / `eligible_transition_trade_exit_count`
  (positive-value-transition-eligible only), with explicit `excluded_
  transition_*_zero_acquisition_value` / `_unknown_acquisition_value`
  reconciliation counts.
- **Holding-day naming**: `raw_realized_holding_days_present_count`
  (merely non-null) vs. `eligible_realized_holding_days_count` (realized,
  non-historical, non-null, no lifecycle date issue) are now distinct, and
  every `holding_sample_size` in every module uses this same eligibility
  rule (v1.0 was inconsistent across a few queries — now fixed uniformly).
- **Brand-count naming**: `all_business_distinct_brand_count` vs.
  `positive_acquisition_distinct_brand_count` vs. `decision_ready_distinct_
  brand_count` — three explicitly distinct populations that used to share
  ambiguous names.
- **Estimated-upside fix**: a known zero acquisition value now correctly
  contributes `$0` to a capital `SUM` in the open-inventory sections
  (`open_listed_inventory`/`open_unlisted_inventory` in both the
  Acquisition Value Band and Brand modules) instead of silently producing
  `NULL` for an all-zero band/brand. Ambiguous `estimated_upside_missing_
  count` fields are replaced with explicit `estimated_value_missing_count`
  / `estimated_upside_available_count` / `estimated_upside_indeterminate_
  count`, plus `acquisition_value_known_count` / `_zero_assigned_count` /
  `_unknown_count` coverage.
- **Recommendation candidates** gain `acquisition_value_status`,
  `acquisition_value_band_label`, and `estimated_upside_status`
  (`available` / `missing_estimated_value` / `unknown_acquisition_value` /
  `other_indeterminate`) alongside the existing `estimated_net_upside`.

No existing calculation for POSITIVE acquisition values changed — this is a
naming/consistency/coverage correction, not a business-logic change.
Channel Analytics, Open Inventory Decision Support, and Business Coach are
explicitly out of scope for this cleanup.

## Analytics Snapshot v1.2 (Channel Analytics module 1: Deal In Channel)

`public.build_analytics_snapshot_v1_2(p_recommendation_target_user_id int)`
(`supabase/migrations/20260801000000_build_analytics_snapshot_v1_2.sql`) is
a **lightweight, additive** version. `build_analytics_snapshot_v1` (v1.0)
and `build_analytics_snapshot_v1_1` (v1.1) are unchanged and remain
callable; no previously stored v1.0/v1.1 `analytics_runs.snapshot` row is
altered. `src/lib/analytics/runAnalytics.ts` now calls v1.2 for new runs
(`ANALYTICS_VERSION = '1.2'`); the Analytics page's new "Deal In Channel"
collapsible section shows a plain "not available in this run" message when
selecting an older v1.0/v1.1 run instead of assuming the field exists.

**What's new:**

- `analytics_item_lifecycle` gains three columns
  (`20260731000000_analytics_item_lifecycle_deal_in_channel.sql`):
  `deal_in_channel_id`, `deal_in_channel_name`,
  `deal_in_channel_requires_listing` — the explicit Channel-Analytics
  names for the same acquisition-deal-channel join already exposed (under
  older, more ambiguous names) as `acquisition_channel_id`/
  `acquisition_channel_name`. Every existing column and calculation on the
  view is unchanged.
- **`evidence_aggregates.deal_in_channel`** (new): `population_summary`,
  `overall_performance`, `by_acquisition_method`,
  `by_acquisition_value_band`, `open_inventory_exposure` — see
  `analytics/sql/04_deal_in_channel_performance.sql` and
  `analytics/SEMANTIC_CONTRACT.md` section 15 for the full field-by-field
  contract. Missing-channel items (Historical Import, or any acquisition
  with no recorded channel) are reported explicitly, never hidden.
- **Truncated-key fix**: v1.1's `acquisition_value_band.population_summary`
  key `excluded_unreliable_acquisition_date_realized_holding_days_count`
  (64 bytes) was silently truncated by PostgreSQL's 63-byte identifier
  limit to `..._holding_days_coun` in every stored v1.1 snapshot. v1.2
  renames it to the shorter `excluded_unreliable_acquisition_date_holding_
  count` via a narrow JSONB patch around v1.1's own helper output — the
  helper itself was not rewritten, and existing v1.1 snapshots are
  untouched (they still have the truncated v1.0/v1.1-era key).
- `acquisition_to_exit`, `brand`, and `recommendation_candidates` are
  v1.1's own helper functions, called directly and unmodified — v1.2 does
  not re-implement or duplicate them.

Deal Out Channel, Listing Channel, the Deal In → Deal Out journey matrix,
listing-conversion/same-channel-exit-rate, channel × brand, channel ×
category/type, monthly channel trends, AI interpretation, and
recommendations/rankings are all explicitly out of scope for this step.

## Analytics Snapshot v1.3 (Channel Analytics module 2: Deal Out Channel)

`public.build_analytics_snapshot_v1_3(p_recommendation_target_user_id int)`
(`supabase/migrations/20260803000000_build_analytics_snapshot_v1_3.sql`) is
a **lightweight, additive** version. `build_analytics_snapshot_v1` (v1.0),
`build_analytics_snapshot_v1_1` (v1.1), and `build_analytics_snapshot_v1_2`
(v1.2) are unchanged and remain callable; no previously stored v1.0/v1.1/
v1.2 `analytics_runs.snapshot` row is altered. `src/lib/analytics/
runAnalytics.ts` now calls v1.3 for new runs (`ANALYTICS_VERSION = '1.3'`);
the Analytics page's new "Deal Out Channel" collapsible section shows a
plain "not available in this run" message when selecting an older run
instead of assuming the field exists.

**What's new:**

- `analytics_item_lifecycle` gains three columns
  (`20260802000000_analytics_item_lifecycle_deal_out_channel.sql`):
  `deal_out_channel_id`, `deal_out_channel_name`,
  `deal_out_channel_requires_listing` — the explicit Channel-Analytics
  names for the same exit-deal-channel join already exposed (under older,
  more ambiguous names) as `exit_channel_id`/`exit_channel_name`. Open
  items always have `deal_out_channel_id = NULL`. Every existing column and
  calculation on the view is unchanged.
- **`evidence_aggregates.deal_out_channel`** (new): `population_summary`,
  `overall_performance`, `cash_sales_by_channel`, `trade_exits_by_channel`,
  `by_exit_value_band`, `by_acquisition_value_band` — see
  `analytics/sql/05_deal_out_channel_performance.sql` and
  `analytics/SEMANTIC_CONTRACT.md` section 16 for the full field-by-field
  contract. Missing-channel exits (a realized trade with no channel
  recorded) are reported explicitly, never hidden. Cash sales and trade
  exits are kept in explicitly separate sections — `exit_value` is only
  ever called a "sale price" in `cash_sales_by_channel` and an "assigned
  trade exit value" in `trade_exits_by_channel`.
- **Lightweight wrapper, one level up**: unlike v1.2 (which had to call
  four separate v1.1 helpers directly, because v1.1 was not itself a single
  callable entry point for everything), v1.3's top-level function calls
  `build_analytics_snapshot_v1_2(int)` WHOLESALE and merges in one extra
  `evidence_aggregates.deal_out_channel` key — v1.2's own
  acquisition_value_band/acquisition_to_exit/brand/deal_in_channel/
  recommendation_candidates assembly is reused as-is, not duplicated.

Listing Channel Exposure, listing conversion, current listing
recommendations, channel × brand, channel × category/type, monthly channel
trends, AI interpretation, and recommendations/rankings are all explicitly
out of scope for this step.

## Analytics Snapshot v1.4 (Channel Analytics module 3A: Channel Journey)

`public.build_analytics_snapshot_v1_4(p_recommendation_target_user_id int)`
(`supabase/migrations/20260804000000_build_analytics_snapshot_v1_4.sql`) is
a **lightweight, additive** version. `build_analytics_snapshot_v1` (v1.0),
`build_analytics_snapshot_v1_1` (v1.1), `build_analytics_snapshot_v1_2`
(v1.2), and `build_analytics_snapshot_v1_3` (v1.3) are unchanged and remain
callable; no previously stored v1.0/v1.1/v1.2/v1.3 `analytics_runs.snapshot`
row is altered. `src/lib/analytics/runAnalytics.ts` now calls v1.4 for new
runs (`ANALYTICS_VERSION = '1.4'`); the Analytics page's new "Channel
Journey" collapsible section shows a plain "not available in this run"
message when selecting an older run instead of assuming the field exists.

**What's new:**

- **No lifecycle view changes.** Channel Journey uses ONLY the
  `deal_in_channel_*`/`deal_out_channel_*` fields already added by modules 1
  and 2 (`20260731000000`/`20260802000000`) — no new migration to
  `analytics_item_lifecycle` was needed for this module.
- **`evidence_aggregates.channel_journey`** (new): `population_summary`,
  `deal_in_to_deal_out_matrix`, `same_channel_summary`,
  `same_channel_by_deal_in_channel`, `paths_by_method` — see
  `analytics/sql/06_channel_journey.sql` and
  `analytics/SEMANTIC_CONTRACT.md` section 17 for the full field-by-field
  contract. Items with a missing Deal In and/or Deal Out Channel are
  reported explicitly in `population_summary`'s coverage fields, never
  hidden, but excluded from the matrix and every downstream section (a
  missing channel is never invented or backfilled).
- **Same-channel path evidence, explicitly not a conversion rate**:
  `same_channel_exit_percent` describes how often an item's Deal In and
  Deal Out channel were the same channel — it is never labeled a
  "conversion rate," never implies causation, and is never compared against
  Deal In Channel's (module 1) or Deal Out Channel's (module 2) own item
  counts, which use different, wider populations.
- **Lightweight wrapper, one level up**: v1.4's top-level function calls
  `build_analytics_snapshot_v1_3(int)` WHOLESALE and merges in one extra
  `evidence_aggregates.channel_journey` key — v1.3's own
  acquisition_value_band/acquisition_to_exit/brand/deal_in_channel/
  deal_out_channel/recommendation_candidates assembly is reused as-is, not
  duplicated.

Listing Channel Exposure, listing conversion, current listing
recommendations, AI interpretation, and recommendations/rankings are all
explicitly out of scope for this step.

## Analytics Snapshot v1.5 (Channel Analytics module 3B: Listing Channel Exposure)

`public.build_analytics_snapshot_v1_5(p_recommendation_target_user_id int)`
(`supabase/migrations/20260805000000_build_analytics_snapshot_v1_5.sql`) is
a **lightweight, additive** version. `build_analytics_snapshot_v1` (v1.0)
through `build_analytics_snapshot_v1_4` (v1.4) are unchanged and remain
callable; no previously stored v1.0-v1.4 `analytics_runs.snapshot` row is
altered. `src/lib/analytics/runAnalytics.ts` now calls v1.5 for new runs
(`ANALYTICS_VERSION = '1.5'`); the Analytics page's new "Listing Channel
Exposure" collapsible section shows a plain "not available in this run"
message when selecting an older run instead of assuming the field exists.

**What's new:**

- **No lifecycle view changes.** Listing Channel Exposure joins
  `item_listings`/`deal_channels` directly to `analytics_item_lifecycle`
  at query time — no new migration to `analytics_item_lifecycle` was
  needed.
- **`item_listings` active-state finding**: no active/current-state column
  exists (`status` was dropped in
  `20260721000000_migrate_date_listed_to_item_listings.sql`; publication is
  determined solely by `listed_at IS NOT NULL`). CURRENT exposure is
  therefore defined as an OPEN Business item with an eligible listing
  record — a documented limitation, not an invented state.
- **Canonical item/channel exposure**: multiple `item_listings` rows for
  the same (item, channel) pair are collapsed into one exposure, preserving
  `listing_record_count` (physical records) alongside `MIN`/`MAX(listed_at)`
  — an item is never double-counted on the same channel.
- **`evidence_aggregates.listing_channel_exposure`** (new):
  `population_summary`, `listing_channel_performance`,
  `cross_listing_summary` (an object: `buckets[]` plus
  `single_listed_item_count`/`cross_listed_item_count`/
  `cross_listed_item_percent`), `listing_to_deal_out_matrix`,
  `open_inventory_by_listing_channel`, `open_unlisted_summary` — see
  `analytics/sql/07_listing_channel_exposure.sql` and
  `analytics/SEMANTIC_CONTRACT.md` section 18 for the full field-by-field
  contract.
- **Non-mutually-exclusive exposure counts**: `listing_channel_performance`,
  `listing_to_deal_out_matrix`, and `open_inventory_by_listing_channel` are
  exposure-level — a cross-listed item appears in multiple rows. Only
  `population_summary` and `cross_listing_summary` report unique item
  counts.
- **Lightweight wrapper, one level up**: v1.5's top-level function calls
  `build_analytics_snapshot_v1_4(int)` WHOLESALE and merges in one extra
  `evidence_aggregates.listing_channel_exposure` key.

Category/Type Performance, Open Inventory Decision Support, listing
conversion, current listing recommendations, AI interpretation, and
recommendations/rankings are all explicitly out of scope for this step.

## Analytics Snapshot v1.6 (Category & Type Performance)

`public.build_analytics_snapshot_v1_6(p_recommendation_target_user_id int)`
(`supabase/migrations/20260806000000_build_analytics_snapshot_v1_6.sql`) is
a **lightweight, additive** version. `build_analytics_snapshot_v1` (v1.0)
through `build_analytics_snapshot_v1_5` (v1.5) are unchanged and remain
callable; no previously stored v1.0-v1.5 `analytics_runs.snapshot` row is
altered. `src/lib/analytics/runAnalytics.ts` now calls v1.6 for new runs
(`ANALYTICS_VERSION = '1.6'`); the Analytics page's new "Category & Type
Performance" collapsible section shows a plain "not available in this run"
message when selecting an older run instead of assuming the field exists.

**What's new:**

- **No lifecycle view changes.** `category_id`/`category_name`/`type_id`/
  `type_name` already existed on `analytics_item_lifecycle` — no new
  migration was needed.
- **`evidence_aggregates.category_type_performance`** (new):
  `population_summary`, `category_performance`, `type_performance`,
  `category_by_acquisition_value_band`, `type_by_acquisition_value_band`,
  `open_inventory_by_category_type` — see
  `analytics/sql/08_category_type_performance.sql` and
  `analytics/SEMANTIC_CONTRACT.md` section 19 for the full field-by-field
  contract. Missing Category/Type is reported explicitly (never dropped);
  Types sharing a name across different Categories are always kept
  separate (grouped by `(category_id, type_id)`, never `type_id` alone).
- **Confidence tiered from the realized sample**: unlike the Channel
  Analytics modules (v1.2-v1.5), which tier `confidence` from a row's total
  item count, every grouped section here tiers `confidence` from that
  row's own REALIZED item count — see section 19's rationale.
- **Lightweight wrapper, one level up**: v1.6's top-level function calls
  `build_analytics_snapshot_v1_5(int)` WHOLESALE and merges in one extra
  `evidence_aggregates.category_type_performance` key.

Capital & Liquidity, Open Inventory Decision Support, AI interpretation,
recommendations/rankings, and Business Coach are all explicitly out of
scope for this step.

## Analytics Snapshot v1.7 (Capital & Liquidity)

`public.build_analytics_snapshot_v1_7(p_recommendation_target_user_id int)`
(`supabase/migrations/20260807000000_build_analytics_snapshot_v1_7.sql`) is
a **lightweight, additive** version. `build_analytics_snapshot_v1` (v1.0)
through `build_analytics_snapshot_v1_6` (v1.6) are unchanged and remain
callable; no previously stored v1.0-v1.6 `analytics_runs.snapshot` row is
altered. `src/lib/analytics/runAnalytics.ts` now calls v1.7 for new runs
(`ANALYTICS_VERSION = '1.7'`); the Analytics page's new "Capital &
Liquidity" collapsible section shows a plain "not available in this run"
message when selecting an older run instead of assuming the field exists.

**What's new:**

- **No lifecycle view changes.** Every field used (`acquisition_value`,
  `current_status`, `holding_days`, `estimated_sold_value`,
  `is_historical_import`, `has_lifecycle_date_issue`) already existed on
  `analytics_item_lifecycle` — no new migration was needed.
- **`evidence_aggregates.capital_liquidity`** (new):
  `capital_position_summary`, `open_capital_age_buckets`,
  `open_capital_by_acquisition_value_band`,
  `open_capital_by_acquisition_method`,
  `realized_capital_efficiency_by_acquisition_value_band`,
  `realized_capital_efficiency_by_acquisition_method` — see
  `analytics/sql/09_capital_liquidity.sql` and
  `analytics/SEMANTIC_CONTRACT.md` section 20 for the full field-by-field
  contract. Reports acquisition CAPITAL, never a user's `cash_flow`
  ledger/cash-balance.
  Every open Business item lands in exactly one mutually-exclusive age
  bucket (`0-29 days`/`30-59 days`/`60-119 days`/`120+ days`/
  `unreliable/unknown age`) — historical imports always land in the
  unreliable/unknown bucket, never a calendar one.
- **Item-level-first time efficiency**: `median_net_profit_per_30_holding_
  days` is computed per item (`net_profit / holding_days * 30`, never
  dividing by zero, excluding historical imports) and THEN medianed —
  never a group-level ratio of medians.
- **Lightweight wrapper, one level up**: v1.7's top-level function calls
  `build_analytics_snapshot_v1_6(int)` WHOLESALE and merges in one extra
  `evidence_aggregates.capital_liquidity` key.

Open Inventory Decision Support, item-level recommendations, recent
trends, AI recommendations, Business Coach, and cash-balance analysis are
all explicitly out of scope for this step.

## Analytics Snapshot v1.8 (Open Inventory Decision Support v1)

`public.build_analytics_snapshot_v1_8(p_recommendation_target_user_id int)`
(`supabase/migrations/20260808000000_build_analytics_snapshot_v1_8.sql`) is
a **lightweight, additive** version. `build_analytics_snapshot_v1` (v1.0)
through `build_analytics_snapshot_v1_7` (v1.7) are unchanged and remain
callable; no previously stored v1.0-v1.7 `analytics_runs.snapshot` row is
altered. `src/lib/analytics/runAnalytics.ts` now calls v1.8 for new runs
(`ANALYTICS_VERSION = '1.8'`); the Analytics page's new "Open Inventory
Decision Support" collapsible section reads from the NEW
`target_user_evidence.open_inventory_decision_support` key (not
`evidence_aggregates`) and shows a plain "not available in this run"
message when selecting an older run.

**What's new:**

- **A new top-level snapshot section**, not `evidence_aggregates`:
  `target_user_evidence.open_inventory_decision_support` — the first
  section in this analytics layer to expose item-level identity (item_id,
  brand, category, type, model), always restricted to the calling user's
  own open Business items. `evidence_aggregates` and
  `recommendation_candidates` are passed through from v1.7 UNCHANGED.
- **`population_summary`, `item_decision_evidence`, `within_brand_
  comparison`** — see `analytics/sql/10_open_inventory_decision_support.sql`
  and `analytics/SEMANTIC_CONTRACT.md` section 21 for the full contract.
- **Comparable-cohort specificity hierarchy**: for each open item, up to 7
  candidate cohorts (brand+type+band down to all-Business) are searched,
  preferring the most specific one with at least 5 realized items, falling
  back to 3, then 1, then no cohort. The exact-model cohort level is
  deliberately skipped (`model` is free text with no normalization table).
- **Deterministic `reason_codes`** — an array of evidence flags (e.g.
  `HIGH_CAPITAL_EXPOSURE`, `OWNERSHIP_AGE_120_PLUS`,
  `DOM_ABOVE_COMPARABLE_MEDIAN`), never counted, weighted, or turned into a
  score. No `score`, `priority_score`, `recommended_action`, or
  sell/keep/reprice decision exists anywhere in this module.

Open Inventory Decision Support beyond v1 (AI-generated recommendations,
Business Coach, recent trends, cash-balance logic, automatic repricing,
notifications, and UI redesign) is explicitly out of scope for this step.

## Conventions

- One file per analysis, numbered (`01_`, `02_`, ...) in the order they were
  written, under `analytics/sql/`. One-off, non-reusable scripts (audits,
  one-time investigations) live under `analytics/audits/` instead, unnumbered,
  so they never compete for a prefix with the reusable sequence.
- Every query in a file is independently runnable — copy-paste any single
  query out and it should execute on its own, with no dependency on another
  query having run first.
- Every query is read-only (`SELECT` only) and reads from `analytics_item_lifecycle`.
- Medians (`PERCENTILE_CONT(0.5)`) are treated as the primary summary
  statistic; averages are included alongside them but are more easily skewed
  by a handful of unusually cheap/expensive/profitable items.
- Sample sizes are always shown next to any aggregate. A median computed over
  3 items is not a conclusion — it's a data point that needs more items before
  it means anything.
- Findings from these files are associations, not causation, until stated
  otherwise (and probably not even then).
- Terminology: use "Acquisition Value Band" / "Exit Value Band" for
  groupings that include both cash and trade items; reserve "Purchase Price
  Band" / "Sale Price Band" for populations explicitly filtered to cash-only
  purchases/sales. Never write "price band" as a generic term — see
  `analytics/SEMANTIC_CONTRACT.md` for the full definitions and
  `analytics/sql/01_acquisition_value_band_performance.sql` for the
  reference implementation.

## Before treating anything here as a real finding

Check the file's own header comment for its specific limitations, then ask:
does the pattern survive the file's own robustness/sensitivity checks (outlier
exclusion, imported-historical-vs-app-tracked cohort comparison, per-user
breakdown), or does it disappear the moment you slice the data a different
way? Note that "imported historical vs. app-tracked" is a COHORT comparison,
not a data-reliability test — see analytics/SEMANTIC_CONTRACT.md. Historical
imports remain included in profit/ROI/DOM/realization metrics throughout;
only acquisition-date-derived metrics (holding time, ownership age,
acquisition-to-listing delay) exclude them.
