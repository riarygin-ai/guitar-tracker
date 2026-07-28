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
  section 15 for the full Deal In Channel definition. Deal Out Channel,
  Listing Channel, and every other Channel Analytics module are explicitly
  out of scope for this file.

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
manual SQL files (`analytics/sql/01_...`, `02_...`, `03_...` — these reflect
the CURRENT/v1.1 semantics, edited in place) and the versioned snapshot
builder functions, one migration per version
(`supabase/migrations/20260728000000_build_analytics_snapshot_v1.sql` for
v1.0, `supabase/migrations/20260730000000_build_analytics_snapshot_v1_1.sql`
for v1.1). A change to an analytical definition (a band boundary, an
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
