# Analytics Semantic Contract

Source of truth for (1) how historical-import records are treated, (2)
acquisition/exit value-band terminology, (3) acquisition-to-exit value
analysis semantics, (4) the separation between shared statistical evidence
and current-user item-level recommendation targets, and (5) the required
conceptual structure of future Business Coach insights, across the
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
