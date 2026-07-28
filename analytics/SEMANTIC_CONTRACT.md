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
- Add Open Inventory Decision Support, item-level recommendations, recent
  trends, AI recommendations, Business Coach, or cash-balance analysis.
  Analytics Snapshot v1.7
  (`20260807000000_build_analytics_snapshot_v1_7.sql`, section 20) adds
  EXACTLY ONE module — Capital & Liquidity — and nothing else. It reports
  acquisition CAPITAL (value assigned to inventory), never a user's
  `cash_flow` ledger/cash-balance, which is a wholly separate subsystem
  not read anywhere in that module. `build_analytics_snapshot_v1` (v1.0)
  through `build_analytics_snapshot_v1_6` (v1.6) remain unchanged and
  callable; v1.7 is additive, not a replacement.

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
