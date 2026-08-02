# Analytics Semantic Contract

Source of truth for (1) how historical-import records are treated, (2)
acquisition/exit value-band terminology, (3) acquisition-to-exit value
analysis semantics, (4) the separation between shared statistical evidence
and current-user item-level recommendation targets, (5) the required
conceptual structure of future Business Coach insights, and (6) the
distinction between zero-assigned, unknown, and negative-invalid
acquisition values (Analytics Snapshot v1.1, section 7.1), across the
analytics layer (`analytics/sql/*.sql`, `analytics_item_lifecycle`, and any
future AI analysis / Business Coach feature built on top of them). If a
query, comment, label, or AI prompt disagrees with this document, THIS
document wins — fix the other one.

Confirmed business rule (do not re-litigate without a new explicit decision):
historical-import records were transferred from Excel. Their listing dates
and days-on-market were tracked accurately. **The only unreliable field is
the acquisition date.**

## 1. What a historical import is

A historical import is any `inventory_items` row whose acquisition deal has
`deals.deal_type` in `('Historical Import', 'Historical Purchase',
'Historical Trade')`. `analytics_item_lifecycle.is_historical_import` is the
single derived boolean for this — `true` for all three deal types, `false`
otherwise. There is no separate "historical" table, column, or flag anywhere
else in the schema; this is the only source of truth for cohort membership.

- `Historical Import` — real acquisition method not (yet) known.
  `acquisition_method` derives to `'unknown'`.
- `Historical Purchase` — known to have been a purchase, corrected from a
  generic `Historical Import` once the real method was confirmed.
  `acquisition_method` derives to `'purchase'`.
- `Historical Trade` — known to have been a trade, same correction path.
  `acquisition_method` derives to `'trade'`.

`'cash'` is never used as a stored or grouped value anywhere in this schema
or in analytics output. `'Historical Buy'` is never used as a stored value —
the only historical-purchase string is `'Historical Purchase'`.

## 2. Which fields are trusted vs. not trusted

**Trusted for historical imports** (same as any app-tracked record):

- acquisition value, exit value, gross profit, net profit, ROI
- realization rate, realized/open counts, sale vs. trade exit mix
- acquisition method, exit method
- first listing date, last listing date, listing platform
- `global_days_on_market` (DOM) — for realized items (`exit_date -
  first_listed_at`) and for open listed items (`CURRENT_DATE -
  first_listed_at`)
- brand, category, type, condition, tags
- everything used by brand performance, category/type performance, and
  acquisition-value (Acquisition Value Band) analysis

**Not trusted for historical imports** — exactly one field:

- `acquisition_date` (and, transitively, every metric computed FROM it)

That is the entire list. Nothing else about a historical-import row is
"unreliable data." A historical record is not a lesser-quality record; it is
a record with one approximate input field.

## 3. DOM vs. holding time — never conflate these

Two independent clocks appear throughout this analytics layer:

- **`global_days_on_market` (DOM)** — market-liquidity/velocity metric.
  Measured from `first_listed_at` (a listing-platform date, tracked
  accurately for historical imports). Answers "how fast does this sell."
  **Never excludes historical imports.**
- **`holding_days`** — ownership/capital-cycle duration. Measured from
  `acquisition_date` (the one approximate field for historical imports).
  Answers "how long is money tied up in this item," not "how liquid is this
  item." **Always excludes historical imports** from any aggregate.

A historical item can simultaneously have a perfectly trustworthy,
currently-ticking DOM clock and an approximate holding-time figure — these
are independent facts about independent fields, not a package deal.

Other acquisition-date-derived metrics that follow the same exclusion rule
as `holding_days`:

- current ownership age (unlisted/not-yet-listed items — same measurement,
  `holding_days`, read as "age" instead of "holding time")
- acquisition-to-first-listing delay (`days_acquisition_to_first_listing`)
- acquisition-to-exit duration (future Acquisition-to-Exit Analysis)
- any capital-cycle or profit-per-N-holding-days efficiency metric normalized
  by `holding_days`

## 4. Eligibility rules by metric

| Metric | Historical imports included? |
|---|---|
| `sample_size` / group row membership | **Yes** — a historical row is never dropped from a GROUP BY population just for being historical. |
| `realized_items` / realization rate | Yes |
| `gross_profit` / `net_profit` / `roi` | Yes |
| Sale vs. trade exit mix | Yes |
| Acquisition method / exit method | Yes |
| `global_days_on_market` (DOM), realized or open-listed | Yes |
| Brand / category / type / acquisition-value-band grouping | Yes |
| `holding_days` and anything derived from it | **No** |
| Current ownership age (unlisted items) | No |
| `days_acquisition_to_first_listing` (acquisition-to-listing delay) | No |
| Profit/ROI normalized per holding-day (capital-cycle efficiency) | No |

**Row-level rule:** excluding a metric never excludes the row. A historical
item still contributes to `sample_size`, `realized_items`,
`median_net_profit`, `median_roi`, and `median_days_on_market` in the same
GROUP BY output row where its `holding_sample_size` and
`median_holding_days` are computed from a narrower, historical-excluding
population. This is implemented as two independently-filtered aggregate
pairs in the same SELECT, not as two different populations or two different
result rows — see `analytics/sql/01_acquisition_value_band_performance.sql` Query B or
`analytics/sql/03_brand_performance.sql` Query B for the reference pattern:

```sql
-- historical imports included:
COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
-- historical imports excluded from THIS pair only:
COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
```

**"All eligible" cohort rows are not an exception.** In any query that
computes a summary row across the whole eligible population (e.g. "All
eligible Business items" in `01_acquisition_value_band_performance.sql` Query G1 or
`03_brand_performance.sql` Query F), profit/ROI/DOM still read from the full
population, but the holding-metric pair in that same row is still restricted
to the historical-excluding subset. An "All eligible" row's holding number is
never computed by including historical imports.

## 5. Data reliability vs. cohort comparison

These are different claims. Keep them separate in every comment, label, and
future AI-generated sentence:

- **Data reliability** — "is this number trustworthy." Historical imports
  are NOT less reliable data in general. Only `acquisition_date` (and
  metrics computed from it) is approximate. Profit, ROI, DOM, and
  realization-rate figures for historical imports are exactly as trustworthy
  as for app-tracked records.
- **Cohort comparison** — "do two populations of real deals differ, and
  why." Comparing the imported-historical cohort against the app-tracked
  cohort is legitimate and useful. A difference between them may reflect
  changes in deal quality, inventory mix, or business behavior over
  time — it is evidence about the BUSINESS across time, not evidence that
  either cohort's underlying numbers are wrong.

Use these population labels for any such comparison (see
`01_acquisition_value_band_performance.sql` Query G1 and `03_brand_performance.sql`
Query F for the reference implementation):

- **All eligible [population] items** — full population; profit/ROI/DOM use
  every eligible row; holding metrics still use only the historical-excluding
  subset (per section 4).
- **Imported historical [population] items** — `is_historical_import = true`
  only. Profit/ROI/DOM are computed normally. Holding metrics are NOT
  computed as a reliable figure for this cohort — they are shown as 0 /
  NULL by construction (the query's own holding filter already excludes
  every row in this branch), never backfilled or approximated.
- **App-tracked [population] items** — `is_historical_import = false` only.
  The one row with a full, reliable set of metrics including holding time.

Never write, generate, or accept a sentence of the form "historical DOM is
unreliable," "historical profit/ROI should be excluded," or "the gap between
cohorts proves the historical data is bad." All three are false under this
contract.

## 6. Rule for future AI analysis (Business Coach or similar)

No Business Coach / AI analysis prompt exists in this codebase yet (checked:
`src/components/AiPromptsCard.tsx` and the `ai_prompts` table are for
per-platform LISTING copy generation, not analytics interpretation — there is
no analytics-facing AI prompt to update as of this writing). When one is
built, its system instructions MUST encode:

1. Historical imports are real, valid business records. They are never
   described as "unreliable data," "bad data," or "low quality" as a whole.
2. The only approximate field for a historical import is `acquisition_date`.
   Do not extend that caveat to profit, ROI, DOM, realization rate, exit
   mix, or acquisition method.
3. `holding_days` and any metric derived from it (ownership age,
   acquisition-to-listing delay, acquisition-to-exit duration, profit-per-
   holding-day efficiency) legitimately excludes historical imports. Do not
   generalize this into "exclude historical imports from analysis."
4. A difference between the "Imported historical" and "App-tracked" cohorts
   in any query's output must be described as a cohort comparison
   (possible causes: deal quality changes, inventory mix shift, business
   behavior change over time) — never asserted as proof that either
   cohort's data is inaccurate.
5. Never exclude a historical row from `sample_size` / `realized_items` /
   any grouped population count on the basis of `is_historical_import`
   alone.

Until a Business Coach prompt exists, this section is the binding rule for
any AI-assisted interpretation of these analytics files.

## 7. Acquisition Value Band, Purchase Price Band, Exit Value Band, Sale Price Band

Four distinct terms. Do not use them interchangeably — each names a
different population, and picking the wrong one misdescribes what the
number actually measures.

- **Acquisition Value Band** — groups items by `acquisition_value`, banded
  into the fixed ranges (`Zero / unknown`, `$1-999`, `$1,000-1,999`,
  `$2,000-2,999`, `$3,000-3,999`, `$4,000-4,999`, `$5,000+`). Applies to
  **every incoming item**, regardless of acquisition method.
  `acquisition_value` may represent either a cash purchase value or an
  assigned incoming trade value — the view stores one number for both cases
  (`deal_items.total_value` on the `'in'` side of the deal), and nothing in
  `analytics_item_lifecycle` distinguishes "what the item cost in cash" from
  "what value was assigned to it in a trade." This is the correct, and
  only correct, name for the grouping used throughout
  `analytics/sql/01_acquisition_value_band_performance.sql` and
  `analytics/sql/03_brand_performance.sql` Query C/C2 — every one of those
  queries includes trade-acquired items in the same bands as
  cash-purchased items.
- **Purchase Price Band** — the SAME banding logic, but applies ONLY to a
  population already filtered to `acquisition_method = 'purchase'`. Must
  never be used for a population that includes trade acquisitions. No query
  in this analytics layer currently filters this way — if one is added
  later, it must use this name, not "Acquisition Value Band," and must not
  be conflated with it.
- **Exit Value Band** — groups items by `exit_value`, applying to **every
  realized item**. Like `acquisition_value`, `exit_value` may represent
  either a cash sale value or an assigned outgoing trade value
  (`deal_items.total_value` on the `'out'` side). Use this name for any
  future exit-side banding that includes both sale and trade exits.
- **Sale Price Band** — the same banding logic restricted to a population
  filtered to a cash-sale exit (`exit_type = 'sale'`). Must never be used
  for a population that includes trade exits.

**Why the distinction matters (worked example):** a $1,500 acquisition_value
row could be an item bought for $1,500 cash, or a guitar traded in and
assigned a $1,500 incoming value as part of a trade deal — the schema
records the same number either way. Calling every row in the
"$1,000-1,999" Acquisition Value Band a "$1,000-1,999 purchase" would be
factually wrong for every trade-acquired row in that band. The same logic
applies on exit: a $2,200 exit_value could be a $2,200 cash sale or a
$2,200 value assigned to an item given up in a trade — "Exit Value Band"
is correct for a population containing both; "Sale Price Band" would
misdescribe the trade rows.

**Rule:** do not describe `acquisition_value` as "purchase price" unless
the query is explicitly restricted to `acquisition_method = 'purchase'`. Do
not describe `exit_value` as "sale price" unless the query is explicitly
restricted to a cash-sale exit. Two queries in `analytics/sql/` now apply
these restrictions and use the restricted terms correctly:
`02_acquisition_to_exit_analysis.sql` Query F (Purchase Price Band,
`acquisition_method = 'purchase'`) and Query G (Sale Price Band,
`exit_type = 'sale'`). Every OTHER acquisition/exit-value grouping in the
codebase — including every other section of that same file — is an
Acquisition Value Band or Exit Value Band, never a Purchase Price Band or
Sale Price Band.

### 7.1 Analytics Snapshot v1.1: zero, unknown, and negative acquisition values

Introduced with Analytics Snapshot v1.1 (`supabase/migrations/20260730000000_
build_analytics_snapshot_v1_1.sql`) to correct field names and semantics that
Snapshot v1.0 left ambiguous. **v1.0's builder function and every previously
stored v1.0 `analytics_runs.snapshot` row are unchanged and remain fully
readable** — v1.1 is a forward, additive correction, not a rewrite of
history. See `analytics/README.md` for the full v1.1 changelog.

**`acquisition_value_status`** — one consistent derived field, exposed
wherever item-level or cohort logic needs it:

| Status | Meaning |
|---|---|
| `positive` | `acquisition_value > 0` |
| `zero_assigned` | `acquisition_value = 0` — **possibly an intentional assigned value** (e.g. one incoming item in a multi-item trade given zero standalone value). Never a data-quality error by itself. |
| `unknown` | `acquisition_value IS NULL` — genuinely not known. The underlying view permits this structurally (`acquisition_value` flows from a `LEFT JOIN` to an item's incoming `deal_item` in `analytics_item_lifecycle`'s `acquisition` CTE), though no row in production data has this status as of this writing. |
| `negative_invalid` | `acquisition_value < 0` — a data-quality state, excluded from normal performance analysis and surfaced only by integrity checks. |

**Rule 1 — zero assigned is never unknown, and vice versa.** These are two
different facts about two different populations. Never fold one into the
other in a query, a label, a comment, or a future AI-generated sentence.

**Rule 2 — ROI is undefined (NULL) when acquisition value is zero**, because
ROI divides by acquisition value. `analytics_item_lifecycle`'s own `roi`
column already returns `NULL` whenever `acquisition_value IS NULL OR
acquisition_value <= 0` (see `20260723000000_analytics_item_lifecycle.sql`)
— this is existing, correct behavior, not something v1.1 changes. Represent
undefined ROI as `NULL`, never `0` and never infinity.

**Rule 3 — net profit and estimated net upside remain calculable for a
known zero acquisition value.** `gross_profit = exit_value - 0`, `net_profit
= exit_value - 0 - item_expenses_total`, and `estimated_net_upside =
estimated_sold_value - 0 - item_expenses_total` are all valid arithmetic —
the view's existing `net_profit` column and the snapshot builder's
`estimated_net_upside` `CASE` expression already compute these correctly by
ordinary NULL-safe arithmetic (0 is a real number, not NULL). A capital `SUM`
over one or more known-zero rows must produce `0`, not `NULL` — Snapshot
v1.0's open-inventory queries (`01`/`03` Query E1/E2) had a bug here
(`SUM(acquisition_value) FILTER (WHERE acquisition_value > 0)` silently
excluded known-zero rows, producing `NULL` for an all-zero-acquisition band
or brand instead of `0`), fixed in v1.1 by filtering on `acquisition_value
IS NOT NULL` instead.

**Rule 4 — unknown acquisition value prevents any calculation that requires
an acquisition basis.** Net profit, ROI, value increase, and estimated net
upside are all `NULL` when `acquisition_value IS NULL` — this already falls
out of ordinary SQL NULL propagation in every formula above; nothing forces
it, nothing needs to. Never present an unknown acquisition value as zero
capital, and never present a known zero as missing/unknown capital.

**Rule 5 — the six positive Acquisition Value Bands exclude zero and
unknown, but neither disappears silently.** `$1-999` through `$5,000+` (see
section 7 above) are computed ONLY over `acquisition_value_status =
'positive'`, unchanged from v1.0. Zero-assigned and unknown items are
reported in their own dedicated summaries instead of being mixed into a
positive-band median:
`evidence_aggregates.acquisition_value_band.zero_assigned_value_summary`
and `.unknown_acquisition_value_summary` (new in v1.1). Their exclusion from
the positive-band transition matrix (`evidence_aggregates.acquisition_to_
exit.transition_matrix`) is likewise explicit, not silent — see the
`excluded_transition_*` fields below.

**Rule 6 — raw holding-day availability is different from reliable holding
eligibility.** "`holding_days` is populated" and "`holding_days` is
analytically usable" are different claims. v1.1 exposes both explicitly at
the acquisition-value-band population-summary level:
`raw_realized_holding_days_present_count` (realized, `holding_days IS NOT
NULL`, regardless of reliability — includes historical imports) vs.
`eligible_realized_holding_days_count` (realized, non-historical,
`holding_days IS NOT NULL`, AND no lifecycle date issue — the population
every `holding_sample_size` in every module actually uses).
`excluded_historical_realized_holding_days_count` and
`excluded_unreliable_acquisition_date_realized_holding_days_count` account
for the gap between the two. Every `holding_sample_size` /
`median_holding_days` pair in every analytics module (Acquisition Value
Band, Acquisition-to-Exit, Brand) now uses this SAME eligibility rule —
v1.0 was inconsistent (several queries in `01_acquisition_value_band_
performance.sql` and `03_brand_performance.sql` omitted the lifecycle-date-
issue check that others already had), fixed uniformly in v1.1.

**Rule 7 — historical imports are excluded ONLY from acquisition-date-
dependent timing metrics** (holding days, ownership age, acquisition-to-
listing delay, acquisition-to-exit duration measured as time, profit per
30 holding days) — restated from section 4 above, unchanged by v1.1.
Historical imports remain fully eligible for acquisition value, exit value,
net profit, ROI (when acquisition value is positive), listing dates, days
on market, realization evidence, and acquisition/exit method analysis.

**Rule 8 — exit counts must state whether they mean ALL realized exits or
POSITIVE-VALUE-TRANSITION-ELIGIBLE exits.** These are different
populations and must never share a field name:
- `total_realized_sale_exit_count` / `total_realized_trade_exit_count`
  (Acquisition Value Band module, `population_summary`) — every realized
  exit of that type, regardless of acquisition-value eligibility.
- `eligible_transition_sale_exit_count` / `eligible_transition_trade_exit_
  count` (Acquisition-to-Exit module, `population_summary`) — additionally
  requires a positive acquisition value AND a positive exit value.
- The gap between the two is accounted for explicitly:
  `excluded_transition_sale_exit_count_zero_acquisition_value`,
  `excluded_transition_sale_exit_count_unknown_acquisition_value`, and the
  trade-side equivalents, plus item-level
  `excluded_transition_item_count_zero_acquisition_value` /
  `_unknown_acquisition_value` / `_negative_acquisition_value`.
  Reconciliation: `total_realized_sale_exit_count = eligible_transition_
  sale_exit_count + excluded_transition_sale_exit_count_zero_acquisition_
  value + excluded_transition_sale_exit_count_unknown_acquisition_value`
  (plus any negative-value exclusion) — same for trade.

**Rule 9 — brand counts must state their population scope.** Three
distinct brand-count populations exist in the Brand module and must never
share a field name:
- `all_business_distinct_brand_count` (`population_summary`) — every
  Business item, positive/zero-assigned/unknown/negative-invalid alike.
- `positive_acquisition_distinct_brand_count` (`integrity_summary`) —
  positive acquisition value only (the same population `overall_
  performance` and every other profit/ROI query in this module uses).
- `decision_ready_distinct_brand_count` (`population_summary`) — brands
  passing the decision-ready threshold (`sample_size >= 3 AND
  realized_items >= 3`, over the positive-acquisition population) —
  i.e. the brands that appear in `decision_ready_performance`.

**Rule 10 — v1.0 runs remain immutable historical snapshots.** Any
`analytics_runs` row with `analytics_version = '1.0'` was produced by, and
must always be interpreted against, `build_analytics_snapshot_v1`'s v1.0
field names and semantics — it is never reinterpreted under v1.1 naming.
`analytics_version = '1.1'` marks the corrected definition. Both versions
coexist in `analytics_runs` and the Analytics page's run history; neither
is deleted, migrated in place, or silently reinterpreted.

## 8. Acquisition-to-Exit value analysis

Governs `analytics/sql/02_acquisition_to_exit_analysis.sql`. "Acquisition-
to-Exit Analysis" means VALUE movement — `acquisition_value -> exit_value`
— never acquisition-date-to-exit-date DURATION. This file computes no
`holding_days`-derived metric; its one timing metric is
`global_days_on_market` (DOM), measured from `first_listed_at`.

- **value_increase** = `exit_value - acquisition_value`. Distinct from
  `net_profit` (= `exit_value - acquisition_value - item_expenses_total`,
  computed by the view) — item expenses can make net_profit lower than
  value_increase. Always show both side by side; never substitute one for
  the other.
- **Movement classification** — derived from comparing
  `exit_value_band_order` to `acquisition_value_band_order` (never from the
  dollar labels, which could change wording without changing order):
  - `moved_down` — exit_value_band_order < acquisition_value_band_order
  - `stayed_in_same_band` — exit_value_band_order = acquisition_value_band_order
  - `moved_up` — exit_value_band_order > acquisition_value_band_order
- **Transition-population eligibility** — `purpose_name = 'Business'`,
  `is_realized = true`, `acquisition_value IS NOT NULL AND > 0`,
  `exit_value IS NOT NULL AND > 0`. Every excluded row is accounted for by
  Query A1's coverage/reconciliation summary — nothing is silently dropped.
- **Why historical imports remain eligible** — this file never reads or
  derives anything from `acquisition_date`, so the one field section 2 of
  this document treats as approximate for historical imports never enters
  this file's population, band, transition, or median logic. Historical
  rows are exactly as eligible as app-tracked rows throughout;
  `historical_item_count`/`app_tracked_item_count` columns are
  informational cohort counts, never filters.
- **The four primary acquisition/exit method paths** — purchase → sale,
  purchase → trade, trade → sale, trade → trade (Query D/E). A fifth
  family, `unknown` → sale/trade, can appear for Historical Import items
  (`acquisition_method = 'unknown'`) that were later realized — it is
  grouped and shown like any other path, never discarded. An `unknown`
  exit_method is not structurally reachable in this file's population
  (`is_realized` already requires `exit_type IN ('sale', 'trade')`), but
  every query still groups by the actual `exit_type` value rather than
  assuming only two values exist.

## 9. The three analytics scopes: evidence, recommendation, developer

Governs how any current or future analytics output — SQL query, autorunner
snapshot, or AI-facing payload — is scoped. Every result produced from
`analytics_item_lifecycle` belongs to exactly one of these three:

### 9.1 Evidence population

The statistical population used to calculate aggregate patterns:
**all eligible shared Business items.** For the current private two-user
application, existing analytical SQL may use all eligible Business rows
available to the privileged analytics process that runs it (see section 12
— this is a controlled, server-side/manually-run process, not an ordinary
authenticated app session). Evidence aggregates may include both users'
data pooled together.

Examples: brand performance, Acquisition Value Band performance,
Acquisition-to-Exit transitions, realization rate, profit and ROI medians,
aggregate DOM — i.e. every section in `01_acquisition_value_band_performance.sql`,
`02_acquisition_to_exit_analysis.sql`, and `03_brand_performance.sql`
classified `shared aggregate evidence` (see each file's own Query
Classification Index).

An evidence result is an aggregate — a count, a median, a percentage, a
label — never a single item's own `item_id`, `user_id`, or display name.

### 9.2 Recommendation target

The population for item-specific actions: **only open eligible Business
items owned by the current target user.**

Examples: list this item, reprice this item, relist this item, trade out
this item, bundle these pedals, review this stale listing.

Another user's item may contribute to aggregate evidence (section 9.1) but
must NEVER appear as an item-level recommendation for a different current
user. Recommendation-target population is defined fully in section 11.

### 9.3 Developer verification population

Developer-only SQL drilldowns (e.g. `01_acquisition_value_band_performance.sql`
Query G5, `02_acquisition_to_exit_analysis.sql` Query H,
`03_brand_performance.sql` Query H) may temporarily contain item-level rows
belonging to multiple users, for validating that the aggregates above them
are computed correctly. They are explicitly labelled `CLASSIFICATION:
developer-only verification` in their own file. A developer verification
result must NOT be:

- included in a future user-facing analytics snapshot;
- sent to the AI as recommendation candidates;
- exposed in a current user's UI;
- treated as Business Coach output.

Developer drilldowns are not removed merely because they contain multiple
users — they remain useful during development. The restriction is on where
their OUTPUT may flow, not on whether they may exist.

## 10. Snapshot boundary

**Update (Phase 2 Step 2):** the boundary this section describes is now
concretely implemented by
`public.build_analytics_snapshot_v1(p_recommendation_target_user_id int)`
(`supabase/migrations/20260728000000_build_analytics_snapshot_v1.sql`) —
see `analytics/README.md` for its exact contract and the manual-query-to-
JSON-key mapping. That function computes the snapshot but does not persist
it; persisting it into `analytics_runs.snapshot` is Phase 2 Step 3, still
not built. The rules below governed the implementation and continue to
govern any future change to it.

The autorunner produces two separate top-level sections, never merged into
one:

- **`evidence_aggregates`** — may use all eligible shared Business items
  (section 9.1). Must contain aggregate results only — counts, medians,
  percentages, labels. Must NOT contain another user's item names or item
  IDs. Pooling both users' data into a median is fine; naming whose item
  produced the extreme value is not.
- **`recommendation_candidates`** — must contain only the target user's own
  items (section 9.2, eligibility in section 11). Must be filtered by
  target user BEFORE being sent to any AI process — filtering is not a
  presentation-layer concern, it happens before the data leaves the
  server-side analytics process.

Boundary rules:

- `evidence_aggregates` may use all eligible shared Business items.
- `evidence_aggregates` must contain aggregate results, not another user's
  item names or item IDs.
- `recommendation_candidates` must contain only the target user's items.
- `recommendation_candidates` must be filtered before being sent to AI.
- Another user's item-level data must not be recoverable from
  `evidence_aggregates` — no aggregate should be computed over a group so
  small (e.g. a median of 1) that it silently re-exposes one specific
  other-user item's value. (The existing `confidence` /
  `sample_confidence` conventions already flag small-sample rows for this
  reason — a future snapshot step should treat "insufficient" confidence
  as a signal to consider suppressing or coarsening that row, not only as
  an interpretation warning.)
- Developer verification drilldowns (section 9.3) are not persisted in the
  user-facing snapshot at all.

This section intentionally does NOT define a complete JSON schema, field
list, or storage format for either section — that belongs to the future
autorunner/snapshot implementation step, not this documentation step.

## 11. Recommendation-candidate eligibility contract (documentation only — no recommendations generated in this step)

Initial eligibility rule for a future item-level recommendation candidate:

- item belongs to `recommendation_target_user_id` (a parameter/argument
  resolved at call time from the authenticated session — see section 12;
  never a hardcoded literal user ID anywhere in code, SQL, or
  documentation);
- `purpose_name = 'Business'`;
- item is open / not realized (`is_realized = false`);
- item may be `listed` or `owned`/unlisted — both open sub-states are
  eligible; recommendation LOGIC may later treat them differently (e.g.
  "list this item" vs. "reprice this item"), but both belong to the
  eligibility population;
- recommendation logic may later apply additional rules such as DOM,
  ownership age, capital tied up, estimated upside, brand evidence, or
  confidence — NONE of those additional rules are defined or implemented
  in this step.

This step does not generate any recommendation, does not classify any
specific item as a candidate, and does not classify another user's item as
a recommendation candidate under any condition. `recommendation_target_user_id`
is always a variable resolved from the authenticated caller at request
time — no real `app_users.id` value for either of this application's two
current users is ever written into code, SQL, or this document.

## 12. Security design note (documentation only — no runtime change in this step)

How this separation should be enforced when the autorunner/snapshot/AI
integration is eventually built (none of this is implemented yet):

- **Shared aggregate evidence** (section 9.1) should be produced only by a
  controlled server-side analytics process — not by handing the ordinary
  authenticated client a raw, unrestricted `SELECT * FROM
  analytics_item_lifecycle`. The current app's `authenticated` role can
  already read `analytics_item_lifecycle` (`GRANT SELECT ... TO
  authenticated`, see the view's migration), but under ordinary RLS-scoped
  access this returns only that user's own rows — see section 12's RLS
  paragraph below. Every analytics SQL file in this repository is today
  run manually (SQL Editor / a role that bypasses RLS), which is exactly
  the "privileged analytics process" section 9.1 describes; it is not
  something the ordinary app client does today or should do in the future.
- The current user must not receive direct, unrestricted access to another
  user's lifecycle rows through any new feature built on this analysis.
- Current-user recommendation candidates (section 11) must be explicitly
  filtered by the authenticated/target application user ID
  (`app_users.id`, an integer — see the Ownership Model note below) before
  being saved or returned, in the server-side process itself, not merely
  in a client-side display filter.
- RLS remains the protection for ordinary application reads. This document
  does not weaken, modify, or replace any existing RLS policy.
- A future service-role/server process (the autorunner) must perform its
  own explicit target-user filtering before saving or returning item-level
  data — a service-role connection bypasses RLS entirely, so the filtering
  responsibility moves from "the database enforces it" to "the server
  process must enforce it explicitly," and that process must be written
  with that responsibility in mind from the start.

**Ownership model this design assumes** (audited, not assumed — see Phase
1 Step 4's report for the full audit): `public.app_users.id` is a plain
`int GENERATED ALWAYS AS IDENTITY` — NOT a UUID. `app_users.auth_user_id`
(uuid) is the FK to Supabase's `auth.users.id`. `public.get_app_user_id()`
(`SECURITY DEFINER`) maps `auth.uid()` → `app_users.id` and backs every RLS
policy on `inventory_items`, `deals`, `deal_items`, `cash_flow`,
`inventory_expenses`, and `inventory_item_photos`.
`analytics_item_lifecycle.user_id` is `inventory_items.user_id` exposed
verbatim (also `int`). No workspace, organization, household, or shared-
membership model exists in the schema today — only forward-looking
comments in `20260723000000_analytics_item_lifecycle.sql` and
`20260724000000_historical_deal_type_labels.sql` mentioning a hypothetical
future `organization_id` model, never implemented. This document does not
create one.

No security-definer functions and no new database tables, views,
functions, migrations, or RPCs are created by this document — everything
in sections 9-12 is documentation of a future design, enforced today only
by the existing RLS policies already in place.

## 13. Future Business Coach Insight Contract (documentation only — no Business Coach, AI calls, prompts, schemas, or runtime code exist yet)

Governs the required CONCEPTUAL structure of any future AI-generated
analytics insight, so the distinction between calculated fact and AI
judgment is never lost when the autorunner and Business Coach are
eventually built. This section defines principles only — no prompt text,
structured-output JSON schema, or AI integration is introduced here; that
is a later, separate implementation step. Every rule below applies
regardless of how that future implementation is built.

A future insight conceptually follows this shape, always in this order:

```
Fact → Evidence → Interpretation → Recommendation → Confidence → Scope → Limitations
```

### 13.1 Fact

A statement directly supported by the analytics snapshot (section 10) —
e.g. "Gibson purchases have a median net profit of $1,000," "the evidence
population contains 8 Gibson purchases, of which 7 are realized," "three of
the target user's Fender items are currently open."

- Facts must come directly from snapshot values — never invented, never
  extrapolated beyond what the snapshot actually contains.
- Facts must not contain invented explanations — an explanation belongs in
  Interpretation (13.2), not Fact.
- Facts must identify important denominators and sample sizes (a median
  without its sample size is not a complete fact — see the analytics
  convention already established throughout `analytics/sql/*.sql`).
- Acquisition Value must not be called Purchase Price unless the population
  is explicitly restricted to `acquisition_method = 'purchase'`. Exit Value
  must not be called Sale Price unless the population is explicitly
  restricted to a cash-sale exit. See section 7 for the full definitions —
  not restated here.

### 13.2 Interpretation

An explanation of what one or more facts may mean — e.g. "the stronger
Gibson result appears to come primarily from favorable cash acquisitions
rather than from trade-acquired Gibson items."

- Must be clearly distinguished from Fact — a reader must never be able to
  mistake an interpretation for a directly-observed snapshot value.
- Describes reasonable implications, not proven causation. Correlation
  shown in the evidence is never asserted as causation.
- Must be traceable to the supporting evidence cited alongside it (13.6).
- Must mention important alternative explanations where applicable: brand
  or model mix, Acquisition Value Band mix, acquisition method, exit
  method, historical-vs-app-tracked cohort differences (section 5 — this is
  a cohort comparison, never a data-reliability claim), or small samples.

### 13.3 Recommendation

A suggested action for `recommendation_target_user_id` — e.g. "consider
prioritizing under-market Gibson purchase opportunities," "review the
target user's Fender listing that has been on the market for more than 60
days."

- Recommendations are judgments, not statistical facts, and must never be
  presented as one.
- A recommendation must explain why it follows from the evidence.
- Item-level recommendations may reference only items belonging to
  `recommendation_target_user_id` (section 9.2 / section 11). Another
  user's item may contribute to aggregate evidence (section 9.1) but must
  NEVER appear as a recommendation target or a supporting item-level
  example — this is the same boundary section 9 already establishes for
  the snapshot itself, applied here to AI-generated text.
- The AI must not recommend action when evidence is insufficient without
  explicitly stating that uncertainty.
- The AI must not automatically interpret high ownership age, low
  estimated upside, or long DOM as requiring a sale — it must explain the
  tradeoff and keep fact separate from judgment (e.g. "this item has been
  listed 90 days, well above the brand's median of 35 — that alone does
  not mean it should be sold; consider whether repricing, relisting on
  another channel, or holding for a better buyer fits your goals").

### 13.4 Confidence

The strength of evidence supporting an interpretation or recommendation,
using the established analytics levels: **insufficient, low, moderate,
stronger** (the same 4-tier convention already used throughout
`analytics/sql/*.sql` and the snapshot's `confidence` fields — see section
7's methodology references; not a new scale).

- Confidence must be grounded in the snapshot's own sample size and
  confidence fields — never asserted independently of them.
- The AI must not silently upgrade confidence (e.g. treating an
  "insufficient" aggregate as if it were "moderate" because the
  interpretation sounds plausible).
- Confidence may be LOWER than the source aggregate's own confidence when a
  recommendation depends on a further subdivision the snapshot's
  confidence field doesn't already account for — one brand, one
  Acquisition Value Band, one acquisition method, one exit method, or one
  specific item. Narrowing the population narrows the evidence; the stated
  confidence must reflect the narrower slice actually being used, not the
  broader aggregate it was drawn from.
- Small samples must remain visible rather than hidden — matching the
  standing analytics-folder convention (`analytics/README.md`).

### 13.5 Scope

The population a statement applies to. At minimum, every future insight
must make clear whether it describes:

- the shared evidence population (section 9.1);
- the target user's inventory (section 9.2 / section 11);
- a particular brand;
- an Acquisition Value Band;
- a purchase-only population (Purchase Price Band, section 7);
- a sale-only population (Sale Price Band, section 7);
- an imported historical cohort;
- an app-tracked cohort (section 5).

Three scopes govern what may appear at all:

- **Evidence scope** — all eligible shared Business items used for
  aggregate statistical evidence (section 9.1).
- **Recommendation scope** — only open eligible Business items belonging
  to `recommendation_target_user_id` (section 9.2, eligibility in section
  11).
- **Developer scope** — developer-only drilldowns and per-user diagnostics
  (section 9.3); these must never appear in user-facing AI output, exactly
  as they must never appear in the user-facing snapshot.

### 13.6 Evidence

A future insight should cite its most important supporting values
concisely, drawn directly from the fixed analytics snapshot under
discussion — not recomputed or re-derived by the AI. At minimum, where
relevant to the statement being made: sample size, realized/open count,
median net profit, median ROI, median DOM, realization rate,
acquisition/exit method counts, transition counts, and confidence level.

### 13.7 Limitations

A future insight should explicitly identify material limitations where
they apply, including: insufficient or low sample size; missing DOM;
estimated values (e.g. `estimated_sold_value`, `estimated_net_upside`)
rather than actual realized cash values; mixed cash-and-trade populations
(section 7); historical acquisition dates being unreliable for
holding-based metrics only (section 1, section 2); brand/model/category
mix; results that depend heavily on one or two items; and that the
evidence is aggregate and does not prove how any one specific item will
perform.

### 13.8 Historical-data rule (restated from section 6 — not a new rule)

Historical imports remain valid for profit, ROI, realization, exit mix,
listing dates, days on market, Acquisition Value Band, Acquisition-to-Exit
transitions, and brand evidence. They are excluded ONLY from
acquisition-date-dependent metrics: holding days, ownership age,
acquisition-to-listing delay, and acquisition-to-exit duration measured in
time. The future AI must not describe historical profit, ROI, or DOM as
unreliable merely because the item was imported — see section 6 for the
full rule this restates.

### 13.9 Prohibited future AI behavior

The Business Coach must not:

- present an interpretation or recommendation as a fact;
- invent causes not present in the analytics;
- confuse acquisition value with purchase price, or exit value with sale
  price (section 7);
- exclude historical profit, ROI, or DOM without a valid reason (13.8);
- use historical acquisition dates for holding-based conclusions;
- expose another user's item-level information;
- recommend actions for another user's items;
- infer another user's individual performance from developer-only
  per-user diagnostics (section 9.3);
- make a strong business rule from insufficient or low evidence (13.4);
- imply that correlation proves causation (13.2);
- claim that waiting, selling, listing, repricing, or trading is
  objectively correct without explaining assumptions and tradeoffs (13.3).

## 14. Non-goals of this document

This contract governs semantics only. It does not:

- Add further Purchase Price Band / Sale Price Band analytical queries
  beyond `02_acquisition_to_exit_analysis.sql` Query F/G, or an Exit Value
  Band-restricted query, without a new explicit request — section 7 defines
  the terms; those two queries are the only ones currently scoped this way.
- Introduce new database columns, CHECK constraints, or migrations. Every
  rule above is enforced with `is_historical_import` (already derived in
  `analytics_item_lifecycle` from `deals.deal_type`) and explicit query-level
  filters — never by nulling or deleting historical values in the view.
- Cover cash-flow ledger "historical data" (`docs/PROJECT_STATUS.md` /
  `docs/database-schema.md`'s "Historical Import" sections) — that is an
  unrelated subsystem (backdated cash-flow ledger entries), not
  `analytics_item_lifecycle`'s `is_historical_import`.
- Build a full autorunner, API routes, UI, scheduled jobs, AI
  recommendations, or a Business Coach. `analytics_runs`
  (`20260727000000`) and the snapshot builder function,
  `build_analytics_snapshot_v1` (`20260728000000`), now exist — see
  section 10 — but nothing calls the builder and stores its result yet
  (Phase 2 Step 3), and none of the remaining pieces in this list are
  implemented.
- Implement the Business Coach itself, make any AI API call, store any AI
  prompt in the database, define a structured-output JSON schema, add
  TypeScript types, or build UI components. Section 13 documents required
  CONCEPTUAL principles only (fact/interpretation/recommendation/
  confidence/scope/evidence/limitations) for whenever that implementation
  happens — it is not that implementation.
- Create a workspace, organization, or household membership model. Section
  12 documents the ownership model AS FOUND, not a proposed replacement.
- Create security-definer functions. `build_analytics_snapshot_v1` and its
  four private helpers are all `SECURITY INVOKER` — see section 10 and
  `20260728000000_build_analytics_snapshot_v1.sql`.
- Weaken, modify, or replace any existing RLS policy.
- Add Open Inventory Decision Support or any new non-channel business-
  performance module. Analytics Snapshot v1.1
  (`20260730000000_build_analytics_snapshot_v1_1.sql`, section 7.1) is a
  semantic-naming and consistency correction to the THREE existing modules
  (Acquisition Value Band, Acquisition-to-Exit, Brand) — it does not add a
  fourth module. `build_analytics_snapshot_v1` (v1.0) remains unchanged and
  callable; v1.1 is additive, not a replacement.
- Add Open Inventory Decision Support, listing conversion, current listing
  recommendations, channel x brand, channel x category/type, or monthly
  channel trends. Analytics Snapshot v1.2
  (`20260801000000_build_analytics_snapshot_v1_2.sql`, section 15) adds
  EXACTLY ONE Channel Analytics module — Deal In Channel Performance;
  Snapshot v1.3 (`20260803000000_build_analytics_snapshot_v1_3.sql`,
  section 16) adds EXACTLY ONE further module — Deal Out Channel
  Performance; Snapshot v1.4
  (`20260804000000_build_analytics_snapshot_v1_4.sql`, section 17) adds
  EXACTLY ONE further module — Channel Journey; Snapshot v1.5
  (`20260805000000_build_analytics_snapshot_v1_5.sql`, section 18) adds
  EXACTLY ONE further module — Listing Channel Exposure — and nothing
  else. `build_analytics_snapshot_v1` (v1.0), `build_analytics_snapshot_v1_1`
  (v1.1), `build_analytics_snapshot_v1_2` (v1.2),
  `build_analytics_snapshot_v1_3` (v1.3), and `build_analytics_snapshot_v1_4`
  (v1.4) remain unchanged and callable; v1.5 is additive, not a
  replacement.
- Add Open Inventory Decision Support, AI recommendations, Business Coach,
  or a UI redesign. Analytics Snapshot v1.6
  (`20260806000000_build_analytics_snapshot_v1_6.sql`, section 19) adds
  EXACTLY ONE module — Category & Type Performance — and nothing else.
  `build_analytics_snapshot_v1` (v1.0) through `build_analytics_snapshot_v1_5`
  (v1.5) remain unchanged and callable; v1.6 is additive, not a
  replacement.
- Add item-level recommendations, recent trends, AI recommendations,
  Business Coach, or cash-balance analysis. Analytics Snapshot v1.7
  (`20260807000000_build_analytics_snapshot_v1_7.sql`, section 20) adds
  EXACTLY ONE module — Capital & Liquidity — and nothing else. It reports
  acquisition CAPITAL (value assigned to inventory), never a user's
  `cash_flow` ledger/cash-balance, which is a wholly separate subsystem
  not read anywhere in that module. `build_analytics_snapshot_v1` (v1.0)
  through `build_analytics_snapshot_v1_6` (v1.6) remain unchanged and
  callable; v1.7 is additive, not a replacement.
- Add AI-generated recommendations, Business Coach, recent trends, cash-
  balance logic, automatic repricing, notifications, or a UI redesign.
  Analytics Snapshot v1.8
  (`20260808000000_build_analytics_snapshot_v1_8.sql`, section 21) adds
  EXACTLY ONE module — Open Inventory Decision Support v1 — and nothing
  else. It never produces a `score`, `priority_score`, `recommended_action`,
  sell/keep/reprice decision, or AI-generated prose — `reason_codes` is a
  deterministic array of evidence flags only, never counted or weighted
  into anything. `build_analytics_snapshot_v1` (v1.0) through
  `build_analytics_snapshot_v1_7` (v1.7) remain unchanged and callable;
  v1.8 is additive, not a replacement.

## 15. Deal In Channel (Channel Analytics module 1)

Governs `analytics/sql/04_deal_in_channel_performance.sql` and
`public._build_deal_in_channel_snapshot_v1()`
(`supabase/migrations/20260801000000_build_analytics_snapshot_v1_2.sql`).
This is the FIRST of what will eventually be several Channel Analytics
modules — see the Non-goals bullet above for exactly which future modules
are explicitly out of scope for now.

**Definition.** Deal In Channel is the channel where CONTACT with the
seller or trade partner ORIGINATED for the operation through which an item
ENTERED inventory: Marketplace, Kijiji, Reverb, or Regular Buyer / Seller.
It is NOT a payment method, NOT a shipping method, and NOT "the technical
place where the deal was completed."

- For a purchase, this is the purchase deal's `deal_channel_id`.
- For a trade acquisition, this is the trade deal's `deal_channel_id`.
- For Historical Purchase / Historical Trade, this is the historical
  deal's own channel, when one was recorded.
- Historical Import (acquisition method never determined) or any
  acquisition with no recorded channel has `deal_in_channel_id = NULL` —
  a real, visible "missing channel" state, reported explicitly via
  `population_summary.deal_in_channel_missing_item_count`, never hidden or
  defaulted to a fake channel.

**Columns** (`analytics_item_lifecycle`, added
`20260731000000_analytics_item_lifecycle_deal_in_channel.sql`):
`deal_in_channel_id`, `deal_in_channel_name`,
`deal_in_channel_requires_listing` (the channel's own
`deal_channels.is_listing_platform`, NULL when the channel itself is
unknown). These are sourced from exactly the same acquisition-deal-channel
join the pre-existing `acquisition_channel_id`/`acquisition_channel_name`
columns already use — this is a naming addition for Channel Analytics, not
a new join or a new fact about the data. The older
`acquisition_channel_id`/`acquisition_channel_name` names are unchanged and
not removed.

**Naming rule.** Never use the ambiguous names `channel_id`,
`channel_name`, `acquisition_channel`, or `source_channel` in any Channel
Analytics output. Always use the explicit `deal_in_channel_*` /
`deal_in_item_count` / `deal_in_distinct_deal_count` /
`deal_in_realized_item_count` / `deal_in_open_item_count` forms.

**Scope.** Deal In Channel evidence uses the full shared eligible Business
population (`purpose_name = 'Business'`), same evidence/recommendation
boundary as every other module (section 9-11) — no per-user channel
breakdown exists or is added here (unlike 01/03's developer-only Query
G2/G, no per-user analog exists in file 04 at all). `deal_in_distinct_deal_count`
counts DISTINCT `acquisition_deal_id`, not items — a single multi-item
purchase/trade deal contributes many items but one deal.


## 16. Deal Out Channel (Channel Analytics module 2)

Governs `analytics/sql/05_deal_out_channel_performance.sql` and
`public._build_deal_out_channel_snapshot_v1()`
(`supabase/migrations/20260803000000_build_analytics_snapshot_v1_3.sql`).
This is the SECOND Channel Analytics module — see the Non-goals bullet in
section 14 for exactly which future modules remain out of scope.

**Definition.** Deal Out Channel is the contact-source channel of the
operation through which an item LEFT inventory: Marketplace, Kijiji,
Reverb, or Regular Buyer / Seller. It is NOT a payment method, NOT a
shipping method, and NOT "the technical place where the deal was
completed." Example: a buyer contacted us through Reverb but payment
happened outside Reverb — Deal Out Channel = Reverb regardless.

- For a cash sale, this is the sale deal's `deal_channel_id`.
- For a trade, the existing `deal_channel_id` on that ONE trade deal is the
  single counterparty/contact-source channel for the whole deal — incoming
  and outgoing items on the same trade deal are NEVER assigned separate
  channels.
- Open (not-yet-realized) items ALWAYS have `deal_out_channel_id = NULL` —
  there is no exit deal yet to read a channel from.
- A realized cash sale always has a channel (`create_sell_operation`
  requires `p_channel_id`); a realized trade MAY have no channel recorded
  (`create_trade_operation`'s `p_channel_id` is optional) — a real, visible
  "missing channel" state, reported explicitly via
  `population_summary.deal_out_channel_missing_item_count`, never hidden or
  defaulted to a fake channel.

**Columns** (`analytics_item_lifecycle`, added
`20260802000000_analytics_item_lifecycle_deal_out_channel.sql`):
`deal_out_channel_id`, `deal_out_channel_name`,
`deal_out_channel_requires_listing` (the channel's own
`deal_channels.is_listing_platform`, NULL when the channel itself is
unknown or the item is still open). These are sourced from exactly the
same exit-deal-channel join the pre-existing `exit_channel_id`/
`exit_channel_name` columns already use — this is a naming addition for
Channel Analytics, not a new join or a new fact about the data. The older
`exit_channel_id`/`exit_channel_name` names are unchanged and not removed.

**Naming rule.** Never use the ambiguous names `channel_id`,
`channel_name`, `exit_channel`, or `source_channel` in any Channel
Analytics output. Always use the explicit `deal_out_channel_*` /
`deal_out_item_count` / `deal_out_distinct_deal_count` forms.

**Cash sale vs. trade exit — never conflate the two.** `exit_value` stores
either a cash sale value or an assigned outgoing trade value in the same
column (section 7). `05_deal_out_channel_performance.sql` follows
`02_acquisition_to_exit_analysis.sql` Query G's own convention: `exit_value`
may be called a "sale price" ONLY in the cash-sales-only section
(`cash_sales_by_channel`), and an "assigned trade exit value" ONLY in the
trade-exits-only section (`trade_exits_by_channel`). The overall and banded
sections (`overall_performance`, `by_exit_value_band`,
`by_acquisition_value_band`), which mix both exit methods together, use
the neutral term "exit value" and never either narrower term.

**Scope.** Deal Out Channel evidence is restricted to REALIZED shared
eligible Business items (`purpose_name = 'Business' AND is_realized`) —
unlike Deal In Channel (section 15), which reports on every Business item
whether open or realized, because acquisition always happens but exit does
not. Same evidence/recommendation boundary as every other module (section
9-11) — no per-user channel breakdown exists or is added here.
`deal_out_distinct_deal_count` counts DISTINCT `exit_deal_id`, not items —
a single multi-item trade deal contributes many items but one deal.
`historical_item_count`/`app_tracked_item_count` in `overall_performance`
are cohort splits based on the item's ACQUISITION history
(`is_historical_import`), never about the exit itself — no "Historical
Sale"/"Historical Trade exit" `deal_type` exists in this schema; every
realized exit's `deal_type` is exactly `'sale'` or `'trade'`.

## 17. Channel Journey (Channel Analytics module 3A)

Governs `analytics/sql/06_channel_journey.sql` and
`public._build_channel_journey_snapshot_v1()`
(`supabase/migrations/20260804000000_build_analytics_snapshot_v1_4.sql`).
This is the THIRD Channel Analytics module — specifically "module 3A"
because Listing Channel Exposure (a related but separate module) remains
explicitly out of scope — see the Non-goals bullet in section 14.

**Definition.** Channel Journey answers how Business items move from their
Deal In contact-source channel (section 15) to their Deal Out
contact-source channel (section 16), using ONLY the explicit
`deal_in_channel_id`/`deal_in_channel_name`/`deal_out_channel_id`/
`deal_out_channel_name` fields — never the legacy
`acquisition_channel_*`/`exit_channel_*` names, which remain on the view
unchanged for their own older readers.

**Eligibility.** The journey matrix (`deal_in_to_deal_out_matrix` and every
section after it) includes ONLY realized Business items where BOTH
`deal_in_channel_id` AND `deal_out_channel_id` are known (`NOT NULL`).
Missing Deal In Channels are NEVER invented or backfilled. A historical
realized item with a missing Deal In Channel is EXCLUDED from the journey
matrix but explicitly counted in `population_summary`'s
`missing_deal_in_channel_item_count` / `missing_deal_out_channel_item_count`
/ `missing_both_channels_item_count` — a missing-channel record is reported,
never silently dropped.

**Reconciliation** (`population_summary`):

```
realized_business_item_count
  = journey_eligible_item_count
  + missing_deal_in_channel_item_count
  + missing_deal_out_channel_item_count
  - missing_both_channels_item_count
```

The subtraction avoids double-counting items missing BOTH channels, which
would otherwise be counted once in each of the two "missing one channel"
fields.

**Same channel — descriptive, not causal.** "Same channel"
(`same_channel_summary`, `same_channel_by_deal_in_channel`) means
`deal_in_channel_id = deal_out_channel_id` — the item entered and left
inventory through contact with the SAME channel. `same_channel_exit_percent`
is DESCRIPTIVE PATH EVIDENCE ONLY:

- It is NEVER called a "conversion rate."
- It never implies the channel CAUSED the exit.
- It must never be compared against Deal In Channel's own item counts
  (section 15, file 04 — population is ALL Business items, open or
  realized, channel known or not) or Deal Out Channel's own item counts
  (section 16, file 05 — population is ALL realized items, channel known or
  not) as though they shared a denominator. Channel Journey's population is
  the narrower intersection: realized AND both channels known.
- Every path percentage must be reported alongside its sample size
  (`journey_eligible_item_count` / `eligible_realized_item_count`) and
  `confidence` — never a bare percentage.

**Scope.** Channel Journey evidence uses the shared eligible Business
population, same evidence/recommendation boundary as every other module
(section 9-11) — no per-user channel breakdown, `user_id`, `item_id`, item
name, or model appears anywhere in this module's output.
`distinct_acquisition_deal_count` / `distinct_exit_deal_count` count
DISTINCT `acquisition_deal_id` / `exit_deal_id` independently — a single
matrix row's acquisition-side and exit-side deal-sharing can differ (e.g.
two items acquired together but sold separately, or vice versa), so both
counts are always present and never conflated into one. Historical items
may contribute to the matrix when both channels are known, but remain
excluded from `holding_sample_size`/`median_holding_days`, same as every
other module.

## 18. Listing Channel Exposure (Channel Analytics module 3B)

Governs `analytics/sql/07_listing_channel_exposure.sql` and
`public._build_listing_channel_exposure_snapshot_v1()`
(`supabase/migrations/20260805000000_build_analytics_snapshot_v1_5.sql`).
This is "module 3B" because it is a sibling of Channel Journey (module 3A,
section 17) rather than a strict sequel — both build on Deal In/Deal Out
Channel (modules 1-2) but Listing Channel Exposure introduces an
independent third fact source, `item_listings`, not derived from either.

**Definition.** Listing Channel is where an item was ADVERTISED, read
directly from `item_listings`. It is explicitly NOT Deal In Channel
(section 15 — where seller/trade-partner contact originated for the
acquisition) and NOT Deal Out Channel (section 16 — where buyer/
trade-partner contact originated for the exit). This module never infers
listing exposure from either of those — every exposure fact comes straight
from `item_listings` joined to `deal_channels`.

**`item_listings` schema findings** (established while building this
module, not assumed): there is NO active/current-state column.
`status` (draft/published/archived) existed briefly but was DROPPED in
`20260721000000_migrate_date_listed_to_item_listings.sql`, whose header
states the replacement rule verbatim: "Publication is determined solely by
`listed_at IS NOT NULL`." No `unlisted_at`/`delisted_at`/`is_active` column
exists. Per this module's own design decision (documented, not invented
silently): CURRENT/ACTIVE exposure means an OPEN (`NOT is_realized`)
Business item with an eligible listing record — there is no way, with
today's schema, to distinguish "still actively listed" from "listed once,
never explicitly delisted." `item_listings.deal_channel_id` is `NOT NULL`
(enforced since `20260713000001_listing_platform_channels.sql`), so
`missing_listing_channel_record_count` (population_summary) means records
missing a usable `listed_at`, never a missing channel.

**Eligible listing record**: an `item_listings` row where its
`deal_channels.is_listing_platform = true` (Marketplace/Kijiji/Reverb
today — "Regular Buyer / Seller" is a relationship/non-listing channel,
always excluded) AND `listed_at IS NOT NULL`.

**Canonical exposure — one row per (item, listing channel).** Multiple
`item_listings` rows can exist for the same (`inventory_item_id`,
`deal_channel_id`) pair (the unique constraint added in
`20260721000000_migrate_date_listed_to_item_listings.sql` was only applied
if zero duplicates existed at that migration's run time — not a permanent
schema guarantee). Eligible records are grouped by
(`inventory_item_id`, `deal_channel_id`) into one canonical exposure,
preserving `listing_record_count` (physical record count) alongside
`MIN(listed_at)` (first_listed_at) and `MAX(listed_at)` (latest_listed_at).
An item is never double-counted on the same channel.

**Cross-listing is non-mutually-exclusive.** An item may have canonical
exposure on more than one Listing Channel. `listing_channel_performance`,
`listing_to_deal_out_matrix`, and `open_inventory_by_listing_channel` are
ALL exposure-level — a cross-listed item appears in MULTIPLE rows across
those sections, and their item counts must NEVER be summed across channels
and compared to a unique Business item total. Only `population_summary`
and `cross_listing_summary` report unique item counts, each item counted
exactly once.

**Same channel — descriptive, not causal** (same rule as section 17's
Channel Journey): "same channel" means
`listing_channel_id = deal_out_channel_id`. `same_channel_exit_percent` is
NEVER a "conversion rate" and never implies the listing caused the exit.
`listing_to_deal_out_matrix` is explicitly NOT a mutually exclusive journey
matrix and NOT a conversion funnel — because one item can have multiple
Listing Channel exposures, the SAME realized item may appear in MULTIPLE
matrix rows (one per channel it was exposed on). Rows represent EXPOSURE
ASSOCIATIONS, never a single deterministic path.

**Channel-specific listing age.** `open_inventory_by_listing_channel` uses
`CURRENT_DATE - <that channel's own canonical first_listed_at>` for
listing age — never the item's overall (any-channel) `first_listed_at` —
so a cross-listed item's staggered per-channel listing dates are never
misattributed to the wrong channel.

**Scope.** Listing Channel evidence uses the shared eligible Business
population, same evidence/recommendation boundary as every other module
(section 9-11) — no `user_id`, `item_id`, item name, or model appears
anywhere in this module's output, and no per-user listing breakdown
exists. `recommendation_candidates` are unchanged and remain restricted to
`recommendation_target_user_id`; this module adds no target-user listing
recommendations.

## 19. Category & Type Performance

Governs `analytics/sql/08_category_type_performance.sql` and
`public._build_category_type_snapshot_v1()`
(`supabase/migrations/20260806000000_build_analytics_snapshot_v1_6.sql`).
This is NOT a Channel Analytics module — it groups by `category_id`/
`category_name`/`type_id`/`type_name` (already exposed by
`analytics_item_lifecycle`, sourced from `item_subtypes`/`item_categories`)
instead of any Deal In/Deal Out/Listing channel. No lifecycle view
migration was needed.

**Population.** Business items only (`purpose_name = 'Business'`).
`category_performance` and `type_performance` (Query B/C) report on the
FULL population (open + realized) — Category/Type is a property an item
has from creation, unlike an exit-side fact. `category_by_acquisition_value_
band`/`type_by_acquisition_value_band` (Query D/E) narrow to
`acquisition_value_status = 'positive'`, matching every other band query in
this analytics layer (sections 7.1, 15, 16). `open_inventory_by_category_
type` (Query F) narrows to open (`NOT is_realized`) items only.

**Historical imports** follow the exact rule in sections 1-4: included in
item counts, realization rate, profit, ROI, DOM, acquisition/exit values,
and sale/trade mix; excluded ONLY from `holding_days`/ownership-age
metrics, because `acquisition_date` is the one approximate field for a
historical import.

**Missing Category/Type is never excluded.** A row with `category_id IS
NULL` or `type_id IS NULL` (no `item_subtype_id` recorded) is never dropped
from any query — GROUP BY keeps the NULL group visible, same as the
missing-channel rows in sections 15/16. `population_summary` reports this
coverage explicitly (`category_known_item_count`/
`category_missing_item_count`, and separately for type). Missing Type is a
DATA-QUALITY GROUP, never a real Type — never plot, rank, or recommend
against it as a genuine inventory category.

**Same Type name, different Category — never merged.** Every Type-level
query groups by `(category_id, type_id)` together, never by `type_id`/
`type_name` alone — two Types sharing a name under different Categories
(this project's seed data includes a "Pedal" subtype under both "Amps" and
"Pedals") are always reported as independent rows.

**Confidence — based on the realized sample, not the whole group.** Unlike
the Channel Analytics modules (sections 15-18), which tier `confidence`
from a row's TOTAL item count, every grouped section here tiers
`confidence` from that row's own REALIZED item count. Same 4-tier
thresholds as everywhere else (1-2 insufficient, 3-5 low, 6-9 moderate,
10+ stronger) — this module simply chooses a different sample to tier on,
because its conclusions (profit/ROI/DOM) are about realized outcomes and an
open-item-heavy row should not read as falsely well-evidenced.

**Interpretation safeguards** (documented in the SQL file header, not new
fields):
- Category and Type results are DESCRIPTIVE, not causal.
- A Type with a tiny sample must never outweigh a Category-level row with
  a stronger sample — always report `confidence` alongside any number.
- Acquisition Value Band results here can still be affected by acquisition
  method and brand mix within a Category/Type — not isolated by this file.
- "Missing Type" is a data-quality group, not a real Type (see above).

**Scope.** Shared Business aggregates only, same evidence/recommendation
boundary as every other module (section 9-11) — no `user_id`, `item_id`,
item name, or model appears anywhere in this module's output, and no
per-user Category/Type breakdown exists. `recommendation_candidates` are
unchanged and remain restricted to `recommendation_target_user_id`.

## 20. Capital & Liquidity

Governs `analytics/sql/09_capital_liquidity.sql` and
`public._build_capital_liquidity_snapshot_v1()`
(`supabase/migrations/20260807000000_build_analytics_snapshot_v1_7.sql`).
This module reports acquisition CAPITAL — value assigned to inventory via
`acquisition_value` — never a user's `cash_flow` ledger/cash-balance, which
is a wholly separate subsystem and is not read anywhere in this module.

**Population.** Business items only (`purpose_name = 'Business'`).
`capital_position_summary` (Query A) reports on the FULL population (open +
realized). `open_capital_age_buckets`/`open_capital_by_acquisition_value_
band`/`open_capital_by_acquisition_method` (Query B/C/D) narrow to OPEN
(`NOT is_realized`) items — capital currently tied up, not yet returned.
`realized_capital_efficiency_by_acquisition_value_band`/`_by_acquisition_
method` (Query E/F) narrow to REALIZED items with `acquisition_value_status
= 'positive'` — capital efficiency is undefined for a zero/unknown
acquisition value.

**Acquisition-value rules** (v1.1 semantics, reused unchanged): positive
values contribute to every acquisition-capital SUM; zero-assigned values
remain visible in every coverage count but contribute exactly $0 (never
excluded, never NULL-ing the whole SUM); unknown values remain visible in
coverage but are excluded from capital SUMs by ordinary NULL propagation —
never treated as $0 (that would understate real capital exposure).

**Historical imports — value-based yes, time-based no.** Included in
acquisition capital, realized profit, ROI, values, listing state, and
estimated upside. EXCLUDED from every acquisition-date-dependent metric:
ownership age, holding days, profit-per-30-holding-days, and any other
time-normalized capital-efficiency figure — same rule as sections 1-4,
applied here to capital instead of profit/DOM.

**Open capital age buckets are mutually exclusive.** Every open Business
item lands in EXACTLY ONE of: `0-29 days` / `30-59 days` / `60-119 days` /
`120+ days` (using `holding_days`, only when NOT a historical import,
`holding_days IS NOT NULL`, and `NOT has_lifecycle_date_issue`), OR
`unreliable/unknown age` — the explicit "cannot trust or do not have this
item's age" group, not a 5th calendar bucket. Historical imports always
land here, never in a calendar bucket.

**Capital percentage denominator.** Every `*_capital_percent` field in
Query B/C/D divides by the SAME denominator — total open acquisition
capital across ALL open Business items (`capital_position_summary`'s
`open_acquisition_capital`) — effectively positive open capital, since a
zero-assigned item contributes $0 to the sum either way.

**`profit_to_acquisition_capital_percent` vs. `median_roi` — never the
same number.** The former is an AGGREGATE descriptive ratio
(`SUM(net_profit) / SUM(acquisition_value) * 100` across the whole group);
the latter is the MEDIAN of each item's own ROI. They answer different
questions and must never be substituted for one another — see the SQL
file header for the full rationale.

**`median_net_profit_per_30_holding_days` — item-level first.** Computed
by deriving, PER ITEM, `net_profit / holding_days * 30` (realized,
non-historical, `holding_days > 0`, no lifecycle date issue — never
divides by zero), and ONLY THEN taking the median across the group. Never
computed as a group-level ratio of medians.
`time_efficiency_sample_size` is always reported alongside it.

**Interpretation safeguards** (documented in the SQL file header, not new
fields): open acquisition capital is capital assigned to inventory, NOT
current market value; estimated upside is a manual guess, not guaranteed
profit; old inventory is not automatically bad inventory; acquisition
method and value-band capital results can be confounded by Category,
Brand, and item mix; a zero-assigned acquisition value never produces an
infinite or undefined ratio (every division uses `NULLIF(..., 0)`).

**Scope.** Shared Business aggregates only, same evidence/recommendation
boundary as every other module (section 9-11) — no `user_id`, `item_id`,
item name, or model appears anywhere in this module's output, and no
per-user capital breakdown exists. `recommendation_candidates` are
unchanged and remain restricted to `recommendation_target_user_id`.

## 21. Open Inventory Decision Support v1

Governs `analytics/sql/10_open_inventory_decision_support.sql` and
`public._build_open_inventory_decision_support_snapshot_v1(int)`
(`supabase/migrations/20260808000000_build_analytics_snapshot_v1_8.sql`).
This module provides transparent, ITEM-LEVEL evidence for the CALLING
user's own open Business inventory, meant to help a later Business Coach —
never this module itself — answer which open items deserve attention.

**This module never produces an opaque score or a final action.** No
`score`, `priority_score`, `recommended_action`, sell/keep/reprice
decision, or AI-generated prose exists anywhere here. `reason_codes` is a
deterministic array of independent evidence FLAGS — never counted,
weighted, or combined into a single number. One item may legitimately
trigger several related reason codes without that meaning "multiple
independent pieces of evidence agree" — it means multiple separate, true
facts are being surfaced together.

**A new top-level section, not `evidence_aggregates`.** This is the first
module to expose item-level identity (item_id, brand, category, type,
model) in a snapshot, via a NEW top-level key —
`target_user_evidence.open_inventory_decision_support` — sibling to
`evidence_aggregates` (shared, never item-level) and
`recommendation_candidates` (target-user-only, fixed narrow shape). This is
safe ONLY because every row is filtered to the calling user's own
`user_id`, identically to `_build_recommendation_candidates_snapshot_v1_1`'s
own filter. Comparable-cohort STATISTICS may pool every user's Business
items (the same shared population every other module reads), but no other
user's item identity is ever exposed.

**Model field decision.** `inventory_items.model` is free text with no
normalization table — two items could be the "same model" under different
spelling/capitalization/abbreviation with no reliable way to detect that.
This module therefore SKIPS the "exact model" comparable-cohort level
entirely (the hierarchy starts at "brand + type + acquisition value band")
and documents this via the `MODEL_COHORT_UNAVAILABLE` limitation code on
every item row. `model` is still exposed as a plain DISPLAY field (a real,
existing column), just never used as an equality-matching cohort key.

**Listing-state limitation.** `item_listings` has no active/unlisted state
(section 18). For an open item, "listed" means "has at least one eligible
`item_listings` record" — never a true "still actively promoted" signal.
Every item row carries `listing_state_basis =
"open_item_with_listing_record"`; the module carries a `module_limitations`
entry documenting this. No listing-schema change is made or implied.

**Population.** Target items: the calling user's own OPEN (`NOT
is_realized`) Business items, listed and unlisted. Comparable cohorts: the
shared Business population across every user — open AND realized items
contribute to a cohort's item/realization-rate counts; ONLY realized items
contribute to profit/ROI/DOM/holding metrics. Historical imports: included
in profit, ROI, realization, DOM, category, type, brand, value-band, and
acquisition-method evidence; excluded from ownership-age and holding-time
evidence (sections 1-4's rule, unchanged).

**Comparable-cohort specificity hierarchy.** For each target item, up to 7
candidate cohorts are computed (skipping the model level — see above):
2. brand + type + acquisition value band (positive acquisition value only)
3. brand + acquisition value band (positive only)
4. brand (unrestricted)
5. category + acquisition value band (positive only)
6. category (unrestricted)
7. acquisition value band (positive only)
8. all Business items (unrestricted)

Band-restricted levels never apply to a zero-assigned/unknown/negative
item, matching every band section elsewhere in this analytics layer.
Selection rule (broader moderate-confidence evidence is preferred over an
unusably small exact match): search the hierarchy (specificity order) for
the first cohort with `realized_item_count >= 5`; if none, search again
for `>= 3`; if none, use the most specific cohort with `>= 1`; if none at
all, no cohort (`comparable_evidence_available = false`). A cohort's own
`confidence` label is computed from its OWN `realized_item_count` using
the standard 4-tier thresholds (1-2 insufficient, 3-5 low, 6-9 moderate,
10+ stronger) — independent of which hierarchy pass located it.

**Reason codes** (v1, exhaustive): `UNLISTED_OPEN_ITEM`,
`DOM_ABOVE_COMPARABLE_MEDIAN`, `DOM_ABOVE_COMPARABLE_P75`,
`OWNERSHIP_AGE_120_PLUS`, `HIGH_CAPITAL_EXPOSURE` (positive value AND
(top-3-by-value OR >=10% of the user's positive open capital)),
`LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL` (positive value, estimate
available, non-negative upside, upside % < 15), `NEGATIVE_ESTIMATED_UPSIDE`,
`LOW_COMPARABLE_CONFIDENCE`, `NO_COMPARABLE_EVIDENCE`,
`HISTORICAL_AGE_UNRELIABLE`, `ZERO_ASSIGNED_ACQUISITION_VALUE`,
`UNKNOWN_ACQUISITION_VALUE`, `ESTIMATED_VALUE_MISSING`. None of these are
counted into a score.

**Ordering** is fully transparent: (1) positive acquisition value
descending, (2) reliable ownership age descending, (3) `item_id` — never a
hidden ranking formula.

**Interpretation safeguards**: reason codes are evidence flags, not
recommendations; high capital does not automatically mean a bad item;
estimated upside is based on a user-entered estimate; cohort performance is
descriptive, not causal; broader fallback cohorts are less specific;
historical imports may have reliable profit/DOM but unreliable ownership
age; listing state is inferred from records and open status; missing
Marketplace/Kijiji history may understate historical cross-listing.

**Scope.** `item_decision_evidence` and `within_brand_comparison` contain
ONLY the calling user's own items — no other user's `item_id`, item name,
model, or identity is ever exposed. `recommendation_candidates` is
unchanged and remains restricted to `recommendation_target_user_id`.

## 22. Purpose-Aware Analytics Foundation (documentation only — no snapshot builder, runner, or UI change in this step)

Lays the ground for Purpose-aware analytics (v2.0+) without wiring it into
anything yet. `analytics_purpose_policy`
(`20260809000000_analytics_purpose_policy.sql`) and
`analytics_item_lifecycle_v2`
(`20260810000000_analytics_item_lifecycle_v2.sql`) exist and are readable,
but no snapshot builder, `runAnalytics.ts`, `recommendation_candidates`,
Open Inventory Decision Support, Calendar analytics, or UI reads from them
as of this step. Sections 1-21 above, and every existing snapshot version
`v1.0`-`v1.8`, are entirely unaffected.

**Purpose controls disposition and urgency, never economic eligibility.**
`item_purposes` (`Business` / `Hybrid` / `Personal`) already gates which
items are *eligible* for Business analytics at all (section 4, section 9).
`analytics_purpose_policy` does not change or duplicate that gate — it
governs how a Purpose-aware module should *interpret* an already-eligible
item: how urgently it should be realized (`disposition_mode`,
`realization_priority_order`), whether active realization is expected at
all (`active_realization_flag`), and how holding time should be read
(`expected_holding_policy`, a descriptive label, not a day-count
threshold). A Business item under this policy is exactly as eligible for
every existing metric as it always was; the policy only informs how a
future module might prioritize or narrate it.

**Profit, ROI, acquisition/exit values, and every other economic fact are
computed identically regardless of Purpose.** Nothing in
`analytics_purpose_policy` or `analytics_item_lifecycle_v2` filters,
reweights, or excludes an item's financial figures by Purpose — those
formulas (sections 1-8) are Purpose-blind and remain so.

**Purpose is currently mutable, with no historical record.** An item's
`purpose_id` can change at any time via the app's own item-editing UI, and
no table anywhere records what an item's Purpose was at any past date.
`current_purpose_id`/`current_purpose_name` on `analytics_item_lifecycle_v2`
are named with the `current_` prefix specifically to flag this: they
describe the item's Purpose *right now*, not at acquisition or at any
other point in its lifecycle. Any future analysis that assumes Purpose was
constant over an item's holding period is not supported by this schema.

**`v1.0`-`v1.8` remain Business-only and are unaffected.** Every snapshot
builder through `v1.8` continues to read `analytics_item_lifecycle` (v1),
continues to scope evidence and recommendations to `purpose_name =
'Business'` exactly as before (section 9), and is not modified by this
step. `analytics_purpose_policy` and `analytics_item_lifecycle_v2` are new,
additive, currently-unconsumed objects alongside them.

**Purpose-aware analytics begins at `v2.0`.** Any future module that reads
Hybrid or Personal items, or varies its interpretation by
`disposition_mode`/`realization_priority_order`/`active_realization_flag`/
`expected_holding_policy`, is a `v2.0+` concern and must be introduced as
its own versioned step — this step deliberately stops short of that,
including deliberately not redefining `EVIDENCE_SCOPE` (section 9) to admit
Hybrid/Personal items.

**`analytics_item_lifecycle_v2` is the foundation for `v2` modules.** It is
a strict superset of `analytics_item_lifecycle` — every existing column
unchanged, every row still present regardless of Purpose or policy state
(`purpose_policy_status`: `mapped` / `missing_purpose` / `missing_policy`,
never used to drop a row) — intended as the read surface a future `v2`
snapshot builder would query instead of `analytics_item_lifecycle`
directly. It is not itself a snapshot builder and produces no aggregate or
recommendation output on its own.

## 23. Analytics v2.0 Snapshot Foundation and Purpose Overview

`public.build_analytics_snapshot_v2_0(p_target_user_id int)`
(`supabase/migrations/20260811000000_build_analytics_snapshot_v2_0.sql`) is
the **first Purpose-aware snapshot contract** in this analytics layer. It
is a clean, independent builder — it does NOT call, embed, or extend
`build_analytics_snapshot_v1_8` (or any v1.x builder), and does not include
`evidence_aggregates`, `recommendation_candidates`, or Open Inventory
Decision Support. `v1.0`-`v1.8` are completely unaffected and remain
independently callable; every previously stored `analytics_runs.snapshot`
row is untouched.

**v1.x remains Business-only; v2.0 reads every Purpose.** Every v1.x
builder narrows to `purpose_name = 'Business'` (section 9 — `EVIDENCE_SCOPE`
is NOT redefined by this section). `build_analytics_snapshot_v2_0` instead
reads the full `analytics_item_lifecycle_v2` population: Business, Hybrid,
Personal, items with no Purpose assigned (`missing_purpose`), and items
whose Purpose has no `analytics_purpose_policy` row yet (`missing_policy`).
Economic eligibility — whether an item's profit, ROI, capital, and DOM are
computed at all — is identical for every Purpose; Purpose is never a
filter here.

**Purpose in v2 means CURRENT disposition, not historical Purpose.**
`current_purpose_id`/`current_purpose_name` (and every grouping in this
section) reflect an item's Purpose right now. Purpose is mutable and this
schema keeps no historical record — an item's entire lifecycle (including
profit realized in the past) is attributed to whatever Purpose it holds
today. See `module_limitations` below and section 22.

**Top-level shape:**

```
{
  "snapshot_schema_version": "2.0",
  "analytics_definition_version": "2.0",
  "generated_at": "...",
  "evidence_scope": "shared_inventory_population",
  "purpose_semantics": "current_item_purpose",
  "shared_purpose_evidence": { "population_summary": [...], "purpose_breakdown": [...] },
  "target_user_purpose_evidence": { "position_summary": [...], "purpose_position_breakdown": [...] },
  "module_limitations": [
    "CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE",
    "PURPOSE_CHANGES_ARE_NOT_HISTORICALLY_TRACKED",
    "LISTING_ACTIVE_STATE_INFERRED_NO_IS_ACTIVE_FIELD"
  ]
}
```

**`shared_purpose_evidence`** pools aggregate statistics across every
user — no item identity, no per-user grouping. `population_summary` is one
row reconciling total/open/realized, listed/unlisted, mapped/missing-
purpose/missing-policy, and positive/zero-assigned/unknown acquisition
value, all against `total_item_count`. `purpose_breakdown` has one row per
mapped Purpose (Business/Hybrid/Personal — distinguished by their
`disposition_mode`/`realization_priority_order`/`active_realization_flag`/
`expected_holding_policy`, which never collapse together) plus exactly one
explicit `missing_purpose` coverage row and one explicit `missing_policy`
coverage row (current_purpose_id/name NULLed before grouping, so multiple
different unmapped Purpose names still collapse into a single
`missing_policy` row — never merged into a mapped Purpose, "unknown," or
an acquisition-method bucket).

**`target_user_purpose_evidence`** is filtered to `p_target_user_id` only
— another user's items may affect pooled shared statistics but can never
be isolated from this section. Like `shared_purpose_evidence`, it exposes
aggregates only: no individual item row exists anywhere in this module
(contrast with Open Inventory Decision Support's `item_decision_evidence`,
which this module does not touch or include).

**Metric rules (unchanged from every prior module):** profit and ROI use
realized items only; ROI additionally requires a positive acquisition
value; DOM uses realized items with a reliable `global_days_on_market`;
holding-time metrics (holding days, open ownership age) exclude Historical
Imports and lifecycle-date issues, per the standing reliable-date rule
(sections 1-4).

**Production runner remains on v1.8 temporarily.** `runAnalytics.ts` is not
updated by this section — production analytics runs continue to call
`build_analytics_snapshot_v1_8` until the v2 evidence modules are
sufficiently complete. `build_analytics_snapshot_v2_0` is reachable only
directly (service_role, e.g. a manual test script), not through the
autorunner or any UI.

**Out of scope for this section:** Calendar & Seasonality, the Findings
Selector, Business Coach, recommendations, scores, and any UI redesign —
all deferred, per the task's explicit scope.

## 24. Open Inventory Decision Support v2.1

`public.build_analytics_snapshot_v2_1(p_target_user_id int)`
(`supabase/migrations/20260812000000_build_analytics_snapshot_v2_1.sql`)
calls `build_analytics_snapshot_v2_0` wholesale (preserving
`shared_purpose_evidence`/`target_user_purpose_evidence` unchanged) and
adds `target_user_open_inventory_evidence`: item-level Purpose-aware
evidence for every OPEN item of one target user, across Business, Hybrid,
Personal, missing-purpose, and missing-policy. Does not call, embed, or
replace any v1.x builder; `v1.0`-`v1.8` and `v2.0` are unaffected;
`runAnalytics.ts` still calls `v1.8` for production runs.

**Two cohort objects, not one.** `economic_cohort` (median profit/ROI/
realization rate) pools every Purpose — economic eligibility is shared
regardless of Purpose. `liquidity_cohort` (DOM/holding time) prefers the
item's own current Purpose first, falling back to a cross-purpose cohort
only when no purpose-matched cohort clears the standard confidence bar
(`liquidity_cohort_match`: `purpose_matched` / `cross_purpose_fallback` /
`unavailable`; a fallback adds `PURPOSE_MATCHED_LIQUIDITY_COHORT_
UNAVAILABLE`). Both use the same selection rule as every prior cohort in
this analytics layer.

**Purpose-aware urgency, not a universal "Hybrid is risky" rule.**
Business gets DOM (`>= 30` days) and ownership-age (`120+` reliable days)
urgency codes; Hybrid gets neutral `HYBRID_*` review signals only
(`HYBRID_REVIEW_REQUIRED` is unconditional — never a realization
recommendation); Personal gets no DOM/age urgency code at all
(`PERSONAL_AGE_UNRELIABLE` is a data-completeness flag, not urgency) and
instead surfaces capital concentration, missing estimates, and a neutral
listed-for-opportunistic-exit note. `hybrid_purpose_review` exposes
descriptive `behavioral_signals` (e.g. `LISTED_ACTIVE_REALIZATION_
SIGNAL`, `LONG_HOLD_SIGNAL`) for the user's own stated goal of resolving
Hybrid ambiguity over time — it never outputs `reclassify_to_business`,
`reclassify_to_personal`, `keep_hybrid`, or `recommended_purpose`, and
this module never writes to `inventory_items.purpose_id`.

**No score, no recommended action, anywhere.** `reason_codes` /
`behavioral_signals` / `control_reason_codes` are deterministic,
independent evidence flags — never counted, weighted, or combined.

**Manual inspection only, historically.** At the time this section was
written, `v2.1` was reachable only via a temporary manual-preview route
(`POST /api/analytics/v2-preview`) — not through the production runner.
As of section 25 (`v2.2`), that manual-preview route has been REMOVED and
`v2.2` (which wraps `v2.1` unchanged) is the production analytics
version. `v2.1` itself was never modified by that promotion — see section
25.

## 25. Hybrid reason-code correction (v2.2) and production promotion

`public.build_analytics_snapshot_v2_2(p_target_user_id int)`
(`supabase/migrations/20260813000000_build_analytics_snapshot_v2_2.sql`)
calls `build_analytics_snapshot_v2_1` wholesale and applies exactly ONE
deterministic correction to
`target_user_open_inventory_evidence.item_decision_evidence[*].reason_
codes`: every occurrence of `HYBRID_RECENT_INSUFFICIENT_HISTORY` is
replaced with exactly one of `HYBRID_RECENT_ITEM` or `HYBRID_
INSUFFICIENT_OWNERSHIP_HISTORY`, chosen from that same row's own
`ownership_age_days` — no new threshold, no recomputation. Nothing else
changes: every count, capital value, cohort, other reason code,
`behavioral_signal`, limitation, and item ordering is identical to
`v2.1`.

**Why:** `v2.1` conflated two different situations under one code — a
genuinely recent item (reliable age under 30 days) and an item whose age
is unavailable (historical import or otherwise unreliable). In
production this meant historical items with DOM values of 100-400+ days
carried a code containing the word "RECENT." `hybrid_purpose_review.
behavioral_signals` already distinguished these correctly
(`RECENT_ITEM_SIGNAL` / `INSUFFICIENT_HISTORY_SIGNAL`); `v2.2` gives
`item_decision_evidence.reason_codes` the same distinction, using the
identical condition each signal already used. The two new codes are
mutually exclusive (`ownership_age_days IS NULL` vs. reliable-and-under-
30) and together exactly reconstruct `v2.1`'s original combined
condition — no item gains or loses a flag, only the code name changes.

**`v2.1` is unchanged.** `_build_open_inventory_decision_support_
snapshot_v2` and `build_analytics_snapshot_v2_1` were not modified.
Previously stored `v2.1` snapshots remain historically interpretable
exactly as generated; a fresh `v2.1` call still produces the old,
ambiguous combined code, unchanged.

**`v2.2` was the production analytics version at this step.**
`runAnalytics.ts` called `build_analytics_snapshot_v2_2` for every new
run. `v1.0`-`v1.8`, `v2.0`, and `v2.1` remained independently callable
and every previously stored `analytics_runs.snapshot` row (whichever
version it was created under) remains readable — this is a forward
version bump, not a rewrite of history. The temporary manual-preview
route and UI card introduced alongside `v2.1` were removed once the
production runner itself served the same evidence. As of section 26
(`v2.3`), the production runner has been promoted again, off `v2.2` and
onto `v2.3` — `v2.2` itself is unaffected.

## 26. Acquisition Economics (v2.3) and second production promotion

`public.build_analytics_snapshot_v2_3(p_target_user_id int)`
(`supabase/migrations/20260814000000_build_analytics_snapshot_v2_3.sql`)
calls `build_analytics_snapshot_v2_2` wholesale and adds two new
top-level sections, `shared_acquisition_evidence` and `target_user_
acquisition_evidence`, each containing `acquisition_value_band_
performance` and `acquisition_to_exit_analysis` — Purpose-aware v2 ports
of the v1.1 `_build_acquisition_value_band_snapshot_v1_1` and
`_build_acquisition_to_exit_snapshot_v1_1` helpers (see analytics/sql/01
and analytics/sql/02, and their v2 ports analytics/sql/14 and
analytics/sql/15). Every prior v2.2 section (`shared_purpose_evidence`,
`target_user_purpose_evidence`, `target_user_open_inventory_evidence`,
`module_limitations`) is preserved unchanged; `v2.2` itself, and every
`v1.x`/`v2.0`/`v2.1` builder, are untouched and remain independently
callable.

**Every Purpose, not Business-only.** Like every prior v2 module, the
population is `analytics_item_lifecycle_v2`'s full population —
Business, Hybrid, Personal, `missing_purpose`, `missing_policy` — never
filtered by Purpose. Every section is produced twice: pooled across all
Purposes, and broken down by `(current_purpose_id, current_purpose_name,
purpose_policy_status)` using the same missing-purpose/missing-policy
collapsing rule established in section 22. Purpose is the item's CURRENT
disposition only — it is never an economic eligibility filter here, and
a Hybrid/Personal row's `realization_rate_percent` is descriptive only,
never an urgency signal, recommendation, score, or AI prose.

**Scope decision — a deliberate subset of each v1 module.** Both v1.1
snapshot helpers are large (12-16 sections each: population coverage,
banded performance, zero/unknown-value summaries, equal-size quartiles,
capital-efficiency sensitivity, open-inventory-by-band, category
cross-cuts, and cohort/method/outlier/integrity diagnostics). `v2.3`
ports the PRIMARY, load-bearing sections of each and deliberately omits
secondary robustness/diagnostic sections — consistent with the
precedent v1.1 itself set by excluding its own developer-only
per-user/item-level drilldowns from the snapshot. Ported, with field
names, band boundaries, exclusion rules, and confidence tiers copied
verbatim from the v1.1 source: population coverage, banded performance
(positive acquisition value only), zero-assigned summary, and
unknown-acquisition summary for Value Band Performance; population
coverage, banded performance, the acquisition-to-exit-band transition
matrix, and acquisition/exit method paths for Acquisition-to-Exit
Analysis. See the migration file's own header for the full list of
omitted sections and rationale.

**Semantics preserved from v1.** Purchase price and assigned incoming
trade value are acquisition value (never called "purchase price"
unconditionally). Historical Imports participate fully in acquisition
value, exit value, profit, ROI, transition counts, and DOM
(`global_days_on_market`) — they are excluded ONLY from `holding_days`-
based duration metrics, same as every prior module (sections 1-4). Rows
with `has_lifecycle_date_issue` are excluded from the same holding-based
metrics regardless of Purpose. ROI requires a positive acquisition
value. Zero-assigned and unknown acquisition values remain visible in
coverage counts but are excluded from positive-value-band performance
rows and ROI. Additive totals return 0 for an empty group; medians,
percentiles, ROI, and durations remain `NULL` when no valid sample
exists.

**`v2.3` was the production analytics version at this step.** `runAnalytics.ts`
called `build_analytics_snapshot_v2_3` for every new run (`ANALYTICS_
VERSION = '2.3'`). `v1.0`-`v1.8` and `v2.0`-`v2.2` remained independently
callable and every previously stored `analytics_runs.snapshot` row
remained readable — a forward version bump, not a rewrite of history. The
Analytics page's "Shared Acquisition Evidence" and "Target User
Acquisition Evidence" collapsible sections use the same JSON/Copy JSON
pattern as every prior section. See section 27 for the next production
promotion.

## 27. Inventory Segmentation (v2.4) and third production promotion

`public.build_analytics_snapshot_v2_4(p_target_user_id int)`
(`supabase/migrations/20260815000000_build_analytics_snapshot_v2_4.sql`)
calls `build_analytics_snapshot_v2_3` wholesale and adds two new
top-level sections, `shared_inventory_segmentation_evidence` and
`target_user_inventory_segmentation_evidence`, each containing
`brand_performance` and `category_type_performance` — Purpose-aware v2
ports of `03_brand_performance.sql` and `08_category_type_performance.sql`
(see their v2 ports `analytics/sql/16` and `analytics/sql/17`). Every
prior v2.3 section (`shared_purpose_evidence`, `target_user_purpose_
evidence`, `target_user_open_inventory_evidence`, `shared_acquisition_
evidence`, `target_user_acquisition_evidence`, `module_limitations`) is
preserved unchanged; `v2.3` itself, and every `v1.x`/`v2.0`-`v2.2`
builder, are untouched and remain independently callable.

**Every Purpose, not Business-only.** Same rule as every prior v2
module: the population is `analytics_item_lifecycle_v2`'s full
population — Business, Hybrid, Personal, `missing_purpose`,
`missing_policy` — never filtered by Purpose. Every section is produced
twice: pooled across all Purposes, and broken down by
`(current_purpose_id, current_purpose_name, purpose_policy_status)`
using the same missing-purpose/missing-policy collapsing rule
established in section 22. A Hybrid/Personal row's
`realization_rate_percent` remains descriptive only.

**Scope decision — production evidence preserved, diagnostics
omitted.** Every v1 section was classified as PRODUCTION EVIDENCE or
DEVELOPER DIAGNOSTIC/AUDIT before porting (see each source file's own
"QUERY CLASSIFICATION INDEX"). `08_category_type_performance.sql` self-
classifies all six of its queries as production evidence, so all six
are ported in full: `population_summary`, `performance_by_category`,
`performance_by_category_type`, `performance_by_category_and_
acquisition_band`, `performance_by_category_type_and_acquisition_band`,
`open_inventory_by_category_type`. `03_brand_performance.sql` has 13
queries; five non-redundant cuts are ported (`population_summary`,
`performance_by_brand` with the "decision-ready" filter folded into a
`decision_ready` boolean instead of a duplicate query,
`performance_by_brand_and_acquisition_band` likewise,
`open_inventory_by_brand` merging the listed/unlisted queries via a
`listing_status` dimension, and `capital_concentration_by_brand`).
Omitted, each with its classification: the brand coverage-distribution
histogram (production evidence, but redundant with per-brand
`sample_size`), the brands lookup-table data-quality audit
(reclassified as a developer/data-hygiene diagnostic — it audits the
shared `brands` table itself, not Purpose-scoped economic evidence),
brand x acquisition method (production evidence, secondary to the two
headline cuts ported), the historical-vs-app-tracked cohort comparison
(superseded by the `historical_item_count`/`non_historical_item_count`
fields present on every ported section), and the per-user/item-level
drilldowns (developer-only diagnostics that would also violate the
no-cross-user-identity-exposure rule if ported to shared evidence). See
the migration file's own header for the complete list and rationale.

**Semantics preserved from v1.** Historical Imports participate fully
in acquisition value, exit value, profit, ROI, brand, category, and
type evidence — excluded ONLY from `holding_days`-based duration
metrics, same as every prior module. ROI requires a positive acquisition
value. Zero-assigned and unknown acquisition values remain visible in
coverage but excluded from positive-value-band performance rows and
ROI. Missing brand (`brand_name` NULL/blank) groups under "Unknown
brand"; missing category/type (`category_id`/`type_id` NULL) are never
dropped — GROUP BY keeps the NULL group visible; two Types sharing a
name under different Categories are never merged. Additive totals
return 0 for an empty group; medians, percentiles, ROI, and durations
remain `NULL` when no valid sample exists. Brand-level confidence uses
the dual sample/realized tiering from `03_brand_performance.sql`;
Category/Type confidence uses the single realized-item-count tiering
from `08_category_type_performance.sql` (unchanged from each source
file's own convention).

**`v2.4` was the production analytics version at this step.** `runAnalytics.ts`
called `build_analytics_snapshot_v2_4` for every new run (`ANALYTICS_
VERSION = '2.4'`). `v1.0`-`v1.8` and `v2.0`-`v2.3` remained independently
callable and every previously stored `analytics_runs.snapshot` row
remained readable — a forward version bump, not a rewrite of history. The
Analytics page's "Shared Inventory Segmentation Evidence" and "Target
User Inventory Segmentation Evidence" collapsible sections use the same
JSON/Copy JSON pattern as every prior section. See section 28 for the
next production promotion.

## 28. Deal Channel Performance (v2.5) and fourth production promotion

`public.build_analytics_snapshot_v2_5(p_target_user_id int)`
(`supabase/migrations/20260816000000_build_analytics_snapshot_v2_5.sql`)
calls `build_analytics_snapshot_v2_4` wholesale and adds two new
top-level sections, `shared_deal_channel_evidence` and `target_user_
deal_channel_evidence`, each containing `deal_in_channel_performance`,
`deal_out_channel_performance`, and `channel_journey` — Purpose-aware v2
ports of `04_deal_in_channel_performance.sql`, `05_deal_out_channel_
performance.sql`, and `06_channel_journey.sql` (see their v2 ports
`analytics/sql/18`, `analytics/sql/19`, `analytics/sql/20`). Every prior
v2.4 section (`shared_purpose_evidence`, `target_user_purpose_evidence`,
`target_user_open_inventory_evidence`, `shared_acquisition_evidence`,
`target_user_acquisition_evidence`, `shared_inventory_segmentation_
evidence`, `target_user_inventory_segmentation_evidence`, `module_
limitations`) is preserved unchanged; `v2.4` itself, and every
`v1.x`/`v2.0`-`v2.3` builder, are untouched and remain independently
callable.

**Every Purpose, not Business-only.** Same rule as every prior v2
module: the population is `analytics_item_lifecycle_v2`'s full
population — Business, Hybrid, Personal, `missing_purpose`,
`missing_policy` — never filtered by Purpose, and Purpose is never
presented as Purpose at acquisition or Purpose at exit (it has no
historical record). Every section is produced twice: pooled across all
Purposes, and broken down by `(current_purpose_id, current_purpose_
name, purpose_policy_status)` using the same missing-purpose/missing-
policy collapsing rule established in section 22.

**Scope decision — all three v1 files ported in full.** `04_deal_in_
channel_performance.sql` (5 queries), `05_deal_out_channel_performance.
sql` (6 queries), and `06_channel_journey.sql` (5 queries) each
self-classify EVERY one of their queries as shared aggregate evidence in
their own "QUERY CLASSIFICATION INDEX" — none are developer-only
diagnostics, unlike `03_brand_performance.sql`'s Query G/H. All 16
queries are therefore ported in full — see the migration file's own
header for the complete section-by-section mapping. Listing-Channel
data is explicitly NOT read anywhere in this module — Deal In/Out
Channel and Channel Journey remain distinct from Listing Channel
Exposure (a separate v1.5 module, not touched here).

**Channel semantics preserved from v1.** Deal In Channel is where
contact ORIGINATED for the operation an item ENTERED inventory through;
Deal Out Channel is where it LEFT — never a payment method or shipping
method (a Reverb contact followed by an off-platform payment remains
Reverb). For a Trade, one `deal_channel_id` applies to both the incoming
and outgoing item(s) — never split into two. Regular Buyer / Seller is
reported like any other channel. Missing Deal In/Out Channel is a real,
visible state, never silently dropped or backfilled. Cash sale and trade
exit paths are never conflated: `exit_value` is a "sale price" only in
cash-sale-scoped sections and an "assigned trade exit value" only in
trade-exit-scoped sections. Channel Journey's `journey_eligible`
population requires BOTH channels known; "same channel"
(`deal_in_channel_id = deal_out_channel_id`) remains descriptive path
evidence only, never a conversion rate.

**Semantics preserved from v1.** Deal In Channel's population is every
item (open + realized); Deal Out Channel and Channel Journey are
realized items only, unchanged from v1. Historical Imports participate
fully wherever a Deal In or Deal Out channel is available; excluded
ONLY from `holding_days`-based duration metrics. ROI requires a positive
acquisition value; acquisition value bands restrict to `acquisition_
value_status = 'positive'`, with zero-assigned/unknown coverage reported
separately. `item_count` and `distinct_deal_count` remain semantically
distinct throughout. Confidence is tiered from the row's own item count
(1-2 insufficient, 3-5 low, 6-9 moderate, 10+ stronger) — the
single-tier convention `04`/`05`/`06` already use, not Brand
Performance's dual sample/realized tiering.

**`v2.5` was the production analytics version at this step.** `runAnalytics.ts`
called `build_analytics_snapshot_v2_5` for every new run (`ANALYTICS_
VERSION = '2.5'`). `v1.0`-`v1.8` and `v2.0`-`v2.4` remained independently
callable and every previously stored `analytics_runs.snapshot` row
remained readable — a forward version bump, not a rewrite of history. The
Analytics page's "Shared Deal Channel Evidence" and "Target User Deal
Channel Evidence" collapsible sections use the same JSON/Copy JSON
pattern as every prior section. See section 29 for the next production
promotion.

## 29. Listing Channel Exposure (v2.6) and fifth production promotion

`public.build_analytics_snapshot_v2_6(p_target_user_id int)`
(`supabase/migrations/20260817000000_build_analytics_snapshot_v2_6.sql`)
calls `build_analytics_snapshot_v2_5` wholesale and adds two new
top-level sections, `shared_listing_channel_evidence` and `target_user_
listing_channel_evidence`, each containing `population_summary`,
`performance_by_listing_channel`, `cross_listing_summary`, `listing_to_
deal_out`, `open_inventory_by_listing_channel`, and `open_unlisted_
summary` — a Purpose-aware v2 port of `07_listing_channel_exposure.sql`
(see its v2 port `analytics/sql/21_listing_channel_exposure_v2.sql`).
Every prior v2.5 section (`shared_purpose_evidence`, `target_user_
purpose_evidence`, `target_user_open_inventory_evidence`, `shared_
acquisition_evidence`, `target_user_acquisition_evidence`, `shared_
inventory_segmentation_evidence`, `target_user_inventory_segmentation_
evidence`, `shared_deal_channel_evidence`, `target_user_deal_channel_
evidence`, `module_limitations`) is preserved unchanged; `v2.5` itself,
and every `v1.x`/`v2.0`-`v2.4` builder, are untouched and remain
independently callable. Deal In Channel, Deal Out Channel, Channel
Journey, Capital & Liquidity, and Open Inventory Decision Support are
not touched by this migration.

**Every Purpose, not Business-only.** Same rule as every prior v2
module: the population is `analytics_item_lifecycle_v2`'s full
population — Business, Hybrid, Personal, `missing_purpose`,
`missing_policy` — never filtered by Purpose, and Purpose is never
presented as Purpose at listing time or Purpose at exit. Every section
is produced twice: pooled across all Purposes, and broken down by
`(current_purpose_id, current_purpose_name, purpose_policy_status)`
using the same missing-purpose/missing-policy collapsing rule
established in section 22.

**Scope decision — all six v1 queries ported in full.**
`07_listing_channel_exposure.sql`'s own "QUERY CLASSIFICATION INDEX"
self-classifies every one of its six queries as shared aggregate
evidence — none are developer-only diagnostics. All six are therefore
ported in full: `population_summary`, `performance_by_listing_channel`,
`cross_listing_summary` (a special shape — scalar fields alongside a
nested `buckets` array, not a plain array like every other section),
`listing_to_deal_out`, `open_inventory_by_listing_channel`, and `open_
unlisted_summary`.

**Listing-platform eligibility rule (reused verbatim from v1, no new
flag introduced).** An `item_listings` row is an eligible listing record
only if its `deal_channels.is_listing_platform = true` (the existing,
already-normalized flag distinguishing Marketplace/Kijiji/Reverb from
Regular Buyer/Seller, a relationship channel) AND `listed_at IS NOT
NULL`. Multiple `item_listings` rows for the same (item, channel) pair
collapse into ONE canonical exposure row — never double-counted.

**Cross-listing is non-mutually-exclusive.** One item may have canonical
exposure on more than one Listing Channel. `performance_by_listing_
channel`, `listing_to_deal_out`, and `open_inventory_by_listing_channel`
are EXPOSURE-LEVEL — a cross-listed item appears in multiple rows across
those sections, and their item counts must never be summed across
channels and compared to a unique item total. Only `population_summary`
and `cross_listing_summary` report unique item counts. A sale or profit
is never attributed exclusively to one listing platform when multiple
platforms exposed the same item.

**Limitation: no active/inactive listing-state column (reused verbatim
from v1).** `item_listings` has no active/current-state column —
publication is determined solely by `listed_at IS NOT NULL`. There is no
`unlisted_at`/`delisted_at`/`is_active` column anywhere in this schema.
CURRENT/ACTIVE listing exposure therefore means an OPEN item with at
least one eligible listing record — there is no way, with today's
schema, to distinguish "still actively listed" from "was listed once,
no longer promoted, but no delisting event was ever recorded." This
module never infers a confirmed sale from a listing merely disappearing
or becoming inactive.

**Semantics preserved from v1.** Historical Imports remain eligible for
listing/DOM evidence wherever a listing date is known — excluded ONLY
from holding/ownership-age metrics, same as every prior module. ROI
requires a positive acquisition value. Zero-assigned and unknown
acquisition values remain visible in coverage. "Same channel" (`listing_
channel_id = deal_out_channel_id`) remains descriptive exposure/path
evidence only, never a conversion rate. `listing_to_deal_out` is
explicitly NOT a mutually exclusive journey matrix.

**`v2.6` was the production analytics version at this step.** `runAnalytics.ts`
called `build_analytics_snapshot_v2_6` for every new run (`ANALYTICS_
VERSION = '2.6'`). `v1.0`-`v1.8` and `v2.0`-`v2.5` remained independently
callable and every previously stored `analytics_runs.snapshot` row
remained readable — a forward version bump, not a rewrite of history. The
Analytics page's "Shared Listing Channel Evidence" and "Target User
Listing Channel Evidence" collapsible sections use the same JSON/Copy
JSON pattern as every prior section. See section 30 for the next
production promotion.

## 30. Capital & Liquidity (v2.7) and sixth production promotion

`public.build_analytics_snapshot_v2_7(p_target_user_id int)`
(`supabase/migrations/20260818000000_build_analytics_snapshot_v2_7.sql`)
calls `build_analytics_snapshot_v2_6` wholesale and adds two new
top-level sections, `shared_capital_liquidity_evidence` and `target_
user_capital_liquidity_evidence`, each containing `population_summary`,
`open_capital_by_age_bucket`, `open_capital_by_acquisition_band`,
`open_capital_by_acquisition_method`, `realized_capital_efficiency_by_
acquisition_band`, and `realized_capital_efficiency_by_acquisition_
method` — a Purpose-aware v2 port of `09_capital_liquidity.sql` (see its
v2 port `analytics/sql/22_capital_liquidity_v2.sql`). Every prior v2.6
section is preserved unchanged; `v2.6` itself, and every `v1.x`/
`v2.0`-`v2.5` builder, are untouched and remain independently callable.
Open Inventory Decision Support, Listing Channel Exposure, and the Deal
Channel modules are not touched by this migration.

**Every Purpose, not Business-only, with Purpose treated as a current
disposition policy.** Same population rule as every prior v2 module —
Business, Hybrid, Personal, `missing_purpose`, `missing_policy`, never
filtered by Purpose. Purpose is a current disposition POLICY, not an
economic eligibility filter and not proven historical intent — never
presented as Purpose at acquisition, listing, or exit time. Every
section is produced twice: pooled across all Purposes, and broken down
by `(current_purpose_id, current_purpose_name, purpose_policy_status)`.

**Purpose-aware interpretation — neutral buckets, policy fields, no
universal urgency.** `09_capital_liquidity.sql`'s own bucket labels and
interpretation safeguards were reviewed for judgmental/urgency language
before porting: they were already neutral ("0-29 days" / "30-59 days" /
"60-119 days" / "120+ days" / "unreliable/unknown age" — no "stale",
"slow", or "trapped" label anywhere), and the file's own safeguard
already warned "Old inventory is NOT automatically bad inventory." Those
same neutral buckets and calculations are ported unchanged. The
`purpose_population_summary` rows additionally LEFT JOIN
`public.analytics_purpose_policy` — the ONLY source of Purpose-level
interpretive framing this module surfaces (`disposition_mode`,
`realization_priority_order`, `active_realization_flag`,
`expected_holding_policy`, `description`), `NULL` for `missing_purpose`/
`missing_policy` rows. No new judgmental label, score, or universal
"stale"/"trapped"/urgency interpretation is invented: Business's policy
row reads `'shorter_holding_preferred'`, Hybrid's `'extended_holding_
acceptable'`, Personal's `'long_holding_acceptable'` — pre-existing,
already-reviewed fields, not new rules this module invents. No
operator's personal inventory-reduction goal for any Purpose is encoded
as a universal application rule.

**Scope decision — all six v1 queries are production evidence, none
superseded by OIDS.** `09_capital_liquidity.sql`'s own "QUERY
CLASSIFICATION INDEX" self-classifies every one of its six queries as
shared aggregate evidence — none are developer-only diagnostics, and
none are superseded by Purpose-aware OIDS (OIDS reports item-level
decision evidence with reason codes for one target user; this module
reports only AGGREGATE capital/liquidity totals — genuinely different
scope, never duplicated here). All six are therefore ported in full:
`population_summary`, `open_capital_by_age_bucket`, `open_capital_by_
acquisition_band`, `open_capital_by_acquisition_method`, `realized_
capital_efficiency_by_acquisition_band`, `realized_capital_efficiency_
by_acquisition_method`.

**Capital and denominator semantics preserved from v1.** This module
reports CAPITAL (acquisition value assigned to inventory), never a
cash_flow/cash-balance ledger. Positive acquisition value contributes to
every capital total; zero-assigned remains visible and contributes
exactly $0; unknown (`NULL`) remains visible in coverage but is excluded
from SUMs by ordinary NULL propagation. Every `*_capital_percent` field
divides by the SAME denominator within its scope — pooled rows use the
scope-wide open-capital total; `_by_purpose` rows use that Purpose's own
open-capital total, so percentages sum to ~100% within their own scope.
`profit_to_acquisition_capital_percent` is an aggregate descriptive
ratio, never a substitute for `median_roi`. `median_net_profit_per_30_
holding_days` is computed PER ITEM FIRST, then medianed.

**Time and reliability semantics preserved from v1.** Historical Imports
are included in acquisition capital, realized profit, ROI, values,
listing state, and estimated upside; excluded ONLY from acquisition-
date-dependent metrics (ownership age, holding days, profit-per-30-
holding-days) — DOM is NOT excluded for historical imports. Open capital
age buckets are MUTUALLY EXCLUSIVE. Confidence is tiered from the row's
own item count, unchanged from 09's own convention. This module never
duplicates OIDS' item-level decision evidence — no item_id, item row,
reason code, or recommendation is produced anywhere here.

**`v2.7` was the production analytics version before `v2.8` (see section
31).** `v1.0`-`v1.8` and `v2.0`-`v2.6` remain independently callable and
every previously stored `analytics_runs.snapshot` row remains readable —
a forward version bump, not a rewrite of history. The Analytics page's
"Shared Capital & Liquidity Evidence" and "Target User Capital &
Liquidity Evidence" collapsible sections use the same JSON/Copy JSON
pattern as every prior section.

## 31. Calendar & Seasonality (v2.8) and seventh production promotion

`public.build_analytics_snapshot_v2_8(p_target_user_id int)`
(`supabase/migrations/20260819000000_build_analytics_snapshot_v2_8.sql`)
calls `build_analytics_snapshot_v2_7` wholesale and adds two new
top-level sections, `shared_calendar_seasonality_evidence` and `target_
user_calendar_seasonality_evidence` — a brand-NEW module, not a port of
any v1 file (see its manual reference, `analytics/sql/23_calendar_
seasonality_v2.sql`). Every prior v2.7 section is preserved unchanged;
`v2.7` itself, and every `v1.x`/`v2.0`-`v2.6` builder, are untouched and
remain independently callable.

**Scope — calendar activity, calendar trends, descriptive seasonality
only.** Explicitly excluded: Findings Selector, Pattern Discovery,
Business Coach, forecasting, recommendations, external market data. Every
section is DESCRIPTIVE — no "best month" claim, no buying/selling advice,
no urgency, no seasonality score, no forecast, no causal claim, no
item-level row, no AI-generated prose.

**Sources of truth — no parallel definitions.** Reads exclusively from
`public.analytics_item_lifecycle_v2` (`acquisition_date`, `first_listed_
at`, `exit_date`, `is_historical_import`, `has_lifecycle_date_issue`,
`holding_days`, `global_days_on_market`, `acquisition_deal_id`,
`exit_deal_id`, `acquisition_value`, `exit_value`, `net_profit`,
`is_realized`) and `public.analytics_purpose_policy`. No new date/deal/
profit definition is created.

**Timezone.** All "current"/"as of" reasoning uses `America/Toronto`.
Both the timezone string and the snapshot's `as_of_date` are stored
directly at the top level of `shared_calendar_seasonality_evidence` and
`target_user_calendar_seasonality_evidence`, and again nested inside
`current_month_to_date_pace`.

**Event-date reliability rules.** `acq_date_reliable` = `acquisition_
date IS NOT NULL AND NOT is_historical_import AND NOT has_lifecycle_
date_issue` — a Historical Import's acquisition date never contributes
to acquisition calendar activity, month-of-year acquisition seasonality,
acquisition weekday patterns, or acquisition-date-dependent MTD pace.
`listing_date_reliable` = `first_listed_at IS NOT NULL AND NOT has_
lifecycle_date_issue` — Historical Import status does NOT exclude a
listing date. `exit_date_reliable` = `is_realized AND exit_date IS NOT
NULL AND NOT has_lifecycle_date_issue` — Historical Import status does
NOT exclude an exit date either. Missing/unreliable dates are never
treated as zero-duration or an invented date — they remain visible in
`population_and_date_coverage`'s explicit exclusion counters. Every
date-based computation uses the event's own date column, never a
record's `created_at`.

**Purpose is current disposition, not proven historical intent.** A
historical event grouped under Business, Hybrid, or Personal reflects
the item's CURRENT `purpose_id` only — it does not prove the item had
that Purpose when the acquisition/listing/exit event actually occurred
(Purpose has no history table in this schema). Every section is produced
twice: pooled across all Purposes, and broken down by `(current_purpose_
id, current_purpose_name, purpose_policy_status)`, using the same
missing-purpose/missing-policy collapsing rule established in `v2.0`.
The purpose-breakdown rows additionally surface the existing `analytics_
purpose_policy` fields — never a new judgmental label.

**Deal-count / item-count separation — no double-counted cash.**
`deal_items.total_value` is already the per-item allocated share of a
deal's cash, not the deal's full total repeated on every item row, so
`SUM(acquisition_value)`/`SUM(exit_value)` never double-counts a
multi-item deal's cash. Distinct deal counts (`COUNT(DISTINCT
acquisition_deal_id)`, `COUNT(DISTINCT exit_deal_id)`) are reported
ALONGSIDE, never instead of, item counts — a 3-item single deal is
visible as both "3 items" and "1 deal." Listing events have no `deal_id`
(`item_listings` is not deal-based), so no deal count is reported for
first-listing activity.

**`monthly_timeline` — gap-filled, never silently sparse.** Generated
from a `generate_series` over every calendar month from the earliest
reliable event date through the current `America/Toronto` month, LEFT
JOINed to observed activity — a month with zero reliable acquisitions/
listings/exits still appears as a row with 0 counts, never omitted. If
no reliable event date exists at all, the series (and therefore the
timeline) is empty, never fabricated. `monthly_timeline_by_purpose`
applies the same gap-filling per Purpose group.

**`month_of_year_seasonality` — descriptive, year-count-aware.**
Aggregates ALL years' observations into 12 rows (Jan-Dec). Every row
reports its own distinct-year contributing count per event type
(acquisition/first-listing/realized-exit) and a `*_confidence` field
that is `'insufficient_years'` whenever fewer than 2 distinct years
contributed an observation for that event type in that month —
regardless of item count. No "best"/"worst" month label, score, or
causal claim is produced anywhere.

**`day_of_week_*_activity` — three separate arrays.**
`day_of_week_acquisition_activity`, `day_of_week_first_listing_
activity`, and `day_of_week_realized_exit_activity` are three
INDEPENDENT Monday-Sunday (ISO weekday) arrays — never combined into one
ambiguous weekday metric.

**`current_month_to_date_pace` — pooled only (scope decision).**
Compares the current `America/Toronto` month-to-date window against the
SAME calendar-day cutoff in every prior year with reliable data (e.g. an
August 12 snapshot compares August 1-12 of each prior year, never a full
prior August) — computed pooled only, not broken down `_by_purpose`, a
deliberate scope decision (a per-Purpose × per-prior-year matrix would
multiply an already multi-dimensional computation for comparatively
little evidentiary value at current inventory scale). February/short
months are handled via `LEAST(current_day_of_month, days_in_that_prior_
month)`. If zero comparable prior years exist, `status` is
`'insufficient_history'` and no median/average/difference is fabricated.
Never presented as a forecast for the completed current month.

**Privacy.** `shared_calendar_seasonality_evidence` pools every user's
items (aggregate only — no item identity, no row grouped by `user_id`).
`target_user_calendar_seasonality_evidence` is filtered to `user_id =
p_target_user_id` and is, like the shared section, aggregate only.

**`v2.8` was the production analytics version before `v2.9` (see section
32).** `v1.0`-`v1.8` and `v2.0`-`v2.7` remain independently callable and
every previously stored `analytics_runs.snapshot` row remains readable —
a forward version bump, not a rewrite of history. The Analytics page's
"Shared Calendar & Seasonality Evidence" and "Target User Calendar &
Seasonality Evidence" collapsible sections use the same JSON/Copy JSON
pattern as every prior section.

## 32. Calendar Observation Coverage & Confidence Correction (v2.9) and eighth production promotion

`public.build_analytics_snapshot_v2_9(p_target_user_id int)`
(`supabase/migrations/20260820000000_build_analytics_snapshot_v2_9.sql`)
calls `build_analytics_snapshot_v2_8` wholesale and MERGES a coverage-
aware correction onto v2.8's OWN `shared_calendar_seasonality_evidence` /
`target_user_calendar_seasonality_evidence` objects (same key names,
never new top-level snapshot keys) — a focused fix, not a new module. See
`analytics/sql/24_calendar_coverage_confidence_v2_9.sql` for a standalone
illustration of the corrected logic.

**The bug.** v2.8 treated a calendar year's mere existence as proof the
whole year had been observed. An isolated old event followed by a long
tracking gap made pre-tracking zero months look like genuine observed
zeros, and seasonality confidence could read `'stronger'` even when most
observations came from a single year.

**`public.analytics_observation_coverage` — new table, genuinely new
concept.** A repository-wide search found no existing field recording
when a user's inventory tracking became complete — `app_users` has no
such column, no migration or import script defines one, and Historical
Import's `acquisition_date` is an ITEM-level provenance flag, not a
user-level completeness marker. One OPTIONAL row per `app_users.id`
(`user_id` PK/FK, `complete_history_start_date date`, `coverage_status`
`'confirmed'`/`'estimated'`/`'unknown'`, `notes`, timestamps). An absent
row means `'unknown'` coverage — NEVER defaulted from the earliest
acquisition/listing/exit/record-creation date, which would reintroduce
the exact bug this migration fixes. `'confirmed'` requires the operator
to have verified the date against an external fact; it is required for
month-to-date comparability and the `'stronger'` seasonality tier.
`'estimated'` is a best guess, sufficient to avoid false observed-zeros
in `monthly_timeline`/`month_of_year_seasonality`, but never trusted
enough for MTD or `'stronger'`. `'unknown'` requires `complete_history_
start_date IS NULL` (enforced by a CHECK constraint). The table starts
completely EMPTY; a human configures a row only after confirming the
date out-of-band, using the SQL template at the end of the migration
file. Security: no settings UI exists for this table in this task —
ordinary authenticated users get NO grant at all (not even `SELECT`),
matching `analytics_runs`' least-privilege pattern rather than
`analytics_purpose_policy`'s authenticated-`SELECT`-all model, since this
is per-user operational metadata, not shared reference data. `service_
role` only, both an explicit `REVOKE` and RLS with zero policies.

**Fully observed month definition.** For a user's coverage row and a
reference calendar month (`month_start` = day 1 of that month):
`'unknown_coverage'` when `coverage_status = 'unknown'` or no row exists;
`'fully_observed'` when `complete_history_start_date <= month_start` —
UNLESS `month_start` is the current, still-in-progress `America/Toronto`
month or any future month within the current year, which is ALWAYS
capped at `'partial'` regardless of how early coverage began (an
in-progress month cannot yet be judged a completed observation);
`'partial'` when `complete_history_start_date` falls strictly inside the
month (day 1 of coverage makes that month fully observed; any later day
makes it partial, with the NEXT month being the first fully observed
one); `'pre_coverage'` when `complete_history_start_date` falls in some
later month (this month entirely precedes coverage). A historical event
before the coverage start remains visible as a real recorded event —
only the surrounding ZERO interpretation is what changes.

**Shared-scope cohort rule (deliberate, documented design choice).**
Shared evidence pools users with different coverage-start dates. This
module does NOT require unanimous coverage across every user who has
ever had an item before trusting a period — that would let one late-
onboarded user permanently poison every earlier calendar month for the
whole pool. For `monthly_timeline` and `month_of_year_seasonality`, a
period is `'fully_observed'` whenever ANY in-scope user's own coverage
fully observes it (real event totals always come from ALL users
regardless — never hidden); when no user fully observes a period, the
label falls back to the most favorable status any user in the pool
supports, so `'unknown_coverage'` is reported only when EVERY in-scope
user is unknown for that period. For `current_month_to_date_pace`
specifically, a STRICTER, PER-PRIOR-YEAR cohort applies instead: a prior
year is "comparable" only when the SAME set of users can vouch for it
with `coverage_status = 'confirmed'` specifically (not `'estimated'` —
MTD is the highest-stakes comparison in this module, per this task's
explicit "confirmed complete-history coverage" wording), and that year's
event totals are summed ONLY over that year's comparable cohort — never
the full population. The CURRENT month-to-date totals are always
computed over the full current population (present-day activity is real
regardless of any user's past coverage gaps); only PAST comparison years
are cohort-restricted. This intentional current/prior-years asymmetry is
a deliberate, documented scope decision, not a silent assumption.

**Corrected `monthly_timeline` / `monthly_timeline_by_purpose`.** Same
gap-filled range and event totals as v2.8 (Historical Import behavior
unchanged), with a new `coverage_status` field per row (and per
purpose-breakdown row) — `'fully_observed'`, `'partial'`, `'pre_
coverage'`, or `'unknown_coverage'` — so a genuinely observed zero is
never confused with an untracked gap. Purpose-breakdown sums continue to
reconcile to pooled totals. Current Purpose remains current disposition
only, never proven historical intent.

**Corrected `month_of_year_seasonality` confidence.** Per event family
(acquisition / first-listing / realized-exit), each of the 12 rows now
exposes `total_event_count`, `active_year_count` (years with >=1 event),
`fully_observed_year_count` and `fully_observed_confirmed_year_count`
(confirmed-only, computed from a coverage-year grid independent of
events, so a genuinely zero-activity fully-observed year is still
counted), `zero_activity_fully_observed_year_count`, `largest_year_
event_share`, and a `*_confidence` field. Rules (documented, and
consistent with the repo-wide item-count confidence convention: `<=2`
insufficient, `<=5` low, `<=9` moderate, `>=10` stronger):
`'no_data'` (zero events, zero fully-observed years); `'coverage_
unknown'` (events exist, but no year is fully observed by any in-scope
user — coverage genuinely can't support a conclusion); `'insufficient_
years'` (fewer than 2 fully-observed years); `'low'` (>=2 fully-observed
years, but `total_event_count <= 5` OR the single largest year
contributes more than 80% of all events — one-year domination caps
confidence even with a large total); `'moderate'` (>=2 fully-observed
years, `total_event_count >= 6`, largest-year share `<= 80%`);
`'stronger'` (ALL of: >=3 fully-observed years using ONLY `'confirmed'`
coverage — an `'estimated'`-only year never counts toward this tier, a
material coverage limitation that caps confidence at `'moderate'` —
`total_event_count >= 10`, >=2 active years, largest-year share `<=
60%`). `month_of_year_seasonality_by_purpose` was explicitly OUT OF
SCOPE for this correction (v2.8's version used the old, uncorrected
logic) — rather than leave it silently stale next to the corrected
pooled section, v2.9 replaces it with an empty array plus a `_note`
field pointing readers to the pooled `month_of_year_seasonality`.

**Corrected `current_month_to_date_pace`.** Same safe same-day cutoff and
February/month-end handling as v2.8. Now exposes `candidate_prior_years_
count`, `comparable_prior_years_count`, `active_comparable_year_count`,
`excluded_pre_coverage_year_count`, `excluded_unknown_coverage_year_
count`, per-year `comparable_user_count` inside `comparable_prior_years`,
and an `excluded_prior_years` array (`{year, reason}`). `status` is
`'sufficient_history'` when `comparable_prior_years_count >= 2`;
`'coverage_unknown'` when no user in scope has ANY confirmed coverage
configured at all; otherwise `'insufficient_history'`. A comparable prior
year with genuine zero activity remains valid and stays zero — nonzero
activity is never required for a fully observed year to count. Still
descriptive only, never a forecast for the completed current month.

**Historical Import semantics — unchanged.** Unreliable Historical Import
acquisition dates remain excluded from acquisition calendar/holding
metrics; reliable listing dates, reliable exit dates, and DOM remain
eligible exactly as in v2.8. Event-date reliability and observation-
period coverage are deliberately separate concepts — a reliable
historical exit before complete tracking began is a valid recorded
event, but it does not prove the rest of that month's activity was
captured.

**`v2.9` is now the production analytics version.** `runAnalytics.ts`
calls `build_analytics_snapshot_v2_9` for every new run (`ANALYTICS_
VERSION = '2.9'`). `v1.0`-`v1.8` and `v2.0`-`v2.8` remain independently
callable and every previously stored `analytics_runs.snapshot` row
remains readable — a forward version bump, not a rewrite of history. If
production observation-coverage dates remain unconfigured for a user,
v2.9 is still safe to run — it honestly reports `'coverage_unknown'`/
`'insufficient_history'` rather than overstating confidence. The
Analytics page's existing "Shared Calendar & Seasonality Evidence" and
"Target User Calendar & Seasonality Evidence" collapsible sections
automatically render the corrected content — no new section, no
redesign, no charts.
